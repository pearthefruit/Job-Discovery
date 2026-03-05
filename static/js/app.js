// =================== State ===================

let scraperPollingInterval = null;
let logPollingInterval = null;
let lastLogId = 0;
let currentRunId = null;
let searchDebounceTimer = null;
let currentAppId = null;           // current application being edited
let currentInterviewJobId = null;  // current job for interview prep
let _analysisHtmlCache = '';       // cached analysis HTML for restoring after bullet compare
let _bulletCompareState = null;    // current bullet comparison state
let _builderGeneratedContent = ''; // last generated story content from builder
let expandedJobId = null;          // currently expanded job in overlay
let expandedJobPhase = 'resume';   // 'resume' or 'interview'
let expandedJobData = null;        // cached job object for expanded view
let _storiesCache = [];
let _jdPanelVisible = false;       // job description side panel toggle
let _jdCache = {};                 // cached JD text per job id

// Discovery tab filter/group state
let columnFilters = { company: null, location: null, status: null, date_found: null };
let showIgnoredJobs = false;
let groupByCompany = false;
let collapsedCompanyGroups = new Set();
let _allJobs = [];
let _openFilterColumn = null;
let jobSortColumn = null;   // null | 'title' | 'company' | 'location' | 'salary' | 'date_found' | 'status'
let jobSortDir = 'asc';     // 'asc' | 'desc'

// Story bank filter/group state
let storyFilters = { company: null, competency: null };
let storyGroupBy = '';
let collapsedStoryGroups = new Set();
let _openStoryFilterColumn = null;
let _storyFilterTimer = null;

const DEFAULT_COMPETENCY_PRESETS = [
    'Leadership', 'Bias for Action', 'Resilience', 'Influence',
    'Decisions w/o Data', 'Customer Obsession', 'Ownership',
    'Deliver Results', 'Dive Deep', 'Earn Trust', 'Disagree & Commit',
    'Strategic Thinking'
];

function getCompetencyPresets() {
    try {
        const stored = localStorage.getItem('competencyPresets');
        if (stored) return JSON.parse(stored);
    } catch {}
    return [...DEFAULT_COMPETENCY_PRESETS];
}

function saveCompetencyPresets(presets) {
    localStorage.setItem('competencyPresets', JSON.stringify(presets));
}

// =================== Helpers ===================

function parseUTC(ts) {
    if (!ts) return null;
    return new Date(ts.replace(' ', 'T') + 'Z');
}

// =================== API Layer ===================

const api = {
    // --- Sources ---
    async getSources() {
        return fetch('/api/sources').then(r => r.json());
    },
    async addSource(data) {
        return fetch('/api/sources', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }).then(r => r.json());
    },
    async deleteSource(id) {
        return fetch(`/api/sources/${id}`, { method: 'DELETE' }).then(r => r.json());
    },
    async toggleSource(id, isActive) {
        return fetch(`/api/sources/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: isActive ? 1 : 0 })
        }).then(r => r.json());
    },

    // --- Filters ---
    async getFilters() {
        return fetch('/api/filters').then(r => r.json());
    },
    async addFilter(keyword, filterType = 'include') {
        return fetch('/api/filters', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keyword, filter_type: filterType })
        }).then(r => r.json());
    },
    async deleteFilter(id) {
        return fetch(`/api/filters/${id}`, { method: 'DELETE' }).then(r => r.json());
    },
    async clearAllFilters() {
        return fetch('/api/filters/all', { method: 'DELETE' }).then(r => r.json());
    },

    // --- Jobs ---
    async getJobs(search = '', stage = '') {
        const params = new URLSearchParams();
        params.set('limit', '10000');
        if (search) params.set('search', search);
        if (stage) params.set('stage', stage);
        return fetch(`/api/jobs?${params.toString()}`).then(r => r.json());
    },
    async updateJobStatus(id, status) {
        return fetch(`/api/jobs/${id}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        }).then(r => r.json());
    },
    async getFilteredJobs() {
        return fetch('/api/jobs/filtered').then(r => r.json());
    },
    async keepFilteredJob(id) {
        return fetch(`/api/jobs/${id}/keep`, { method: 'POST' }).then(r => r.json());
    },
    async updateJobNotes(id, notes) {
        return fetch(`/api/jobs/${id}/notes`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes })
        }).then(r => r.json());
    },
    async setJobOutcome(id, status, rejected_at_stage, notes) {
        return fetch(`/api/jobs/${id}/outcome`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, rejected_at_stage, notes })
        }).then(r => r.json());
    },
    async getStats() {
        return fetch('/api/stats').then(r => r.json());
    },
    async getPipelineStats() {
        return fetch('/api/pipeline-stats').then(r => r.json());
    },
    async getOutcomes() {
        return fetch('/api/outcomes').then(r => r.json());
    },
    async getAIUsageStats() {
        return fetch('/api/ai-usage-stats').then(r => r.json());
    },

    // --- Scraper ---
    async runScraper() {
        const r = await fetch('/api/scraper/run', { method: 'POST' });
        let data;
        try {
            data = await r.json();
        } catch {
            data = { error: `Server error (${r.status})` };
        }
        return { status: r.status, data };
    },
    async getScraperStatus() {
        return fetch('/api/scraper/status').then(r => r.json());
    },
    async getScraperLog(sinceId = 0, runId = null) {
        const params = new URLSearchParams({ since_id: sinceId });
        if (runId) params.set('run_id', runId);
        return fetch(`/api/scraper/log?${params}`).then(r => r.json());
    },
    async getJobDescription(jobId) {
        return fetch(`/api/jobs/${jobId}/description`).then(r => r.json());
    },
    async updateJobDescription(jobId, description) {
        return fetch(`/api/jobs/${jobId}/description`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description })
        }).then(r => r.json());
    },
    async updateJobFields(jobId, fields) {
        return fetch(`/api/jobs/${jobId}/fields`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fields)
        }).then(r => r.json());
    },
    async rescrapeJob(jobId) {
        const r = await fetch(`/api/jobs/${jobId}/rescrape`, { method: 'POST' });
        try {
            return { status: r.status, data: await r.json() };
        } catch {
            return { status: r.status, data: { error: `Server returned ${r.status}` } };
        }
    },
    async reformatJD(jobId) {
        const r = await fetch(`/api/jobs/${jobId}/reformat-jd`, { method: 'POST' });
        return { status: r.status, data: await r.json() };
    },
    async importJob(data) {
        return fetch('/api/jobs/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }).then(r => r.json());
    },
    async scrapeUrls(urls) {
        return fetch('/api/jobs/scrape-urls', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls })
        }).then(r => r.json());
    },
    async getObsidianFiles() {
        return fetch('/api/obsidian/files').then(r => r.json());
    },
    async readObsidianFile(path) {
        return fetch('/api/obsidian/file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
        }).then(r => r.json());
    },

    // --- Resumes ---
    async getResumes() {
        return fetch('/api/resumes').then(r => r.json());
    },
    async getResume(id) {
        return fetch(`/api/resumes/${id}`).then(r => r.json());
    },
    async deleteResume(id) {
        return fetch(`/api/resumes/${id}`, { method: 'DELETE' }).then(r => r.json());
    },
    async renameResume(id, name) {
        return fetch(`/api/resumes/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        }).then(r => r.json());
    },

    // --- Applications ---
    async createApplication(jobId, resumeId) {
        return fetch('/api/applications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_id: jobId, resume_id: resumeId })
        }).then(r => r.json());
    },
    async getApplication(id) {
        return fetch(`/api/applications/${id}`).then(r => r.json());
    },
    async switchResumeBase(appId, resumeId) {
        return fetch(`/api/applications/${appId}/switch-resume`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resume_id: resumeId })
        }).then(r => r.json());
    },
    async getApplicationForJob(jobId) {
        return fetch(`/api/applications/job/${jobId}`).then(r => r.json()).catch(() => null);
    },
    async updateApplicationContent(id, contentHtml, contentJson) {
        return fetch(`/api/applications/${id}/content`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content_html: contentHtml, content_json: contentJson })
        }).then(r => r.json());
    },
    async analyzeApplication(id) {
        // AI analysis can take 2-3 minutes (two phases); use AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 min
        try {
            const r = await fetch(`/api/applications/${id}/analyze`, {
                method: 'POST',
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            const data = await r.json();
            if (!r.ok && !data.error) data.error = `Server error (${r.status})`;
            return data;
        } catch (e) {
            clearTimeout(timeoutId);
            if (e.name === 'AbortError') {
                return { error: 'Analysis timed out after 5 minutes. Try again.' };
            }
            throw e;
        }
    },
    async markApplied(id) {
        return fetch(`/api/applications/${id}/apply`, { method: 'POST' }).then(r => r.json());
    },

    // --- Stories ---
    async getStories(includeAll) {
        const url = includeAll ? '/api/stories?include_all=1' : '/api/stories';
        return fetch(url).then(r => r.json());
    },
    async addStory(data) {
        return fetch('/api/stories', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }).then(r => r.json());
    },
    async updateStory(id, data) {
        return fetch(`/api/stories/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }).then(r => r.json());
    },
    async deleteStory(id) {
        return fetch(`/api/stories/${id}`, { method: 'DELETE' }).then(r => r.json());
    },
    async importStories(text) {
        return fetch('/api/stories/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        }).then(r => r.json());
    },

    // --- Story Versions ---
    async getStoryVersionsForJob(jobId) {
        return fetch(`/api/story-versions/job/${jobId}`).then(r => r.json());
    },

    // --- Interview Prep ---
    async analyzeInterview(jobId, framework, stageName, stageNotes) {
        const payload = { framework };
        if (stageName) payload.stage_name = stageName;
        if (stageNotes) payload.stage_notes = stageNotes;
        return fetch(`/api/interview-prep/${jobId}/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(r => r.json());
    },
    async buildStory(storyId, bullet, context) {
        return fetch(`/api/stories/${storyId}/build`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bullet, context })
        }).then(r => r.json());
    },
    async generateStory(title, bullet, context) {
        return fetch('/api/stories/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, bullet, context })
        }).then(r => r.json());
    },
    async updateInterviewTracking(jobId, data) {
        return fetch(`/api/jobs/${jobId}/interview-tracking`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }).then(r => r.json());
    },

    // --- Activity Log ---
    async getActivityLog(jobId) {
        return fetch(`/api/jobs/${jobId}/activity-log`).then(r => r.json());
    },
    async addActivityEntry(jobId, text, type) {
        return fetch(`/api/jobs/${jobId}/activity-log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, type })
        }).then(r => r.json());
    },

    // --- Interview Prep (AI) ---
    async recommendStories(jobId, stageName, stageNotes, assignedStoryIds) {
        const payload = {};
        if (stageName) payload.stage_name = stageName;
        if (stageNotes) payload.stage_notes = stageNotes;
        if (assignedStoryIds && assignedStoryIds.length) payload.assigned_story_ids = assignedStoryIds;
        return fetch(`/api/interview-prep/${jobId}/recommend-stories`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(r => r.json());
    },
    async reframeStory(jobId, storyId) {
        return fetch(`/api/interview-prep/${jobId}/reframe-story`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ story_id: storyId })
        }).then(r => r.json());
    },
    async getInsights(jobId) {
        return fetch(`/api/interview-prep/${jobId}/insights`).then(r => r.json());
    },
    async deleteInsight(jobId, insightId) {
        return fetch(`/api/interview-prep/${jobId}/insights/${insightId}`, { method: 'DELETE' }).then(r => r.json());
    },

    // --- Interview Stages ---
    async getStages(jobId) {
        return fetch(`/api/interview-stages/${jobId}`).then(r => r.json());
    },
    async addStage(jobId, name) {
        return fetch(`/api/interview-stages/${jobId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        }).then(r => r.json());
    },
    async updateStage(jobId, stageId, data) {
        return fetch(`/api/interview-stages/${jobId}/${stageId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }).then(r => r.json());
    },
    async deleteStage(jobId, stageId) {
        return fetch(`/api/interview-stages/${jobId}/${stageId}`, { method: 'DELETE' }).then(r => r.json());
    },
    async reorderStages(jobId, stageIds) {
        return fetch(`/api/interview-stages/${jobId}/reorder`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage_ids: stageIds })
        }).then(r => r.json());
    },
    async getStageStories(jobId, stageId) {
        return fetch(`/api/interview-stages/${jobId}/${stageId}/stories`).then(r => r.json());
    },
    async assignStoryToStage(jobId, stageId, storyId) {
        return fetch(`/api/interview-stages/${jobId}/${stageId}/stories`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ story_id: storyId })
        }).then(r => r.json());
    },
    async updateStageStoryContent(jobId, stageId, storyId, customContent) {
        return fetch(`/api/interview-stages/${jobId}/${stageId}/stories/${storyId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ custom_content: customContent })
        }).then(r => r.json());
    },
    async removeStoryFromStage(jobId, stageId, storyId) {
        return fetch(`/api/interview-stages/${jobId}/${stageId}/stories/${storyId}`, { method: 'DELETE' }).then(r => r.json());
    },
    async reorderStageStories(jobId, stageId, storyIds) {
        return fetch(`/api/interview-stages/${jobId}/${stageId}/stories/reorder`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ story_ids: storyIds })
        }).then(r => r.json());
    },
    async getMocks(jobId, stageId) {
        return fetch(`/api/interview-stages/${jobId}/${stageId}/mocks`).then(r => r.json());
    },
    async addMock(jobId, stageId, title) {
        return fetch(`/api/interview-stages/${jobId}/${stageId}/mocks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
        }).then(r => r.json());
    },
    async updateMock(jobId, stageId, mockId, data) {
        return fetch(`/api/interview-stages/${jobId}/${stageId}/mocks/${mockId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }).then(r => r.json());
    },
    async deleteMock(jobId, stageId, mockId) {
        return fetch(`/api/interview-stages/${jobId}/${stageId}/mocks/${mockId}`, { method: 'DELETE' }).then(r => r.json());
    },
};

// =================== Tab Navigation ===================

function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-content').forEach(panel => {
        panel.classList.toggle('active', panel.id === `tab-${tabName}`);
    });

    if (tabName === 'discovery') refreshDiscovery();
    else if (tabName === 'board') refreshBoard();
    else if (tabName === 'toolkit') refreshToolkit();
}

// =================== Discovery Tab ===================

async function refreshDiscovery() {
    const [stats, jobs, status, sources, filters, aiUsage] = await Promise.all([
        api.getStats(),
        api.getJobs(),
        api.getScraperStatus(),
        api.getSources(),
        api.getFilters(),
        api.getAIUsageStats(),
    ]);

    document.getElementById('stat-total').textContent = stats.total_jobs;
    document.getElementById('stat-today').textContent = stats.new_today;
    document.getElementById('stat-sources').textContent = stats.active_sources;
    document.getElementById('stat-filters').textContent = stats.active_filters;

    document.getElementById('source-count-badge').textContent = sources.length;
    document.getElementById('filter-count-badge').textContent = filters.length;

    renderAIUsageStats(aiUsage);
    renderJobs(jobs);
    renderScraperStatus(status);
    renderSources(sources);
    renderFilters(filters);
    loadFilteredJobs();
}

function _formatTokens(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
}

function renderAIUsageStats(data) {
    const el = document.getElementById('ai-usage-stats');
    if (!el) return;

    document.getElementById('ai-stat-calls-today').textContent = data.today_calls;
    document.getElementById('ai-stat-tokens-today').textContent = _formatTokens(data.today_tokens);
    document.getElementById('ai-stat-calls-total').textContent = data.total_calls;
    document.getElementById('ai-stat-tokens-total').textContent = _formatTokens(data.total_tokens);

    const detail = document.getElementById('ai-usage-detail');
    if (!detail) return;

    let html = '';

    if (data.by_model && data.by_model.length) {
        html += `<div class="ai-usage-table-wrap"><h4>By Model</h4><table class="ai-usage-table">
            <tr><th>Model</th><th>Calls</th><th>Tokens</th></tr>
            ${data.by_model.map(r => `<tr><td>${escapeHtml(r.model)}</td><td>${r.calls}</td><td>${_formatTokens(r.tokens)}</td></tr>`).join('')}
        </table></div>`;
    }

    if (data.by_type && data.by_type.length) {
        html += `<div class="ai-usage-table-wrap"><h4>By Type</h4><table class="ai-usage-table">
            <tr><th>Type</th><th>Calls</th><th>Tokens</th></tr>
            ${data.by_type.map(r => `<tr><td>${escapeHtml(r.call_type)}</td><td>${r.calls}</td><td>${_formatTokens(r.tokens)}</td></tr>`).join('')}
        </table></div>`;
    }

    if (data.by_key && data.by_key.length) {
        html += `<div class="ai-usage-table-wrap"><h4>By Key</h4><table class="ai-usage-table">
            <tr><th>Key</th><th>Calls</th><th>Tokens</th></tr>
            ${data.by_key.map(r => `<tr><td>${escapeHtml(r.key_hint)}</td><td>${r.calls}</td><td>${_formatTokens(r.tokens)}</td></tr>`).join('')}
        </table></div>`;
    }

    if (data.recent && data.recent.length) {
        html += `<div class="ai-usage-table-wrap"><h4>Recent Calls</h4><table class="ai-usage-table">
            <tr><th>Time</th><th>Type</th><th>Model</th><th>Tokens</th></tr>
            ${data.recent.map(r => {
                const t = r.created_at ? new Date(r.created_at + 'Z').toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '';
                return `<tr><td>${t}</td><td>${escapeHtml(r.call_type)}</td><td>${escapeHtml(r.model)}</td><td>${_formatTokens(r.total_tokens)}</td></tr>`;
            }).join('')}
        </table></div>`;
    }

    detail.innerHTML = html || '<div class="empty-state">No AI calls recorded yet.</div>';
}

function toggleAIUsageDetail() {
    const detail = document.getElementById('ai-usage-detail');
    const btn = document.getElementById('ai-usage-toggle-btn');
    if (!detail) return;
    const show = detail.style.display === 'none';
    detail.style.display = show ? 'grid' : 'none';
    if (btn) btn.textContent = show ? 'Hide Details' : 'View Details';
}

async function refreshToolkit() {
    const [resumes, stories] = await Promise.all([
        api.getResumes(),
        api.getStories(),
    ]);
    renderResumeBank(resumes);
    renderStories(stories);
}

function renderJobs(jobs) {
    _allJobs = jobs;
    applyFiltersAndRender();
}

function getDisplayStatus(status) {
    const map = { greenlighted: 'applying', preparing: 'applying' };
    return map[status] || status || 'new';
}

function applyFiltersAndRender() {
    const tbody = document.getElementById('jobs-tbody');

    if (!_allJobs.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No jobs discovered yet. Add sources and run the scraper.</td></tr>';
        updateFilterIndicator();
        return;
    }

    // Step 1: Apply column filters
    let filtered = _allJobs.filter(job => {
        if (columnFilters.company) {
            const val = job.company || '(No company)';
            if (!columnFilters.company.has(val)) return false;
        }
        if (columnFilters.location) {
            const val = job.location || '(No location)';
            if (!columnFilters.location.has(val)) return false;
        }
        if (columnFilters.status) {
            const display = getDisplayStatus(job.status);
            if (!columnFilters.status.has(display)) return false;
        }
        if (columnFilters.date_found) {
            const df = columnFilters.date_found;
            const jobDate = job.date_found ? job.date_found.split('T')[0] : '';
            if (df.from && jobDate < df.from) return false;
            if (df.to && jobDate > df.to) return false;
        }
        return true;
    });

    // Step 2: Split active vs ignored
    const activeJobs = filtered.filter(j => j.status !== 'ignored');
    const ignoredJobs = filtered.filter(j => j.status === 'ignored');

    // Step 3: Sort
    if (jobSortColumn) {
        const dir = jobSortDir === 'asc' ? 1 : -1;
        activeJobs.sort((a, b) => {
            let va = a[jobSortColumn] || '';
            let vb = b[jobSortColumn] || '';
            if (jobSortColumn === 'status') {
                va = getDisplayStatus(va);
                vb = getDisplayStatus(vb);
            }
            if (typeof va === 'string') va = va.toLowerCase();
            if (typeof vb === 'string') vb = vb.toLowerCase();
            if (va < vb) return -1 * dir;
            if (va > vb) return 1 * dir;
            return 0;
        });
    } else {
        // Default: sort by status priority
        const order = { greenlighted: 0, preparing: 0, applied: 1, interviewing: 1, new: 2, offer: 3, rejected: 3 };
        activeJobs.sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2));
    }

    // Step 4: Render
    if (!activeJobs.length && !ignoredJobs.length) {
        const hasFilters = columnFilters.company || columnFilters.location || columnFilters.status;
        tbody.innerHTML = hasFilters
            ? '<tr><td colspan="7" class="empty-state">No jobs match current filters. <a href="#" onclick="clearAllFilters(); return false;">Clear filters</a></td></tr>'
            : '<tr><td colspan="7" class="empty-state">No jobs discovered yet. Add sources and run the scraper.</td></tr>';
        updateFilterIndicator();
        return;
    }

    let html = '';
    if (groupByCompany) {
        html = renderGroupedRows(activeJobs);
    } else {
        html = activeJobs.map(job => renderJobRow(job)).join('');
    }

    // Ignored toggle row
    if (ignoredJobs.length > 0) {
        const arrow = showIgnoredJobs ? '&#9660;' : '&#9654;';
        const verb = showIgnoredJobs ? 'Hide' : 'Show';
        html += `<tr class="ignored-toggle-row ${showIgnoredJobs ? 'ignored-toggle-open' : ''}" onclick="toggleIgnoredJobs()">
            <td colspan="7"><span class="ignored-toggle-icon">${arrow}</span> ${verb} ${ignoredJobs.length} ignored job(s)</td>
        </tr>`;
        if (showIgnoredJobs) {
            html += ignoredJobs.map(job => renderJobRow(job)).join('');
        }
    }

    tbody.innerHTML = html;
    updateFilterIndicator();
}

function renderGroupedRows(jobs) {
    const groups = new Map();
    for (const job of jobs) {
        const key = job.company || '(No company)';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(job);
    }

    const sortedKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
    let html = '';

    for (const company of sortedKeys) {
        const groupJobs = groups.get(company);
        const isCollapsed = collapsedCompanyGroups.has(company);
        const chevron = isCollapsed ? '&#9654;' : '&#9660;';

        html += `<tr class="group-header-row ${isCollapsed ? 'group-collapsed' : ''}" onclick="toggleCompanyGroup('${escapeHtml(company).replace(/'/g, "\\'")}')">
            <td colspan="7">
                <span class="group-chevron">${chevron}</span>
                <strong>${escapeHtml(company)}</strong>
                <span class="badge-count">${groupJobs.length}</span>
            </td>
        </tr>`;

        if (!isCollapsed) {
            html += groupJobs.map(job => renderJobRow(job)).join('');
        }
    }

    return html;
}

function toggleIgnoredJobs() {
    showIgnoredJobs = !showIgnoredJobs;
    applyFiltersAndRender();
}

function toggleCompanyGroup(company) {
    if (collapsedCompanyGroups.has(company)) {
        collapsedCompanyGroups.delete(company);
    } else {
        collapsedCompanyGroups.add(company);
    }
    applyFiltersAndRender();
}

function toggleGroupByCompany() {
    groupByCompany = document.getElementById('group-by-company').checked;
    collapsedCompanyGroups.clear();
    applyFiltersAndRender();
}

// =================== Column Sorting ===================

function toggleJobSort(column) {
    if (jobSortColumn === column) {
        if (jobSortDir === 'asc') {
            jobSortDir = 'desc';
        } else {
            // Third click: clear sort
            jobSortColumn = null;
            jobSortDir = 'asc';
        }
    } else {
        jobSortColumn = column;
        jobSortDir = 'asc';
    }
    // Update sort icons
    document.querySelectorAll('.sort-icon').forEach(el => {
        el.className = 'sort-icon';
        if (el.dataset.col === jobSortColumn) {
            el.classList.add(jobSortDir);
        }
    });
    applyFiltersAndRender();
}

// =================== Column Filters ===================

function toggleColumnFilter(event, columnKey) {
    event.stopPropagation();

    // Close if already open
    if (_openFilterColumn === columnKey) {
        closeColumnFilters();
        return;
    }

    closeColumnFilters();
    _openFilterColumn = columnKey;

    const btn = event.currentTarget;
    const th = btn.closest('th');

    if (columnKey === 'date_found') {
        _buildDateFilterDropdown(th);
        return;
    }

    // Build unique values from _allJobs
    const valuesSet = new Set();
    for (const job of _allJobs) {
        if (columnKey === 'company') valuesSet.add(job.company || '(No company)');
        else if (columnKey === 'location') valuesSet.add(job.location || '(No location)');
        else if (columnKey === 'status') valuesSet.add(getDisplayStatus(job.status));
    }
    const values = [...valuesSet].sort((a, b) => a.localeCompare(b));
    const activeFilter = columnFilters[columnKey];

    let dropdownHtml = `<div class="col-filter-dropdown" data-column="${columnKey}" onclick="event.stopPropagation()">`;
    if (values.length > 8) {
        dropdownHtml += `<div class="col-filter-search-wrap"><input type="text" class="input col-filter-search" placeholder="Search..." oninput="filterDropdownOptions(this)"></div>`;
    }
    dropdownHtml += `<div class="col-filter-actions">
        <button class="btn btn-ghost btn-sm" onclick="selectAllFilterOptions('${columnKey}')">All</button>
        <button class="btn btn-ghost btn-sm" onclick="clearFilterOptions('${columnKey}')">None</button>
    </div>`;
    dropdownHtml += `<div class="col-filter-options">`;
    for (const val of values) {
        const checked = !activeFilter || activeFilter.has(val) ? 'checked' : '';
        dropdownHtml += `<label class="col-filter-item">
            <input type="checkbox" value="${escapeHtml(val)}" ${checked}>
            <span>${escapeHtml(val)}</span>
        </label>`;
    }
    dropdownHtml += `</div></div>`;

    th.insertAdjacentHTML('beforeend', dropdownHtml);

    // Auto-apply on checkbox change
    const dropdown = th.querySelector('.col-filter-dropdown');
    dropdown.addEventListener('change', () => applyColumnFilterFromDropdown(columnKey, dropdown));
}

function _buildDateFilterDropdown(th) {
    const existing = columnFilters.date_found || {};
    const fromVal = existing.from || '';
    const toVal = existing.to || '';
    const preset = existing.preset || '';

    let html = `<div class="col-filter-dropdown col-filter-date-dropdown" data-column="date_found" onclick="event.stopPropagation()">
        <div class="date-filter-presets">
            <button class="btn btn-ghost btn-sm ${preset === 'today' ? 'active' : ''}" onclick="applyDatePreset('today')">Today</button>
            <button class="btn btn-ghost btn-sm ${preset === '7d' ? 'active' : ''}" onclick="applyDatePreset('7d')">7 days</button>
            <button class="btn btn-ghost btn-sm ${preset === '30d' ? 'active' : ''}" onclick="applyDatePreset('30d')">30 days</button>
            <button class="btn btn-ghost btn-sm ${preset === '90d' ? 'active' : ''}" onclick="applyDatePreset('90d')">90 days</button>
        </div>
        <div class="date-filter-range">
            <label>From<input type="date" class="input date-filter-input" id="date-filter-from" value="${fromVal}" onchange="applyDateRange()"></label>
            <label>To<input type="date" class="input date-filter-input" id="date-filter-to" value="${toVal}" onchange="applyDateRange()"></label>
        </div>
        <div class="col-filter-actions">
            <button class="btn btn-ghost btn-sm" onclick="clearDateFilter()">Clear</button>
        </div>
    </div>`;

    th.insertAdjacentHTML('beforeend', html);
}

function applyDatePreset(preset) {
    const now = new Date();
    let from;
    if (preset === 'today') {
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (preset === '7d') {
        from = new Date(now.getTime() - 7 * 86400000);
    } else if (preset === '30d') {
        from = new Date(now.getTime() - 30 * 86400000);
    } else if (preset === '90d') {
        from = new Date(now.getTime() - 90 * 86400000);
    }
    const fromStr = from.toISOString().split('T')[0];
    columnFilters.date_found = { from: fromStr, to: '', preset };

    const btn = document.querySelector('.col-filter-btn[data-column="date_found"]');
    if (btn) btn.classList.add('active');

    // Update preset button styles
    document.querySelectorAll('.date-filter-presets .btn').forEach(b => b.classList.remove('active'));
    const clicked = [...document.querySelectorAll('.date-filter-presets .btn')].find(b => b.textContent.trim().toLowerCase().replace(' ', '') === preset.replace('d', ' days').replace('today', 'today'));
    // Simpler: just re-highlight by preset
    document.querySelectorAll('.date-filter-presets .btn').forEach(b => {
        const map = { 'Today': 'today', '7 days': '7d', '30 days': '30d', '90 days': '90d' };
        if (map[b.textContent.trim()] === preset) b.classList.add('active');
    });

    // Update date inputs
    const fromInput = document.getElementById('date-filter-from');
    const toInput = document.getElementById('date-filter-to');
    if (fromInput) fromInput.value = fromStr;
    if (toInput) toInput.value = '';

    applyFiltersAndRender();
}

function applyDateRange() {
    const fromInput = document.getElementById('date-filter-from');
    const toInput = document.getElementById('date-filter-to');
    const from = fromInput ? fromInput.value : '';
    const to = toInput ? toInput.value : '';

    if (!from && !to) {
        clearDateFilter();
        return;
    }

    columnFilters.date_found = { from, to, preset: '' };
    const btn = document.querySelector('.col-filter-btn[data-column="date_found"]');
    if (btn) btn.classList.add('active');

    // Clear preset highlights
    document.querySelectorAll('.date-filter-presets .btn').forEach(b => b.classList.remove('active'));

    applyFiltersAndRender();
}

function clearDateFilter() {
    columnFilters.date_found = null;
    const btn = document.querySelector('.col-filter-btn[data-column="date_found"]');
    if (btn) btn.classList.remove('active');
    const fromInput = document.getElementById('date-filter-from');
    const toInput = document.getElementById('date-filter-to');
    if (fromInput) fromInput.value = '';
    if (toInput) toInput.value = '';
    document.querySelectorAll('.date-filter-presets .btn').forEach(b => b.classList.remove('active'));
    applyFiltersAndRender();
}

function applyColumnFilterFromDropdown(columnKey, dropdown) {
    const checkboxes = dropdown.querySelectorAll('.col-filter-options input[type="checkbox"]');
    const checked = new Set();
    let allChecked = true;
    for (const cb of checkboxes) {
        if (cb.checked) checked.add(cb.value);
        else allChecked = false;
    }

    columnFilters[columnKey] = allChecked ? null : (checked.size > 0 ? checked : new Set(['__none__']));

    // Update button active state
    const btn = dropdown.closest('th').querySelector('.col-filter-btn');
    btn.classList.toggle('active', !allChecked);

    applyFiltersAndRender();
}

function selectAllFilterOptions(columnKey) {
    const dropdown = document.querySelector(`.col-filter-dropdown[data-column="${columnKey}"]`);
    if (!dropdown) return;
    dropdown.querySelectorAll('.col-filter-options input[type="checkbox"]').forEach(cb => cb.checked = true);
    applyColumnFilterFromDropdown(columnKey, dropdown);
}

function clearFilterOptions(columnKey) {
    const dropdown = document.querySelector(`.col-filter-dropdown[data-column="${columnKey}"]`);
    if (!dropdown) return;
    dropdown.querySelectorAll('.col-filter-options input[type="checkbox"]').forEach(cb => cb.checked = false);
    applyColumnFilterFromDropdown(columnKey, dropdown);
}

function filterDropdownOptions(input) {
    const query = input.value.toLowerCase();
    const items = input.closest('.col-filter-dropdown').querySelectorAll('.col-filter-item');
    for (const item of items) {
        const text = item.querySelector('span').textContent.toLowerCase();
        item.style.display = text.includes(query) ? '' : 'none';
    }
}

function closeColumnFilters() {
    document.querySelectorAll('.col-filter-dropdown').forEach(el => el.remove());
    _openFilterColumn = null;
}

function clearAllFilters() {
    columnFilters = { company: null, location: null, status: null, date_found: null };
    document.querySelectorAll('.col-filter-btn.active').forEach(btn => btn.classList.remove('active'));
    applyFiltersAndRender();
}

function clearSingleFilter(columnKey) {
    columnFilters[columnKey] = null;
    const th = document.querySelector(`.filterable-th .col-filter-btn[data-column="${columnKey}"]`);
    if (th) th.classList.remove('active');
    applyFiltersAndRender();
}

function updateFilterIndicator() {
    const bar = document.getElementById('filter-indicator-bar');
    if (!bar) return;
    const active = [];
    if (columnFilters.company) active.push({ key: 'company', label: 'Company', count: columnFilters.company.size });
    if (columnFilters.location) active.push({ key: 'location', label: 'Location', count: columnFilters.location.size });
    if (columnFilters.status) active.push({ key: 'status', label: 'Status', count: columnFilters.status.size });
    if (columnFilters.date_found) {
        const df = columnFilters.date_found;
        const label = df.preset ? { today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days' }[df.preset] || 'Date' : 'Date range';
        active.push({ key: 'date_found', label });
    }

    if (!active.length) {
        bar.style.display = 'none';
        return;
    }

    bar.style.display = 'flex';
    bar.innerHTML = active.map(f =>
        `<span class="filter-chip-active">${f.label}${f.count != null ? ` (${f.count})` : ''} <button onclick="clearSingleFilter('${f.key}')">&times;</button></span>`
    ).join('') + `<button class="btn btn-ghost btn-sm" onclick="clearAllFilters()">Clear all</button>`;
}

// Close filter dropdown on outside click / Escape
document.addEventListener('click', (e) => {
    if (_openFilterColumn && !e.target.closest('.col-filter-dropdown') && !e.target.closest('.col-filter-btn')) {
        closeColumnFilters();
    }
    if (_openStoryFilterColumn && !e.target.closest('.story-filter-dropdown') && !e.target.closest('.col-filter-btn')) {
        closeStoryFilters();
    }
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _openFilterColumn) closeColumnFilters();
});

function renderJobRow(job) {
    const d = parseUTC(job.date_found);
    const date = d ? d.toLocaleDateString() : '';
    const salary = job.salary || '-';
    const location = job.location || '-';
    const status = job.status || 'new';

    // Map internal statuses to display labels
    const displayStatusMap = {
        greenlighted: 'applying',
        preparing: 'applying',
    };
    const displayStatus = displayStatusMap[status] || status;
    const badgeClass = displayStatusMap[status] ? 'applying' : status;

    let actionsHtml = '';

    if (status === 'ignored') {
        actionsHtml = `
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); handleUnignore(${job.id})" title="Restore">&larr;</button>
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); openJobCard(${job.id})" title="View JD">View JD</button>
        `;
    } else {
        // Ignore (any non-ignored job)
        actionsHtml += `<button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); handleIgnore(${job.id})" title="Ignore">&times;</button>`;
        // View JD
        actionsHtml += `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); openJobCard(${job.id})" title="View JD">View JD</button>`;
    }

    const rowClass = status === 'ignored' ? 'row-ignored' :
        (status === 'greenlighted' || status === 'preparing') ? 'row-active' :
        (status === 'applied' || status === 'interviewing') ? 'row-active' : '';

    return `<tr class="${rowClass} job-row-clickable" data-job-id="${job.id}" onclick="expandJobView(${job.id})">
        <td><strong>${escapeHtml(job.title || 'Untitled')}</strong></td>
        <td>${escapeHtml(job.company || '-')}</td>
        <td>${escapeHtml(location)}</td>
        <td>${escapeHtml(salary)}</td>
        <td>${date}</td>
        <td><select class="status-select status-${badgeClass}" onclick="event.stopPropagation()" onmousedown="event.stopPropagation()" onchange="event.stopPropagation(); quickStatusChange(${job.id}, this)" data-current="${status}">
            <option value="new"${status === 'new' ? ' selected' : ''}>new</option>
            <option value="applying"${(status === 'greenlighted' || status === 'preparing') ? ' selected' : ''}>applying</option>
            <option value="applied"${status === 'applied' ? ' selected' : ''}>applied</option>
            <option value="interviewing"${status === 'interviewing' ? ' selected' : ''}>interviewing</option>
            <option value="offer"${status === 'offer' ? ' selected' : ''}>offer</option>
            <option value="rejected"${status === 'rejected' ? ' selected' : ''}>rejected</option>
            <option value="ignored"${status === 'ignored' ? ' selected' : ''}>ignored</option>
        </select></td>
        <td class="actions-cell">${actionsHtml}</td>
    </tr>`;
}

