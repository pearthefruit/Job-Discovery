# JobDiscovery

Flask-based job discovery engine with AI-powered resume analysis, interview prep, and pipeline tracking. Single-page app frontend served by Flask. SQLite database. Personal tool with plans to evolve into the public-facing job-agent-public (Next.js) app.

## Commands

```bash
pip install -r requirements.txt   # Install dependencies
python app.py                     # Flask server on port 5000
```

## Dependencies

flask, beautifulsoup4, httpx, google-generativeai, python-docx (implied)

## Project Structure

```
JobDiscovery/
├── app.py                          # Flask app init + route registration
├── config.py                       # API keys, paths, timeouts, model selection
├── requirements.txt
├── database/
│   ├── db.py                       # JobDiscoveryDB — SQLite wrapper (all queries)
│   ├── schema.sql                  # Full schema DDL
│   └── jobdiscovery.db             # SQLite database file
├── scraper/
│   ├── engine.py                   # ScrapeEngine — main orchestrator
│   ├── ats_api.py                  # Greenhouse, Lever, Ashby JSON API scrapers
│   ├── career_page.py              # Generic career page scraper (tiered extraction)
│   ├── linkedin.py                 # LinkedIn guest API scraper
│   ├── extractors.py               # Regex company/title extraction from URLs
│   ├── dedup.py                    # URL normalization + duplicate detection
│   ├── llm_extract.py              # Gemini LLM extraction (Tier 2 fallback)
│   ├── selectors.py                # CSS selector registry (hardcoded + learned)
│   ├── file_writer.py              # Markdown writer (Obsidian vault output)
│   └── logger.py                   # ScrapeLogger — per-run log manager
├── routes/
│   ├── discovery.py                # Sources, filters, jobs, scraper control, stats
│   ├── application.py              # Resume upload/parse, applications, AI analysis, export
│   └── interview.py                # Stories, story versions, interview prep, reframing
├── resume/
│   ├── parser.py                   # .docx → sectional HTML parser
│   ├── exporter.py                 # Sections → .docx with formatting + margin presets
│   └── story_parser.py             # SAIL/STARI text → structured story objects
├── ai/
│   ├── client.py                   # AIClient — Gemini (primary) + Claude (fallback)
│   └── prompts.py                  # All analysis prompts (applying, bullets, SAIL, STARI, STARFAQS)
├── static/
│   ├── css/style.css               # Frontend styling
│   ├── js/app.js                   # SPA logic (tabs, job board, editors, scraper UI)
│   └── js/editor.js                # Resume section editor
├── templates/
│   └── index.html                  # Single-page app shell
└── uploads/                        # Uploaded resume files
```

## Database Schema (SQLite)

**target_urls** — job sources to scrape
- `url` (unique), `company_name`, `url_type` (career_page | linkedin_serp | ats_api), `is_active`

**filters** — include/exclude keyword filters
- `keyword` (unique), `filter_type` (include | exclude)

**job_history** — all discovered jobs
- `job_url`, `job_url_normalized` (unique), `title`, `company`, `location`, `salary`
- `status` (new | greenlighted | ignored | preparing | applied | interviewing | offer | rejected)
- `pipeline_stage` (discovery | application | interview | outcome)
- `date_found`, `file_path`, `source_url_id`, `notes`
- `interview_rounds_total`, `interview_rounds_done`, `interview_status`
- `rejected_at_stage`

**scrape_runs** — scraping run history
- `started_at`, `finished_at`, `status` (running | completed | failed)
- `jobs_found`, `jobs_new`, `errors`, `current_source_index`, `current_source_name`, `total_sources`

**scrape_log** — per-run log entries
- `run_id`, `timestamp`, `level` (info | success | warn | error | step), `message`

**selector_cache** — learned CSS selectors per domain
- `domain`, `selector_type`, `selector`, `success_count`, `failure_count`, `last_used`

**resumes** — uploaded resumes
- `name`, `content_html`, `content_json`, `original_filename`, `uploaded_at`

**resume_sections** — parsed resume sections
- `resume_id` (FK), `section_type`, `section_order`, `content_html`, `company_name`, `role_title`, `dates`

**applications** — job applications with AI analysis
- `job_id` (FK), `resume_id` (FK), `content_html`, `content_json`
- `analysis_phase1` (profile assessment), `analysis_phase2` (bullet analysis)

**stories** — interview story bank (SAIL format)
- `title`, `hook`, `content`, `tags`, `created_at`, `updated_at`

**story_versions** — job-specific story reframings
- `story_id` (FK), `job_id` (FK), `framework` (SAIL | STARI | STARFAQS), `reframed_content`

