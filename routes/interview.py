import os
import re
from flask import Blueprint, jsonify, request

interview_bp = Blueprint('interview', __name__)

db = None


def init_app(database):
    global db
    db = database


def _log_usage(client, call_type, job_id=None):
    """Log AI API usage after a successful call."""
    try:
        u = client.last_usage or {}
        db.log_api_usage(
            call_type=call_type,
            provider=u.get('provider', client.last_provider or 'unknown'),
            model=client.last_model_used or 'unknown',
            api_key_hint=client.last_key_hint or '',
            prompt_tokens=u.get('prompt_tokens', 0),
            completion_tokens=u.get('completion_tokens', 0),
            total_tokens=u.get('total_tokens', 0),
            job_id=job_id,
        )
    except Exception:
        pass  # never break the main flow for logging


# =================== STORIES API ===================

@interview_bp.route("/api/stories", methods=["GET"])
def get_stories():
    include_all = request.args.get("include_all", "0") == "1"
    stories = db.get_all_stories(include_stage_only=include_all)
    return jsonify(stories)


@interview_bp.route("/api/stories", methods=["POST"])
def add_story():
    data = request.get_json()
    title = data.get("title", "").strip()
    if not title:
        return jsonify({"error": "title is required"}), 400
    story_id = db.add_story(
        title=title,
        hook=data.get("hook", ""),
        content=data.get("content", ""),
        tags=data.get("tags", ""),
        stage_only=int(data.get("stage_only", 0)),
        competency=data.get("competency", ""),
        company=data.get("company", ""),
    )
    return jsonify({"id": story_id, "message": "Story added"}), 201


@interview_bp.route("/api/stories/<int:story_id>", methods=["PUT"])
def update_story(story_id):
    data = request.get_json()
    db.update_story(story_id, **data)
    return jsonify({"message": "Story updated"})


@interview_bp.route("/api/stories/<int:story_id>", methods=["DELETE"])
def delete_story(story_id):
    db.delete_story(story_id)
    return jsonify({"message": "Story deleted"})


@interview_bp.route("/api/stories/import", methods=["POST"])
def import_stories():
    data = request.get_json()
    text = data.get("text", "")
    if not text:
        return jsonify({"error": "text is required"}), 400

    from resume.story_parser import parse_stories
    stories = parse_stories(text)

    ids = []
    for story in stories:
        sid = db.add_story(
            title=story['title'],
            hook=story.get('hook', ''),
            content=story['content'],
            tags=story.get('tags', ''),
        )
        ids.append(sid)

    return jsonify({"imported": len(ids), "ids": ids}), 201


# =================== STORY VERSIONS API ===================

@interview_bp.route("/api/story-versions", methods=["POST"])
def add_story_version():
    data = request.get_json()
    version_id = db.add_story_version(
        story_id=data['story_id'],
        job_id=data['job_id'],
        framework=data.get('framework', 'SAIL'),
        reframed_content=data.get('reframed_content', ''),
    )
    return jsonify({"id": version_id, "message": "Story version saved"}), 201


@interview_bp.route("/api/story-versions/job/<int:job_id>", methods=["GET"])
def get_story_versions_for_job(job_id):
    versions = db.get_versions_for_job(job_id)
    return jsonify(versions)


@interview_bp.route("/api/story-versions/<int:version_id>", methods=["DELETE"])
def delete_story_version(version_id):
    db.delete_story_version(version_id)
    return jsonify({"message": "Story version deleted"})


# =================== INTERVIEW PREP API ===================

