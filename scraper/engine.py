"""
ScrapeEngine orchestrator. Runs in a background thread.
Coordinates ATS API scrapers, LinkedIn scraper, career page scraper, dedup, and file writing.
"""

import sys
from scraper.linkedin import LinkedInScraper
from scraper.career_page import CareerPageScraper
from scraper.ats_api import GreenhouseScraper, LeverScraper, AshbyScraper
from scraper.file_writer import MarkdownFileWriter
from scraper.dedup import DeduplicationManager
from scraper.logger import ScrapeLogger


def detect_scraper_type(url):
    """Auto-detect which ATS platform a URL belongs to."""
    url_lower = url.lower()
    if 'boards.greenhouse.io' in url_lower or 'boards-api.greenhouse.io' in url_lower:
        return 'greenhouse'
    if 'lever.co' in url_lower:
        return 'lever'
    if 'ashbyhq.com' in url_lower:
        return 'ashby'
    if 'linkedin.com/jobs' in url_lower:
        return 'linkedin'
    return 'generic'  # includes workday — CareerPageScraper auto-detects


class ScrapeEngine:
    def __init__(self, db):
        self.db = db
        self.file_writer = MarkdownFileWriter()
        self.dedup = DeduplicationManager(db)

    def run(self, run_id=None):
        """Main scrape loop. Called from background thread.
        If run_id is provided, uses that pre-created run (avoids race condition with frontend polling).
        """
        log = None
        scrapers = []
        jobs_found = 0
        jobs_new = 0
        errors = []
        status = 'failed'

        try:
            # Create logger first so any crash is visible in the UI
            if run_id is None:
                run_id = self.db.start_scrape_run(total_sources=0)
            log = ScrapeLogger(self.db, run_id)

            filters = self.db.get_all_filters()
            keywords = [f['keyword'] for f in filters if f.get('filter_type', 'include') == 'include']
            exclude_keywords = [f['keyword'] for f in filters if f.get('filter_type') == 'exclude']
            sources = self.db.get_active_target_urls()

            self.db.update_scrape_run_sources(run_id, len(sources))

            # Create all scraper instances
            linkedin_scraper = LinkedInScraper(log)
            career_scraper = CareerPageScraper(self.db, log)
            greenhouse_scraper = GreenhouseScraper(log)
            lever_scraper = LeverScraper(log)
            ashby_scraper = AshbyScraper(log)
            scrapers = [linkedin_scraper, career_scraper, greenhouse_scraper, lever_scraper, ashby_scraper]

            if not sources:
                log.warn("No active sources configured. Add sources in the UI.")
                status = 'completed'
                return

            log.step(f"Starting scrape: {len(sources)} source(s), {len(keywords)} keyword(s), {len(exclude_keywords)} exclude(s)")
            if keywords:
                log.info(f"Keywords (OR): {', '.join(keywords)}")
            if exclude_keywords:
                log.info(f"Exclude: {', '.join(exclude_keywords)}")

            for idx, source in enumerate(sources):
                source_num = idx + 1
                self.db.update_scrape_progress(
                    run_id, source_num, source['company_name'], jobs_found, jobs_new
                )

                scraper_type = detect_scraper_type(source['url'])
                log.step(f"[{source_num}/{len(sources)}] {source['company_name']} ({scraper_type})")

                try:
                    if scraper_type == 'linkedin':
                        discovered = linkedin_scraper.scrape(source, keywords, exclude_keywords)
                    elif scraper_type == 'greenhouse':
                        discovered = greenhouse_scraper.scrape(source, keywords, exclude_keywords)
                    elif scraper_type == 'lever':
                        discovered = lever_scraper.scrape(source, keywords, exclude_keywords)
                    elif scraper_type == 'ashby':
                        discovered = ashby_scraper.scrape(source, keywords, exclude_keywords)
                    else:
                        discovered = career_scraper.scrape(source, keywords, exclude_keywords)

                    log.info(f"Found {len(discovered)} matching job(s) from {source['company_name']}")

                    source_dupes = 0
                    for job in discovered:
                        jobs_found += 1
                        if not self.dedup.is_duplicate(job['url']):
                            try:
                                self._save_job(job, source)
                                jobs_new += 1
                                log.success(f"Saved: {job.get('title', 'Untitled')} at {job.get('company', '?')}")
                            except Exception as e:
                                err = f"Save error for {job.get('title', 'unknown')}: {e}"
                                log.error(err)
                                errors.append(err)
                        else:
                            source_dupes += 1

                    if source_dupes > 0:
                        if source_dupes == len(discovered):
                            log.info(f"All {source_dupes} jobs already in database — nothing new from {source['company_name']}")
                        else:
                            log.info(f"Skipped {source_dupes} duplicate(s) from {source['company_name']}")

                    # Update running totals
                    self.db.update_scrape_progress(
                        run_id, source_num, source['company_name'], jobs_found, jobs_new
                    )

                except Exception as e:
                    error_msg = f"{source['company_name']}: {str(e)}"
                    if log:
                        log.error(error_msg)
                    errors.append(error_msg)

            status = 'completed'
            log.step(f"Scrape complete: {jobs_found} found, {jobs_new} new")

        except Exception as e:
            status = 'failed'
            errors.append(str(e))
            print(f"[SCRAPER CRASH] {e}", file=sys.stderr, flush=True)
            if log:
                log.error(f"Scrape failed: {e}")

        finally:
            for scraper in scrapers:
                try:
                    scraper.close()
                except Exception:
                    pass
            if run_id:
                self.db.finish_scrape_run(
                    run_id, status, jobs_found, jobs_new,
                    '; '.join(errors) if errors else None
                )

    def _save_job(self, job, source):
        """Save a job to DB and write markdown file."""
        if not job.get('company'):
            job['company'] = source.get('company_name', 'Unknown')

        file_path = self.file_writer.write(job)
        normalized = DeduplicationManager.normalize_url(job['url'])

        self.db.add_job(
            job_url=job['url'],
            job_url_normalized=normalized,
            title=job.get('title'),
            company=job.get('company'),
            location=job.get('location'),
            salary=job.get('salary'),
            source_url_id=source['id'],
            file_path=file_path,
            description=job.get('description'),
        )
