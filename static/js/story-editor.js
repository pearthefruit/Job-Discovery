/**
 * TipTap Story Editor Module
 *
 * Multi-instance, multi-group editor for stories across contexts
 * (Story Bank, Interview Prep, etc.). Each group gets its own toolbar,
 * editors, and save callback. Lazy initialization — editors created
 * only when a story is expanded. Auto-save on update with 1.5s debounce.
 *
 * Exposes window.storyEditor API for app.js integration.
 */

import { Editor } from 'https://esm.sh/@tiptap/core@2.11.5';
import StarterKit from 'https://esm.sh/@tiptap/starter-kit@2.11.5';
import Underline from 'https://esm.sh/@tiptap/extension-underline@2.11.5';
import Link from 'https://esm.sh/@tiptap/extension-link@2.11.5';

// Multi-group state — each group has independent editors, toolbar, and callbacks
const groups = new Map();

// Track which group is currently active (for toolbar commands)
let _activeGroupName = null;

function getGroup(name) {
    return groups.get(name);
}

function createGroup(name) {
    const group = {
        editors: {},
        storyDataMap: {},
        activeEditor: null,
        saveTimers: {},
        onSaveCallback: null,
        toolbarEl: null,
        elementPrefix: 'story-editor',
        cardSelector: '.assigned-story-card',
    };
    groups.set(name, group);
    return group;
}

// =================== TipTap Extensions (shared) ===================

const EDITOR_EXTENSIONS = [
    StarterKit.configure({ heading: { levels: [2, 3] } }),
    Underline,
    Link.configure({
        openOnClick: false,
        HTMLAttributes: { target: '_blank', rel: 'noopener' },
    }),
];

// =================== Shared Toolbar ===================

function createToolbar(groupName) {
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
            runCommand(groupName, item.cmd);
        });
        toolbar.appendChild(btn);
    });

    // Save indicator (right-aligned)
    const indicator = document.createElement('span');
    indicator.className = 'story-save-indicator';
    indicator.id = `story-save-indicator-${groupName}`;
    toolbar.appendChild(indicator);

    return toolbar;
}

function runCommand(groupName, cmd) {
    const group = getGroup(groupName);
    if (!group || !group.activeEditor) return;
    const chain = group.activeEditor.editor.chain().focus();
    switch (cmd) {
        case 'bold': chain.toggleBold().run(); break;
        case 'italic': chain.toggleItalic().run(); break;
        case 'underline': chain.toggleUnderline().run(); break;
        case 'heading2': chain.toggleHeading({ level: 2 }).run(); break;
        case 'heading3': chain.toggleHeading({ level: 3 }).run(); break;
        case 'bulletList': chain.toggleBulletList().run(); break;
        case 'orderedList': chain.toggleOrderedList().run(); break;
        case 'link': handleLinkCommand(groupName); return;
    }
    updateToolbarState(groupName);
}

function handleLinkCommand(groupName) {
    const group = getGroup(groupName);
    if (!group || !group.activeEditor) return;
    const ed = group.activeEditor.editor;
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
    updateToolbarState(groupName);
}

