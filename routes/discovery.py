import threading
import re
from flask import Blueprint, render_template, jsonify, request

import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import SCRAPE_RUN_TIMEOUT_SECONDS, OUTPUT_DIR

discovery_bp = Blueprint('discovery', __name__)

# db and get_scrape_engine are injected via init_app
db = None
_scrape_engine = None


def init_app(database):
    global db
    db = database


def get_scrape_engine():
    global _scrape_engine
    if _scrape_engine is None:
        from scraper.engine import ScrapeEngine
        _scrape_engine = ScrapeEngine(db)
    return _scrape_engine


# =================== PAGE ROUTES ===================

@discovery_bp.route("/")
def index():
    return render_template("index.html")


# =================== SOURCE URLS API ===================

@discovery_bp.route("/api/sources", methods=["GET"])
def get_sources():
    sources = db.get_all_target_urls()
    return jsonify(sources)


@discovery_bp.route("/api/sources", methods=["POST"])
def add_source():
    data = request.get_json()
    url = data.get("url", "").strip()
    company_name = data.get("company_name", "").strip()
    url_type = data.get("url_type", "career_page")

    if "linkedin.com/jobs" in url:
        url_type = "linkedin_serp"

    if not url or not company_name:
        return jsonify({"error": "url and company_name are required"}), 400

    try:
        source_id = db.add_target_url(url, company_name, url_type)
        return jsonify({"id": source_id, "message": "Source added"}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 409


@discovery_bp.route("/api/sources/<int:source_id>", methods=["DELETE"])
def delete_source(source_id):
    db.delete_target_url(source_id)
    return jsonify({"message": "Source deleted"})


@discovery_bp.route("/api/sources/<int:source_id>", methods=["PUT"])
def update_source(source_id):
    data = request.get_json()
    db.update_target_url(source_id, **data)
    return jsonify({"message": "Source updated"})


# =================== FILTERS API ===================

@discovery_bp.route("/api/filters", methods=["GET"])
def get_filters():
    filters = db.get_all_filters()
    return jsonify(filters)


@discovery_bp.route("/api/filters", methods=["POST"])
def add_filter():
    data = request.get_json()
    keyword = data.get("keyword", "").strip()
    filter_type = data.get("filter_type", "include")
    if not keyword:
        return jsonify({"error": "keyword is required"}), 400
    if filter_type not in ("include", "exclude"):
        return jsonify({"error": "filter_type must be 'include' or 'exclude'"}), 400
    try:
        filter_id = db.add_filter(keyword, filter_type=filter_type)
        return jsonify({"id": filter_id, "message": "Filter added"}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 409


@discovery_bp.route("/api/filters/<int:filter_id>", methods=["DELETE"])
def delete_filter(filter_id):
    db.delete_filter(filter_id)
    return jsonify({"message": "Filter deleted"})


@discovery_bp.route("/api/filters/all", methods=["DELETE"])
def clear_all_filters():
    db.delete_all_filters()
    return jsonify({"message": "All filters cleared"})


# =================== JOBS API ===================

@discovery_bp.route("/api/jobs", methods=["GET"])
def get_jobs():
    limit = request.args.get("limit", 10000, type=int)
    offset = request.args.get("offset", 0, type=int)
    search = request.args.get("search", "", type=str)
    stage = request.args.get("stage", "", type=str)

    if search:
        jobs = db.search_jobs(search)
    elif stage:
        jobs = db.get_jobs_by_stage(stage)
    else:
        jobs = db.get_all_jobs(limit=limit, offset=offset)
    return jsonify(jobs)


@discovery_bp.route("/api/jobs/filtered", methods=["GET"])
def get_filtered_jobs():
    jobs = db.get_filtered_jobs()
    return jsonify(jobs)


# Stopwords for keyword suggestion (common English + job title noise)
_SUGGEST_STOPWORDS = {
    'a', 'an', 'the', 'and', 'or', 'of', 'for', 'in', 'at', 'to', 'with',
    'on', 'by', 'as', 'is', 'it', 'be', 'are', 'was', 'were', 'will', 'that',
    'this', 'from', 'have', 'has', 'had', 'but', 'not', 'no', 'do', 'does',
    'we', 'you', 'he', 'she', 'they', 'i', 'its', 'our', 'your', 'their',
    'us', 'co', 'inc', 'llc', 'ltd', 'ii', 'iii', 'iv', 'v', 'remote',
}


def _suggest_keywords(title, existing_keywords):
    """Tokenize a job title and suggest words not already in the keyword list."""
    import re
    existing_lower = {kw.lower() for kw in existing_keywords}
    tokens = re.findall(r'[a-zA-Z]+', title or '')
    suggestions = []
    seen = set()
    for token in tokens:
        lower = token.lower()
        if len(lower) < 3:
            continue
        if lower in _SUGGEST_STOPWORDS:
            continue
        if lower in existing_lower:
            continue
        if lower in seen:
            continue
        seen.add(lower)
        suggestions.append(token)
    return suggestions


@discovery_bp.route("/api/jobs/<int:job_id>/keep", methods=["POST"])
def keep_filtered_job(job_id):
    job = db.get_job_by_id(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    if job.get('status') != 'filtered':
        return jsonify({"error": "Job is not in filtered status"}), 400

    db.update_job_status(job_id, 'new')

    all_filters = db.get_all_filters()
    existing_keywords = [f['keyword'] for f in all_filters]
    suggestions = _suggest_keywords(job.get('title', ''), existing_keywords)

    return jsonify({
        "message": "Job kept and promoted to new",
        "keyword_suggestions": suggestions,
    })


@discovery_bp.route("/api/jobs/<int:job_id>/status", methods=["PUT"])
def update_job_status(job_id):
    data = request.get_json()
    status = data.get("status", "").strip()
    try:
        db.update_job_status(job_id, status)
        return jsonify({"message": "Status updated"})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@discovery_bp.route("/api/jobs/<int:job_id>/pipeline", methods=["PUT"])
def update_pipeline_stage(job_id):
    data = request.get_json()
    stage = data.get("pipeline_stage", "").strip()
    try:
        db.update_pipeline_stage(job_id, stage)
        return jsonify({"message": "Pipeline stage updated"})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@discovery_bp.route("/api/jobs/<int:job_id>/notes", methods=["PUT"])
def update_notes(job_id):
    data = request.get_json()
    notes = data.get("notes", "")
    db.update_job_notes(job_id, notes)
    return jsonify({"message": "Notes updated"})


@discovery_bp.route("/api/jobs/<int:job_id>/fields", methods=["PUT"])
def update_fields(job_id):
    """Update editable job metadata fields (title, company, location, salary).

    When title or company changes, also move/rename the Obsidian markdown file
    so it stays in sync (Company/Title.md convention).
    """
    data = request.get_json() or {}
    changing_title = "title" in data
    changing_company = "company" in data

    # Update DB first
    db.update_job_fields(job_id, **data)

    # Sync Obsidian file when title or company changes
    if changing_title or changing_company:
        job = db.get_job_by_id(job_id)
        old_path = job.get("file_path") if job else None
        if old_path and os.path.isfile(old_path):
            from scraper.file_writer import MarkdownFileWriter
            fw = MarkdownFileWriter()

            # Rewrite file content with updated fields
            job_data = {
                "title": job.get("title"),
                "company": job.get("company"),
                "url": job.get("job_url"),
                "location": job.get("location"),
                "salary": job.get("salary"),
                "description": job.get("description", ""),
            }
            new_content = fw._build_markdown(job_data)
            with open(old_path, "w", encoding="utf-8") as f:
                f.write(new_content)

            # Move file to new Company/Title.md path
            safe_company = fw._sanitize_filename(job.get("company") or "Unknown")
            safe_title = fw._sanitize_filename(job.get("title") or "Untitled Position")
            if len(safe_title) > 80:
                safe_title = safe_title[:80].rstrip()
            new_dir = os.path.join(OUTPUT_DIR, safe_company)
            os.makedirs(new_dir, exist_ok=True)
            new_path = os.path.join(new_dir, f"{safe_title}.md")
            if new_path != old_path:
                if os.path.exists(new_path):
                    base, ext = os.path.splitext(new_path)
                    from datetime import datetime
                    new_path = f"{base} ({datetime.now().strftime('%H%M%S')}){ext}"
                os.rename(old_path, new_path)
                db.update_job_fields(job_id, file_path=new_path)
                # Clean up empty old company folder
                old_dir = os.path.dirname(old_path)
                if os.path.isdir(old_dir) and not os.listdir(old_dir):
                    os.rmdir(old_dir)

    return jsonify({"message": "Job updated"})


@discovery_bp.route("/api/jobs/<int:job_id>/activity-log", methods=["GET"])
def get_activity_log(job_id):
    import json
    job = db.get_job_by_id(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    raw = job.get("notes") or ""
    try:
        entries = json.loads(raw)
        if not isinstance(entries, list):
            entries = [{"text": raw, "ts": job.get("date_found", ""), "type": "note"}] if raw else []
    except (json.JSONDecodeError, TypeError):
        entries = [{"text": raw, "ts": job.get("date_found", ""), "type": "note"}] if raw else []
    return jsonify({"entries": entries})


@discovery_bp.route("/api/jobs/<int:job_id>/activity-log", methods=["POST"])
def add_activity_entry(job_id):
    import json
    from datetime import datetime, timezone
    data = request.get_json() or {}
    text = data.get("text", "").strip()
    entry_type = data.get("type", "note")
    if not text:
        return jsonify({"error": "text is required"}), 400

    job = db.get_job_by_id(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    raw = job.get("notes") or ""
    try:
        entries = json.loads(raw)
        if not isinstance(entries, list):
            entries = [{"text": raw, "ts": job.get("date_found", ""), "type": "note"}] if raw else []
    except (json.JSONDecodeError, TypeError):
        entries = [{"text": raw, "ts": job.get("date_found", ""), "type": "note"}] if raw else []

    new_entry = {
        "text": text,
        "ts": datetime.now(timezone.utc).isoformat(),
        "type": entry_type,
    }
    entries.append(new_entry)
    db.update_job_notes(job_id, json.dumps(entries))
    return jsonify({"entry": new_entry, "total": len(entries)}), 201


@discovery_bp.route("/api/stats", methods=["GET"])
def get_stats():
    stats = db.get_stats()
    return jsonify(stats)


@discovery_bp.route("/api/pipeline-stats", methods=["GET"])
def get_pipeline_stats():
    stats = db.get_pipeline_stats()
    return jsonify(stats)


@discovery_bp.route("/api/ai-usage-stats", methods=["GET"])
def get_ai_usage_stats():
    stats = db.get_ai_usage_stats()
    return jsonify(stats)


# =================== SCRAPER CONTROL API ===================

@discovery_bp.route("/api/scraper/run", methods=["POST"])
def run_scraper():
    try:
        if db.is_scraper_running():
            return jsonify({"error": "Scraper is already running in the background.", "running": True}), 409

        # Create the run BEFORE starting the thread so the frontend can poll immediately
        run_id = db.start_scrape_run(total_sources=0)
        engine = get_scrape_engine()

        def _scrape_worker():
            """Run scraper in a background thread with full error handling."""
            import traceback
            try:
                print(f"[SCRAPER] Thread started for run {run_id}", file=sys.stderr, flush=True)
                engine.run(run_id=run_id)
                print(f"[SCRAPER] Thread finished for run {run_id}", file=sys.stderr, flush=True)
            except Exception as e:
                print(f"[SCRAPER] Thread CRASHED for run {run_id}: {e}", file=sys.stderr, flush=True)
                traceback.print_exc(file=sys.stderr)
                # Ensure run is marked as failed
                try:
                    db.finish_scrape_run(run_id, 'failed', 0, 0, str(e))
                except Exception:
                    pass

        worker = threading.Thread(target=_scrape_worker, name=f"scraper-run-{run_id}", daemon=True)
        worker.start()

        return jsonify({"message": "Scraper started", "running": True, "run_id": run_id}), 202
    except Exception as e:
        return jsonify({"error": f"Failed to start scraper: {e}"}), 500


@discovery_bp.route("/api/scraper/status", methods=["GET"])
def scraper_status():
    latest_run = db.get_latest_run()
    is_running = db.is_scraper_running()
    return jsonify({"running": is_running, "latest_run": latest_run})


@discovery_bp.route("/api/scraper/force-stop", methods=["POST"])
def force_stop_scraper():
    db.force_stop_scraper()
    return jsonify({"message": "Scraper stopped"})


@discovery_bp.route("/api/scraper/log", methods=["GET"])
def scraper_log():
    # Accept explicit run_id to avoid race conditions with latest_run detection
    run_id = request.args.get("run_id", 0, type=int)
    if not run_id:
        latest_run = db.get_latest_run()
        if not latest_run:
            return jsonify({"logs": [], "run_id": None})
        run_id = latest_run["id"]
    since_id = request.args.get("since_id", 0, type=int)
    logs = db.get_logs(run_id, since_id=since_id)
    return jsonify({"logs": logs, "run_id": run_id})


# =================== JOB DESCRIPTION API ===================

@discovery_bp.route("/api/jobs/<int:job_id>/description", methods=["GET"])
def get_job_description(job_id):
    job = db.get_job_by_id(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    # Prefer DB-stored description
    description = job.get("description") or ""

    # Fall back to markdown file on disk (backwards compat)
    if not description:
        file_path = job.get("file_path", "")
        if file_path and os.path.isfile(file_path):
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    description = f.read()
            except Exception:
                pass

    return jsonify({"description": description})


@discovery_bp.route("/api/jobs/<int:job_id>/description", methods=["PUT"])
def update_job_description(job_id):
    job = db.get_job_by_id(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    data = request.get_json()
    description = data.get("description", "")
    db.update_job_description(job_id, description)
    return jsonify({"message": "Description updated"})


@discovery_bp.route("/api/jobs/<int:job_id>/rescrape", methods=["POST"])
def rescrape_job(job_id):
    """Re-fetch job details from the posting URL to fill in missing data."""
    job = db.get_job_by_id(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    job_url = job.get("job_url", "")
    if not job_url:
        return jsonify({"error": "No URL stored for this job"}), 400

    from scraper.linkedin import LinkedInScraper
    from scraper.career_page import CareerPageScraper

    is_linkedin = 'linkedin.com' in job_url.lower()
    job_data = None

    try:
        if is_linkedin:
            scraper = LinkedInScraper()
            try:
                job_data = scraper._fetch_job_detail(job_url)
            finally:
                scraper.close()
        else:
            scraper = CareerPageScraper(db)
            try:
                html = scraper._fetch_page(job_url)
                if html and not scraper._is_blocked(html):
                    domain = scraper._get_domain(job_url)
                    source_stub = {"company_name": job.get("company"), "url": job_url}
                    job_data = scraper._extract_job_data(html, job_url, domain, source_stub)
            finally:
                scraper.close()
    except Exception as e:
        return jsonify({"error": f"Scrape failed: {str(e)}"}), 500

    if not job_data:
        return jsonify({"error": "Could not extract any data from the page. The site may be blocking scrapers."}), 422

    # Update fields that were missing
    updated = []
    fill_fields = {}
    if job_data.get('description') and not job.get('description'):
        fill_fields['description'] = job_data['description']
        updated.append('description')
    if job_data.get('location') and not job.get('location'):
        fill_fields['location'] = job_data['location']
        updated.append('location')
    if job_data.get('salary') and not job.get('salary'):
        fill_fields['salary'] = job_data['salary']
        updated.append('salary')
    if job_data.get('company') and not job.get('company'):
        fill_fields['company'] = job_data['company']
        updated.append('company')
    if fill_fields:
        db.update_job_fields(job_id, **fill_fields)

    if not updated:
        # If the job already has all fields, offer to overwrite description
        if job_data.get('description'):
            return jsonify({
                "message": "All fields already populated. Use 'force' to overwrite description.",
                "has_new_description": True,
                "updated": [],
            })
        return jsonify({"error": "Rescrape succeeded but found no new data to fill in."}), 422

    return jsonify({
        "message": f"Updated: {', '.join(updated)}",
        "updated": updated,
        "description": job_data.get('description', ''),
    })


@discovery_bp.route("/api/jobs/<int:job_id>/reformat-jd", methods=["POST"])
def reformat_job_description(job_id):
    """Use AI to restructure a raw JD into clean organized markdown."""
    job = db.get_job_by_id(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    description = job.get("description") or ""
    if not description:
        return jsonify({"error": "No job description to reformat"}), 400

    from ai.prompts import JD_REFORMAT_PROMPT
    from config import JD_REFORMAT_API_KEY, JD_REFORMAT_MODEL, GEMINI_API_KEYS, LLM_FALLBACK_MODELS

    prompt = JD_REFORMAT_PROMPT + description

    # Try dedicated key first, then fall back to shared keys
    keys_to_try = [JD_REFORMAT_API_KEY] + [k for k in GEMINI_API_KEYS if k != JD_REFORMAT_API_KEY]
    models_to_try = [JD_REFORMAT_MODEL] + [m for m in LLM_FALLBACK_MODELS if m != JD_REFORMAT_MODEL]

    try:
        import httpx

        for model in models_to_try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
            for key in keys_to_try:
                resp = httpx.post(
                    url,
                    params={"key": key},
                    json={
                        "contents": [{"parts": [{"text": prompt}]}],
                        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 8192},
                    },
                    timeout=60,
                )

                if resp.status_code == 429:
                    continue  # try next key
                if resp.status_code != 200:
                    break  # non-rate-limit error, try next model

                data = resp.json()
                candidates = data.get("candidates", [])
                if not candidates:
                    return jsonify({"error": "AI returned no response"}), 502

                formatted = candidates[0].get("content", {}).get("parts", [{}])[0].get("text", "")
                if not formatted:
                    return jsonify({"error": "AI returned empty response"}), 502

                # Log usage
                try:
                    usage_meta = data.get("usageMetadata", {})
                    db.log_api_usage(
                        call_type='jd_reformat', provider='gemini', model=model,
                        api_key_hint=f"...{key[-4:]}",
                        prompt_tokens=usage_meta.get('promptTokenCount', 0),
                        completion_tokens=usage_meta.get('candidatesTokenCount', 0),
                        total_tokens=usage_meta.get('totalTokenCount', 0),
                        job_id=job_id,
                    )
                except Exception:
                    pass

                # Save the reformatted description
                db.update_job_description(job_id, formatted)
                return jsonify({"description": formatted})

        return jsonify({"error": "All AI keys rate limited — try again in a minute"}), 429

    except Exception as e:
        return jsonify({"error": f"Reformat failed: {str(e)}"}), 500


# =================== IMPORT JOB API ===================

def _normalize_url(url):
    """Normalize a URL for deduplication."""
    url = url.strip().rstrip('/')
    url = re.sub(r'^https?://(www\.)?', '', url)
    url = url.split('?')[0].split('#')[0]
    return url.lower()


@discovery_bp.route("/api/jobs/import", methods=["POST"])
def import_job():
    """Manually import a job with metadata and description."""
    data = request.get_json()
    title = (data.get("title") or "").strip()
    company = (data.get("company") or "").strip()
    location = (data.get("location") or "").strip()
    salary = (data.get("salary") or "").strip()
    description = (data.get("description") or "").strip()
    job_url = (data.get("job_url") or "").strip()

    if not title:
        return jsonify({"error": "Title is required"}), 400
    if not description:
        return jsonify({"error": "Description is required"}), 400

    # Generate a URL for deduplication if none provided
    if not job_url:
        slug = re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')
        company_slug = re.sub(r'[^a-z0-9]+', '-', company.lower()).strip('-') if company else 'unknown'
        job_url = f"manual://{company_slug}/{slug}"

    normalized = _normalize_url(job_url)

    # Check for duplicates
    existing = db.get_job_by_normalized_url(normalized)
    if existing:
        return jsonify({"error": f"Job already exists (id: {existing['id']})", "existing_id": existing['id']}), 409

    job_id = db.add_job(
        job_url=job_url,
        job_url_normalized=normalized,
        title=title,
        company=company or None,
        location=location or None,
        salary=salary or None,
        description=description,
    )

    if not job_id:
        return jsonify({"error": "Failed to create job (possible duplicate URL)"}), 409

    return jsonify({"id": job_id, "message": "Job imported successfully"}), 201


@discovery_bp.route("/api/jobs/scrape-urls", methods=["POST"])
def scrape_urls():
    """Scrape a list of direct job posting URLs and save results."""
    data = request.get_json()
    urls = data.get("urls", [])

    if not urls or not isinstance(urls, list):
        return jsonify({"error": "urls must be a non-empty list"}), 400
    if len(urls) > 20:
        return jsonify({"error": "Maximum 20 URLs per batch"}), 400

    # Clean URLs
    clean_urls = []
    for raw in urls:
        url = raw.strip()
        if not url:
            continue
        if not url.startswith(('http://', 'https://')):
            url = 'https://' + url
        clean_urls.append(url)

    if not clean_urls:
        return jsonify({"error": "No valid URLs provided"}), 400

    from scraper.career_page import CareerPageScraper
    from scraper.linkedin import LinkedInScraper
    from scraper.file_writer import MarkdownFileWriter
    from scraper.dedup import DeduplicationManager

    career_scraper = CareerPageScraper(db)
    linkedin_scraper = LinkedInScraper()
    file_writer = MarkdownFileWriter()

    results = []
    saved = 0
    dupes = 0
    errors = 0

    try:
        for url in clean_urls:
            try:
                # Dedup check
                normalized = DeduplicationManager.normalize_url(url)
                existing = db.get_job_by_normalized_url(normalized)
                if existing:
                    results.append({"url": url, "status": "duplicate",
                                    "title": existing.get("title"), "existing_id": existing["id"]})
                    dupes += 1
                    continue

                # Route to correct scraper
                is_linkedin = 'linkedin.com' in url.lower()
                job_data = None

                if is_linkedin:
                    job_data = linkedin_scraper._fetch_job_detail(url)
                else:
                    domain = career_scraper._get_domain(url)
                    html = career_scraper._fetch_page(url)
                    if not html:
                        results.append({"url": url, "status": "error", "error": "Failed to fetch page"})
                        errors += 1
                        continue
                    if career_scraper._is_blocked(html):
                        results.append({"url": url, "status": "error", "error": "Page blocked (captcha/access denied)"})
                        errors += 1
                        continue
                    source_stub = {"company_name": None, "url": url}
                    job_data = career_scraper._extract_job_data(html, url, domain, source_stub)

                if not job_data or not job_data.get('title'):
                    results.append({"url": url, "status": "error", "error": "Could not extract job data from page"})
                    errors += 1
                    continue

                job_data['url'] = url

                # Write markdown file
                file_path = file_writer.write(job_data)

                # Save to DB
                job_id = db.add_job(
                    job_url=url,
                    job_url_normalized=normalized,
                    title=job_data.get('title'),
                    company=job_data.get('company'),
                    location=job_data.get('location'),
                    salary=job_data.get('salary'),
                    source_url_id=None,
                    file_path=file_path,
                    description=job_data.get('description'),
                )

                if not job_id:
                    results.append({"url": url, "status": "duplicate", "title": job_data.get("title")})
                    dupes += 1
                    continue

                results.append({"url": url, "status": "saved", "title": job_data.get("title"),
                                "company": job_data.get("company"), "job_id": job_id})
                saved += 1

            except Exception as e:
                results.append({"url": url, "status": "error", "error": str(e)})
                errors += 1
    finally:
        try:
            career_scraper.close()
        except Exception:
            pass
        try:
            linkedin_scraper.close()
        except Exception:
            pass

    return jsonify({
        "results": results,
        "summary": {"total": len(clean_urls), "saved": saved, "duplicates": dupes, "errors": errors}
    })


# =================== OBSIDIAN FILES API ===================

@discovery_bp.route("/api/obsidian/files", methods=["GET"])
def list_obsidian_files():
    """List markdown files from the Obsidian careers directory."""
    if not os.path.isdir(OUTPUT_DIR):
        return jsonify({"files": [], "error": "Careers directory not found"})

    files = []
    for company_dir in sorted(os.listdir(OUTPUT_DIR)):
        company_path = os.path.join(OUTPUT_DIR, company_dir)
        if not os.path.isdir(company_path):
            continue
        for fname in sorted(os.listdir(company_path)):
            if not fname.endswith('.md'):
                continue
            fpath = os.path.join(company_path, fname)
            files.append({
                "company": company_dir,
                "filename": fname,
                "title": fname.replace('.md', ''),
                "path": fpath,
            })

    return jsonify({"files": files})


@discovery_bp.route("/api/obsidian/file", methods=["POST"])
def read_obsidian_file():
    """Read and parse an Obsidian markdown file."""
    data = request.get_json()
    file_path = data.get("path", "")

    # Security: ensure the path is within OUTPUT_DIR
    abs_path = os.path.abspath(file_path)
    abs_output = os.path.abspath(OUTPUT_DIR)
    if not abs_path.startswith(abs_output):
        return jsonify({"error": "Invalid file path"}), 403

    if not os.path.isfile(abs_path):
        return jsonify({"error": "File not found"}), 404

    try:
        with open(abs_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return jsonify({"error": f"Failed to read file: {e}"}), 500

    # Parse YAML frontmatter
    metadata = {}
    body = content
    if content.startswith('---'):
        parts = content.split('---', 2)
        if len(parts) >= 3:
            frontmatter = parts[1].strip()
            body = parts[2].strip()
            for line in frontmatter.split('\n'):
                line = line.strip()
                if ':' in line and not line.startswith('-') and not line.startswith('#'):
                    key, _, val = line.partition(':')
                    key = key.strip().strip('"')
                    val = val.strip().strip('"').strip("'")
                    # Handle author array
                    if key == 'author' and val == '':
                        continue
                    if val and val != '':
                        metadata[key] = val

    # Extract source URL and company from frontmatter
    source_url = metadata.get('source', '')
    company = ''
    # Try to get company from directory name
    rel_path = os.path.relpath(abs_path, abs_output)
    parts = rel_path.split(os.sep)
    if len(parts) > 1:
        company = parts[0]

    return jsonify({
        "title": metadata.get('title', os.path.basename(abs_path).replace('.md', '')),
        "company": company,
        "source_url": source_url,
        "description": body,
        "metadata": metadata,
    })


# =================== OUTCOMES API ===================

@discovery_bp.route("/api/jobs/<int:job_id>/outcome", methods=["PUT"])
def set_outcome(job_id):
    data = request.get_json()
    status = data.get("status")
    rejected_at_stage = data.get("rejected_at_stage")
    notes = data.get("notes", "")

    if status not in ('offer', 'rejected'):
        return jsonify({"error": "Status must be 'offer' or 'rejected'"}), 400

    db.set_job_outcome(job_id, status, rejected_at_stage, notes)
    return jsonify({"message": "Outcome recorded"})


@discovery_bp.route("/api/outcomes", methods=["GET"])
def get_outcomes():
    jobs = db.get_jobs_by_stage('outcome')
    stats = {
        'total': len(jobs),
        'offers': sum(1 for j in jobs if j['status'] == 'offer'),
        'rejections': sum(1 for j in jobs if j['status'] == 'rejected'),
        'rejected_at': {
            'discovery': sum(1 for j in jobs if j.get('rejected_at_stage') == 'discovery'),
            'application': sum(1 for j in jobs if j.get('rejected_at_stage') == 'application'),
            'interview': sum(1 for j in jobs if j.get('rejected_at_stage') == 'interview'),
            'offer': sum(1 for j in jobs if j.get('rejected_at_stage') == 'offer'),
        }
    }
    return jsonify({"jobs": jobs, "stats": stats})