// =================== Job Actions ===================

async function handleIgnore(jobId) {
    await api.updateJobStatus(jobId, 'ignored');
    showToast('Job ignored', 'success');
    refreshDiscovery();
}

async function handleUnignore(jobId) {
    await api.updateJobStatus(jobId, 'new');
    showToast('Job restored', 'success');
    refreshDiscovery();
}

async function quickStatusChange(jobId, selectEl) {
    const newStatus = selectEl.value;
    const statusActions = {
        'new': () => api.updateJobStatus(jobId, 'new'),
        'applying': () => api.updateJobStatus(jobId, 'greenlighted'),
        'applied': () => api.updateJobStatus(jobId, 'applied'),
        'interviewing': () => api.updateJobStatus(jobId, 'interviewing'),
        'offer': () => api.setJobOutcome(jobId, 'offer', null, ''),
        'rejected': () => api.setJobOutcome(jobId, 'rejected', 'application', ''),
        'ignored': () => api.updateJobStatus(jobId, 'ignored'),
    };
    if (statusActions[newStatus]) {
        await statusActions[newStatus]();
        await logSystemEvent(jobId, `Status changed to ${newStatus}`);
        showToast(`Status → ${newStatus}`, 'success');
        refreshDiscovery();
    }
}

async function handleReject(jobId, stage) {
    await api.setJobOutcome(jobId, 'rejected', stage, '');
    showToast('Rejection recorded', 'success');
    refreshDiscovery();
}

// =================== Job Card (Discovery Quick View) ===================

async function openJobCard(jobId) {
    // Find job data
    const jobs = await api.getJobs();
    const job = jobs.find(j => j.id === jobId);
    if (!job) { showToast('Job not found', 'error'); return; }

    // Remove any existing card
    const existing = document.getElementById('job-quick-card');
    if (existing) existing.remove();

    const status = job.status || 'new';
    const displayStatusMap = { greenlighted: 'applying', preparing: 'applying' };
    const displayStatus = displayStatusMap[status] || status;
    const badgeClass = displayStatusMap[status] ? 'applying' : status;

    const card = document.createElement('div');
    card.id = 'job-quick-card';
    card.className = 'job-quick-card-overlay';
    card.innerHTML = `
        <div class="job-quick-card">
            <div class="job-quick-card-header">
                <div>
                    <h2>${escapeHtml(job.title || 'Untitled')}</h2>
                    <p class="job-quick-card-meta">
                        <span>${escapeHtml(job.company || '')}</span>
                        ${job.location ? `<span>&middot; ${escapeHtml(job.location)}</span>` : ''}
                        ${job.salary ? `<span>&middot; ${escapeHtml(job.salary)}</span>` : ''}
                    </p>
                </div>
                <div class="job-quick-card-actions-top">
                    <span class="status-badge status-${badgeClass}">${displayStatus}</span>
                    <button class="btn btn-ghost btn-sm" onclick="closeJobCard()" title="Close">&times;</button>
                </div>
            </div>
            <div class="job-quick-card-body" id="job-quick-card-body">
                <div class="empty-state">Loading job description...</div>
            </div>
            <div class="job-quick-card-footer">
                ${status === 'new' ? `<button class="btn btn-danger btn-sm" onclick="handleIgnoreFromCard(${job.id})">Ignore</button>` : ''}
                ${status === 'ignored' ? `<button class="btn btn-ghost btn-sm" onclick="handleRestoreFromCard(${job.id})">Restore</button>` : ''}
                <button class="btn btn-ghost btn-sm" onclick="closeJobCard(); expandJobView(${job.id})">Prep &rarr;</button>
                <a href="${escapeHtml(job.job_url)}" target="_blank" rel="noopener" class="btn btn-primary btn-sm">Open Posting &rarr;</a>
            </div>
        </div>
    `;
    document.body.appendChild(card);

    // Animate in
    requestAnimationFrame(() => card.classList.add('visible'));

    // Close on backdrop click
    card.addEventListener('click', (e) => {
        if (e.target === card) closeJobCard();
    });

    // Close on Escape
    const escHandler = (e) => { if (e.key === 'Escape') { closeJobCard(); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);

    // Fetch JD
    const data = await api.getJobDescription(jobId);
    const desc = data.description || '';
    const body = document.getElementById('job-quick-card-body');
    if (!body) return;
    if (!desc) {
        body.innerHTML = `<div class="empty-state">
            <p>No job description available.</p>
            <div style="display:flex;gap:0.5rem;margin-top:0.75rem;justify-content:center;">
                <button class="btn btn-primary btn-sm" onclick="rescrapeFromCard(${jobId})">Rescrape</button>
                <button class="btn btn-ghost btn-sm" onclick="editJDFromCard(${jobId})">Paste JD</button>
            </div>
        </div>`;
    } else {
        let rendered;
        if (desc.trim().startsWith('<')) {
            rendered = desc;
        } else if (desc.includes('# ') || desc.includes('**') || desc.includes('- ')) {
            rendered = marked.parse(desc);
        } else {
            rendered = desc.split('\n\n').map(p => `<p>${escapeHtml(p)}</p>`).join('');
        }
        body.innerHTML = `<div class="jd-rendered">${rendered}</div>
            <div class="jd-edit-bar">
                <button class="btn btn-ghost btn-sm" onclick="editJDFromCard(${jobId})">Edit JD</button>
                <button class="btn btn-ghost btn-sm" onclick="rescrapeFromCard(${jobId})">Rescrape</button>
            </div>`;
    }
}

async function rescrapeFromCard(jobId) {
    const body = document.getElementById('job-quick-card-body');
    if (!body) return;
    body.innerHTML = '<div class="empty-state">Rescraping...</div>';

    const _updateBody = (html) => {
        const el = document.getElementById('job-quick-card-body');
        if (el) el.innerHTML = html;
    };

    try {
        const { status, data } = await api.rescrapeJob(jobId);
        if (status === 200 && data.updated && data.updated.length) {
            showToast(`Updated: ${data.updated.join(', ')}`, 'success');
            delete _jdCache[jobId];
            if (data.updated.includes('description') && data.description) {
                const html = data.description.includes('# ') || data.description.includes('**')
                    ? marked.parse(data.description)
                    : data.description.split('\n\n').map(p => `<p>${escapeHtml(p)}</p>`).join('');
                _updateBody(`<div class="jd-rendered">${html}</div>
                    <div class="jd-edit-bar">
                        <button class="btn btn-ghost btn-sm" onclick="editJDFromCard(${jobId})">Edit JD</button>
                        <button class="btn btn-ghost btn-sm" onclick="rescrapeFromCard(${jobId})">Rescrape</button>
                    </div>`);
            } else {
                openJobCard(jobId);
            }
        } else {
            const errMsg = data.error || 'No new data found. Try pasting the JD manually.';
            showToast(errMsg, 'warning');
            _updateBody(`<div class="empty-state">
                <p>${escapeHtml(errMsg)}</p>
                <div style="display:flex;gap:0.5rem;margin-top:0.75rem;justify-content:center;">
                    <button class="btn btn-primary btn-sm" onclick="editJDFromCard(${jobId})">Paste JD</button>
                    <button class="btn btn-ghost btn-sm" onclick="rescrapeFromCard(${jobId})">Retry</button>
                </div>
            </div>`);
        }
    } catch (e) {
        showToast('Rescrape failed: ' + e.message, 'error');
        _updateBody(`<div class="empty-state">
            <p>Rescrape failed. Try pasting the JD manually.</p>
            <div style="display:flex;gap:0.5rem;margin-top:0.75rem;justify-content:center;">
                <button class="btn btn-primary btn-sm" onclick="editJDFromCard(${jobId})">Paste JD</button>
                <button class="btn btn-ghost btn-sm" onclick="rescrapeFromCard(${jobId})">Retry</button>
            </div>
        </div>`);
    }
}

function editJDFromCard(jobId) {
    const body = document.getElementById('job-quick-card-body');
    if (!body) return;

    // Get existing text if any
    const existing = body.querySelector('.jd-rendered');
    const existingText = existing ? existing.innerText : '';

    body.innerHTML = `<div class="jd-edit-container">
        <textarea id="jd-edit-textarea" class="input jd-edit-textarea" placeholder="Paste job description here...">${escapeHtml(existingText)}</textarea>
        <div class="jd-edit-actions">
            <button class="btn btn-primary btn-sm" onclick="saveJDFromCard(${jobId})">Save</button>
            <button class="btn btn-ghost btn-sm" onclick="openJobCard(${jobId})">Cancel</button>
        </div>
    </div>`;

    document.getElementById('jd-edit-textarea').focus();
}

async function saveJDFromCard(jobId) {
    const textarea = document.getElementById('jd-edit-textarea');
    if (!textarea) return;
    const description = textarea.value.trim();
    if (!description) {
        showToast('Description cannot be empty', 'error');
        return;
    }
    try {
        await api.updateJobDescription(jobId, description);
        delete _jdCache[jobId];
        showToast('Job description saved', 'success');
        openJobCard(jobId);
    } catch (e) {
        showToast('Failed to save: ' + e.message, 'error');
    }
}

function closeJobCard() {
    const card = document.getElementById('job-quick-card');
    if (!card) return;
    card.classList.remove('visible');
    setTimeout(() => card.remove(), 250);
}

// =================== RESUME QUICK-VIEW ===================

async function openResumeCard(resumeId, resumeName) {
    const existing = document.getElementById('resume-quick-card');
    if (existing) existing.remove();

    const card = document.createElement('div');
    card.id = 'resume-quick-card';
    card.className = 'job-quick-card-overlay';
    card.innerHTML = `
        <div class="job-quick-card" style="max-width: min(800px, 92vw);">
            <div class="job-quick-card-header">
                <div>
                    <h2>${escapeHtml(resumeName)}</h2>
                    <p class="job-quick-card-meta"><span>Resume</span></p>
                </div>
                <div class="job-quick-card-actions-top">
                    <button class="btn btn-ghost btn-sm" onclick="closeResumeCard()" title="Close">&times;</button>
                </div>
            </div>
            <div class="job-quick-card-body" id="resume-quick-card-body">
                <div class="empty-state">Loading resume...</div>
            </div>
        </div>
    `;
    document.body.appendChild(card);
    requestAnimationFrame(() => card.classList.add('visible'));

    card.addEventListener('click', (e) => {
        if (e.target === card) closeResumeCard();
    });
    const escHandler = (e) => { if (e.key === 'Escape') { closeResumeCard(); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);

    // Fetch resume data
    try {
        const data = await api.getResume(resumeId);
        const body = document.getElementById('resume-quick-card-body');
        if (!body) return;

        const resume = data.resume || {};
        const sections = data.sections || [];

        if (sections.length) {
            body.innerHTML = sections.map(s => {
                const heading = s.heading || s.company_name || s.role_title || '';
                const content = s.content_html || s.content || '';
                return `
                    <div class="resume-section-block">
                        ${heading ? `<h3 class="resume-section-heading">${escapeHtml(heading)}</h3>` : ''}
                        <div class="resume-section-content">${content}</div>
                    </div>
                `;
            }).join('');
        } else if (resume.content_html) {
            body.innerHTML = resume.content_html;
        } else {
            body.innerHTML = '<div class="empty-state">No resume content available.</div>';
        }
    } catch (err) {
        const body = document.getElementById('resume-quick-card-body');
        if (body) body.innerHTML = '<div class="empty-state">Failed to load resume.</div>';
    }
}

function closeResumeCard() {
    const card = document.getElementById('resume-quick-card');
    if (!card) return;
    card.classList.remove('visible');
    setTimeout(() => card.remove(), 250);
}

async function handleIgnoreFromCard(jobId) {
    await api.updateJobStatus(jobId, 'ignored');
    showToast('Job ignored', 'success');
    closeJobCard();
    refreshDiscovery();
}

async function handleRestoreFromCard(jobId) {
    await api.updateJobStatus(jobId, 'new');
    showToast('Job restored', 'success');
    closeJobCard();
    refreshDiscovery();
}

// =================== Import Job Modal ===================

function showImportJobModal() {
    const overlay = document.getElementById('import-job-overlay');
    overlay.style.display = 'flex';
    requestAnimationFrame(() => overlay.classList.add('visible'));

    // Close on backdrop click
    overlay.onclick = (e) => { if (e.target === overlay) closeImportJobModal(); };

    // Close on Escape
    const escHandler = (e) => {
        if (e.key === 'Escape') { closeImportJobModal(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);

    // Reset to paste tab
    switchImportTab('paste');
}

function closeImportJobModal() {
    const overlay = document.getElementById('import-job-overlay');
    overlay.classList.remove('visible');
    setTimeout(() => { overlay.style.display = 'none'; }, 250);

    // Clear paste form
    ['import-title', 'import-company', 'import-location', 'import-salary', 'import-url', 'import-description'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });

    // Clear scrape URLs tab
    const scrapeInput = document.getElementById('scrape-urls-input');
    if (scrapeInput) scrapeInput.value = '';
    const scrapeResults = document.getElementById('scrape-urls-results');
    if (scrapeResults) { scrapeResults.style.display = 'none'; scrapeResults.innerHTML = ''; }
    const scrapeBtn = document.getElementById('scrape-urls-btn');
    if (scrapeBtn) { scrapeBtn.textContent = 'Scrape All'; scrapeBtn.onclick = handleScrapeUrls; }
}

function switchImportTab(tabName) {
    document.querySelectorAll('.import-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.importTab === tabName);
    });
    document.querySelectorAll('.import-tab-content').forEach(panel => {
        const id = panel.id.replace('import-tab-', '');
        panel.style.display = id === tabName ? '' : 'none';
        if (id === tabName) panel.classList.add('active');
        else panel.classList.remove('active');
    });

    if (tabName === 'obsidian') loadObsidianFiles();
}

async function handleImportJob() {
    const title = document.getElementById('import-title').value.trim();
    const company = document.getElementById('import-company').value.trim();
    const location = document.getElementById('import-location').value.trim();
    const salary = document.getElementById('import-salary').value.trim();
    const job_url = document.getElementById('import-url').value.trim();
    const description = document.getElementById('import-description').value.trim();

    if (!title) { showToast('Title is required', 'error'); return; }
    if (!description) { showToast('Description is required', 'error'); return; }

    const result = await api.importJob({ title, company, location, salary, job_url, description });
    if (result.error) {
        showToast(result.error, 'error');
        return;
    }

    showToast('Job imported successfully', 'success');
    closeImportJobModal();
    refreshDiscovery();
}

// --- Obsidian file browser ---

let _obsidianFilesCache = null;

async function loadObsidianFiles() {
    const listEl = document.getElementById('obsidian-file-list');
    const previewEl = document.getElementById('obsidian-preview');
    previewEl.style.display = 'none';
    listEl.style.display = '';

    if (_obsidianFilesCache) {
        renderObsidianFiles(_obsidianFilesCache);
        return;
    }

    listEl.innerHTML = '<div class="empty-state">Loading Obsidian files...</div>';
    const data = await api.getObsidianFiles();

    if (data.error) {
        listEl.innerHTML = `<div class="empty-state">${escapeHtml(data.error)}</div>`;
        return;
    }

    _obsidianFilesCache = data.files || [];
    renderObsidianFiles(_obsidianFilesCache);
}

function renderObsidianFiles(files) {
    const listEl = document.getElementById('obsidian-file-list');

    if (!files.length) {
        listEl.innerHTML = '<div class="empty-state">No markdown files found in Obsidian careers directory.</div>';
        return;
    }

    // Group by company
    const groups = {};
    for (const f of files) {
        if (!groups[f.company]) groups[f.company] = [];
        groups[f.company].push(f);
    }

    let html = '';
    for (const company of Object.keys(groups).sort()) {
        html += `<div class="obsidian-company-group">`;
        html += `<div class="obsidian-company-label">${escapeHtml(company)}</div>`;
        for (const f of groups[company]) {
            html += `<div class="obsidian-file-item" onclick="previewObsidianFile('${escapeHtml(f.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'"))}')">
                <span class="obsidian-file-icon">&#9679;</span>
                <span>${escapeHtml(f.title)}</span>
            </div>`;
        }
        html += `</div>`;
    }

    listEl.innerHTML = html;
}

async function previewObsidianFile(filePath) {
    const listEl = document.getElementById('obsidian-file-list');
    const previewEl = document.getElementById('obsidian-preview');

    listEl.style.display = 'none';
    previewEl.style.display = '';

    // Show loading
    document.getElementById('obsidian-preview-title').textContent = 'Loading...';
    document.getElementById('obsidian-import-description').value = '';

    const data = await api.readObsidianFile(filePath);
    if (data.error) {
        showToast(data.error, 'error');
        hideObsidianPreview();
        return;
    }

    document.getElementById('obsidian-preview-title').textContent = data.title || 'Untitled';
    document.getElementById('obsidian-import-title').value = data.title || '';
    document.getElementById('obsidian-import-company').value = data.company || '';
    document.getElementById('obsidian-import-location').value = '';
    document.getElementById('obsidian-import-url').value = data.source_url || '';
    document.getElementById('obsidian-import-description').value = data.description || '';
}

function hideObsidianPreview() {
    document.getElementById('obsidian-file-list').style.display = '';
    document.getElementById('obsidian-preview').style.display = 'none';
}

async function handleImportFromObsidian() {
    const title = document.getElementById('obsidian-import-title').value.trim();
    const company = document.getElementById('obsidian-import-company').value.trim();
    const location = document.getElementById('obsidian-import-location').value.trim();
    const job_url = document.getElementById('obsidian-import-url').value.trim();
    const description = document.getElementById('obsidian-import-description').value.trim();

    if (!title) { showToast('Title is required', 'error'); return; }
    if (!description) { showToast('Description is required', 'error'); return; }

    const result = await api.importJob({ title, company, location, job_url, description });
    if (result.error) {
        showToast(result.error, 'error');
        return;
    }

    showToast('Job imported from Obsidian', 'success');
    closeImportJobModal();
    refreshDiscovery();
}

async function handleScrapeUrls() {
    const textarea = document.getElementById('scrape-urls-input');
    const resultsDiv = document.getElementById('scrape-urls-results');
    const btn = document.getElementById('scrape-urls-btn');
    const rawText = textarea.value.trim();

    if (!rawText) { showToast('Paste at least one URL', 'error'); return; }

    const urls = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (urls.length === 0) { showToast('No valid URLs found', 'error'); return; }
    if (urls.length > 20) { showToast('Maximum 20 URLs per batch', 'error'); return; }

    btn.disabled = true;
    btn.textContent = `Scraping ${urls.length} URL(s)...`;
    resultsDiv.style.display = '';
    resultsDiv.innerHTML = `<div class="scrape-progress">Scraping ${urls.length} URL(s)... This may take a minute.</div>`;

    try {
        const data = await api.scrapeUrls(urls);

        if (data.error) {
            showToast(data.error, 'error');
            resultsDiv.innerHTML = `<div class="scrape-progress error">${escapeHtml(data.error)}</div>`;
            return;
        }

        const s = data.summary;
        let html = `<div class="scrape-summary">`;
        html += `<span class="scrape-stat saved">${s.saved} saved</span>`;
        if (s.duplicates > 0) html += `<span class="scrape-stat dupe">${s.duplicates} duplicate(s)</span>`;
        if (s.errors > 0) html += `<span class="scrape-stat error">${s.errors} error(s)</span>`;
        html += `</div><div class="scrape-result-list">`;

        for (const r of data.results) {
            const icon = r.status === 'saved' ? '&#10003;' : r.status === 'duplicate' ? '&#8212;' : '&#10007;';
            const label = r.status === 'saved'
                ? `${escapeHtml(r.title || 'Untitled')} at ${escapeHtml(r.company || '?')}`
                : r.status === 'duplicate'
                ? `Already exists${r.title ? ': ' + escapeHtml(r.title) : ''}`
                : escapeHtml(r.error || 'Unknown error');
            const urlShort = r.url.length > 60 ? r.url.substring(0, 57) + '...' : r.url;
            const clickable = r.status === 'saved' && r.job_id ? `onclick="closeImportJobModal(); expandJobView(${r.job_id})" style="cursor:pointer"` : '';
            html += `<div class="scrape-result-item ${r.status}" ${clickable}>
                <span class="scrape-result-icon">${icon}</span>
                <div class="scrape-result-detail">
                    <div class="scrape-result-label">${label}</div>
                    <div class="scrape-result-url">${escapeHtml(urlShort)}</div>
                </div>
            </div>`;
        }
        html += `</div>`;
        resultsDiv.innerHTML = html;

        if (s.saved > 0) {
            showToast(`${s.saved} job(s) scraped and saved`, 'success');
            refreshDiscovery();
        }

        // Switch button to "Done" — closes modal
        btn.textContent = 'Done';
        btn.onclick = () => closeImportJobModal();
    } catch (err) {
        showToast('Scrape failed: ' + err.message, 'error');
        resultsDiv.innerHTML = `<div class="scrape-progress error">Request failed: ${escapeHtml(err.message)}</div>`;
    } finally {
        btn.disabled = false;
        if (btn.textContent === `Scraping ${urls.length} URL(s)...`) {
            btn.textContent = 'Scrape All';
        }
    }
}

// =================== Expanded Job Overlay ===================

async function expandJobView(jobId) {
    expandedJobId = jobId;
    expandedJobPhase = 'resume';

    // Fetch job data
    const jobs = await api.getJobs();
    expandedJobData = jobs.find(j => j.id === jobId);
    if (!expandedJobData) {
        showToast('Job not found', 'error');
        return;
    }

    // If job has no status, set to 'new'
    if (!expandedJobData.status) {
        await api.updateJobStatus(jobId, 'new');
        expandedJobData.status = 'new';
    }

    // Populate header
    document.getElementById('expanded-job-title').textContent = expandedJobData.title || 'Untitled';
    document.getElementById('expanded-job-company').textContent = expandedJobData.company || '(company)';
    document.getElementById('expanded-job-location').textContent = expandedJobData.location || '';
    document.getElementById('expanded-job-salary').textContent = expandedJobData.salary || '';

    // Set status dropdown
    const statusSelect = document.getElementById('expanded-status-select');
    const statusMap = {
        'new': 'new',
        'greenlighted': 'applying', 'preparing': 'applying',
        'applied': 'applied', 'interviewing': 'interviewing',
        'offer': 'offer', 'rejected': 'rejected',
        'ignored': 'ignored'
    };
    statusSelect.value = statusMap[expandedJobData.status] || 'new';

    // Show overlay with animation
    const overlay = document.getElementById('job-expanded-overlay');
    overlay.style.display = 'flex';
    requestAnimationFrame(() => overlay.classList.add('visible'));

    // Set phase nav to resume
    document.querySelectorAll('.phase-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.phase === 'resume');
    });
    document.getElementById('expanded-resume-view').style.display = 'block';
    document.getElementById('expanded-interview-view').style.display = 'none';

    // Reset activity sidebar
    _sidebarOpen = false;
    const sidebar = document.getElementById('activity-sidebar');
    sidebar.classList.remove('open');
    sidebar.style.width = '';
    sidebar.style.minWidth = '';
    const actPullTab = document.getElementById('sidebar-pull-tab');
    if (actPullTab) {
        actPullTab.classList.remove('open');
        const lbl = actPullTab.querySelector('.edge-label');
        if (lbl) lbl.textContent = 'Activity';
    }

    // Load resume phase
    await loadExpandedResumePhase(jobId);
}

function collapseJobView() {
    // Flush and destroy editors
    if (window.resumeEditor) {
        window.resumeEditor.destroyEditors();
    }

    expandedJobId = null;
    expandedJobData = null;
    expandedJobPhase = 'resume';
    currentAppId = null;
    currentInterviewJobId = null;
    _jdPanelVisible = false;

    // Reset JD panel
    const jdPanel = document.getElementById('jd-panel');
    if (jdPanel) { jdPanel.style.display = 'none'; jdPanel.style.flex = ''; }
    const jdHandle = document.getElementById('jd-resize-handle');
    if (jdHandle) jdHandle.style.display = 'none';
    document.querySelector('.expanded-container')?.classList.remove('jd-visible');
    const jdEdge = document.getElementById('jd-edge-handle');
    if (jdEdge) {
        jdEdge.classList.remove('open');
        const lbl = jdEdge.querySelector('.jd-edge-label');
        if (lbl) lbl.textContent = 'Show JD';
    }

    // Animate out
    const overlay = document.getElementById('job-expanded-overlay');
    overlay.classList.remove('visible');

    // Wait for animation, then hide
    setTimeout(() => {
        overlay.style.display = 'none';
        // Clean up DOM content
        document.getElementById('resume-sections-container').innerHTML = '';
        document.getElementById('ai-feedback-panel').innerHTML = '';
    }, 300);

    // Refresh active tab
    const activeTab = document.querySelector('.tab-btn.active');
    if (activeTab) {
        const tabName = activeTab.dataset.tab;
        if (tabName === 'discovery') refreshDiscovery();
        else if (tabName === 'board') refreshBoard();
    }
}

function editJobField(el, field) {
    // Already editing
    if (el.querySelector('input')) return;

    const current = el.textContent.trim();
    const isPlaceholder = current === '(company)';
    const inputVal = isPlaceholder ? '' : current;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'editable-field-input';
    input.value = inputVal;
    input.style.fontSize = getComputedStyle(el).fontSize;
    input.style.width = Math.max(120, el.offsetWidth + 20) + 'px';

    el.textContent = '';
    el.appendChild(input);
    input.focus();
    input.select();

    const save = async () => {
        const newVal = input.value.trim();
        el.textContent = newVal || (field === 'company' ? '(company)' : '');

        if (newVal !== inputVal && expandedJobId) {
            await api.updateJobFields(expandedJobId, { [field]: newVal });
            if (expandedJobData) expandedJobData[field] = newVal;
            showToast(`${field.charAt(0).toUpperCase() + field.slice(1)} updated`, 'success');
        }
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') {
            el.textContent = isPlaceholder ? '(company)' : current;
        }
    });
}

