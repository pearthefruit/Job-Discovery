class DeduplicationManager:
    """Prevents saving duplicate jobs by checking normalized URLs against the DB."""

    def __init__(self, db):
        self.db = db

    @staticmethod
    def normalize_url(url):
        """Normalize URL by removing query parameters, fragments, and trailing slashes."""
        base_url = url.split('?')[0].split('#')[0]
        return base_url.rstrip('/')

    def is_duplicate(self, url):
        normalized = self.normalize_url(url)
        existing = self.db.get_job_by_normalized_url(normalized)
        return existing is not None
