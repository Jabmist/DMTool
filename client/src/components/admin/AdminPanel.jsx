import React, { useEffect, useState, useCallback } from 'react';
import { api, downloadFile } from '../../api/client.js';
import { useAuthStore } from '../../store/authStore.js';

// datetime-local <-> unix epoch seconds (the announcements API stores epoch s)
function toLocalInput(sec) {
  if (sec == null) return '';
  const d = new Date(sec * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(str) {
  if (!str) return NaN;
  const ms = new Date(str).getTime();
  return Number.isNaN(ms) ? NaN : Math.floor(ms / 1000);
}

// Human-readable byte sizes for backup files.
function humanBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i += 1; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}

function fmtEpoch(sec) {
  return sec != null ? new Date(sec * 1000).toLocaleString() : '—';
}

export default function AdminPanel() {
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');
  const currentUser = useAuthStore(s => s.user);

  // Issue #16 — admin announcement (single active slot)
  const [announcement, setAnnouncement] = useState(null);
  const [msg, setMsg] = useState('');
  const [startStr, setStartStr] = useState('');
  const [endStr, setEndStr] = useState('');
  const [savingAnn, setSavingAnn] = useState(false);
  const [annError, setAnnError] = useState('');
  const [annSaved, setAnnSaved] = useState(false);

  // Issue #19 — admin system backups (create / download / restore)
  const [backups, setBackups] = useState([]);
  const [backError, setBackError] = useState('');
  const [backBusy, setBackBusy] = useState(false);   // a create is in flight
  const [restoring, setRestoring] = useState(false); // a restore was triggered
  const [restartNote, setRestartNote] = useState('');

  const fetchUsers = useCallback(async () => {
    try {
      const d = await api.get('/api/admin/users');
      setUsers(d.users);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const fetchAnnouncement = useCallback(async () => {
    try {
      const d = await api.get('/api/admin/announcements');
      setAnnouncement(d.announcement ?? null);
      if (d.announcement) {
        setMsg(d.announcement.message);
        setStartStr(toLocalInput(d.announcement.start_time));
        setEndStr(toLocalInput(d.announcement.end_time));
      }
    } catch (e) {
      setAnnError(e.message);
    }
  }, []);

  useEffect(() => { fetchAnnouncement(); }, [fetchAnnouncement]);

  const fetchBackups = useCallback(async () => {
    const d = await api.get('/api/admin/backups');
    const list = d.backups ?? [];
    setBackups(list);
    return list;
  }, []);

  useEffect(() => { fetchBackups().catch(e => setBackError(e.message)); }, [fetchBackups]);

  // While a backup is still running (server-side tar of the whole vault can
  // take a while), poll until it settles to complete/failed.
  const anyRunning = backups.some(b => b.status === 'running');
  useEffect(() => {
    if (!anyRunning) return undefined;
    const t = setInterval(() => { fetchBackups().catch(() => {}); }, 2000);
    return () => clearInterval(t);
  }, [anyRunning, fetchBackups]);

  async function publishAnn() {
    setAnnError(''); setAnnSaved(false);
    if (!msg.trim()) { setAnnError('Enter a message to announce.'); return; }
    const start = fromLocalInput(startStr);
    const end = fromLocalInput(endStr);
    if (Number.isNaN(start) || Number.isNaN(end)) { setAnnError('Set a start and end time.'); return; }
    if (end <= start) { setAnnError('End time must be after start time.'); return; }
    setSavingAnn(true);
    try {
      const d = await api.post('/api/admin/announcements', { message: msg, start_time: start, end_time: end });
      setAnnouncement(d.announcement);
      setAnnSaved(true);
    } catch (e) {
      setAnnError(e.message);
    } finally {
      setSavingAnn(false);
    }
  }

  async function endAnn() {
    setAnnError(''); setAnnSaved(false);
    if (!confirm('End the current announcement now?')) return;
    try {
      await api.delete('/api/admin/announcements');
      await fetchAnnouncement();
    } catch (e) {
      setAnnError(e.message);
    }
  }

  async function approve(id) {
    try {
      await api.post(`/api/admin/users/${id}/approve`, {});
      await fetchUsers();
    } catch (e) {
      setError(e.message);
    }
  }

  async function remove(id, email) {
    if (!confirm(`Remove user "${email}"? This permanently deletes their account and vault.`)) return;
    try {
      await api.delete(`/api/admin/users/${id}`);
      await fetchUsers();
    } catch (e) {
      setError(e.message);
    }
  }

  async function toggleRole(id, currentRole) {
    const newRole = currentRole === 'admin' ? 'user' : 'admin';
    try {
      await api.patch(`/api/admin/users/${id}/role`, { role: newRole });
      await fetchUsers();
    } catch (e) {
      setError(e.message);
    }
  }

  async function createBackup() {
    setBackError(''); setBackBusy(true);
    try {
      // Server-side tar of the whole vault + db snapshot — may take a while.
      await api.post('/api/admin/backups', {});
      // Poll until the new backup settles out of 'running' (bounded to 10 min).
      const deadline = Date.now() + 10 * 60 * 1000;
      for (;;) {
        const list = await fetchBackups();
        if (!list.some(b => b.status === 'running')) break;
        if (Date.now() >= deadline) break;
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e) {
      setBackError(e.message);
    } finally {
      setBackBusy(false);
    }
  }

  async function downloadBackup(id) {
    setBackError('');
    try {
      await downloadFile(`/api/admin/backups/${id}/download`, `obsidian-${id}.tar.gz`);
    } catch (e) {
      setBackError(e.message);
    }
  }

  async function restoreBackup(id) {
    setBackError(''); setRestartNote('');
    // Destructive: type-to-confirm gate (per the plan).
    const typed = prompt(
      'RESTORE this backup? This wipes ALL users\' notes and the database ' +
      'and replaces them with the backup.\n\nType the word RESTORE to continue.',
      '',
    );
    if (typed === null) return; // cancel
    if (typed.trim() !== 'RESTORE') { setBackError('Not confirmed — nothing was restored.'); return; }
    setRestoring(true);
    try {
      await api.post(`/api/admin/backups/${id}/restore`, {});
      // The server replies, then restarts itself (systemd respawns ~2s later).
      setRestartNote('Restore complete. The server is restarting — you will be re-connected shortly.');
      await fetchBackups();
    } catch (e) {
      setBackError(e.message);
    } finally {
      setRestoring(false);
    }
  }

  const pending = users.filter(u => u.status === 'pending');
  const active  = users.filter(u => u.status === 'active');

  const statusBadge = (status) => {
    const colors = { pending: '#f0a500', active: '#3cb371', suspended: '#cc3333' };
    return (
      <span style={{
        fontSize: 10, padding: '1px 6px', borderRadius: 3,
        background: colors[status] + '22', color: colors[status],
        fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
      }}>
        {status}
      </span>
    );
  };

  return (
    <div style={{ padding: '24px 32px', overflowY: 'auto', height: '100%', color: 'var(--text)' }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Admin</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 24 }}>
        Publish a timed announcement, and approve or remove accounts.
      </p>

      {error && (
        <p style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 16 }}>{error}</p>
      )}

      <section style={{ marginBottom: 32, padding: 16, border: '1px solid var(--border)', borderRadius: 8 }}>
        <h2 style={{ fontSize: 14, marginBottom: 4, color: 'var(--accent)' }}>Announcement</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12 }}>
          Shown to every user (blocking modal they must OK) while the current time is inside
          the window below. Publishing replaces any current announcement.
        </p>

        {announcement && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 12px', marginBottom: 12,
            background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
          }}>
            <span style={{ fontSize: 11, color: '#3cb371', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Active
            </span>
            <span style={{ fontSize: 12, color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {announcement.message}
            </span>
            <button className="danger" onClick={endAnn} style={{ padding: '2px 10px', fontSize: 12 }}>
              End now
            </button>
          </div>
        )}

        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 10 }}>
          Message
          <div style={{ marginTop: 4 }}>
            <textarea
              value={msg}
              onChange={e => { setMsg(e.target.value); setAnnError(''); setAnnSaved(false); }}
              rows={3}
              placeholder="e.g. Planned maintenance tonight 22:00–23:00. The site will be read-only."
              style={{ width: '100%', fontSize: 13, fontFamily: 'inherit', lineHeight: 1.5 }}
            />
          </div>
        </label>

        <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: 10, alignItems: 'end', marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Starts
            <input
              type="datetime-local"
              value={startStr}
              onChange={e => { setStartStr(e.target.value); setAnnError(''); setAnnSaved(false); }}
              style={{ marginTop: 4, width: 'auto' }}
            />
          </label>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Ends
            <input
              type="datetime-local"
              value={endStr}
              onChange={e => { setEndStr(e.target.value); setAnnError(''); setAnnSaved(false); }}
              style={{ marginTop: 4, width: 'auto' }}
            />
          </label>
        </div>

        {annError && <p style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 8 }}>{annError}</p>}
        {annSaved && !annError && (
          <p style={{ color: '#3cb371', fontSize: 12, marginBottom: 8 }}>
            {announcement ? 'Announcement updated.' : 'Announcement set.'}
          </p>
        )}

        <button onClick={publishAnn} style={{ fontSize: 12 }} disabled={savingAnn}>
          {savingAnn ? 'Saving…' : announcement ? 'Replace announcement' : 'Publish announcement'}
        </button>
      </section>

      {pending.length > 0 && (
        <section style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 14, marginBottom: 10, color: '#f0a500' }}>
            Pending approval ({pending.length})
          </h2>
          <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                <th style={{ padding: '6px 12px 6px 0', color: 'var(--text-muted)', fontWeight: 500 }}>Email</th>
                <th style={{ padding: '6px 12px', color: 'var(--text-muted)', fontWeight: 500 }}>Registered</th>
                <th style={{ padding: '6px 0 6px 12px', color: 'var(--text-muted)', fontWeight: 500 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {pending.map(u => (
                <tr key={u.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px 8px 0' }}>{u.email}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>
                    {new Date(u.created_at * 1000).toLocaleDateString()}
                  </td>
                  <td style={{ padding: '8px 0 8px 12px', display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => approve(u.id)}
                      style={{ padding: '3px 10px', fontSize: 12, background: 'var(--accent)', border: 'none', color: '#fff', borderRadius: 3, cursor: 'pointer' }}
                    >
                      Approve
                    </button>
                    <button
                      className="danger"
                      onClick={() => remove(u.id, u.email)}
                      style={{ padding: '3px 10px', fontSize: 12 }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </section>
      )}

      {pending.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 24 }}>
          No pending registrations.
        </p>
      )}

      <section>
        <h2 style={{ fontSize: 14, marginBottom: 10 }}>All users ({users.length})</h2>
        <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
              <th style={{ padding: '6px 12px 6px 0', color: 'var(--text-muted)', fontWeight: 500 }}>Email</th>
              <th style={{ padding: '6px 12px', color: 'var(--text-muted)', fontWeight: 500 }}>Role</th>
              <th style={{ padding: '6px 12px', color: 'var(--text-muted)', fontWeight: 500 }}>Status</th>
              <th style={{ padding: '6px 12px', color: 'var(--text-muted)', fontWeight: 500 }}>Last sign in</th>
              <th style={{ padding: '6px 12px', color: 'var(--text-muted)', fontWeight: 500 }}>Notebooks</th>
              <th style={{ padding: '6px 12px', color: 'var(--text-muted)', fontWeight: 500 }}>Notes</th>
              <th style={{ padding: '6px 12px', color: 'var(--text-muted)', fontWeight: 500 }}>Shared notes</th>
              <th style={{ padding: '6px 0 6px 12px', color: 'var(--text-muted)', fontWeight: 500 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '8px 12px 8px 0' }}>
                  {u.email}
                  {u.id === currentUser?.id && (
                    <span style={{ fontSize: 10, marginLeft: 6, color: 'var(--text-muted)' }}>(you)</span>
                  )}
                </td>
                <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>{u.role}</td>
                <td style={{ padding: '8px 12px' }}>{statusBadge(u.status)}</td>
                <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>
                  {u.last_seen_at != null ? new Date(u.last_seen_at * 1000).toLocaleDateString() : '—'}
                </td>
                <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>{u.notebooks}</td>
                <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>{u.notes}</td>
                <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>{u.shared_notes}</td>
                <td style={{ padding: '8px 0 8px 12px', display: 'flex', gap: 6 }}>
                  {u.id !== currentUser?.id && (
                    <>
                      <button
                        className="secondary"
                        onClick={() => toggleRole(u.id, u.role)}
                        style={{ padding: '3px 10px', fontSize: 12 }}
                      >
                        {u.role === 'admin' ? 'Remove admin' : 'Make admin'}
                      </button>
                      <button
                        className="danger"
                        onClick={() => remove(u.id, u.email)}
                        style={{ padding: '3px 10px', fontSize: 12 }}
                      >
                        Remove
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </section>

      <section style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
        <h2 style={{ fontSize: 14, marginBottom: 4, color: 'var(--accent)' }}>Backups</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12 }}>
          Create a full system backup — every user's notes plus the database — as a single
          archive. Download one to keep, or Restore to replace the live notes and database
          (this restarts the server).
        </p>

        {backError && <p style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 10 }}>{backError}</p>}
        {restartNote && (
          <p style={{ color: '#3cb371', fontSize: 12, marginBottom: 10 }}>{restartNote}</p>
        )}

        <div style={{ marginBottom: 14 }}>
          <button
            onClick={createBackup}
            disabled={backBusy || anyRunning || restoring}
            style={{ fontSize: 12 }}
          >
            {(backBusy || anyRunning) ? 'Creating backup…' : 'Create backup'}
          </button>
        </div>

        {backups.length === 0 && !(backBusy || anyRunning) && (
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No backups yet.</p>
        )}

        {backups.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                <th style={{ padding: '6px 12px 6px 0', color: 'var(--text-muted)', fontWeight: 500 }}>When</th>
                <th style={{ padding: '6px 12px', color: 'var(--text-muted)', fontWeight: 500 }}>Kind</th>
                <th style={{ padding: '6px 12px', color: 'var(--text-muted)', fontWeight: 500 }}>Status</th>
                <th style={{ padding: '6px 12px', color: 'var(--text-muted)', fontWeight: 500 }}>Size</th>
                <th style={{ padding: '6px 12px', color: 'var(--text-muted)', fontWeight: 500 }}>Files</th>
                <th style={{ padding: '6px 12px', color: 'var(--text-muted)', fontWeight: 500 }}>By</th>
                <th style={{ padding: '6px 0 6px 12px', color: 'var(--text-muted)', fontWeight: 500 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {backups.map(b => (
                <tr key={b.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px 8px 0' }}>{fmtEpoch(b.created_at)}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>{b.kind}</td>
                  <td style={{ padding: '8px 12px' }}>
                    {b.status === 'failed' && b.error ? <span title={b.error}>{b.status}</span> : b.status}
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>{humanBytes(b.size_bytes)}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>{b.file_count != null ? b.file_count : '—'}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>{b.created_by_email || '—'}</td>
                  <td style={{ padding: '8px 0 8px 12px', display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => downloadBackup(b.id)}
                      disabled={b.status !== 'complete' || restoring}
                      style={{ padding: '3px 10px', fontSize: 12 }}
                    >
                      Download
                    </button>
                    <button
                      className="danger"
                      onClick={() => restoreBackup(b.id)}
                      disabled={b.status !== 'complete' || restoring || backBusy}
                      style={{ padding: '3px 10px', fontSize: 12 }}
                    >
                      {restoring ? '…' : 'Restore'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>
    </div>
  );
}