async function switchJobPhase(phase) {
    if (phase === expandedJobPhase) return;

    // Leaving resume phase: destroy editors
    if (expandedJobPhase === 'resume' && window.resumeEditor) {
        window.resumeEditor.destroyEditors();
    }

    expandedJobPhase = phase;

    // Update phase nav buttons
    document.querySelectorAll('.phase-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.phase === phase);
    });

    // Hide all phase views
    document.getElementById('expanded-resume-view').style.display = 'none';
    document.getElementById('expanded-interview-view').style.display = 'none';

    if (phase === 'resume') {
        document.getElementById('expanded-resume-view').style.display = 'block';
        await loadExpandedResumePhase(expandedJobId);
    } else if (phase === 'interview') {
        document.getElementById('expanded-interview-view').style.display = 'block';
        await loadExpandedInterviewPhase(expandedJobId);
    }
}

async function toggleJDPanel() {
    _jdPanelVisible = !_jdPanelVisible;
    const container = document.querySelector('.expanded-container');
    const panel = document.getElementById('jd-panel');
    const resizeHandle = document.getElementById('jd-resize-handle');
    const edgeHandle = document.getElementById('jd-edge-handle');

    const edgeLabel = edgeHandle && edgeHandle.querySelector('.jd-edge-label');

    if (_jdPanelVisible) {
        container.classList.add('jd-visible');
        panel.style.display = '';
        const savedWidth = localStorage.getItem('jdPanelWidth');
        if (savedWidth) panel.style.width = savedWidth + 'px';
        if (resizeHandle) resizeHandle.style.display = '';
        if (edgeHandle) edgeHandle.classList.add('open');
        if (edgeLabel) edgeLabel.textContent = 'Hide JD';

        // Fetch and render JD
        const jdContent = document.getElementById('jd-panel-content');
        if (jdContent && expandedJobId) {
            if (_jdCache[expandedJobId]) {
                jdContent.innerHTML = _jdCache[expandedJobId];
            } else {
                jdContent.innerHTML = '<div class="empty-state">Loading job description...</div>';
                const data = await api.getJobDescription(expandedJobId);
                const desc = data.description || '';
                if (!desc) {
                    _jdCache[expandedJobId] = '<div class="empty-state">No job description available.</div>';
                } else if (desc.trim().startsWith('<')) {
                    _jdCache[expandedJobId] = desc;
                } else if (desc.includes('# ') || desc.includes('**') || desc.includes('- ')) {
                    _jdCache[expandedJobId] = marked.parse(desc);
                } else {
                    _jdCache[expandedJobId] = desc.split('\n\n').map(p => `<p>${escapeHtml(p)}</p>`).join('');
                }
                jdContent.innerHTML = _jdCache[expandedJobId];
            }
        }
    } else {
        container.classList.remove('jd-visible');
        panel.style.display = 'none';
        if (resizeHandle) resizeHandle.style.display = 'none';
        if (edgeHandle) edgeHandle.classList.remove('open');
        if (edgeLabel) edgeLabel.textContent = 'Show JD';
    }
}

async function shareJDLink() {
    const url = expandedJobData && expandedJobData.job_url;
    if (!url) {
        showToast('No job URL available for this listing', 'error');
        return;
    }
    try {
        await navigator.clipboard.writeText(url);
        showToast('Job link copied to clipboard', 'success');
    } catch (e) {
        showToast('Failed to copy job link', 'error');
    }
}

