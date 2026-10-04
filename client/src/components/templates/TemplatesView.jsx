import React, { useState, useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { api } from '../../api/client.js';
import EditorToolbar from '../editor/EditorToolbar.jsx';
import NotePreview from '../editor/NotePreview.jsx';

export default function TemplatesView() {
  const [templates, setTemplates] = useState([]);
  const [editing, setEditing] = useState(null); // { id, name }
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [previewContent, setPreviewContent] = useState('');
  const editorRef = useRef(null);
  const viewRef = useRef(null);
  const nameRef = useRef(null);

  async function load() {
    try {
      const d = await api.get('/api/templates');
      setTemplates(d.templates);
    } catch {}
  }

  useEffect(() => { load(); }, []);

  // Create CM instance once; it lives for the component's lifetime
  useEffect(() => {
    const state = EditorState.create({
      doc: '',
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        oneDark,
        highlightActiveLine(),
        EditorView.lineWrapping,
      ],
    });
    const view = new EditorView({ state, parent: editorRef.current });
    viewRef.current = view;
    return () => { view.destroy(); };
  }, []);

  // Load template content into CM when editing changes
  useEffect(() => {
    if (!editing) return;
    setEditName(editing.name);
    if (viewRef.current) {
      viewRef.current.dispatch({
        changes: { from: 0, to: viewRef.current.state.doc.length, insert: editing.content },
        selection: { anchor: 0 },
      });
      viewRef.current.focus();
    }
    nameRef.current?.focus();
  }, [editing?.id]);

  async function startEdit(tpl) {
    try {
      const d = await api.get(`/api/templates/${tpl.id}`);
      setEditing({ id: tpl.id, name: d.name, content: d.content });
    } catch (err) {
      alert(err.message);
    }
  }

  function cancelEdit() {
    setEditing(null);
    setPreviewMode(false);
  }

  function togglePreview() {
    if (!previewMode) {
      setPreviewContent(viewRef.current?.state.doc.toString() ?? '');
    }
    setPreviewMode(p => !p);
  }

  async function handleSave() {
    if (!editName.trim()) return;
    setSaving(true);
    try {
      const content = viewRef.current?.state.doc.toString() ?? '';
      await api.put(`/api/templates/${editing.id}`, { name: editName.trim(), content });
      setEditing(null);
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this template?')) return;
    try {
      await api.delete(`/api/templates/${id}`);
      if (editing?.id === id) setEditing(null);
      await load();
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', color: 'var(--text)', fontFamily: 'var(--font-sans)' }}>

      {/* Header bar */}
      <div style={{
        padding: '6px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
      }}>
        {editing ? (
          <>
            <input
              ref={nameRef}
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') cancelEdit(); }}
              placeholder="Template name"
              style={{ fontSize: 13, fontWeight: 600, flex: 1, maxWidth: 360 }}
            />
            <button onClick={handleSave} disabled={saving} style={{ fontSize: 12, padding: '3px 10px' }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="secondary" onClick={togglePreview} style={{ fontSize: 12, padding: '3px 10px' }}>
              {previewMode ? 'Edit' : 'Preview'}
            </button>
            <button className="secondary" onClick={cancelEdit} style={{ fontSize: 12, padding: '3px 10px' }}>
              Cancel
            </button>
          </>
        ) : (
          <span style={{ fontSize: 14, fontWeight: 600, color: '#e0e0e0' }}>Templates</span>
        )}
      </div>

      {/* Format toolbar — only visible while editing in edit mode */}
      {editing && !previewMode && <EditorToolbar viewRef={viewRef} />}

      {/* Template list — hidden while editing */}
      {!editing && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          {templates.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              No templates saved yet. Open a note in the editor and use the Template button to save one.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 680 }}>
              {templates.map(tpl => (
                <div key={tpl.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  border: '1px solid var(--border)', borderRadius: 6,
                  padding: '8px 12px',
                }}>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{tpl.name}</span>
                  <button
                    className="secondary"
                    onClick={() => startEdit(tpl)}
                    style={{ fontSize: 11, padding: '2px 8px' }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(tpl.id)}
                    style={{
                      fontSize: 11, padding: '2px 8px', cursor: 'pointer',
                      color: 'var(--danger)', border: '1px solid var(--danger)',
                      background: 'none', borderRadius: 4,
                    }}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* CodeMirror — always mounted, hidden in preview mode or when not editing */}
      <div
        ref={editorRef}
        style={{ flex: 1, overflow: 'auto', display: editing && !previewMode ? 'block' : 'none' }}
      />

      {/* Preview panel */}
      {editing && previewMode && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <NotePreview content={previewContent} onNavigate={() => {}} />
        </div>
      )}
    </div>
  );
}
