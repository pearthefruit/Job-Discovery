import os
from dotenv import load_dotenv

load_dotenv()

# Paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE_PATH = os.path.join(BASE_DIR, "database", "jobdiscovery.db")
OUTPUT_DIR = os.environ.get(
    "OUTPUT_DIR",
    r"C:\Users\peary\OneDrive - The City University of New York\Personal\Personal Pear\NOTES\Careers\2026",
)

# Gemini AI — multiple free-tier keys for rate-limit rotation
GEMINI_API_KEYS = [
    k.strip()
    for k in os.environ.get("GEMINI_API_KEYS", "").split(",")
    if k.strip()
]
GEMINI_API_KEY = GEMINI_API_KEYS[0] if GEMINI_API_KEYS else ""

# Interview prep models — tried in order; rotate on rate limit.
GEMINI_INTERVIEW_MODELS = [
    "gemini-2.5-pro",
    "gemini-3.1-pro-preview",
    "gemini-2.5-flash",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
]

# Default model for single-call use
GEMINI_MODEL = "gemini-2.5-flash"

# LLM extraction (Tier 2: after JSON-LD, before CSS selectors)
LLM_EXTRACTION_ENABLED = True
LLM_MODEL = "gemini-2.0-flash"
LLM_MAX_TEXT_CHARS = 16000
LLM_TIMEOUT_SECONDS = 30

# Dedicated scraper API keys — separate from interview prep keys to avoid contention
LLM_API_KEYS = [
    k.strip()
    for k in os.environ.get("LLM_API_KEYS", "").split(",")
    if k.strip()
]

# Gemini model fallback chain for scraper LLM extraction.
LLM_FALLBACK_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
]
LLM_RATE_LIMIT_COOLDOWN_SECONDS = 60

# Scraper settings
REQUEST_TIMEOUT_SECONDS = 10
SCRAPE_RUN_TIMEOUT_SECONDS = 300
WORKDAY_PROBE_TIMEOUT_SECONDS = 4
LINKEDIN_GUEST_API_BASE = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

# Job limits
MAX_JOBS_PER_SOURCE = 25

# Self-healing thresholds
EMPTY_JOB_THRESHOLD = 3
SELECTOR_FAILURE_THRESHOLD = 5

# Claude AI (interview prep + LLM fallback)
CLAUDE_API_KEY = os.environ.get("CLAUDE_API_KEY", "")
CLAUDE_MODEL = "claude-sonnet-4-20250514"

# JD Reformat — dedicated key (lightweight, single call)
JD_REFORMAT_API_KEY = os.environ.get("JD_REFORMAT_API_KEY", "")
JD_REFORMAT_MODEL = "gemini-2.0-flash"

# Resume / Application
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