async function reformatJD() {
    if (!expandedJobId) return;

    const btn = document.getElementById('btn-reformat-jd');
    const jdContent = document.getElementById('jd-panel-content');
    const origBtnText = btn.textContent;

    btn.disabled = true;
    btn.textContent = 'Reformatting...';

    try {
        const { status, data } = await api.reformatJD(expandedJobId);
        if (status !== 200 || data.error) {
            showToast(data.error || 'Reformat failed', 'error');
            return;
        }

        // Render the reformatted markdown
        const html = marked.parse(data.description);
        jdContent.innerHTML = html;
        _jdCache[expandedJobId] = html;
        showToast('JD reformatted and saved', 'success');
    } catch (e) {
        showToast('Reformat failed: ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = origBtnText;
    }
}

function editJDInPanel() {
    if (!expandedJobId) return;
    const jdContent = document.getElementById('jd-panel-content');
    if (!jdContent) return;

    const existingText = jdContent.innerText || '';

    jdContent.innerHTML = `<div class="jd-edit-container">
        <textarea id="jd-panel-edit-textarea" class="input jd-edit-textarea" placeholder="Paste job description here...">${escapeHtml(existingText)}</textarea>
        <div class="jd-edit-actions">
            <button class="btn btn-primary btn-sm" onclick="saveJDInPanel()">Save</button>
            <button class="btn btn-ghost btn-sm" onclick="cancelJDPanelEdit()">Cancel</button>
        </div>
    </div>`;

    document.getElementById('jd-panel-edit-textarea').focus();
}

async function saveJDInPanel() {
    if (!expandedJobId) return;
    const textarea = document.getElementById('jd-panel-edit-textarea');
    if (!textarea) return;
    const description = textarea.value.trim();
    if (!description) {
        showToast('Description cannot be empty', 'error');
        return;
    }
    try {
        await api.updateJobDescription(expandedJobId, description);
        delete _jdCache[expandedJobId];
        showToast('Job description saved', 'success');
        // Re-render the panel
        const html = description.includes('# ') || description.includes('**')
            ? marked.parse(description)
            : description.split('\n\n').map(p => `<p>${escapeHtml(p)}</p>`).join('');
        const jdContent = document.getElementById('jd-panel-content');
        jdContent.innerHTML = html;
        _jdCache[expandedJobId] = html;
    } catch (e) {
        showToast('Failed to save: ' + e.message, 'error');
    }
}

function cancelJDPanelEdit() {
    if (!expandedJobId) return;
    // Re-render from cache or refetch
    const jdContent = document.getElementById('jd-panel-content');
    if (_jdCache[expandedJobId]) {
        jdContent.innerHTML = _jdCache[expandedJobId];
    } else {
        // Force re-toggle to refetch
        _jdPanelVisible = false;
        toggleJDPanel();
    }
}

async function rescrapeInPanel() {
    if (!expandedJobId) return;
    const jdContent = document.getElementById('jd-panel-content');
    if (!jdContent) return;

    jdContent.innerHTML = '<div class="empty-state">Rescraping...</div>';

    try {
        const { status, data } = await api.rescrapeJob(expandedJobId);
        if (status === 200 && data.updated && data.updated.length) {
            showToast(`Updated: ${data.updated.join(', ')}`, 'success');
            delete _jdCache[expandedJobId];
            if (data.description) {
                const html = data.description.includes('# ') || data.description.includes('**')
                    ? marked.parse(data.description)
                    : data.description.split('\n\n').map(p => `<p>${escapeHtml(p)}</p>`).join('');
                jdContent.innerHTML = html;
                _jdCache[expandedJobId] = html;
            } else {
                _jdPanelVisible = false;
                toggleJDPanel();
            }
        } else {
            const errMsg = data.error || 'No new data found.';
            showToast(errMsg, 'warning');
            jdContent.innerHTML = `<div class="empty-state">
                <p>${escapeHtml(errMsg)}</p>
                <button class="btn btn-ghost btn-sm" style="margin-top:0.5rem" onclick="editJDInPanel()">Paste JD manually</button>
            </div>`;
        }
    } catch (e) {
        showToast('Rescrape failed: ' + e.message, 'error');
        jdContent.innerHTML = `<div class="empty-state">
            <p>Rescrape failed. Try pasting the JD manually.</p>
            <button class="btn btn-primary btn-sm" style="margin-top:0.5rem" onclick="editJDInPanel()">Paste JD</button>
        </div>`;
    }
}

async function handleExpandedStatusChange(newStatus) {
    if (!expandedJobId) return;

    // Map dropdown values to actual statuses
    const statusActions = {
        'new': async () => await api.updateJobStatus(expandedJobId, 'new'),
        'applying': async () => await api.updateJobStatus(expandedJobId, 'greenlighted'),
        'applied': async () => await api.updateJobStatus(expandedJobId, 'applied'),
        'interviewing': async () => await api.updateJobStatus(expandedJobId, 'interviewing'),
        'offer': async () => await api.setJobOutcome(expandedJobId, 'offer', null, ''),
        'rejected': async () => {
            const stage = expandedJobPhase === 'interview' ? 'interview' : 'application';
            await api.setJobOutcome(expandedJobId, 'rejected', stage, '');
        },
        'ignored': async () => await api.updateJobStatus(expandedJobId, 'ignored'),
    };

    if (statusActions[newStatus]) {
        await statusActions[newStatus]();
        logSystemEvent(expandedJobId, `Status changed to ${newStatus}`);
        expandedJobData.status = newStatus === 'applying' ? 'greenlighted' : newStatus;
        showToast(`Status updated to ${newStatus}`, 'success');

        // Auto-collapse when ignoring a job so it immediately disappears from the board
        if (newStatus === 'ignored') {
            collapseJobView();
        }
    }
}

// =================== Expanded Resume Phase ===================

async function loadExpandedResumePhase(jobId) {
    const resumes = await api.getResumes();
    if (resumes.length === 0) {
        document.getElementById('expanded-resume-upload').style.display = 'block';
        document.getElementById('expanded-resume-workspace').style.display = 'none';
        return;
    }

    document.getElementById('expanded-resume-upload').style.display = 'none';
    document.getElementById('expanded-resume-workspace').style.display = 'block';

    // Destroy any existing editors
    if (window.resumeEditor) window.resumeEditor.destroyEditors();

    currentAppId = jobId;

    // Load or create application
    let app = await api.getApplicationForJob(jobId);
    if (!app || app.error) {
        // Check if we need resume selection
        if (resumes.length > 1) {
            showResumeSelector(jobId, resumes);
            return;
        }
        const result = await api.createApplication(jobId);
        app = await api.getApplication(result.id);
    }

    // Show switch resume button (only if multiple resumes exist)
    const switchBtn = document.getElementById('btn-switch-resume');
    if (switchBtn) {
        switchBtn.style.display = resumes.length > 1 ? '' : 'none';
        switchBtn._appId = app.id;
        switchBtn._currentResumeId = app.resume_id;
    }

    // Determine sections: merge saved edits with section metadata
    let sections = app.sections || [];
    if (app.content_json) {
        try {
            const saved = JSON.parse(app.content_json);
            sections = sections.map(s => {
                const match = saved.find(ss => ss.id === s.id);
                return match ? { ...s, content_html: match.html } : s;
            });
        } catch (e) { /* use original sections */ }
    }

    // Initialize TipTap editors
    const container = document.getElementById('resume-sections-container');
    if (sections.length > 0 && window.resumeEditor) {
        window.resumeEditor.initEditors(sections, app.id);
    } else if (sections.length > 0) {
        container.innerHTML = sections.map(section => {
            const typeLabel = sectionTypeLabel(section.section_type);
            const meta = [section.company_name, section.role_title, section.dates]
                .filter(Boolean).join(' \u2014 ');
            return `<div class="resume-section" data-section-id="${section.id}">
                <div class="section-header-row">
                    <span class="chip-sm">${escapeHtml(typeLabel)}</span>
                    ${meta ? `<span class="section-meta">${escapeHtml(meta)}</span>` : ''}
                </div>
                <div class="resume-content">${section.content_html}</div>
            </div>`;
        }).join('');
    } else if (app.content_html) {
        container.innerHTML = `<div class="resume-content">${app.content_html}</div>`;
    } else {
        container.innerHTML = '<div class="empty-state">Resume content not available.</div>';
    }

    // Display analysis if available
    const feedbackPanel = document.getElementById('ai-feedback-panel');
    if (app.analysis_phase1 || app.analysis_phase2) {
        let html = '';
        if (app.analysis_phase1) {
            html += `<div class="feedback-section card">
                <h3>Profile Assessment & Edits</h3>
                <div class="markdown-body">${marked.parse(app.analysis_phase1)}</div>
            </div>`;
        }
        if (app.analysis_phase2) {
            html += `<div class="feedback-section card">
                <h3>Bullet Analysis</h3>
                <div class="markdown-body">${marked.parse(app.analysis_phase2)}</div>
            </div>`;
        }
        feedbackPanel.innerHTML = html;
        _analysisHtmlCache = html;

        // Parse bullet suggestions and send to editor
        if (app.analysis_phase2 && window.resumeEditor) {
            const suggestions = parseBulletAnalysis(app.analysis_phase2);
            window.resumeEditor.setBulletSuggestions(suggestions);
        }
    } else {
        feedbackPanel.innerHTML = '<div class="empty-state">Click Analyze to get AI feedback on your resume for this job.</div>';
        _analysisHtmlCache = '';
    }

    // Register bullet improve callback
    if (window.resumeEditor) {
        window.resumeEditor.setOnImprove(showBulletComparison);
    }
}

// =================== Scraper Status & Polling ===================

function renderScraperStatus(status) {
    const badge = document.getElementById('scraper-badge');
    const detail = document.getElementById('scraper-status-detail');
    const btn = document.getElementById('btn-run-scraper');
    const progressEl = document.getElementById('scraper-progress');

    if (status.running) {
        badge.className = 'badge badge-running';
        badge.textContent = 'Running';
        btn.disabled = true;
        btn.textContent = 'Running...';

        const run = status.latest_run;
        if (run && run.total_sources > 0) {
            progressEl.style.display = 'block';
            const pct = Math.round((run.current_source_index / run.total_sources) * 100);
            document.getElementById('progress-bar').style.width = pct + '%';
            document.getElementById('progress-text').textContent =
                `Source ${run.current_source_index} of ${run.total_sources}` +
                (run.current_source_name ? ` — ${run.current_source_name}` : '') +
                ` | Found: ${run.jobs_found || 0} | New: ${run.jobs_new || 0}`;
        }

        document.getElementById('activity-log-container').style.display = 'block';
        startPollingStatus();
        startPollingLogs();
    } else {
        badge.className = 'badge badge-idle';
        badge.textContent = 'Idle';
        btn.disabled = false;
        btn.textContent = 'Run Scraper';
        progressEl.style.display = 'none';
        stopPollingLogs();

        if (status.latest_run) {
            const run = status.latest_run;
            const statusClass = run.status === 'completed' ? 'badge-done' : 'badge-error';
            badge.className = `badge ${statusClass}`;
            badge.textContent = run.status === 'completed' ? 'Done' : 'Error';

            const d = parseUTC(run.finished_at);
            const finishedAt = d ? d.toLocaleString() : 'N/A';
            detail.innerHTML = `<div class="run-info">
                <span>Last run: ${finishedAt}</span>
                <span>Found: ${run.jobs_found}</span>
                <span>New: ${run.jobs_new}</span>
                ${run.errors ? `<span style="color:var(--danger)">Errors: ${escapeHtml(run.errors).substring(0, 200)}</span>` : ''}
            </div>`;
        }
    }
}

function startPollingStatus() {
    if (scraperPollingInterval) return;
    scraperPollingInterval = setInterval(async () => {
        const status = await api.getScraperStatus();
        renderScraperStatus(status);
        if (!status.running) {
            clearInterval(scraperPollingInterval);
            scraperPollingInterval = null;
            refreshDiscovery();
        }
    }, 2000);
}

// =================== Activity Log ===================

function startPollingLogs() {
    if (logPollingInterval) return;
    pollLogs();
    logPollingInterval = setInterval(pollLogs, 1500);
}

function stopPollingLogs() {
    if (logPollingInterval) {
        clearInterval(logPollingInterval);
        logPollingInterval = null;
    }
}

async function pollLogs() {
    try {
        const data = await api.getScraperLog(lastLogId, currentRunId);
        if (!data.run_id) return;

        currentRunId = data.run_id;

        if (data.logs && data.logs.length > 0) {
            const logContainer = document.getElementById('activity-log');
            document.getElementById('activity-log-container').style.display = 'block';

            for (const entry of data.logs) {
                const div = document.createElement('div');
                div.className = `log-entry log-${entry.level}`;
                const d = parseUTC(entry.timestamp);
                const time = d ? d.toLocaleTimeString() : '';
                div.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${escapeHtml(entry.message)}</span>`;
                logContainer.appendChild(div);
                lastLogId = Math.max(lastLogId, entry.id);
            }
            logContainer.scrollTop = logContainer.scrollHeight;
        }
    } catch (e) { /* Silently ignore */ }
}

function clearActivityLog() {
    document.getElementById('activity-log').innerHTML = '';
    lastLogId = 0;
    currentRunId = null;
}

// =================== Sources (collapsible) ===================

function renderSources(sources) {
    const container = document.getElementById('sources-list');
    if (!sources.length) {
        container.innerHTML = '<div class="empty-state">No sources added yet.</div>';
        return;
    }
    container.innerHTML = sources.map(s => {
        const typeLabel = s.url_type === 'linkedin_serp' ? 'linkedin' : 'career';
        const checked = s.is_active ? 'checked' : '';
        return `<div class="source-item">
            <div class="source-info">
                <div class="source-company">
                    ${escapeHtml(s.company_name)}
                    <span class="source-type ${typeLabel}">${typeLabel}</span>
                </div>
                <div class="source-url" title="${escapeHtml(s.url)}">${escapeHtml(s.url)}</div>
            </div>
            <div class="source-actions">
                <label class="toggle" title="Active">
                    <input type="checkbox" ${checked} onchange="handleToggleSource(${s.id}, this.checked)">
                    <span class="toggle-slider"></span>
                </label>
                <button class="btn btn-danger btn-sm" onclick="handleDeleteSource(${s.id})">Remove</button>
            </div>
        </div>`;
    }).join('');
}

// =================== Filters (collapsible) ===================

function renderFilters(filters) {
    const container = document.getElementById('filters-list');
    const clearBtn = document.getElementById('btn-clear-filters');
    if (!filters.length) {
        container.innerHTML = '<div class="empty-state">No keyword filters set. All jobs will be saved.</div>';
        if (clearBtn) clearBtn.style.display = 'none';
        return;
    }
    if (clearBtn) clearBtn.style.display = '';
    container.innerHTML = filters.map(f => {
        const isExclude = f.filter_type === 'exclude';
        const chipClass = isExclude ? 'filter-chip filter-chip-exclude' : 'filter-chip';
        const prefix = isExclude ? '&minus; ' : '';
        return `<span class="${chipClass}">
            ${prefix}${escapeHtml(f.keyword)}
            <span class="remove" onclick="handleDeleteFilter(${f.id})">&times;</span>
        </span>`;
    }).join('');
}

// =================== Filtered Jobs Review ===================

async function loadFilteredJobs() {
    try {
        const jobs = await api.getFilteredJobs();
        renderFilteredJobs(Array.isArray(jobs) ? jobs : []);
    } catch (e) {
        // Silent fail — filtered section just won't show
    }
}

function renderFilteredJobs(jobs) {
    const section = document.getElementById('filtered-jobs-section');
    const badge = document.getElementById('filtered-count-badge');
    const list = document.getElementById('filtered-jobs-list');
    if (!section || !badge || !list) return;

    badge.textContent = jobs.length;

    if (!jobs.length) {
        section.style.display = 'none';
        list.innerHTML = '<div class="empty-state">No filtered jobs to review.</div>';
        return;
    }

    section.style.display = '';

    list.innerHTML = jobs.map(job => {
        const d = job.date_found ? new Date(job.date_found) : null;
        const date = d ? d.toLocaleDateString() : '';
        return `
            <div class="filtered-job-row" data-job-id="${job.id}">
                <div class="filtered-job-meta">
                    <strong>${escapeHtml(job.title || 'Untitled')}</strong>
                    <span class="filtered-job-company">${escapeHtml(job.company || '')}</span>
                    <span class="filtered-job-location">${escapeHtml(job.location || '')}</span>
                    <span class="filtered-job-date">${date}</span>
                </div>
                <div class="filtered-job-actions">
                    <button class="btn btn-primary btn-sm" onclick="handleKeepFilteredJob(${job.id}, this)">Keep</button>
                    <button class="btn btn-ghost btn-sm" onclick="handleDiscardFilteredJob(${job.id})">Discard</button>
                </div>
                <div class="filtered-keyword-suggestions" id="kw-suggest-${job.id}" style="display:none;"></div>
            </div>
        `;
    }).join('');
}

async function handleKeepFilteredJob(jobId, btn) {
    btn.disabled = true;
    btn.textContent = 'Keeping...';

    const result = await api.keepFilteredJob(jobId);

    if (result.error) {
        showToast(result.error, 'error');
        btn.disabled = false;
        btn.textContent = 'Keep';
        return;
    }

    showToast('Job promoted to new!', 'success');

    const row = btn.closest('.filtered-job-row');
    const suggestions = result.keyword_suggestions || [];
    const suggestEl = document.getElementById(`kw-suggest-${jobId}`);

    // Hide action buttons
    const actionsEl = row ? row.querySelector('.filtered-job-actions') : null;
    if (actionsEl) actionsEl.style.display = 'none';

    if (suggestions.length && suggestEl) {
        const chips = suggestions.map(kw =>
            `<button class="btn btn-ghost btn-sm keyword-suggest-chip" onclick="handleAddSuggestedKeyword('${escapeHtml(kw)}', this)">+ ${escapeHtml(kw)}</button>`
        ).join('');
        suggestEl.innerHTML = `
            <span class="hint" style="margin-right:0.5rem;">Add as keyword?</span>
            ${chips}
        `;
        suggestEl.style.display = 'flex';
        // Replace Keep/Discard with a Done button
        if (actionsEl) {
            actionsEl.innerHTML = `<button class="btn btn-ghost btn-sm" onclick="dismissFilteredRow(this)">Done</button>`;
            actionsEl.style.display = '';
        }
    } else {
        // No suggestions — just remove the row
        if (row) { row.remove(); updateFilteredBadge(); }
    }

    // Refresh just the jobs table (not filtered section — would wipe out the suggestion chips)
    const jobs = await api.getJobs();
    renderJobs(jobs);
}

function dismissFilteredRow(btn) {
    const row = btn.closest('.filtered-job-row');
    if (row) row.remove();
    updateFilteredBadge();
}

async function handleAddSuggestedKeyword(keyword, btn) {
    btn.disabled = true;
    const result = await api.addFilter(keyword, 'include');
    if (result.error) {
        showToast(result.error || 'Already exists', 'warn');
        btn.disabled = false;
        return;
    }
    showToast(`Keyword "${keyword}" added`, 'success');
    btn.textContent = `\u2713 ${keyword}`;
    btn.classList.add('keyword-suggest-added');
    // Refresh filters list
    const filters = await api.getFilters();
    renderFilters(filters);
    document.getElementById('filter-count-badge').textContent = filters.length;
}

async function handleDiscardFilteredJob(jobId) {
    await api.updateJobStatus(jobId, 'ignored');
    showToast('Job discarded', 'success');
    const row = document.querySelector(`.filtered-job-row[data-job-id="${jobId}"]`);
    if (row) row.remove();
    updateFilteredBadge();
}

function updateFilteredBadge() {
    const badge = document.getElementById('filtered-count-badge');
    const section = document.getElementById('filtered-jobs-section');
    const rows = document.querySelectorAll('.filtered-job-row');
    if (badge) badge.textContent = rows.length;
    if (section && !rows.length) section.style.display = 'none';
}

// =================== Event Handlers (Discovery) ===================

async function handleAddSource(e) {
    e.preventDefault();
    const url = document.getElementById('source-url').value.trim();
    const company = document.getElementById('source-company').value.trim();
    const result = await api.addSource({ url, company_name: company });
    if (result.error) {
        showToast(result.error, 'error');
    } else {
        showToast('Source added', 'success');
        document.getElementById('add-source-form').reset();
        refreshDiscovery();
    }
}

async function handleDeleteSource(id) {
    await api.deleteSource(id);
    showToast('Source removed', 'success');
    refreshDiscovery();
}

async function handleToggleSource(id, isActive) {
    await api.toggleSource(id, isActive);
}

async function handleAddFilter(e) {
    e.preventDefault();
    const keyword = document.getElementById('filter-keyword').value.trim();
    const filterType = document.getElementById('filter-type-select').value;
    const result = await api.addFilter(keyword, filterType);
    if (result.error) {
        showToast(result.error, 'error');
    } else {
        showToast(`Keyword "${keyword}" added`, 'success');
        document.getElementById('filter-keyword').value = '';
        refreshDiscovery();
    }
}

async function handleDeleteFilter(id) {
    await api.deleteFilter(id);
    refreshDiscovery();
}

async function handleClearFilters() {
    await api.clearAllFilters();
    showToast('All filters cleared', 'success');
    refreshDiscovery();
}

async function handleRunScraper() {
    const btn = document.getElementById('btn-run-scraper');
    btn.disabled = true;
    btn.textContent = 'Starting...';

    lastLogId = 0;
    currentRunId = null;
    document.getElementById('activity-log').innerHTML = '';

    try {
        const { status, data } = await api.runScraper();

        if (data.error) {
            showToast(data.error, status === 409 ? 'warning' : 'error');
            btn.disabled = false;
            btn.textContent = 'Run Scraper';
        } else {
            // Capture run_id immediately so polling targets the correct run
            if (data.run_id) currentRunId = data.run_id;
            showToast('Scraper started!', 'success');
            document.getElementById('activity-log-container').style.display = 'block';
            renderScraperStatus({ running: true, latest_run: null });
        }
    } catch (e) {
        console.error('[Scraper] Failed to start:', e);
        showToast('Failed to start scraper — is the server running?', 'error');
        btn.disabled = false;
        btn.textContent = 'Run Scraper';
    }
}

function debounceSearch() {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(async () => {
        const query = document.getElementById('job-search').value.trim();
        const jobs = await api.getJobs(query);
        _allJobs = jobs;
        applyFiltersAndRender();
    }, 300);
}

// =================== Resume Actions ===================

async function handleResumeUpload(e) {
    e.preventDefault();
    const fileInput = document.getElementById('resume-file');
    const formData = new FormData();
    formData.append('file', fileInput.files[0]);

    try {
        const resp = await fetch('/api/resumes/upload', { method: 'POST', body: formData });
        const result = await resp.json();
        if (result.error) {
            showToast(result.error, 'error');
        } else {
            showToast(`Resume parsed: ${result.sections} sections`, 'success');
            // Reload the resume phase in the expanded view
            if (expandedJobId) {
                await loadExpandedResumePhase(expandedJobId);
            }
        }
    } catch (e) {
        showToast('Upload failed: ' + e.message, 'error');
    }
}

async function handleAnalyze() {
    console.log('[Analyze] currentAppId =', currentAppId);
    if (!currentAppId) {
        showToast('No job loaded. Open a job first.', 'warning');
        return;
    }

    let app;
    try {
        app = await api.getApplicationForJob(currentAppId);
        console.log('[Analyze] fetched app =', app);
    } catch (e) {
        console.error('[Analyze] fetch app error:', e);
        showToast('Failed to fetch application', 'error');
        return;
    }
    if (!app || !app.id) {
        console.error('[Analyze] no app.id, app =', app);
        showToast('No application found for this job. Upload a resume first.', 'error');
        return;
    }

    const btn = document.getElementById('btn-analyze');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> Analyzing...';

    const feedbackPanel = document.getElementById('ai-feedback-panel');
    feedbackPanel.innerHTML = `
        <div class="empty-state">
            <div class="loading-spinner" style="width:24px;height:24px;margin:0 auto 1rem;"></div>
            <p>Running AI analysis...</p>
            <p style="font-size:0.75rem;color:var(--text-muted);margin-top:0.5rem;">
                This may take 30-60 seconds (two-phase analysis).
            </p>
        </div>`;

    try {
        console.log('[Analyze] calling analyzeApplication with app.id =', app.id);
        const result = await api.analyzeApplication(app.id);
        console.log('[Analyze] result =', result);
        if (result.error) {
            showToast(result.error, 'error');
            feedbackPanel.innerHTML = `<div class="error-state" style="padding:1rem;">${escapeHtml(result.error)}</div>`;
        } else {
            let html = '';
            if (result.analysis_phase1) {
                html += `<div class="feedback-section">
                    <h4>Profile Assessment & Resume Edits</h4>
                    <div class="markdown-body">${marked.parse(result.analysis_phase1)}</div>
                </div>`;
            }
            if (result.analysis_phase2) {
                html += `<div class="feedback-section">
                    <h4>Bullet Analysis</h4>
                    <div class="markdown-body">${marked.parse(result.analysis_phase2)}</div>
                </div>`;
            }
            if (result.warning) {
                html += `<div class="empty-state" style="color:var(--warning);">${escapeHtml(result.warning)}</div>`;
            }
            feedbackPanel.innerHTML = html;
            _analysisHtmlCache = html;

            if (result.analysis_phase2 && window.resumeEditor) {
                const suggestions = parseBulletAnalysis(result.analysis_phase2);
                window.resumeEditor.setBulletSuggestions(suggestions);
            }

            showToast('Analysis complete!', 'success');
        }
    } catch (e) {
        console.error('[Analyze] exception:', e);
        showToast('Analysis failed: ' + e.message, 'error');
        feedbackPanel.innerHTML = `<div class="error-state" style="padding:1rem;">Analysis failed: ${escapeHtml(e.message)}</div>`;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Analyze';
    }
}

async function handleExportDocx() {
    if (!currentAppId) return;

    const app = await api.getApplicationForJob(currentAppId);
    if (!app || !app.id) {
        showToast('No application found', 'error');
        return;
    }

    const url = `/api/applications/${app.id}/export/docx?margin=normal`;
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('Downloading .docx...', 'success');
}

function handlePrintPDF() {
    // Collect resume HTML with section types for styling
    let sectionEntries = []; // [{type, html}]
    if (window.resumeEditor) {
        const sections = window.resumeEditor.getContent();
        sectionEntries = sections.map(s => ({ type: s.type, html: s.html }));
    } else {
        document.querySelectorAll('#resume-sections-container .resume-section').forEach(el => {
            const chip = el.querySelector('.chip-sm');
            const type = chip ? chip.textContent.trim().toLowerCase() : '';
            const content = el.querySelector('.resume-content');
            if (content) sectionEntries.push({ type, html: content.innerHTML });
        });
    }

    if (!sectionEntries.length) {
        showToast('No resume content to print', 'error');
        return;
    }

    const resumeHtml = sectionEntries.map(s =>
        `<div class="sec sec-${s.type}">${s.html}</div>`
    ).join('\n');

    // Use a hidden iframe so print stays in same tab
    let frame = document.getElementById('pdf-print-frame');
    if (frame) frame.remove();
    frame = document.createElement('iframe');
    frame.id = 'pdf-print-frame';
    frame.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;border:none;visibility:hidden;';
    document.body.appendChild(frame);

    const fdoc = frame.contentDocument || frame.contentWindow.document;
    fdoc.open();
    fdoc.write(`<!DOCTYPE html><html><head><title>Resume</title>
<style>
@page { size: letter; margin: 0.5in; }
body {
    font-family: Calibri, 'Segoe UI', sans-serif;
    font-size: 10pt;
    color: #000;
    background: #fff;
    margin: 0; padding: 0;
    line-height: 1.3;
}
h2, h3 {
    font-size: 14pt;
    font-weight: bold;
    border-bottom: 1px solid #000;
    margin: 8pt 0 3pt;
    padding-bottom: 2pt;
}
p { margin: 1pt 0; }
ul { margin: 2pt 0 2pt 18pt; padding: 0; list-style-type: disc; }
li { margin: 1pt 0; }
li p { margin: 0; display: inline; }
span[style*="float:right"], span[style*="float: right"] { float: right; }
a { color: #0563C1; text-decoration: underline; }
strong { font-weight: bold; }
em { font-style: italic; }
/* Header section — name line larger */
.sec-header > p:first-child { font-size: 20pt; margin-bottom: 2pt; }
/* Summary section — border after first and last p */
.sec-summary > p:first-of-type { border-bottom: 1px solid #000; padding-bottom: 4pt; margin-bottom: 4pt; }
.sec-summary > p:last-of-type { border-bottom: 1px solid #000; padding-bottom: 4pt; margin-bottom: 4pt; }
</style></head><body>
${resumeHtml}
</body></html>`);
    fdoc.close();

    frame.contentWindow.focus();
    setTimeout(() => frame.contentWindow.print(), 200);
}

function toggleExportMenu(e) {
    e.stopPropagation();
    const menu = document.getElementById('export-menu');
    menu.classList.toggle('open');
    // Close on next click anywhere
    if (menu.classList.contains('open')) {
        setTimeout(() => {
            document.addEventListener('click', closeExportMenu, { once: true });
        }, 0);
    }
}

function closeExportMenu() {
    document.getElementById('export-menu')?.classList.remove('open');
}

async function handleApply() {
    if (!expandedJobId) return;

    // Open the job posting URL
    if (expandedJobData && expandedJobData.job_url) {
        window.open(expandedJobData.job_url, '_blank');
    }

    // Mark as applied if there's an application
    const app = await api.getApplicationForJob(expandedJobId);
    if (app && app.id) {
        await api.markApplied(app.id);
    } else {
        // No application yet — just update job status directly
        await api.updateJobStatus(expandedJobId, 'applied');
    }

    logSystemEvent(expandedJobId, 'Application submitted');
    showToast('Marked as Applied!', 'success');
    if (expandedJobData) {
        expandedJobData.status = 'applied';
        document.getElementById('expanded-status-select').value = 'applied';
    }
}

// =================== Bullet Analysis & Comparison ===================

function parseBulletAnalysis(markdown) {
    if (!markdown) return [];
    const improvements = [];

    const parts = markdown.split(/\*\*Bullet\s+\d+[^*]*\*\*/i);

    for (let i = 1; i < parts.length; i++) {
        const block = parts[i];

        const ratingMatch = block.match(/\*\*Rating\*\*\s*:\s*(\w+)/i);
        const currentMatch = block.match(/\*\*Current(?:\s*(?:Text)?)?\*\*\s*:\s*"?([^"\n]+)"?/i);
        const issueMatch = block.match(/\*\*(?:Issue|Analysis)\*\*\s*:\s*([^\n]+)/i);
        const rewriteMatch = block.match(/\*\*(?:Rewrite|Recommendation)\*\*\s*:\s*"?(.+?)"?\s*$/im);

        if (currentMatch) {
            improvements.push({
                rating: ratingMatch ? ratingMatch[1].trim().toUpperCase() : 'MODERATE',
                current: currentMatch[1].trim().replace(/^"/, '').replace(/"$/, ''),
                issue: issueMatch ? issueMatch[1].trim() : '',
                rewrite: rewriteMatch ? rewriteMatch[1].trim().replace(/^"/, '').replace(/"$/, '') : '',
            });
        }
    }

    return improvements;
}

function showBulletComparison(data) {
    _bulletCompareState = data;

    const panel = document.getElementById('ai-feedback-panel');
    const suggestion = data.suggestion;

    if (!suggestion) {
        panel.innerHTML = `
            <div class="bullet-compare">
                <div class="bullet-compare-header">
                    <h3>Bullet Review</h3>
                    <button class="btn btn-ghost btn-sm" onclick="restoreAnalysisView()">Back to Analysis</button>
                </div>
                <div class="bullet-compare-section">
                    <div class="bullet-compare-label">Current Bullet</div>
                    <div class="bullet-compare-original">${escapeHtml(data.originalText)}</div>
                </div>
                <p class="hint" style="margin-top:1rem;">No AI suggestion found for this bullet. Run analysis first to get improvement recommendations.</p>
            </div>`;
        return;
    }

    const ratingClass = suggestion.rating === 'STRONG' ? 'rating-strong' :
                        suggestion.rating === 'MODERATE' ? 'rating-moderate' : 'rating-weak';

    const rewriteText = suggestion.rewrite || data.originalText;
    const isStrong = suggestion.rating === 'STRONG';

    panel.innerHTML = `
        <div class="bullet-compare">
            <div class="bullet-compare-header">
                <h3>Bullet Review</h3>
                <div style="display:flex;gap:0.5rem;align-items:center;">
                    <span class="bullet-compare-rating ${ratingClass}">${escapeHtml(suggestion.rating)}</span>
                    <button class="btn btn-ghost btn-sm" onclick="restoreAnalysisView()">Back</button>
                </div>
            </div>

            <div class="bullet-compare-section">
                <div class="bullet-compare-label">Original</div>
                <div class="bullet-compare-original">${escapeHtml(data.originalText)}</div>
            </div>

            ${suggestion.issue ? `
            <div class="bullet-compare-issue">${escapeHtml(suggestion.issue)}</div>
            ` : ''}

            ${!isStrong && suggestion.rewrite ? `
            <div class="bullet-compare-section">
                <div class="bullet-compare-label">Proposed Improvement</div>
                <div class="bullet-compare-proposed" contenteditable="true" id="bullet-proposed-text">${escapeHtml(rewriteText)}</div>
            </div>

            <div class="bullet-compare-actions">
                <button class="btn btn-accept btn-sm" onclick="acceptBulletRewrite()">Accept</button>
                <button class="btn btn-ghost btn-sm" onclick="restoreAnalysisView()">Dismiss</button>
            </div>
            ` : `
            <p class="hint" style="margin-top:0.5rem;">This bullet is rated <strong>STRONG</strong> - no rewrite needed.</p>
            `}
        </div>`;
}

function acceptBulletRewrite() {
    if (!_bulletCompareState) return;

    const proposedEl = document.getElementById('bullet-proposed-text');
    const newText = proposedEl ? proposedEl.textContent.trim() : '';

    if (!newText) {
        showToast('No text to apply', 'warning');
        return;
    }

    if (window.resumeEditor && window.resumeEditor.acceptRewrite) {
        const success = window.resumeEditor.acceptRewrite(
            _bulletCompareState.liElement,
            _bulletCompareState.editor,
            newText
        );
        if (success) {
            showToast('Bullet updated!', 'success');
            restoreAnalysisView();
        } else {
            showToast('Failed to update bullet', 'error');
        }
    }

    _bulletCompareState = null;
}

function restoreAnalysisView() {
    const panel = document.getElementById('ai-feedback-panel');
    if (_analysisHtmlCache) {
        panel.innerHTML = _analysisHtmlCache;
    } else {
        panel.innerHTML = '<div class="empty-state">Click Analyze to get AI feedback on your resume for this job.</div>';
    }
    _bulletCompareState = null;
}

// =================== Resume Base Selection ===================

function showResumeSelector(jobId, resumes) {
    const container = document.getElementById('resume-sections-container');
    container.innerHTML = `
        <div class="resume-selector-prompt">
            <h3>Choose Resume Base</h3>
            <p class="hint">Select which resume to use as the starting point for this application.</p>
            <div class="resume-selector-options">
                ${resumes.map(r => `
                    <button class="resume-selector-option" onclick="createApplicationWithResume(${jobId}, ${r.id})">
                        <div class="resume-selector-name">${escapeHtml(r.name)}</div>
                        <div class="resume-selector-meta">${escapeHtml(r.original_filename || '')}</div>
                    </button>
                `).join('')}
            </div>
        </div>
    `;
    document.getElementById('ai-feedback-panel').innerHTML =
        '<div class="empty-state">Select a resume to start preparing your application.</div>';
}

async function createApplicationWithResume(jobId, resumeId) {
    const result = await api.createApplication(jobId, resumeId);
    if (result.error) {
        showToast(result.error, 'error');
        return;
    }
    showToast('Application created', 'success');
    loadExpandedResumePhase(jobId);
}

async function showSwitchResumeModal() {
    const switchBtn = document.getElementById('btn-switch-resume');
    const appId = switchBtn?._appId;
    const currentResumeId = switchBtn?._currentResumeId;
    if (!appId) return;

    const resumes = await api.getResumes();
    if (resumes.length < 2) {
        showToast('Only one resume available', 'warning');
        return;
    }

    // Build modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'switch-resume-overlay';
    overlay.innerHTML = `
        <div class="switch-resume-modal card">
            <h3>Switch Resume Base</h3>
            <p class="hint">This will replace your current resume edits. AI analysis will be kept. This cannot be undone.</p>
            <div class="resume-selector-options">
                ${resumes.map(r => `
                    <button class="resume-selector-option ${r.id === currentResumeId ? 'current' : ''}"
                            onclick="confirmSwitchResume(${appId}, ${r.id})"
                            ${r.id === currentResumeId ? 'disabled' : ''}>
                        <div class="resume-selector-name">${escapeHtml(r.name)}</div>
                        <div class="resume-selector-meta">${r.id === currentResumeId ? '(current)' : escapeHtml(r.original_filename || '')}</div>
                    </button>
                `).join('')}
            </div>
            <button class="btn btn-ghost" onclick="closeSwitchResumeModal()" style="margin-top:0.75rem;">Cancel</button>
        </div>
    `;
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeSwitchResumeModal();
    });
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));
}

function closeSwitchResumeModal() {
    const overlay = document.querySelector('.switch-resume-overlay');
    if (overlay) {
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 200);
    }
}

async function confirmSwitchResume(appId, resumeId) {
    if (!confirm('This will replace your current resume edits with the selected base. AI analysis will be kept. Continue?')) return;

    closeSwitchResumeModal();

    // Flush current editors before switching
    if (window.resumeEditor) window.resumeEditor.destroyEditors();

    const result = await api.switchResumeBase(appId, resumeId);
    if (result.error) {
        showToast(result.error, 'error');
        return;
    }

    logSystemEvent(expandedJobId, 'Resume base switched');
    showToast('Resume base switched', 'success');
    await loadExpandedResumePhase(expandedJobId);
}

// =================== Board Tab (Kanban) ===================

let _boardJobs = [];
let _boardFilterTimer = null;

async function refreshBoard() {
    const allJobs = await api.getJobs();

    _boardJobs = allJobs;

    // Populate company filter dropdown
    const companySelect = document.getElementById('board-company-filter');
    if (companySelect) {
        const companies = [...new Set(allJobs.map(j => j.company || '').filter(Boolean))].sort();
        const current = companySelect.value;
        companySelect.innerHTML = '<option value="">All companies</option>' +
            companies.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
        companySelect.value = current;
    }

    applyBoardFilters();
}

function debounceBoardFilter() {
    clearTimeout(_boardFilterTimer);
    _boardFilterTimer = setTimeout(() => applyBoardFilters(), 200);
}

function applyBoardFilters() {
    const searchQuery = (document.getElementById('board-search')?.value || '').toLowerCase().trim();
    const companyFilter = document.getElementById('board-company-filter')?.value || '';
    const groupBy = document.getElementById('board-group-by-company')?.checked || false;

    let filtered = _boardJobs;

    if (searchQuery) {
        filtered = filtered.filter(j =>
            (j.title || '').toLowerCase().includes(searchQuery) ||
            (j.company || '').toLowerCase().includes(searchQuery)
        );
    }
    if (companyFilter) {
        filtered = filtered.filter(j => j.company === companyFilter);
    }

    // Group by status
    const newJobs = filtered.filter(j => j.status === 'new' || !j.status);
    const applying = filtered.filter(j => ['greenlighted', 'preparing'].includes(j.status));
    const applied = filtered.filter(j => j.status === 'applied');
    const interviewing = filtered.filter(j => j.status === 'interviewing');
    const offers = filtered.filter(j => j.status === 'offer');
    const rejected = filtered.filter(j => j.status === 'rejected');
    const ignored = filtered.filter(j => j.status === 'ignored');

    // Update board stats
    document.getElementById('board-stat-new').textContent = newJobs.length;
    document.getElementById('board-stat-applying').textContent = applying.length;
    document.getElementById('board-stat-applied').textContent = applied.length;
    document.getElementById('board-stat-interviewing').textContent = interviewing.length;
    document.getElementById('board-stat-offers').textContent = offers.length;
    document.getElementById('board-stat-rejected').textContent = rejected.length;

    // Render kanban columns
    if (groupBy) {
        renderKanbanColumnGrouped('kanban-new', 'kanban-count-new', newJobs);
        renderKanbanColumnGrouped('kanban-applying', 'kanban-count-applying', applying);
        renderKanbanColumnGrouped('kanban-applied', 'kanban-count-applied', applied);
        renderKanbanColumnGrouped('kanban-interviewing', 'kanban-count-interviewing', interviewing);
        renderKanbanColumnGrouped('kanban-offer', 'kanban-count-offer', offers);
        renderKanbanColumnGrouped('kanban-rejected', 'kanban-count-rejected', rejected);
    } else {
        renderKanbanColumn('kanban-new', 'kanban-count-new', newJobs);
        renderKanbanColumn('kanban-applying', 'kanban-count-applying', applying);
        renderKanbanColumn('kanban-applied', 'kanban-count-applied', applied);
        renderKanbanColumn('kanban-interviewing', 'kanban-count-interviewing', interviewing);
        renderKanbanColumn('kanban-offer', 'kanban-count-offer', offers);
        renderKanbanColumn('kanban-rejected', 'kanban-count-rejected', rejected);
    }

    // Render ignored bucket
    renderIgnoredBucket(ignored, groupBy);
}

function renderKanbanColumnGrouped(containerId, countId, jobs) {
    document.getElementById(countId).textContent = jobs.length;
    const container = document.getElementById(containerId);

    if (!jobs.length) {
        container.innerHTML = '<div class="kanban-empty">No jobs</div>';
        setupKanbanDragDrop(container);
        return;
    }

    // Group by company
    const groups = new Map();
    for (const job of jobs) {
        const key = job.company || '(No company)';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(job);
    }

    const statusDisplayMap = { greenlighted: 'applying', preparing: 'applying' };
    let html = '';
    for (const [company, groupJobs] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        html += `<div class="kanban-group">
            <div class="kanban-group-header">${escapeHtml(company)} <span class="badge-count">${groupJobs.length}</span></div>`;
        html += groupJobs.map(job => {
            const display = statusDisplayMap[job.status] || job.status;
            const badge = statusDisplayMap[job.status] ? 'applying' : job.status;
            return `<div class="kanban-card" draggable="true" data-job-id="${job.id}" onclick="expandJobView(${job.id})">
                <button class="kanban-card-dismiss" onclick="event.stopPropagation(); dismissKanbanCard(${job.id})" title="Ignore">&times;</button>
                <button class="kanban-card-jd" onclick="event.stopPropagation(); openJobCard(${job.id})" title="View JD"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
                <div class="kanban-card-title">${escapeHtml(job.title || 'Untitled')}</div>
                <span class="status-badge status-${badge}">${display}</span>
                ${job.notes ? `<div class="kanban-card-notes">${escapeHtml(getLatestNoteText(job.notes))}</div>` : ''}
            </div>`;
        }).join('');
        html += `</div>`;
    }

    container.innerHTML = html;
    setupKanbanDragDrop(container);
}

function renderKanbanColumn(containerId, countId, jobs) {
    document.getElementById(countId).textContent = jobs.length;
    const container = document.getElementById(containerId);

    if (!jobs.length) {
        container.innerHTML = '<div class="kanban-empty">No jobs</div>';
    } else {
        const statusDisplayMap = { greenlighted: 'applying', preparing: 'applying' };
        container.innerHTML = jobs.map(job => {
            const display = statusDisplayMap[job.status] || job.status;
            const badge = statusDisplayMap[job.status] ? 'applying' : job.status;
            return `
            <div class="kanban-card" draggable="true" data-job-id="${job.id}" onclick="expandJobView(${job.id})">
                <button class="kanban-card-dismiss" onclick="event.stopPropagation(); dismissKanbanCard(${job.id})" title="Ignore">&times;</button>
                <button class="kanban-card-jd" onclick="event.stopPropagation(); openJobCard(${job.id})" title="View JD"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
                <div class="kanban-card-title">${escapeHtml(job.title || 'Untitled')}</div>
                <div class="kanban-card-company">${escapeHtml(job.company || '')}</div>
                <span class="status-badge status-${badge}">${display}</span>
                ${job.notes ? `<div class="kanban-card-notes">${escapeHtml(getLatestNoteText(job.notes))}</div>` : ''}
            </div>
        `}).join('');
    }

    // Drag-and-drop event listeners
    setupKanbanDragDrop(container);
}

// Track the source status of a dragged kanban card
let _kanbanDragSourceStatus = null;

function setupKanbanDragDrop(container) {
    container.querySelectorAll('.kanban-card').forEach(card => {
        card.addEventListener('dragstart', (e) => {
            if (e.target.closest('button')) { e.preventDefault(); return; }
            card.classList.add('dragging');
            e.dataTransfer.setData('text/plain', card.dataset.jobId);
            e.dataTransfer.effectAllowed = 'move';
            const srcCol = card.closest('.kanban-column');
            _kanbanDragSourceStatus = srcCol ? srcCol.dataset.status : null;
        });
        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            _kanbanDragSourceStatus = null;
            document.querySelectorAll('.kanban-column.drag-over').forEach(col =>
                col.classList.remove('drag-over')
            );
        });
    });

    // Drop targets on column containers — only attach once
    const column = container.closest('.kanban-column');
    if (!column || column._kanbanDropBound) return;
    column._kanbanDropBound = true;
    const targetStatus = column.dataset.status;

    column.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        column.classList.add('drag-over');
    });

    column.addEventListener('dragleave', (e) => {
        if (!column.contains(e.relatedTarget)) {
            column.classList.remove('drag-over');
        }
    });

    column.addEventListener('drop', async (e) => {
        e.preventDefault();
        column.classList.remove('drag-over');
        const jobId = parseInt(e.dataTransfer.getData('text/plain'));
        if (!jobId) return;

        // Map column status to backend status
        const statusMap = {
            'new': 'new',
            'applying': 'greenlighted',
            'applied': 'applied',
            'interviewing': 'interviewing',
            'offer': 'offer',
            'rejected': 'rejected',
            'ignored': 'ignored',
        };
        const newStatus = statusMap[targetStatus];
        if (!newStatus) return;

        // If dropping into the same column, do nothing
        if (_kanbanDragSourceStatus === targetStatus) return;

        // Confirm before moving jobs from advanced stages
        const advancedStatuses = ['interviewing', 'offer', 'applied'];
        if (advancedStatuses.includes(_kanbanDragSourceStatus)) {
            const ok = confirm(`Move this job from "${_kanbanDragSourceStatus}" to "${targetStatus}"?`);
            if (!ok) {
                refreshBoard();
                return;
            }
        }

        await api.updateJobStatus(jobId, newStatus);
        showToast(`Moved to ${targetStatus}`, 'success');
        refreshBoard();
    });
}

async function dismissKanbanCard(jobId) {
    const card = document.querySelector(`.kanban-card[data-job-id="${jobId}"]`);
    if (card) {
        card.style.transition = 'opacity 0.25s, transform 0.25s';
        card.style.opacity = '0';
        card.style.transform = 'scale(0.9)';
    }
    await api.updateJobStatus(jobId, 'ignored');
    showToast('Job ignored', 'success');
    setTimeout(() => refreshBoard(), 200);
}

function renderIgnoredBucket(jobs, groupBy) {
    const bucket = document.getElementById('kanban-ignored-bucket');
    const countEl = document.getElementById('kanban-count-ignored');
    countEl.textContent = jobs.length;
    bucket.style.display = jobs.length > 0 ? '' : 'none';

    if (groupBy) {
        renderKanbanColumnGrouped('kanban-ignored', 'kanban-count-ignored', jobs);
    } else {
        renderKanbanColumn('kanban-ignored', 'kanban-count-ignored', jobs);
    }
}

function toggleIgnoredBucket() {
    const cards = document.getElementById('kanban-ignored');
    const chevron = document.getElementById('ignored-chevron');
    const isOpen = cards.style.display !== 'none';
    cards.style.display = isOpen ? 'none' : '';
    chevron.innerHTML = isOpen ? '&#x25B6;' : '&#x25BC;';
}

// =================== Stories ===================

let _storyQuillEditors = {}; // track Quill editors for story bank editing

// =================== Competency Picker Helpers ===================

function initCompetencyPicker(containerId, inputId, picksId) {
    const input = document.getElementById(inputId);
    const picksDiv = document.getElementById(picksId);
    if (!picksDiv) return;

    renderCompetencyPicks(picksDiv, containerId);

    // Custom competency on Enter
    if (input) {
        input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const val = input.value.trim();
                if (val) {
                    addCompetencyChip(containerId, val);
                    input.value = '';
                    syncCompetencyPicks(containerId);
                }
            }
        };
    }
}

function renderCompetencyPicks(picksDiv, containerId) {
    const presets = getCompetencyPresets();
    picksDiv.innerHTML = presets.map(c =>
        `<button type="button" class="btn btn-ghost btn-xs competency-pick" data-comp="${escapeHtml(c)}" onclick="toggleCompetencyPick(this, '${containerId}')">${escapeHtml(c)}</button>`
    ).join('') + `<button type="button" class="btn btn-ghost btn-xs competency-edit-presets" onclick="openCompetencyPresetsEditor()" title="Edit presets">&#9881;</button>`;
}

function openCompetencyPresetsEditor() {
    const existing = document.getElementById('competency-presets-overlay');
    if (existing) existing.remove();

    const presets = getCompetencyPresets();

    const overlay = document.createElement('div');
    overlay.id = 'competency-presets-overlay';
    overlay.className = 'job-quick-card-overlay';
    overlay.innerHTML = `
        <div class="job-quick-card" style="max-width: min(500px, 92vw);">
            <div class="job-quick-card-header">
                <div><h2>Edit Competency Presets</h2></div>
                <div class="job-quick-card-actions-top">
                    <button class="btn btn-ghost btn-sm" onclick="closeCompetencyPresetsEditor()" title="Close">&times;</button>
                </div>
            </div>
            <div class="job-quick-card-body" style="padding: 1rem;">
                <p style="font-size:0.8rem; color:var(--text-muted); margin:0 0 0.75rem;">Click <strong>&times;</strong> to remove. Type below to add new ones.</p>
                <div id="presets-chip-list" class="presets-chip-list">
                    ${presets.map(c => `<span class="competency-chip chip-sm preset-editable">${escapeHtml(c)}<button onclick="removePresetChip(this)">&times;</button></span>`).join('')}
                </div>
                <div class="form-row" style="margin-top:0.75rem; gap:0.4rem;">
                    <input type="text" id="new-preset-input" class="input" placeholder="New competency..." style="flex:1;" onkeydown="if(event.key==='Enter'){addPresetFromInput();}">
                    <button class="btn btn-ghost btn-sm" onclick="addPresetFromInput()">Add</button>
                </div>
                <div class="form-row" style="margin-top:0.5rem; gap:0.4rem;">
                    <button class="btn btn-ghost btn-sm" onclick="resetPresetsToDefault()">Reset to Defaults</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));

    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCompetencyPresetsEditor(); });
    const esc = (e) => { if (e.key === 'Escape') { closeCompetencyPresetsEditor(); document.removeEventListener('keydown', esc); } };
    document.addEventListener('keydown', esc);

    document.getElementById('new-preset-input')?.focus();
}

function closeCompetencyPresetsEditor() {
    const overlay = document.getElementById('competency-presets-overlay');
    if (!overlay) return;
    // Save current state from chips
    const chips = overlay.querySelectorAll('.preset-editable');
    const presets = [...chips].map(c => c.firstChild.textContent.trim()).filter(Boolean);
    saveCompetencyPresets(presets);
    overlay.classList.remove('visible');
    setTimeout(() => overlay.remove(), 250);

    // Refresh all visible competency pickers
    document.querySelectorAll('.competency-quick-picks').forEach(picksDiv => {
        const containerId = picksDiv.id.replace('-picks', '-chips').replace('inline-competency-picks', 'inline-competency-chips').replace('edit-competency-picks', 'edit-competency-chips').replace('story-competency-picks', 'story-competency-chips');
        renderCompetencyPicks(picksDiv, containerId);
    });
}

function removePresetChip(btn) {
    btn.closest('.preset-editable').remove();
}

function addPresetFromInput() {
    const input = document.getElementById('new-preset-input');
    const val = (input?.value || '').trim();
    if (!val) return;
    const list = document.getElementById('presets-chip-list');
    if (!list) return;
    // Avoid duplicates
    const existing = [...list.querySelectorAll('.preset-editable')].map(c => c.firstChild.textContent.trim().toLowerCase());
    if (existing.includes(val.toLowerCase())) { showToast('Already exists', 'warning'); return; }
    list.insertAdjacentHTML('beforeend', `<span class="competency-chip chip-sm preset-editable">${escapeHtml(val)}<button onclick="removePresetChip(this)">&times;</button></span>`);
    input.value = '';
    input.focus();
}

function resetPresetsToDefault() {
    const list = document.getElementById('presets-chip-list');
    if (!list) return;
    list.innerHTML = DEFAULT_COMPETENCY_PRESETS.map(c => `<span class="competency-chip chip-sm preset-editable">${escapeHtml(c)}<button onclick="removePresetChip(this)">&times;</button></span>`).join('');
}

function toggleCompetencyPick(btn, containerId) {
    const comp = btn.dataset.comp;
    const container = document.getElementById(containerId);
    const existing = container.querySelector(`[data-value="${CSS.escape(comp)}"]`);
    if (existing) {
        existing.remove();
        btn.classList.remove('active');
    } else {
        addCompetencyChip(containerId, comp);
        btn.classList.add('active');
    }
}

function addCompetencyChip(containerId, value) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (container.querySelector(`[data-value="${CSS.escape(value)}"]`)) return;
    const chip = document.createElement('span');
    chip.className = 'competency-chip chip-sm';
    chip.dataset.value = value;
    chip.innerHTML = `${escapeHtml(value)} <button onclick="this.parentElement.remove();syncCompetencyPicks('${containerId}')">&times;</button>`;
    container.appendChild(chip);
}

function getCompetencyValues(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return '';
    return [...container.querySelectorAll('[data-value]')].map(el => el.dataset.value).join(', ');
}

function setCompetencyValues(containerId, csvString) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    const values = (csvString || '').split(',').map(s => s.trim()).filter(Boolean);
    values.forEach(v => addCompetencyChip(containerId, v));
    syncCompetencyPicks(containerId);
}

function syncCompetencyPicks(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const parent = container.closest('.competency-input-group');
    if (!parent) return;
    const currentValues = new Set([...container.querySelectorAll('[data-value]')].map(el => el.dataset.value));
    parent.querySelectorAll('.competency-pick').forEach(btn => {
        btn.classList.toggle('active', currentValues.has(btn.dataset.comp));
    });
}

// =================== Story Bank Render Pipeline ===================

function renderStories(stories) {
    _storiesCache = stories;
    _storyQuillEditors = {};
    applyStoryFilters();
}

function debounceStoryFilter() {
    clearTimeout(_storyFilterTimer);
    _storyFilterTimer = setTimeout(() => applyStoryFilters(), 200);
}

function applyStoryFilters() {
    const container = document.getElementById('stories-list');
    if (!container) return;
    if (!_storiesCache.length) {
        container.innerHTML = '<div class="empty-state">No stories yet. Add or import your interview stories.</div>';
        return;
    }

    let filtered = [..._storiesCache];

    // Text search
    const searchQuery = (document.getElementById('story-search')?.value || '').toLowerCase().trim();
    if (searchQuery) {
        filtered = filtered.filter(s =>
            (s.title || '').toLowerCase().includes(searchQuery) ||
            (s.hook || '').toLowerCase().includes(searchQuery) ||
            (s.tags || '').toLowerCase().includes(searchQuery) ||
            (s.company || '').toLowerCase().includes(searchQuery) ||
            (s.competency || '').toLowerCase().includes(searchQuery)
        );
    }

    // Company filter
    if (storyFilters.company) {
        filtered = filtered.filter(s => storyFilters.company.has(s.company || '(No company)'));
    }

    // Competency filter
    if (storyFilters.competency) {
        filtered = filtered.filter(s => {
            const comps = (s.competency || '').split(',').map(c => c.trim()).filter(Boolean);
            if (!comps.length) return storyFilters.competency.has('(No competency)');
            return comps.some(c => storyFilters.competency.has(c));
        });
    }

    updateStoryFilterIndicator();

    storyGroupBy = document.getElementById('story-group-by')?.value || '';
    if (storyGroupBy) {
        renderStoriesGrouped(container, filtered, storyGroupBy);
    } else {
        if (!filtered.length) {
            container.innerHTML = '<div class="empty-state">No stories match the current filters. <a href="#" onclick="clearAllStoryFilters();return false;">Clear filters</a></div>';
        } else {
            container.innerHTML = filtered.map(s => renderStoryCard(s)).join('');
        }
    }
}

function renderStoryCard(story) {
    const contentHtml = story.content ? (looksLikeHtml(story.content) ? story.content : (looksLikeMarkdown(story.content) ? marked.parse(story.content) : `<p>${escapeHtml(story.content)}</p>`)) : '';

    const companyBadge = story.company ? `<span class="company-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M8 10h.01M16 10h.01M12 10h.01M8 14h.01M16 14h.01M12 14h.01"/></svg>${escapeHtml(story.company)}</span>` : '';

    const tagChips = story.tags ? story.tags.split(',').map(t =>
        `<span class="filter-chip chip-sm">${escapeHtml(t.trim())}</span>`).join('') : '';

    const competencyChips = story.competency ? story.competency.split(',').map(c =>
        `<span class="competency-chip chip-sm">${escapeHtml(c.trim())}</span>`).join('') : '';

    return `
    <div class="story-card" data-story-id="${story.id}">
        <div class="story-card-header" onclick="toggleStoryContent(${story.id})">
            <span class="story-card-chevron" id="bank-story-chevron-${story.id}">&#9654;</span>
            <div class="story-card-title-area">
                <h3>${escapeHtml(story.title)}</h3>
                ${story.hook ? `<p class="story-hook">${escapeHtml(story.hook)}</p>` : ''}
            </div>
            <div class="story-header-right">
                <div class="story-meta-right">${competencyChips}${tagChips}</div>
                <div class="story-company-col">${companyBadge}</div>
                <div class="story-card-actions" onclick="event.stopPropagation()">
                    <button class="btn btn-ghost btn-sm" onclick="showEditStory(${story.id})">Edit</button>
                    <button class="btn btn-danger btn-sm" onclick="handleDeleteStory(${story.id})">Delete</button>
                </div>
            </div>
        </div>
        <div class="story-expanded" id="story-content-${story.id}" style="display:none;">
            <div class="story-inline-meta" onclick="event.stopPropagation()">
                <div class="story-meta-fields-row">
                    <input type="text" class="input input-inline" id="inline-company-${story.id}" value="${escapeHtml(story.company || '')}" placeholder="Company" onblur="inlineStoryMetaSave(${story.id})" onkeydown="if(event.key==='Enter'){this.blur();}">
                    <input type="text" class="input input-inline" id="inline-tags-${story.id}" value="${escapeHtml(story.tags || '')}" placeholder="Tags (comma-separated)" onblur="inlineStoryMetaSave(${story.id})" onkeydown="if(event.key==='Enter'){this.blur();}">
                </div>
                <div class="competency-input-group">
                    <label class="form-label-sm">Competencies</label>
                    <div id="inline-competency-chips-${story.id}" class="competency-chip-container"></div>
                    <div class="competency-quick-picks" id="inline-competency-picks-${story.id}"></div>
                    <input type="text" id="inline-competency-input-${story.id}" class="input input-inline" placeholder="Add competency... (Enter)" onkeydown="if(event.key==='Enter'){this.blur();}">
                </div>
            </div>
            <div class="markdown-body">${contentHtml}</div>
        </div>
        <div class="story-edit-form" id="story-edit-${story.id}" style="display:none;">
            <div class="form-stack">
                <input type="text" class="input" id="edit-title-${story.id}" value="${escapeHtml(story.title)}" placeholder="Title">
                <input type="text" class="input" id="edit-hook-${story.id}" value="${escapeHtml(story.hook || '')}" placeholder="Hook">
                <div class="quill-resize-wrapper" id="edit-content-wrap-${story.id}" style="min-height:200px;">
                    <div id="edit-content-quill-${story.id}"></div>
                    <div class="resize-handle" data-target="edit-content-wrap-${story.id}"></div>
                </div>
            </div>
            <div class="form-row" style="margin-top:8px;">
                <button class="btn btn-primary btn-sm" onclick="handleSaveStoryEdit(${story.id})">Save</button>
                <button class="btn btn-ghost btn-sm" onclick="hideEditStory(${story.id})">Cancel</button>
            </div>
        </div>
    </div>`;
}

function renderStoriesGrouped(container, stories, groupKey) {
    const groups = new Map();
    for (const story of stories) {
        if (groupKey === 'competency') {
            const comps = (story.competency || '').split(',').map(c => c.trim()).filter(Boolean);
            if (!comps.length) comps.push('(No competency)');
            for (const comp of comps) {
                if (!groups.has(comp)) groups.set(comp, []);
                groups.get(comp).push(story);
            }
        } else {
            const key = story[groupKey] || `(No ${groupKey})`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(story);
        }
    }

    const sortedKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
    let html = '';

    for (const key of sortedKeys) {
        const groupStories = groups.get(key);
        const isCollapsed = collapsedStoryGroups.has(key);
        const chevron = isCollapsed ? '&#9654;' : '&#9660;';

        html += `<div class="story-group">
            <div class="story-group-header" onclick="toggleStoryGroup('${escapeHtml(key).replace(/'/g, "\\'")}')">
                <span class="group-chevron">${chevron}</span>
                <strong>${escapeHtml(key)}</strong>
                <span class="badge-count">${groupStories.length}</span>
            </div>`;
        if (!isCollapsed) {
            html += groupStories.map(s => renderStoryCard(s)).join('');
        }
        html += `</div>`;
    }

    container.innerHTML = html || '<div class="empty-state">No stories match the current filters. <a href="#" onclick="clearAllStoryFilters();return false;">Clear filters</a></div>';
}

function toggleStoryGroup(key) {
    if (collapsedStoryGroups.has(key)) collapsedStoryGroups.delete(key);
    else collapsedStoryGroups.add(key);
    applyStoryFilters();
}

// =================== Story Bank Filter Dropdowns ===================

function toggleStoryFilter(event, filterKey) {
    event.stopPropagation();
    if (_openStoryFilterColumn === filterKey) { closeStoryFilters(); return; }
    closeStoryFilters();
    _openStoryFilterColumn = filterKey;

    const btn = event.currentTarget;
    const valuesSet = new Set();
    for (const story of _storiesCache) {
        if (filterKey === 'company') {
            valuesSet.add(story.company || '(No company)');
        } else if (filterKey === 'competency') {
            const comps = (story.competency || '').split(',').map(c => c.trim()).filter(Boolean);
            if (!comps.length) valuesSet.add('(No competency)');
            comps.forEach(c => valuesSet.add(c));
        }
    }
    const values = [...valuesSet].sort((a, b) => a.localeCompare(b));
    const activeFilter = storyFilters[filterKey];

    let dropdownHtml = `<div class="col-filter-dropdown story-filter-dropdown" data-column="${filterKey}" onclick="event.stopPropagation()">`;
    if (values.length > 8) {
        dropdownHtml += `<div class="col-filter-search-wrap"><input type="text" class="input col-filter-search" placeholder="Search..." oninput="filterDropdownOptions(this)"></div>`;
    }
    dropdownHtml += `<div class="col-filter-actions">
        <button class="btn btn-ghost btn-sm" onclick="selectAllStoryFilterOptions('${filterKey}')">All</button>
        <button class="btn btn-ghost btn-sm" onclick="clearStoryFilterOptions('${filterKey}')">None</button>
    </div><div class="col-filter-options">`;
    for (const val of values) {
        const checked = !activeFilter || activeFilter.has(val) ? 'checked' : '';
        dropdownHtml += `<label class="col-filter-item"><input type="checkbox" value="${escapeHtml(val)}" ${checked}><span>${escapeHtml(val)}</span></label>`;
    }
    dropdownHtml += `</div></div>`;

    btn.insertAdjacentHTML('beforeend', dropdownHtml);
    const dropdown = btn.querySelector('.col-filter-dropdown');
    dropdown.addEventListener('change', () => applyStoryFilterFromDropdown(filterKey, dropdown));
}

function applyStoryFilterFromDropdown(filterKey, dropdown) {
    const checkboxes = dropdown.querySelectorAll('.col-filter-options input[type="checkbox"]');
    const checked = new Set();
    let allChecked = true;
    for (const cb of checkboxes) {
        if (cb.checked) checked.add(cb.value);
        else allChecked = false;
    }
    storyFilters[filterKey] = allChecked ? null : (checked.size > 0 ? checked : new Set(['__none__']));
    const btn = document.getElementById(`story-${filterKey}-filter-btn`);
    if (btn) btn.classList.toggle('active', !allChecked);
    applyStoryFilters();
}

function selectAllStoryFilterOptions(filterKey) {
    const dropdown = document.querySelector(`.story-filter-dropdown[data-column="${filterKey}"]`);
    if (!dropdown) return;
    dropdown.querySelectorAll('.col-filter-options input[type="checkbox"]').forEach(cb => cb.checked = true);
    applyStoryFilterFromDropdown(filterKey, dropdown);
}

function clearStoryFilterOptions(filterKey) {
    const dropdown = document.querySelector(`.story-filter-dropdown[data-column="${filterKey}"]`);
    if (!dropdown) return;
    dropdown.querySelectorAll('.col-filter-options input[type="checkbox"]').forEach(cb => cb.checked = false);
    applyStoryFilterFromDropdown(filterKey, dropdown);
}

function closeStoryFilters() {
    document.querySelectorAll('.story-filter-dropdown').forEach(el => el.remove());
    _openStoryFilterColumn = null;
}

function clearAllStoryFilters() {
    storyFilters = { company: null, competency: null };
    const searchEl = document.getElementById('story-search');
    if (searchEl) searchEl.value = '';
    document.querySelectorAll('#story-controls-bar .col-filter-btn.active').forEach(btn => btn.classList.remove('active'));
    applyStoryFilters();
}

function clearSingleStoryFilter(filterKey) {
    storyFilters[filterKey] = null;
    const btn = document.getElementById(`story-${filterKey}-filter-btn`);
    if (btn) btn.classList.remove('active');
    applyStoryFilters();
}

function updateStoryFilterIndicator() {
    const bar = document.getElementById('story-filter-indicator-bar');
    if (!bar) return;
    const active = [];
    if (storyFilters.company) active.push({ key: 'company', label: 'Company', count: storyFilters.company.size });
    if (storyFilters.competency) active.push({ key: 'competency', label: 'Competency', count: storyFilters.competency.size });
    const searchQuery = (document.getElementById('story-search')?.value || '').trim();
    if (searchQuery) active.push({ key: 'search', label: `Search: "${searchQuery}"` });

    if (!active.length) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    bar.innerHTML = active.map(f =>
        f.key === 'search'
            ? `<span class="filter-chip-active">${escapeHtml(f.label)} <button onclick="document.getElementById('story-search').value='';applyStoryFilters()">&times;</button></span>`
            : `<span class="filter-chip-active">${f.label} (${f.count}) <button onclick="clearSingleStoryFilter('${f.key}')">&times;</button></span>`
    ).join('') + `<button class="btn btn-ghost btn-sm" onclick="clearAllStoryFilters()" style="font-size:0.7rem;">Clear all</button>`;
}

function toggleStoryContent(storyId) {
    const el = document.getElementById(`story-content-${storyId}`);
    const chevron = document.getElementById(`bank-story-chevron-${storyId}`);
    const card = el.closest('.story-card');
    if (el.style.display === 'none') {
        el.style.display = 'block';
        if (chevron) chevron.style.transform = 'rotate(90deg)';
        if (card) card.classList.add('expanded');

        // Initialize inline competency picker on first expand
        const picksEl = document.getElementById(`inline-competency-picks-${storyId}`);
        if (picksEl && !picksEl.dataset.init) {
            picksEl.dataset.init = '1';
            initCompetencyPicker(
                `inline-competency-chips-${storyId}`,
                `inline-competency-input-${storyId}`,
                `inline-competency-picks-${storyId}`
            );
            const story = _storiesCache.find(s => s.id === storyId);
            if (story) setCompetencyValues(`inline-competency-chips-${storyId}`, story.competency);

            // Auto-save when competency changes (chip add/remove)
            const chipsContainer = document.getElementById(`inline-competency-chips-${storyId}`);
            if (chipsContainer) {
                const observer = new MutationObserver(() => inlineStoryMetaSave(storyId));
                observer.observe(chipsContainer, { childList: true });
            }
        }
    } else {
        el.style.display = 'none';
        if (chevron) chevron.style.transform = 'rotate(0deg)';
        if (card) card.classList.remove('expanded');
    }
}

function showEditStory(storyId) {
    const editForm = document.getElementById(`story-edit-${storyId}`);
    const contentEl = document.getElementById(`story-content-${storyId}`);
    editForm.style.display = 'block';
    contentEl.style.display = 'none';

    // Initialize Quill editor if not already done
    if (!_storyQuillEditors[storyId]) {
        const story = _storiesCache.find(s => s.id === storyId);
        const q = initQuill(`edit-content-quill-${storyId}`, QUILL_FULL_TOOLBAR, 'Full story content (SAIL format)...');
        if (q && story) {
            q.root.innerHTML = contentToHtml(story.content || '');
        }
        _storyQuillEditors[storyId] = q;
        initResizeHandles();
    }
}

function hideEditStory(storyId) {
    document.getElementById(`story-edit-${storyId}`).style.display = 'none';
    // Clean up Quill editor reference
    delete _storyQuillEditors[storyId];
}

async function handleSaveStoryEdit(storyId) {
    const title = document.getElementById(`edit-title-${storyId}`).value.trim();
    const hook = document.getElementById(`edit-hook-${storyId}`).value.trim();

    // Read content from Quill editor
    const quill = _storyQuillEditors[storyId];
    const content = quill ? _getQuillHtml(quill) : '';

    if (!title) { showToast('Title is required', 'warning'); return; }
    const result = await api.updateStory(storyId, { title, hook, content });
    if (result.error) {
        showToast(result.error, 'error');
    } else {
        showToast('Story updated', 'success');
        delete _storyQuillEditors[storyId];
        const stories = await api.getStories();
        renderStories(stories);
    }
}

// Auto-save inline metadata (company, tags, competency) on blur/change
let _inlineMetaSaveTimer = {};
async function inlineStoryMetaSave(storyId) {
    clearTimeout(_inlineMetaSaveTimer[storyId]);
    _inlineMetaSaveTimer[storyId] = setTimeout(async () => {
        const company = (document.getElementById(`inline-company-${storyId}`)?.value || '').trim();
        const tags = (document.getElementById(`inline-tags-${storyId}`)?.value || '').trim();
        const competency = getCompetencyValues(`inline-competency-chips-${storyId}`);

        const story = _storiesCache.find(s => s.id === storyId);
        if (!story) return;

        // Only save if something changed
        if (company === (story.company || '') && tags === (story.tags || '') && competency === (story.competency || '')) return;

        const result = await api.updateStory(storyId, { company, tags, competency });
        if (result.error) {
            showToast(result.error, 'error');
        } else {
            // Update cache silently — no toast for inline saves, just refresh chips in header
            story.company = company;
            story.tags = tags;
            story.competency = competency;

            // Update header chips without re-rendering the whole list
            const card = document.querySelector(`.story-card[data-story-id="${storyId}"]`);
            if (card) {
                // Update company column
                const compCol = card.querySelector('.story-company-col');
                if (compCol) compCol.innerHTML = company ? `<span class="company-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M8 10h.01M16 10h.01M12 10h.01M8 14h.01M16 14h.01M12 14h.01"/></svg>${escapeHtml(company)}</span>` : '';

                // Update competency + tag chips
                const metaRight = card.querySelector('.story-meta-right');
                const tagChips = tags ? tags.split(',').map(t => `<span class="filter-chip chip-sm">${escapeHtml(t.trim())}</span>`).join('') : '';
                const compChips = competency ? competency.split(',').map(c => `<span class="competency-chip chip-sm">${escapeHtml(c.trim())}</span>`).join('') : '';
                const chipsHtml = compChips + tagChips;
                if (chipsHtml) {
                    if (metaRight) {
                        metaRight.innerHTML = chipsHtml;
                    } else {
                        const actions = card.querySelector('.story-card-actions');
                        if (actions) actions.insertAdjacentHTML('beforebegin', `<div class="story-meta-right">${chipsHtml}</div>`);
                    }
                } else if (metaRight) {
                    metaRight.remove();
                }
            }
        }
    }, 300);
}

// Story UI toggles
function showStoryImport() {
    document.getElementById('story-import-area').style.display = 'block';
    document.getElementById('story-add-area').style.display = 'none';
    document.getElementById('story-builder-area').style.display = 'none';
}
function hideStoryImport() {
    document.getElementById('story-import-area').style.display = 'none';
}
let _quillAddStory = null;

function showAddStory() {
    document.getElementById('story-add-area').style.display = 'block';
    document.getElementById('story-import-area').style.display = 'none';
    document.getElementById('story-builder-area').style.display = 'none';

    // Initialize Quill for add story content
    if (!_quillAddStory) {
        _quillAddStory = initQuill('story-add-content-quill', QUILL_FULL_TOOLBAR, 'Full story content (SAIL format)...');
        initResizeHandles();
    }

    // Initialize competency picker for add form
    initCompetencyPicker('story-competency-chips', 'story-competency-input', 'story-competency-picks');
}
function hideAddStory() {
    document.getElementById('story-add-area').style.display = 'none';
    _quillAddStory = null;
}

async function handleImportStories() {
    const text = document.getElementById('story-import-text').value.trim();
    if (!text) {
        showToast('Paste your stories first', 'warning');
        return;
    }
    const result = await api.importStories(text);
    if (result.error) {
        showToast(result.error, 'error');
    } else {
        showToast(`Imported ${result.imported} stories`, 'success');
        hideStoryImport();
        document.getElementById('story-import-text').value = '';
        const stories = await api.getStories();
        renderStories(stories);
    }
}

async function handleAddStory() {
    const title = document.getElementById('story-title').value.trim();
    const hook = document.getElementById('story-hook').value.trim();
    const content = _quillAddStory ? _getQuillHtml(_quillAddStory) : '';
    const tags = document.getElementById('story-tags').value.trim();
    const company = (document.getElementById('story-company')?.value || '').trim();
    const competency = getCompetencyValues('story-competency-chips');

    if (!title) {
        showToast('Title is required', 'warning');
        return;
    }

    const result = await api.addStory({ title, hook, content, tags, company, competency });
    if (result.error) {
        showToast(result.error, 'error');
    } else {
        showToast('Story added', 'success');
        hideAddStory();
        document.getElementById('story-title').value = '';
        document.getElementById('story-hook').value = '';
        document.getElementById('story-tags').value = '';
        if (document.getElementById('story-company')) document.getElementById('story-company').value = '';
        setCompetencyValues('story-competency-chips', '');
        _quillAddStory = null;
        const stories = await api.getStories();
        renderStories(stories);
    }
}

async function handleDeleteStory(id) {
    await api.deleteStory(id);
    showToast('Story deleted', 'success');
    const stories = await api.getStories();
    renderStories(stories);
}

// Story Builder
function showStoryBuilder() {
    document.getElementById('story-builder-area').style.display = 'block';
    document.getElementById('story-add-area').style.display = 'none';
    document.getElementById('story-import-area').style.display = 'none';
    document.getElementById('builder-preview').style.display = 'none';
    _builderGeneratedContent = '';
}

function hideStoryBuilder() {
    document.getElementById('story-builder-area').style.display = 'none';
    document.getElementById('builder-preview').style.display = 'none';
    _builderGeneratedContent = '';
}

async function handleGenerateStory() {
    const title = document.getElementById('builder-title').value.trim();
    const bullet = document.getElementById('builder-bullet').value.trim();
    const context = document.getElementById('builder-context').value.trim();

    if (!bullet) {
        showToast('Paste a resume bullet point first', 'warning');
        return;
    }

    const btn = document.getElementById('btn-generate-story');
    btn.disabled = true;
    btn.textContent = 'Generating...';

    try {
        const result = await api.generateStory(title, bullet, context);
        if (result.error) {
            showToast(result.error, 'error');
            return;
        }
        _builderGeneratedContent = result.generated_content || '';
        document.getElementById('builder-preview-content').innerHTML = marked.parse(_builderGeneratedContent);
        document.getElementById('builder-preview').style.display = 'block';
        showToast('Story generated! Review and save.', 'success');
    } catch (e) {
        showToast('Generation failed: ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Generate Story';
    }
}

async function saveBuiltStory() {
    if (!_builderGeneratedContent) {
        showToast('No generated content to save', 'warning');
        return;
    }

    const title = document.getElementById('builder-title').value.trim() || 'Untitled Story';

    let hook = '';
    const hookMatch = _builderGeneratedContent.match(/###\s*Hook\s*\n+([\s\S]*?)(?=\n###|\n$|$)/i);
    if (hookMatch) {
        hook = hookMatch[1].trim();
    }

    const company = (document.getElementById('builder-company')?.value || '').trim();

    const result = await api.addStory({
        title: title,
        hook: hook,
        content: _builderGeneratedContent,
        tags: '',
        company: company,
    });

    if (result.error) {
        showToast(result.error, 'error');
    } else {
        showToast('Story saved to bank!', 'success');
        hideStoryBuilder();
        document.getElementById('builder-title').value = '';
        document.getElementById('builder-bullet').value = '';
        document.getElementById('builder-context').value = '';
        if (document.getElementById('builder-company')) document.getElementById('builder-company').value = '';
        const stories = await api.getStories();
        renderStories(stories);
    }
}

async function handleRefineStory() {
    const bullet = document.getElementById('builder-bullet').value.trim();
    const title = document.getElementById('builder-title').value.trim();
    const feedback = prompt('What would you like to change or improve?');
    if (!feedback) return;

    const btn = document.getElementById('btn-generate-story');
    btn.disabled = true;
    btn.textContent = 'Refining...';

    const refinedContext = `Previous draft:\n${_builderGeneratedContent}\n\nUser feedback: ${feedback}`;

    try {
        const result = await api.generateStory(title, bullet, refinedContext);
        if (result.error) {
            showToast(result.error, 'error');
            return;
        }
        _builderGeneratedContent = result.generated_content || '';
        document.getElementById('builder-preview-content').innerHTML = marked.parse(_builderGeneratedContent);
        showToast('Story refined!', 'success');
    } catch (e) {
        showToast('Refinement failed: ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Generate Story';
    }
}

// =================== Resume Bank ===================

let _resumesCache = [];

function renderResumeBank(resumes) {
    _resumesCache = resumes;
    const container = document.getElementById('resume-bank-list');
    if (!container) return;
    if (!resumes.length) {
        container.innerHTML = '<div class="empty-state">No resumes uploaded yet. Upload a .docx resume to get started.</div>';
        return;
    }
    container.innerHTML = resumes.map(r => {
        const date = r.uploaded_at ? new Date(r.uploaded_at).toLocaleDateString() : '';
        const safeName = escapeHtml(r.name).replace(/'/g, "\\'");
        return `
        <div class="resume-bank-card" data-resume-id="${r.id}" onclick="openResumeCard(${r.id}, '${safeName}')" style="cursor:pointer;">
            <div class="resume-bank-info">
                <h3 class="resume-bank-name">${escapeHtml(r.name)}</h3>
                <span class="resume-bank-meta">${escapeHtml(r.original_filename || '')}${date ? ' \u2014 ' + date : ''}</span>
            </div>
            <div class="resume-bank-actions" onclick="event.stopPropagation()">
                <button class="btn btn-ghost btn-sm" onclick="handleRenameResume(${r.id}, this)">Rename</button>
                <button class="btn btn-danger btn-sm" onclick="handleDeleteResume(${r.id})">Delete</button>
            </div>
        </div>`;
    }).join('');
}

async function handleResumeBankUpload(e) {
    e.preventDefault();
    const fileInput = document.getElementById('resume-bank-file');
    if (!fileInput.files.length) return;
    const formData = new FormData();
    formData.append('file', fileInput.files[0]);

    try {
        const resp = await fetch('/api/resumes/upload', { method: 'POST', body: formData });
        const result = await resp.json();
        if (result.error) {
            showToast(result.error, 'error');
        } else {
            showToast(`Resume uploaded: ${result.sections} sections`, 'success');
            const resumes = await api.getResumes();
            renderResumeBank(resumes);
        }
    } catch (err) {
        showToast('Upload failed: ' + err.message, 'error');
    } finally {
        fileInput.value = '';
    }
}

async function handleRenameResume(id, btn) {
    const card = btn.closest('.resume-bank-card');
    const nameEl = card.querySelector('.resume-bank-name');
    const current = nameEl.textContent;
    const newName = prompt('Rename resume:', current);
    if (!newName || newName.trim() === current) return;

    const result = await api.renameResume(id, newName.trim());
    if (result.error) {
        showToast(result.error, 'error');
    } else {
        showToast('Resume renamed', 'success');
        nameEl.textContent = newName.trim();
    }
}

async function handleDeleteResume(id) {
    if (!confirm('Delete this resume? This cannot be undone.')) return;
    await api.deleteResume(id);
    showToast('Resume deleted', 'success');
    const resumes = await api.getResumes();
    renderResumeBank(resumes);
}

// =================== Activity Sidebar ===================

let _sidebarOpen = false;

function toggleActivitySidebar() {
    const sidebar = document.getElementById('activity-sidebar');
    const pullTab = document.getElementById('sidebar-pull-tab');
    _sidebarOpen = !_sidebarOpen;
    sidebar.classList.toggle('open', _sidebarOpen);
    if (pullTab) {
        pullTab.classList.toggle('open', _sidebarOpen);
        const edgeLabel = pullTab.querySelector('.edge-label');
        if (edgeLabel) edgeLabel.textContent = _sidebarOpen ? 'Hide' : 'Activity';
    }
    // Reset inline resize styles when closing
    if (!_sidebarOpen) {
        sidebar.style.width = '';
        sidebar.style.minWidth = '';
    }
    if (_sidebarOpen && expandedJobId) {
        loadSidebarActivity(expandedJobId);
    }
}

// Click toggles sidebar; but if sidebar is open and user drags, it resizes instead
let _edgeMouseDownX = null;
function handleEdgeHandleClick(e) {
    // If sidebar is open, only toggle on pure click (no drag)
    if (_sidebarOpen) {
        // The resize handler in initResizeHandles manages drag.
        // Only toggle if this was a clean click (mousedown + mouseup with <5px movement)
        // We track this via a flag set in mousedown
        if (!_edgeDragged) toggleActivitySidebar();
    } else {
        toggleActivitySidebar();
    }
    _edgeDragged = false;
}
let _edgeDragged = false;

async function loadSidebarActivity(jobId) {
    const timeline = document.getElementById('sidebar-timeline');
    timeline.innerHTML = '<div class="empty-state">Loading...</div>';
    try {
        const data = await api.getActivityLog(jobId);
        renderSidebarTimeline(data.entries || []);
    } catch (e) {
        timeline.innerHTML = '<div class="empty-state">Failed to load.</div>';
    }
}

function renderSidebarTimeline(entries) {
    const timeline = document.getElementById('sidebar-timeline');
    if (!entries.length) {
        timeline.innerHTML = '<div class="empty-state">No thoughts yet. Jot something down.</div>';
        return;
    }
    // Newest first
    const sorted = [...entries].reverse();
    timeline.innerHTML = sorted.map(entry => {
        const timeStr = entry.ts ? formatRelativeTime(entry.ts) : '';
        const dateStr = entry.ts ? new Date(entry.ts).toLocaleString() : '';
        const isSystem = entry.type === 'system';
        const len = (entry.text || '').length;
        const sizeClass = isSystem ? 'bubble-system' : (len <= 30 ? 'bubble-sm' : len <= 100 ? 'bubble-md' : 'bubble-lg');
        const typeClass = isSystem ? 'system-event' : '';
        return `
            <div class="timeline-entry ${isSystem ? 'system-entry' : ''}">
                <div class="timeline-bubble ${sizeClass} ${typeClass}">
                    ${isSystem ? '<span class="system-icon">\u26A1</span> ' : ''}${escapeHtml(entry.text)}
                    <div class="bubble-time" title="${dateStr}">${timeStr}</div>
                </div>
            </div>
        `;
    }).join('');
}

function formatRelativeTime(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now - date;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    if (diffDay < 30) return `${diffDay}d ago`;
    return `${Math.floor(diffDay / 30)}mo ago`;
}

async function handleSidebarAddEntry() {
    if (!expandedJobId) return;
    const input = document.getElementById('sidebar-activity-input');
    const text = input.value.trim();
    if (!text) return;
    try {
        await api.addActivityEntry(expandedJobId, text, 'note');
        input.value = '';
        await loadSidebarActivity(expandedJobId);
    } catch (e) {
        showToast('Failed to add entry', 'error');
    }
}

// Auto-log system events for key lifecycle actions
async function logSystemEvent(jobId, text) {
    if (!jobId) return;
    try {
        await api.addActivityEntry(jobId, text, 'system');
        // Refresh sidebar if it's open and showing this job
        if (_sidebarOpen && expandedJobId === jobId) {
            await loadSidebarActivity(jobId);
        }
    } catch (e) {
        // Silent fail — don't block user actions for logging
    }
}

// =================== Interview Timeline & Stages ===================

let _stagesCache = [];
let _selectedStageId = null;
let _stageStoriesCache = [];
let _versionsCache = [];
let _insightsCache = [];
let _stageNotesSaveTimer = null;
let _liveNotesSaveTimer = null;

// Quill editor instances
let _quillGamePlan = null;
let _quillLiveNotes = null;
let _quillDebriefWentWell = null;
let _quillDebriefToImprove = null;
let _quillDebriefQuestionsAsked = null;
let _quillDebriefFollowup = null;
let _quillInterviewerNotes = null;
let _quillStoryEdit = null; // current inline story editor

const QUILL_FULL_TOOLBAR = [
    [{ 'header': [1, 2, 3, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ 'list': 'ordered' }, { 'list': 'bullet' }, { 'list': 'check' }],
    [{ 'indent': '-1' }, { 'indent': '+1' }],
    ['blockquote', 'code-block'],
    ['link', 'image'],
    ['clean']
];

const QUILL_MINI_TOOLBAR = [
    ['bold', 'italic', 'underline'],
    [{ 'list': 'ordered' }, { 'list': 'bullet' }],
    ['link', 'image'],
    ['clean']
];

function initQuill(containerId, toolbar, placeholder, onChange) {
    const container = document.getElementById(containerId);
    if (!container) return null;

    // Remove any previous Quill toolbar siblings (Snow theme inserts them before the container)
    const parent = container.parentElement;
    if (parent) {
        parent.querySelectorAll('.ql-toolbar').forEach(tb => tb.remove());
    }
    // Strip Quill classes from the container so it re-initializes cleanly
    container.className = '';
    container.innerHTML = '';

    const q = new Quill(`#${containerId}`, {
        theme: 'snow',
        modules: {
            toolbar: toolbar,
            clipboard: { matchVisual: false }
        },
        placeholder: placeholder || ''
    });
    if (onChange) {
        q.on('text-change', () => onChange(q));
    }

    // --- Image support: paste, drop, and toolbar button ---

    // Matcher: preserve <img> tags from pasted HTML (e.g. copy-paste from web pages)
    q.clipboard.addMatcher('IMG', (node, delta) => {
        const src = node.getAttribute('src');
        if (src) {
            const Delta = Quill.import('delta');
            return new Delta().insert({ image: src });
        }
        return delta;
    });

    function insertImageFile(file) {
        if (!file || !file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            const range = q.getSelection(true);
            q.insertEmbed(range.index, 'image', e.target.result, Quill.sources.USER);
            q.setSelection(range.index + 1, Quill.sources.SILENT);
        };
        reader.readAsDataURL(file);
    }

    // Attach to the PARENT of q.root (.ql-container) so our capture-phase handler
    // fires BEFORE Quill's own capture-phase handler on q.root. In capture phase,
    // events travel outer→inner, so parent fires first. stopPropagation() then
    // prevents the event from ever reaching Quill's handler.
    const editorParent = q.root.parentNode;

    // Clipboard paste (screenshots, copied images)
    editorParent.addEventListener('paste', (e) => {
        const clipboard = e.clipboardData || e.originalEvent?.clipboardData;
        if (!clipboard) return;
        const items = clipboard.items;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.stopPropagation();
                e.preventDefault();
                insertImageFile(item.getAsFile());
                return;
            }
        }
        // Non-image paste: don't stop propagation, let Quill handle normally
    }, true);

    // Drag-and-drop image files
    editorParent.addEventListener('drop', (e) => {
        const files = e.dataTransfer?.files;
        if (files && files.length) {
            for (const file of files) {
                if (file.type.startsWith('image/')) {
                    e.stopPropagation();
                    e.preventDefault();
                    insertImageFile(file);
                    return;
                }
            }
        }
    }, true);

    // Toolbar image button — open file picker
    const toolbarModule = q.getModule('toolbar');
    if (toolbarModule) {
        toolbarModule.addHandler('image', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.onchange = () => {
                if (input.files && input.files[0]) {
                    insertImageFile(input.files[0]);
                }
            };
            input.click();
        });
    }

    setupCollapsibleHeadings(q);
    return q;
}

// --- Collapsible headings (Notion-style toggle) ---

function setupCollapsibleHeadings(quill) {
    quill.root.addEventListener('click', (e) => {
        const heading = e.target.closest('h1, h2, h3');
        if (!heading || !quill.root.contains(heading)) return;

        // Only toggle if click was in the arrow area (left padding, ~24px)
        const rect = heading.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        if (clickX > 26) return;

        e.preventDefault();
        const isCollapsed = heading.hasAttribute('data-collapsed');
        toggleHeadingSection(heading, !isCollapsed);
    });
}

function toggleHeadingSection(heading, collapse) {
    const headingLevel = parseInt(heading.tagName[1]);

    if (collapse) {
        heading.setAttribute('data-collapsed', '');
    } else {
        heading.removeAttribute('data-collapsed');
    }

    // Toggle visibility of everything under this heading until the next heading of same/higher level
    let sibling = heading.nextElementSibling;
    while (sibling) {
        if (/^H[1-3]$/i.test(sibling.tagName) && parseInt(sibling.tagName[1]) <= headingLevel) break;
        if (collapse) {
            sibling.classList.add('toggle-hidden');
        } else {
            sibling.classList.remove('toggle-hidden');
        }
        sibling = sibling.nextElementSibling;
    }

    // When expanding, re-collapse content under any nested sub-headings that are still collapsed
    if (!collapse) {
        sibling = heading.nextElementSibling;
        while (sibling) {
            if (/^H[1-3]$/i.test(sibling.tagName)) {
                const sibLevel = parseInt(sibling.tagName[1]);
                if (sibLevel <= headingLevel) break;
                if (sibling.hasAttribute('data-collapsed')) {
                    let inner = sibling.nextElementSibling;
                    while (inner) {
                        if (/^H[1-3]$/i.test(inner.tagName) && parseInt(inner.tagName[1]) <= sibLevel) break;
                        inner.classList.add('toggle-hidden');
                        inner = inner.nextElementSibling;
                    }
                }
            }
            sibling = sibling.nextElementSibling;
        }
    }
}

// Detect if content looks like HTML (starts with a tag)
function looksLikeHtml(str) {
    if (!str) return false;
    return /^\s*<[a-z][\s\S]*>/i.test(str);
}

// Detect if content looks like markdown (has markdown syntax markers)
function looksLikeMarkdown(str) {
    if (!str || looksLikeHtml(str)) return false;
    return /(?:^|\n)#{1,3}\s|\*\*\w|^\*[^*]|\n- |\n\d+\. |\[.*\]\(.*\)/.test(str);
}

// Convert content to HTML for Quill: handles markdown (legacy), HTML, or plain text
function contentToHtml(content) {
    if (!content) return '';
    // Already HTML — use directly
    if (looksLikeHtml(content)) return content;
    // Markdown — parse it
    if (looksLikeMarkdown(content)) return marked.parse(content);
    // Plain text — wrap lines in <p> tags for Quill
    return content.split('\n').map(line => `<p>${line || '<br>'}</p>`).join('');
}

// Strip HTML to plain text for AI context
function htmlToPlainText(html) {
    if (!html) return '';
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
}

// Setup drag-to-resize for .quill-resize-wrapper
function initResizeHandles() {
    document.querySelectorAll('.resize-handle').forEach(handle => {
        if (handle._resizeInit) return;
        handle._resizeInit = true;
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const targetId = handle.dataset.target;
            const wrapper = document.getElementById(targetId);
            if (!wrapper) return;
            const startY = e.clientY;
            const startH = wrapper.offsetHeight;
            function onMove(ev) {
                const newH = Math.max(80, startH + (ev.clientY - startY));
                wrapper.style.height = newH + 'px';
            }
            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    });
}

async function loadExpandedInterviewPhase(jobId) {
    currentInterviewJobId = jobId;

    // Load stages + insights in parallel
    const [stagesRes, insights] = await Promise.all([
        api.getStages(jobId),
        api.getInsights(jobId),
    ]);
    _stagesCache = stagesRes.stages || [];
    _insightsCache = insights;

    renderTimeline();
    renderInsightsFeed(insights);

    // Auto-select first "current" stage, or first stage
    const currentStage = _stagesCache.find(s => s.status === 'current') || _stagesCache[0];
    if (currentStage) {
        await selectStage(currentStage.id);
    } else {
        showStageEmpty();
    }
}

// ---- Timeline Rendering ----

function renderTimeline() {
    const container = document.getElementById('stage-timeline-nodes');
    if (!container) return;

    let html = _stagesCache.map(stage => {
        const isActive = stage.id === _selectedStageId;
        const statusIcon = stage.status === 'completed' ? '&#x2713;'
            : stage.status === 'current' ? '&#x25CF;'
            : '&#x25CB;';
        return `
            <div class="stage-node ${isActive ? 'active' : ''}" data-stage-id="${stage.id}" data-status="${stage.status}"
                 onclick="selectStage(${stage.id})" draggable="true"
                 ondragstart="handleStageDragStart(event, ${stage.id})"
                 ondragover="handleStageDragOver(event)"
                 ondrop="handleStageDrop(event, ${stage.id})">
                <div class="stage-node-dot">${statusIcon}</div>
                <div class="stage-node-label" title="${escapeHtml(stage.name)}">${escapeHtml(stage.name)}</div>
            </div>
        `;
    }).join('');

    // Inline "+ Add" node at end of timeline
    html += `
        <div class="stage-node stage-add-node" onclick="handleAddStage()" title="Add interview stage">
            <div class="stage-node-dot">+</div>
            <div class="stage-node-label">Add Stage</div>
        </div>
    `;
    container.innerHTML = html;
}

function showStageEmpty() {
    _selectedStageId = null;
    document.getElementById('stage-detail-empty').style.display = 'block';
    document.getElementById('stage-detail-content').style.display = 'none';
}

async function selectStage(stageId) {
    _selectedStageId = stageId;
    const stage = _stagesCache.find(s => s.id === stageId);
    if (!stage) { showStageEmpty(); return; }

    // Update timeline active highlight
    document.querySelectorAll('.stage-node').forEach(n => {
        n.classList.toggle('active', parseInt(n.dataset.stageId) === stageId);
    });

    // Show stage detail
    document.getElementById('stage-detail-empty').style.display = 'none';
    document.getElementById('stage-detail-content').style.display = 'block';

    // Populate fields
    document.getElementById('stage-name-input').value = stage.name || '';
    document.getElementById('stage-status-select').value = stage.status || 'upcoming';

    // Initialize Game Plan Quill editor
    _quillGamePlan = initQuill('stage-notes-editor', QUILL_FULL_TOOLBAR, 'Prep notes for this round... (auto-saves)', () => {
        clearTimeout(_stageNotesSaveTimer);
        _stageNotesSaveTimer = setTimeout(() => saveStageNotes(), 800);
    });
    if (_quillGamePlan && stage.notes) {
        const html = contentToHtml(stage.notes);
        _quillGamePlan.root.innerHTML = html;
    }

    // Initialize Live Notes Quill editor
    _quillLiveNotes = initQuill('live-notes-editor', QUILL_FULL_TOOLBAR, 'Jot notes during the interview... (auto-saves)', () => {
        clearTimeout(_liveNotesSaveTimer);
        _liveNotesSaveTimer = setTimeout(() => saveLiveNotes(), 800);
    });
    if (_quillLiveNotes && stage.live_notes) {
        const html = contentToHtml(stage.live_notes);
        _quillLiveNotes.root.innerHTML = html;
    }

    // Init resize handles
    initResizeHandles();

    // Load interviewer intel, questions, debrief
    loadInterviewerData(stage);
    loadQuestions(stage);
    loadDebrief(stage);

    // Load assigned stories
    await loadStageStories(stageId);

    // Show/hide "Copy from Stage" button
    updateCopyFromStageVisibility();

    // Load whiteboard + mock interviews
    initStageWhiteboard(stage);
    loadMockInterviews(stageId);

    // Update section visibility based on status
    updateStageSectionVisibility(stage.status || 'upcoming');
}

// ---- Stage CRUD Handlers ----

async function handleAddStage() {
    if (!expandedJobId) return;

    try {
        const result = await api.addStage(expandedJobId, 'New Stage');
        if (result.error) { showToast(result.error, 'error'); return; }
        logSystemEvent(expandedJobId, 'Interview stage added');
        const res = await api.getStages(expandedJobId);
        _stagesCache = res.stages || [];
        renderTimeline();
        if (result.id) {
            await selectStage(result.id);
            // Focus name input with text selected so user can immediately rename
            requestAnimationFrame(() => {
                const nameInput = document.getElementById('stage-name-input');
                if (nameInput) { nameInput.focus(); nameInput.select(); }
            });
        }
    } catch (e) {
        showToast('Failed to add stage', 'error');
    }
}

async function handleStageNameChange() {
    if (!_selectedStageId || !expandedJobId) return;
    const name = document.getElementById('stage-name-input').value.trim();
    if (!name) return;
    try {
        await api.updateStage(expandedJobId, _selectedStageId, { name });
        const stage = _stagesCache.find(s => s.id === _selectedStageId);
        if (stage) stage.name = name;
        renderTimeline();
    } catch (e) {
        showToast('Failed to rename stage', 'error');
    }
}

async function handleStageStatusChange() {
    if (!_selectedStageId || !expandedJobId) return;
    const status = document.getElementById('stage-status-select').value;
    try {
        await api.updateStage(expandedJobId, _selectedStageId, { status });
        const stage = _stagesCache.find(s => s.id === _selectedStageId);
        const stageName = stage ? stage.name : 'Stage';
        if (stage) stage.status = status;
        logSystemEvent(expandedJobId, `${stageName} → ${status}`);
        renderTimeline();
        updateStageSectionVisibility(status);
    } catch (e) {
        showToast('Failed to update status', 'error');
    }
}

function updateStageSectionVisibility(status) {
    const liveNotes = document.getElementById('section-live-notes');
    const debrief = document.getElementById('section-debrief');
    const hint = document.getElementById('stage-status-hint');
    const hintText = document.getElementById('stage-status-hint-text');

    // Live Notes: visible when current or completed
    if (liveNotes) liveNotes.style.display = (status === 'current' || status === 'completed') ? '' : 'none';

    // Debrief: visible only when completed
    if (debrief) debrief.style.display = status === 'completed' ? '' : 'none';

    // Status hint banner
    if (hint && hintText) {
        if (status === 'upcoming') {
            hint.style.display = '';
            hintText.textContent = 'Set status to "Current" when the interview starts to begin taking Live Notes.';
        } else if (status === 'current') {
            hint.style.display = '';
            hintText.textContent = 'Set status to "Completed" when you\'re done to write your Debrief.';
        } else {
            hint.style.display = 'none';
        }
    }
}

async function advanceStageStatus() {
    const select = document.getElementById('stage-status-select');
    if (!select) return;
    const current = select.value;
    const next = current === 'upcoming' ? 'current' : current === 'current' ? 'completed' : null;
    if (!next) return;
    select.value = next;
    await handleStageStatusChange();
}

async function saveStageNotes() {
    if (!_selectedStageId || !expandedJobId || !_quillGamePlan) return;
    const notes = _quillGamePlan.root.innerHTML;
    // Don't save if editor is empty (just <p><br></p>)
    const cleanNotes = (notes === '<p><br></p>' || notes === '<p></p>') ? '' : notes;
    try {
        await api.updateStage(expandedJobId, _selectedStageId, { notes: cleanNotes });
        const stage = _stagesCache.find(s => s.id === _selectedStageId);
        if (stage) stage.notes = cleanNotes;
    } catch (e) {
        // Silent fail for auto-save
    }
}

async function saveLiveNotes() {
    if (!_selectedStageId || !expandedJobId || !_quillLiveNotes) return;
    const notes = _quillLiveNotes.root.innerHTML;
    const cleanNotes = (notes === '<p><br></p>' || notes === '<p></p>') ? '' : notes;
    try {
        await api.updateStage(expandedJobId, _selectedStageId, { live_notes: cleanNotes });
        const stage = _stagesCache.find(s => s.id === _selectedStageId);
        if (stage) stage.live_notes = cleanNotes;
    } catch (e) {
        // Silent fail for auto-save
    }
}

async function handleDeleteStage() {
    if (!_selectedStageId || !expandedJobId) return;
    const stage = _stagesCache.find(s => s.id === _selectedStageId);
    if (!confirm(`Delete "${stage ? stage.name : 'this stage'}"? Assigned stories will be unlinked.`)) return;

    try {
        await api.deleteStage(expandedJobId, _selectedStageId);
        _stagesCache = _stagesCache.filter(s => s.id !== _selectedStageId);
        renderTimeline();
        // Select next available stage
        if (_stagesCache.length) {
            await selectStage(_stagesCache[0].id);
        } else {
            showStageEmpty();
        }
        showToast('Stage deleted', 'success');
    } catch (e) {
        showToast('Failed to delete stage', 'error');
    }
}

// ---- Stage Drag-to-Reorder ----

let _draggedStageId = null;

function handleStageDragStart(e, stageId) {
    _draggedStageId = stageId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', stageId);
}

function handleStageDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
}

