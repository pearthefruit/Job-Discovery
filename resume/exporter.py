"""
Export resume sections back to .docx format.

Converts section HTML back to python-docx paragraphs preserving
bold, italic, underline, alignment, color, and bullet formatting.
Supports adjustable margins and right-aligned date tab stops.
"""

import re
from html.parser import HTMLParser
from docx import Document
from docx.shared import Pt, Inches, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT


MARGIN_PRESETS = {
    'narrow': (0.4, 0.4, 0.4, 0.4),
    'normal': (0.5, 0.5, 0.5, 0.5),
    'wide': (0.75, 0.75, 0.75, 0.75),
}


class _HTMLToRuns(HTMLParser):
    """Parse HTML into a list of (text, bold, italic, underline, color, float_right) tuples."""

    def __init__(self):
        super().__init__()
        self.runs = []
        self._bold = False
        self._italic = False
        self._underline = False
        self._color = None
        self._float_right = False
        self._tag_stack = []

    def handle_starttag(self, tag, attrs):
        self._tag_stack.append(tag)
        if tag in ('strong', 'b'):
            self._bold = True
        elif tag in ('em', 'i'):
            self._italic = True
        elif tag == 'u':
            self._underline = True
        elif tag == 'span':
            attrs_dict = dict(attrs)
            style = attrs_dict.get('style', '')
            color_match = re.search(r'color:\s*#([0-9a-fA-F]{6})', style)
            if color_match:
                self._color = color_match.group(1)
            if 'float:right' in style or 'float: right' in style:
                self._float_right = True

    def handle_endtag(self, tag):
        if tag in ('strong', 'b'):
            self._bold = False
        elif tag in ('em', 'i'):
            self._italic = False
        elif tag == 'u':
            self._underline = False
        elif tag == 'span':
            self._color = None
            self._float_right = False
        if self._tag_stack and self._tag_stack[-1] == tag:
            self._tag_stack.pop()

    def handle_data(self, data):
        if data:
            self.runs.append((data, self._bold, self._italic, self._underline, self._color, self._float_right))

    def handle_entityref(self, name):
        entities = {'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"',
                    'emsp': '\t', 'nbsp': '\u00a0'}
        char = entities.get(name, f'&{name};')
        self.runs.append((char, self._bold, self._italic, self._underline, self._color, self._float_right))

    def handle_charref(self, name):
        try:
            char = chr(int(name, 16) if name.startswith('x') else int(name))
        except ValueError:
            char = f'&#{name};'
        self.runs.append((char, self._bold, self._italic, self._underline, self._color, self._float_right))


def _parse_inline_html(html):
    """Parse inline HTML to a list of run tuples."""
    parser = _HTMLToRuns()
    parser.feed(html)
    return parser.runs


def _detect_alignment(tag_html):
    """Extract text-align from an element's style attribute."""
    m = re.search(r'text-align:\s*(right|center|left)', tag_html)
    if m:
        val = m.group(1)
        if val == 'right':
            return WD_ALIGN_PARAGRAPH.RIGHT
        elif val == 'center':
            return WD_ALIGN_PARAGRAPH.CENTER
    return None


# Regex to split HTML into block elements
_BLOCK_RE = re.compile(
    r'<(p|li|h[23]|ul|/ul)(\s[^>]*)?>',
    re.IGNORECASE,
)


def _split_blocks(html):
    """Split HTML into a list of (tag, attrs_html, inner_html) blocks."""
    blocks = []
    current_tag = None
    current_attrs = ''
    content_start = 0

    for m in re.finditer(r'<(/?)(\w+)([^>]*)>', html):
        is_close = m.group(1) == '/'
        tag = m.group(2).lower()
        attrs = m.group(3)

        if tag in ('ul',):
            continue  # skip ul wrappers

        if tag in ('p', 'li', 'h2', 'h3'):
            if is_close:
                if current_tag:
                    inner = html[content_start:m.start()]
                    blocks.append((current_tag, current_attrs, inner))
                    current_tag = None
            else:
                current_tag = tag
                current_attrs = attrs
                content_start = m.end()

    return blocks


