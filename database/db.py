import sqlite3
import os
from contextlib import contextmanager

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import DATABASE_PATH


class JobDiscoveryDB:
    def __init__(self, db_path=None):
        self.db_path = db_path or DATABASE_PATH
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self.init_db()

    @contextmanager
    def get_connection(self):
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def init_db(self):
        schema_path = os.path.join(os.path.dirname(__file__), "schema.sql")
        with open(schema_path, "r") as f:
            schema = f.read()
        with self.get_connection() as conn:
            conn.executescript(schema)
        self._migrate()

    def _migrate(self):
        """Add columns that may be missing from an older schema."""
        migrations = [
            ("scrape_runs", "total_sources", "INTEGER DEFAULT 0"),
            ("scrape_runs", "current_source_index", "INTEGER DEFAULT 0"),
            ("scrape_runs", "current_source_name", "TEXT"),
            ("job_history", "status", "TEXT DEFAULT 'new'"),
            ("job_history", "pipeline_stage", "TEXT DEFAULT 'discovery'"),
            ("job_history", "rejected_at_stage", "TEXT"),
            ("job_history", "notes", "TEXT"),
            ("filters", "filter_type", "TEXT DEFAULT 'include'"),
            ("job_history", "interview_rounds_total", "INTEGER"),
            ("job_history", "interview_rounds_done", "INTEGER DEFAULT 0"),
            ("job_history", "interview_status", "TEXT"),
            ("job_history", "description", "TEXT"),
            ("interview_stage_stories", "custom_content", "TEXT"),
            ("interview_stages", "questions", "TEXT"),
            ("interview_stages", "debrief", "TEXT"),
            ("interview_stages", "interviewer", "TEXT"),
            ("stories", "stage_only", "INTEGER DEFAULT 0"),
            ("stories", "competency", "TEXT"),
            ("stories", "company", "TEXT"),
            ("interview_stages", "whiteboard", "TEXT"),
            ("interview_stages", "live_notes", "TEXT"),
            ("scrape_runs", "jobs_filtered", "INTEGER DEFAULT 0"),
            ("scrape_runs", "jobs_dupes", "INTEGER DEFAULT 0"),
        ]
        with self.get_connection() as conn:
            for table, column, col_type in migrations:
                try:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")
                except sqlite3.OperationalError:
                    pass  # Column already exists
            # Fix any NULL status values from before migration
            conn.execute("UPDATE job_history SET status = 'new' WHERE status IS NULL")
            conn.execute("UPDATE job_history SET pipeline_stage = 'discovery' WHERE pipeline_stage IS NULL")
            conn.execute("UPDATE filters SET filter_type = 'include' WHERE filter_type IS NULL")
            # Create indexes on migrated columns
            conn.execute("CREATE INDEX IF NOT EXISTS idx_job_history_pipeline ON job_history(pipeline_stage)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_job_history_status ON job_history(status)")
            # Interview insights table
            conn.execute("""CREATE TABLE IF NOT EXISTS interview_insights (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL,
                insight_type TEXT NOT NULL,
                framework TEXT,
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(job_id) REFERENCES job_history(id) ON DELETE CASCADE
            )""")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_interview_insights_job ON interview_insights(job_id)")
            # Interview stages table
            conn.execute("""CREATE TABLE IF NOT EXISTS interview_stages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                stage_order INTEGER NOT NULL DEFAULT 0,
                notes TEXT,
                status TEXT DEFAULT 'upcoming',
                scheduled_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(job_id) REFERENCES job_history(id) ON DELETE CASCADE
            )""")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_interview_stages_job ON interview_stages(job_id)")
            # Interview stage-story junction table
            conn.execute("""CREATE TABLE IF NOT EXISTS interview_stage_stories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                stage_id INTEGER NOT NULL,
                story_id INTEGER NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(stage_id) REFERENCES interview_stages(id) ON DELETE CASCADE,
                FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE,
                UNIQUE(stage_id, story_id)
            )""")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_stage_stories_stage ON interview_stage_stories(stage_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_stage_stories_story ON interview_stage_stories(story_id)")
            # Mock interviews table
            conn.execute("""CREATE TABLE IF NOT EXISTS mock_interviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                stage_id INTEGER NOT NULL,
                title TEXT NOT NULL DEFAULT 'Mock Practice',
                notes TEXT,
                whiteboard TEXT,
                debrief TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(stage_id) REFERENCES interview_stages(id) ON DELETE CASCADE
            )""")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_mock_interviews_stage ON mock_interviews(stage_id)")
            # API usage tracking table
            conn.execute("""CREATE TABLE IF NOT EXISTS api_usage_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                call_type TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                api_key_hint TEXT,
                prompt_tokens INTEGER DEFAULT 0,
                completion_tokens INTEGER DEFAULT 0,
                total_tokens INTEGER DEFAULT 0,
                job_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(job_id) REFERENCES job_history(id) ON DELETE SET NULL
            )""")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_usage_log(created_at)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_api_usage_provider ON api_usage_log(provider)")
            # Story rework history table
            conn.execute("""CREATE TABLE IF NOT EXISTS story_rework_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                story_id INTEGER NOT NULL,
                reworked_content TEXT NOT NULL,
                model_used TEXT,
                provider TEXT,
                target_role TEXT,
                target_company TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE
            )""")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_rework_history_story ON story_rework_history(story_id)")
            # Analysis history table
            conn.execute("""CREATE TABLE IF NOT EXISTS analysis_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                application_id INTEGER NOT NULL,
                phase1 TEXT,
                phase2 TEXT,
                model_used TEXT,
                provider TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(application_id) REFERENCES applications(id) ON DELETE CASCADE
            )""")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_analysis_history_app ON analysis_history(application_id)")

    # --- Target URLs ---

    def add_target_url(self, url, company_name, url_type="career_page"):
        with self.get_connection() as conn:
            cursor = conn.execute(
                "INSERT INTO target_urls (url, company_name, url_type) VALUES (?, ?, ?)",
                (url, company_name, url_type),
            )
            return cursor.lastrowid

    def get_all_target_urls(self):
        with self.get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM target_urls ORDER BY created_at DESC"
            ).fetchall()
            return [dict(r) for r in rows]

    def get_active_target_urls(self):
        with self.get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM target_urls WHERE is_active = 1 ORDER BY created_at DESC"
            ).fetchall()
            return [dict(r) for r in rows]

    def update_target_url(self, url_id, **kwargs):
        allowed = {"url", "company_name", "is_active", "url_type"}
        fields = {k: v for k, v in kwargs.items() if k in allowed and v is not None}
        if not fields:
            return
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        values = list(fields.values()) + [url_id]
        with self.get_connection() as conn:
            conn.execute(
                f"UPDATE target_urls SET {set_clause} WHERE id = ?", values
            )

    def delete_target_url(self, url_id):
        with self.get_connection() as conn:
            conn.execute("DELETE FROM target_urls WHERE id = ?", (url_id,))

    # --- Filters ---

    def add_filter(self, keyword, filter_type='include'):
        with self.get_connection() as conn:
            cursor = conn.execute(
                "INSERT INTO filters (keyword, filter_type) VALUES (?, ?)",
                (keyword, filter_type),
            )
            return cursor.lastrowid

    def get_all_filters(self):
        with self.get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM filters ORDER BY created_at DESC"
            ).fetchall()
            return [dict(r) for r in rows]

    def delete_filter(self, filter_id):
        with self.get_connection() as conn:
            conn.execute("DELETE FROM filters WHERE id = ?", (filter_id,))

    def delete_all_filters(self):
        with self.get_connection() as conn:
            conn.execute("DELETE FROM filters")

    # --- Job History ---

    def add_job(self, job_url, job_url_normalized, title=None, company=None,
                location=None, salary=None, source_url_id=None, file_path=None,
                description=None, status='new'):
        with self.get_connection() as conn:
            cursor = conn.execute(
                """INSERT OR IGNORE INTO job_history
                   (job_url, job_url_normalized, title, company, location, salary,
                    source_url_id, file_path, description, status)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (job_url, job_url_normalized, title, company, location, salary,
                 source_url_id, file_path, description, status),
            )
            return cursor.lastrowid

    def get_job_by_normalized_url(self, normalized_url):
        with self.get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM job_history WHERE job_url_normalized = ?",
                (normalized_url,),
            ).fetchone()
            return dict(row) if row else None

    def get_all_jobs(self, limit=10000, offset=0):
        with self.get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM job_history ORDER BY date_found DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_job_count(self):
        with self.get_connection() as conn:
            row = conn.execute("SELECT COUNT(*) as cnt FROM job_history").fetchone()
            return row["cnt"]

    def get_filtered_jobs(self, limit=200):
        with self.get_connection() as conn:
            rows = conn.execute(
                """SELECT * FROM job_history
                   WHERE status = 'filtered'
                   ORDER BY date_found DESC LIMIT ?""",
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]

    def search_jobs(self, query):
        with self.get_connection() as conn:
            like = f"%{query}%"
            rows = conn.execute(
                """SELECT * FROM job_history
                   WHERE title LIKE ? OR company LIKE ? OR location LIKE ?
                   ORDER BY date_found DESC LIMIT 200""",
                (like, like, like),
            ).fetchall()
            return [dict(r) for r in rows]

    def update_job_status(self, job_id, status):
        allowed = {'new', 'greenlighted', 'ignored', 'filtered', 'preparing', 'applied',
                   'interviewing', 'offer', 'rejected'}
        if status not in allowed:
            raise ValueError(f"Invalid status: {status}")
        # Auto-set pipeline_stage based on status
        stage_map = {
            'new': 'discovery', 'greenlighted': 'application', 'ignored': 'discovery',
            'filtered': 'discovery', 'preparing': 'application', 'applied': 'application',
            'interviewing': 'interview', 'offer': 'outcome', 'rejected': 'outcome',
        }
        stage = stage_map.get(status, 'discovery')
        with self.get_connection() as conn:
            conn.execute(
                "UPDATE job_history SET status = ?, pipeline_stage = ? WHERE id = ?",
                (status, stage, job_id),
            )
        # Auto-create default interview stage when entering interview phase
        if status == 'interviewing':
            self.ensure_default_stage(job_id)

    def update_pipeline_stage(self, job_id, stage):
        allowed = {'discovery', 'application', 'interview', 'outcome'}
        if stage not in allowed:
            raise ValueError(f"Invalid pipeline stage: {stage}")
        with self.get_connection() as conn:
            conn.execute(
                "UPDATE job_history SET pipeline_stage = ? WHERE id = ?",
                (stage, job_id),
            )

    def set_job_outcome(self, job_id, status, rejected_at_stage=None, notes=None):
        with self.get_connection() as conn:
            conn.execute(
                """UPDATE job_history
                   SET status = ?, pipeline_stage = 'outcome',
                       rejected_at_stage = ?, notes = ?
                   WHERE id = ?""",
                (status, rejected_at_stage, notes, job_id),
            )

    def update_job_notes(self, job_id, notes):
        with self.get_connection() as conn:
            conn.execute(
                "UPDATE job_history SET notes = ? WHERE id = ?",
                (notes, job_id),
            )

    def update_job_description(self, job_id, description):
        with self.get_connection() as conn:
            conn.execute(
                "UPDATE job_history SET description = ? WHERE id = ?",
                (description, job_id),
            )

    def update_job_fields(self, job_id, **kwargs):
        allowed = {'title', 'company', 'location', 'salary', 'description', 'job_url', 'file_path'}
        fields = {k: v for k, v in kwargs.items() if k in allowed and v is not None}
        if not fields:
            return
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        values = list(fields.values()) + [job_id]
        with self.get_connection() as conn:
            conn.execute(f"UPDATE job_history SET {set_clause} WHERE id = ?", values)

    def update_interview_tracking(self, job_id, **kwargs):
        allowed = {'interview_rounds_total', 'interview_rounds_done', 'interview_status'}
        fields = {k: v for k, v in kwargs.items() if k in allowed and v is not None}
        if not fields:
            return
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        values = list(fields.values()) + [job_id]
        with self.get_connection() as conn:
            conn.execute(f"UPDATE job_history SET {set_clause} WHERE id = ?", values)

    def get_job_by_id(self, job_id):
        with self.get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM job_history WHERE id = ?", (job_id,)
            ).fetchone()
            return dict(row) if row else None

    def get_jobs_by_stage(self, stage):
        with self.get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM job_history WHERE pipeline_stage = ? ORDER BY date_found DESC",
                (stage,),
            ).fetchall()
            return [dict(r) for r in rows]

    # --- Scrape Runs ---

    def start_scrape_run(self, total_sources=0):
        with self.get_connection() as conn:
            cursor = conn.execute(
                "INSERT INTO scrape_runs (status, total_sources) VALUES ('running', ?)",
                (total_sources,),
            )
            return cursor.lastrowid

    def update_scrape_run_sources(self, run_id, total_sources):
        with self.get_connection() as conn:
            conn.execute(
                "UPDATE scrape_runs SET total_sources = ? WHERE id = ?",
                (total_sources, run_id),
            )

    def update_scrape_progress(self, run_id, current_source_index, current_source_name,
                               jobs_found=None, jobs_new=None,
                               jobs_filtered=None, jobs_dupes=None):
        with self.get_connection() as conn:
            if jobs_found is not None and jobs_new is not None:
                conn.execute(
                    """UPDATE scrape_runs
                       SET current_source_index = ?, current_source_name = ?,
                           jobs_found = ?, jobs_new = ?,
                           jobs_filtered = COALESCE(?, jobs_filtered),
                           jobs_dupes = COALESCE(?, jobs_dupes)
                       WHERE id = ?""",
                    (current_source_index, current_source_name, jobs_found, jobs_new,
                     jobs_filtered, jobs_dupes, run_id),
                )
            else:
                conn.execute(
                    """UPDATE scrape_runs
                       SET current_source_index = ?, current_source_name = ?
                       WHERE id = ?""",
                    (current_source_index, current_source_name, run_id),
                )

    def finish_scrape_run(self, run_id, status, jobs_found, jobs_new,
                          errors=None, jobs_filtered=0, jobs_dupes=0):
        with self.get_connection() as conn:
            conn.execute(
                """UPDATE scrape_runs
                   SET finished_at = CURRENT_TIMESTAMP, status = ?, jobs_found = ?,
                       jobs_new = ?, jobs_filtered = ?, jobs_dupes = ?,
                       errors = ?, current_source_name = NULL
                   WHERE id = ?""",
                (status, jobs_found, jobs_new, jobs_filtered, jobs_dupes, errors, run_id),
            )

    def get_latest_run(self):
        with self.get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM scrape_runs ORDER BY id DESC LIMIT 1"
            ).fetchone()
            return dict(row) if row else None

    def is_scraper_running(self):
        with self.get_connection() as conn:
            # Auto-expire runs stuck as "running" for more than 10 minutes
            conn.execute(
                """UPDATE scrape_runs SET status = 'failed',
                   finished_at = CURRENT_TIMESTAMP,
                   errors = 'Auto-expired: stuck for >10 minutes'
                   WHERE status = 'running'
                   AND started_at < datetime('now', '-10 minutes')"""
            )
            row = conn.execute(
                "SELECT COUNT(*) as cnt FROM scrape_runs WHERE status = 'running'"
            ).fetchone()
            return row["cnt"] > 0

    # --- Scrape Log ---

    def add_log(self, run_id, message, level="info"):
        with self.get_connection() as conn:
            conn.execute(
                "INSERT INTO scrape_log (run_id, level, message) VALUES (?, ?, ?)",
                (run_id, level, message),
            )

    def get_logs(self, run_id, since_id=0, limit=200):
        with self.get_connection() as conn:
            rows = conn.execute(
                """SELECT * FROM scrape_log
                   WHERE run_id = ? AND id > ?
                   ORDER BY id ASC LIMIT ?""",
                (run_id, since_id, limit),
            ).fetchall()
            return [dict(r) for r in rows]

    # --- Selector Cache ---

    def get_selectors(self, domain, selector_type):
        with self.get_connection() as conn:
            rows = conn.execute(
                """SELECT * FROM selector_cache
                   WHERE domain = ? AND selector_type = ?
                   ORDER BY (success_count - failure_count) DESC""",
                (domain, selector_type),
            ).fetchall()
            return [dict(r) for r in rows]

    def upsert_selector(self, domain, selector_type, selector):
        with self.get_connection() as conn:
            conn.execute(
                """INSERT INTO selector_cache (domain, selector_type, selector)
                   VALUES (?, ?, ?)
                   ON CONFLICT(domain, selector_type, selector)
                   DO UPDATE SET last_used = CURRENT_TIMESTAMP""",
                (domain, selector_type, selector),
            )

    def record_selector_success(self, domain, selector_type, selector):
        with self.get_connection() as conn:
            conn.execute(
                """INSERT INTO selector_cache (domain, selector_type, selector, success_count)
                   VALUES (?, ?, ?, 1)
                   ON CONFLICT(domain, selector_type, selector)
                   DO UPDATE SET success_count = success_count + 1,
                                 last_used = CURRENT_TIMESTAMP""",
                (domain, selector_type, selector),
            )

    def record_selector_failure(self, domain, selector_type, selector):
        with self.get_connection() as conn:
            conn.execute(
                """INSERT INTO selector_cache (domain, selector_type, selector, failure_count)
                   VALUES (?, ?, ?, 1)
                   ON CONFLICT(domain, selector_type, selector)
                   DO UPDATE SET failure_count = failure_count + 1,
                                 last_used = CURRENT_TIMESTAMP""",
                (domain, selector_type, selector),
            )

    # --- Dashboard Stats ---

    def get_stats(self):
        with self.get_connection() as conn:
            total = conn.execute("SELECT COUNT(*) as cnt FROM job_history").fetchone()["cnt"]
            today = conn.execute(
                "SELECT COUNT(*) as cnt FROM job_history WHERE date(date_found, 'localtime') = date('now', 'localtime')"
            ).fetchone()["cnt"]
            sources = conn.execute(
                "SELECT COUNT(*) as cnt FROM target_urls WHERE is_active = 1"
            ).fetchone()["cnt"]
            filters = conn.execute(
                "SELECT COUNT(*) as cnt FROM filters"
            ).fetchone()["cnt"]
            return {
                "total_jobs": total,
                "new_today": today,
                "active_sources": sources,
                "active_filters": filters,
            }

    def get_pipeline_stats(self):
        with self.get_connection() as conn:
            stages = {}
            for stage in ('discovery', 'application', 'interview', 'outcome'):
                stages[stage] = conn.execute(
                    "SELECT COUNT(*) as cnt FROM job_history WHERE pipeline_stage = ?",
                    (stage,),
                ).fetchone()["cnt"]
            stages['greenlighted'] = conn.execute(
                "SELECT COUNT(*) as cnt FROM job_history WHERE status = 'greenlighted'"
            ).fetchone()["cnt"]
            stages['offers'] = conn.execute(
                "SELECT COUNT(*) as cnt FROM job_history WHERE status = 'offer'"
            ).fetchone()["cnt"]
            stages['rejections'] = conn.execute(
                "SELECT COUNT(*) as cnt FROM job_history WHERE status = 'rejected'"
            ).fetchone()["cnt"]
            return stages

    # --- AI Usage Tracking ---

    def log_api_usage(self, call_type, provider, model, api_key_hint='',
                      prompt_tokens=0, completion_tokens=0, total_tokens=0, job_id=None):
        with self.get_connection() as conn:
            conn.execute(
                """INSERT INTO api_usage_log
                   (call_type, provider, model, api_key_hint, prompt_tokens, completion_tokens, total_tokens, job_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (call_type, provider, model, api_key_hint,
                 prompt_tokens, completion_tokens, total_tokens, job_id),
            )

    def get_ai_usage_stats(self):
        with self.get_connection() as conn:
            total_calls = conn.execute("SELECT COUNT(*) as cnt FROM api_usage_log").fetchone()["cnt"]
            total_tokens = conn.execute("SELECT COALESCE(SUM(total_tokens),0) as s FROM api_usage_log").fetchone()["s"]
            today_calls = conn.execute(
                "SELECT COUNT(*) as cnt FROM api_usage_log WHERE date(created_at, 'localtime') = date('now', 'localtime')"
            ).fetchone()["cnt"]
            today_tokens = conn.execute(
                "SELECT COALESCE(SUM(total_tokens),0) as s FROM api_usage_log WHERE date(created_at, 'localtime') = date('now', 'localtime')"
            ).fetchone()["s"]

            by_model = [dict(r) for r in conn.execute(
                "SELECT model, COUNT(*) as calls, COALESCE(SUM(total_tokens),0) as tokens FROM api_usage_log GROUP BY model ORDER BY calls DESC"
            ).fetchall()]

            by_type = [dict(r) for r in conn.execute(
                "SELECT call_type, COUNT(*) as calls, COALESCE(SUM(total_tokens),0) as tokens FROM api_usage_log GROUP BY call_type ORDER BY calls DESC"
            ).fetchall()]

            by_key = [dict(r) for r in conn.execute(
                "SELECT api_key_hint as key_hint, COUNT(*) as calls, COALESCE(SUM(total_tokens),0) as tokens FROM api_usage_log WHERE api_key_hint IS NOT NULL GROUP BY api_key_hint ORDER BY calls DESC"
            ).fetchall()]

            recent = [dict(r) for r in conn.execute(
                "SELECT call_type, provider, model, prompt_tokens, completion_tokens, total_tokens, created_at FROM api_usage_log ORDER BY created_at DESC LIMIT 10"
            ).fetchall()]

            return {
                "total_calls": total_calls,
                "total_tokens": total_tokens,
                "today_calls": today_calls,
                "today_tokens": today_tokens,
                "by_model": by_model,
                "by_type": by_type,
                "by_key": by_key,
                "recent": recent,
            }

    # --- Resumes ---

    def add_resume(self, name, content_html=None, content_json=None, original_filename=None):
        with self.get_connection() as conn:
            cursor = conn.execute(
                """INSERT INTO resumes (name, content_html, content_json, original_filename)
                   VALUES (?, ?, ?, ?)""",
                (name, content_html, content_json, original_filename),
            )
            return cursor.lastrowid

    def get_resume(self, resume_id):
        with self.get_connection() as conn:
            row = conn.execute("SELECT * FROM resumes WHERE id = ?", (resume_id,)).fetchone()
            return dict(row) if row else None

    def get_all_resumes(self):
        with self.get_connection() as conn:
            rows = conn.execute("SELECT * FROM resumes ORDER BY uploaded_at DESC").fetchall()
            return [dict(r) for r in rows]

    def update_resume_name(self, resume_id, name):
        with self.get_connection() as conn:
            conn.execute("UPDATE resumes SET name = ? WHERE id = ?", (name, resume_id))

    def delete_resume(self, resume_id):
        with self.get_connection() as conn:
            conn.execute("DELETE FROM resumes WHERE id = ?", (resume_id,))

    # --- Resume Sections ---

    def add_resume_section(self, resume_id, section_type, section_order,
                           content_html=None, company_name=None, role_title=None, dates=None):
        with self.get_connection() as conn:
            cursor = conn.execute(
                """INSERT INTO resume_sections
                   (resume_id, section_type, section_order, content_html, company_name, role_title, dates)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (resume_id, section_type, section_order, content_html, company_name, role_title, dates),
            )
            return cursor.lastrowid

    def get_sections_for_resume(self, resume_id):
        with self.get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM resume_sections WHERE resume_id = ? ORDER BY section_order",
                (resume_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    def update_section(self, section_id, **kwargs):
        allowed = {"content_html", "company_name", "role_title", "dates"}
        fields = {k: v for k, v in kwargs.items() if k in allowed}
        if not fields:
            return
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        values = list(fields.values()) + [section_id]
        with self.get_connection() as conn:
            conn.execute(f"UPDATE resume_sections SET {set_clause} WHERE id = ?", values)

    # --- Applications ---

    def create_application(self, job_id, resume_id, content_html=None, content_json=None):
        with self.get_connection() as conn:
            cursor = conn.execute(
                """INSERT INTO applications (job_id, resume_id, content_html, content_json)
                   VALUES (?, ?, ?, ?)""",
                (job_id, resume_id, content_html, content_json),
            )
            return cursor.lastrowid

    def get_application(self, app_id):
        with self.get_connection() as conn:
            row = conn.execute("SELECT * FROM applications WHERE id = ?", (app_id,)).fetchone()
            return dict(row) if row else None

    def get_application_by_job(self, job_id):
        with self.get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM applications WHERE job_id = ? ORDER BY created_at DESC LIMIT 1",
                (job_id,),
            ).fetchone()
            return dict(row) if row else None

    def update_application(self, app_id, **kwargs):
        allowed = {"content_html", "content_json", "analysis_phase1", "analysis_phase2", "resume_id"}
        fields = {k: v for k, v in kwargs.items() if k in allowed}
        if not fields:
            return
        fields["updated_at"] = "CURRENT_TIMESTAMP"
        set_parts = []
        values = []
        for k, v in fields.items():
            if v == "CURRENT_TIMESTAMP":
                set_parts.append(f"{k} = CURRENT_TIMESTAMP")
            else:
                set_parts.append(f"{k} = ?")
                values.append(v)
        values.append(app_id)
        with self.get_connection() as conn:
            conn.execute(
                f"UPDATE applications SET {', '.join(set_parts)} WHERE id = ?", values
            )

    # --- Analysis History ---

    def add_analysis_history(self, application_id, phase1=None, phase2=None,
                             model_used=None, provider=None):
        with self.get_connection() as conn:
            cursor = conn.execute(
                """INSERT INTO analysis_history
                   (application_id, phase1, phase2, model_used, provider)
                   VALUES (?, ?, ?, ?, ?)""",
                (application_id, phase1, phase2, model_used, provider),
            )
            return cursor.lastrowid

    def get_analysis_history(self, application_id):
        with self.get_connection() as conn:
            rows = conn.execute(
                """SELECT * FROM analysis_history
                   WHERE application_id = ?
                   ORDER BY created_at DESC""",
                (application_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    # --- Stories ---

    def add_story(self, title, hook=None, content=None, tags=None, stage_only=0,
                  competency=None, company=None):
        with self.get_connection() as conn:
            cursor = conn.execute(
                "INSERT INTO stories (title, hook, content, tags, stage_only, competency, company) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (title, hook, content, tags, stage_only, competency, company),
            )
            return cursor.lastrowid

    def get_story(self, story_id):
        with self.get_connection() as conn:
            row = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
            return dict(row) if row else None

    def get_all_stories(self, include_stage_only=False):
        with self.get_connection() as conn:
            if include_stage_only:
                rows = conn.execute("SELECT * FROM stories ORDER BY updated_at DESC").fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM stories WHERE stage_only = 0 OR stage_only IS NULL ORDER BY updated_at DESC"
                ).fetchall()
            return [dict(r) for r in rows]

    def update_story(self, story_id, **kwargs):
        allowed = {"title", "hook", "content", "tags", "stage_only", "competency", "company"}
        fields = {k: v for k, v in kwargs.items() if k in allowed}
        if not fields:
            return
        fields_sql = ", ".join(f"{k} = ?" for k in fields)
        values = list(fields.values()) + [story_id]
        with self.get_connection() as conn:
            conn.execute(
                f"UPDATE stories SET {fields_sql}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                values,
            )

    def delete_story(self, story_id):
        with self.get_connection() as conn:
            conn.execute("DELETE FROM stories WHERE id = ?", (story_id,))

    # --- Story Versions ---

    def add_story_version(self, story_id, job_id, framework='SAIL', reframed_content=None):
        with self.get_connection() as conn:
            cursor = conn.execute(
                """INSERT INTO story_versions (story_id, job_id, framework, reframed_content)
                   VALUES (?, ?, ?, ?)""",
                (story_id, job_id, framework, reframed_content),
            )
            return cursor.lastrowid

    def get_versions_for_job(self, job_id):
        with self.get_connection() as conn:
            rows = conn.execute(
                """SELECT sv.*, s.title as story_title
                   FROM story_versions sv
                   JOIN stories s ON sv.story_id = s.id
                   WHERE sv.job_id = ?
                   ORDER BY sv.created_at DESC""",
                (job_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_versions_for_story(self, story_id):
        with self.get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM story_versions WHERE story_id = ? ORDER BY created_at DESC",
                (story_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    def delete_story_version(self, version_id):
        with self.get_connection() as conn:
            conn.execute("DELETE FROM story_versions WHERE id = ?", (version_id,))

    # --- Story Rework History ---

    def add_rework_history(self, story_id, reworked_content, model_used=None,
                           provider=None, target_role=None, target_company=None):
        with self.get_connection() as conn:
            cursor = conn.execute(
                """INSERT INTO story_rework_history
                   (story_id, reworked_content, model_used, provider, target_role, target_company)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (story_id, reworked_content, model_used, provider, target_role, target_company),
            )
            return cursor.lastrowid

    def get_rework_history(self, story_id):
        with self.get_connection() as conn:
            rows = conn.execute(
                """SELECT * FROM story_rework_history
                   WHERE story_id = ? ORDER BY created_at DESC""",
                (story_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    def delete_rework_history(self, rework_id):
        with self.get_connection() as conn:
            conn.execute("DELETE FROM story_rework_history WHERE id = ?", (rework_id,))

    def get_rework_entry(self, rework_id):
        with self.get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM story_rework_history WHERE id = ?", (rework_id,),
            ).fetchone()
            return dict(row) if row else None

    # --- Interview Insights ---

    def add_interview_insight(self, job_id, insight_type, framework, content):
        with self.get_connection() as conn:
            cursor = conn.execute(
                """INSERT INTO interview_insights (job_id, insight_type, framework, content)
                   VALUES (?, ?, ?, ?)""",
                (job_id, insight_type, framework, content),
            )
            return cursor.lastrowid

    def get_insights_for_job(self, job_id):
        with self.get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM interview_insights WHERE job_id = ? ORDER BY created_at DESC",
                (job_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    def delete_interview_insight(self, insight_id):
        with self.get_connection() as conn:
            conn.execute("DELETE FROM interview_insights WHERE id = ?", (insight_id,))

    # --- Interview Stages ---

    def ensure_default_stage(self, job_id):
        """Create default 'Recruiter Screen' stage if no stages exist for this job."""
        with self.get_connection() as conn:
            count = conn.execute(
                "SELECT COUNT(*) as cnt FROM interview_stages WHERE job_id = ?",
                (job_id,),
            ).fetchone()["cnt"]
            if count == 0:
                conn.execute(
                    """INSERT INTO interview_stages (job_id, name, stage_order, status)
                       VALUES (?, 'Recruiter Screen', 0, 'current')""",
                    (job_id,),
                )

    def add_interview_stage(self, job_id, name, stage_order=0, status='upcoming'):
        with self.get_connection() as conn:
            cursor = conn.execute(
                """INSERT INTO interview_stages (job_id, name, stage_order, status)
                   VALUES (?, ?, ?, ?)""",
                (job_id, name, stage_order, status),
            )
            return cursor.lastrowid

    def get_stages_for_job(self, job_id):
        with self.get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM interview_stages WHERE job_id = ? ORDER BY stage_order ASC",
                (job_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_stage(self, stage_id):
        with self.get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM interview_stages WHERE id = ?", (stage_id,)
            ).fetchone()
            return dict(row) if row else None

    def update_stage(self, stage_id, **kwargs):
        allowed = {"name", "stage_order", "notes", "status", "scheduled_at", "questions", "debrief", "interviewer", "whiteboard", "live_notes"}
        fields = {k: v for k, v in kwargs.items() if k in allowed}
        if not fields:
            return
        fields_sql = ", ".join(f"{k} = ?" for k in fields)
        values = list(fields.values()) + [stage_id]
        with self.get_connection() as conn:
            conn.execute(
                f"UPDATE interview_stages SET {fields_sql}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                values,
            )

    def delete_stage(self, stage_id):
        with self.get_connection() as conn:
            conn.execute("DELETE FROM interview_stages WHERE id = ?", (stage_id,))

    def reorder_stages(self, job_id, stage_ids):
        """Reorder stages based on list of stage IDs in desired order."""
        with self.get_connection() as conn:
            for order, stage_id in enumerate(stage_ids):
                conn.execute(
                    "UPDATE interview_stages SET stage_order = ? WHERE id = ? AND job_id = ?",
                    (order, stage_id, job_id),
                )

    # --- Interview Stage Stories ---

    def assign_story_to_stage(self, stage_id, story_id, sort_order=0):
        with self.get_connection() as conn:
            cursor = conn.execute(
                """INSERT OR IGNORE INTO interview_stage_stories (stage_id, story_id, sort_order)
                   VALUES (?, ?, ?)""",
                (stage_id, story_id, sort_order),
            )
            return cursor.lastrowid

    def remove_story_from_stage(self, stage_id, story_id):
        with self.get_connection() as conn:
            conn.execute(
                "DELETE FROM interview_stage_stories WHERE stage_id = ? AND story_id = ?",
                (stage_id, story_id),
            )

    def get_stories_for_stage(self, stage_id):
        with self.get_connection() as conn:
            rows = conn.execute(
                """SELECT iss.*, s.title, s.hook, s.content, s.tags, s.stage_only
                   FROM interview_stage_stories iss
                   JOIN stories s ON iss.story_id = s.id
                   WHERE iss.stage_id = ?
                   ORDER BY iss.sort_order ASC""",
                (stage_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    def update_stage_story_content(self, stage_id, story_id, custom_content):
        """Update the custom content for a story copy assigned to a stage."""
        with self.get_connection() as conn:
            conn.execute(
                """UPDATE interview_stage_stories SET custom_content = ?
                   WHERE stage_id = ? AND story_id = ?""",
                (custom_content, stage_id, story_id),
            )

    def reorder_stage_stories(self, stage_id, story_ids):
        """Reorder stories within a stage."""
        with self.get_connection() as conn:
            for order, story_id in enumerate(story_ids):
                conn.execute(
                    """UPDATE interview_stage_stories SET sort_order = ?
                       WHERE stage_id = ? AND story_id = ?""",
                    (order, stage_id, story_id),
                )

    # --- Mock Interviews ---

    def add_mock_interview(self, stage_id, title="Mock Practice"):
        with self.get_connection() as conn:
            cursor = conn.execute(
                "INSERT INTO mock_interviews (stage_id, title) VALUES (?, ?)",
                (stage_id, title),
            )
            return cursor.lastrowid

    def get_mock_interviews(self, stage_id):
        with self.get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM mock_interviews WHERE stage_id = ? ORDER BY created_at ASC",
                (stage_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    def update_mock_interview(self, mock_id, **kwargs):
        allowed = {"title", "notes", "whiteboard", "debrief"}
        fields = {k: v for k, v in kwargs.items() if k in allowed}
        if not fields:
            return
        fields_sql = ", ".join(f"{k} = ?" for k in fields)
        values = list(fields.values()) + [mock_id]
        with self.get_connection() as conn:
            conn.execute(
                f"UPDATE mock_interviews SET {fields_sql}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                values,
            )

    def delete_mock_interview(self, mock_id):
        with self.get_connection() as conn:
            conn.execute("DELETE FROM mock_interviews WHERE id = ?", (mock_id,))

    # --- Job Blurbs ---

    def add_blurb(self, company_name, content, role_title=None, variant_name=None):
        with self.get_connection() as conn:
            cursor = conn.execute(
                """INSERT INTO job_blurbs (company_name, role_title, variant_name, content)
                   VALUES (?, ?, ?, ?)""",
                (company_name, role_title, variant_name, content),
            )
            return cursor.lastrowid

    def get_all_blurbs(self):
        with self.get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM job_blurbs ORDER BY company_name, variant_name"
            ).fetchall()
            return [dict(r) for r in rows]

    def get_blurbs_for_company(self, company_name):
        with self.get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM job_blurbs WHERE company_name = ?", (company_name,)
            ).fetchall()
            return [dict(r) for r in rows]

    def delete_blurb(self, blurb_id):
        with self.get_connection() as conn:
            conn.execute("DELETE FROM job_blurbs WHERE id = ?", (blurb_id,))