async function handleStageDrop(e, targetStageId) {
    e.preventDefault();
    if (!_draggedStageId || _draggedStageId === targetStageId) return;

    // Reorder: move dragged before target
    const ids = _stagesCache.map(s => s.id);
    const fromIdx = ids.indexOf(_draggedStageId);
    const toIdx = ids.indexOf(targetStageId);
    if (fromIdx === -1 || toIdx === -1) return;

    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, _draggedStageId);

    try {
        await api.reorderStages(expandedJobId, ids);
        // Re-fetch to get updated order
        const res = await api.getStages(expandedJobId);
        _stagesCache = res.stages || [];
        renderTimeline();
    } catch (e) {
        showToast('Failed to reorder', 'error');
    }
    _draggedStageId = null;
}

// ---- Assigned Stories ----

async function loadStageStories(stageId) {
    if (!expandedJobId) return;
    const container = document.getElementById('stage-assigned-stories');
    if (!container) return;

    try {
        const res = await api.getStageStories(expandedJobId, stageId);
        _stageStoriesCache = res.stories || [];
        renderAssignedStories();
    } catch (e) {
        container.innerHTML = '<div class="empty-state">Failed to load stories.</div>';
    }
}

function renderAssignedStories() {
    const container = document.getElementById('stage-assigned-stories');
    if (!container) return;

    if (!_stageStoriesCache.length) {
        container.innerHTML = '<div class="empty-state">No stories assigned. Click "+ Add Story" to get started.</div>';
        setupAssignedStoriesDropZone();
        return;
    }

    container.innerHTML = _stageStoriesCache.map(story => {
        const sid = story.story_id || story.id;
        const hasCustom = !!story.custom_content;
        const displayContent = story.custom_content || story.content || '';

        return `
            <div class="assigned-story-card ${hasCustom ? 'has-custom-content' : ''}" data-story-id="${sid}" draggable="true"
                 ondragstart="handleAssignedStoryDragStart(event, ${sid})"
                 ondragend="handleAssignedStoryDragEnd()">
                <span class="assigned-story-drag-handle" title="Drag to reorder">&#x2630;</span>
                <div class="assigned-story-info" onclick="toggleAssignedStoryContent(${sid})" style="cursor:pointer;">
                    <h4>
                        <span class="story-expand-chevron" id="story-chevron-${sid}">&#x25B6;</span>
                        ${escapeHtml(story.title)}${hasCustom ? ' <span class="custom-badge">edited</span>' : ''}
                    </h4>
                    ${story.hook ? `<p class="story-hook-text">${escapeHtml(story.hook)}</p>` : ''}
                    ${story.tags ? `<div class="story-tags" style="margin-top:0.15rem;">${story.tags.split(',').map(t =>
                        `<span class="filter-chip chip-sm">${escapeHtml(t.trim())}</span>`
                    ).join('')}</div>` : ''}
                    <div class="assigned-story-body" id="story-body-${sid}" style="display:none;">
                        <div class="markdown-body">${displayContent ? (looksLikeMarkdown(displayContent) ? marked.parse(displayContent) : displayContent) : '<em>No content</em>'}</div>
                    </div>
                </div>
                <div class="assigned-story-actions">
                    ${story.stage_only ? `<button class="btn btn-ghost btn-sm btn-save-bank" onclick="event.stopPropagation();handlePromoteToBank(${sid})" title="Save to Story Bank for other interviews">Save to Bank</button>` : ''}
                    <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();handleEditStoryForStage(${sid})" title="Edit this copy">Edit</button>
                    <button class="btn btn-ghost btn-sm btn-danger-hover" onclick="event.stopPropagation();handleRemoveStoryFromStage(${sid})" title="Remove">&times;</button>
                </div>
            </div>
        `;
    }).join('');

    // Setup drop zone for stories from picker
    setupAssignedStoriesDropZone();
}

