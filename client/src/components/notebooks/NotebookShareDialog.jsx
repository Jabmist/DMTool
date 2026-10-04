import React, { useEffect, useState } from 'react';
import { api } from '../../api/client.js';

export default function NotebookShareDialog({ notebook, onClose, onChanged }) {
  const [members, setMembers] = useState([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('editor');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const isOwner = notebook.role === 'owner';

  useEffect(() => {
    api.get(`/api/notebooks/${notebook.id}/members`)
      .then(d => setMembers(d.members))
      .catch(() => {});
  }, [notebook.id]);

  async function handleInvite(e) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setError('');
    setLoading(true);
    try {
      await api.post(`/api/notebooks/${notebook.id}/members`, { email: trimmed, role });
      setEmail('');
      const d = await api.get(`/api/notebooks/${notebook.id}/members`);
      setMembers(d.members);
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRoleChange(userId, newRole) {
    try {
      await api.patch(`/api/notebooks/${notebook.id}/members/${userId}`, { role: newRole });
      setMembers(prev => prev.map(m => m.userId === userId ? { ...m, role: newRole } : m));
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRemove(userId) {
    try {
      await api.delete(`/api/notebooks/${notebook.id}/members/${userId}`);
      setMembers(prev => prev.filter(m => m.userId !== userId));
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-panel)', border: '1px solid var(--border)',
          borderRadius: 8, padding: 20, width: 380, maxWidth: '90vw',
          display: 'flex', flexDirection: 'column', gap: 14,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: 14, color: 'var(--text)' }}>
            Share "{notebook.name}"
          </h3>
          <button
            onClick={onClose}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 18, lineHeight: 1, padding: '0 2px' }}
          >
            ×
          </button>
        </div>

        {members.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontVariant: 'small-caps', letterSpacing: '0.05em' }}>Members</div>
            {members.map(m => (
              <div key={m.userId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>
                  {m.email}
                  {!m.accepted && <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>(pending)</span>}
                </span>
                {isOwner ? (
                  <>
                    <select
                      value={m.role}
                      onChange={e => handleRoleChange(m.userId, e.target.value)}
                      style={{ fontSize: 11, padding: '1px 4px' }}
                    >
                      <option value="editor">editor</option>
                      <option value="viewer">viewer</option>
                    </select>
                    <button
                      onClick={() => handleRemove(m.userId)}
                      style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--danger)', fontSize: 13, padding: '0 2px', lineHeight: 1 }}
                      title="Remove member"
                    >
                      ×
                    </button>
                  </>
                ) : (
                  <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{m.role}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {isOwner && (
          <form onSubmit={handleInvite} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontVariant: 'small-caps', letterSpacing: '0.05em' }}>Invite</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="email"
                placeholder="Email address…"
                value={email}
                onChange={e => { setEmail(e.target.value); setError(''); }}
                style={{ flex: 1, fontSize: 12 }}
                disabled={loading}
              />
              <select
                value={role}
                onChange={e => setRole(e.target.value)}
                style={{ fontSize: 12, padding: '2px 4px' }}
                disabled={loading}
              >
                <option value="editor">editor</option>
                <option value="viewer">viewer</option>
              </select>
              <button type="submit" disabled={loading} style={{ fontSize: 12, padding: '4px 10px' }}>
                {loading ? '…' : 'Invite'}
              </button>
            </div>
            {error && <div style={{ fontSize: 11, color: 'var(--danger)' }}>{error}</div>}
          </form>
        )}

        {members.length === 0 && !isOwner && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>No other members.</p>
        )}
      </div>
    </div>
  );
}
