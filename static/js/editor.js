/**
 * TipTap Resume Editor Module
 *
 * Provides rich-text editing for resume sections using TipTap via esm.sh CDN.
 * Exposes window.resumeEditor API for app.js integration.
 */

import { Editor } from 'https://esm.sh/@tiptap/core@2.11.5';
import StarterKit from 'https://esm.sh/@tiptap/starter-kit@2.11.5';
import TextAlign from 'https://esm.sh/@tiptap/extension-text-align@2.11.5';
import Underline from 'https://esm.sh/@tiptap/extension-underline@2.11.5';
import Link from 'https://esm.sh/@tiptap/extension-link@2.11.5';
import TextStyle from 'https://esm.sh/@tiptap/extension-text-style@2.11.5';
import Color from 'https://esm.sh/@tiptap/extension-color@2.11.5';

let editors = [];
let activeEditor = null;
let appId = null;
let saveTimer = null;
let saveIndicator = null;

// Bullet hover state
let bulletBar = null;
let hoveredLi = null;
let hoveredEditorInstance = null;
let bulletSuggestions = [];
let onImproveCallback = null;
let barHideTimer = null;

// =================== Section Labels ===================

const SECTION_LABELS = {
    header: 'Header',
    headline: 'Headline',
    contact: 'Contact',
    summary: 'Summary',
    keywords: 'Keywords',
    experience: 'Experience',
    education: 'Education',
    skills: 'Skills',
    projects: 'Projects',
    certifications: 'Certifications',
    interests: 'Interests',
};

function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

// =================== Toolbar ===================