@interview_bp.route("/api/interview-prep/<int:job_id>/analyze", methods=["POST"])
def analyze_interview(job_id):
    """Run interview prep analysis with framework selection."""
    data = request.get_json() or {}
    framework = data.get('framework', 'SAIL')

    job = db.get_job_by_id(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    # Load job description (DB first, then file fallback)
    job_description = job.get('description', '') or ''
    if not job_description:
        file_path = job.get('file_path', '')
        if file_path and os.path.isfile(file_path):
            with open(file_path, 'r', encoding='utf-8') as f:
                job_description = f.read()

    if not job_description:
        return jsonify({"error": "No job description found. Import or scrape the job description first."}), 400

    # Build resume text from master resume
    resumes = db.get_all_resumes()
    resume_text = ""
    if resumes:
        sections = db.get_sections_for_resume(resumes[0]['id'])
        resume_text = _sections_to_text(sections)

    # Load stories
    stories = db.get_all_stories()
    stories_text = _format_stories(stories) if stories else ""

    # Select prompt based on framework
    from ai.prompts import INTERVIEWING_PROMPT, STARI_PROMPT, STARFAQS_PROMPT
    prompt_map = {
        'SAIL': INTERVIEWING_PROMPT,
        'STARI': STARI_PROMPT,
        'STARFAQS': STARFAQS_PROMPT,
    }
    prompt = prompt_map.get(framework, INTERVIEWING_PROMPT)

    # Stage-aware context
    stage_name = data.get('stage_name', '')
    stage_notes = data.get('stage_notes', '')

    # Build context
    context = f"""{prompt}

JOB DESCRIPTION:
{job_description}

RESUME:
{resume_text}
"""
    if stage_name:
        context += f"\nINTERVIEW STAGE: {stage_name}\n"
    if stage_notes:
        context += f"\nSTAGE GAME PLAN / NOTES:\n{stage_notes}\n"
    if stories_text:
        context += f"\nSTORY BANK:\n{stories_text}\n"

    # Build AI client — Claude primary for interview prep, Gemini fallback
    from ai.client import AIClient

    client = AIClient.from_config()

    try:
        result = client.analyze_interview(context)
    except Exception as e:
        return jsonify({"error": f"Analysis failed: {e}"}), 500

    result = _strip_preamble(result)
    _log_usage(client, 'prep_guide', job_id)
    insight_id = db.add_interview_insight(job_id, 'prep', framework, result)
    return jsonify({"analysis": result, "framework": framework, "insight_id": insight_id, "model": client.last_model_used})


@interview_bp.route("/api/stories/generate", methods=["POST"])
def generate_story():
    """Generate a SAIL story from a bullet point (no existing story required)."""
    data = request.get_json() or {}
    title = data.get('title', '').strip()
    bullet = data.get('bullet', '').strip()
    context = data.get('context', '').strip()

    if not bullet:
        return jsonify({"error": "bullet text is required"}), 400

    prompt = f"""You are an expert interview coach. Help the candidate expand a resume bullet point into a full SAIL (Situation, Action, Impact, Learning) story.

STORY TITLE: {title or 'Untitled Story'}

BULLET POINT TO EXPAND:
{bullet}

{f"ADDITIONAL CONTEXT FROM CANDIDATE: {context}" if context else ""}

### INSTRUCTIONS
Generate a complete SAIL story based on the bullet point. Include:
- What was the business context and challenge?
- What specific actions did the candidate take?
- What was the measurable impact?
- What did they learn?

### OUTPUT FORMAT
### Hook
[1-2 sentence summary]

### Context
[Business situation, team, stakes]

### Action
[Specific steps taken, decisions made, challenges overcome]

### Results
[Quantified impact, what changed]

### Takeaways
[Lessons learned, how this shaped their approach]"""

    from ai.client import AIClient

    client = AIClient.from_config()

    try:
        result = client.analyze_interview(prompt)
    except Exception as e:
        return jsonify({"error": f"Story generation failed: {e}"}), 500

    _log_usage(client, 'story_gen')
    return jsonify({"generated_content": result, "title": title or "Untitled Story"})


@interview_bp.route("/api/jobs/<int:job_id>/interview-tracking", methods=["PUT"])
def update_tracking(job_id):
    """Update interview tracking for a job."""
    data = request.get_json() or {}
    allowed = {'interview_rounds_total', 'interview_rounds_done', 'interview_status'}
    filtered = {k: v for k, v in data.items() if k in allowed}
    if filtered:
        db.update_interview_tracking(job_id, **filtered)
    return jsonify({"message": "Interview tracking updated"})


@interview_bp.route("/api/interview-prep/<int:job_id>/recommend-stories", methods=["POST"])
def recommend_stories(job_id):
    """AI-ranked story recommendations for a specific job."""
    import json as json_mod
    data = request.get_json() or {}
    job = db.get_job_by_id(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    # Load job description (DB first, then file fallback)
    job_description = job.get('description', '') or ''
    if not job_description:
        file_path = job.get('file_path', '')
        if file_path and os.path.isfile(file_path):
            with open(file_path, 'r', encoding='utf-8') as f:
                job_description = f.read()

    # Parse notes for context
    notes_text = ""
    raw_notes = job.get('notes', '')
    if raw_notes:
        try:
            entries = json_mod.loads(raw_notes)
            if isinstance(entries, list):
                notes_text = "\n".join(e.get('text', '') for e in entries if e.get('text'))
            else:
                notes_text = raw_notes
        except (json_mod.JSONDecodeError, TypeError):
            notes_text = raw_notes

    # Stage-aware context
    stage_name = data.get('stage_name', '')
    stage_notes = data.get('stage_notes', '')
    assigned_story_ids = data.get('assigned_story_ids', [])

    # Load all stories from the bank
    all_stories = db.get_all_stories()
    if not all_stories:
        return jsonify({"error": "No stories in your bank. Add stories first."}), 400

    stage_context = ""
    if stage_name:
        stage_context += f"\nINTERVIEW STAGE: {stage_name}"
    if stage_notes:
        stage_context += f"\nSTAGE GAME PLAN: {stage_notes}"

    # Two modes: evaluate assigned selection vs. rank entire bank
    stage_label = f" for the {stage_name} stage" if stage_name else ""
    if assigned_story_ids:
        assigned = [s for s in all_stories if s['id'] in assigned_story_ids]
        unassigned = [s for s in all_stories if s['id'] not in assigned_story_ids]
        assigned_text = _format_stories_with_ids(assigned)
        unassigned_text = _format_stories_with_ids(unassigned) if unassigned else "None."

        prompt = f"""Rank and evaluate the candidate's assigned stories for this role{stage_label}. Be direct — no preamble.

JOB: {job.get('title', '')} at {job.get('company', '')}
{stage_context}

JOB DESCRIPTION:
{job_description or 'N/A'}

ASSIGNED STORIES:
{assigned_text}

UNASSIGNED STORIES:
{unassigned_text}

Output in markdown — jump straight into the evaluation:

#### Evaluation
For each assigned story: **[ID:N] Title** — High/Medium/Low relevance. One line why.

#### Recommended Order
Optimal order with brief rationale.

#### Add
Stories from unassigned worth adding, or "None."

#### Remove
Stories to drop, or "None."

#### Gaps
Competencies from the JD not covered.

End with this exact line (IDs of stories to keep + add, in optimal order):
<!-- RECOMMENDED: id1,id2,id3 -->"""
    else:
        stories_text = _format_stories_brief_with_ids(all_stories)

        prompt = f"""Rank these stories by relevance to the role{stage_label}. Be direct — no preamble, jump straight into rankings.

JOB: {job.get('title', '')} at {job.get('company', '')}
{stage_context}

JOB DESCRIPTION:
{job_description or 'N/A'}

STORIES:
{stories_text}

Output in markdown — numbered list, best first:
**[ID:N] Title** — High/Medium/Low
- Why: one line on relevance
- Best for: which competencies/questions it addresses

After rankings, add:
#### Gaps
Competencies from the JD not covered by any story.

End with this exact line (High + Medium IDs, best first):
<!-- RECOMMENDED: id1,id2,id3 -->"""

    from ai.client import AIClient

    client = AIClient.from_config()

    try:
        result = client.analyze_with_rotation(prompt, max_tokens=12000)
    except Exception as e:
        return jsonify({"error": f"Recommendation failed: {e}"}), 500

    result = _strip_preamble(result)
    _log_usage(client, 'rank_stories', job_id)

    # Extract recommended story IDs from the AI's structured output
    valid_ids = [s['id'] for s in all_stories]
    suggested_ids = _extract_recommended_ids(result, valid_ids)
    # In evaluate mode, AI often only puts "keep" IDs in RECOMMENDED comment,
    # omitting new stories from the #### Add section — merge those in too
    if assigned_story_ids:
        add_ids = _extract_add_section_ids(result, valid_ids)
        for aid in add_ids:
            if aid not in suggested_ids:
                suggested_ids.append(aid)
    # Strip the machine-readable comment from the displayed markdown
    display_result = re.sub(r'\s*<!--\s*RECOMMENDED:.*?-->\s*', '', result).strip()

    insight_id = db.add_interview_insight(job_id, 'rank', None, display_result)
    return jsonify({
        "recommendations": display_result,
        "insight_id": insight_id,
        "model": client.last_model_used,
        "suggested_story_ids": suggested_ids,
    })


@interview_bp.route("/api/interview-prep/<int:job_id>/reframe-story", methods=["POST"])
def reframe_story(job_id):
    """Reframe a story for a specific job using AI."""
    import json as json_mod
    data = request.get_json() or {}
    story_id = data.get('story_id')
    if not story_id:
        return jsonify({"error": "story_id is required"}), 400

    job = db.get_job_by_id(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    story = db.get_story(story_id)
    if not story:
        return jsonify({"error": "Story not found"}), 404

    # Load job description (DB first, then file fallback)
    job_description = job.get('description', '') or ''
    if not job_description:
        file_path = job.get('file_path', '')
        if file_path and os.path.isfile(file_path):
            with open(file_path, 'r', encoding='utf-8') as f:
                job_description = f.read()

    # Parse notes for context
    notes_text = ""
    raw_notes = job.get('notes', '')
    if raw_notes:
        try:
            entries = json_mod.loads(raw_notes)
            if isinstance(entries, list):
                notes_text = "\n".join(e.get('text', '') for e in entries if e.get('text'))
            else:
                notes_text = raw_notes
        except (json_mod.JSONDecodeError, TypeError):
            notes_text = raw_notes

    prompt = f"""You are an expert interview coach. Reframe this interview story to be most compelling for the specific role.

JOB TITLE: {job.get('title', '')}
COMPANY: {job.get('company', '')}

JOB DESCRIPTION:
{job_description or 'No job description available.'}

CANDIDATE NOTES (from recruiter calls, phone screens, etc.):
{notes_text or 'No notes.'}

ORIGINAL STORY:
Title: {story['title']}
Hook: {story.get('hook', '')}
Content:
{story.get('content', '')}

### INSTRUCTIONS
Reframe this story to emphasize the aspects most relevant to the target role. Consider:
1. Which competencies from the job description does this story demonstrate?
2. What details should be emphasized or de-emphasized?
3. How can the impact be framed to resonate with this company/role?
4. If there are notes from a phone screen, tailor the story to address topics discussed.

Keep the same SAIL structure but adjust emphasis, language, and framing.

### OUTPUT FORMAT
### Hook
[Reframed 1-2 sentence hook]

### Context
[Reframed situation/context]

### Action
[Reframed actions, emphasizing relevant skills]

### Results
[Reframed impact, using metrics relevant to the role]

### Takeaways
[Reframed learnings, connected to the target role]"""

    from ai.client import AIClient

    client = AIClient.from_config()

    try:
        result = client.analyze_interview(prompt)
    except Exception as e:
        return jsonify({"error": f"Reframing failed: {e}"}), 500

    _log_usage(client, 'reframe', job_id)
    return jsonify({"reframed_content": result, "story_id": story_id})


@interview_bp.route("/api/stories/<int:story_id>/build", methods=["POST"])
def build_story(story_id):
    """Guided story builder: take a bullet/experience and generate SAIL story."""
    data = request.get_json() or {}
    bullet_text = data.get('bullet', '')
    additional_context = data.get('context', '')

    if not bullet_text:
        return jsonify({"error": "bullet text is required"}), 400

    story = db.get_story(story_id)
    if not story:
        return jsonify({"error": "Story not found"}), 404

    prompt = f"""You are an expert interview coach. Help the candidate expand a resume bullet point into a full SAIL (Situation, Action, Impact, Learning) story.

EXISTING STORY TITLE: {story['title']}
EXISTING HOOK: {story.get('hook', '')}

BULLET POINT TO EXPAND:
{bullet_text}

{f"ADDITIONAL CONTEXT FROM CANDIDATE: {additional_context}" if additional_context else ""}

### INSTRUCTIONS
Generate a complete SAIL story based on the bullet point. Ask yourself what details would make this compelling:
- What was the business context and challenge?
- What specific actions did the candidate take?
- What was the measurable impact?
- What did they learn?

### OUTPUT FORMAT
### Hook
[1-2 sentence summary]

### Context
[Business situation, team, stakes]

### Action
[Specific steps taken, decisions made, challenges overcome]

### Results
[Quantified impact, what changed]

### Takeaways
[Lessons learned, how this shaped their approach]"""

    from ai.client import AIClient

    client = AIClient.from_config()

    try:
        result = client.analyze_interview(prompt)
    except Exception as e:
        return jsonify({"error": f"Story builder failed: {e}"}), 500

    _log_usage(client, 'story_build')
    return jsonify({"generated_content": result})


@interview_bp.route("/api/stories/<int:story_id>/rework", methods=["POST"])
def rework_story(story_id):
    """Rework a story using two-pass approach: body first, then takeaway."""
    from ai.client import AIClient
    from ai.prompts import REWORK_STORY_PROMPT, REWORK_TAKEAWAY_PROMPT

    story = db.get_story(story_id)
    if not story:
        return jsonify({"error": "Story not found"}), 404

    data = request.get_json(silent=True) or {}
    target_role = data.get('target_role', '')
    target_company = data.get('target_company', '')

    story_context = f"""

### STORY TO REWORK
**Title**: {story['title']}
**Hook**: {story.get('hook', '') or 'None'}
**Competencies**: {story.get('competency', '') or 'None'}

**Content**:
{story.get('content', '')}
"""

    # --- Pass 1: Rework body (Hook → Results, no takeaway) ---
    body_prompt = REWORK_STORY_PROMPT + story_context

    client = AIClient.from_config()

    # Optional model override
    model_override = data.get('model')
    if model_override:
        parts = model_override.split('/', 1)
        if len(parts) == 2:
            client.force_model(parts[0], parts[1])

    # Use diversity rotation (different model each click) unless user forced a model
    _rework_call = client.analyze_interview if client._forced_model else client.analyze_with_diversity

    try:
        body_result = _rework_call(body_prompt)
    except Exception as e:
        return jsonify({"error": f"Story rework failed: {e}"}), 500

    _log_usage(client, 'story_rework')

    # Force same model for pass 2 so takeaway matches body style
    if not client._forced_model and client.last_provider and client.last_model_used:
        client.force_model(client.last_provider, client.last_model_used)

    # --- Pass 2: Generate takeaway separately ---
    takeaway_prompt = REWORK_TAKEAWAY_PROMPT + f"""

### REWORKED STORY (for context — already written)
{body_result}

### ORIGINAL STORY (for factual reference)
{story.get('content', '')}
"""
    if target_role or target_company:
        takeaway_prompt += f"""
### TARGET ROLE (for future pacing)
**Role**: {target_role or 'Not specified'}
**Company**: {target_company or 'Not specified'}
"""

    try:
        takeaway_result = client.analyze_interview(takeaway_prompt)
    except Exception as e:
        # If takeaway fails, return body without it
        return jsonify({
            "reworked_content": body_result,
            "story_id": story_id,
            "model_used": client.last_model_used,
            "provider": client.last_provider,
        })

    _log_usage(client, 'story_rework_takeaway')

    # Combine body + takeaway
    combined = body_result.rstrip() + "\n\n**Takeaway**\n" + takeaway_result.strip()

    # Auto-save to rework history
    history_id = db.add_rework_history(
        story_id=story_id,
        reworked_content=combined,
        model_used=client.last_model_used,
        provider=client.last_provider,
        target_role=target_role or None,
        target_company=target_company or None,
    )

    return jsonify({
        "reworked_content": combined,
        "story_id": story_id,
        "history_id": history_id,
        "model_used": client.last_model_used,
        "provider": client.last_provider,
    })


@interview_bp.route("/api/stories/<int:story_id>/rework-history", methods=["GET"])
def get_rework_history(story_id):
    """Get all rework history entries for a story."""
    history = db.get_rework_history(story_id)
    return jsonify({"history": history})


@interview_bp.route("/api/stories/rework-history/<int:rework_id>", methods=["DELETE"])
def delete_rework_entry(rework_id):
    """Delete a single rework history entry."""
    db.delete_rework_history(rework_id)
    return jsonify({"success": True})


def _sections_to_text(sections):
    """Convert resume sections to plain text for AI prompt."""
    lines = []
    for s in sections:
        html = s.get('content_html', '')
        text = re.sub(r'<[^>]+>', '', html)
        text = text.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
        text = text.replace('&quot;', '"').replace('&emsp;', '  ')
        text = text.strip()
        if text:
            if s.get('company_name') or s.get('role_title'):
                header = ' | '.join(filter(None, [s.get('company_name'), s.get('role_title')]))
                if s.get('dates'):
                    header += f"  {s['dates']}"
                lines.append(f"\n{header}")
            lines.append(text)
    return '\n'.join(lines)


def _format_stories(stories):
    """Format stories into text for AI context (full content)."""
    lines = []
    for s in stories:
        lines.append(f"# {s['title']}")
        if s.get('hook'):
            lines.append(f"Hook: {s['hook']}")
        if s.get('tags'):
            lines.append(f"Tags: {s['tags']}")
        if s.get('content'):
            lines.append(s['content'])
        lines.append('')
    return '\n'.join(lines)


def _format_stories_brief(stories):
    """Format stories as title + hook only (for ranking without needing full content)."""
    lines = []
    for i, s in enumerate(stories, 1):
        line = f"{i}. **{s['title']}**"
        if s.get('hook'):
            line += f" — {s['hook']}"
        if s.get('tags'):
            line += f"  [Tags: {s['tags']}]"
        lines.append(line)
    return '\n'.join(lines)


def _format_stories_brief_with_ids(stories):
    """Format stories as [ID:N] title + hook for AI ranking with ID extraction."""
    lines = []
    for s in stories:
        line = f"- [ID:{s['id']}] **{s['title']}**"
        if s.get('hook'):
            line += f" — {s['hook']}"
        if s.get('tags'):
            line += f"  [Tags: {s['tags']}]"
        lines.append(line)
    return '\n'.join(lines)


def _format_stories_with_ids(stories):
    """Format stories with full content and IDs for AI evaluation."""
    lines = []
    for s in stories:
        lines.append(f"# [ID:{s['id']}] {s['title']}")
        if s.get('hook'):
            lines.append(f"Hook: {s['hook']}")
        if s.get('tags'):
            lines.append(f"Tags: {s['tags']}")
        if s.get('content'):
            lines.append(s['content'])
        lines.append('')
    return '\n'.join(lines)


def _extract_recommended_ids(text, valid_ids):
    """Extract story IDs from <!-- RECOMMENDED: id1,id2,id3 --> comment in AI output."""
    match = re.search(r'<!--\s*RECOMMENDED:\s*([\d,\s]+)\s*-->', text)
    if not match:
        return []
    raw = match.group(1)
    ids = []
    for token in raw.split(','):
        token = token.strip()
        if token.isdigit():
            sid = int(token)
            if sid in valid_ids:
                ids.append(sid)
    return ids


def _extract_add_section_ids(text, valid_ids):
    """Extract story IDs from the #### Add section (AI often omits these from RECOMMENDED)."""
    add_match = re.search(r'####\s*Add\s*\n(.*?)(?=####|\Z)', text, re.DOTALL)
    if not add_match:
        return []
    add_text = add_match.group(1)
    ids = []
    for m in re.finditer(r'\[ID:(\d+)\]', add_text):
        sid = int(m.group(1))
        if sid in valid_ids and sid not in ids:
            ids.append(sid)
    return ids


def _strip_preamble(text):
    """Strip common AI preambles like 'As an expert interview coach...'"""
    if not text:
        return text
    return re.sub(
        r'^(?:As an? (?:expert |experienced )?interview coach[^.]*\.\s*)+',
        '', text, flags=re.IGNORECASE
    ).lstrip()


# =================== INTERVIEW INSIGHTS API ===================

@interview_bp.route("/api/interview-prep/<int:job_id>/insights", methods=["GET"])
def get_insights(job_id):
    """Get all saved interview insights for a job."""
    insights = db.get_insights_for_job(job_id)
    return jsonify(insights)


@interview_bp.route("/api/interview-prep/<int:job_id>/insights/<int:insight_id>", methods=["DELETE"])
def delete_insight(job_id, insight_id):
    """Delete a single interview insight."""
    db.delete_interview_insight(insight_id)
    return jsonify({"message": "Insight deleted"})


# =================== INTERVIEW STAGES API ===================

@interview_bp.route("/api/interview-stages/<int:job_id>", methods=["GET"])
def get_stages(job_id):
    """Get all interview stages for a job. Auto-creates default if none exist."""
    db.ensure_default_stage(job_id)
    stages = db.get_stages_for_job(job_id)
    for stage in stages:
        stories = db.get_stories_for_stage(stage['id'])
        stage['story_count'] = len(stories)
        stage['story_ids'] = [s['story_id'] for s in stories]
    return jsonify({"stages": stages})


@interview_bp.route("/api/interview-stages/<int:job_id>", methods=["POST"])
def add_stage(job_id):
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "Stage name is required"}), 400

    stages = db.get_stages_for_job(job_id)
    next_order = max((s['stage_order'] for s in stages), default=-1) + 1

    stage_id = db.add_interview_stage(
        job_id=job_id,
        name=name,
        stage_order=next_order,
        status=data.get('status', 'upcoming'),
    )
    return jsonify({"id": stage_id, "message": "Stage added"}), 201


@interview_bp.route("/api/interview-stages/<int:job_id>/<int:stage_id>", methods=["PUT"])
def update_stage_route(job_id, stage_id):
    data = request.get_json() or {}
    db.update_stage(stage_id, **data)
    return jsonify({"message": "Stage updated"})


@interview_bp.route("/api/interview-stages/<int:job_id>/<int:stage_id>", methods=["DELETE"])
def delete_stage_route(job_id, stage_id):
    db.delete_stage(stage_id)
    return jsonify({"message": "Stage deleted"})


@interview_bp.route("/api/interview-stages/<int:job_id>/reorder", methods=["PUT"])
def reorder_stages_route(job_id):
    data = request.get_json() or {}
    stage_ids = data.get("stage_ids", [])
    if not stage_ids:
        return jsonify({"error": "stage_ids required"}), 400
    db.reorder_stages(job_id, stage_ids)
    return jsonify({"message": "Stages reordered"})


# =================== STAGE STORIES API ===================

@interview_bp.route("/api/interview-stages/<int:job_id>/<int:stage_id>/stories", methods=["GET"])
def get_stage_stories_route(job_id, stage_id):
    stories = db.get_stories_for_stage(stage_id)
    return jsonify({"stories": stories})


@interview_bp.route("/api/interview-stages/<int:job_id>/<int:stage_id>/stories", methods=["POST"])
def assign_story_route(job_id, stage_id):
    data = request.get_json() or {}
    story_id = data.get("story_id")
    if not story_id:
        return jsonify({"error": "story_id is required"}), 400
    current = db.get_stories_for_stage(stage_id)
    sort_order = len(current)
    assignment_id = db.assign_story_to_stage(stage_id, story_id, sort_order)
    return jsonify({"id": assignment_id, "message": "Story assigned to stage"}), 201


@interview_bp.route("/api/interview-stages/<int:job_id>/<int:stage_id>/stories/<int:story_id>", methods=["PUT"])
def update_stage_story_content_route(job_id, stage_id, story_id):
    data = request.get_json() or {}
    custom_content = data.get("custom_content", "")
    db.update_stage_story_content(stage_id, story_id, custom_content)
    return jsonify({"message": "Story content updated"})


@interview_bp.route("/api/interview-stages/<int:job_id>/<int:stage_id>/stories/<int:story_id>", methods=["DELETE"])
def remove_story_route(job_id, stage_id, story_id):
    db.remove_story_from_stage(stage_id, story_id)
    return jsonify({"message": "Story removed from stage"})


@interview_bp.route("/api/interview-stages/<int:job_id>/<int:stage_id>/stories/reorder", methods=["PUT"])
def reorder_stage_stories_route(job_id, stage_id):
    data = request.get_json() or {}
    story_ids = data.get("story_ids", [])
    if not story_ids:
        return jsonify({"error": "story_ids required"}), 400
    db.reorder_stage_stories(stage_id, story_ids)
    return jsonify({"message": "Stage stories reordered"})


# =================== MOCK INTERVIEWS API ===================

@interview_bp.route("/api/interview-stages/<int:job_id>/<int:stage_id>/mocks", methods=["GET"])
def get_mocks_route(job_id, stage_id):
    mocks = db.get_mock_interviews(stage_id)
    return jsonify({"mocks": mocks})


@interview_bp.route("/api/interview-stages/<int:job_id>/<int:stage_id>/mocks", methods=["POST"])
def add_mock_route(job_id, stage_id):
    data = request.get_json() or {}
    title = data.get("title", "Mock Practice").strip() or "Mock Practice"
    mock_id = db.add_mock_interview(stage_id, title)
    return jsonify({"id": mock_id, "message": "Mock interview added"}), 201


@interview_bp.route("/api/interview-stages/<int:job_id>/<int:stage_id>/mocks/<int:mock_id>", methods=["PUT"])
def update_mock_route(job_id, stage_id, mock_id):
    data = request.get_json() or {}
    db.update_mock_interview(mock_id, **data)
    return jsonify({"message": "Mock interview updated"})


@interview_bp.route("/api/interview-stages/<int:job_id>/<int:stage_id>/mocks/<int:mock_id>", methods=["DELETE"])
def delete_mock_route(job_id, stage_id, mock_id):
    db.delete_mock_interview(mock_id)
    return jsonify({"message": "Mock interview deleted"})
