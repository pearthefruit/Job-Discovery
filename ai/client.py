"""
AI client for resume analysis and interview prep.

Uses Gemini with key × model rotation for free-tier rate-limit resilience.
Claude support retained as optional fallback. Direct REST calls via httpx.
"""

import logging
import time
import httpx

log = logging.getLogger(__name__)

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
CLAUDE_URL = "https://api.anthropic.com/v1/messages"

TIMEOUT = 120  # seconds - analysis prompts generate long responses


class AIClient:
    def __init__(self, gemini_keys=None, gemini_models=None,
                 gemini_api_key="", gemini_model="gemini-2.5-flash",
                 claude_api_key="", claude_model="claude-sonnet-4-20250514"):
        # Support both new list-based and old single-key init
        self.gemini_keys = gemini_keys or ([gemini_api_key] if gemini_api_key else [])
        self.gemini_models = gemini_models or ([gemini_model] if gemini_model else ["gemini-2.5-flash"])
        self.claude_api_key = claude_api_key
        self.claude_model = claude_model
        self.http = httpx.Client(timeout=TIMEOUT)
        # Track which model actually answered (for logging/UI)
        self.last_model_used = None
        self.last_provider = None
        self.last_key_hint = None
        self.last_usage = {}

    def _call_gemini(self, key, model, prompt, temperature=0.3, max_tokens=65536):
        """Single Gemini API call. Returns text or raises."""
        url = GEMINI_URL.format(model=model)
        response = self.http.post(
            url,
            params={"key": key},
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "temperature": temperature,
                    "maxOutputTokens": max_tokens,
                },
            },
        )

        if response.status_code == 429:
            raise RateLimitError(f"{model} rate limited (key ...{key[-4:]})")

        if response.status_code != 200:
            raise RuntimeError(f"{model} HTTP {response.status_code}: {response.text[:300]}")

        data = response.json()
        candidates = data.get("candidates", [])
        if not candidates:
            raise RuntimeError(f"{model} returned no candidates")

        finish_reason = candidates[0].get("finishReason", "")
        text = candidates[0].get("content", {}).get("parts", [{}])[0].get("text", "")

        if finish_reason == "MAX_TOKENS":
            log.warning(f"{model} output truncated (hit maxOutputTokens={max_tokens})")
            text += f"\n\n---\n*Output was truncated — {model} hit its token limit. Try again to get a higher-capacity model.*"

        self.last_model_used = model
        self.last_provider = 'gemini'
        self.last_key_hint = f"...{key[-4:]}"
        usage_meta = data.get("usageMetadata", {})
        self.last_usage = {
            'provider': 'gemini',
            'prompt_tokens': usage_meta.get('promptTokenCount', 0),
            'completion_tokens': usage_meta.get('candidatesTokenCount', 0),
            'total_tokens': usage_meta.get('totalTokenCount', 0),
        }
        return text

    def analyze_gemini(self, prompt, temperature=0.3, max_tokens=65536, retries=2):
        """Call Gemini with retry on rate limit (single key+model, backward compat)."""
        if not self.gemini_keys:
            raise ValueError("No Gemini API keys configured")

        key = self.gemini_keys[0]
        model = self.gemini_models[0]
        last_error = None

        for attempt in range(retries + 1):
            try:
                return self._call_gemini(key, model, prompt, temperature, max_tokens)
            except RateLimitError as e:
                last_error = e
                if attempt < retries:
                    time.sleep(5 * (attempt + 1))
                    continue
            except Exception as e:
                raise

        raise last_error

    def analyze_with_rotation(self, prompt, temperature=0.3, max_tokens=65536):
        """Try all key × model combinations. Best model first, rotate keys on rate limit.

        Order: for each model (quality-first), try every key.
        On rate limit → next key. All keys exhausted → next model.
        On other error → skip that model entirely.
        """
        if not self.gemini_keys:
            raise ValueError("No Gemini API keys configured")

        errors = []

        for model in self.gemini_models:
            for key in self.gemini_keys:
                try:
                    log.info(f"Trying {model} with key ...{key[-4:]}")
                    return self._call_gemini(key, model, prompt, temperature, max_tokens)
                except RateLimitError:
                    errors.append(f"{model}/...{key[-4:]}: rate limited")
                    continue
                except Exception as e:
                    errors.append(f"{model}: {e}")
                    break  # non-rate-limit error → model is broken, skip to next

        # Last resort: try Claude if configured
        if self.claude_api_key:
            try:
                log.info("All Gemini combos exhausted, trying Claude")
                return self.analyze_claude(prompt, temperature, max_tokens)
            except Exception as e:
                errors.append(f"Claude fallback: {e}")

        raise RuntimeError(f"All models exhausted. Tried: {'; '.join(errors)}")

    def analyze_claude(self, prompt, temperature=0.3, max_tokens=65536):
        """Call Claude API. Returns text response or raises."""
        if not self.claude_api_key:
            raise ValueError("Claude API key not configured")

        response = self.http.post(
            CLAUDE_URL,
            headers={
                "x-api-key": self.claude_api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": self.claude_model,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "messages": [{"role": "user", "content": prompt}],
            },
        )

        if response.status_code == 429:
            raise RateLimitError("Claude rate limited")
        if response.status_code != 200:
            raise RuntimeError(f"Claude HTTP {response.status_code}: {response.text[:300]}")

        data = response.json()
        content = data.get("content", [])
        if not content:
            raise RuntimeError("Claude returned no content")

        self.last_model_used = self.claude_model
        self.last_provider = 'claude'
        self.last_key_hint = f"...{self.claude_api_key[-4:]}" if self.claude_api_key else None
        usage_data = data.get("usage", {})
        self.last_usage = {
            'provider': 'claude',
            'prompt_tokens': usage_data.get('input_tokens', 0),
            'completion_tokens': usage_data.get('output_tokens', 0),
            'total_tokens': usage_data.get('input_tokens', 0) + usage_data.get('output_tokens', 0),
        }
        return content[0].get("text", "")

    # Convenience aliases (backward compat)
    def analyze_resume(self, prompt):
        return self.analyze_with_rotation(prompt)

    def analyze_interview(self, prompt):
        return self.analyze_with_rotation(prompt)


class RateLimitError(RuntimeError):
    """Raised on HTTP 429 — signals rotation to try next key/model."""
    pass