function updateToolbarState(groupName) {
    const group = getGroup(groupName);
    if (!group || !group.toolbarEl) return;
    const ed = group.activeEditor ? group.activeEditor.editor : null;
    group.toolbarEl.querySelectorAll('button[data-cmd]').forEach(btn => {
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

function showSaveStatus(groupName, text, className) {
    const el = document.getElementById(`story-save-indicator-${groupName}`);
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

function _createEditor(groupName, id) {
    const group = getGroup(groupName);
    if (!group) return null;
    const data = group.storyDataMap[id];
    if (!data) return null;
    const wrapper = document.getElementById(`${group.elementPrefix}-${id}`);
    if (!wrapper) return null;

    // Clear static HTML placeholder before TipTap mounts
    wrapper.innerHTML = '';

    const editor = new Editor({
        element: wrapper,
        extensions: EDITOR_EXTENSIONS,
        content: data.htmlContent || '',
        onFocus() {
            group.activeEditor = { id, editor };
            _activeGroupName = groupName;
            updateToolbarState(groupName);
            // Remove editing highlight from all cards in this group
            const container = group.toolbarEl ? group.toolbarEl.parentNode : null;
            if (container) {
                container.querySelectorAll(`${group.cardSelector}.story-editing`)
                    .forEach(c => c.classList.remove('story-editing'));
            }
            const card = wrapper.closest(group.cardSelector);
            if (card) card.classList.add('story-editing');
        },
        onBlur() {
            setTimeout(() => {
                if (group.activeEditor && group.activeEditor.id === id && !editor.isFocused) {
                    const card = wrapper.closest(group.cardSelector);
                    if (card) card.classList.remove('story-editing');
                }
            }, 150);
        },
        onUpdate() {
            updateToolbarState(groupName);
            showSaveStatus(groupName, 'Editing...', 'editing');
            clearTimeout(group.saveTimers[id]);
            group.saveTimers[id] = setTimeout(() => {
                if (group.onSaveCallback) {
                    group.onSaveCallback(id, editor.getHTML());
                }
            }, 1500);
        },
        onSelectionUpdate() {
            updateToolbarState(groupName);
        },
    });

    group.editors[id] = editor;
    return editor;
}

/**
 * Called when a story is expanded — creates the TipTap editor if not yet initialized.
 */
function ensureEditor(groupName, storyId) {
    const group = getGroup(groupName);
    if (!group || group.editors[storyId]) return;
    _createEditor(groupName, storyId);
}

// =================== Init / Destroy ===================

function initEditors(groupName, container, storyData, callbacks) {
    // Destroy existing group if re-initializing
    if (groups.has(groupName)) {
        destroyEditors(groupName);
    }

    const group = createGroup(groupName);
    group.onSaveCallback = callbacks.onSave || null;
    group.elementPrefix = callbacks.elementPrefix || 'story-editor';
    group.cardSelector = callbacks.cardSelector || '.assigned-story-card';

    if (!storyData.length) return;

    // Store data for lazy init — don't create editors yet
    storyData.forEach(({ id, htmlContent }) => {
        group.storyDataMap[id] = { htmlContent };
    });

    // Create shared toolbar at top of container
    group.toolbarEl = createToolbar(groupName);
    container.insertBefore(group.toolbarEl, container.firstChild);
}

function destroyEditors(groupName) {
    const group = getGroup(groupName);
    if (!group) return;

    // Flush any pending saves
    Object.entries(group.saveTimers).forEach(([id, timer]) => {
        clearTimeout(timer);
        const editor = group.editors[id];
        if (editor && group.onSaveCallback) {
            group.onSaveCallback(parseInt(id), editor.getHTML());
        }
    });
    group.saveTimers = {};

    // Destroy all editors
    Object.values(group.editors).forEach(e => e.destroy());

    // Remove toolbar
    if (group.toolbarEl && group.toolbarEl.parentNode) {
        group.toolbarEl.remove();
    }

    // Clear active group if it was this one
    if (_activeGroupName === groupName) {
        _activeGroupName = null;
    }

    groups.delete(groupName);
}

function destroyAll() {
    for (const name of [...groups.keys()]) {
        destroyEditors(name);
    }
}

function getHTML(groupName, storyId) {
    const group = getGroup(groupName);
    if (!group) return '';
    const editor = group.editors[storyId];
    return editor ? editor.getHTML() : '';
}

function setContent(groupName, storyId, html) {
    const group = getGroup(groupName);
    if (!group) return;
    const editor = group.editors[storyId];
    if (editor) {
        editor.commands.setContent(html);
    }
    // Also update stored data so re-expand after reset works
    if (group.storyDataMap[storyId]) {
        group.storyDataMap[storyId].htmlContent = html;
    }
}

// =================== Standalone Editor (for Add/Create forms) ===================

function createStandaloneEditor(elementId) {
    const wrapper = document.getElementById(elementId);
    if (!wrapper) return null;
    wrapper.innerHTML = '';
    return new Editor({
        element: wrapper,
        extensions: EDITOR_EXTENSIONS,
        content: '',
    });
}

function destroyStandaloneEditor(editor) {
    if (editor) editor.destroy();
}

// =================== Export ===================

window.storyEditor = {
    initEditors,
    destroyEditors,
    destroyAll,
    ensureEditor,
    getHTML,
    setContent,
    showSaveStatus,
    createStandaloneEditor,
    destroyStandaloneEditor,
};
