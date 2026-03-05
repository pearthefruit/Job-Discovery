/**
 * TipTap Story Editor Module
 *
 * Multi-instance editor for interview stage stories.
 * Lazy initialization — editors are created only when a story is expanded,
 * so tab switches are fast regardless of how many stories are assigned.
 * Shared toolbar above all stories, auto-save on update with 1.5s debounce.
 *
 * Exposes window.storyEditor API for app.js integration.
 */

import { Editor } from 'https://esm.sh/@tiptap/core@2.11.5';
import StarterKit from 'https://esm.sh/@tiptap/starter-kit@2.11.5';
import Underline from 'https://esm.sh/@tiptap/extension-underline@2.11.5';
import Link from 'https://esm.sh/@tiptap/extension-link@2.11.5';

let editors = {};          // { storyId: Editor }
let storyDataMap = {};     // { storyId: { htmlContent } } — for lazy init
let activeEditor = null;   // { id, editor }
let saveTimers = {};
let _onSaveCallback = null;
let _toolbarEl = null;

// =================== Shared Toolbar ===================

function createToolbar() {
    const toolbar = document.createElement('div');
    toolbar.className = 'story-editor-toolbar story-toolbar-shared';

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
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            runCommand(item.cmd);
        });
        toolbar.appendChild(btn);
    });

    // Save indicator (right-aligned)
    const indicator = document.createElement('span');
    indicator.className = 'story-save-indicator';
    indicator.id = 'story-save-indicator';
    toolbar.appendChild(indicator);

    return toolbar;
}

function runCommand(cmd) {
    if (!activeEditor) return;
    const chain = activeEditor.editor.chain().focus();
    switch (cmd) {
        case 'bold': chain.toggleBold().run(); break;
        case 'italic': chain.toggleItalic().run(); break;
        case 'underline': chain.toggleUnderline().run(); break;
        case 'heading2': chain.toggleHeading({ level: 2 }).run(); break;
        case 'heading3': chain.toggleHeading({ level: 3 }).run(); break;
        case 'bulletList': chain.toggleBulletList().run(); break;
        case 'orderedList': chain.toggleOrderedList().run(); break;
        case 'link': handleLinkCommand(); return;
    }
    updateToolbarState();
}

function handleLinkCommand() {
    if (!activeEditor) return;
    const ed = activeEditor.editor;
    const prevUrl = ed.getAttributes('link').href || '';
    if (prevUrl) {
        const action = prompt(`Current link: ${prevUrl}\n\nEnter new URL (or leave empty to remove):`, prevUrl);
        if (action === null) return;
        if (action.trim() === '') {
            ed.chain().focus().unsetLink().run();
        } else {
            ed.chain().focus().extendMarkRange('link').setLink({ href: action.trim() }).run();
        }
    } else {
        const url = prompt('Enter URL:');
        if (!url || !url.trim()) return;
        ed.chain().focus().setLink({ href: url.trim() }).run();
    }
    updateToolbarState();
}

function updateToolbarState() {
    if (!_toolbarEl) return;
    const ed = activeEditor ? activeEditor.editor : null;
    _toolbarEl.querySelectorAll('button[data-cmd]').forEach(btn => {
        const cmd = btn.dataset.cmd;
        let active = false;
        if (ed) {
            switch (cmd) {
                case 'bold': active = ed.isActive('bold'); break;
                case 'italic': active = ed.isActive('italic'); break;
                case 'underline': active = ed.isActive('underline'); break;
                case 'heading2': active = ed.isActive('heading', { level: 2 }); break;
                case 'heading3': active = ed.isActive('heading', { level: 3 }); break;
                case 'bulletList': active = ed.isActive('bulletList'); break;
                case 'orderedList': active = ed.isActive('orderedList'); break;
                case 'link': active = ed.isActive('link'); break;
            }
        }
        btn.classList.toggle('is-active', active);
    });
}

