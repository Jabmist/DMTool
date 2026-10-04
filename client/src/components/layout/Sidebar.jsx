import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuthStore } from '../../store/authStore.js';
import NotebookShareDialog from '../notebooks/NotebookShareDialog.jsx';
import ChangePasswordDialog from './ChangePasswordDialog.jsx';
import { APP_VERSION } from '../../version.js';

function NoteRow({ path, indent, activePath, onSelect, onViewChange, onClose, updated }) {
  const label = path.replace(/\.md$/, '').split('/').pop();
  return (
    <div
      className="note-row"
      onClick={() => { onSelect(path); onViewChange('editor'); onClose?.(); }}
      title={path}
      style={{
        paddingRight: 12,
        paddingLeft: 12 + indent,
        cursor: 'pointer',
        fontSize: 12,
        display: 'flex',
        alignItems: 'center',
        color: activePath === path ? 'var(--accent)' : 'var(--text)',
        background: activePath === path ? 'rgba(124,106,247,0.1)' : 'transparent',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {updated && <span className="nb-updated-dot" title="Updated" />}
    </div>
  );
}

export default function Sidebar({ activePath, onSelect, onViewChange, activeView, refreshKey, onModeChange, onNotebooksChange, sidebarOpen, onClose }) {
  const [allPaths, setAllPaths]         = useState([]);
  const [nbTree, setNbTree]             = useState([]);
  const [expanded, setExpanded]         = useState(new Set());
  const [search, setSearch]             = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [creating, setCreating]         = useState(false);
  const [createInNb, setCreateInNb]     = useState(null);
  const [newName, setNewName]           = useState('');
  const [templates, setTemplates]       = useState([]);
  const [selectedTpl, setSelectedTpl]   = useState('');
  const [createError, setCreateError]   = useState('');
  const newInputRef                     = useRef(null);
  const [creatingNotebook, setCreatingNotebook] = useState(false);
  const [newNotebookName, setNewNotebookName]   = useState('');
  const notebookInputRef = useRef(null);
  const [confirmDeleteNb, setConfirmDeleteNb]   = useState(null); // { id, name }
  const [shareDialogNb, setShareDialogNb]       = useState(null); // notebook object
  const [changePwOpen, setChangePwOpen]         = useState(false);
  const logout = useAuthStore(s => s.logout);
  const user   = useAuthStore(s => s.user);
  const navigate = useNavigate();

  const fetchTree = useCallback(async () => {
    const [nbRes, notesRes] = await Promise.all([
      api.get('/api/notebooks/all-with-notes').catch(() => ({ notebooks: [] })),
      api.get('/api/notes').catch(() => ({ paths: [] })),
    ]);
    setNbTree(nbRes.notebooks);
    setAllPaths(notesRes.paths);
    setExpanded(prev => {
      const next = new Set(prev);
      nbRes.notebooks.forEach(nb => { if (!prev.has(nb.id)) next.add(nb.id); });
      return next;
    });
  }, []);

  useEffect(() => { fetchTree(); }, [refreshKey, fetchTree]);

  useEffect(() => { if (creating) newInputRef.current?.focus(); }, [creating]);
  useEffect(() => { if (creatingNotebook) notebookInputRef.current?.focus(); }, [creatingNotebook]);

  function toggleExpand(id) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // Optimistically clear the "updated" dot on the opened note. The /seen POST
  // fires from VaultPage; this keeps the UI responsive without waiting for the
  // round-trip. Only the opened note's dot is cleared — the others stay.
  function clearSharedSeen(nb, name) {
    setNbTree(prev => prev.map(n => {
      if (n.id !== nb.id) return n;
      return {
        ...n,
        paths: (n.paths ?? []).map(p => (typeof p === 'object' && p.path === name) ? { ...p, updated: false } : p),
      };
    }));
  }

  async function handleSearch(e) {
    const q = e.target.value;
    setSearch(q);
    if (!q.trim()) { setSearchResults(null); return; }
    try {
      const d = await api.get(`/api/notes/search?q=${encodeURIComponent(q)}`);
      setSearchResults(d.results);
    } catch { /* ignore */ }
  }

  function startCreatingNote(nbId = null) {
    setCreating(true);
    setCreateInNb(nbId);
    setSelectedTpl('');
    api.get('/api/templates').then(d => setTemplates(d.templates)).catch(() => setTemplates([]));
  }

  function cancelCreate() {
    setCreating(false);
    setCreateInNb(null);
    setNewName('');
    setSelectedTpl('');
    setCreateError('');
  }

  async function handleCreateNote(e) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) {
      setCreateError('Note name required');
      newInputRef.current?.focus();
      return;
    }
    setCreateError('');
    const notePath = name.endsWith('.md') ? name : `${name}.md`;
    const targetNb = createInNb ? nbTree.find(n => n.id === createInNb) : null;
    const isSharedNb = targetNb && targetNb.ownerId !== user?.id;

    try {
      let content = '';
      if (selectedTpl) {
        const tpl = await api.get(`/api/templates/${selectedTpl}`);
        content = tpl.content;
      }

      if (isSharedNb) {
        // Create note in owner's vault via notebook-scoped endpoint.
        // Register the path in the notebook first so the scoped content
        // endpoint (which only serves notebook paths) accepts the write.
        await api.put(`/api/notebooks/${createInNb}/notes`, { path: notePath });
        await api.put(`/api/notebooks/${createInNb}/content/${notePath}`, { content });
        cancelCreate();
        onSelect(notePath, createInNb);
      } else {
        await api.put(`/api/notes/${notePath}`, { content });
        if (createInNb) {
          await api.put(`/api/notebooks/${createInNb}/notes`, { path: notePath });
        }
        cancelCreate();
        onSelect(notePath, null);
      }

      onViewChange('editor');
      onModeChange?.('edit');
      await fetchTree();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleCreateNotebook(e) {
    e.preventDefault();
    const name = newNotebookName.trim();
    if (!name) return;
    try {
      await api.post('/api/notebooks', { name });
      onNotebooksChange?.();
      setCreatingNotebook(false);
      setNewNotebookName('');
      await fetchTree();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleDeleteNotebook(deleteNotes) {
    if (!confirmDeleteNb) return;
    const { id } = confirmDeleteNb;
    setConfirmDeleteNb(null);
    try {
      await api.delete(`/api/notebooks/${id}${deleteNotes ? '?deleteNotes=true' : ''}`);
      onNotebooksChange?.();
      await fetchTree();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleLeaveNotebook(nb) {
    if (!user) return;
    if (!confirm(`Leave "${nb.name}"?`)) return;
    try {
      await api.delete(`/api/notebooks/${nb.id}/members/${user.id}`);
      onNotebooksChange?.();
      await fetchTree();
    } catch (err) {
      alert(err.message);
    }
  }

  // Normalize paths array (string or {path, updated} object) to plain strings.
  const pathToName = p => typeof p === 'string' ? p : p.path;
  // Notes in personal notebooks; shared notebook notes are shown under their notebook but
  // are not shown again under "Unorganized" since they're not in the personal vault listing
  const personalNotebookPaths = new Set(
    nbTree.filter(nb => nb.ownerId === user?.id).flatMap(nb => (nb.paths ?? []).map(pathToName))
  );
  const unorganized = allPaths.filter(p => !personalNotebookPaths.has(p));
  const createInNbName = createInNb ? nbTree.find(n => n.id === createInNb)?.name : null;

  return (
    <aside className={`sidebar${sidebarOpen ? ' open' : ''}`} style={{
      background: 'var(--bg-sidebar)',
      borderRight: '1px solid var(--border)', display: 'flex',
      flexDirection: 'column', height: '100%',
    }}>
      {/* Search + global new-note button */}
      <div style={{ padding: '8px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 6 }}>
        <input
          placeholder="Search notes…"
          value={search}
          onChange={handleSearch}
          style={{ fontSize: 12, flex: 1 }}
        />
        <button
          onClick={() => startCreatingNote(null)}
          title="New note"
          style={{ padding: '4px 8px', flexShrink: 0, fontSize: 16, lineHeight: 1 }}
        >
          +
        </button>
      </div>

      {/* Inline new-note form */}
      {creating && (
        <form onSubmit={handleCreateNote} style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              ref={newInputRef}
              placeholder={createInNbName ? `Note in "${createInNbName}"…` : 'Note name…'}
              value={newName}
              onChange={e => { setNewName(e.target.value); setCreateError(''); }}
              onKeyDown={e => e.key === 'Escape' && cancelCreate()}
              style={{ fontSize: 12, flex: 1, borderColor: createError ? 'var(--danger)' : undefined }}
            />
            <button type="submit" style={{ padding: '4px 8px', fontSize: 12 }}>OK</button>
          </div>
          {createError && (
            <div style={{ fontSize: 11, color: 'var(--danger)' }}>{createError}</div>
          )}
          <select
            value={selectedTpl}
            onChange={e => setSelectedTpl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreateNote(e)}
            style={{ fontSize: 11, width: '100%' }}
          >
            <option value="">Blank</option>
            {templates.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </form>
      )}

      {/* Tree / search results */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {searchResults ? (
          searchResults.map(r => (
            <NoteRow key={r.path} path={r.path} indent={0} activePath={activePath} onSelect={p => onSelect(p, null)} onViewChange={onViewChange} onClose={onClose} />
          ))
        ) : (
          <>
            {/* Notebooks */}
            {nbTree.map(nb => {
              const isOwner = nb.ownerId === user?.id;
              const isShared = !isOwner; // member viewing someone else's shared notebook (drives the "shared" label)
              // The server attaches {path, updated} objects to notebooks shared
              // with at least one other accepted member — for both a member AND
              // the owner of a shared notebook. That is what lets us open a note
              // to clear its dot (post /seen) and to be notified of the other
              // party's edits.
              const dotEligible = (nb.paths ?? []).some(p => typeof p === 'object');
              return (
                <div key={nb.id}>
                  <div style={{ display: 'flex', alignItems: 'center', padding: '3px 6px 3px 4px', userSelect: 'none' }}>
                    <span
                      onClick={() => toggleExpand(nb.id)}
                      style={{ fontSize: 9, width: 14, flexShrink: 0, color: 'var(--text-muted)', cursor: 'pointer', textAlign: 'center' }}
                    >
                      {expanded.has(nb.id) ? '▾' : '▸'}
                    </span>
                    <span
                      onClick={() => toggleExpand(nb.id)}
                      style={{
                        flex: 1, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        color: 'var(--text)', padding: '1px 4px',
                      }}
                    >
                      {nb.name}
                      {isShared && (
                        <span style={{ marginLeft: 5, fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>
                          shared
                        </span>
                      )}
                    </span>
                    {/* Share button (owner only) */}
                    {isOwner && (
                      <button
                        onClick={e => { e.stopPropagation(); setShareDialogNb(nb); }}
                        title="Share notebook"
                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 11, padding: '0 2px', lineHeight: 1 }}
                      >
                        ↗
                      </button>
                    )}
                    {/* Add note button (owner or editor) */}
                    {(isOwner || nb.role === 'editor') && (
                      <button
                        onClick={() => startCreatingNote(nb.id)}
                        title="New note in this notebook"
                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, padding: '0 2px', lineHeight: 1 }}
                      >
                        +
                      </button>
                    )}
                    {/* Delete (owner) or Leave (member) */}
                    {isOwner ? (
                      <button
                        onClick={e => { e.stopPropagation(); setConfirmDeleteNb({ id: nb.id, name: nb.name }); }}
                        title="Delete notebook"
                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 12, padding: '0 2px', lineHeight: 1 }}
                      >
                        ×
                      </button>
                    ) : (
                      <button
                        onClick={e => { e.stopPropagation(); handleLeaveNotebook(nb); }}
                        title="Leave notebook"
                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 10, padding: '0 2px', lineHeight: 1 }}
                      >
                        leave
                      </button>
                    )}
                  </div>
                  {confirmDeleteNb?.id === nb.id && (
                    <div style={{ padding: '6px 8px 6px 18px', borderBottom: '1px solid var(--border)', background: 'rgba(var(--danger-rgb,220,53,69),0.08)' }}>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                        Delete <strong style={{ color: 'var(--text)' }}>{confirmDeleteNb.name}</strong>?
                      </p>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <button onClick={() => handleDeleteNotebook(false)} style={{ fontSize: 10, padding: '2px 8px' }}>
                          Notebook only
                        </button>
                        <button className="danger" onClick={() => handleDeleteNotebook(true)} style={{ fontSize: 10, padding: '2px 8px' }}>
                          + all notes
                        </button>
                        <button className="secondary" onClick={() => setConfirmDeleteNb(null)} style={{ fontSize: 10, padding: '2px 8px' }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {expanded.has(nb.id) && (nb.paths ?? []).map(p => {
                    const name = pathToName(p);
                    return (
                      <NoteRow
                        key={name}
                        path={name}
                        indent={16}
                        activePath={activePath}
                        onSelect={path => { onSelect(path, dotEligible ? nb.id : null); if (dotEligible) clearSharedSeen(nb, path); }}
                        onViewChange={onViewChange}
                        onClose={onClose}
                        updated={typeof p === 'object' ? p.updated : false}
                      />
                    );
                  })}
                </div>
              );
            })}

            {/* New notebook */}
            {creatingNotebook ? (
              <form onSubmit={handleCreateNotebook} style={{ padding: '4px 8px', display: 'flex', gap: 4 }}>
                <input
                  ref={notebookInputRef}
                  placeholder="Notebook name…"
                  value={newNotebookName}
                  onChange={e => setNewNotebookName(e.target.value)}
                  onKeyDown={e => e.key === 'Escape' && (setCreatingNotebook(false), setNewNotebookName(''))}
                  style={{ fontSize: 11, flex: 1 }}
                />
                <button type="submit" style={{ padding: '2px 6px', fontSize: 11 }}>OK</button>
              </form>
            ) : (
              <div style={{ padding: '3px 4px 3px 18px' }}>
                <button
                  onClick={() => setCreatingNotebook(true)}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 11, padding: 0 }}
                >
                  + New notebook
                </button>
              </div>
            )}

            {/* Unorganized notes */}
            {unorganized.length > 0 && (
              <>
                <div style={{
                  padding: '6px 4px 2px 18px',
                  fontSize: 10, color: 'var(--text-muted)',
                  fontVariant: 'small-caps', letterSpacing: '0.05em',
                  userSelect: 'none',
                }}>
                  Unorganized
                </div>
                {unorganized.map(p => (
                  <NoteRow key={p} path={p} indent={16} activePath={activePath} onSelect={p => onSelect(p, null)} onViewChange={onViewChange} onClose={onClose} />
                ))}
              </>
            )}
          </>
        )}
      </nav>

      {/* View navigation */}
      <div className="sidebar-nav" style={{ borderTop: '1px solid var(--border)', padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {[
          ['editor', 'Editor'],
          ['graph', 'Graph'],
          ['dissect', 'AI Dissect'],
          ['import', 'Import'],
          ['templates', 'Templates'],
          ...(user?.role === 'admin' ? [['admin', 'Admin']] : []),
        ].map(([key, label]) => (
          <button
            key={key}
            className="secondary"
            onClick={() => { onViewChange(key); onClose?.(); }}
            style={{ textAlign: 'left', opacity: activeView === key ? 1 : 0.7 }}
          >
            {label}
          </button>
        ))}
        <button
          className="secondary"
          onClick={() => navigate('/help')}
          style={{ textAlign: 'left' }}
        >
          Help
        </button>
        <button className="secondary" onClick={() => setChangePwOpen(true)} style={{ textAlign: 'left' }}>
          Change password
        </button>
        <button className="secondary" onClick={logout} style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>
          Sign out
        </button>
        <button
          onClick={() => { navigate('/version'); onClose?.(); }}
          title="See what's new"
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', fontSize: 11, textAlign: 'left', padding: '2px 0',
          }}
        >
          v{APP_VERSION}
        </button>
      </div>

      {shareDialogNb && (
        <NotebookShareDialog
          notebook={shareDialogNb}
          onClose={() => setShareDialogNb(null)}
          onChanged={() => { onNotebooksChange?.(); fetchTree(); }}
        />
      )}

      {changePwOpen && (
        <ChangePasswordDialog onClose={() => setChangePwOpen(false)} onSuccess={() => setChangePwOpen(false)} />
      )}
    </aside>
  );
}
