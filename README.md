# JobDiscovery

A full-lifecycle job management engine — from discovery to offer. Scrape career pages and job boards, tailor resumes per application, prep for interviews with an AI-powered story bank, and track every stage of the pipeline.

Built with Flask + vanilla JS as a local-first single-page app backed by SQLite.

## Features

### Job Discovery
- **Multi-source scraping** — career pages, LinkedIn (guest API), and ATS platforms (Greenhouse, Lever, Ashby)
- **Self-healing selectors** — automatically detects and repairs broken CSS selectors using heuristics and AI
- **Keyword filters** — include/exclude rules to auto-filter irrelevant postings
- **Obsidian integration** — every scraped job writes a markdown file with YAML frontmatter to your vault
- **Batch import** — paste up to 20 job URLs for bulk scraping

### Application Prep
- **Resume parser** — upload a `.docx`, auto-parsed into editable sections (header, summary, experience, education, etc.)
- **Inline editor** — edit resume sections in the browser with rich text formatting
- **Two-phase AI analysis** — profile assessment + per-bullet STRONG/MODERATE/WEAK ratings with rewrite suggestions
- **Export** — download as `.docx` (ATS-friendly) or print to PDF (recruiter-ready), with configurable margins

### Interview Prep
- **Story bank** — create and manage interview stories in SAIL format with tags and competency labels
- **Stage tracking** — define interview stages (recruiter screen, technical, onsite, etc.) with notes, questions, and debrief
- **AI story ranking** — rank and evaluate your stories against a specific job posting, with auto-assign for suggested additions
- **Story reframing** — AI-tailored rewrites of stories for specific roles
- **Mock interviews** — practice sessions with whiteboard and notes per stage
- **Prep guides** — AI-generated preparation using SAIL, STARI, or STARFAQS frameworks

### Pipeline Management
- **Kanban-style board** — jobs flow through discovery → application → interview → outcome
- **Activity log** — timestamped entries for every status change and action
- **Outcome tracking** — record offers and rejections with per-stage breakdowns

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Flask 3, SQLite |
| Frontend | Vanilla JS (SPA), HTML/CSS |
| Scraping | httpx, BeautifulSoup, ATS JSON APIs |
| AI | Google Gemini (primary), Anthropic Claude (fallback) |
| Resume I/O | python-docx |

## Setup

### Prerequisites
- Python 3.10+
- Google Gemini API key(s)

### Install

```bash
git clone https://github.com/pearthefruit/Job-Discovery.git
cd Job-Discovery
pip install -r requirements.txt
```

### Configure

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

```env
# Gemini AI — interview prep keys (comma-separated for rotation)
GEMINI_API_KEYS=your-key-1,your-key-2

# Dedicated scraper LLM API keys (comma-separated)
LLM_API_KEYS=your-key-1,your-key-2

# JD Reformat — dedicated key
JD_REFORMAT_API_KEY=your-key

# Claude AI (optional fallback)
CLAUDE_API_KEY=

# Obsidian vault output directory
OUTPUT_DIR=C:\path\to\your\obsidian\vault\jobs
```

Three separate key pools are used to avoid rate-limit contention between interview prep, scraping, and JD reformatting. Multiple keys per pool enables rotation when hitting free-tier limits.

### Run

```bash
python app.py
```

Open [http://localhost:5000](http://localhost:5000).

## Project Structure

```
JobDiscovery/
├── app.py                  # Flask entry point
├── config.py               # Settings, API keys, timeouts
├── ai/
│   └── client.py           # AIClient — Gemini + Claude with key rotation
├── database/
│   ├── db.py               # SQLite queries + migrations
│   └── schema.sql          # Table definitions
├── resume/
│   ├── parser.py           # .docx → sectional HTML
│   ├── exporter.py         # Sections → .docx with formatting
│   └── story_parser.py     # SAIL/STARI text → story objects
├── routes/
│   ├── discovery.py        # Scraping, sources, filters, pipeline
│   ├── application.py      # Resumes, applications, AI analysis, export
│   └── interview.py        # Stories, stages, ranking, mocks
├── scraper/
│   ├── engine.py           # Scrape orchestrator
│   ├── ats_api.py          # Greenhouse, Lever, Ashby scrapers
│   ├── career_page.py      # Generic career page scraper
│   ├── linkedin.py         # LinkedIn guest API scraper
│   ├── llm_extract.py      # Gemini LLM extraction fallback
│   ├── self_healing.py     # Automatic selector repair
│   └── dedup.py            # URL normalization + deduplication
├── static/
│   ├── css/style.css
│   ├── js/app.js           # SPA frontend logic
│   └── js/editor.js        # Resume section editor
├── templates/
│   └── index.html          # App shell
└── uploads/                # Uploaded .docx files
```

## How the Scraper Works

The scraper uses a tiered extraction strategy per source:

1. **ATS JSON APIs** — directly queries Greenhouse, Lever, and Ashby APIs for structured job data
2. **LinkedIn Guest API** — fetches public job listings without authentication
3. **Career Page Extraction** — tries in order:
   - JSON-LD structured data
   - Platform-specific embedded JSON (e.g., Phenom People)
   - Gemini LLM extraction (sends page text, gets structured output)
   - CSS selector matching (with self-healing)
   - ATS platform probe (Workday, iCIMS URL patterns)

Failed selectors are tracked in a `selector_cache` table. After repeated failures, the self-healing manager attempts heuristic repair or AI-powered selector generation.

## AI Integration

`AIClient` rotates through all Gemini key × model combinations (quality-ordered) before falling back to Claude. This maximizes availability on free-tier API limits.

Used for:
- Job description reformatting
- Resume analysis (profile assessment + bullet ratings)
- Story ranking and evaluation
- Story reframing for specific roles
- Interview prep guide generation
- Mock interview facilitation
- Career page content extraction (scraper fallback)
