"""
LinkedIn job scraper using the guest API (no login required).

Extracts metadata from SERP cards first, then enriches with detail page if available.
Falls back to SERP-only data when detail pages return 400/429.
"""

import re
import time
import httpx
from bs4 import BeautifulSoup
from urllib.parse import urlencode, urlparse, parse_qs

import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import LINKEDIN_GUEST_API_BASE, USER_AGENT, REQUEST_TIMEOUT_SECONDS, MAX_JOBS_PER_SOURCE


class LinkedInScraper:
    GUEST_API = LINKEDIN_GUEST_API_BASE
    GUEST_JOB_DETAIL = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{job_id}"

    def __init__(self, log=None):
        self.log = log
        self.client = httpx.Client(
            headers={"User-Agent": USER_AGENT},
            timeout=REQUEST_TIMEOUT_SECONDS,
            follow_redirects=True,
        )

    def _info(self, msg):
        if self.log:
            self.log.info(msg)

    def _warn(self, msg):
        if self.log:
            self.log.warn(msg)

    def _error(self, msg):
        if self.log:
            self.log.error(msg)

    def scrape(self, source, keywords, exclude_keywords=None):
        """
        Scrape LinkedIn SERP for jobs.
        Returns list of job dicts: {url, title, company, location, salary, description}
        """
        exclude_keywords = exclude_keywords or []
        self._info(f"Querying LinkedIn guest API for job links...")
        serp_jobs = self._fetch_serp_cards(source['url'])

        if len(serp_jobs) > MAX_JOBS_PER_SOURCE:
            self._info(f"Found {len(serp_jobs)} cards, limiting to first {MAX_JOBS_PER_SOURCE}")
            serp_jobs = serp_jobs[:MAX_JOBS_PER_SOURCE]
        else:
            self._info(f"LinkedIn: found {len(serp_jobs)} job card(s)")

        discovered = []
        detail_failures = 0
        for i, serp_data in enumerate(serp_jobs, 1):
            job_url = serp_data['url']
            title = serp_data.get('title', '')
            try:
                # Check keyword/exclude filters using SERP title (before detail fetch)
                if title:
                    if self._matches_exclude(title, exclude_keywords):
                        self._info(f"Excluded by negative filter: {title}")
                        continue
                    if not self._matches_keywords(title, keywords):
                        self._info(f"Filtered out (no keyword match): {title}")
                        continue

                # Try to enrich with detail page (adds description)
                self._info(f"[{i}/{len(serp_jobs)}] Fetching: {job_url[:70]}...")
                detail = self._fetch_job_detail(job_url)
                if detail and detail.get('title'):
                    # Merge: detail data wins, SERP fills gaps
                    job_data = {**serp_data, **{k: v for k, v in detail.items() if v}}
                    discovered.append(job_data)
                    self._info(f"Matched (full detail): {job_data['title']}")
                elif title:
                    # Detail fetch failed — use SERP card data (no description)
                    detail_failures += 1
                    discovered.append(serp_data)
                    self._info(f"Matched (SERP only, no description): {title}")

                # Pause between requests to reduce 429s
                if i < len(serp_jobs):
                    time.sleep(1.5)

            except Exception as e:
                self._error(f"Error fetching {job_url}: {e}")
                # Still save SERP data on error
                if title and self._matches_keywords(title, keywords):
                    discovered.append(serp_data)

        if detail_failures:
            self._warn(f"{detail_failures} jobs saved with SERP-only data (detail pages blocked)")

        return discovered

    def _fetch_serp_cards(self, serp_url):
        """Fetch job cards from LinkedIn SERP, extracting metadata from each card.
        Returns list of dicts with: url, title, company, location (no description).
        """
        all_cards = []
        seen_urls = set()
        parsed = urlparse(serp_url)
        params = parse_qs(parsed.query)

        flat_params = {k: v[0] for k, v in params.items()}
        keywords = flat_params.get('keywords', '')

        for start in range(0, 100, 25):
            api_params = {'keywords': keywords, 'start': str(start)}

            if 'location' in flat_params:
                api_params['location'] = flat_params['location']
            if 'geoId' in flat_params:
                api_params['geoId'] = flat_params['geoId']

            api_url = f"{self.GUEST_API}?{urlencode(api_params)}"

            try:
                response = self.client.get(api_url)
                if response.status_code != 200:
                    self._warn(f"LinkedIn API returned {response.status_code} at offset {start}")
                    break

                soup = BeautifulSoup(response.text, 'html.parser')

                # Find all job cards
                cards = soup.find_all('div', class_=lambda c: c and 'base-card' in c)
                if not cards:
                    cards = soup.find_all('li')

                if not cards:
                    break

                page_count = 0
                for card in cards:
                    card_data = self._parse_serp_card(card)
                    if card_data and card_data['url'] not in seen_urls:
                        seen_urls.add(card_data['url'])
                        all_cards.append(card_data)
                        page_count += 1

                self._info(f"Page {start // 25 + 1}: {page_count} cards")

            except Exception as e:
                self._error(f"LinkedIn API error at offset {start}: {e}")
                break

        return all_cards

    def _parse_serp_card(self, card):
        """Extract metadata from a single LinkedIn SERP job card."""
        # Find the job link
        link = card.find('a', class_=lambda c: c and 'base-card__full-link' in c)
        if not link:
            link = card.find('a', href=lambda h: h and '/jobs/view/' in h)
        if not link:
            return None

        href = link.get('href', '')
        if '/jobs/view/' not in href:
            return None

        clean_url = href.split('?')[0]
        if not clean_url.startswith('http'):
            clean_url = 'https://www.linkedin.com' + clean_url

        # Extract title from the card
        title = None
        title_el = card.find('h3', class_=lambda c: c and 'base-search-card__title' in c)
        if not title_el:
            title_el = card.find('span', class_=lambda c: c and 'sr-only' in c)
        if not title_el:
            title_el = link  # fallback to link text
        if title_el:
            title = title_el.get_text(strip=True)

        # Extract company
        company = None
        company_el = card.find('h4', class_=lambda c: c and 'base-search-card__subtitle' in c)
        if not company_el:
            company_el = card.find('a', class_=lambda c: c and 'hidden-nested-link' in c)
        if company_el:
            company = company_el.get_text(strip=True)

        # Extract location
        location = None
        loc_el = card.find('span', class_=lambda c: c and 'job-search-card__location' in c)
        if loc_el:
            location = loc_el.get_text(strip=True)

        # Extract salary if shown in card
        salary = None
        salary_el = card.find('span', class_=lambda c: c and 'job-search-card__salary-info' in c)
        if salary_el:
            salary = salary_el.get_text(strip=True)

        # Extract posted date
        date_el = card.find('time')
        posted_date = date_el.get('datetime', '') if date_el else ''

        if not title:
            return None

        return {
            'url': clean_url,
            'title': title,
            'company': company,
            'location': location,
            'salary': salary,
            'description': '',  # SERP cards don't have descriptions
            'posted_date': posted_date,
        }

    def _fetch_job_detail(self, job_url):
        """Fetch job details. Tries direct page (JSON-LD), then guest API."""
        # Strategy 1: Direct page fetch — LinkedIn serves JSON-LD to crawlers
        try:
            response = self.client.get(job_url)
            if response.status_code == 200 and len(response.text) > 500:
                result = self._parse_detail_html(response.text, job_url)
                if result and result.get('description'):
                    self._info(f"Got description via direct page fetch")
                    return result
        except Exception as e:
            self._warn(f"Direct fetch failed for {job_url[:60]}: {e}")

        # Strategy 2: Guest API detail endpoint
        job_id = job_url.rstrip('/').split('/')[-1]
        try:
            detail_url = self.GUEST_JOB_DETAIL.format(job_id=job_id)
            response = self.client.get(detail_url)

            if response.status_code == 200 and len(response.text) > 500:
                return self._parse_detail_html(response.text, job_url)
            self._warn(f"Guest API returned {response.status_code} for {job_url[:60]}, skipping")
        except Exception as e:
            self._warn(f"Guest API failed for {job_url[:60]}: {e}, skipping")

        return None

    def _parse_detail_html(self, html, job_url):
        """Parse LinkedIn job detail HTML for structured data."""
        soup = BeautifulSoup(html, 'html.parser')

        title = None
        company = None
        location = None
        salary = None
        description = None

        # Try JSON-LD first (most reliable)
        script_tag = soup.find('script', type='application/ld+json')
        if script_tag:
            import json
            try:
                data = json.loads(script_tag.string)
                title = data.get('title')
                location_data = data.get('jobLocation', {})
                if isinstance(location_data, dict):
                    addr = location_data.get('address', {})
                    if isinstance(addr, dict):
                        parts = [addr.get('addressLocality', ''), addr.get('addressRegion', '')]
                        location = ', '.join(p for p in parts if p)
                elif isinstance(location_data, list) and location_data:
                    addr = location_data[0].get('address', {})
                    parts = [addr.get('addressLocality', ''), addr.get('addressRegion', '')]
                    location = ', '.join(p for p in parts if p)

                org = data.get('hiringOrganization', {})
                if isinstance(org, dict):
                    company = org.get('name')

                salary_data = data.get('baseSalary', {})
                if isinstance(salary_data, dict):
                    value = salary_data.get('value', {})
                    if isinstance(value, dict):
                        min_v = value.get('minValue', '')
                        max_v = value.get('maxValue', '')
                        unit = value.get('unitText', 'YEAR')
                        if min_v and max_v:
                            salary = f"${min_v:,} - ${max_v:,}/{unit.lower()}"
                        elif min_v:
                            salary = f"${min_v:,}/{unit.lower()}"
            except (json.JSONDecodeError, AttributeError):
                pass

        # Fallback to HTML parsing
        if not title:
            title_el = soup.find('h2', class_=lambda c: c and 'title' in c if c else False)
            if not title_el:
                title_el = soup.find('h1')
            if title_el:
                title = title_el.get_text(strip=True)

        if not company:
            company_el = soup.find('a', class_=lambda c: c and 'org-name' in c if c else False)
            if not company_el:
                company_el = soup.find('a', class_=lambda c: c and 'company' in c.lower() if c else False)
            if company_el:
                company = company_el.get_text(strip=True)

        if not location:
            loc_el = soup.find('span', class_=lambda c: c and 'bullet' in c if c else False)
            if loc_el:
                location = loc_el.get_text(strip=True)

        if not salary:
            text = soup.get_text()
            salary_patterns = [
                r'\$[\d,]+(?:\.\d{2})?\s+to\s+\$[\d,]+(?:\.\d{2})?',
                r'\$[\d,]+(?:\.\d{2})?\s*[-\u2013]\s*\$[\d,]+(?:\.\d{2})?(?:\s*/\s*(?:yr|year|annually|hr|hour))?',
            ]
            for pattern in salary_patterns:
                salary_match = re.search(pattern, text, re.IGNORECASE)
                if salary_match:
                    salary = salary_match.group(0)
                    break

        if not description:
            desc_el = soup.find('div', class_=lambda c: c and 'description' in c if c else False)
            if not desc_el:
                desc_el = soup.find('section', class_=lambda c: c and 'description' in c if c else False)
            if desc_el:
                description = desc_el.get_text(separator='\n\n', strip=True)

        return {
            'url': job_url,
            'title': title,
            'company': company,
            'location': location,
            'salary': salary,
            'description': description or '',
        }

    def _matches_keywords(self, title, keywords):
        if not keywords:
            return True
        title_lower = title.lower() if title else ''
        return any(kw.lower() in title_lower for kw in keywords)

    def _matches_exclude(self, title, exclude_keywords):
        if not exclude_keywords:
            return False
        title_lower = title.lower() if title else ''
        return any(kw.lower() in title_lower for kw in exclude_keywords)

    def close(self):
        self.client.close()
