"""
Self-healing scraper manager.
Detects selector failures and attempts automatic repair through:
1. Heuristic link/content discovery (pattern matching)
2. AI-powered selector repair via Gemini (last resort)
"""

import re
from bs4 import BeautifulSoup

import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import SELECTOR_FAILURE_THRESHOLD


class SelfHealingManager:
    def __init__(self, db, log=None):
        self.db = db
        self.log = log
        self.ai_client = None

    def _info(self, msg):
        if self.log:
            self.log.info(msg)

    def _warn(self, msg):
        if self.log:
            self.log.warn(msg)

    def attempt_link_discovery(self, html, domain):
        """Discover job links from HTML using URL pattern analysis."""
        soup = BeautifulSoup(html, 'html.parser')

        links = soup.find_all('a', href=True)
        url_groups = {}
        for link in links:
            href = link['href']
            pattern = self._url_to_pattern(href)
            if pattern not in url_groups:
                url_groups[pattern] = []
            url_groups[pattern].append(link)

        job_indicators = ['job', 'position', 'career', 'opening', 'vacancy', 'role', 'posting']
        candidates = []
        for pattern, link_group in url_groups.items():
            if len(link_group) >= 3:
                if any(indicator in pattern.lower() for indicator in job_indicators):
                    candidates.extend(link_group)

        if candidates:
            selector = self._derive_selector(candidates)
            if selector:
                self.db.upsert_selector(domain, 'job_link', selector)
                self._info(f"Self-healing: discovered selector '{selector}' for {domain}")
            return [link.get('href', '') for link in candidates if link.get('href')]

        for container_tag in ['ul', 'ol', 'div', 'section']:
            containers = soup.find_all(container_tag)
            for container in containers:
                child_links = container.find_all('a', href=True)
                if 5 <= len(child_links) <= 100:
                    hrefs = [a['href'] for a in child_links]
                    job_hrefs = [h for h in hrefs
                                 if any(ind in h.lower() for ind in job_indicators)]
                    if len(job_hrefs) >= 3:
                        return job_hrefs

        return []

    def rework_strategy(self, domain, html):
        """Attempt AI-powered selector repair when failure threshold is reached."""
        failure_count = self._get_total_failures(domain)

        if failure_count >= SELECTOR_FAILURE_THRESHOLD:
            self._warn(f"Self-healing: {failure_count} failures for {domain}, attempting AI repair")
            new_selectors = self._ai_repair_selectors(domain, html)
            if new_selectors:
                for selector_type, selector in new_selectors.items():
                    if selector:
                        self.db.upsert_selector(domain, selector_type, selector)
                        self._info(f"AI repair: new selector '{selector}' for {domain}/{selector_type}")

    def _ai_repair_selectors(self, domain, html):
        if not self.ai_client:
            try:
                common_path = os.path.join(
                    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                    'Common'
                )
                sys.path.insert(0, common_path)
                from ai_client import AIClient
                self.ai_client = AIClient(use_case='backup')
            except ImportError:
                self._warn("AI client not available for self-healing")
                return {}

        truncated_html = html[:5000]

        prompt = """Analyze this HTML from a job listing page and provide CSS selectors.
Return ONLY a JSON object with these keys (use null if not found):
- job_link: CSS selector for links to individual job postings
- job_title: CSS selector for the job title on a detail page
- job_location: CSS selector for location
- job_description: CSS selector for the job description

Example response:
{"job_link": "a.job-card__link", "job_title": "h1.job-title", "job_location": ".location-text", "job_description": ".description-content"}"""

        try:
            result = self.ai_client.analyze_text(truncated_html, prompt, model='gemini-2.0-flash')
            import json
            json_match = re.search(r'\{[^}]+\}', result)
            if json_match:
                return json.loads(json_match.group(0))
        except Exception as e:
            self._warn(f"AI selector repair failed for {domain}: {e}")

        return {}

    def _url_to_pattern(self, url):
        parts = url.split('/')
        return '/'.join('{id}' if re.match(r'^\d+$', p) else p for p in parts)

    def _derive_selector(self, links):
        classes = [set(link.get('class', [])) for link in links if link.get('class')]
        if classes:
            common_classes = classes[0]
            for cls_set in classes[1:]:
                common_classes &= cls_set
            if common_classes:
                return 'a.' + '.'.join(sorted(common_classes))

        parents = [link.parent for link in links]
        parent_classes = [set(p.get('class', [])) for p in parents if p and p.get('class')]
        if parent_classes:
            common = parent_classes[0]
            for cls_set in parent_classes[1:]:
                common &= cls_set
            if common:
                return '.' + '.'.join(sorted(common)) + ' a'

        return None

    def _get_total_failures(self, domain):
        selectors = self.db.get_selectors(domain, 'job_link')
        return sum(s.get('failure_count', 0) for s in selectors)