let _draggedAssignedStoryId = null;

function setupAssignedStoriesDropZone() {
    const container = document.getElementById('stage-assigned-stories');
    if (!container) return;

    // Container-level: accept drops from the story picker (copy into stage)
    container.ondragover = (e) => {
        if (e.dataTransfer.types.includes('application/story-id')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = _draggedAssignedStoryId ? 'move' : 'copy';
        }
    };
    container.ondragleave = (e) => {
        // Only remove if actually leaving the container
        if (!container.contains(e.relatedTarget)) {
            container.classList.remove('drag-over');
            container.querySelectorAll('.drag-above, .drag-below').forEach(el => {
                el.classList.remove('drag-above', 'drag-below');
            });
        }
    };
    container.ondrop = async (e) => {
        e.preventDefault();
        container.classList.remove('drag-over');
        container.querySelectorAll('.drag-above, .drag-below').forEach(el => {
            el.classList.remove('drag-above', 'drag-below');
        });
        const storyId = parseInt(e.dataTransfer.getData('application/story-id'));
        // If not a reorder (came from picker), assign the story
        if (storyId && _selectedStageId && !_draggedAssignedStoryId) {
            await handleAssignStoryToStage(storyId);
        }
        _draggedAssignedStoryId = null;
    };

    // Per-card: dragover + drop for reordering
    container.querySelectorAll('.assigned-story-card').forEach(card => {
        card.ondragover = (e) => {
            if (!_draggedAssignedStoryId) return; // only reorder when dragging an assigned story
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';

            // Determine top/bottom half
            const rect = card.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            card.classList.toggle('drag-above', e.clientY < midY);
            card.classList.toggle('drag-below', e.clientY >= midY);
        };

        card.ondragleave = () => {
            card.classList.remove('drag-above', 'drag-below');
        };

        card.ondrop = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            card.classList.remove('drag-above', 'drag-below');

            if (!_draggedAssignedStoryId) return;

            const targetId = parseInt(card.dataset.storyId);
            if (_draggedAssignedStoryId === targetId) { _draggedAssignedStoryId = null; return; }

            // Determine insertion position
            const rect = card.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            const insertBefore = e.clientY < midY;

            // Reorder in cache
            const fromIdx = _stageStoriesCache.findIndex(s => (s.story_id || s.id) === _draggedAssignedStoryId);
            const toIdx = _stageStoriesCache.findIndex(s => (s.story_id || s.id) === targetId);
            if (fromIdx === -1 || toIdx === -1) { _draggedAssignedStoryId = null; return; }

            const [moved] = _stageStoriesCache.splice(fromIdx, 1);
            let newIdx = _stageStoriesCache.findIndex(s => (s.story_id || s.id) === targetId);
            if (!insertBefore) newIdx += 1;
            _stageStoriesCache.splice(newIdx, 0, moved);

            // Re-render immediately for snappy feedback
            renderAssignedStories();

            // Persist new order
            const orderedIds = _stageStoriesCache.map(s => s.story_id || s.id);
            try {
                await api.reorderStageStories(expandedJobId, _selectedStageId, orderedIds);
            } catch (err) {
                showToast('Failed to save order', 'error');
            }

            _draggedAssignedStoryId = null;
        };
    });
}