function showSaveStatus(text, className) {
    const el = document.getElementById('story-save-indicator');
    if (!el) return;
    el.textContent = text;
    el.className = 'story-save-indicator ' + (className || '');
    if (className === 'saved') {
        setTimeout(() => {
            if (el.textContent === text) {
                el.textContent = '';
                el.className = 'story-save-indicator';
            }
        }, 2000);
    }
}

// =================== Lazy Editor Creation ===================

function _createEditor(id) {
    const data = storyDataMap[id];
    if (!data) return null;
    const wrapper = document.getElementById(`story-editor-${id}`);
    if (!wrapper) return null;

    // Clear static HTML placeholder before TipTap mounts
    wrapper.innerHTML = '';

    const editor = new Editor({
        element: wrapper,
        extensions: [
            StarterKit.configure({ heading: { levels: [2, 3] } }),
            Underline,
            Link.configure({
                openOnClick: false,
                HTMLAttributes: { target: '_blank', rel: 'noopener' },
            }),
        ],
        content: data.htmlContent || '',
        onFocus() {
            activeEditor = { id, editor };
            updateToolbarState();
            document.querySelectorAll('.assigned-story-card.story-editing')
                .forEach(c => c.classList.remove('story-editing'));
            const card = wrapper.closest('.assigned-story-card');
            if (card) card.classList.add('story-editing');
        },
        onBlur() {
            setTimeout(() => {
                if (activeEditor && activeEditor.id === id && !editor.isFocused) {
                    const card = wrapper.closest('.assigned-story-card');
                    if (card) card.classList.remove('story-editing');
                }
            }, 150);
        },
        onUpdate() {
            updateToolbarState();
            showSaveStatus('Editing...', 'editing');
            clearTimeout(saveTimers[id]);
            saveTimers[id] = setTimeout(() => {
                if (_onSaveCallback) {
                    _onSaveCallback(id, editor.getHTML());
                }
            }, 1500);
        },
        onSelectionUpdate() {
            updateToolbarState();
        },
    });

    editors[id] = editor;
    return editor;
}

/**
 * Called when a story is expanded — creates the TipTap editor if not yet initialized.
 * Since the grid animation takes 0.3s and TipTap init takes ~20ms, the editor is
 * ready well before the content becomes visible.
 */
function ensureEditor(storyId) {
    if (editors[storyId]) return;
    _createEditor(storyId);
}

// =================== Init / Destroy ===================

function initEditors(container, storyData, callbacks) {
    destroyEditors();
    _onSaveCallback = callbacks.onSave || null;

    if (!storyData.length) return;

    // Store data for lazy init — don't create editors yet
    storyData.forEach(({ id, htmlContent }) => {
        storyDataMap[id] = { htmlContent };
    });

    // Create shared toolbar at top of container
    _toolbarEl = createToolbar();
    container.insertBefore(_toolbarEl, container.firstChild);
}

function destroyEditors() {
    // Flush any pending saves
    Object.entries(saveTimers).forEach(([id, timer]) => {
        clearTimeout(timer);
        const editor = editors[id];
        if (editor && _onSaveCallback) {
            _onSaveCallback(parseInt(id), editor.getHTML());
        }
    });
    saveTimers = {};

    // Destroy all editors
    Object.values(editors).forEach(e => e.destroy());
    editors = {};
    storyDataMap = {};
    activeEditor = null;

    // Remove toolbar
    if (_toolbarEl && _toolbarEl.parentNode) {
        _toolbarEl.remove();
    }
    _toolbarEl = null;
    _onSaveCallback = null;
}

function getHTML(storyId) {
    const editor = editors[storyId];
    return editor ? editor.getHTML() : '';
}

function setContent(storyId, html) {
    const editor = editors[storyId];
    if (editor) {
        editor.commands.setContent(html);
    }
    // Also update stored data so re-expand after reset works
    if (storyDataMap[storyId]) {
        storyDataMap[storyId].htmlContent = html;
    }
}

// =================== Export ===================

window.storyEditor = {
    initEditors,
    destroyEditors,
    ensureEditor,
    getHTML,
    setContent,
    showSaveStatus,
};
