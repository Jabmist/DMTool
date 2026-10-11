import React, { useEffect, useRef, useState, useCallback } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { autocompletion } from '@codemirror/autocomplete';
import { api } from '../../api/client.js';
import BacklinksPanel from './BacklinksPanel.jsx';
import { wikilinkSource } from './wikilinkComplete.js';
import { entitySource } from './symbolLinkComplete.js';
import { setNewEntityHandler, clearNewEntityHandler } from './entityLinkBridge.js';
import { ENTITY_TYPES } from './symbolPalette.js';
import NotePreview from './NotePreview.jsx';
import EditorToolbar from './EditorToolbar.jsx';
import EntityDraftPanel from './EntityDraftPanel.jsx';

const SAVE_DEBOUNCE_MS = 1000;

// One autocompletion config owning both link sources. CodeMirror cannot merge
// two autocompletion() extensions (each sets the `override` config field →
// "Config merge conflict for field override"), so the [[wikilink]] and
// [entity-symbol] pickers share a single instance.
const entityLinkCompletion = autocompletion({
  override: [wikilinkSource, entitySource],
  closeOnBlur: true,
  activateOnTyping: true,
});

export default function Editor({ notePath, notebookId, onNavigate, onDelete, onRename, mode = 'edit', onModeChange, notebooks, onNotebookChange, onEntityCreated, draftJob, onDraftJobChange, onAiComplete, loadKey = 0 }) {
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
  const [entitySymbol, setEntitySymbol] = useState(null);
  const [noteNotebooks, setNoteNotebooks] = useState([]);
  const [showNbPicker, setShowNbPicker] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef(null);
  const [savingTpl, setSavingTpl] = useState(false);
  const [tplName, setTplName] = useState('');
  const tplInputRef = useRef(null);
  // Phase 3: AI Assist panel shown when the user clicks the toolbar button.
  const [aiOpen, setAiOpen] = useState(false);
  // Entity "New…" prompt (Phase 2): shown when the picker's New… row is chosen.
  const [entityPrompt, setEntityPrompt] = useState(null); // { type, name, error }
  const entityInputRef = useRef(null);

  // Derive role for the active shared notebook
  const activeNotebook = notebookId ? (notebooks ?? []).find(n => n.id === notebookId) : null;
  const sharedRole = activeNotebook?.role ?? null; // 'owner'|'editor'|'viewer'|null
  const isShared = notebookId != null;
  const isReadOnly = sharedRole === 'viewer';
  const canEdit = !isShared || sharedRole === 'owner' || sharedRole === 'editor';

  // AI Assist (Phase 3): available only when the note is an entity.
  const entity = entitySymbol ? ENTITY_TYPES.find(t => t.symbol === entitySymbol) : null;
  const entityTypeLabel = entity?.label ?? null;
  const aiLabel = entity ? { symbol: entity.symbol, label: entity.label } : null;
  const entityDisplayName = notePath ? notePath.replace(/\.md$/, '').split('/').pop() : '';

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

  useEffect(() => {
    if (entityPrompt) entityInputRef.current?.focus();
  }, [entityPrompt]);

  // Register the bridge handler so the CodeMirror picker's **New…** row can ask
  // this component to show the name prompt for a given type. Unregister on unmount.
  // The picker's `from` is the absolute position right after the opening pair;
  // we also record the cursor head at selection time so we can replace the
  // entire range [from, head] when we insert the final link — including any
  // partially-typed name the user started before picking New…
  const openEntityPrompt = useCallback((type, from) => {
    const head = viewRef.current ? viewRef.current.state.selection.main.head : from;
    setEntityPrompt({ type, from, head, name: '', error: '' });
  }, []);
  useEffect(() => {
    setNewEntityHandler(openEntityPrompt);
    return () => clearNewEntityHandler(openEntityPrompt);
  }, [openEntityPrompt]);

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

  // Phase 2 entity creation via the picker's **New…** row. Create through the
  // POST /api/entity-types/:symbol endpoint (which auto-files the note into the
  // type's seed notebook and applies its template), then insert the full link
  // at the cursor: `&sym Name &sym`.  On success, refresh the sidebar tree so
  // the new note appears immediately.
  async function submitEntityPrompt() {
    const prompt = entityPrompt;
    setEntityPrompt(null);
    if (!prompt) return;
    const name = prompt.name.trim();
    if (!name) return;
    try {
      const d = await api.post(`/api/entity-types/${encodeURIComponent(prompt.type.symbol)}`, { name });
      const created = d.name ?? name;
      const view = viewRef.current;
      if (view) {
        const from = prompt.from ?? (view.state.selection.main.head - prompt.type.pair.length);
        const to = prompt.head ?? view.state.selection.main.head;
        const insert = `${created}${prompt.type.pair}`;
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
        });
      }
      setStatus(`Created ${prompt.type.label} “${created}”`);
      setTimeout(() => setStatus(''), 2500);
      onEntityCreated?.();
    } catch (e) {
      setEntityPrompt({ ...prompt, error: e.message });
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

  // The AI-Assist panel and its job are relative to the currently-open note.
  // Navigating to a different note closes any open panel (a draft keeps
  // running for the note it was started on, surfaced via the toast).
  useEffect(() => { setAiOpen(false); }, [notePath, notebookId]);

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
        entityLinkCompletion,
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
    setEntitySymbol(null);

    if (!notePath) return;

    const base = notebookId != null ? `/api/notebooks/${notebookId}/content` : '/api/notes';

    api.get(`${base}/${notePath}`).then(d => {
      setPreviewContent(d.content);
      setEntitySymbol(d.entity_symbol ?? null);
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
  }, [notePath, notebookId, loadKey]);

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
      {entityPrompt && (
        <div style={{
          padding: '8px 16px', borderBottom: '1px solid var(--border)',
          background: 'rgba(124,106,247,0.08)',
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            New <strong style={{ color: 'var(--accent)' }}>{entityPrompt.type.label}</strong>
            <span style={{ marginLeft: 6, fontFamily: 'var(--font-mono)' }}>{entityPrompt.type.pair}Name{entityPrompt.type.pair}</span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              ref={entityInputRef}
              value={entityPrompt.name}
              placeholder={`${entityPrompt.type.label} name…`}
              onChange={e => setEntityPrompt(p => p && { ...p, name: e.target.value, error: '' })}
              onKeyDown={e => {
                if (e.key === 'Enter') submitEntityPrompt();
                if (e.key === 'Escape') setEntityPrompt(null);
              }}
              style={{ fontSize: 12, flex: 1 }}
            />
            <button onClick={submitEntityPrompt} style={{ padding: '4px 10px', fontSize: 12 }}>Create</button>
            <button className="secondary" onClick={() => setEntityPrompt(null)} style={{ padding: '4px 10px', fontSize: 12 }}>Cancel</button>
          </div>
          {entityPrompt.error && (
            <div style={{ fontSize: 11, color: 'var(--danger)' }}>{entityPrompt.error}</div>
          )}
        </div>
      )}
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

      {mode === 'edit' && notePath && canEdit && (
        <EditorToolbar
          viewRef={viewRef}
          ai={aiLabel ? { label: aiLabel, name: entityDisplayName, onAssist: () => setAiOpen(true) } : null}
        />
      )}

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
        {/* CodeMirror — ALWAYS mounted so the editor view survives the AI panel
            being open/closed (it's created once on mount); just hidden when the
            panel, preview mode, or read-only are active. */}
        <div
          ref={editorRef}
          style={{
            flex: 1, height: '100%', overflow: 'auto',
            display: mode === 'edit' && !isReadOnly && !aiOpen ? 'block' : 'none',
            pointerEvents: isReadOnly ? 'none' : 'auto',
          }}
        />

        {(mode === 'preview' || isReadOnly) && !aiOpen && (
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <NotePreview content={previewContent} onNavigate={onNavigate} />
          </div>
        )}

        {backlinks.length > 0 && !aiOpen && (
          <BacklinksPanel backlinks={backlinks} onNavigate={onNavigate} />
        )}

        {aiOpen && (
          <EntityDraftPanel
            label={aiLabel}
            name={entityDisplayName}
            draftJob={draftJob}
            onDraftJobChange={onDraftJobChange}
            onComplete={() => { setAiOpen(false); onAiComplete?.(); }}
          />
        )}
      </div>
    </div>
  );
}