function createToolbar() {
    const existing = document.getElementById('resume-format-toolbar');
    if (existing) existing.remove();

    const toolbar = document.createElement('div');
    toolbar.id = 'resume-format-toolbar';
    toolbar.className = 'editor-toolbar resume-format-toolbar';

    const buttons = [
        { cmd: 'bold', label: 'B', title: 'Bold (Ctrl+B)', style: 'font-weight:bold' },
        { cmd: 'italic', label: 'I', title: 'Italic (Ctrl+I)', style: 'font-style:italic' },
        { cmd: 'underline', label: 'U', title: 'Underline (Ctrl+U)', style: 'text-decoration:underline' },
        null,
        { cmd: 'heading2', label: 'H2', title: 'Heading 2' },
        { cmd: 'heading3', label: 'H3', title: 'Heading 3' },
        null,
        { cmd: 'bulletList', label: '\u2022', title: 'Bullet List' },
        { cmd: 'orderedList', label: '1.', title: 'Numbered List' },
        null,
        { cmd: 'link', label: '\uD83D\uDD17', title: 'Insert/Edit Link' },
        null,
        { cmd: 'alignLeft', label: '\u2190', title: 'Align Left' },
        { cmd: 'alignCenter', label: '\u2194', title: 'Align Center' },
        { cmd: 'alignRight', label: '\u2192', title: 'Align Right' },
    ];

    buttons.forEach(item => {
        if (item === null) {
            const d = document.createElement('span');
            d.className = 'divider';
            toolbar.appendChild(d);
            return;
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = item.title;
        btn.textContent = item.label;
        btn.dataset.cmd = item.cmd;
        if (item.style) btn.setAttribute('style', item.style);
        btn.addEventListener('click', () => runCommand(item.cmd));
        toolbar.appendChild(btn);
    });

    // Color picker dropdown
    const colorBtn = document.createElement('div');
    colorBtn.className = 'color-picker-wrapper';
    colorBtn.innerHTML = `
        <button type="button" class="color-picker-trigger" title="Text Color" data-cmd="color">A</button>
        <div class="color-picker-dropdown">
            ${['#ffffff','#f87171','#fb923c','#facc15','#4ade80','#60a5fa','#a78bfa','#f472b6'].map(c =>
                `<button type="button" class="color-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`
            ).join('')}
            <button type="button" class="color-swatch color-reset" data-color="" title="Reset color">x</button>
        </div>
    `;
    colorBtn.querySelector('.color-picker-trigger').addEventListener('click', () => {
        colorBtn.classList.toggle('open');
    });
    colorBtn.querySelectorAll('.color-swatch').forEach(swatch => {
        swatch.addEventListener('click', () => {
            const color = swatch.dataset.color;
            if (!activeEditor) return;
            if (color) {
                activeEditor.chain().focus().setColor(color).run();
            } else {
                activeEditor.chain().focus().unsetColor().run();
            }
            colorBtn.classList.remove('open');
            updateToolbarState();
        });
    });
    toolbar.appendChild(colorBtn);

    // Save indicator (right-aligned)
    saveIndicator = document.createElement('span');
    saveIndicator.className = 'save-indicator';
    toolbar.appendChild(saveIndicator);

    return toolbar;
}

function runCommand(cmd) {
    if (!activeEditor) return;
    const chain = activeEditor.chain().focus();
    switch (cmd) {
        case 'bold': chain.toggleBold().run(); break;
        case 'italic': chain.toggleItalic().run(); break;
        case 'underline': chain.toggleUnderline().run(); break;
        case 'heading2': chain.toggleHeading({ level: 2 }).run(); break;
        case 'heading3': chain.toggleHeading({ level: 3 }).run(); break;
        case 'bulletList': chain.toggleBulletList().run(); break;
        case 'orderedList': chain.toggleOrderedList().run(); break;
        case 'link': handleLinkCommand(); return; // handled separately
        case 'alignLeft': chain.setTextAlign('left').run(); break;
        case 'alignCenter': chain.setTextAlign('center').run(); break;
        case 'alignRight': chain.setTextAlign('right').run(); break;
    }
    updateToolbarState();
}

function handleLinkCommand() {
    if (!activeEditor) return;

    const prevUrl = activeEditor.getAttributes('link').href || '';
    if (prevUrl) {
        // Already a link — offer to remove or edit
        const action = prompt(`Current link: ${prevUrl}\n\nEnter new URL (or leave empty to remove link):`, prevUrl);
        if (action === null) return; // cancelled
        if (action.trim() === '') {
            activeEditor.chain().focus().unsetLink().run();
        } else {
            activeEditor.chain().focus().extendMarkRange('link').setLink({ href: action.trim() }).run();
        }
    } else {
        const url = prompt('Enter URL:');
        if (!url || !url.trim()) return;
        activeEditor.chain().focus().setLink({ href: url.trim() }).run();
    }
    updateToolbarState();
}

function updateToolbarState() {
    const toolbar = document.getElementById('resume-format-toolbar');
    if (!toolbar || !activeEditor) return;

    toolbar.querySelectorAll('button[data-cmd]').forEach(btn => {
        const cmd = btn.dataset.cmd;
        let active = false;
        switch (cmd) {
            case 'bold': active = activeEditor.isActive('bold'); break;
            case 'italic': active = activeEditor.isActive('italic'); break;
            case 'underline': active = activeEditor.isActive('underline'); break;
            case 'heading2': active = activeEditor.isActive('heading', { level: 2 }); break;
            case 'heading3': active = activeEditor.isActive('heading', { level: 3 }); break;
            case 'bulletList': active = activeEditor.isActive('bulletList'); break;
            case 'orderedList': active = activeEditor.isActive('orderedList'); break;
            case 'link': active = activeEditor.isActive('link'); break;
            case 'alignLeft': active = activeEditor.isActive({ textAlign: 'left' }); break;
            case 'alignCenter': active = activeEditor.isActive({ textAlign: 'center' }); break;
            case 'alignRight': active = activeEditor.isActive({ textAlign: 'right' }); break;
        }
        btn.classList.toggle('is-active', active);
    });
}

// =================== Auto-save ===================

function scheduleSave() {
    if (saveIndicator) {
        saveIndicator.textContent = 'Editing...';
        saveIndicator.className = 'save-indicator unsaved';
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 1500);
}

async function doSave() {
    if (!appId || editors.length === 0) return;

    // Collect HTML from each editor, merging sub-sections back into originals
    const rawEntries = editors.map(({ editor, sectionId, sectionType, parentId, originalType }) => ({
        id: parentId || sectionId,
        type: originalType || sectionType,
        html: editor.getHTML(),
    }));
    // Merge entries that share the same parent ID (e.g., headline + contact → header)
    const mergedMap = new Map();
    for (const entry of rawEntries) {
        if (!mergedMap.has(entry.id)) mergedMap.set(entry.id, { id: entry.id, type: entry.type, parts: [] });
        mergedMap.get(entry.id).parts.push(entry.html);
    }
    const sectionsData = [...mergedMap.values()].map(m => ({
        id: m.id,
        type: m.type,
        html: m.parts.join('\n'),
    }));

    const combinedHtml = sectionsData.map(s => s.html).join('\n');
    const contentJson = JSON.stringify(sectionsData);

    try {
        await fetch(`/api/applications/${appId}/content`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content_html: combinedHtml, content_json: contentJson }),
        });
        if (saveIndicator) {
            saveIndicator.textContent = 'Saved';
            saveIndicator.className = 'save-indicator saved';
            setTimeout(() => {
                if (saveIndicator && saveIndicator.textContent === 'Saved') {
                    saveIndicator.textContent = '';
                }
            }, 2000);
        }
    } catch (e) {
        console.error('Auto-save failed:', e);
        if (saveIndicator) {
            saveIndicator.textContent = 'Save failed';
            saveIndicator.className = 'save-indicator error';
        }
    }
}

// =================== Editor Lifecycle ===================

function initEditors(sections, applicationId) {
    destroyEditors();
    appId = applicationId;

    const container = document.getElementById('resume-sections-container');
    const parent = document.getElementById('resume-display');
    container.innerHTML = '';

    // Insert formatting toolbar
    const toolbar = createToolbar();
    parent.insertBefore(toolbar, container);

    sections.forEach(section => {
        const wrapper = document.createElement('div');
        wrapper.className = 'resume-section';
        wrapper.dataset.sectionId = section.id;

        // Section header with type chip + metadata
        const header = document.createElement('div');
        header.className = 'section-header-row';
        const typeLabel = SECTION_LABELS[section.section_type] || section.section_type;
        const meta = [section.company_name, section.role_title, section.dates]
            .filter(Boolean).join(' \u2014 ');
        header.innerHTML = `
            <span class="chip-sm">${esc(typeLabel)}</span>
            ${meta ? `<span class="section-meta">${esc(meta)}</span>` : ''}
        `;
        wrapper.appendChild(header);

        // Editor mount point
        const editorEl = document.createElement('div');
        editorEl.className = 'tiptap-wrapper';
        wrapper.appendChild(editorEl);

        container.appendChild(wrapper);

        // Create TipTap editor instance
        const editor = new Editor({
            element: editorEl,
            extensions: [
                StarterKit.configure({
                    heading: { levels: [2, 3] },
                }),
                TextAlign.configure({
                    types: ['heading', 'paragraph'],
                }),
                Underline,
                Link.configure({
                    openOnClick: false,
                    HTMLAttributes: { target: '_blank', rel: 'noopener' },
                }),
                TextStyle,
                Color,
            ],
            content: section.content_html || '',
            onFocus() {
                activeEditor = editor;
                container.querySelectorAll('.resume-section').forEach(el =>
                    el.classList.remove('editing')
                );
                wrapper.classList.add('editing');
                updateToolbarState();
            },
            onUpdate() {
                scheduleSave();
                updateToolbarState();
            },
            onSelectionUpdate() {
                updateToolbarState();
            },
        });

        editors.push({
            editor,
            sectionId: section.id,
            sectionType: section.section_type,
            parentId: section._parentId || null,
            originalType: section._originalType || null,
        });
    });

    // Set up bullet hover after all editors are ready
    setupBulletHovers();
}

function destroyEditors() {
    // Flush pending save
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        if (appId && editors.length > 0) {
            doSave(); // fire and forget
        }
    }

    destroyBulletBar();

    editors.forEach(({ editor }) => editor.destroy());
    editors = [];
    activeEditor = null;
    appId = null;

    // Remove formatting toolbar
    const toolbar = document.getElementById('resume-format-toolbar');
    if (toolbar) toolbar.remove();
}

function getContent() {
    return editors.map(({ editor, sectionId, sectionType }) => ({
        id: sectionId,
        type: sectionType,
        html: editor.getHTML(),
    }));
}

// =================== Bullet Hover UX ===================

function setupBulletHovers() {
    // Visual highlight is handled entirely by pure CSS :hover pseudo-classes
    // (ProseMirror can't interfere with those). JS only manages the action bar.
    editors.forEach(({ editor, sectionType }) => {
        const el = editor.options.element;

        el.addEventListener('mouseover', (e) => {
            // Skip contact sections entirely (not analyzed)
            if (sectionType === 'contact') return;
            // Match bullet items, paragraphs, and headings
            const target = e.target.closest('li') || e.target.closest('p')
                || e.target.closest('h2') || e.target.closest('h3');
            if (!target || !el.contains(target)) return;
            // Skip very short paragraphs (but not headings — those are intentionally short)
            if (target.tagName === 'P' && target.textContent.trim().length < 30) return;
            if (target === hoveredLi) return;

            hoveredLi = target;
            hoveredEditorInstance = editor;

            if (barHideTimer) { clearTimeout(barHideTimer); barHideTimer = null; }
            positionBulletBar(target);
        });

        el.addEventListener('mouseleave', () => {
            scheduleBarHide();
        });
    });

    // Hide bar on panel scroll
    const panelLeft = document.querySelector('.panel-left');
    if (panelLeft) {
        panelLeft.addEventListener('scroll', () => {
            hideBulletBarImmediate();
        }, { passive: true });
    }
}

function createBulletBar() {
    if (bulletBar) return;

    const bar = document.createElement('div');
    bar.id = 'bullet-action-bar';
    bar.className = 'bullet-action-bar';
    bar.innerHTML = `
        <button class="bullet-btn bullet-btn-improve" data-action="improve">Improve</button>
    `;

    bar.addEventListener('mouseenter', () => {
        if (barHideTimer) { clearTimeout(barHideTimer); barHideTimer = null; }
    });

    bar.addEventListener('mouseleave', () => {
        scheduleBarHide();
    });

    bar.querySelector('[data-action="improve"]').addEventListener('click', handleBulletImprove);

    document.body.appendChild(bar);
    bulletBar = bar;
}

function positionBulletBar(li) {
    if (!bulletBar) createBulletBar();

    const rect = li.getBoundingClientRect();
    const barWidth = 160;
    let top = rect.top + (rect.height / 2) - 16;
    let left = rect.right + 8;

    if (left + barWidth > window.innerWidth - 20) {
        left = rect.left - barWidth - 8;
    }
    if (top < 4) top = 4;
    if (top > window.innerHeight - 40) top = window.innerHeight - 40;

    bulletBar.style.display = 'flex';
    bulletBar.style.top = `${top}px`;
    bulletBar.style.left = `${left}px`;

    updateImproveButtonState();
}

function getHoveredSectionType() {
    if (!hoveredEditorInstance) return null;
    const entry = editors.find(e => e.editor === hoveredEditorInstance);
    return entry ? entry.sectionType : null;
}

function updateImproveButtonState() {
    if (!bulletBar || !hoveredLi) return;
    const btn = bulletBar.querySelector('[data-action="improve"]');
    const bulletText = hoveredLi.textContent.trim();
    const sectionType = getHoveredSectionType();
    const suggestion = findSuggestionForBullet(bulletText, sectionType);

    btn.className = 'bullet-btn bullet-btn-improve';
    if (suggestion) {
        const ratingClass = suggestion.rating === 'STRONG' ? 'rating-strong' :
                            suggestion.rating === 'MODERATE' ? 'rating-moderate' : 'rating-weak';
        btn.classList.add(ratingClass);
        btn.textContent = suggestion.rating === 'STRONG' ? 'Strong' : 'Improve';
    } else {
        btn.textContent = 'Improve';
    }
}

function clearBulletHighlight() {
    // No-op: visual highlight is handled entirely by CSS :hover pseudo-classes
}

function scheduleBarHide() {
    if (barHideTimer) clearTimeout(barHideTimer);
    barHideTimer = setTimeout(() => {
        hideBulletBarImmediate();
    }, 200);
}

function hideBulletBarImmediate() {
    if (bulletBar) bulletBar.style.display = 'none';
    clearBulletHighlight();
    hoveredLi = null;
    hoveredEditorInstance = null;
    if (barHideTimer) { clearTimeout(barHideTimer); barHideTimer = null; }
}

function handleBulletImprove() {
    if (!hoveredLi) return;
    const bulletText = hoveredLi.textContent.trim();
    const sectionType = getHoveredSectionType();
    const suggestion = findSuggestionForBullet(bulletText, sectionType);

    if (onImproveCallback) {
        onImproveCallback({
            originalText: bulletText,
            suggestion: suggestion,
            liElement: hoveredLi,
            editor: hoveredEditorInstance,
        });
    }
}

function handleBulletEdit() {
    if (!hoveredLi || !hoveredEditorInstance) return;

    try {
        const view = hoveredEditorInstance.view;
        const pos = view.posAtDOM(hoveredLi, 0);
        hoveredEditorInstance.commands.focus();
        hoveredEditorInstance.commands.setTextSelection(pos + 1);
    } catch (e) {
        hoveredEditorInstance.commands.focus();
    }

    hideBulletBarImmediate();
}

function findSuggestionForBullet(bulletText, sectionType) {
    if (!bulletSuggestions.length || !bulletText) return null;

    // For Phase 1 sub-sections, use direct target matching (no fuzzy logic)
    if (sectionType === 'headline') {
        return bulletSuggestions.find(s => s.target === 'headline') || null;
    }
    if (sectionType === 'summary') {
        return bulletSuggestions.find(s => s.target === 'summary') || null;
    }
    if (sectionType === 'keywords') {
        const text = bulletText.trim().toLowerCase();
        if (text.startsWith('skills')) return bulletSuggestions.find(s => s.target === 'skills') || null;
        if (text.startsWith('tools')) return bulletSuggestions.find(s => s.target === 'tools') || null;
        return null;
    }
    if (sectionType === 'contact') {
        return null;  // Contact info is never analyzed
    }

    // For experience/other sections, use fuzzy matching (Phase 2 bullet analysis)
    const normalize = (t) => t.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const normalized = normalize(bulletText);

    let bestMatch = null;
    let bestScore = 0;

    for (const s of bulletSuggestions) {
        if (s.target) continue;  // Skip Phase 1 suggestions in fuzzy matching
        const sNorm = normalize(s.current);

        // Exact match
        if (normalized === sNorm) return s;

        // Containment
        if (normalized.includes(sNorm) || sNorm.includes(normalized)) {
            const score = Math.min(normalized.length, sNorm.length) / Math.max(normalized.length, sNorm.length);
            if (score > bestScore) { bestScore = score; bestMatch = s; }
        }

        // Word overlap
        const words1 = new Set(normalized.split(' '));
        const words2 = sNorm.split(' ');
        const overlap = words2.filter(w => words1.has(w)).length;
        const score = overlap / Math.max(words2.length, 1);
        if (score > bestScore && score > 0.4) { bestScore = score; bestMatch = s; }
    }

    return bestScore > 0.35 ? bestMatch : null;
}

function acceptRewrite(liElement, editorInstance, newText) {
    if (!liElement || !editorInstance) return false;

    try {
        const view = editorInstance.view;
        const pos = view.posAtDOM(liElement, 0);
        const resolved = view.state.doc.resolve(pos);

        for (let depth = resolved.depth; depth >= 0; depth--) {
            const node = resolved.node(depth);
            if (node.type.name === 'listItem') {
                const before = resolved.before(depth);
                const child = node.child(0);
                if (child && child.type.name === 'paragraph') {
                    const textStart = before + 2;
                    const textEnd = textStart + child.content.size;

                    const tr = view.state.tr;
                    if (child.content.size > 0) {
                        tr.replaceWith(textStart, textEnd, view.state.schema.text(newText));
                    } else {
                        tr.insertText(newText, textStart);
                    }
                    view.dispatch(tr);
                    scheduleSave();
                    return true;
                }
            }
            // Handle paragraph and heading nodes
            if (node.type.name === 'paragraph' || node.type.name === 'heading') {
                const before = resolved.before(depth);
                const textStart = before + 1;
                const textEnd = textStart + node.content.size;

                const tr = view.state.tr;
                if (node.content.size > 0) {
                    tr.replaceWith(textStart, textEnd, view.state.schema.text(newText));
                } else {
                    tr.insertText(newText, textStart);
                }
                view.dispatch(tr);
                scheduleSave();
                return true;
            }
        }
    } catch (e) {
        console.error('Failed to accept rewrite:', e);
    }
    return false;
}

function setBulletSuggestionsData(suggestions) {
    bulletSuggestions = suggestions || [];
}

function setOnImproveCallback(fn) {
    onImproveCallback = fn;
}

function destroyBulletBar() {
    if (bulletBar) {
        bulletBar.remove();
        bulletBar = null;
    }
    clearBulletHighlight();
    hoveredLi = null;
    hoveredEditorInstance = null;
    bulletSuggestions = [];
    onImproveCallback = null;
    if (barHideTimer) { clearTimeout(barHideTimer); barHideTimer = null; }
}

// =================== Expose API ===================

window.resumeEditor = {
    initEditors,
    destroyEditors,
    getContent,
    setBulletSuggestions: setBulletSuggestionsData,
    setOnImprove: setOnImproveCallback,
    acceptRewrite,
};
