"""
Parse a .docx resume into structured sections.

Detects section boundaries via bold-only heading paragraphs and style patterns.
Extracts company/role/dates from experience entries.
Converts paragraphs to HTML preserving bold, italic, underline, and alignment.
"""

import re
import docx
from docx.enum.text import WD_ALIGN_PARAGRAPH


# Section headings we recognize (case-insensitive partial match)
SECTION_KEYWORDS = {
    'experience': 'experience',
    'work experience': 'experience',
    'professional experience': 'experience',
    'employment': 'experience',
    'education': 'education',
    'skills': 'skills',
    'tools': 'skills',
    'technical skills': 'skills',
    'projects': 'projects',
    'projects and activities': 'projects',
    'certifications': 'certifications',
    'interests': 'interests',
    'summary': 'summary',
    'professional summary': 'summary',
    'profile': 'summary',
    'objective': 'summary',
    'early career': 'experience',
}

# Pattern for dates like "1/2025 – Present", "2018 – 2020", "3/2020 – 2/2022"
DATE_PATTERN = re.compile(
    r'\b(\d{1,2}/)?(\d{4})\s*[–\-—]\s*(\d{1,2}/)?(\d{4}|[Pp]resent)\b'
)


class ResumeParser:
    def parse(self, filepath):
        """Parse a .docx file into a list of section dicts."""
        doc = docx.Document(filepath)
        paragraphs = doc.paragraphs

        if not paragraphs:
            return []

        sections = []
        current_section = None

        # First pass: identify the header (name + contact)
        header_end = self._find_header_end(paragraphs)

        # Build header section from top paragraphs
        header_html = ''
        for i in range(header_end):
            header_html += self._para_to_html(paragraphs[i])

        if header_html.strip():
            sections.append({
                'type': 'header',
                'content_html': header_html,
            })

        # Check if the first content after header is a summary (no heading)
        summary_end = header_end
        if header_end < len(paragraphs):
            # Look for summary text before the first section heading
            for i in range(header_end, len(paragraphs)):
                p = paragraphs[i]
                text = p.text.strip()
                if not text:
                    continue
                heading_type = self._detect_section_heading(p)
                if heading_type:
                    break
                # Check if it looks like a summary (long paragraph, not a bullet)
                if p.style and p.style.name == 'List Paragraph':
                    break
                if self._is_role_line(text):
                    break
                summary_end = i + 1

        if summary_end > header_end:
            summary_html = ''
            for i in range(header_end, summary_end):
                html = self._para_to_html(paragraphs[i])
                if html.strip():
                    summary_html += html
            if summary_html.strip():
                sections.append({
                    'type': 'summary',
                    'content_html': summary_html,
                })

        # Second pass: parse remaining paragraphs into sections
        i = summary_end
        while i < len(paragraphs):
            p = paragraphs[i]
            text = p.text.strip()

            if not text:
                i += 1
                continue

            heading_type = self._detect_section_heading(p)
            if heading_type:
                # Start a new section
                current_section = {
                    'type': heading_type,
                    'content_html': '',
                }
                sections.append(current_section)

                # For experience/projects, parse role entries
                if heading_type in ('experience', 'projects'):
                    i += 1
                    i = self._parse_experience_section(
                        paragraphs, i, sections, current_section
                    )
                    continue
                else:
                    i += 1
                    continue

            # Content belonging to current section
            if current_section is not None:
                current_section['content_html'] += self._para_to_html(p)
            i += 1

        # Post-process: remove empty heading sections, wrap <li> in <ul>
        result = []
        for s in sections:
            html = s.get('content_html', '').strip()
            if not html:
                continue
            s['content_html'] = self._wrap_list_items(html)
            result.append(s)
        return result

    def _find_header_end(self, paragraphs):
        """Find where the header (name + contact info) ends.

        Usually the first 1-3 non-empty paragraphs before a section heading
        or summary paragraph.
        """
        count = 0
        for i, p in enumerate(paragraphs):
            text = p.text.strip()
            if not text:
                if count > 0:
                    return i
                continue
            count += 1
            # Header is typically just 1-2 lines (name, contact)
            if count >= 2:
                return i + 1
            # If we hit a section heading early, stop
            if self._detect_section_heading(p):
                return i
        return min(2, len(paragraphs))

    def _detect_section_heading(self, para):
        """Check if a paragraph is a section heading.

        A section heading is typically:
        - A short line that is entirely bold
        - Matches a known section keyword
        """
        text = para.text.strip()
        if not text:
            return None

        text_lower = text.lower()

        # Direct match against known section headings
        if text_lower in SECTION_KEYWORDS:
            return SECTION_KEYWORDS[text_lower]

        # Check for heading styles
        if para.style and 'heading' in para.style.name.lower():
            for keyword, section_type in SECTION_KEYWORDS.items():
                if keyword in text_lower:
                    return section_type

        # Check if the entire paragraph text is bold and matches a keyword
        if self._is_all_bold(para) and len(text) < 40:
            for keyword, section_type in SECTION_KEYWORDS.items():
                if keyword in text_lower:
                    return section_type

        return None

    def _is_all_bold(self, para):
        """Check if all non-whitespace runs in a paragraph are bold."""
        runs = para.runs
        if not runs:
            return False
        for run in runs:
            if run.text.strip() and not run.bold:
                return False
        return True

    def _is_role_line(self, text):
        """Check if a line looks like a role/company entry (has dates)."""
        return bool(DATE_PATTERN.search(text))

    def _parse_experience_section(self, paragraphs, start_idx, sections, parent_section):
        """Parse experience entries: role lines followed by bullet points.

        Each role line becomes its own section with type 'experience'.
        The parent_section is the heading-only section.
        """
        i = start_idx
        current_role = None

        while i < len(paragraphs):
            p = paragraphs[i]
            text = p.text.strip()

            if not text:
                i += 1
                continue

            # Check if we've hit a new section heading
            heading_type = self._detect_section_heading(p)
            if heading_type:
                return i  # Don't consume this paragraph

            # Check if this is a role/company line
            if self._is_role_line(text) or (
                self._is_all_bold(p) and p.style
                and p.style.name != 'List Paragraph'
            ):
                company, role, dates = self._parse_role_line(text)
                current_role = {
                    'type': 'experience',
                    'content_html': self._para_to_html(p),
                    'company_name': company,
                    'role_title': role,
                    'dates': dates,
                }
                sections.append(current_role)
                i += 1
                continue

            # Bullet point or content under current role
            if current_role is not None:
                current_role['content_html'] += self._para_to_html(p)
            else:
                # Content before first role line - add to parent
                parent_section['content_html'] += self._para_to_html(p)
            i += 1

        return i

    def _parse_role_line(self, text):
        """Extract company, role, and dates from a role line.

        Common formats:
        - "Company, NY | Role Title\t1/2025 – Present"
        - "Company | Role – Specialization\t7/2024 – 1/2025"
        - "Early Career\t2015 – 2020"
        """
        # Extract dates
        dates = ''
        date_match = DATE_PATTERN.search(text)
        if date_match:
            dates = date_match.group(0).strip()

        # Remove dates and tab from the text for company/role parsing
        clean = text
        if dates:
            clean = text[:text.find(dates)].strip().rstrip('\t').strip()

        # Split on pipe character for Company | Role
        parts = [p.strip() for p in clean.split('|')]

        if len(parts) >= 2:
            company = parts[0].rstrip(',').strip()
            # Remove location suffix from company (e.g. "Company, NY")
            company_clean = re.sub(r',\s*[A-Z]{2}\s*$', '', company).strip()
            role = ' | '.join(parts[1:])
            # Clean up role: remove leading/trailing dashes
            role = re.sub(r'^[\s–\-]+|[\s–\-]+$', '', role).strip()
            return company_clean, role, dates
        else:
            # No pipe - treat whole thing as a title
            return '', clean, dates

    def _para_to_html(self, para):
        """Convert a paragraph to HTML preserving formatting."""
        if not para.text.strip():
            return ''

        # Determine tag based on style and context
        is_bullet = (para.style and para.style.name == 'List Paragraph')

        # Check alignment
        align_style = ''
        if para.alignment == WD_ALIGN_PARAGRAPH.RIGHT:
            align_style = ' style="text-align:right"'
        elif para.alignment == WD_ALIGN_PARAGRAPH.CENTER:
            align_style = ' style="text-align:center"'

        # Build inline HTML from runs
        html_parts = []
        for run in para.runs:
            text = self._escape_html(run.text)
            if not text:
                continue

            # Replace tab with spacing
            text = text.replace('\t', '&emsp;')

            if run.bold and run.italic:
                text = f'<strong><em>{text}</em></strong>'
            elif run.bold:
                text = f'<strong>{text}</strong>'
            elif run.italic:
                text = f'<em>{text}</em>'
            if run.underline:
                text = f'<u>{text}</u>'

            # Preserve text color
            try:
                if run.font.color and run.font.color.rgb:
                    color_hex = str(run.font.color.rgb)
                    text = f'<span style="color:#{color_hex}">{text}</span>'
            except (AttributeError, TypeError):
                pass

            html_parts.append(text)

        content = ''.join(html_parts)

        # Float dates to the right when separated by tab (emsp)
        if '&emsp;' in content:
            parts = content.split('&emsp;')
            last_part = parts[-1]
            last_text = re.sub(r'<[^>]+>', '', last_part).strip()
            if DATE_PATTERN.search(last_text):
                rest = '&emsp;'.join(parts[:-1])
                content = f'{rest}<span style="float:right">{last_part}</span>'

        if is_bullet:
            return f'<li{align_style}>{content}</li>\n'
        else:
            return f'<p{align_style}>{content}</p>\n'

    def _wrap_list_items(self, html):
        """Wrap consecutive <li> elements in <ul> tags."""
        lines = html.split('\n')
        result = []
        in_list = False
        for line in lines:
            stripped = line.strip()
            if stripped.startswith('<li'):
                if not in_list:
                    result.append('<ul>')
                    in_list = True
                result.append(line)
            else:
                if in_list:
                    result.append('</ul>')
                    in_list = False
                result.append(line)
        if in_list:
            result.append('</ul>')
        return '\n'.join(result)

    def _escape_html(self, text):
        """Escape HTML special characters."""
        return (text
                .replace('&', '&amp;')
                .replace('<', '&lt;')
                .replace('>', '&gt;')
                .replace('"', '&quot;'))
