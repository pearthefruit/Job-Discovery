CREATE TABLE IF NOT EXISTS target_urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE NOT NULL,
    company_name TEXT NOT NULL,
    url_type TEXT DEFAULT 'career_page',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS filters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS job_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_url TEXT UNIQUE NOT NULL,
    job_url_normalized TEXT NOT NULL,
    title TEXT,
    company TEXT,
    location TEXT,
    salary TEXT,
    status TEXT DEFAULT 'new',
    date_found DATETIME DEFAULT CURRENT_TIMESTAMP,
    description TEXT,
    source_url_id INTEGER,
    file_path TEXT,
    FOREIGN KEY(source_url_id) REFERENCES target_urls(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS scrape_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    status TEXT DEFAULT 'running',
    jobs_found INTEGER DEFAULT 0,
    jobs_new INTEGER DEFAULT 0,
    jobs_filtered INTEGER DEFAULT 0,
    jobs_dupes INTEGER DEFAULT 0,
    errors TEXT,
    total_sources INTEGER DEFAULT 0,
    current_source_index INTEGER DEFAULT 0,
    current_source_name TEXT
);

CREATE TABLE IF NOT EXISTS scrape_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    level TEXT DEFAULT 'info',
    message TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES scrape_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS selector_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    selector_type TEXT NOT NULL,
    selector TEXT NOT NULL,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    last_used DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(domain, selector_type, selector)
);

-- =================== Pipeline Extension Tables ===================

CREATE TABLE IF NOT EXISTS resumes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    content_html TEXT,
    content_json TEXT,
    original_filename TEXT,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS resume_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resume_id INTEGER NOT NULL,
    section_type TEXT NOT NULL,
    section_order INTEGER NOT NULL,
    content_html TEXT,
    company_name TEXT,
    role_title TEXT,
    dates TEXT,
    FOREIGN KEY(resume_id) REFERENCES resumes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    resume_id INTEGER NOT NULL,
    content_html TEXT,
    content_json TEXT,
    analysis_phase1 TEXT,
    analysis_phase2 TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(job_id) REFERENCES job_history(id) ON DELETE CASCADE,
    FOREIGN KEY(resume_id) REFERENCES resumes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    hook TEXT,
    content TEXT,
    tags TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS story_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    story_id INTEGER NOT NULL,
    job_id INTEGER NOT NULL,
    framework TEXT DEFAULT 'SAIL',
    reframed_content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE,
    FOREIGN KEY(job_id) REFERENCES job_history(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS job_blurbs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    role_title TEXT,
    variant_name TEXT,
    content TEXT NOT NULL
);

-- =================== Analysis History ===================

CREATE TABLE IF NOT EXISTS analysis_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL,
    phase1 TEXT,
    phase2 TEXT,
    model_used TEXT,
    provider TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(application_id) REFERENCES applications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_analysis_history_app ON analysis_history(application_id);

-- =================== AI Usage Tracking ===================

CREATE TABLE IF NOT EXISTS api_usage_log (
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
);

-- =================== Indexes ===================

CREATE INDEX IF NOT EXISTS idx_job_history_url_normalized ON job_history(job_url_normalized);
CREATE INDEX IF NOT EXISTS idx_job_history_date ON job_history(date_found);
CREATE INDEX IF NOT EXISTS idx_job_history_company ON job_history(company);
CREATE INDEX IF NOT EXISTS idx_selector_cache_domain ON selector_cache(domain);
CREATE INDEX IF NOT EXISTS idx_target_urls_active ON target_urls(is_active);
CREATE INDEX IF NOT EXISTS idx_applications_job ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_resume_sections_resume ON resume_sections(resume_id);
CREATE INDEX IF NOT EXISTS idx_story_versions_job ON story_versions(job_id);
CREATE INDEX IF NOT EXISTS idx_story_versions_story ON story_versions(story_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_usage_log(created_at);
CREATE INDEX IF NOT EXISTS idx_api_usage_provider ON api_usage_log(provider);