**interview_insights** — saved interview prep analyses
- `job_id` (FK), `insight_type` (prep | rank), `framework`, `content`

**job_blurbs** — pre-written role descriptions
- `company_name`, `role_title`, `variant_name`, `content`

## API Endpoints

### Discovery (routes/discovery.py)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sources` | List all target URLs |
| POST | `/api/sources` | Add source (auto-detects LinkedIn) |
| PUT | `/api/sources/<id>` | Update source |
| DELETE | `/api/sources/<id>` | Delete source |
| GET | `/api/filters` | List keyword filters |
| POST | `/api/filters` | Add filter (include/exclude) |
| DELETE | `/api/filters/<id>` | Delete filter |
| GET | `/api/jobs` | List jobs (supports limit, offset, search, stage) |
| PUT | `/api/jobs/<id>/status` | Update job status |
| PUT | `/api/jobs/<id>/pipeline` | Update pipeline stage |
| PUT | `/api/jobs/<id>/notes` | Add/update notes (JSON activity log) |
| GET | `/api/jobs/<id>/activity-log` | Get activity entries |
| POST | `/api/jobs/<id>/activity-log` | Add timestamped activity entry |
| GET | `/api/stats` | Dashboard stats |
| GET | `/api/pipeline-stats` | Pipeline stage breakdown |
| POST | `/api/scraper/run` | Start scraper (background thread) |
| GET | `/api/scraper/status` | Scraper running status + latest run |
| GET | `/api/scraper/log` | Stream logs from current run (long-poll) |
| PUT | `/api/jobs/<id>/outcome` | Record offer/rejection |
| GET | `/api/outcomes` | All outcome-stage jobs with stats |

### Application (routes/application.py)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/resumes` | List uploaded resumes |
| GET | `/api/resumes/<id>` | Get resume + parsed sections |
| POST | `/api/resumes/upload` | Upload .docx, parse into sections |
| DELETE | `/api/resumes/<id>` | Delete resume |
| POST | `/api/applications` | Create application (link job + resume) |
| GET | `/api/applications/<id>` | Get application + sections |
| GET | `/api/applications/job/<id>` | Get application for a specific job |
| PUT | `/api/applications/<id>/content` | Save edited content |
| POST | `/api/applications/<id>/analyze` | Two-phase AI analysis |
| GET | `/api/applications/<id>/export/docx` | Export as .docx (margin presets) |
| POST | `/api/applications/<id>/apply` | Mark job as applied |

### Interview (routes/interview.py)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/stories` | List all stories |
| POST | `/api/stories` | Create story |
| PUT | `/api/stories/<id>` | Update story |
| DELETE | `/api/stories/<id>` | Delete story |
| POST | `/api/stories/import` | Import SAIL stories from text |
| POST | `/api/story-versions` | Save job-specific reframing |
| GET | `/api/story-versions/job/<id>` | Get story versions for job |
| DELETE | `/api/story-versions/<id>` | Delete story version |
| POST | `/api/interview-prep/<id>/analyze` | Interview analysis (SAIL/STARI/STARFAQS) |
| POST | `/api/interview-prep/<id>/recommend-stories` | AI-ranked story recommendations |
| POST | `/api/interview-prep/<id>/reframe-story` | Reframe one story for a role |
| POST | `/api/stories/generate` | Generate SAIL story from bullet |
| POST | `/api/stories/<id>/build` | Guided SAIL story expansion |
| PUT | `/api/jobs/<id>/interview-tracking` | Update interview round tracking |
| GET | `/api/interview-prep/<id>/insights` | Get saved insights |
| DELETE | `/api/interview-prep/<id>/insights/<iid>` | Delete insight |

## Scraper Architecture

The scraper uses a **tiered extraction** strategy that falls back through progressively more expensive methods:

1. **ATS API** (ats_api.py) — Direct JSON APIs for Greenhouse, Lever, Ashby. Fastest and most reliable.
2. **LinkedIn Guest API** (linkedin.py) — No-auth API for LinkedIn SERP links and job details.
3. **Career Page** (career_page.py) — Generic scraper with tiered extraction:
   - **Tier 1: JSON-LD** — Structured `<script type="application/ld+json">` data
   - **Tier 1b: Phenom People** — Embedded JSON extraction (`phApp.eagerLoadRefineSearch`) for HelloFresh, etc.
   - **Tier 2: LLM** — Gemini multi-model fallback extracts job data from raw HTML (llm_extract.py)
   - **Tier 3: CSS Selectors** — Learned selectors from selector_cache table (selectors.py)
   - **Fallback: ATS Probe** — Detects and probes Greenhouse/Lever/Ashby APIs, Workday portals

