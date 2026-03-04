"""
Writes job data as markdown files to the Obsidian vault.
File pattern: Company/Job Title.md (matches existing convention).
"""

import os
import re
from datetime import datetime

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import OUTPUT_DIR


class MarkdownFileWriter:
    def __init__(self, output_dir=None):
        self.output_dir = output_dir or OUTPUT_DIR

    def write(self, job):
        """Write a job as a markdown file. Returns the file path."""
        company = job.get('company') or 'Unknown'
        title = job.get('title') or 'Untitled Position'

        safe_company = self._sanitize_filename(company)
        safe_title = self._sanitize_filename(title)

        if len(safe_title) > 80:
            safe_title = safe_title[:80].rstrip()

        company_dir = os.path.join(self.output_dir, safe_company)
        os.makedirs(company_dir, exist_ok=True)

        file_path = os.path.join(company_dir, f"{safe_title}.md")

        # Handle filename collision
        if os.path.exists(file_path):
            timestamp = datetime.now().strftime("%H%M%S")
            file_path = os.path.join(company_dir, f"{safe_title} ({timestamp}).md")

        content = self._build_markdown(job)

        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)

        return file_path

    def _build_markdown(self, job):
        """Build markdown content with YAML frontmatter matching existing files."""
        title = job.get('title', 'Untitled')
        company = job.get('company', 'Unknown')
        url = job.get('url', '')
        location = job.get('location', '')
        salary = job.get('salary', '')
        description = job.get('description', '')
        today = datetime.now().strftime('%Y-%m-%d')

        # Escape quotes in YAML values
        def yq(val):
            return str(val).replace('"', '\\"') if val else ''

        lines = [
            '---',
            f'title: "{yq(company)} - {yq(title)}"',
            f'source: "{yq(url)}"',
            'author:',
            f'  - [["{yq(company)}"]]',
            'published:',
            f'created: {today}',
            f'description: "{yq(title)} at {yq(company)}"',
            'tags:',
            '  - "clippings"',
            '  - "job-discovery"',
        ]

        if location:
            lines.append(f'location: "{yq(location)}"')
        if salary:
            lines.append(f'salary: "{yq(salary)}"')

        lines.append('---')
        lines.append('')

        if title:
            lines.append(f'## {title}')
            lines.append('')

        if company:
            lines.append(f'**Company:** {company}')
        if location:
            lines.append(f'**Location:** {location}')
        if salary:
            lines.append(f'**Salary:** {salary}')
        if url:
            lines.append(f'**Source:** {url}')

        lines.append('')

        if description:
            lines.append(description)
        else:
            lines.append(f'*No description extracted. View the full posting at: {url}*')

        return '\n'.join(lines)

    def _sanitize_filename(self, name):
        """Remove/replace characters invalid in Windows filenames."""
        name = re.sub(r'[<>:"/\\|?*]', '', name)
        name = re.sub(r'\s+', ' ', name).strip()
        name = name.rstrip('. ')
        return name if name else 'Unknown'