async function handleAssignStoryToStage(storyId) {
    if (!expandedJobId || !_selectedStageId) return;
    // Check if already assigned
    if (_stageStoriesCache.some(s => (s.story_id || s.id) === storyId)) {
        showToast('Story already assigned', 'warning');
        return;
    }
    try {
        await api.assignStoryToStage(expandedJobId, _selectedStageId, storyId);
        await loadStageStories(_selectedStageId);
        showToast('Story assigned', 'success');
        // Re-render picker if open
        if (document.getElementById('story-picker-overlay').style.display !== 'none') {
            await renderStoryPicker();
        }
    } catch (e) {
        showToast('Failed to assign story', 'error');
    }
}

async function handleRemoveStoryFromStage(storyId) {
    if (!expandedJobId || !_selectedStageId) return;
    try {
        await api.removeStoryFromStage(expandedJobId, _selectedStageId, storyId);
        _stageStoriesCache = _stageStoriesCache.filter(s => (s.story_id || s.id) !== storyId);
        renderAssignedStories();
        showToast('Story removed', 'success');
        // Re-render picker if open
        if (document.getElementById('story-picker-overlay').style.display !== 'none') {
            await renderStoryPicker();
        }
    } catch (e) {
        showToast('Failed to remove story', 'error');
    }
}

function handleAssignedStoryDragStart(e, storyId) {
    _draggedAssignedStoryId = storyId;
    e.dataTransfer.setData('application/story-id', String(storyId));
    e.dataTransfer.effectAllowed = 'move';
    // Add a drag ghost effect
    requestAnimationFrame(() => {
        const card = e.target.closest('.assigned-story-card');
        if (card) card.classList.add('dragging');
    });
}

function handleAssignedStoryDragEnd() {
    _draggedAssignedStoryId = null;
    document.querySelectorAll('.assigned-story-card.dragging').forEach(el => el.classList.remove('dragging'));
    document.querySelectorAll('.drag-above, .drag-below').forEach(el => el.classList.remove('drag-above', 'drag-below'));
}

function toggleAssignedStoryContent(storyId) {
    const body = document.getElementById(`story-body-${storyId}`);
    const chevron = document.getElementById(`story-chevron-${storyId}`);
    if (!body) return;
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : 'block';
    if (chevron) chevron.innerHTML = isOpen ? '&#x25B6;' : '&#x25BC;';
}

// ---- Story Picker Modal ----

async function openStoryPicker() {
    document.getElementById('story-picker-overlay').style.display = 'flex';
    await renderStoryPicker();
}

function closeStoryPicker() {
    document.getElementById('story-picker-overlay').style.display = 'none';
    // Reset to browse view if in create mode
    const createPanel = document.getElementById('story-picker-create');
    if (createPanel && createPanel.style.display !== 'none') {
        hidePickerCreateForm();
    }
    _quillPickerNewContent = null;
}

async function renderStoryPicker() {
    const container = document.getElementById('story-picker-browse');
    if (!container) return;

    const stories = await api.getStories(true); // include stage-only stories for assignment tracking
    _storiesCache = stories;
    const assignedIds = new Set(_stageStoriesCache.map(s => s.story_id || s.id));

    if (!stories.length) {
        container.innerHTML = '<div class="empty-state">No stories yet. Click "+ New Story" above to create one.</div>';
        return;
    }

    // Sort: unassigned first, then alphabetical
    const sorted = [...stories].sort((a, b) => {
        const aAssigned = assignedIds.has(a.id) ? 1 : 0;
        const bAssigned = assignedIds.has(b.id) ? 1 : 0;
        if (aAssigned !== bAssigned) return aAssigned - bAssigned;
        return (a.title || '').localeCompare(b.title || '');
    });

    container.innerHTML = sorted.map(story => {
        const isAssigned = assignedIds.has(story.id);
        return `
            <div class="story-picker-item ${isAssigned ? 'already-assigned' : ''}"
                 data-story-id="${story.id}"
                 ${!isAssigned ? `draggable="true" ondragstart="handlePickerStoryDragStart(event, ${story.id})"` : ''}>
                <div class="story-info">
                    <h4>${escapeHtml(story.title)}</h4>
                    ${story.hook ? `<p>${escapeHtml(story.hook)}</p>` : ''}
                    ${story.tags ? `<div class="story-tags" style="margin-top:0.15rem;">${story.tags.split(',').map(t =>
                        `<span class="filter-chip chip-sm">${escapeHtml(t.trim())}</span>`
                    ).join('')}</div>` : ''}
                </div>
                ${isAssigned
                    ? '<span style="font-size:0.75rem;color:var(--text-muted);">Assigned</span>'
                    : `<button class="btn btn-ghost btn-sm" onclick="handleAssignStoryToStage(${story.id})">Add</button>`
                }
            </div>
        `;
    }).join('');
}

function handlePickerStoryDragStart(e, storyId) {
    e.dataTransfer.setData('application/story-id', storyId);
    e.dataTransfer.effectAllowed = 'copy';
}

// ---- Create New Story in Picker ----

let _quillPickerNewContent = null;

function showPickerCreateForm() {
    document.getElementById('story-picker-browse').style.display = 'none';
    document.getElementById('story-picker-create').style.display = 'block';
    document.getElementById('story-picker-title').textContent = 'Create New Story';
    document.getElementById('picker-create-btn').style.display = 'none';

    // Reset form
    document.getElementById('picker-new-title').value = '';
    document.getElementById('picker-new-hook').value = '';
    document.getElementById('picker-new-tags').value = '';
    document.getElementById('picker-save-to-bank').checked = true;

    // Init Quill for content
    _quillPickerNewContent = initQuill('picker-new-content-editor', QUILL_FULL_TOOLBAR, 'Tell your story... (SAIL, STAR, or freeform)');
    initResizeHandles();

    // Focus title
    requestAnimationFrame(() => document.getElementById('picker-new-title').focus());
}

function hidePickerCreateForm() {
    document.getElementById('story-picker-create').style.display = 'none';
    document.getElementById('story-picker-browse').style.display = 'flex';
    document.getElementById('story-picker-title').textContent = 'Add Stories to Stage';
    document.getElementById('picker-create-btn').style.display = '';
    _quillPickerNewContent = null;
}

async function handlePickerCreateStory() {
    const title = document.getElementById('picker-new-title').value.trim();
    if (!title) {
        showToast('Title is required', 'warning');
        document.getElementById('picker-new-title').focus();
        return;
    }

    const hook = document.getElementById('picker-new-hook').value.trim();
    const tags = document.getElementById('picker-new-tags').value.trim();
    const content = _quillPickerNewContent ? _getQuillHtml(_quillPickerNewContent) : '';
    const saveToBank = document.getElementById('picker-save-to-bank').checked;
    const company = (document.getElementById('picker-new-company')?.value || '').trim();
    const competency = (document.getElementById('picker-new-competency')?.value || '').trim();

    try {
        // Create the story — stage_only=1 if not saving to bank
        const storyData = { title, hook, content, tags, company, competency };
        if (!saveToBank) storyData.stage_only = 1;

        const result = await api.addStory(storyData);
        if (result.error) {
            showToast(result.error, 'error');
            return;
        }

        const newStoryId = result.id;
        if (!newStoryId) {
            showToast('Failed to create story', 'error');
            return;
        }

        // Assign to the current stage
        await api.assignStoryToStage(expandedJobId, _selectedStageId, newStoryId);
        await loadStageStories(_selectedStageId);

        if (saveToBank) {
            showToast('Story created, assigned, and saved to Story Bank', 'success');
        } else {
            showToast('Story created and assigned to this stage', 'success');
        }

        // Switch back to browse view with refreshed list
        hidePickerCreateForm();
        await renderStoryPicker();

    } catch (e) {
        showToast('Failed to create story', 'error');
    }
}

// ---- Edit Story Copy for Stage ----

function handleEditStoryForStage(storyId) {
    const card = document.querySelector(`.assigned-story-card[data-story-id="${storyId}"]`);
    if (!card) return;

    // Toggle: if editor already open, close it
    const existingEditor = card.nextElementSibling;
    if (existingEditor && existingEditor.classList.contains('story-edit-inline')) {
        _quillStoryEdit = null;
        existingEditor.remove();
        return;
    }

    // Get story data from cache
    const story = _stageStoriesCache.find(s => (s.story_id || s.id) === storyId);
    if (!story) return;

    // Use custom_content if set, otherwise fall back to original
    const editContent = story.custom_content || story.content || '';

    const editorDiv = document.createElement('div');
    editorDiv.className = 'story-edit-inline';
    editorDiv.innerHTML = `
        <div class="story-edit-label">Editing copy for this stage <span style="color:var(--text-muted);font-weight:400;">(original in Story Bank is unchanged)</span></div>
        <div class="quill-resize-wrapper" id="story-edit-resize-${storyId}" style="min-height:160px;">
            <div id="story-edit-quill-${storyId}"></div>
            <div class="resize-handle" data-target="story-edit-resize-${storyId}"></div>
        </div>
        <div class="story-edit-actions">
            <button class="btn btn-success btn-sm" onclick="saveStoryEditForStage(${storyId})">Save</button>
            <button class="btn btn-ghost btn-sm" onclick="_quillStoryEdit=null;this.closest('.story-edit-inline').remove()">Cancel</button>
            ${story.custom_content ? `<button class="btn btn-ghost btn-sm btn-danger-hover" onclick="resetStoryToOriginal(${storyId})" title="Discard edits and revert to original">Reset to Original</button>` : ''}
        </div>
    `;
    card.after(editorDiv);

    // Initialize Quill for story editing
    _quillStoryEdit = initQuill(`story-edit-quill-${storyId}`, QUILL_FULL_TOOLBAR, 'Edit your story...');
    if (_quillStoryEdit) {
        _quillStoryEdit.root.innerHTML = contentToHtml(editContent);
        _quillStoryEdit.focus();
    }
    _quillStoryEdit._storyId = storyId;
    initResizeHandles();
}

async function saveStoryEditForStage(storyId) {
    if (!expandedJobId || !_selectedStageId || !_quillStoryEdit) return;

    const content = _getQuillHtml(_quillStoryEdit);
    try {
        await api.updateStageStoryContent(expandedJobId, _selectedStageId, storyId, content);
        // Update cache
        const story = _stageStoriesCache.find(s => (s.story_id || s.id) === storyId);
        if (story) story.custom_content = content;
        // Remove editor and re-render
        _quillStoryEdit = null;
        renderAssignedStories();
        showToast('Story copy saved', 'success');
    } catch (e) {
        showToast('Failed to save', 'error');
    }
}

async function resetStoryToOriginal(storyId) {
    if (!expandedJobId || !_selectedStageId) return;
    try {
        await api.updateStageStoryContent(expandedJobId, _selectedStageId, storyId, null);
        const story = _stageStoriesCache.find(s => (s.story_id || s.id) === storyId);
        if (story) story.custom_content = null;
        _quillStoryEdit = null;
        renderAssignedStories();
        showToast('Reset to original', 'success');
    } catch (e) {
        showToast('Failed to reset', 'error');
    }
}

