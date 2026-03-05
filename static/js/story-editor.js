/**
 * TipTap Story Editor Module
 *
 * Lightweight inline editor for interview stage stories.
 * Supports inline editing within the story card + expand-to-modal.
 * Exposes window.storyEditor API for app.js integration.
 */

import { Editor } from 'https://esm.sh/@tiptap/core@2.11.5';
import StarterKit from 'https://esm.sh/@tiptap/starter-kit@2.11.5';
import Underline from 'https://esm.sh/@tiptap/extension-underline@2.11.5';
import Link from 'https://esm.sh/@tiptap/extension-link@2.11.5';

let currentEditor = null;
let currentStoryId = null;
let onSaveCallback = null;
let onCancelCallback = null;
let saveTimer = null;
let isModalMode = false;

// =================== Toolbar ===================

function createToolbar(containerId) {
    const toolbar = document.createElement('div');
    toolbar.className = 'story-editor-toolbar';
    toolbar.id = `story-toolbar-${containerId}`;

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
            e.preventDefault(); // prevent focus loss
            runCommand(item.cmd);
        });
        toolbar.appendChild(btn);
    });

    // Expand button (right-aligned)
    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'story-editor-expand-btn';
    expandBtn.title = 'Expand to full editor';
    expandBtn.innerHTML = '&#x26F6;';
    expandBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        expandToModal();
    });
    toolbar.appendChild(expandBtn);

    return toolbar;
}

function runCommand(cmd) {
    if (!currentEditor) return;
    const chain = currentEditor.chain().focus();
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
    if (!currentEditor) return;
    const prevUrl = currentEditor.getAttributes('link').href || '';
    if (prevUrl) {
        const action = prompt(`Current link: ${prevUrl}\n\nEnter new URL (or leave empty to remove):`, prevUrl);
        if (action === null) return;
        if (action.trim() === '') {
            currentEditor.chain().focus().unsetLink().run();
        } else {
            currentEditor.chain().focus().extendMarkRange('link').setLink({ href: action.trim() }).run();
        }
    } else {
        const url = prompt('Enter URL:');
        if (!url || !url.trim()) return;
        currentEditor.chain().focus().setLink({ href: url.trim() }).run();
    }
    updateToolbarState();
}

function updateToolbarState() {
    const toolbars = document.querySelectorAll('.story-editor-toolbar');
    toolbars.forEach(toolbar => {
        if (!currentEditor) return;
        toolbar.querySelectorAll('button[data-cmd]').forEach(btn => {
            const cmd = btn.dataset.cmd;
            let active = false;
            switch (cmd) {
                case 'bold': active = currentEditor.isActive('bold'); break;
                case 'italic': active = currentEditor.isActive('italic'); break;
                case 'underline': active = currentEditor.isActive('underline'); break;
                case 'heading2': active = currentEditor.isActive('heading', { level: 2 }); break;
                case 'heading3': active = currentEditor.isActive('heading', { level: 3 }); break;
                case 'bulletList': active = currentEditor.isActive('bulletList'); break;
                case 'orderedList': active = currentEditor.isActive('orderedList'); break;
                case 'link': active = currentEditor.isActive('link'); break;
            }
            btn.classList.toggle('is-active', active);
        });
    });
}

// =================== Editor Init/Destroy ===================

function init(storyId, containerEl, htmlContent, callbacks) {
    destroy(); // clean up any existing editor

    currentStoryId = storyId;
    onSaveCallback = callbacks.onSave || null;
    onCancelCallback = callbacks.onCancel || null;

    // Build editor UI
    containerEl.innerHTML = '';
    containerEl.classList.add('story-editor-active');

    // Label
    const label = document.createElement('div');
    label.className = 'story-edit-label';
    label.innerHTML = 'Editing copy for this stage <span style="color:var(--text-muted);font-weight:400;">(original in Story Bank is unchanged)</span>';
    containerEl.appendChild(label);

    // Toolbar
    const toolbar = createToolbar(storyId);
    containerEl.appendChild(toolbar);

    // Editor mount
    const editorEl = document.createElement('div');
    editorEl.className = 'story-tiptap-wrapper';
    containerEl.appendChild(editorEl);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'story-edit-actions';
    actions.innerHTML = `
        <button type="button" class="btn btn-success btn-sm story-editor-save">Save</button>
        <button type="button" class="btn btn-ghost btn-sm story-editor-cancel">Cancel</button>
        ${callbacks.hasCustomContent ? '<button type="button" class="btn btn-ghost btn-sm btn-danger-hover story-editor-reset">Reset to Original</button>' : ''}
    `;
    containerEl.appendChild(actions);

    actions.querySelector('.story-editor-save').addEventListener('click', handleSave);
    actions.querySelector('.story-editor-cancel').addEventListener('click', handleCancel);
    const resetBtn = actions.querySelector('.story-editor-reset');
    if (resetBtn) resetBtn.addEventListener('click', () => callbacks.onReset && callbacks.onReset());

    // Create TipTap instance
    currentEditor = new Editor({
        element: editorEl,
        extensions: [
            StarterKit.configure({ heading: { levels: [2, 3] } }),
            Underline,
            Link.configure({
                openOnClick: false,
                HTMLAttributes: { target: '_blank', rel: 'noopener' },
            }),
        ],
        content: htmlContent || '',
        onSelectionUpdate() { updateToolbarState(); },
        onUpdate() { updateToolbarState(); },
    });

    // Focus editor
    setTimeout(() => currentEditor && currentEditor.commands.focus('end'), 50);
}

