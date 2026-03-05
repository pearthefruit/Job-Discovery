"""
Parse a .docx resume into structured sections.

Detects section boundaries via bold-only heading paragraphs and style patterns.
Extracts company/role/dates from experience entries.
Converts paragraphs to HTML preserving bold, italic, underline, and alignment.
"""

import re
import docx
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.text.run import Run


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
                # Keep heading as <p> to preserve original formatting (color, size)
                heading_html = self._para_to_html(p)
                current_section = {
                    'type': heading_type,
                    'heading_text': text,
                    'content_html': heading_html,
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

    def _run_to_html(self, run):
        """Convert a single run to HTML with formatting."""
        return self._run_to_html_text(run, run.text)

    def _run_to_html_text(self, run, text):
        """Convert text with a run's formatting to HTML."""
        text = self._escape_html(text)
        if not text:
            return ''

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

        return text

    def _para_to_html(self, para):
        """Convert a paragraph to HTML preserving formatting and hyperlinks."""
        if not para.text.strip():
            return ''

        # Determine tag based on style and context
        is_bullet = (para.style and para.style.name == 'List Paragraph')

        # Check alignment
        styles = []
        if para.alignment == WD_ALIGN_PARAGRAPH.RIGHT:
            styles.append('text-align:right')
        elif para.alignment == WD_ALIGN_PARAGRAPH.CENTER:
            styles.append('text-align:center')

        # Detect font size (max across runs)
        max_font_size = None
        for child in para._element:
            if child.tag == qn('w:r'):
                run = Run(child, para)
                if run.font.size:
                    sz = run.font.size.pt
                    if max_font_size is None or sz > max_font_size:
                        max_font_size = sz

        data_attrs = []
        if max_font_size and max_font_size > 10:
            data_attrs.append(f'data-font-size="{max_font_size:.0f}"')

        # Detect paragraph borders (top/bottom)
        pPr = para._element.find(qn('w:pPr'))
        if pPr is not None:
            pBdr = pPr.find(qn('w:pBdr'))
            if pBdr is not None:
                for side in ('bottom', 'top'):
                    border_el = pBdr.find(qn(f'w:{side}'))
                    if border_el is not None:
                        val = border_el.get(qn('w:val'), 'single')
                        bsz = border_el.get(qn('w:sz'), '4')
                        bcolor = border_el.get(qn('w:color'), 'auto')
                        data_attrs.append(f'data-border-{side}="{val},{bsz},{bcolor}"')

        # Build tag attributes
        tag_attrs = ''
        if styles:
            tag_attrs += f' style="{"; ".join(styles)}"'
        for da in data_attrs:
            tag_attrs += f' {da}'

        # Build a list of (html_fragment, is_tab) tuples so we can detect
        # tab-separated dates BEFORE joining, avoiding cutting through tags.
        fragments = []
        for child in para._element:
            if child.tag == qn('w:hyperlink'):
                r_id = child.get(qn('r:id'))
                url = ''
                if r_id:
                    try:
                        url = para.part.rels[r_id].target_ref
                    except (KeyError, AttributeError):
                        pass
                link_parts = []
                for run_el in child.findall(qn('w:r')):
                    run = Run(run_el, para)
                    link_parts.append(self._run_to_html(run))
                link_text = ''.join(link_parts)
                if url and link_text:
                    fragments.append((f'<a href="{self._escape_html(url)}" target="_blank">{link_text}</a>', False))
                elif link_text:
                    fragments.append((link_text, False))
            elif child.tag == qn('w:r'):
                run = Run(child, para)
                text = run.text or ''
                if '\t' in text:
                    # Split on tab — parts before tab are regular, tab itself is a marker
                    parts = text.split('\t')
                    for j, part in enumerate(parts):
                        if j > 0:
                            fragments.append(('', True))  # tab marker
                        if part:
                            # Build HTML for this text chunk with the run's formatting
                            fragments.append((self._run_to_html_text(run, part), False))
                else:
                    html = self._run_to_html(run)
                    if html:
                        fragments.append((html, False))

        # Find the last tab marker — everything after it may be a date
        last_tab_idx = None
        for idx in range(len(fragments) - 1, -1, -1):
            if fragments[idx][1]:  # is_tab
                last_tab_idx = idx
                break

        if last_tab_idx is not None:
            # Extract plain text after the last tab to check for dates
            after_tab_text = re.sub(r'<[^>]+>', '', ''.join(f for f, _ in fragments[last_tab_idx + 1:])).strip()
            if DATE_PATTERN.search(after_tab_text):
                # Build content with float:right for the date portion
                before = ''.join(f for f, _ in fragments[:last_tab_idx])
                after = ''.join(f for f, _ in fragments[last_tab_idx + 1:])
                content = f'{before}<span style="float:right">{after}</span>'
            else:
                content = ''.join(f if not is_tab else '&emsp;' for f, is_tab in fragments)
        else:
            content = ''.join(f if not is_tab else '&emsp;' for f, is_tab in fragments)

        if is_bullet:
            return f'<li{tag_attrs}>{content}</li>\n'
        else:
            return f'<p{tag_attrs}>{content}</p>\n'

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
