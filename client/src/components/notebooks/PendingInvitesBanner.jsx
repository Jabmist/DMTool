import React, { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useAuthStore } from '../../store/authStore.js';

export default function PendingInvitesBanner({ onAccepted }) {
  const [invites, setInvites] = useState([]);
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const userId = useAuthStore(s => s.user?.id);

  useEffect(() => {
    api.get('/api/notebooks/invites/pending')
      .then(d => { setInvites(d.invites); setDismissed(false); })
      .catch(() => {});
  }, []);

  async function reload() {
    const d = await api.get('/api/notebooks/invites/pending').catch(() => ({ invites: [] }));
    setInvites(d.invites);
  }

  async function accept(notebookId) {
    try {
      await api.post(`/api/notebooks/${notebookId}/members/accept`);
      await reload();
      onAccepted?.();
    } catch { /* ignore */ }
  }

  async function decline(notebookId) {
    if (!userId) return;
    try {
      await api.delete(`/api/notebooks/${notebookId}/members/${userId}`);
      await reload();
    } catch { /* ignore */ }
  }

  if (dismissed || invites.length === 0) return null;

  return (
    <div style={{
      background: 'rgba(124,106,247,0.12)', borderBottom: '1px solid var(--accent)',
      padding: '6px 16px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8,
      flexWrap: 'wrap',
    }}>
      <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
        {invites.length} notebook invite{invites.length !== 1 ? 's' : ''} pending
      </span>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: 12, padding: 0, textDecoration: 'underline' }}
      >
        {open ? 'Hide' : 'View'}
      </button>
      <button
        onClick={() => setDismissed(true)}
        style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13, padding: '0 2px', marginLeft: 'auto', lineHeight: 1 }}
        title="Dismiss"
      >
        ×
      </button>

      {open && (
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 4 }}>
          {invites.map(inv => (
            <div key={inv.notebookId} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--text)' }}>
                <strong>{inv.name}</strong>
                <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
                  invited by {inv.invitedByEmail} · {inv.role}
                </span>
              </span>
              <button onClick={() => accept(inv.notebookId)} style={{ fontSize: 11, padding: '2px 8px' }}>
                Accept
              </button>
              <button onClick={() => decline(inv.notebookId)} className="secondary" style={{ fontSize: 11, padding: '2px 8px' }}>
                Decline
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