function destroy() {
    if (currentEditor) {
        currentEditor.destroy();
        currentEditor = null;
    }
    currentStoryId = null;
    onSaveCallback = null;
    onCancelCallback = null;
    isModalMode = false;

    // Clean up modal if open
    const modal = document.getElementById('story-editor-modal');
    if (modal) modal.remove();
}

function getHTML() {
    return currentEditor ? currentEditor.getHTML() : '';
}

function handleSave() {
    if (onSaveCallback) onSaveCallback(getHTML());
    if (isModalMode) closeModal();
}

function handleCancel() {
    if (isModalMode) {
        closeModal();
        // Restore inline view
        if (onCancelCallback) onCancelCallback();
    } else {
        if (onCancelCallback) onCancelCallback();
    }
}

// =================== Expand to Modal ===================

function expandToModal() {
    if (!currentEditor) return;
    isModalMode = true;

    // Capture current content
    const html = getHTML();
    const storyId = currentStoryId;

    // Create modal overlay
    const modal = document.createElement('div');
    modal.id = 'story-editor-modal';
    modal.className = 'story-editor-modal-overlay';
    modal.innerHTML = `
        <div class="story-editor-modal">
            <div class="story-editor-modal-header">
                <h3>Edit Story</h3>
                <button type="button" class="btn btn-ghost btn-sm" id="story-modal-close" title="Close">&times;</button>
            </div>
            <div class="story-editor-modal-toolbar" id="story-modal-toolbar-mount"></div>
            <div class="story-editor-modal-body">
                <div id="story-modal-editor" class="story-tiptap-wrapper story-tiptap-modal"></div>
            </div>
            <div class="story-editor-modal-footer">
                <button type="button" class="btn btn-success btn-sm story-editor-save">Save</button>
                <button type="button" class="btn btn-ghost btn-sm story-editor-cancel">Cancel</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('visible'));

    // Destroy inline editor
    if (currentEditor) {
        currentEditor.destroy();
        currentEditor = null;
    }

    // Mount toolbar in modal
    const toolbar = createToolbar('modal');
    // Hide the expand button in modal
    const expandBtn = toolbar.querySelector('.story-editor-expand-btn');
    if (expandBtn) expandBtn.style.display = 'none';
    document.getElementById('story-modal-toolbar-mount').appendChild(toolbar);

    // Create new editor in modal
    const editorEl = document.getElementById('story-modal-editor');
    currentEditor = new Editor({
        element: editorEl,
        extensions: [
            StarterKit.configure({ heading: { levels: [2, 3] } }),
            Underline,
            Link.configure({
                openOnClick: false,
                HTMLAttributes: { target: '_blank', rel: 'noopener' },
            }),
        ],
        content: html,
        onSelectionUpdate() { updateToolbarState(); },
        onUpdate() { updateToolbarState(); },
    });

    setTimeout(() => currentEditor && currentEditor.commands.focus('end'), 100);

    // Wire up modal buttons
    modal.querySelector('#story-modal-close').addEventListener('click', () => closeModal());
    modal.querySelector('.story-editor-save').addEventListener('click', handleSave);
    modal.querySelector('.story-editor-cancel').addEventListener('click', handleCancel);

    // Click backdrop to close
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // Escape to close
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            e.preventDefault();
            closeModal();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);
}

function closeModal() {
    const modal = document.getElementById('story-editor-modal');
    if (modal) {
        modal.classList.remove('visible');
        setTimeout(() => modal.remove(), 200);
    }
    if (currentEditor) {
        currentEditor.destroy();
        currentEditor = null;
    }
    isModalMode = false;
    // Trigger cancel to restore inline view
    if (onCancelCallback) onCancelCallback();
}

// =================== Export ===================

window.storyEditor = {
    init,
    destroy,
    getHTML,
};
