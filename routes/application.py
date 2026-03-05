import os
from flask import Blueprint, jsonify, request, send_file
from werkzeug.utils import secure_filename

application_bp = Blueprint('application', __name__)

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
        pass


# =================== RESUMES API ===================

@application_bp.route("/api/resumes", methods=["GET"])
def get_resumes():
    resumes = db.get_all_resumes()
    return jsonify(resumes)


@application_bp.route("/api/resumes/<int:resume_id>", methods=["GET", "PUT", "DELETE"])
def resume_detail(resume_id):
    if request.method == "GET":
        resume = db.get_resume(resume_id)
        if not resume:
            return jsonify({"error": "Resume not found"}), 404
        sections = db.get_sections_for_resume(resume_id)
        return jsonify({"resume": resume, "sections": sections})

    elif request.method == "PUT":
        data = request.get_json()
        name = data.get('name', '').strip()
        if not name:
            return jsonify({"error": "Name is required"}), 400
        db.update_resume_name(resume_id, name)
        return jsonify({"message": "Resume updated"})

    elif request.method == "DELETE":
        db.delete_resume(resume_id)
        return jsonify({"message": "Resume deleted"})


@application_bp.route("/api/resumes/upload", methods=["POST"])
def upload_resume():
    """Upload a .docx resume, parse into sections, store in DB."""
    if 'file' not in request.files:
        return jsonify({"error": "No file provided"}), 400
    file = request.files['file']
    if not file.filename.endswith('.docx'):
        return jsonify({"error": "Only .docx files supported"}), 400

    from config import UPLOAD_DIR
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    filename = secure_filename(file.filename)
    filepath = os.path.join(UPLOAD_DIR, filename)
    file.save(filepath)

    try:
        from resume.parser import ResumeParser
        parser = ResumeParser()
        sections = parser.parse(filepath)
    except Exception as e:
        return jsonify({"error": f"Failed to parse resume: {e}"}), 400

    full_html = ''.join(s['content_html'] for s in sections)
    resume_id = db.add_resume(
        name=filename.rsplit('.', 1)[0],
        content_html=full_html,
        original_filename=filename,
    )

    for i, section in enumerate(sections):
        db.add_resume_section(
            resume_id=resume_id,
            section_type=section['type'],
            section_order=i,
            content_html=section['content_html'],
            company_name=section.get('company_name'),
            role_title=section.get('role_title'),
            dates=section.get('dates'),
        )

    return jsonify({"id": resume_id, "sections": len(sections), "message": "Resume uploaded"}), 201


# =================== APPLICATIONS API ===================

@application_bp.route("/api/applications", methods=["POST"])
def create_application():
    data = request.get_json()
    job_id = data.get('job_id')
    resume_id = data.get('resume_id')

    if not job_id:
        return jsonify({"error": "job_id is required"}), 400

    # Default to first resume if not specified
    if not resume_id:
        resumes = db.get_all_resumes()
        if not resumes:
            return jsonify({"error": "No resume uploaded yet"}), 400
        resume_id = resumes[0]['id']

    resume = db.get_resume(resume_id)
    app_id = db.create_application(
        job_id=job_id,
        resume_id=resume_id,
        content_html=resume.get('content_html'),
        content_json=resume.get('content_json'),
    )
    db.update_job_status(job_id, 'preparing')
    return jsonify({"id": app_id, "message": "Application created"}), 201


@application_bp.route("/api/applications/<int:app_id>/switch-resume", methods=["PUT"])
def switch_resume_base(app_id):
    """Replace the resume base for an existing application."""
    data = request.get_json()
    resume_id = data.get('resume_id')
    if not resume_id:
        return jsonify({"error": "resume_id is required"}), 400

    app = db.get_application(app_id)
    if not app:
        return jsonify({"error": "Application not found"}), 404

    resume = db.get_resume(resume_id)
    if not resume:
        return jsonify({"error": "Resume not found"}), 404

    db.update_application(
        app_id,
        resume_id=resume_id,
        content_html=resume.get('content_html'),
        content_json=resume.get('content_json'),
    )
    return jsonify({"message": "Resume base switched"})


@application_bp.route("/api/applications/<int:app_id>", methods=["GET"])
def get_application(app_id):
    app = db.get_application(app_id)
    if not app:
        return jsonify({"error": "Application not found"}), 404
    sections = db.get_sections_for_resume(app['resume_id'])
    app['sections'] = sections
    return jsonify(app)


@application_bp.route("/api/applications/job/<int:job_id>", methods=["GET"])
def get_application_for_job(job_id):
    app = db.get_application_by_job(job_id)
    if not app:
        return jsonify({"error": "No application for this job"}), 404
    sections = db.get_sections_for_resume(app['resume_id'])
    app['sections'] = sections
    return jsonify(app)


