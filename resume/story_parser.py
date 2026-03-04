"""
Parse SAIL-format text into individual story records.

Expected format:
    # Story Title
    ### Hook
    One or two sentence summary...

    ### Context
    Background details...

    ### Action
    What you did...

    ### Results
    Outcomes and metrics...

    ### Takeaways
    Lessons learned...

Section headers are flexible: Context/Situation, Results/Impact,
Takeaways/Learning are all recognized.
"""

import re


# Map alternate section names to canonical names
_SECTION_ALIASES = {
    'hook': 'Hook',
    'context': 'Context',
    'situation': 'Context',
    'action': 'Action',
    'results': 'Results',
    'result': 'Results',
    'impact': 'Results',
    'takeaways': 'Takeaways',
    'takeaway': 'Takeaways',
    'learning': 'Takeaways',
    'learnings': 'Takeaways',
    # STAR format
    'task': 'Task',
}

# Regex to match story title (# Title) — must be a single #
_TITLE_RE = re.compile(r'^#\s+(.+)$', re.MULTILINE)

# Regex to match subsection headers (### Hook, ### Context, etc.)
_SUBSECTION_RE = re.compile(r'^###\s+(.+)$', re.MULTILINE)


def parse_stories(text):
    """Parse SAIL-format text into a list of story dicts.

    Returns:
        list of dicts with keys: title, hook, content, tags
    """
    if not text or not text.strip():
        return []

    stories = []

    # Split on story titles (# Title)
    title_matches = list(_TITLE_RE.finditer(text))

    if not title_matches:
        # No # headers found — treat entire text as a single story
        stories.append(_parse_single_story('Untitled Story', text.strip()))
        return stories

    for i, match in enumerate(title_matches):
        title = match.group(1).strip()
        start = match.end()
        end = title_matches[i + 1].start() if i + 1 < len(title_matches) else len(text)
        body = text[start:end].strip()
        stories.append(_parse_single_story(title, body))

    return stories


def _parse_single_story(title, body):
    """Parse a single story body into structured sections."""
    sections = {}
    subsection_matches = list(_SUBSECTION_RE.finditer(body))

    if subsection_matches:
        # Extract preamble (text before first subsection)
        preamble = body[:subsection_matches[0].start()].strip()

        for i, match in enumerate(subsection_matches):
            header = match.group(1).strip().rstrip(':')
            canonical = _SECTION_ALIASES.get(header.lower(), header)
            start = match.end()
            end = subsection_matches[i + 1].start() if i + 1 < len(subsection_matches) else len(body)
            sections[canonical] = body[start:end].strip()
    else:
        preamble = body

    # Extract hook
    hook = sections.get('Hook', '')
    if not hook and preamble:
        # Use preamble as hook if no explicit hook section
        hook = preamble.split('\n')[0].strip()

    # Build full content preserving SAIL structure
    content_parts = []
    if preamble and 'Hook' not in sections:
        content_parts.append(preamble)

    for key in ('Hook', 'Context', 'Task', 'Action', 'Results', 'Takeaways'):
        if key in sections:
            content_parts.append(f"### {key}\n{sections[key]}")

    # Include any non-standard sections too
    for key, val in sections.items():
        if key not in ('Hook', 'Context', 'Task', 'Action', 'Results', 'Takeaways'):
            content_parts.append(f"### {key}\n{val}")

    content = '\n\n'.join(content_parts)

    return {
        'title': title,
        'hook': hook,
        'content': content,
        'tags': '',
    }