**Dedup** (dedup.py): Normalizes URLs (strips query params, fragments) before checking DB for duplicates.

**File output** (file_writer.py): Writes each job as a markdown file with YAML frontmatter to an Obsidian vault directory.

## AI Integration

**AIClient** (ai/client.py)
- **Gemini** (primary for resume analysis) — `gemini-2.5-flash` via REST
- **Claude** (primary for interview prep) — `claude-sonnet-4-20250514` via REST
- Cross-fallback if primary fails. 120s timeout. Direct httpx calls (no SDK).

**LLMExtractor** (scraper/llm_extract.py)
- Multi-model fallback chain for resilience against free-tier rate limits
- Gemini rotation: `2.0-flash → 2.0-flash-lite → 1.5-flash → 1.5-flash-8b`
- Claude (`claude-sonnet-4-20250514`) as last resort if all Gemini models are 429'd
- Per-model cooldown tracking (60s) — skips recently rate-limited models
- Extracts job data from HTML and identifies job links from listing pages
- Truncates to 16K chars (70% head + 25% tail)

**Prompts** (ai/prompts.py)
- `APPLYING_PROMPT` — Profile assessment + resume edits + job blurbs
- `BULLET_ANALYSIS_PROMPT` — Per-bullet ratings (STRONG/MODERATE/WEAK) with rewrites
- `INTERVIEWING_PROMPT` — SAIL framework analysis
- `STARI_PROMPT` — Situation-Task-Action-Result-Impact analysis
- `STARFAQS_PROMPT` — High-bar interview prep with FAQ + synthesis

## Resume Processing

**Parser** (resume/parser.py): Reads .docx, detects sections by bold headings/styles, extracts company/role/dates via regex, converts to sectional HTML preserving formatting.

**Exporter** (resume/exporter.py): Reconstructs .docx from HTML sections. Supports margin presets (narrow 0.4", normal 0.5", wide 0.75"). Preserves bold, italic, underline, color, alignment, bullet styles, tab-stop dates.

**Story Parser** (resume/story_parser.py): Parses SAIL/STARI-format text into structured story objects with title, hook, content, tags.

## Frontend

Single-page app served by Flask (`templates/index.html` + `static/js/app.js`).

**Two main tabs:**
1. **Discovery** — Scraper control (run/status/logs), source management, keyword filters, stats dashboard
2. **Board** — Job pipeline board, application builder with resume editor, interview prep with story management

**Key UI patterns:**
- Real-time scraper log streaming via long-poll
- Expandable job detail overlays
- Inline resume section editing
- AI analysis display (phase 1 + phase 2)
- Story builder wizard
- Pipeline stage transitions

## Config (config.py)

| Key | Purpose | Default |
|-----|---------|---------|
| `DATABASE_PATH` | SQLite file location | `database/jobdiscovery.db` |
| `OUTPUT_DIR` | Obsidian vault for markdown output | CUNY notes folder |
| `UPLOAD_DIR` | Resume upload directory | `uploads/` |
| `GEMINI_API_KEY` | Google Gemini key | set |
| `CLAUDE_API_KEY` | Anthropic Claude key | empty |
| `LLM_MODEL` | Scraping LLM (primary) | `gemini-2.0-flash` |
| `LLM_FALLBACK_MODELS` | Gemini model rotation chain | `[2.0-flash, 2.0-flash-lite, 1.5-flash, 1.5-flash-8b]` |
| `LLM_RATE_LIMIT_COOLDOWN_SECONDS` | Skip 429'd models for this long | `60` |
| `GEMINI_MODEL` | Analysis LLM | `gemini-2.5-flash` |
| `REQUEST_TIMEOUT_SECONDS` | HTTP timeout | 10 |
| `SCRAPE_RUN_TIMEOUT_SECONDS` | Full run timeout | 300 |
| `MAX_JOBS_PER_SOURCE` | Max jobs scraped per source | 25 |
| `SELECTOR_FAILURE_THRESHOLD` | Failures before self-heal | 5 |

## Code Conventions

- **Routes**: Flask blueprints, JSON responses with `jsonify`
- **DB access**: All queries go through `JobDiscoveryDB` methods in `database/db.py`
- **Error handling**: Try-catch in routes, 500 responses with error messages
- **AI calls**: Direct REST via httpx, no SDK wrappers
- **Frontend**: Vanilla JS SPA, no framework, DOM manipulation via `document.getElementById`
- **Naming**: snake_case everywhere (Python + JS + DB)