@application_bp.route("/api/applications/<int:app_id>/analyze", methods=["POST"])
def analyze_application(app_id):
    """Run two-phase AI analysis: profile assessment + bullet analysis."""
    app_record = db.get_application(app_id)
    if not app_record:
        return jsonify({"error": "Application not found"}), 404

    job = db.get_job_by_id(app_record['job_id'])
    if not job:
        return jsonify({"error": "Job not found"}), 404

    # Load job description from DB column or saved markdown file
    job_description = job.get('description', '') or ''
    file_path = job.get('file_path', '')
    if file_path and os.path.isfile(file_path):
        with open(file_path, 'r', encoding='utf-8') as f:
            job_description = f.read()

    if not job_description:
        return jsonify({"error": "No job description found. Run the scraper first to save job details."}), 400

    # Build resume text from sections
    sections = db.get_sections_for_resume(app_record['resume_id'])
    resume_text = _sections_to_text(sections)

    # Load job blurbs
    blurbs = db.get_all_blurbs()
    blurbs_text = _format_blurbs(blurbs) if blurbs else ""

    # Build AI client
    from config import GEMINI_API_KEYS, GEMINI_INTERVIEW_MODELS, CLAUDE_API_KEY, CLAUDE_MODEL
    from ai.client import AIClient
    from ai.prompts import APPLYING_PROMPT, BULLET_ANALYSIS_PROMPT

    client = AIClient(
        gemini_keys=GEMINI_API_KEYS,
        gemini_models=GEMINI_INTERVIEW_MODELS,
        claude_api_key=CLAUDE_API_KEY,
        claude_model=CLAUDE_MODEL,
    )

    context = f"""JOB DESCRIPTION:
{job_description}

RESUME:
{resume_text}
"""
    if blurbs_text:
        context += f"\nJOB BLURBS LIBRARY:\n{blurbs_text}\n"

    # Phase 1: Profile assessment
    try:
        phase1 = client.analyze_resume(APPLYING_PROMPT + "\n\n" + context)
    except Exception as e:
        return jsonify({"error": f"Phase 1 analysis failed: {e}"}), 500
    _log_usage(client, 'resume_analysis', app_record.get('job_id'))

    # Phase 2: Bullet analysis
    bullet_context = f"""{BULLET_ANALYSIS_PROMPT}

JOB REQUIREMENTS:
{job_description}

RESUME:
{resume_text}
"""
    try:
        phase2 = client.analyze_resume(bullet_context)
    except Exception as e:
        # Save phase 1 even if phase 2 fails
        db.update_application(app_id, analysis_phase1=phase1)
        return jsonify({
            "analysis_phase1": phase1,
            "analysis_phase2": None,
            "warning": f"Phase 2 failed: {e}",
        })
    _log_usage(client, 'resume_analysis', app_record.get('job_id'))

    # Save both phases
    db.update_application(app_id, analysis_phase1=phase1, analysis_phase2=phase2)

    return jsonify({
        "analysis_phase1": phase1,
        "analysis_phase2": phase2,
    })


def _sections_to_text(sections):
    """Convert resume sections to plain text for AI prompt."""
    import re
    lines = []
    for s in sections:
        html = s.get('content_html', '')
        # Strip HTML tags for plain text
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


def _format_blurbs(blurbs):
    """Format job blurbs into text for AI context."""
    lines = []
    for b in blurbs:
        header = b.get('company_name', '')
        if b.get('role_title'):
            header += f" - {b['role_title']}"
        if b.get('variant_name'):
            header += f" ({b['variant_name']})"
        lines.append(f"### {header}")
        lines.append(b.get('content', ''))
        lines.append('')
    return '\n'.join(lines)


@application_bp.route("/api/applications/<int:app_id>/export/docx", methods=["GET"])
def export_docx(app_id):
    """Export application resume as .docx file."""
    import json
    import tempfile
    from resume.exporter import ResumeExporter

    app_record = db.get_application(app_id)
    if not app_record:
        return jsonify({"error": "Application not found"}), 404

    # Build sections: prefer edited content_json, fall back to master sections
    sections = db.get_sections_for_resume(app_record['resume_id'])
    if app_record.get('content_json'):
        try:
            saved = json.loads(app_record['content_json'])
            saved_map = {s['id']: s['html'] for s in saved}
            sections = [{**s, 'content_html': saved_map.get(s['id'], s['content_html'])}
                        for s in sections]
        except (json.JSONDecodeError, KeyError):
            pass

    # Get job info for filename
    job = db.get_job_by_id(app_record['job_id'])
    company = job.get('company', 'export') if job else 'export'
    safe_company = "".join(c for c in company if c.isalnum() or c in (' ', '-', '_')).strip()

    # Export to temp file with margin preset
    margin = request.args.get('margin', 'normal')
    tmp = tempfile.NamedTemporaryFile(suffix='.docx', delete=False)
    tmp.close()

    exporter = ResumeExporter()
    exporter.export(sections, tmp.name, margin=margin)

    return send_file(
        tmp.name,
        as_attachment=True,
        download_name=f"Resume_{safe_company}.docx",
        mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )


@application_bp.route("/api/applications/<int:app_id>/content", methods=["PUT"])
def update_application_content(app_id):
    data = request.get_json()
    db.update_application(
        app_id,
        content_html=data.get('content_html'),
        content_json=data.get('content_json'),
    )
    return jsonify({"message": "Content saved"})


@application_bp.route("/api/applications/<int:app_id>/apply", methods=["POST"])
def mark_applied(app_id):
    app = db.get_application(app_id)
    if not app:
        return jsonify({"error": "Application not found"}), 404
    db.update_job_status(app['job_id'], 'applied')
    job = db.get_job_by_id(app['job_id'])
    return jsonify({"message": "Marked as applied", "job_url": job.get('job_url')})
