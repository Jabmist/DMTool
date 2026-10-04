import React, { useState } from 'react';
import { useMobile } from '../../hooks/useMobile.js';

export default function BacklinksPanel({ backlinks, onNavigate }) {
  const isMobile = useMobile();
  const [open, setOpen] = useState(false);

  if (isMobile) {
    // Fixed bottom sheet above the nav bar. DOM order [list, header] with
    // flex-direction:column keeps the header anchored at bottom:56 and the
    // list growing upward when expanded.
    return (
      <div style={{
        position: 'fixed', bottom: 56, left: 0, right: 0, zIndex: 100,
        background: 'var(--bg-sidebar)', borderTop: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
      }}>
        {open && (
          <div style={{ maxHeight: 220, overflowY: 'auto', padding: '8px 16px 4px' }}>
            {backlinks.map(b => (
              <div
                key={b.source_path}
                onClick={() => { onNavigate(b.source_path); setOpen(false); }}
                style={{ cursor: 'pointer', color: 'var(--accent)', padding: '6px 0', fontSize: 13 }}
              >
                {b.title}
              </div>
            ))}
          </div>
        )}
        <div
          onClick={() => setOpen(o => !o)}
          style={{
            padding: '10px 16px', cursor: 'pointer', fontSize: 12,
            color: 'var(--text-muted)', fontWeight: 600,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            minHeight: 44,
          }}
        >
          <span>Backlinks ({backlinks.length})</span>
          <span>{open ? '▾' : '▴'}</span>
        </div>
      </div>
    );
  }

  return (
    <aside style={{
      width: 200, borderLeft: '1px solid var(--border)',
      padding: 12, overflowY: 'auto', fontSize: 12,
    }}>
      <p style={{ color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>
        Backlinks ({backlinks.length})
      </p>
      {backlinks.map(b => (
        <div
          key={b.source_path}
          onClick={() => onNavigate(b.source_path)}
          style={{ cursor: 'pointer', color: 'var(--accent)', marginBottom: 6 }}
        >
          {b.title}
        </div>
      ))}
    </aside>
  );
}
