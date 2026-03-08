"""
Generic career page scraper with self-healing selector logic.
Handles Workday, iCIMS, SmartRecruiters, Phenom People, and custom career pages.

Strategy: httpx only (no Playwright). Fast and non-blocking.
Extraction tiers: JSON-LD → CSS selectors → LLM (Gemini/Claude, only when CSS is incomplete)
→ ATS API probe (Greenhouse/Lever/Ashby) → Workday API.
"""

import re
import json
import html as html_module
import httpx
from urllib.parse import urljoin, urlparse, unquote

from bs4 import BeautifulSoup

from scraper.selectors import SelectorRegistry
from scraper.extractors import extract_company_from_url, extract_company_from_content
from scraper.llm_extract import LLMExtractor

import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import (
    REQUEST_TIMEOUT_SECONDS, REQUEST_HEADERS, EMPTY_JOB_THRESHOLD,
    MAX_JOBS_PER_SOURCE, WORKDAY_PROBE_TIMEOUT_SECONDS,
)


class CareerPageScraper:
    def __init__(self, db, log=None):
        self.db = db
        self.log = log
        self.selector_registry = SelectorRegistry(db)
        self.http = httpx.Client(
            headers=REQUEST_HEADERS,
            timeout=httpx.Timeout(REQUEST_TIMEOUT_SECONDS, connect=5.0),
            follow_redirects=True,
        )
        self.llm = LLMExtractor(log, usage_callback=self._log_llm_usage)
        self.llm.set_http_client(self.http)
        self._llm_used_for = set()  # Track domains that needed LLM extraction

    def _log_llm_usage(self, call_type, provider, model, key_hint, prompt_tok, comp_tok, total_tok):
        try:
            self.db.log_api_usage(call_type, provider, model, key_hint, prompt_tok, comp_tok, total_tok)
        except Exception:
            pass

    def _info(self, msg):
        if self.log:
            self.log.info(msg)

    def _warn(self, msg):
        if self.log:
            self.log.warn(msg)

    def _error(self, msg):
        if self.log:
            self.log.error(msg)

    # =================== Main Entry Point ===================

    def scrape(self, source, keywords, exclude_keywords=None):
        """Scrape a company career page for job listings. Returns (matched, filtered_out) tuple."""
        self._exclude_keywords = exclude_keywords or []
        domain = self._get_domain(source['url'])
        discovered = []
        filtered_out = []

        # Phase 1: Fetch listing page via httpx
        self._info(f"Loading {source['url'][:80]}...")
        html = self._fetch_page(source['url'])

        if not html:
            self._error(f"Failed to load {source['url'][:60]}")
            # Try ATS APIs / Workday even if page fetch failed (the page might be pure SPA)
            fallback_results = self._try_fallback_apis(source, keywords, filtered_out=filtered_out)
            if fallback_results:
                return fallback_results, filtered_out
            return [], filtered_out

        if self._is_blocked(html):
            self._warn(f"Blocked/captcha detected on {domain}, skipping")
            return [], filtered_out

        # Phase 1b: Phenom People detection (embedded JSON extraction)
        phenom_jobs = self._try_phenom_extraction(html, source, keywords, filtered_out=filtered_out)
        if phenom_jobs is not None:
            return phenom_jobs, filtered_out

        # Phase 2: Extract job links from listing page
        self._info("Extracting job links...")
        job_links = self._extract_job_links(html, domain, source['url'])

        if not job_links and self.llm.is_available():
            self._info("No links via selectors, trying LLM link discovery...")
            job_links = self.llm.extract_job_links(html, source['url'], domain)
            if job_links:
                self._info(f"[LLM-USED] LLM discovered {len(job_links)} job link(s) on {domain}")
                self._llm_used_for.add(domain)
                job_links = self._filter_job_urls(job_links, source['url'])
            else:
                self._info("LLM link discovery returned no results")

        # If still no links, try as single detail page
        if not job_links:
            self._info("No job links found. Trying as single job detail page...")
            job_data = self._extract_job_data(html, source['url'], domain, source)
            if job_data and job_data.get('title'):
                if self._matches_exclude(job_data['title']):
                    pass
                elif self._matches_keywords(job_data['title'], keywords):
                    discovered.append(job_data)
                else:
                    filtered_out.append(job_data)
            if not discovered:
                fallback_results = self._try_fallback_apis(source, keywords, html, filtered_out=filtered_out)
                if fallback_results:
                    discovered.extend(fallback_results)
            return discovered, filtered_out

        # Apply per-source limit
        if len(job_links) > MAX_JOBS_PER_SOURCE:
            self._info(f"Found {len(job_links)} links, limiting to first {MAX_JOBS_PER_SOURCE}")
            job_links = job_links[:MAX_JOBS_PER_SOURCE]
        else:
            self._info(f"Found {len(job_links)} job link(s)")

        # Phase 3: Scrape each job detail page
        empty_count = 0
        consecutive_non_job = 0

        for i, link_url in enumerate(job_links, 1):
            try:
                resolved_url = self._resolve_url(link_url, source['url'])
                self._info(f"[{i}/{len(job_links)}] Fetching: {resolved_url[:80]}...")

                detail_html = self._fetch_page(resolved_url)

                if detail_html:
                    job_data = self._extract_job_data(detail_html, resolved_url, domain, source)

                    if job_data and job_data.get('title'):
                        is_real_job = not self._is_generic_title(job_data['title']) and not self._is_non_job_page(job_data['title'])
                        consecutive_non_job = 0 if is_real_job else consecutive_non_job + 1
                        empty_count = 0

                        if self._matches_exclude(job_data['title']):
                            self._info(f"Excluded: {job_data['title']}")
                        elif self._matches_keywords(job_data['title'], keywords):
                            discovered.append(job_data)
                            self._info(f"Matched: {job_data['title']}")
                        else:
                            self._info(f"Filtered out: {job_data['title']}")
                            filtered_out.append(job_data)
                    else:
                        empty_count += 1
                        consecutive_non_job += 1
                        self._warn(f"Empty result for {resolved_url[:60]}")

                    # Bail early if first 4 links are non-job pages (likely SPA)
                    if consecutive_non_job >= 4 and not discovered:
                        self._warn("First 4 links are non-job pages — likely a SPA, trying Workday API...")
                        break

            except Exception as e:
                self._error(f"Error scraping {link_url[:60]}: {e}")

        # Phase 4: ATS API + Workday fallback if nothing found
        if not discovered:
            fallback_results = self._try_fallback_apis(source, keywords, html, filtered_out=filtered_out)
            if fallback_results:
                discovered.extend(fallback_results)

        if domain in self._llm_used_for:
            self._info(f"[OPTIMIZE] {domain} required LLM extraction — consider adding CSS selectors")

        return discovered, filtered_out

    # =================== Page Fetching ===================

    def _fetch_page(self, url):
        """Fetch a page via httpx. Returns HTML string or None.
        No Playwright — if httpx gets a SPA shell, we return the raw HTML
        and let JSON-LD / LLM extraction handle it.
        """
        try:
            response = self.http.get(url)
            if response.status_code == 200 and len(response.text) > 500:
                self._info(f"httpx OK ({len(response.text)} bytes)")
                return response.text
            self._warn(f"httpx returned {response.status_code} ({len(response.text)} bytes)")
            return None
        except Exception as e:
            self._error(f"httpx failed for {url[:60]}: {e}")
            return None

    # =================== Job Data Extraction ===================

    def _extract_job_data(self, html, job_url, domain, source):
        """Extract job data from HTML. Tiers: JSON-LD → CSS selectors → LLM (fallback only)."""
        soup = BeautifulSoup(html, 'html.parser')

        # 1. Try JSON-LD structured data (most reliable, zero cost)
        jsonld = self._extract_from_jsonld(soup, job_url)
        if jsonld and jsonld.get('title'):
            self._info(f"Extracted via JSON-LD: {jsonld['title'][:60]}")
            if not jsonld.get('company'):
                jsonld['company'] = source.get('company_name')
            if not jsonld.get('salary') and jsonld.get('description'):
                jsonld['salary'] = self._extract_salary(None, jsonld['description'])
            return jsonld

        # 2. CSS selectors + heuristics (fast, no API cost)
        meta_title = self._extract_title_from_meta(soup)

        # Work on a copy for CSS extraction (decompose noise)
        for element in soup(["script", "style", "nav", "footer", "header", "aside", "noscript"]):
            element.decompose()

        title = self._extract_field(soup, domain, 'job_title')
        if not title or self._is_generic_title(title):
            if meta_title:
                title = meta_title

        location = self._extract_field(soup, domain, 'job_location')
        description = self._extract_description(soup, domain)

        if not location and title:
            location = self._extract_location_from_title(title)
        if not location:
            location = self._extract_location_from_text(description or soup.get_text())

        salary = self._extract_salary(soup, description)

        company = source.get('company_name')
        if not company or company == 'Unknown':
            company = extract_company_from_content(description) or extract_company_from_url(job_url)

        css_result = {
            'url': job_url,
            'title': html_module.unescape(title) if title else title,
            'company': html_module.unescape(company) if company else company,
            'location': html_module.unescape(location) if location else location,
            'salary': salary,
            'description': description or '',
        }

        # If CSS got a title + description (>100 chars), we're done — no LLM needed
        if title and description and len(description) > 100:
            self._info(f"Extracted via CSS: {title[:60]}")
            return css_result

        # 3. LLM fallback — only when CSS couldn't get a complete result
        if self.llm.is_available():
            self._info(f"CSS incomplete (title={'yes' if title else 'no'}, desc={len(description) if description else 0} chars), trying LLM...")
            llm_result = self.llm.extract_job_data(html, job_url, company_hint=source.get('company_name'))
            if llm_result and llm_result.get('title'):
                self._info(f"[LLM-USED] Extracted via LLM: {llm_result['title'][:60]}")
                self._llm_used_for.add(domain)
                if not llm_result.get('company'):
                    llm_result['company'] = source.get('company_name')
                if not llm_result.get('salary') and llm_result.get('description'):
                    llm_result['salary'] = self._extract_salary(None, llm_result['description'])
                # Merge: LLM fills gaps that CSS missed, CSS fills gaps LLM missed
                merged = {}
                for key in ('url', 'title', 'company', 'location', 'salary', 'description'):
                    merged[key] = llm_result.get(key) or css_result.get(key) or ''
                merged['url'] = job_url
                return merged

        # Return whatever CSS got (partial data is better than nothing)
        if title:
            self._info(f"Extracted via CSS (no LLM): {title[:60]}")
        return css_result

    def _extract_from_jsonld(self, soup, job_url):
        """Extract job data from JSON-LD structured data (schema.org JobPosting)."""
        scripts = soup.find_all('script', type='application/ld+json')
        for script in scripts:
            try:
                data = json.loads(script.string)

                # Handle @graph arrays
                if isinstance(data, list):
                    for item in data:
                        if isinstance(item, dict) and item.get('@type') == 'JobPosting':
                            data = item
                            break
                    else:
                        continue
                elif isinstance(data, dict) and data.get('@type') != 'JobPosting':
                    # Check nested @graph
                    graph = data.get('@graph', [])
                    for item in graph:
                        if isinstance(item, dict) and item.get('@type') == 'JobPosting':
                            data = item
                            break
                    else:
                        continue

                if not isinstance(data, dict) or data.get('@type') != 'JobPosting':
                    continue

                title = data.get('title') or data.get('name')
                company = None
                location = None
                salary = None
                description = None

                # Company
                org = data.get('hiringOrganization', {})
                if isinstance(org, dict):
                    company = org.get('name')

                # Location
                loc_data = data.get('jobLocation')
                if isinstance(loc_data, dict):
                    location = self._parse_jsonld_location(loc_data)
                elif isinstance(loc_data, list):
                    locs = [self._parse_jsonld_location(l) for l in loc_data if isinstance(l, dict)]
                    location = ', '.join(l for l in locs if l)

                # Salary
                salary_data = data.get('baseSalary', {})
                if isinstance(salary_data, dict):
                    value = salary_data.get('value', {})
                    if isinstance(value, dict):
                        min_v = value.get('minValue')
                        max_v = value.get('maxValue')
                        unit = value.get('unitText', 'YEAR') or 'YEAR'
                        try:
                            if min_v and max_v:
                                salary = f"${float(min_v):,.0f} - ${float(max_v):,.0f}/{unit.lower()}"
                            elif min_v:
                                salary = f"${float(min_v):,.0f}/{unit.lower()}"
                        except (ValueError, TypeError):
                            pass

                # Description
                desc = data.get('description', '')
                if desc:
                    desc_soup = BeautifulSoup(desc, 'html.parser')
                    description = desc_soup.get_text(separator='\n\n', strip=True)

                return {
                    'url': job_url,
                    'title': title,
                    'company': company,
                    'location': location,
                    'salary': salary,
                    'description': description or '',
                }

            except (json.JSONDecodeError, AttributeError, TypeError):
                continue

        return None

    def _parse_jsonld_location(self, loc_data):
        """Parse a JSON-LD jobLocation object into a string."""
        addr = loc_data.get('address', {})
        if isinstance(addr, dict):
            parts = [addr.get('addressLocality', ''), addr.get('addressRegion', '')]
            return ', '.join(p for p in parts if p)
        return None

    # =================== Link Extraction ===================

    def _extract_job_links(self, html, domain, source_url):
        """Extract job links from a listing page using tiered selectors."""
        soup = BeautifulSoup(html, 'html.parser')

        selectors = self.selector_registry.get_link_selectors(domain)

        for selector_info in selectors:
            selector = selector_info['selector']
            try:
                links = soup.select(selector)
                if links:
                    self.db.record_selector_success(domain, 'job_link', selector)
                    urls = []
                    for link in links:
                        href = link.get('href', '')
                        if href and href != '#':
                            full_url = self._resolve_url(href, source_url)
                            urls.append(full_url)
                    filtered = self._filter_job_urls(urls, source_url)
                    if filtered:
                        return filtered
                else:
                    self.db.record_selector_failure(domain, 'job_link', selector)
            except Exception:
                self.db.record_selector_failure(domain, 'job_link', selector)

        # Heuristic fallback
        return self._heuristic_link_extraction(soup, source_url)

    def _heuristic_link_extraction(self, soup, source_url):
        """Last resort: find links that look like job detail pages."""
        job_patterns = ['/job/', '/jobs/', '/position/', '/opening/', '/career/',
                        '/vacancy/', '/posting/', '/requisition/']
        links = []
        for a_tag in soup.find_all('a', href=True):
            href = a_tag['href'].lower()
            if any(pattern in href for pattern in job_patterns):
                full_url = self._resolve_url(a_tag['href'], source_url)
                links.append(full_url)
        return self._filter_job_urls(links, source_url)

    def _filter_job_urls(self, urls, source_url):
        """Remove junk URLs that aren't real job detail pages."""
        source_parsed = urlparse(source_url)
        source_domain = source_parsed.netloc
        source_path = unquote(source_parsed.path).rstrip('/')
        seen = set()
        filtered = []

        # Navigation paths to exclude
        nav_paths = {
            '/saved-jobs', '/search-jobs', '/job-opportunities', '/about',
            '/contact', '/faq', '/help', '/benefits', '/culture', '/teams',
            '/diversity', '/locations', '/students', '/internships',
        }

        for url in urls:
            parsed = urlparse(url)
            path = parsed.path.rstrip('/')
            path_decoded = unquote(path).rstrip('/')

            # Must be same domain as source
            if parsed.netloc and parsed.netloc != source_domain:
                continue
            # Skip login/apply/register
            if '/login' in path or '/apply' in path or '/register' in path:
                continue
            # Skip lang-only variants
            if parsed.query and 'lang=' in parsed.query and not re.search(r'/\d+', path):
                continue
            # Skip source URL itself (URL-decode before comparing)
            if path_decoded == source_path:
                continue
            # Skip known navigation pages
            if path in nav_paths:
                continue
            # Skip search/listing pages (pagination, not individual job pages)
            if '/search-jobs/' in path:
                continue

            norm = url.split('?')[0].split('#')[0].rstrip('/')
            if norm not in seen:
                seen.add(norm)
                filtered.append(url)
        return filtered

    # =================== Field Extraction ===================

    def _extract_field(self, soup, domain, field_type):
        """Extract a field using tiered selectors for the domain."""
        selectors = self.selector_registry.get_field_selectors(domain, field_type)

        for selector_info in selectors:
            selector = selector_info['selector']
            try:
                element = soup.select_one(selector)
                if element:
                    text = element.get_text(strip=True)
                    if text:
                        self.db.record_selector_success(domain, field_type, selector)
                        return text
                self.db.record_selector_failure(domain, field_type, selector)
            except Exception:
                self.db.record_selector_failure(domain, field_type, selector)

        return None

    def _extract_title_from_meta(self, soup):
        """Extract job title from <title> tag or <meta og:title> before page elements are decomposed."""
        og = soup.find('meta', property='og:title')
        if og and og.get('content'):
            raw = og['content'].strip()
            if len(raw) > 5:
                return self._clean_meta_title(raw)

        title_tag = soup.find('title')
        if title_tag:
            raw = title_tag.get_text(strip=True)
            if len(raw) > 5:
                return self._clean_meta_title(raw)

        return None

    def _clean_meta_title(self, raw):
        """Strip company/site suffix from a <title> or og:title string."""
        parts = re.split(r'\s*[|\u2013\u2014]\s*', raw)
        title = parts[0].strip()
        if len(title) < 8 and len(parts) > 1:
            title = parts[1].strip()
        title = re.split(r'\s+-\s+', title)[0].strip()
        # Also strip "and jobs at Company" suffix (Comcast pattern)
        title = re.split(r'\s+and\s+jobs\s+at\s+', title, flags=re.IGNORECASE)[0].strip()
        return title if len(title) > 3 else None

    def _is_generic_title(self, title):
        """Check if a title looks like generic navigation rather than a real job title."""
        if not title:
            return True
        lower = title.lower().strip()
        generic_exact = [
            'who we are', 'what we do', 'what we stand for', 'about us',
            'our story', 'contact us', 'investors', 'news', 'careers',
            'home', 'menu', 'navigation', 'search', 'sign in', 'log in',
            'join us', 'our team', 'our values', 'our culture', 'benefits',
            'join our team', 'terms and conditions', 'privacy policy',
        ]
        if lower in generic_exact:
            return True
        # Patterns that indicate non-job pages
        generic_patterns = [
            'results found', 'supports veterans', 'hubs around',
            'trending roles', 'inspired by', 'cashiers wanted', 'cashierswanted',
        ]
        if any(p in lower for p in generic_patterns):
            return True
        if len(lower) < 5 and not any(c.isdigit() for c in lower):
            return True
        return False

    def _is_non_job_page(self, title):
        """Check if a title indicates a category/landing page rather than a job posting."""
        if not title:
            return True
        lower = title.lower().strip()
        # Single-word category names that are never job titles
        non_job_single = {
            'military', 'healthcare', 'technology', 'corporate', 'location',
            'stores', 'transportation', 'engineering', 'finance', 'legal',
            'design', 'operations', 'security', 'education',
        }
        if lower in non_job_single:
            return True
        # Multi-word category patterns
        non_job_patterns = [
            'careers', 'hiring process', 'stores and clubs', 'supply chain',
            'sam\'s club', 'terms and conditions', 'privacy policy',
            'walmart careers', 'join our team', 'come join',
        ]
        if any(p in lower for p in non_job_patterns):
            return True
        return False

    def _extract_salary(self, soup, description=None):
        """Extract salary using regex pattern matching."""
        text = description or (soup.get_text() if soup else None)
        if not text:
            return None
        patterns = [
            r'\$[\d,]+(?:\.\d{2})?\s+to\s+\$[\d,]+(?:\.\d{2})?',
            r'\$[\d,]+(?:\.\d{2})?\s*[-\u2013]\s*\$[\d,]+(?:\.\d{2})?(?:\s*/\s*(?:yr|year|annually|hr|hour))?',
            r'\$[\d,]+(?:\.\d{2})?\s*/\s*(?:yr|year|annually|hr|hour)',
            r'(?:base\s+)?(?:salary|pay|compensation)\s+(?:range|scale)?[:\s]+\$[\d,]+[^\n]{0,60}',
            r'(?:Salary|Compensation|Pay\s*Range)[:\s]*\$[\d,]+[^\n]{0,60}',
        ]
        for pattern in patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                result = match.group(0).strip()
                # Trim trailing sentence fragments but preserve decimals in dollar amounts
                result = re.split(r'(?<!\d)[.;]', result)[0].strip()
                if len(result) > 120:
                    result = result[:120] + '...'
                return result
        return None

    def _extract_location_from_title(self, title):
        """Extract location from job title like 'Analyst in New York'."""
        if not title:
            return None
        match = re.search(r'\bin\s+((?:Multiple\s+Locations|[A-Z][A-Za-z\s,/]+(?:[A-Z]{2})?))\s*$', title)
        if match:
            return match.group(1).strip().rstrip(',')
        return None

    def _extract_location_from_text(self, text):
        """Extract location from description text as fallback."""
        if not text:
            return None

        loc_match = re.search(r'(?:Location|Office Location|Work Location|Based in)\s*:\s*([A-Z][^\n]{3,80})', text)
        if loc_match:
            location = loc_match.group(1).strip()
            location = re.split(r'[.;]', location)[0].strip()
            if self._looks_like_location(location):
                return location

        loc_match = re.search(r'(?:^|\n)\s*Location\s*\n\s*([A-Z][^\n]{3,80})', text)
        if loc_match:
            location = loc_match.group(1).strip()
            if self._looks_like_location(location):
                return location

        cities = self._find_cities_in_text(text)
        if cities:
            return ', '.join(cities)

        return None

    def _find_cities_in_text(self, text):
        """Find all known city names mentioned in text."""
        city_names = [
            'New York', 'Los Angeles', 'Chicago', 'San Francisco', 'Boston',
            'Seattle', 'Austin', 'Atlanta', 'Washington', 'Houston', 'Dallas',
            'Denver', 'Miami', 'Philadelphia', 'Phoenix', 'Portland',
            'Minneapolis', 'San Diego', 'Charlotte', 'Detroit', 'Nashville',
            'Tampa', 'San Jose', 'Columbus', 'Indianapolis', 'Jacksonville',
            'San Antonio', 'Pittsburgh', 'Cincinnati', 'Kansas City',
            'Raleigh', 'Salt Lake City', 'Orlando', 'Sacramento',
            'St. Louis', 'Baltimore', 'Milwaukee', 'Las Vegas',
            'Richmond', 'Hartford', 'Stamford', 'Newark',
        ]
        found = []
        seen = set()
        for city in city_names:
            if city in text and city not in seen:
                pattern = r'\b' + re.escape(city) + r'\b'
                if re.search(pattern, text):
                    found.append(city)
                    seen.add(city)
        if re.search(r'\bRemote\b', text):
            found.append('Remote')
        return found

    def _looks_like_location(self, text):
        """Validate that extracted text actually looks like a location."""
        if not text or len(text) > 100:
            return False
        lower = text.lower()
        bad_indicators = [
            'understanding', 'experience', 'knowledge', 'proficiency',
            'skills', 'ability', 'responsible', 'manage', 'develop',
            'suite', 'excel', 'software', 'tools', 'platform',
            'working', 'building', 'creating', 'leading',
        ]
        if any(word in lower for word in bad_indicators):
            return False
        return True

    def _extract_description(self, soup, domain):
        """Extract job description using heuristic cascade."""
        selectors = self.selector_registry.get_field_selectors(domain, 'job_description')
        for selector_info in selectors:
            try:
                el = soup.select_one(selector_info['selector'])
                if el and len(el.get_text(strip=True)) > 100:
                    self.db.record_selector_success(domain, 'job_description', selector_info['selector'])
                    return el.get_text(separator='\n\n', strip=True)
            except Exception:
                pass

        article = soup.find('article')
        if article:
            return article.get_text(separator='\n\n', strip=True)

        common_selectors = [
            'job-description', 'jobDescription', 'description',
            'job-details', 'posting-requirements', 'content-body',
        ]
        for term in common_selectors:
            element = soup.find('div', class_=re.compile(term, re.I))
            if element:
                return element.get_text(separator='\n\n', strip=True)
            element = soup.find('div', id=re.compile(term, re.I))
            if element:
                return element.get_text(separator='\n\n', strip=True)

        main = soup.find('main')
        if main:
            return main.get_text(separator='\n\n', strip=True)

        return soup.body.get_text(separator='\n\n', strip=True) if soup.body else ''

    # =================== Platform-Specific Extraction ===================

    def _try_phenom_extraction(self, html, source, keywords, filtered_out=None):
        """Detect Phenom People platform and extract jobs from embedded JSON.

        Phenom People (used by HelloFresh, etc.) renders job listings client-side
        but embeds initial job data as phApp.eagerLoadRefineSearch in the HTML.
        Returns list of job dicts, or None if not a Phenom page.
        """
        if 'phenompeople' not in html.lower() and 'eagerLoadRefineSearch' not in html:
            return None

        self._info("Detected Phenom People platform, extracting embedded jobs...")

        # Find the embedded JSON object using JSONDecoder for robust brace matching
        start_marker = 'eagerLoadRefineSearch'
        idx = html.find(start_marker)
        if idx == -1:
            self._info("Phenom People detected but no embedded job data found")
            return None

        brace_idx = html.find('{', idx)
        if brace_idx == -1:
            return None

        try:
            decoder = json.JSONDecoder()
            data, _ = decoder.raw_decode(html, brace_idx)
        except (json.JSONDecodeError, ValueError):
            self._warn("Failed to parse Phenom People embedded JSON")
            return None

        jobs_data = data.get('jobs', [])
        if not jobs_data:
            self._info("Phenom People: no jobs in embedded data")
            return None

        self._info(f"Phenom People: found {len(jobs_data)} embedded job(s)")

        # Build base URL and detect locale path (e.g. /global/en)
        parsed = urlparse(source['url'])
        base_url = f"{parsed.scheme}://{parsed.netloc}"
        locale_match = re.search(r'(/[^/]+/[a-z]{2})(?:/|$)', parsed.path)
        locale_path = locale_match.group(1) if locale_match else '/global/en'

        discovered = []
        for job in jobs_data:
            title = job.get('title', '')
            if not title:
                continue

            if self._matches_exclude(title):
                self._info(f"Excluded: {title}")
                continue
            if not self._matches_keywords(title, keywords):
                if filtered_out is not None:
                    job_id = job.get('jobId', '')
                    city = job.get('city', '')
                    state = job.get('state', '')
                    country = job.get('country', '')
                    loc_parts = [p for p in [city, state, country] if p]
                    filtered_out.append({
                        'url': f"{base_url}{locale_path}/job/{job_id}" if job_id else '',
                        'title': title,
                        'company': source.get('company_name', ''),
                        'location': ', '.join(loc_parts),
                        'salary': None,
                        'description': '',
                    })
                continue

            job_id = job.get('jobId', '')
            city = job.get('city', '')
            state = job.get('state', '')
            country = job.get('country', '')
            loc_parts = [p for p in [city, state, country] if p]
            location_str = ', '.join(loc_parts)

            job_url = f"{base_url}{locale_path}/job/{job_id}" if job_id else ''

            discovered.append({
                'url': job_url,
                'title': title,
                'company': source.get('company_name', ''),
                'location': location_str,
                'salary': None,
                'description': '',
            })

            if len(discovered) >= MAX_JOBS_PER_SOURCE:
                break

        # Fetch detail pages for descriptions and salary
        if discovered:
            self._info(f"Phenom People: {len(discovered)} job(s) matched, fetching details...")
            for i, job in enumerate(discovered):
                if not job['url']:
                    continue
                try:
                    detail_html = self._fetch_page(job['url'])
                    if detail_html:
                        detail = self._extract_job_data(
                            detail_html, job['url'],
                            self._get_domain(job['url']), source,
                        )
                        if detail:
                            if detail.get('description'):
                                job['description'] = detail['description']
                            if detail.get('salary'):
                                job['salary'] = detail['salary']
                            if detail.get('location') and not job['location']:
                                job['location'] = detail['location']
                except Exception as e:
                    self._warn(f"Failed to fetch Phenom job detail: {e}")

        if discovered:
            self._info(f"Phenom People: returning {len(discovered)} job(s)")
            return discovered

        # No matches after filtering — return None so ATS API fallback can run
        self._info("Phenom People: no matching jobs after filtering, trying ATS fallback...")
        return None

    # =================== ATS API Probe Fallback ===================

    def _try_fallback_apis(self, source, keywords, html=None, filtered_out=None):
        """Try ATS API probes (Greenhouse/Lever/Ashby), then Workday as last resort."""
        ats_results = self._try_ats_api_probe(source, keywords, html, filtered_out=filtered_out)
        if ats_results:
            return ats_results
        return self._try_workday_api(source, keywords, filtered_out=filtered_out)

    def _try_ats_api_probe(self, source, keywords, html=None, filtered_out=None):
        """Probe Greenhouse, Lever, and Ashby APIs using company slug."""
        slugs = self._generate_ats_slugs(source['url'], source.get('company_name', ''))
        if not slugs:
            return []

        self._info(f"Probing ATS APIs for: {', '.join(slugs)}...")

        # Detect Phenom People SPA — very likely backed by Greenhouse
        if html and 'phenompeople.com' in html:
            self._info("Detected Phenom People platform — Greenhouse backend likely")

        for slug in slugs:
            for probe_fn in [self._probe_greenhouse, self._probe_lever, self._probe_ashby]:
                result = probe_fn(slug, source, keywords, filtered_out=filtered_out)
                if result:
                    return result

        self._info("No ATS API found for this site")
        return []

    def _generate_ats_slugs(self, url, company_name):
        """Generate possible ATS board slugs from URL and company name."""
        slugs = []
        seen = set()

        parsed = urlparse(url)
        domain = parsed.netloc.lower().replace('www.', '')

        # From domain: careers.hellofresh.com → hellofresh
        parts = domain.split('.')
        for part in parts:
            if part not in ('careers', 'jobs', 'com', 'org', 'net', 'io', 'co', 'apply', 'hire'):
                clean = part.replace('-', '')
                if clean and clean not in seen:
                    slugs.append(clean)
                    seen.add(clean)
                # Also try with hyphens preserved
                if '-' in part and part not in seen:
                    slugs.append(part)
                    seen.add(part)

        # From company name
        if company_name:
            slug = re.sub(r'[^a-z0-9]', '', company_name.lower())
            if slug and slug not in seen:
                slugs.append(slug)
                seen.add(slug)

        return slugs[:3]  # Cap to limit probe time

    def _probe_greenhouse(self, slug, source, keywords, filtered_out=None):
        """Probe Greenhouse API for a given slug. Returns list of job dicts or None."""
        try:
            url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"
            resp = self.http.get(url)
            if resp.status_code != 200:
                return None
            data = resp.json()
            jobs = data.get('jobs', [])
            if not jobs:
                return None

            self._info(f"Greenhouse API hit: {len(jobs)} job(s) for '{slug}'")
            discovered = []
            for job in jobs:
                title = job.get('title', '')
                if self._matches_exclude(title):
                    continue
                if not self._matches_keywords(title, keywords):
                    if filtered_out is not None:
                        filtered_out.append({
                            'url': job.get('absolute_url', ''),
                            'title': title,
                            'company': source.get('company_name', ''),
                            'location': '',
                            'salary': None,
                            'description': '',
                        })
                    continue

                content_html = job.get('content', '')
                description = ''
                if content_html:
                    soup = BeautifulSoup(content_html, 'html.parser')
                    description = soup.get_text(separator='\n\n', strip=True)

                location = ''
                loc_obj = job.get('location')
                if isinstance(loc_obj, dict):
                    location = loc_obj.get('name', '')

                salary = self._extract_salary(None, description) if description else None

                discovered.append({
                    'url': job.get('absolute_url', ''),
                    'title': title,
                    'company': source.get('company_name', ''),
                    'location': location,
                    'salary': salary,
                    'description': description,
                })
                if len(discovered) >= MAX_JOBS_PER_SOURCE:
                    break

            return discovered if discovered else None
        except Exception:
            return None

    def _probe_lever(self, slug, source, keywords, filtered_out=None):
        """Probe Lever API for a given slug. Returns list of job dicts or None."""
        try:
            url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
            resp = self.http.get(url)
            if resp.status_code != 200:
                return None
            postings = resp.json()
            if not isinstance(postings, list) or not postings:
                return None

            self._info(f"Lever API hit: {len(postings)} posting(s) for '{slug}'")
            discovered = []
            for posting in postings:
                title = posting.get('text', '')
                if self._matches_exclude(title):
                    continue
                if not self._matches_keywords(title, keywords):
                    if filtered_out is not None:
                        filtered_out.append({
                            'url': posting.get('hostedUrl', '') or posting.get('applyUrl', ''),
                            'title': title,
                            'company': source.get('company_name', ''),
                            'location': (posting.get('categories', {}) or {}).get('location', ''),
                            'salary': None,
                            'description': '',
                        })
                    continue

                categories = posting.get('categories', {}) or {}
                location = categories.get('location', '')
                description = posting.get('descriptionPlain', '') or ''

                salary = None
                salary_range = posting.get('salaryRange')
                if salary_range and isinstance(salary_range, dict):
                    sr_min = salary_range.get('min')
                    sr_max = salary_range.get('max')
                    interval = salary_range.get('interval', 'per-year')
                    if sr_min and sr_max:
                        salary = f"${sr_min:,.0f} - ${sr_max:,.0f}/{interval}"
                    elif sr_min:
                        salary = f"${sr_min:,.0f}/{interval}"
                if not salary and description:
                    salary = self._extract_salary(None, description)

                discovered.append({
                    'url': posting.get('hostedUrl', '') or posting.get('applyUrl', ''),
                    'title': title,
                    'company': source.get('company_name', ''),
                    'location': location,
                    'salary': salary,
                    'description': description,
                })
                if len(discovered) >= MAX_JOBS_PER_SOURCE:
                    break

            return discovered if discovered else None
        except Exception:
            return None

    def _probe_ashby(self, slug, source, keywords, filtered_out=None):
        """Probe Ashby API for a given slug. Returns list of job dicts or None."""
        try:
            url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true"
            resp = self.http.get(url)
            if resp.status_code != 200:
                return None
            data = resp.json()
            jobs = data.get('jobs', [])
            if not jobs:
                return None

            self._info(f"Ashby API hit: {len(jobs)} job(s) for '{slug}'")
            discovered = []
            for job in jobs:
                title = job.get('title', '')
                if self._matches_exclude(title):
                    continue
                if not self._matches_keywords(title, keywords):
                    if filtered_out is not None:
                        filtered_out.append({
                            'url': job.get('jobUrl', ''),
                            'title': title,
                            'company': source.get('company_name', ''),
                            'location': job.get('location', ''),
                            'salary': None,
                            'description': '',
                        })
                    continue

                location = job.get('location', '')
                description = job.get('descriptionPlain', '') or ''

                salary = None
                comp = job.get('compensation')
                if comp and isinstance(comp, dict):
                    salary = comp.get('compensationTierSummary', '')
                if not salary and description:
                    salary = self._extract_salary(None, description)

                discovered.append({
                    'url': job.get('jobUrl', ''),
                    'title': title,
                    'company': source.get('company_name', ''),
                    'location': location,
                    'salary': salary,
                    'description': description,
                })
                if len(discovered) >= MAX_JOBS_PER_SOURCE:
                    break

            return discovered if discovered else None
        except Exception:
            return None

    # =================== Workday API Fallback ===================

    def _try_workday_api(self, source, keywords, filtered_out=None):
        """Auto-detect and scrape via Workday API. Returns list of job dicts or empty list."""
        company_slug = self._extract_workday_slug(source['url'], source.get('company_name', ''))
        if not company_slug:
            return []

        self._info(f"Probing Workday API for '{company_slug}'...")

        # Try common Workday URL patterns: {slug}.wd{1-5}.myworkdayjobs.com
        # with common site names
        site_names = [
            f'{company_slug.capitalize()}External',
            f'{company_slug.upper()}External',
            'WalmartExternal',   # special case
            'External',
            'External_US',
            f'{company_slug.capitalize()}_Careers',
            f'{company_slug.capitalize()}Careers',
        ]
        # De-duplicate while preserving order
        seen = set()
        unique_sites = []
        for s in site_names:
            if s not in seen:
                seen.add(s)
                unique_sites.append(s)

        for wd_num in [5, 1, 2, 3, 4]:  # wd5 is most common
            base = f"https://{company_slug}.wd{wd_num}.myworkdayjobs.com"
            wd_reachable = None  # Track if this wd number is reachable

            for site_name in unique_sites:
                api_url = f"{base}/wday/cxs/{company_slug}/{site_name}/jobs"
                try:
                    test_resp = self.http.post(
                        api_url,
                        json={'appliedFacets': {}, 'limit': 1, 'offset': 0, 'searchText': ''},
                        headers={'Content-Type': 'application/json'},
                        timeout=WORKDAY_PROBE_TIMEOUT_SECONDS,
                    )
                    wd_reachable = True
                    if test_resp.status_code == 200:
                        data = test_resp.json()
                        if 'jobPostings' in data and data.get('total', 0) > 0:
                            self._info(f"Workday API found at wd{wd_num}/{site_name} ({data['total']} total jobs)")
                            return self._scrape_workday_jobs(api_url, base, site_name, source, keywords, filtered_out=filtered_out)
                except httpx.ConnectError:
                    wd_reachable = False
                    break  # DNS/connection failed, skip all site names for this wd number
                except Exception:
                    continue

            # If this wd number wasn't reachable, skip remaining wd numbers with higher values
            # (companies typically use the lowest available wd number)
            if wd_reachable is False:
                continue

        self._info("No Workday API found for this site")
        return []

    def _scrape_workday_jobs(self, api_url, base_url, site_name, source, keywords, filtered_out=None):
        """Scrape jobs from a discovered Workday API endpoint."""
        discovered = []
        all_postings = []

        # Search each keyword separately to avoid Workday's search limits,
        # then deduplicate results
        search_terms = keywords if keywords else ['']
        seen_paths = set()

        for kw in search_terms:
            self._info(f"Searching Workday for: '{kw}'")
            try:
                resp = self.http.post(
                    api_url,
                    json={
                        'appliedFacets': {},
                        'limit': min(MAX_JOBS_PER_SOURCE, 20),  # Workday caps at 20
                        'offset': 0,
                        'searchText': kw,
                    },
                    headers={'Content-Type': 'application/json'},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    for posting in data.get('jobPostings', []):
                        path = posting.get('externalPath', '')
                        if path not in seen_paths:
                            seen_paths.add(path)
                            all_postings.append(posting)
                    self._info(f"  '{kw}' returned {len(data.get('jobPostings', []))} result(s)")
                else:
                    self._info(f"  '{kw}' search returned HTTP {resp.status_code}, skipping")
            except Exception as e:
                self._info(f"  '{kw}' search failed: {e}")

        postings = all_postings[:MAX_JOBS_PER_SOURCE]
        self._info(f"Workday: {len(postings)} unique job(s) to process")

        try:
            for i, posting in enumerate(postings, 1):
                title = posting.get('title', '')
                location = posting.get('locationsText', '')
                ext_path = posting.get('externalPath', '')

                if not title:
                    continue

                # Keyword filter (Workday search is fuzzy, so double-check)
                if self._matches_exclude(title):
                    self._info(f"Excluded: {title}")
                    continue
                if not self._matches_keywords(title, keywords):
                    self._info(f"Filtered out: {title}")
                    if filtered_out is not None:
                        job_url = f"{base_url}/en-US/{site_name}{ext_path}"
                        filtered_out.append({
                            'url': job_url,
                            'title': title,
                            'company': source.get('company_name', ''),
                            'location': location,
                            'salary': None,
                            'description': '',
                        })
                    continue

                # Build the public-facing job URL
                job_url = f"{base_url}/en-US/{site_name}{ext_path}"

                # Fetch detail page for description/salary
                salary = None
                description = ''
                try:
                    detail_api = f"{base_url}/wday/cxs/{source.get('company_name', '').lower().replace(' ', '')}/{site_name}{ext_path}"
                    # Use the slug we already have
                    slug = api_url.split('/wday/cxs/')[1].split('/')[0]
                    detail_api = f"{base_url}/wday/cxs/{slug}/{site_name}{ext_path}"
                    detail_resp = self.http.get(detail_api)
                    if detail_resp.status_code == 200:
                        detail = detail_resp.json()
                        job_info = detail.get('jobPostingInfo', {})
                        desc_html = job_info.get('jobDescription', '')
                        if desc_html:
                            desc_soup = BeautifulSoup(desc_html, 'html.parser')
                            description = desc_soup.get_text(separator='\n\n', strip=True)
                            salary = self._extract_salary(None, description)
                        location = job_info.get('location', location)
                except Exception as e:
                    self._info(f"Detail fetch skipped: {e}")

                self._info(f"Matched (Workday): {title}")
                discovered.append({
                    'url': job_url,
                    'title': title,
                    'company': source.get('company_name', ''),
                    'location': location,
                    'salary': salary,
                    'description': description,
                })

        except Exception as e:
            self._error(f"Workday scrape failed: {e}")

        return discovered

    def _extract_workday_slug(self, url, company_name):
        """Extract a Workday-compatible company slug from URL or company name."""
        parsed = urlparse(url)
        domain = parsed.netloc.lower()

        # Try extracting from domain: careers.walmart.com → walmart
        parts = domain.replace('www.', '').split('.')
        for part in parts:
            if part not in ('careers', 'jobs', 'com', 'org', 'net', 'io', 'co', 'www'):
                return part.replace('-', '')

        # Fall back to company name
        if company_name:
            return re.sub(r'[^a-z0-9]', '', company_name.lower())

        return None

    # =================== Utilities ===================

    def _is_blocked(self, html):
        """Check if the page shows a captcha or blocking message."""
        lower = html.lower()
        indicators = ['captcha', 'verify you are human', 'access denied',
                       'please verify', 'robot', 'blocked']
        return any(ind in lower for ind in indicators) and len(html) < 5000

    def _matches_keywords(self, title, keywords):
        if not keywords:
            return True
        title_lower = title.lower() if title else ''
        return any(kw.lower() in title_lower for kw in keywords)

    def _matches_exclude(self, title):
        if not self._exclude_keywords:
            return False
        title_lower = title.lower() if title else ''
        return any(kw.lower() in title_lower for kw in self._exclude_keywords)

    def _resolve_url(self, href, base_url):
        return urljoin(base_url, href)

    def _get_domain(self, url):
        return urlparse(url).netloc

    def close(self):
        self.llm.close()
        self.http.close()
