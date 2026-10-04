import React from 'react';

// Issue #16: blocking announcement shown to all users inside the admin-set
// window. Intentionally has no close/× button and no backdrop dismiss — the
// user must acknowledge with OK. `message` is the announcement text.
export default function AnnouncementDialog({ message, onAck }) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Announcement"
      style={{
        position: 'fixed', inset: 0, zIndex: 3000,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        style={{
          background: 'var(--bg-panel)', border: '1px solid var(--border)',
          borderRadius: 8, padding: 20, width: 420, maxWidth: '92vw',
          display: 'flex', flexDirection: 'column', gap: 14,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14, color: 'var(--text)' }}>Notice</h3>

        <div
          style={{
            whiteSpace: 'pre-wrap', overflow: 'auto',
            fontSize: 13, lineHeight: 1.5, color: 'var(--text)',
            maxHeight: '55vh',
          }}
        >
          {String(message ?? '')}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onAck} style={{ fontSize: 13 }} autoFocus>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
