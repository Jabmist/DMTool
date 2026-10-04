import React, { useState } from 'react';
import { api } from '../../api/client.js';

export default function ChangePasswordDialog({ onClose, onSuccess }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (next !== confirm) { setError('New passwords do not match'); return; }
    setError('');
    setLoading(true);
    try {
      await api.post('/api/auth/change-password', { currentPassword: current, newPassword: next });
      onSuccess?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
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
          <h3 style={{ margin: 0, fontSize: 14, color: 'var(--text)' }}>Change password</h3>
          <button
            onClick={onClose}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 18, lineHeight: 1, padding: '0 2px' }}
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Current password
            <input
              type="password"
              value={current}
              onChange={e => { setCurrent(e.target.value); setError(''); }}
              style={{ width: '100%', fontSize: 12, marginTop: 2 }}
              disabled={loading}
            />
          </label>
          <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            New password (12+ characters)
            <input
              type="password"
              value={next}
              onChange={e => { setNext(e.target.value); setError(''); }}
              style={{ width: '100%', fontSize: 12, marginTop: 2 }}
              disabled={loading}
            />
          </label>
          <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Confirm new password
            <input
              type="password"
              value={confirm}
              onChange={e => { setConfirm(e.target.value); setError(''); }}
              style={{ width: '100%', fontSize: 12, marginTop: 2 }}
              disabled={loading}
            />
          </label>
          {error && <div style={{ fontSize: 11, color: 'var(--danger)' }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            <button type="button" className="secondary" onClick={onClose} style={{ fontSize: 12 }} disabled={loading}>
              Cancel
            </button>
            <button type="submit" style={{ fontSize: 12 }} disabled={loading}>
              {loading ? '…' : 'Change password'}
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Changing your password signs out every other device and session.
          </div>
        </form>
      </div>
    </div>
  );
}