async function handlePromoteToBank(storyId) {
    try {
        await fetch(`/api/stories/${storyId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage_only: 0 })
        });
        // Update cache
        const story = _stageStoriesCache.find(s => (s.story_id || s.id) === storyId);
        if (story) story.stage_only = 0;
        renderAssignedStories();
        showToast('Story saved to Story Bank', 'success');
    } catch (e) {
        showToast('Failed to save to bank', 'error');
    }
}

// (Old insertNotesFormat and toggleNotesPreview removed — replaced by Quill rich text editor)

// =================== Collapsible Sections ===================

const _sectionStates = { interviewer: false, questions: false, stories: true, whiteboard: false, mocks: false };

function toggleSection(name) {
    _sectionStates[name] = !_sectionStates[name];
    const body = document.getElementById(`body-${name}`);
    const chevron = document.getElementById(`chevron-${name}`);
    if (body) body.style.display = _sectionStates[name] ? '' : 'none';
    if (chevron) chevron.innerHTML = _sectionStates[name] ? '&#x25BC;' : '&#x25B6;';
}

// =================== Interviewer Intel ===================

let _interviewerSaveTimer = null;

function loadInterviewerData(stage) {
    let data = {};
    try { data = JSON.parse(stage.interviewer || '{}'); } catch (e) { data = {}; }
    document.getElementById('interviewer-name').value = data.name || '';
    document.getElementById('interviewer-role').value = data.role || '';
    document.getElementById('interviewer-linkedin').value = data.linkedin || '';

    // Init interviewer notes Quill
    _quillInterviewerNotes = initQuill('interviewer-notes-editor', QUILL_MINI_TOOLBAR, 'Research notes... (what they worked on, shared interests, etc.)', () => {
        debounceInterviewerSave();
    });
    if (_quillInterviewerNotes && data.notes) {
        _quillInterviewerNotes.root.innerHTML = contentToHtml(data.notes);
    }
    initResizeHandles();
}

function getInterviewerData() {
    return {
        name: (document.getElementById('interviewer-name').value || '').trim(),
        role: (document.getElementById('interviewer-role').value || '').trim(),
        linkedin: (document.getElementById('interviewer-linkedin').value || '').trim(),
        notes: _getQuillHtml(_quillInterviewerNotes),
    };
}

async function saveInterviewerField() {
    if (!expandedJobId || !_selectedStageId) return;
    const data = getInterviewerData();
    const json = JSON.stringify(data);
    try {
        await api.updateStage(expandedJobId, _selectedStageId, { interviewer: json });
        const stage = _stagesCache.find(s => s.id === _selectedStageId);
        if (stage) stage.interviewer = json;
    } catch (e) { /* silent */ }
}

function debounceInterviewerSave() {
    clearTimeout(_interviewerSaveTimer);
    _interviewerSaveTimer = setTimeout(saveInterviewerField, 800);
}

// =================== Questions to Ask ===================

let _questionsCache = [];
let _questionsSaveTimer = null;

function loadQuestions(stage) {
    try { _questionsCache = JSON.parse(stage.questions || '[]'); } catch (e) { _questionsCache = []; }
    if (!Array.isArray(_questionsCache)) _questionsCache = [];
    renderQuestions();
}

function renderQuestions() {
    const container = document.getElementById('questions-list');
    if (!container) return;

    if (!_questionsCache.length) {
        container.innerHTML = '<div class="empty-state">No questions yet. Click + to add one.</div>';
        return;
    }

    container.innerHTML = _questionsCache.map((q, idx) => `
        <div class="question-item" data-q-idx="${idx}">
            <div class="question-row">
                <textarea class="question-text" rows="1" placeholder="Type your question..."
                    oninput="updateQuestion(${idx}, 'question', this.value); autoResizeTextarea(this)"
                    onfocus="autoResizeTextarea(this)">${escapeHtml(q.question || '')}</textarea>
                <button class="question-delete" onclick="deleteQuestion(${idx})" title="Remove">&times;</button>
            </div>
            <div class="question-answer">
                <textarea rows="1" placeholder="Answer / notes from the interview..."
                    oninput="updateQuestion(${idx}, 'answer', this.value); autoResizeTextarea(this)"
                    onfocus="autoResizeTextarea(this)">${escapeHtml(q.answer || '')}</textarea>
            </div>
        </div>
    `).join('');

    // Auto-resize all textareas
    container.querySelectorAll('textarea').forEach(autoResizeTextarea);
}

function autoResizeTextarea(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

function addQuestion() {
    _questionsCache.push({ question: '', answer: '' });
    // Expand the section if collapsed
    if (!_sectionStates.questions) toggleSection('questions');
    renderQuestions();
    debounceQuestionsSave();
    // Focus the new question
    requestAnimationFrame(() => {
        const items = document.querySelectorAll('.question-item');
        const last = items[items.length - 1];
        if (last) last.querySelector('.question-text').focus();
    });
}

function deleteQuestion(idx) {
    _questionsCache.splice(idx, 1);
    renderQuestions();
    debounceQuestionsSave();
}

function updateQuestion(idx, field, value) {
    if (_questionsCache[idx]) _questionsCache[idx][field] = value;
    debounceQuestionsSave();
}

function debounceQuestionsSave() {
    clearTimeout(_questionsSaveTimer);
    _questionsSaveTimer = setTimeout(saveQuestions, 800);
}

async function saveQuestions() {
    if (!expandedJobId || !_selectedStageId) return;
    const json = JSON.stringify(_questionsCache);
    try {
        await api.updateStage(expandedJobId, _selectedStageId, { questions: json });
        const stage = _stagesCache.find(s => s.id === _selectedStageId);
        if (stage) stage.questions = json;
    } catch (e) { /* silent */ }
}

// =================== Post-Interview Debrief ===================

let _debriefCache = {};
let _debriefSaveTimer = null;

function loadDebrief(stage) {
    try { _debriefCache = JSON.parse(stage.debrief || '{}'); } catch (e) { _debriefCache = {}; }
    if (typeof _debriefCache !== 'object' || _debriefCache === null) _debriefCache = {};

    // Init debrief Quill editors
    const debriefChange = () => debounceDebriefSave();
    _quillDebriefWentWell = initQuill('debrief-went-well-editor', QUILL_MINI_TOOLBAR, 'What went well?', debriefChange);
    _quillDebriefToImprove = initQuill('debrief-to-improve-editor', QUILL_MINI_TOOLBAR, 'What could improve for next round?', debriefChange);
    _quillDebriefQuestionsAsked = initQuill('debrief-questions-asked-editor', QUILL_MINI_TOOLBAR, 'Questions they asked (capture while fresh)', debriefChange);
    _quillDebriefFollowup = initQuill('debrief-followup-editor', QUILL_MINI_TOOLBAR, 'Follow-up needed? (thank you email, references, etc.)', debriefChange);

    if (_quillDebriefWentWell && _debriefCache.went_well) _quillDebriefWentWell.root.innerHTML = contentToHtml(_debriefCache.went_well);
    if (_quillDebriefToImprove && _debriefCache.to_improve) _quillDebriefToImprove.root.innerHTML = contentToHtml(_debriefCache.to_improve);
    if (_quillDebriefQuestionsAsked && _debriefCache.questions_asked) _quillDebriefQuestionsAsked.root.innerHTML = contentToHtml(_debriefCache.questions_asked);
    if (_quillDebriefFollowup && _debriefCache.followup) _quillDebriefFollowup.root.innerHTML = contentToHtml(_debriefCache.followup);

    setDebriefRating(_debriefCache.rating || 0, true);
    initResizeHandles();

    // Debrief visibility is handled by updateStageSectionVisibility()
}

function setDebriefRating(rating, silent) {
    _debriefCache.rating = rating;
    document.querySelectorAll('#debrief-stars .debrief-star').forEach(star => {
        star.classList.toggle('active', parseInt(star.dataset.rating) <= rating);
    });
    if (!silent) debounceDebriefSave();
}

function debounceDebriefSave() {
    clearTimeout(_debriefSaveTimer);
    _debriefSaveTimer = setTimeout(saveDebrief, 800);
}

function _getQuillHtml(quill) {
    if (!quill) return '';
    const html = quill.root.innerHTML;
    if (html === '<p><br></p>' || html === '<p></p>') return '';
    // Strip collapsible heading artifacts so saved HTML is clean
    if (html.includes('toggle-hidden') || html.includes('data-collapsed')) {
        const temp = document.createElement('div');
        temp.innerHTML = html;
        temp.querySelectorAll('.toggle-hidden').forEach(el => {
            el.classList.remove('toggle-hidden');
            if (!el.className) el.removeAttribute('class');
        });
        temp.querySelectorAll('[data-collapsed]').forEach(el => el.removeAttribute('data-collapsed'));
        return temp.innerHTML;
    }
    return html;
}

async function saveDebrief() {
    if (!expandedJobId || !_selectedStageId) return;
    _debriefCache.went_well = _getQuillHtml(_quillDebriefWentWell);
    _debriefCache.to_improve = _getQuillHtml(_quillDebriefToImprove);
    _debriefCache.questions_asked = _getQuillHtml(_quillDebriefQuestionsAsked);
    _debriefCache.followup = _getQuillHtml(_quillDebriefFollowup);
    const json = JSON.stringify(_debriefCache);
    try {
        await api.updateStage(expandedJobId, _selectedStageId, { debrief: json });
        const stage = _stagesCache.find(s => s.id === _selectedStageId);
        if (stage) stage.debrief = json;
    } catch (e) { /* silent */ }
}

// =================== Quick-Reference Cheat Sheet ===================

function openCheatSheet() {
    if (!_selectedStageId) return;
    const stage = _stagesCache.find(s => s.id === _selectedStageId);
    if (!stage) return;

    const overlay = document.getElementById('cheatsheet-overlay');
    const title = document.getElementById('cheatsheet-title');
    const body = document.getElementById('cheatsheet-body');

    title.textContent = `Cheat Sheet: ${stage.name}`;

    let html = '';

    // Interviewer intel
    let interviewer = {};
    try { interviewer = JSON.parse(stage.interviewer || '{}'); } catch (e) {}
    if (interviewer.name || interviewer.role) {
        html += `<div class="cheatsheet-section">
            <h4 class="cheatsheet-section-title">Interviewer</h4>
            <div class="cheatsheet-item"><strong>${escapeHtml(interviewer.name || 'TBD')}</strong>${interviewer.role ? ` &mdash; ${escapeHtml(interviewer.role)}` : ''}</div>
            ${interviewer.linkedin ? `<div class="cheatsheet-item"><span class="cs-label">LinkedIn:</span> <a href="${escapeHtml(interviewer.linkedin)}" target="_blank" style="color:var(--accent);">${escapeHtml(interviewer.linkedin)}</a></div>` : ''}
            ${interviewer.notes ? `<div class="cheatsheet-item"><span class="cs-label">Notes:</span> <span class="markdown-body" style="display:inline;">${contentToHtml(interviewer.notes)}</span></div>` : ''}
        </div>`;
    }

    // Game plan (rendered as rich text HTML)
    if (stage.notes) {
        // Handle both legacy markdown and new HTML content
        const notesHtml = looksLikeMarkdown(stage.notes) ? marked.parse(stage.notes) : stage.notes;
        html += `<div class="cheatsheet-section">
            <h4 class="cheatsheet-section-title">Game Plan</h4>
            <div class="cheatsheet-item markdown-body" style="font-size:0.8rem;">${notesHtml}</div>
        </div>`;
    }

    // Key stories
    if (_stageStoriesCache.length) {
        html += `<div class="cheatsheet-section">
            <h4 class="cheatsheet-section-title">Stories (${_stageStoriesCache.length})</h4>
            ${_stageStoriesCache.map(s => {
                const hook = s.hook || '';
                const hasEdited = !!s.custom_content;
                return `<div class="cheatsheet-story">
                    <h4>${escapeHtml(s.title)}${hasEdited ? ' <span class="custom-badge">edited</span>' : ''}</h4>
                    ${hook ? `<p>${escapeHtml(hook)}</p>` : ''}
                </div>`;
            }).join('')}
        </div>`;
    }

    // Questions to ask
    let questions = [];
    try { questions = JSON.parse(stage.questions || '[]'); } catch (e) {}
    if (questions.length) {
        html += `<div class="cheatsheet-section">
            <h4 class="cheatsheet-section-title">Questions to Ask</h4>
            ${questions.map(q => `<div class="cheatsheet-item">&bull; ${escapeHtml(q.question || '')}</div>`).join('')}
        </div>`;
    }

    if (!html) {
        html = '<div class="cheatsheet-empty">No prep data yet. Add notes, stories, and questions to build your cheat sheet.</div>';
    }

    body.innerHTML = html;
    overlay.style.display = 'flex';
}

function closeCheatSheet() {
    document.getElementById('cheatsheet-overlay').style.display = 'none';
}

function printCheatSheet() {
    // Focus on just the cheat sheet content for printing
    const body = document.getElementById('cheatsheet-body');
    if (!body) return;
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`<!DOCTYPE html><html><head><title>Cheat Sheet</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 1.5rem; max-width: 700px; margin: 0 auto; color: #111; }
            h3 { margin: 0 0 1rem; font-size: 1.2rem; }
            h4 { font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #555; margin: 1rem 0 0.3rem; padding-bottom: 0.2rem; border-bottom: 1px solid #ddd; }
            .item { font-size: 0.9rem; line-height: 1.5; padding: 0.1rem 0; }
            .story { background: #f5f5f5; padding: 0.4rem 0.6rem; border-radius: 4px; margin-bottom: 0.3rem; }
            .story strong { font-size: 0.85rem; }
            .story p { font-size: 0.8rem; color: #666; margin: 0.1rem 0 0; }
            .label { color: #888; font-size: 0.8rem; }
            a { color: #3b82f6; }
            ul { padding-left: 1.2rem; }
            li { margin-bottom: 0.15rem; }
        </style></head><body>
        <h3>${document.getElementById('cheatsheet-title').textContent}</h3>
        ${body.innerHTML.replace(/class="cheatsheet-section-title"/g, '').replace(/class="cheatsheet-item"/g, 'class="item"').replace(/class="cheatsheet-story"/g, 'class="story"').replace(/class="cs-label"/g, 'class="label"')}
    </body></html>`);
    printWindow.document.close();
    printWindow.print();
}

// =================== AI Prep Coach (Stage-Aware) ===================

function _getStageContext() {
    const stage = _stagesCache.find(s => s.id === _selectedStageId);
    return {
        stage_name: stage ? stage.name : '',
        stage_notes: stage ? htmlToPlainText(stage.notes || '') : '',
    };
}

function renderInsightsFeed(insights) {
    const feed = document.getElementById('interview-insights-feed');
    if (!feed) return;

    if (!insights || !insights.length) {
        feed.innerHTML = '<div class="empty-state">Click Rank Stories or Prep Guide to get started.</div>';
        return;
    }

    feed.innerHTML = insights.map((insight, idx) => renderInsightCard(insight, idx === 0)).join('');
}

function renderInsightCard(insight, expanded = false) {
    const typeLabel = insight.insight_type === 'rank' ? 'Rank Stories' : 'Prep Guide';
    const typeCls = insight.insight_type === 'rank' ? 'insight-type-rank' : 'insight-type-prep';
    const frameworkTag = insight.framework ? ` (${escapeHtml(insight.framework)})` : '';
    const date = new Date(insight.created_at + 'Z');
    const timestamp = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
        date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

    return `
        <div class="insight-card ${expanded ? 'expanded' : ''}" data-insight-id="${insight.id}">
            <div class="insight-header" onclick="toggleInsightCard(this)">
                <span class="insight-chevron">▸</span>
                <div class="insight-meta">
                    <span class="insight-type-badge ${typeCls}">${typeLabel}</span>
                    <span class="insight-framework">${frameworkTag}</span>
                </div>
                <div class="insight-actions">
                    <span class="insight-timestamp">${timestamp}</span>
                    <button class="btn-icon" onclick="event.stopPropagation();deleteInsight(${insight.id})" title="Delete">&#x2715;</button>
                </div>
            </div>
            <div class="insight-body">
                <div class="markdown-body">${marked.parse(insight.content || '')}</div>
            </div>
        </div>
    `;
}

function toggleInsightCard(headerEl) {
    const card = headerEl.closest('.insight-card');
    if (card) card.classList.toggle('expanded');
}

async function deleteInsight(insightId) {
    if (!expandedJobId) return;
    try {
        await api.deleteInsight(expandedJobId, insightId);
        _insightsCache = _insightsCache.filter(i => i.id !== insightId);
        renderInsightsFeed(_insightsCache);
        showToast('Insight removed', 'success');
    } catch (e) {
        showToast('Failed to delete', 'error');
    }
}

function prependInsightCard(insight) {
    _insightsCache.unshift(insight);
    renderInsightsFeed(_insightsCache);
}

async function handleRecommendStories() {
    if (!expandedJobId) return;

    const { stage_name, stage_notes } = _getStageContext();
    const assignedIds = _stageStoriesCache.map(s => s.story_id || s.id);
    const feed = document.getElementById('interview-insights-feed');
    const stageLabel = stage_name ? ` for ${escapeHtml(stage_name)}` : '';
    const modeLabel = assignedIds.length ? 'Evaluating your story selection' : 'Ranking your stories';
    const loadingHtml = `<div class="insight-card expanded loading-insight"><div class="insight-body"><div class="loading-state">${modeLabel}${stageLabel}... This may take a minute.</div></div></div>`;
    feed.insertAdjacentHTML('afterbegin', loadingHtml);

    try {
        const result = await api.recommendStories(expandedJobId, stage_name, stage_notes, assignedIds);
        const loadingCard = feed.querySelector('.loading-insight');
        if (loadingCard) loadingCard.remove();

        if (result.error) {
            showToast(result.error, 'error');
            return;
        }

        const newInsight = {
            id: result.insight_id,
            insight_type: 'rank',
            framework: null,
            content: result.recommendations || '',
            created_at: new Date().toISOString().replace('Z', ''),
        };
        prependInsightCard(newInsight);

        // Show auto-assign button if AI suggested stories
        const suggestedIds = result.suggested_story_ids || [];
        if (suggestedIds.length && _selectedStageId) {
            const currentIds = new Set(_stageStoriesCache.map(s => s.story_id || s.id));
            const newIds = suggestedIds.filter(id => !currentIds.has(id));
            if (newIds.length) {
                const card = feed.querySelector('.insight-card');
                if (card) {
                    const body = card.querySelector('.insight-body');
                    const btn = document.createElement('button');
                    btn.className = 'btn btn-primary btn-sm auto-assign-btn';
                    btn.textContent = `Auto-assign ${newIds.length} suggested stor${newIds.length === 1 ? 'y' : 'ies'}`;
                    btn.onclick = async () => {
                        btn.disabled = true;
                        btn.textContent = 'Assigning...';
                        let assigned = 0;
                        for (const storyId of newIds) {
                            try {
                                await api.assignStoryToStage(expandedJobId, _selectedStageId, storyId);
                                assigned++;
                            } catch (e) { /* skip duplicates / errors */ }
                        }
                        btn.remove();
                        showToast(`Assigned ${assigned} stor${assigned === 1 ? 'y' : 'ies'}`, 'success');
                        await loadStageStories(_selectedStageId);
                    };
                    body.insertBefore(btn, body.firstChild);
                }
            }
        }

        const modelTag = result.model ? ` (${result.model})` : '';
        showToast(`Stories ranked${modelTag}`, 'success');
    } catch (e) {
        const loadingCard = feed.querySelector('.loading-insight');
        if (loadingCard) loadingCard.remove();
        showToast(`Ranking failed: ${e.message || e}`, 'error');
        console.error('Rank stories error:', e);
    }
}

async function handlePrepGuide(framework) {
    if (!expandedJobId) {
        showToast('Select a job first', 'warning');
        return;
    }

    framework = framework || 'SAIL';
    // Close dropdown if open
    const dd = document.getElementById('prep-guide-dropdown');
    if (dd) dd.style.display = 'none';
    const { stage_name, stage_notes } = _getStageContext();
    const feed = document.getElementById('interview-insights-feed');
    const stageLabel = stage_name ? ` for ${escapeHtml(stage_name)}` : '';
    const loadingHtml = `<div class="insight-card expanded loading-insight"><div class="insight-body"><div class="loading-state">Preparing ${escapeHtml(framework)} guide${stageLabel}... This may take a minute.</div></div></div>`;
    feed.insertAdjacentHTML('afterbegin', loadingHtml);

    try {
        const result = await api.analyzeInterview(expandedJobId, framework, stage_name, stage_notes);
        const loadingCard = feed.querySelector('.loading-insight');
        if (loadingCard) loadingCard.remove();

        if (result.error) {
            showToast(result.error, 'error');
            return;
        }
        if (!result.analysis) {
            showToast('Analysis returned empty. Ensure the job has a saved description.', 'warning');
            return;
        }

        const newInsight = {
            id: result.insight_id,
            insight_type: 'prep',
            framework: result.framework || framework,
            content: result.analysis,
            created_at: new Date().toISOString().replace('Z', ''),
        };
        prependInsightCard(newInsight);
        const modelTag = result.model ? ` (${result.model})` : '';
        showToast(`Prep guide ready${modelTag}`, 'success');
    } catch (e) {
        const loadingCard = feed.querySelector('.loading-insight');
        if (loadingCard) loadingCard.remove();
        showToast(`Prep guide failed: ${e.message || e}`, 'error');
        console.error('Prep guide error:', e);
    }
}

// ---- Prep Guide Split Button ----

function togglePrepGuideMenu(e) {
    e.stopPropagation();
    const dd = document.getElementById('prep-guide-dropdown');
    if (!dd) return;
    const show = dd.style.display === 'none';
    dd.style.display = show ? 'flex' : 'none';
    if (show) {
        // Close on outside click
        const close = (ev) => {
            if (!dd.contains(ev.target)) {
                dd.style.display = 'none';
                document.removeEventListener('click', close);
            }
        };
        setTimeout(() => document.addEventListener('click', close), 0);
    }
}

// ---- Copy Stories from Previous Stages ----

function updateCopyFromStageVisibility() {
    const group = document.getElementById('copy-from-stage-group');
    if (!group) return;
    // Show button only if there are other stages with stories potentially
    const otherStages = _stagesCache.filter(s => s.id !== _selectedStageId);
    group.style.display = otherStages.length ? '' : 'none';
}

async function toggleCopyFromStageMenu() {
    const menu = document.getElementById('copy-from-stage-menu');
    if (!menu) return;

    const show = menu.style.display === 'none';
    if (!show) { menu.style.display = 'none'; return; }

    menu.innerHTML = '<div class="copy-stage-loading">Loading...</div>';
    menu.style.display = 'flex';

    // Close on outside click
    const close = (ev) => {
        if (!menu.contains(ev.target) && !ev.target.closest('#copy-from-stage-group')) {
            menu.style.display = 'none';
            document.removeEventListener('click', close);
        }
    };
    setTimeout(() => document.addEventListener('click', close), 0);

    // Fetch stories for each other stage
    const otherStages = _stagesCache.filter(s => s.id !== _selectedStageId);
    if (!otherStages.length) {
        menu.innerHTML = '<div class="copy-stage-empty">No other stages</div>';
        return;
    }

    const currentAssignedIds = new Set(_stageStoriesCache.map(s => s.story_id || s.id));
    let html = '';

    for (const stage of otherStages) {
        try {
            const res = await api.getStageStories(expandedJobId, stage.id);
            const stories = (res.stories || []).filter(s => !currentAssignedIds.has(s.story_id || s.id));
            if (!stories.length) {
                html += `<div class="copy-stage-section">
                    <div class="copy-stage-name">${escapeHtml(stage.name)}</div>
                    <div class="copy-stage-empty-hint">No new stories to copy</div>
                </div>`;
                continue;
            }
            html += `<div class="copy-stage-section">
                <div class="copy-stage-name">
                    ${escapeHtml(stage.name)}
                    <button class="btn btn-ghost btn-xs copy-all-btn" onclick="event.stopPropagation();copyAllStoriesFromStage(${stage.id}, '${escapeHtml(stage.name)}')">Copy All</button>
                </div>
                ${stories.map(s => `
                    <div class="copy-stage-story" onclick="event.stopPropagation();copySingleStoryFromStage(${s.story_id || s.id})">
                        <span class="copy-story-title">${escapeHtml(s.title)}</span>
                        <span class="copy-story-add">+</span>
                    </div>
                `).join('')}
            </div>`;
        } catch (e) {
            html += `<div class="copy-stage-section">
                <div class="copy-stage-name">${escapeHtml(stage.name)}</div>
                <div class="copy-stage-empty-hint">Failed to load</div>
            </div>`;
        }
    }

    if (!html) html = '<div class="copy-stage-empty">No stories in other stages</div>';
    menu.innerHTML = html;
}

async function copySingleStoryFromStage(storyId) {
    if (!_selectedStageId || !expandedJobId) return;
    try {
        await api.assignStoryToStage(expandedJobId, _selectedStageId, storyId);
        await loadStageStories(_selectedStageId);
        showToast('Story copied to this stage', 'success');
        // Refresh menu in-place
        const menu = document.getElementById('copy-from-stage-menu');
        if (menu && menu.style.display !== 'none') {
            // Close and re-open to refresh content
            menu.style.display = 'none';
            await toggleCopyFromStageMenu();
        }
    } catch (e) {
        showToast('Failed to copy story', 'error');
    }
}

async function copyAllStoriesFromStage(stageId, stageName) {
    if (!_selectedStageId || !expandedJobId) return;
    try {
        const res = await api.getStageStories(expandedJobId, stageId);
        const currentAssignedIds = new Set(_stageStoriesCache.map(s => s.story_id || s.id));
        const stories = (res.stories || []).filter(s => !currentAssignedIds.has(s.story_id || s.id));
        if (!stories.length) {
            showToast('No new stories to copy', 'info');
            return;
        }
        let copied = 0;
        for (const s of stories) {
            try {
                await api.assignStoryToStage(expandedJobId, _selectedStageId, s.story_id || s.id);
                copied++;
            } catch (e) { }
        }
        await loadStageStories(_selectedStageId);
        showToast(`Copied ${copied} stor${copied === 1 ? 'y' : 'ies'} from ${stageName}`, 'success');
        // Close menu
        const menu = document.getElementById('copy-from-stage-menu');
        if (menu) menu.style.display = 'none';
    } catch (e) {
        showToast('Failed to copy stories', 'error');
    }
}

// =================== Utilities ===================

function getLatestNoteText(notes) {
    if (!notes) return '';
    try {
        const entries = JSON.parse(notes);
        if (Array.isArray(entries) && entries.length) {
            const latest = entries[entries.length - 1];
            const text = latest.text || '';
            const prefix = latest.type === 'system' ? '\u26A1 ' : '';
            const display = prefix + text;
            return display.length > 60 ? display.substring(0, 60) + '...' : display;
        }
    } catch (e) {
        // Plain text notes
    }
    return notes.length > 60 ? notes.substring(0, 60) + '...' : notes;
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function sectionTypeLabel(type) {
    const labels = {
        header: 'Header',
        summary: 'Summary',
        experience: 'Experience',
        education: 'Education',
        skills: 'Skills',
        projects: 'Projects',
        certifications: 'Certifications',
        interests: 'Interests',
    };
    return labels[type] || type;
}

function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

async function handleUpdateNotes(jobId, notes) {
    await api.updateJobNotes(jobId, notes);
}

// =================== Resize Handles (all panel dividers) ===================

(function initResizeHandles() {
    let isDragging = false;
    let handle = null;
    let leftPanel = null;
    let rightPanel = null;
    let container = null;

    let startX = 0;

    document.addEventListener('mousedown', (e) => {
        const target = e.target.closest('.resize-handle-vertical, .sidebar-edge-handle');
        if (!target) return;

        startX = e.clientX;

        // Determine which panels to resize
        if (target.classList.contains('sidebar-edge-handle')) {
            // Sidebar resize — only when sidebar is open
            const sidebar = target.closest('.activity-sidebar');
            if (!sidebar || !sidebar.classList.contains('open')) return;
            handle = target;
            isDragging = true;
            handle.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
            leftPanel = null;
            rightPanel = null;
            container = sidebar;
        } else {
            handle = target;
            isDragging = true;
            handle.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
            const resizeType = target.dataset.resize;
            if (resizeType === 'resume') {
                leftPanel = document.getElementById('resume-display');
                rightPanel = document.getElementById('ai-feedback-panel');
                container = target.closest('.two-panel');
            } else if (resizeType === 'interview') {
                leftPanel = document.getElementById('stage-detail-panel');
                rightPanel = target.nextElementSibling;
                container = target.closest('.interview-two-col');
            } else {
                // JD panel (original)
                const row = target.closest('.expanded-content-row');
                if (!row) return;
                leftPanel = document.getElementById('jd-panel');
                rightPanel = null;
                container = row;
            }
        }
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging || !handle || !container) return;

        // Mark as dragged if moved more than 5px (prevents toggle on drag release)
        if (Math.abs(e.clientX - startX) > 5) _edgeDragged = true;

        const containerRect = container.getBoundingClientRect();

        if (handle.classList.contains('sidebar-edge-handle')) {
            // Sidebar resize: drag left edge to change width
            const newWidth = containerRect.right - e.clientX;
            const clamped = Math.max(200, Math.min(600, newWidth));
            container.style.width = clamped + 'px';
            container.style.minWidth = clamped + 'px';
        } else if (leftPanel && rightPanel) {
            // Two-panel resize: adjust left panel width, right gets remainder
            const leftOffset = e.clientX - containerRect.left;
            const minW = 200;
            const maxW = containerRect.width - 200 - 5; // 5px for handle
            const clamped = Math.max(minW, Math.min(maxW, leftOffset));

            leftPanel.style.flex = 'none';
            leftPanel.style.width = clamped + 'px';
            rightPanel.style.flex = '1';
        } else if (leftPanel) {
            // JD panel resize + persist
            const newWidth = e.clientX - containerRect.left;
            const clamped = Math.max(200, Math.min(containerRect.width - 300, newWidth));
            leftPanel.style.width = clamped + 'px';
            localStorage.setItem('jdPanelWidth', clamped);
        }
    });

    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        if (handle) handle.classList.remove('dragging');
        handle = null;
        leftPanel = null;
        rightPanel = null;
        container = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });
})();

// =================== Column Resize ===================

(function initColumnResize() {
    let th = null, startX = 0, startW = 0;

    document.addEventListener('mousedown', (e) => {
        if (!e.target.classList.contains('col-resize-handle')) return;
        e.preventDefault();
        e.stopPropagation();
        th = e.target.closest('th');
        if (!th) return;
        startX = e.clientX;
        startW = th.offsetWidth;
        e.target.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!th) return;
        const newW = Math.max(50, startW + (e.clientX - startX));
        th.style.width = newW + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (!th) return;
        const handle = th.querySelector('.col-resize-handle');
        if (handle) handle.classList.remove('active');
        th = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });
})();

// =================== Whiteboard ===================

let _whiteboardReady = false;
let _whiteboardSaveTimer = null;
let _whiteboardPendingScene = null;

function initStageWhiteboard(stage) {
    _whiteboardReady = false;
    _whiteboardPendingScene = null;
    clearTimeout(_whiteboardSaveTimer);

    const iframe = document.getElementById('stage-whiteboard-iframe');
    if (!iframe) return;

    // Parse saved whiteboard data
    let scene = null;
    if (stage.whiteboard) {
        try { scene = JSON.parse(stage.whiteboard); } catch (e) { scene = null; }
    }

    // If iframe is already loaded, post immediately; otherwise wait for ready message
    _whiteboardPendingScene = scene;

    // Force reload iframe to reset state for new stage
    const src = iframe.src;
    iframe.src = '';
    requestAnimationFrame(() => { iframe.src = src; });
}

// Listen for whiteboard iframe messages
window.addEventListener('message', (e) => {
    if (!e.data || !e.data.type) return;

    if (e.data.type === 'ready') {
        const stageIframe = document.getElementById('stage-whiteboard-iframe');
        if (stageIframe && e.source === stageIframe.contentWindow) {
            _whiteboardReady = true;
            if (_whiteboardPendingScene) {
                stageIframe.contentWindow.postMessage({ type: 'load', scene: _whiteboardPendingScene }, '*');
                _whiteboardPendingScene = null;
            }
        }
    }

    if (e.data.type === 'change' && expandedJobId && _selectedStageId) {
        // Only handle if the message came from the stage whiteboard iframe (not a mock iframe)
        const stageIframe = document.getElementById('stage-whiteboard-iframe');
        if (stageIframe && e.source === stageIframe.contentWindow) {
            clearTimeout(_whiteboardSaveTimer);
            const jobId = expandedJobId;
            const stageId = _selectedStageId;
            _whiteboardSaveTimer = setTimeout(async () => {
                await api.updateStage(jobId, stageId, { whiteboard: JSON.stringify(e.data.scene) });
            }, 2000);
        }
    }
});

function toggleWhiteboardFullscreen() {
    const container = document.getElementById('stage-whiteboard-container');
    if (!container) return;
    const isFullscreen = container.classList.toggle('fullscreen');

    if (isFullscreen) {
        // Block clicks from reaching the backdrop behind the fullscreen overlay
        const clickGuard = (e) => { e.stopPropagation(); };
        container.addEventListener('click', clickGuard);

        // Escape key to exit fullscreen (stop propagation so it doesn't close the parent overlay)
        const handler = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                e.preventDefault();
                container.classList.remove('fullscreen');
                container.removeEventListener('click', clickGuard);
                document.removeEventListener('keydown', handler);
            }
        };
        document.addEventListener('keydown', handler);
    }
}

// =================== Mock Interviews ===================

let _mockInterviewsCache = [];
let _mockQuills = {};
let _mockSaveTimers = {};
let _expandedMockId = null;

async function loadMockInterviews(stageId) {
    if (!expandedJobId) return;
    _mockInterviewsCache = [];
    _mockQuills = {};
    _mockSaveTimers = {};
    _expandedMockId = null;

    try {
        const res = await api.getMocks(expandedJobId, stageId);
        _mockInterviewsCache = res.mocks || [];
    } catch (e) {
        _mockInterviewsCache = [];
    }
    renderMockInterviews();
}

function renderMockInterviews() {
    const container = document.getElementById('mock-interviews-list');
    if (!container) return;

    if (_mockInterviewsCache.length === 0) {
        container.innerHTML = '<div class="empty-state">No mock sessions yet. Click + Add to practice.</div>';
        return;
    }

    container.innerHTML = _mockInterviewsCache.map(mock => renderMockCard(mock)).join('');
}

function renderMockCard(mock) {
    const isExpanded = mock.id === _expandedMockId;
    const date = mock.created_at ? new Date(mock.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

    // Parse debrief
    let debrief = {};
    try { debrief = JSON.parse(mock.debrief || '{}'); } catch (e) { debrief = {}; }
    const rating = debrief.rating || 0;

    const stars = [1, 2, 3, 4, 5].map(n =>
        `<span class="debrief-star ${n <= rating ? 'active' : ''}" onclick="setMockDebriefRating(${mock.id}, ${n})">&#x2605;</span>`
    ).join('');

    return `
        <div class="mock-card ${isExpanded ? 'expanded' : ''}" data-mock-id="${mock.id}">
            <div class="mock-card-header" onclick="toggleMockCard(${mock.id})">
                <div class="mock-card-header-left">
                    <span class="mock-card-chevron">&#x25B6;</span>
                    <input type="text" class="mock-card-title-input" value="${escapeHtml(mock.title || 'Mock Practice')}"
                        onclick="event.stopPropagation()" onchange="saveMockTitle(${mock.id}, this.value)">
                    <span class="mock-card-date">${date}</span>
                </div>
                <div class="mock-card-actions">
                    <button class="btn btn-ghost btn-sm btn-danger-hover" onclick="event.stopPropagation();deleteMockInterview(${mock.id})" title="Delete">&#x2715;</button>
                </div>
            </div>
            <div class="mock-card-body">
                <div class="mock-section-label">Notes</div>
                <div class="quill-resize-wrapper quill-mini" id="mock-notes-resize-${mock.id}">
                    <div id="mock-notes-editor-${mock.id}"></div>
                    <div class="resize-handle" data-target="mock-notes-resize-${mock.id}"></div>
                </div>

                <div class="mock-whiteboard-toggle">
                    <label style="font-size:0.8rem;color:var(--text-secondary);cursor:pointer;">
                        <input type="checkbox" id="mock-wb-toggle-${mock.id}" onchange="toggleMockWhiteboard(${mock.id}, this.checked)"
                            ${mock.whiteboard ? 'checked' : ''}> Whiteboard
                    </label>
                </div>
                <div class="mock-whiteboard-container" id="mock-wb-container-${mock.id}" style="display:${mock.whiteboard ? 'block' : 'none'};">
                    <iframe id="mock-wb-iframe-${mock.id}" class="whiteboard-iframe" loading="lazy"></iframe>
                </div>

                <div class="mock-mini-debrief">
                    <div class="mock-section-label">Debrief</div>
                    <div class="mock-debrief-rating">
                        <label>How did it go?</label>
                        <div class="mock-debrief-stars">${stars}</div>
                    </div>
                    <div class="mock-section-label" style="margin-top:8px;">What went well?</div>
                    <div class="quill-resize-wrapper quill-mini" id="mock-debrief-well-resize-${mock.id}">
                        <div id="mock-debrief-well-editor-${mock.id}"></div>
                        <div class="resize-handle" data-target="mock-debrief-well-resize-${mock.id}"></div>
                    </div>
                    <div class="mock-section-label" style="margin-top:8px;">What to improve?</div>
                    <div class="quill-resize-wrapper quill-mini" id="mock-debrief-improve-resize-${mock.id}">
                        <div id="mock-debrief-improve-editor-${mock.id}"></div>
                        <div class="resize-handle" data-target="mock-debrief-improve-resize-${mock.id}"></div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function toggleMockCard(mockId) {
    const wasExpanded = _expandedMockId === mockId;
    _expandedMockId = wasExpanded ? null : mockId;

    // Re-render all cards
    renderMockInterviews();

    // If expanding, initialize Quill editors after DOM update
    if (!wasExpanded) {
        requestAnimationFrame(() => initMockEditors(mockId));
    }
}

function initMockEditors(mockId) {
    const mock = _mockInterviewsCache.find(m => m.id === mockId);
    if (!mock) return;

    // Notes editor
    _mockQuills[`notes-${mockId}`] = initQuill(
        `mock-notes-editor-${mockId}`, QUILL_MINI_TOOLBAR,
        'Practice notes, talking points...',
        () => debouncedMockSave(mockId, 'notes')
    );
    if (_mockQuills[`notes-${mockId}`] && mock.notes) {
        _mockQuills[`notes-${mockId}`].root.innerHTML = contentToHtml(mock.notes);
    }

    // Debrief "went well" editor
    let debrief = {};
    try { debrief = JSON.parse(mock.debrief || '{}'); } catch (e) { debrief = {}; }

    _mockQuills[`debrief-well-${mockId}`] = initQuill(
        `mock-debrief-well-editor-${mockId}`, QUILL_MINI_TOOLBAR,
        'What went well...',
        () => debouncedMockSave(mockId, 'debrief')
    );
    if (_mockQuills[`debrief-well-${mockId}`] && debrief.went_well) {
        _mockQuills[`debrief-well-${mockId}`].root.innerHTML = debrief.went_well;
    }

    // Debrief "to improve" editor
    _mockQuills[`debrief-improve-${mockId}`] = initQuill(
        `mock-debrief-improve-editor-${mockId}`, QUILL_MINI_TOOLBAR,
        'What to improve...',
        () => debouncedMockSave(mockId, 'debrief')
    );
    if (_mockQuills[`debrief-improve-${mockId}`] && debrief.to_improve) {
        _mockQuills[`debrief-improve-${mockId}`].root.innerHTML = debrief.to_improve;
    }

    initResizeHandles();

    // Load mock whiteboard if exists
    if (mock.whiteboard) {
        loadMockWhiteboard(mockId, mock.whiteboard);
    }
}

function debouncedMockSave(mockId, field) {
    const key = `${field}-${mockId}`;
    clearTimeout(_mockSaveTimers[key]);
    _mockSaveTimers[key] = setTimeout(() => saveMockField(mockId, field), 800);
}

async function saveMockField(mockId, field) {
    if (!expandedJobId || !_selectedStageId) return;

    const data = {};
    if (field === 'notes') {
        const quill = _mockQuills[`notes-${mockId}`];
        if (quill) data.notes = _getQuillHtml(quill);
    } else if (field === 'debrief') {
        const mock = _mockInterviewsCache.find(m => m.id === mockId);
        let existing = {};
        try { existing = JSON.parse(mock?.debrief || '{}'); } catch (e) { existing = {}; }

        const wellQuill = _mockQuills[`debrief-well-${mockId}`];
        const improveQuill = _mockQuills[`debrief-improve-${mockId}`];
        existing.went_well = wellQuill ? _getQuillHtml(wellQuill) : (existing.went_well || '');
        existing.to_improve = improveQuill ? _getQuillHtml(improveQuill) : (existing.to_improve || '');
        data.debrief = JSON.stringify(existing);

        // Update cache
        if (mock) mock.debrief = data.debrief;
    }

    if (Object.keys(data).length > 0) {
        await api.updateMock(expandedJobId, _selectedStageId, mockId, data);
        // Update cache
        const mock = _mockInterviewsCache.find(m => m.id === mockId);
        if (mock && data.notes !== undefined) mock.notes = data.notes;
    }
}

async function saveMockTitle(mockId, newTitle) {
    if (!expandedJobId || !_selectedStageId) return;
    const title = (newTitle || '').trim() || 'Mock Practice';
    await api.updateMock(expandedJobId, _selectedStageId, mockId, { title });
    const mock = _mockInterviewsCache.find(m => m.id === mockId);
    if (mock) mock.title = title;
}

function setMockDebriefRating(mockId, rating) {
    if (!expandedJobId || !_selectedStageId) return;
    const mock = _mockInterviewsCache.find(m => m.id === mockId);
    if (!mock) return;

    let debrief = {};
    try { debrief = JSON.parse(mock.debrief || '{}'); } catch (e) { debrief = {}; }
    debrief.rating = rating;
    mock.debrief = JSON.stringify(debrief);

    // Update star visuals
    const card = document.querySelector(`.mock-card[data-mock-id="${mockId}"]`);
    if (card) {
        card.querySelectorAll('.mock-debrief-stars .debrief-star').forEach(star => {
            const r = parseInt(star.getAttribute('onclick').match(/\d+$/)?.[0] || 0);
            star.classList.toggle('active', r <= rating);
        });
    }

    api.updateMock(expandedJobId, _selectedStageId, mockId, { debrief: mock.debrief });
}

async function addMockInterview() {
    if (!expandedJobId || !_selectedStageId) {
        showToast('No job/stage selected (job=' + expandedJobId + ', stage=' + _selectedStageId + ')', 'error');
        return;
    }

    // Expand the section if collapsed
    if (!_sectionStates.mocks) toggleSection('mocks');

    const url = `/api/interview-stages/${expandedJobId}/${_selectedStageId}/mocks`;
    let resp, result;
    try {
        resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Mock Practice' })
        });
    } catch (e) {
        showToast('Network error: ' + (e.message || e), 'error');
        return;
    }

    try {
        result = await resp.json();
    } catch (e) {
        const text = await resp.text().catch(() => '');
        showToast(`Server returned non-JSON (${resp.status}): ${text.slice(0, 100)}`, 'error');
        return;
    }

    if (!resp.ok || result.error) {
        showToast(result.error || `Server error ${resp.status}`, 'error');
        return;
    }

    logSystemEvent(expandedJobId, 'Mock interview created');
    await loadMockInterviews(_selectedStageId);
    if (result.id) {
        _expandedMockId = result.id;
        renderMockInterviews();
        requestAnimationFrame(() => {
            try { initMockEditors(result.id); } catch (e) { console.error('initMockEditors error:', e); }
        });
    }
}

async function deleteMockInterview(mockId) {
    if (!expandedJobId || !_selectedStageId) return;
    if (!confirm('Delete this mock interview session?')) return;

    try {
        await api.deleteMock(expandedJobId, _selectedStageId, mockId);
        _mockInterviewsCache = _mockInterviewsCache.filter(m => m.id !== mockId);
        if (_expandedMockId === mockId) _expandedMockId = null;
        renderMockInterviews();
    } catch (e) {
        showToast('Failed to delete mock interview', 'error');
    }
}

function toggleMockWhiteboard(mockId, show) {
    const container = document.getElementById(`mock-wb-container-${mockId}`);
    if (!container) return;
    container.style.display = show ? 'block' : 'none';

    if (show) {
        const iframe = document.getElementById(`mock-wb-iframe-${mockId}`);
        if (iframe && (!iframe.src || iframe.src === 'about:blank' || !iframe.src.includes('excalidraw'))) {
            iframe.src = '/static/excalidraw.html';
        }
        const mock = _mockInterviewsCache.find(m => m.id === mockId);
        if (mock && mock.whiteboard) {
            loadMockWhiteboard(mockId, mock.whiteboard);
        }
    }
}

let _mockWhiteboardPending = {}; // mockId -> scene

function loadMockWhiteboard(mockId, whiteboardJson) {
    const iframe = document.getElementById(`mock-wb-iframe-${mockId}`);
    if (!iframe) return;

    let scene = null;
    try { scene = typeof whiteboardJson === 'string' ? JSON.parse(whiteboardJson) : whiteboardJson; } catch (e) { return; }
    if (!scene || !scene.elements || scene.elements.length === 0) return;

    _mockWhiteboardPending[mockId] = scene;

    // If iframe not loaded yet, set src and wait
    if (!iframe.src || iframe.src === 'about:blank') {
        iframe.src = '/static/excalidraw.html';
    }
}

// Handle mock whiteboard ready + change messages
window.addEventListener('message', (e) => {
    if (!e.data || !e.data.type) return;
    if (!expandedJobId || !_selectedStageId) return;

    // Find which mock iframe sent the message
    let sourceMockId = null;
    for (const mock of _mockInterviewsCache) {
        const iframe = document.getElementById(`mock-wb-iframe-${mock.id}`);
        if (iframe && e.source === iframe.contentWindow) {
            sourceMockId = mock.id;
            break;
        }
    }
    if (sourceMockId === null) return;

    if (e.data.type === 'ready') {
        const pending = _mockWhiteboardPending[sourceMockId];
        if (pending) {
            const iframe = document.getElementById(`mock-wb-iframe-${sourceMockId}`);
            if (iframe) iframe.contentWindow.postMessage({ type: 'load', scene: pending }, '*');
            delete _mockWhiteboardPending[sourceMockId];
        }
    }

    if (e.data.type === 'change') {
        const mockId = sourceMockId;
        const key = `wb-${mockId}`;
        clearTimeout(_mockSaveTimers[key]);
        _mockSaveTimers[key] = setTimeout(async () => {
            const wbData = JSON.stringify(e.data.scene);
            await api.updateMock(expandedJobId, _selectedStageId, mockId, { whiteboard: wbData });
            const mock = _mockInterviewsCache.find(m => m.id === mockId);
            if (mock) mock.whiteboard = wbData;
        }, 2000);
    }
});

// =================== Init ===================

document.addEventListener('DOMContentLoaded', () => {
    refreshDiscovery();
});