class ResumeExporter:
    """Export resume sections to a .docx file."""

    def export(self, sections, output_path, margin='normal'):
        """Generate .docx from section dicts with content_html."""
        doc = Document()

        # Set margins based on preset
        margins = MARGIN_PRESETS.get(margin, MARGIN_PRESETS['normal'])
        top, bottom, left, right = margins
        for section in doc.sections:
            section.top_margin = Inches(top)
            section.bottom_margin = Inches(bottom)
            section.left_margin = Inches(left)
            section.right_margin = Inches(right)

        # Calculate content width for right-aligned tab stops
        self._content_width = Inches(8.5 - left - right)

        # Set default font
        style = doc.styles['Normal']
        style.font.name = 'Calibri'
        style.font.size = Pt(10)
        style.paragraph_format.space_after = Pt(1)
        style.paragraph_format.space_before = Pt(0)

        for sec in sections:
            html = sec.get('content_html', sec.get('html', ''))
            if not html.strip():
                continue
            sec_type = sec.get('section_type', sec.get('type', ''))
            self._write_section(doc, html, sec_type)

        doc.save(output_path)

    def _write_section(self, doc, html, section_type):
        """Write a single section's HTML content to the document."""
        blocks = _split_blocks(html)

        for tag, attrs, inner in blocks:
            alignment = _detect_alignment(attrs)
            runs_data = _parse_inline_html(inner)

            if tag in ('h2', 'h3'):
                para = doc.add_paragraph()
                para.paragraph_format.space_before = Pt(6)
                para.paragraph_format.space_after = Pt(2)
                if alignment:
                    para.alignment = alignment
                for text, bold, italic, underline, color, float_right in runs_data:
                    run = para.add_run(text)
                    run.bold = True
                    run.italic = italic
                    run.underline = underline
                    run.font.size = Pt(14) if tag == 'h2' else Pt(12)
                    if color:
                        run.font.color.rgb = RGBColor.from_string(color)

            elif tag == 'li':
                para = doc.add_paragraph(style='List Bullet')
                para.paragraph_format.space_after = Pt(1)
                para.paragraph_format.space_before = Pt(0)
                if alignment:
                    para.alignment = alignment
                self._add_runs(para, runs_data)

            else:  # <p>
                para = doc.add_paragraph()
                if alignment:
                    para.alignment = alignment

                # Detect if this is a role/heading line (all bold, has tab)
                all_bold = all(b for t, b, i, u, c, f in runs_data if t.strip()) if runs_data else False

                if section_type == 'header' and self._is_name_line(runs_data):
                    # Name line: larger font
                    for text, bold, italic, underline, color, float_right in runs_data:
                        run = para.add_run(text)
                        run.bold = bold
                        run.italic = italic
                        run.underline = underline
                        run.font.size = Pt(20)
                        if color:
                            run.font.color.rgb = RGBColor.from_string(color)
                else:
                    self._add_runs(para, runs_data)

    def _add_runs(self, para, runs_data):
        """Add formatted runs to a paragraph, handling color and right-aligned dates."""
        has_float_right = any(f for t, b, i, u, c, f in runs_data)

        if has_float_right:
            # Add a right-aligned tab stop at the content width
            para.paragraph_format.tab_stops.add_tab_stop(
                self._content_width,
                alignment=WD_TAB_ALIGNMENT.RIGHT,
            )

        for text, bold, italic, underline, color, float_right in runs_data:
            if float_right:
                # Insert tab to jump to the right-aligned tab stop
                para.add_run('\t')

            run = para.add_run(text)
            run.bold = bold or None
            run.italic = italic or None
            run.underline = underline or None
            if color:
                run.font.color.rgb = RGBColor.from_string(color)

    def _is_name_line(self, runs_data):
        """Check if runs look like a name line (first paragraph, bold, short)."""
        if not runs_data:
            return False
        text = ''.join(t for t, b, i, u, c, f in runs_data).strip()
        all_bold = all(b for t, b, i, u, c, f in runs_data if t.strip())
        return all_bold and len(text) < 60 and '|' in text
