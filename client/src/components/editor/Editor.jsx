import React, { useEffect, useRef, useState, useCallback } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { api } from '../../api/client.js';
import BacklinksPanel from './BacklinksPanel.jsx';
import { wikilinkCompletion } from './wikilinkComplete.js';
import NotePreview from './NotePreview.jsx';
import EditorToolbar from './EditorToolbar.jsx';

const SAVE_DEBOUNCE_MS = 1000;

export default function Editor({ notePath, notebookId, onNavigate, onDelete, onRename, mode = 'edit', onModeChange, notebooks, onNotebookChange }) {
  const editorRef = useRef(null);
  const viewRef = useRef(null);
  const saveTimer = useRef(null);
  // Content of the note we last knowingly loaded/saved. The load path dispatches
  // this into the editor, which CodeMirror reports as `docChanged`; without
  // this guard the auto-save would fire a redundant PUT (re-writing the file and
  // re-indexing it for no change).
  const loadedRef = useRef('');
  const notePathRef = useRef(notePath);
  const notebookIdRef = useRef(notebookId);
  const [backlinks, setBacklinks] = useState([]);
  const [status, setStatus] = useState('');
  const [previewContent, setPreviewContent] = useState('');
  const [noteNotebooks, setNoteNotebooks] = useState([]);
  const [showNbPicker, setShowNbPicker] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef(null);
  const [savingTpl, setSavingTpl] = useState(false);
  const [tplName, setTplName] = useState('');
  const tplInputRef = useRef(null);

  // Derive role for the active shared notebook
  const activeNotebook = notebookId ? (notebooks ?? []).find(n => n.id === notebookId) : null;
  const sharedRole = activeNotebook?.role ?? null; // 'owner'|'editor'|'viewer'|null
  const isShared = notebookId != null;
  const isReadOnly = sharedRole === 'viewer';
  const canEdit = !isShared || sharedRole === 'owner' || sharedRole === 'editor';

  function noteApiBase() {
    return notebookIdRef.current != null
      ? `/api/notebooks/${notebookIdRef.current}/content`
      : '/api/notes';
  }

  const setMode = (m) => onModeChange?.(m);

  function startRename() {
    if (!notePath || isShared) return;
    const basename = notePath.replace(/\.md$/, '').split('/').pop();
    setRenameValue(basename);
    setRenaming(true);
  }

  useEffect(() => {
    if (renaming) renameInputRef.current?.select();
  }, [renaming]);

  useEffect(() => {
    if (savingTpl) tplInputRef.current?.select();
  }, [savingTpl]);

  function startSaveTemplate() {
    const name = notePath ? notePath.replace(/\.md$/, '').split('/').pop() : '';
    setTplName(name);
    setSavingTpl(true);
  }

  async function submitSaveTemplate() {
    const name = tplName.trim();
    setSavingTpl(false);
    if (!name) return;
    const content = viewRef.current?.state.doc.toString() ?? '';
    try {
      await api.post('/api/templates', { name, content });
      setStatus('Saved as template');
      setTimeout(() => setStatus(''), 1500);
    } catch (e) {
      setStatus(`Template save failed: ${e.message}`);
    }
  }

  async function submitRename() {
    const newName = renameValue.trim();
    setRenaming(false);
    if (!newName) return;
    const dir = notePath.includes('/') ? notePath.split('/').slice(0, -1).join('/') + '/' : '';
    const newPath = dir + (newName.endsWith('.md') ? newName : `${newName}.md`);
    if (newPath === notePath) return;
    try {
      await api.patch(`/api/notes/${notePath}`, { newPath });
      onRename?.(newPath);
    } catch (e) {
      setStatus(`Rename failed: ${e.message}`);
    }
  }

  useEffect(() => { notePathRef.current = notePath; }, [notePath]);
  useEffect(() => { notebookIdRef.current = notebookId; }, [notebookId]);

  const save = useCallback(async (content) => {
    const path = notePathRef.current;
    if (!path) return;
    try {
      await api.put(`${noteApiBase()}/${path}`, { content });
      loadedRef.current = content; // remember: doc now matches the server copy
      setStatus('Saved');
      setTimeout(() => setStatus(''), 1500);
    } catch {
      setStatus('Save failed');
    }
  }, []);

  // Build CodeMirror instance once on mount
  useEffect(() => {
    const updateListener = EditorView.updateListener.of(update => {
      if (!update.docChanged) return;
      clearTimeout(saveTimer.current);
      const content = update.state.doc.toString();
      // A load (or a save) sets the doc to content we already have on the
      // server. Don't auto-save that back — it would re-write the file and
      // re-index it for no change.
      if (content === loadedRef.current) return;
      const pathSnapshot = notePathRef.current;
      saveTimer.current = setTimeout(() => {
        if (notePathRef.current === pathSnapshot) save(content);
      }, SAVE_DEBOUNCE_MS);
    });

    const state = EditorState.create({
      doc: '',
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        oneDark,
        highlightActiveLine(),
        EditorView.lineWrapping,
        wikilinkCompletion,
        updateListener,
      ],
    });

    const view = new EditorView({ state, parent: editorRef.current });
    viewRef.current = view;
    return () => {
      clearTimeout(saveTimer.current);
      view.destroy();
    };
  }, [save]);

  // Load note content whenever the selected note or notebook context changes
  useEffect(() => {
    setNoteNotebooks([]);
    setShowNbPicker(false);

    if (!notePath) return;

    const base = notebookId != null ? `/api/notebooks/${notebookId}/content` : '/api/notes';

    api.get(`${base}/${notePath}`).then(d => {
      setPreviewContent(d.content);
      loadedRef.current = d.content; // the doc about to be set is already saved
      const view = viewRef.current;
      if (view) {
        try {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: d.content },
            selection: { anchor: 0 },
          });
        } catch (_) {}
      }
    }).catch(() => {
      setStatus('Note not found');
      setTimeout(() => setStatus(''), 2000);
    });

    const title = notePath.replace(/\.md$/, '').split('/').pop();
    api.get(`/api/notes/backlinks?title=${encodeURIComponent(title)}`)
      .then(d => setBacklinks(d.backlinks))
      .catch(() => {});

    api.get(`/api/notebooks/for-note?path=${encodeURIComponent(notePath)}`)
      .then(d => setNoteNotebooks(d.notebooks))
      .catch(() => setNoteNotebooks([]));
  }, [notePath, notebookId]);

  async function addToNotebook(nbId) {
    const nb = (notebooks ?? []).find(n => n.id === nbId);
    if (!nb || !notePath) return;
    await api.put(`/api/notebooks/${nbId}/notes`, { path: notePath });
    setNoteNotebooks(prev => [...prev, nb]);
    setShowNbPicker(false);
    onNotebookChange?.();
  }

  async function removeFromNotebook(nbId) {
    if (!notePath) return;
    await api.delete(`/api/notebooks/${nbId}/notes`, { path: notePath });
    setNoteNotebooks(prev => prev.filter(n => n.id !== nbId));
    onNotebookChange?.();
  }

  function toggleMode() {
    if (mode === 'edit') {
      setPreviewContent(viewRef.current?.state.doc.toString() ?? '');
      setMode('preview');
    } else {
      setMode('edit');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        padding: '4px 16px', borderBottom: '1px solid var(--border)',
        fontSize: 12, color: 'var(--text-muted)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        {renaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
            onBlur={submitRename}
            style={{ fontSize: 12, padding: '1px 4px', minWidth: 180 }}
          />
        ) : (
          <span
            onClick={notePath && !isShared ? startRename : undefined}
            title={notePath && !isShared ? 'Click to rename' : undefined}
            style={{ cursor: notePath && !isShared ? 'text' : 'default' }}
          >
            {notePath ?? 'No note selected'}
            {isReadOnly && (
              <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontSize: 11 }}>
                (read-only)
              </span>
            )}
          </span>
        )}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span>{status}</span>
          {notePath && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {savingTpl ? (
                <input
                  ref={tplInputRef}
                  value={tplName}
                  onChange={e => setTplName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') setSavingTpl(false);
                  }}
                  onBlur={submitSaveTemplate}
                  placeholder="Template name…"
                  style={{ fontSize: 11, padding: '1px 4px', width: 140 }}
                />
              ) : (
                <button
                  className="secondary"
                  onClick={startSaveTemplate}
                  title="Save current note as a template"
                  style={{ padding: '3px 10px', fontSize: 11 }}
                >
                  Template
                </button>
              )}
              <button
                className="secondary"
                onClick={toggleMode}
                style={{ padding: '3px 10px', fontSize: 11 }}
              >
                {mode === 'edit' ? 'Preview' : 'Edit'}
              </button>
              {!isShared && (
                <button
                  className="danger"
                  onClick={async () => {
                    if (!confirm(`Delete "${notePath.replace(/\.md$/, '')}"?`)) return;
                    try {
                      await api.delete(`/api/notes/${notePath}`);
                      onDelete?.();
                    } catch (e) {
                      setStatus(`Delete failed: ${e.message}`);
                    }
                  }}
                  style={{ padding: '3px 10px', fontSize: 11 }}
                >
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {notePath && (
        <div style={{
          padding: '2px 16px 4px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', flexWrap: 'wrap',
          gap: 4, fontSize: 11,
        }}>
          <span style={{ color: 'var(--text-muted)' }}>Notebooks:</span>
          {noteNotebooks.map(nb => (
            <span key={nb.id} style={{
              display: 'inline-flex', alignItems: 'center', gap: 2,
              background: 'rgba(124,106,247,0.15)', color: 'var(--accent)',
              borderRadius: 3, padding: '1px 6px', lineHeight: 1.4,
            }}>
              {nb.name}
              {!isShared && (
                <button onClick={() => removeFromNotebook(nb.id)} style={{
                  border: 'none', background: 'none', cursor: 'pointer',
                  color: 'var(--accent)', padding: '0 1px', fontSize: 12, lineHeight: 1,
                }}>×</button>
              )}
            </span>
          ))}
          {!isShared && !showNbPicker && (notebooks ?? []).some(nb => !noteNotebooks.find(n => n.id === nb.id)) && (
            <button onClick={() => setShowNbPicker(true)} style={{
              border: 'none', background: 'none', cursor: 'pointer',
              color: 'var(--text-muted)', padding: '0 4px', fontSize: 11,
            }}>+ notebook</button>
          )}
          {!isShared && showNbPicker && (
            <select
              autoFocus
              defaultValue=""
              onChange={e => e.target.value && addToNotebook(Number(e.target.value))}
              onBlur={() => setShowNbPicker(false)}
              style={{ fontSize: 11 }}
            >
              <option value="" disabled>Select…</option>
              {(notebooks ?? [])
                .filter(nb => !noteNotebooks.find(n => n.id === nb.id))
                .map(nb => <option key={nb.id} value={nb.id}>{nb.name}</option>)
              }
            </select>
          )}
        </div>
      )}

      {mode === 'edit' && notePath && canEdit && <EditorToolbar viewRef={viewRef} />}

      {isReadOnly && notePath && (
        <div style={{
          padding: '4px 16px', background: 'rgba(124,106,247,0.08)',
          borderBottom: '1px solid var(--border)', fontSize: 11,
          color: 'var(--text-muted)',
        }}>
          You have read-only access to this notebook.
        </div>
      )}

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        {/* CodeMirror — hidden in preview mode or when read-only; kept mounted to preserve state */}
        <div
          ref={editorRef}
          style={{
            flex: 1, height: '100%', overflow: 'auto',
            display: mode === 'edit' && !isReadOnly ? 'block' : 'none',
            pointerEvents: isReadOnly ? 'none' : 'auto',
          }}
        />

        {(mode === 'preview' || isReadOnly) && (
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <NotePreview content={previewContent} onNavigate={onNavigate} />
          </div>
        )}

        {backlinks.length > 0 && (
          <BacklinksPanel backlinks={backlinks} onNavigate={onNavigate} />
        )}
      </div>
    </div>
  );
}
