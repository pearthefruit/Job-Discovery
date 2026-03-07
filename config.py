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
# Note: pro models and gemini-2.0-flash have limit:0 on free tier (disabled by Google).
GEMINI_INTERVIEW_MODELS = [
    "gemini-2.5-flash",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-2.5-flash-lite",
]

# Default model for single-call use
GEMINI_MODEL = "gemini-2.5-flash"

# LLM extraction (Tier 2: after JSON-LD, before CSS selectors)
LLM_EXTRACTION_ENABLED = True
LLM_MODEL = "gemini-2.5-flash"
LLM_MAX_TEXT_CHARS = 16000
LLM_TIMEOUT_SECONDS = 30

# Dedicated scraper API keys — separate from interview prep keys to avoid contention
LLM_API_KEYS = [
    k.strip()
    for k in os.environ.get("LLM_API_KEYS", "").split(",")
    if k.strip()
]

# Gemini model fallback chain for scraper LLM extraction.
# Note: gemini-2.0-flash and 2.0-flash-lite have limit:0 on free tier.
LLM_FALLBACK_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite-preview",
]
LLM_RATE_LIMIT_COOLDOWN_SECONDS = 60

# Scraper settings
REQUEST_TIMEOUT_SECONDS = 10
SCRAPE_RUN_TIMEOUT_SECONDS = 300
WORKDAY_PROBE_TIMEOUT_SECONDS = 4
LINKEDIN_GUEST_API_BASE = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
REQUEST_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}

# Job limits
MAX_JOBS_PER_SOURCE = 25

# Self-healing thresholds
EMPTY_JOB_THRESHOLD = 3
SELECTOR_FAILURE_THRESHOLD = 5

# Claude AI (interview prep + LLM fallback)
CLAUDE_API_KEY = os.environ.get("CLAUDE_API_KEY", "")
CLAUDE_MODEL = "claude-sonnet-4-20250514"

# Mistral — free-tier direct API (1 req/s, 500K TPM, 1B tokens/month)
MISTRAL_API_KEY = os.environ.get("MISTRAL_API_KEY", "")
MISTRAL_MODELS = [
    "mistral-large-latest",
    "mistral-medium-latest",
    "mistral-small-latest",
]

# Cerebras — free-tier fast inference (OpenAI-compatible API)
CEREBRAS_API_KEY = os.environ.get("CEREBRAS_API_KEY", "")
CEREBRAS_MODELS = [
    "gpt-oss-120b",
    "llama3.1-8b",
]

# Groq — ultra-fast inference, OpenAI-compatible API
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODELS = [
    "llama-3.3-70b-versatile",
    "openai/gpt-oss-120b",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "qwen/qwen3-32b",
    "openai/gpt-oss-20b",
    "moonshotai/kimi-k2-instruct-0905",
]

# OpenRouter — free-tier fallback after Gemini + Mistral + Cerebras (OpenAI-compatible API)
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_MODELS = [
    # Large / high-quality (availability rotates)
    "nousresearch/hermes-3-llama-3.1-405b:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen3-next-80b-a3b-instruct:free",
    "mistralai/mistral-small-3.1-24b-instruct:free",
    "arcee-ai/trinity-large-preview:free",
    # Reliable fallbacks (own infra, not shared upstream)
    "stepfun/step-3.5-flash:free",
    "z-ai/glm-4.5-air:free",
    "nvidia/nemotron-3-nano-30b-a3b:free",
    "nvidia/nemotron-nano-9b-v2:free",
    "arcee-ai/trinity-mini:free",
    "google/gemma-3-27b-it:free",
]

# JD Reformat — dedicated key (lightweight, single call)
JD_REFORMAT_API_KEY = os.environ.get("JD_REFORMAT_API_KEY", "")
JD_REFORMAT_MODEL = "gemini-2.5-flash"

# Resume / Application
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
