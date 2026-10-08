import React, { useState, useCallback, useEffect, useRef } from 'react';
import Sidebar from '../components/layout/Sidebar.jsx';
import Editor from '../components/editor/Editor.jsx';
import GraphView from '../components/graph/GraphView.jsx';
import DissectPanel from '../components/dissect/DissectPanel.jsx';
import ImportPanel from '../components/import/ImportPanel.jsx';
import AdminPanel from '../components/admin/AdminPanel.jsx';
import TemplatesView from '../components/templates/TemplatesView.jsx';
import PendingInvitesBanner from '../components/notebooks/PendingInvitesBanner.jsx';
import AnnouncementDialog from '../components/layout/AnnouncementDialog.jsx';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { useMobile } from '../hooks/useMobile.js';
import { api } from '../api/client.js';
import Header from '../components/layout/Header.jsx';
import BottomNav from '../components/layout/BottomNav.jsx';

export default function VaultPage() {
  const isMobile = useMobile();
  const [activePath, setActivePath] = useState(null);
  const [activeNotebookId, setActiveNotebookId] = useState(null);
  const [view, setView] = useState('editor');
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile);

  useEffect(() => { setSidebarOpen(!isMobile); }, [isMobile]);
  const [editorMode, setEditorMode] = useState('edit');
  const [wsEvents, setWsEvents] = useState([]);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);
  const [notebooks, setNotebooks] = useState([]);
  const [notebooksKey, setNotebooksKey] = useState(0);
  const [dissectJob, setDissectJob] = useState(null);
  const [notebookColorKey, setNotebookColorKey] = useState(0);
  // Issue #16: active admin announcement fetched on mount (covers login
  // navigation and app load). Shown once per session until acknowledged.
  const [announcement, setAnnouncement] = useState(null);
  // dissectJob: null | { jobId, status: 'processing'|'preview'|'failed'|'complete', notes, error, startedAt }

  const handleWsMessage = useCallback((msg) => {
    setWsEvents(prev => [...prev.slice(-50), msg]);
  }, []);

  useWebSocket(handleWsMessage);

  useEffect(() => {
    api.get('/api/notebooks').then(d => setNotebooks(d.notebooks)).catch(() => {});
  }, [notebooksKey]);

  // Issue #16: load the active announcement once on mount. A failure (e.g.
  // 401 while token is rotating) must not break the page — the announcement
  // is non-critical.
  useEffect(() => {
    api.get('/api/auth/active-announcement')
      .then(d => setAnnouncement(d.announcement ?? null))
      .catch(() => {});
  }, []);

  // Refresh sidebar when a shared notebook note is updated by another member
  useEffect(() => {
    const last = wsEvents[wsEvents.length - 1];
    if (!last) return;
    if (last.type === 'note:updated' || last.type === 'note:deleted') {
      setSidebarRefreshKey(k => k + 1);
    }
  }, [wsEvents]);

  // Update dissect job from WebSocket events
  useEffect(() => {
    if (!dissectJob?.jobId) return;
    const last = [...wsEvents].reverse().find(e => e.jobId === dissectJob.jobId);
    if (!last) return;
    setDissectJob(j => {
      if (!j) return j;
      if (last.type === 'job:processing' && last.timeoutMs) return { ...j, status: 'processing', timeoutMs: last.timeoutMs };
      if (last.type === 'job:processing' && j.status !== 'processing') return { ...j, status: 'processing' };
      if (last.type === 'job:preview'    && j.status !== 'preview')    return { ...j, status: 'preview', notes: last.notes };
      if (last.type === 'job:failed'     && j.status !== 'failed')     return { ...j, status: 'failed', error: last.error };
      if (last.type === 'job:cancelled'  && j.status !== 'cancelled')  return { ...j, status: 'cancelled', error: last.error ?? 'Cancelled' };
      if (last.type === 'job:waiting_continue' && j.status !== 'waiting_continue' && j.status !== 'processing') return { ...j, status: 'waiting_continue' };
      if (last.type === 'job:complete'   && j.status !== 'complete')   return { ...j, status: 'complete' };
      return j;
    });
  }, [wsEvents, dissectJob?.jobId]);

  // Polling fallback — kicks in when WS isn't delivering events (e.g. after server restart)
  useEffect(() => {
    if (!['processing', 'waiting_continue'].includes(dissectJob?.status)) return;
    const id = setInterval(async () => {
      try {
        const job = await api.get(`/api/dissect/${dissectJob.jobId}`);
        setDissectJob(j => {
          if (!j || j.status !== 'processing') return j;
          if (job.status === 'preview') return { ...j, status: 'preview', notes: job.result ?? [] };
          if (job.status === 'failed')  return { ...j, status: 'failed',  error: job.error ?? 'Unknown error' };
          if (job.status === 'cancelled') return { ...j, status: 'cancelled', error: job.error ?? 'Cancelled' };
          if (job.status === 'waiting_continue') return { ...j, status: 'waiting_continue' };
          return j;
        });
      } catch { /* ignore transient poll errors */ }
    }, 3_000);
    return () => clearInterval(id);
  }, [dissectJob?.jobId, dissectJob?.status]);

  // Refresh sidebar when dissect notes land in the vault
  useEffect(() => {
    if (dissectJob?.status === 'complete') setSidebarRefreshKey(k => k + 1);
  }, [dissectJob?.status]);

  // Elapsed-time ticker so the toast stays current while processing
  const [, setTick] = useState(0);
  useEffect(() => {
    if (dissectJob?.status !== 'processing') return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [dissectJob?.status]);

  function refreshNotebooks() { setNotebooksKey(k => k + 1); }

  function handleNoteDeleted() {
    setActivePath(null);
    setActiveNotebookId(null);
    setSidebarRefreshKey(k => k + 1);
  }

  function handleNoteRenamed(newPath) {
    setActivePath(newPath);
    setSidebarRefreshKey(k => k + 1);
  }

  function handleSelectNote(path, notebookId) {
    if (notebookId) {
      api.post(`/api/notebooks/${notebookId}/seen`, { notePaths: [path] }).catch(() => {});
    }
    setActivePath(path);
    setActiveNotebookId(notebookId ?? null);
  }

  const toastVisible = dissectJob
    && view !== 'dissect'
    && dissectJob.status !== 'complete';

  const elapsed = dissectJob?.startedAt
    ? Math.floor((Date.now() - dissectJob.startedAt) / 1000)
    : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PendingInvitesBanner
        onAccepted={() => { refreshNotebooks(); setSidebarRefreshKey(k => k + 1); }}
      />

      {announcement && (
        <AnnouncementDialog message={announcement.message} onAck={() => setAnnouncement(null)} />
      )}

      {isMobile && (
        <Header
          sidebarOpen={sidebarOpen}
          onToggle={() => setSidebarOpen(o => !o)}
          activeNotePath={activePath}
        />
      )}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar
          activePath={activePath}
          onSelect={handleSelectNote}
          onViewChange={setView}
          activeView={view}
          refreshKey={sidebarRefreshKey}
          onModeChange={setEditorMode}
          onNotebooksChange={refreshNotebooks}
          sidebarOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />
        <main className="main-content" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {view === 'editor'    && <Editor notePath={activePath} notebookId={activeNotebookId} onNavigate={path => handleSelectNote(path, null)} onDelete={handleNoteDeleted} onRename={handleNoteRenamed} mode={editorMode} onModeChange={setEditorMode} notebooks={notebooks} onNotebookChange={() => { setSidebarRefreshKey(k => k + 1); setNotebookColorKey(k => k + 1); }} onEntityCreated={() => { setSidebarRefreshKey(k => k + 1); setNotebooksKey(k => k + 1); }} />}
          {view === 'graph'     && <GraphView activePath={activePath} notebookColorKey={notebookColorKey} onSelectNote={(p, nbId) => { handleSelectNote(p, nbId ?? null); setEditorMode('preview'); setView('editor'); }} isMobile={isMobile} />}
          {view === 'dissect'   && <DissectPanel dissectJob={dissectJob} onDissectJobChange={setDissectJob} onComplete={() => setView('editor')} />}
          {view === 'import'    && <ImportPanel onComplete={() => setView('editor')} />}
          {view === 'admin'     && <AdminPanel />}
          {view === 'templates' && <TemplatesView />}
        </main>
      </div>

      {isMobile && <BottomNav activeView={view} onViewChange={setView} />}

      {isMobile && sidebarOpen && (
        <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}

      {toastVisible && (
        <div
          onClick={() => setView('dissect')}
          style={{
            position: 'fixed', bottom: isMobile ? 76 : 20, right: 20, zIndex: 1000,
            background: 'var(--bg-panel)', border: '1px solid var(--border)',
            borderRadius: 8, padding: '10px 16px', cursor: 'pointer',
            fontSize: 13, boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 260,
          }}
        >
          {dissectJob.status === 'processing' && (
            <>
              <span style={{ fontWeight: 600 }}>AI Dissection in progress</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                {elapsed}s elapsed — click to view
              </span>
            </>
          )}
          {dissectJob.status === 'preview' && (
            <>
              <span style={{ fontWeight: 600, color: 'var(--accent)' }}>Notes ready to review</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                {dissectJob.notes.length} note{dissectJob.notes.length !== 1 ? 's' : ''} — click to approve
              </span>
            </>
          )}
          {dissectJob.status === 'failed' && (
            <>
              <span style={{ fontWeight: 600, color: 'var(--danger)' }}>Dissection failed</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Click to view error</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
