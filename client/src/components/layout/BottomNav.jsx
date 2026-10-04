import React, { useState } from 'react';
import { useAuthStore } from '../../store/authStore.js';

const PRIMARY_TABS = [
  { key: 'editor',    label: 'Note',      icon: '✏' },
  { key: 'graph',     label: 'Graph',     icon: '◎' },
  { key: 'dissect',   label: 'Dissect',   icon: '✦' },
  { key: 'import',    label: 'Import',    icon: '↑' },
  { key: 'templates', label: 'Templates', icon: '≡' },
];

const OVERFLOW_TABS = [
  { key: 'templates', label: 'Templates', icon: '≡' },
  { key: 'admin',     label: 'Admin',     icon: '⚙' },
];

function TabBtn({ icon, label, active, onClick }) {
  return (
    <button
      className="bottom-nav-btn"
      onClick={onClick}
      style={{
        flex: 1, border: 'none', borderRadius: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 3, padding: '6px 4px', minHeight: 56,
        color: active ? 'var(--accent)' : 'var(--text-muted)', fontSize: 10,
      }}
    >
      <span style={{ fontSize: 20, lineHeight: 1 }}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

export default function BottomNav({ activeView, onViewChange }) {
  const user = useAuthStore(s => s.user);
  const isAdmin = user?.role === 'admin';
  const [moreOpen, setMoreOpen] = useState(false);

  function go(view) { onViewChange(view); setMoreOpen(false); }

  const overflowActive = activeView === 'templates' || activeView === 'admin';

  return (
    <>
      {isAdmin && moreOpen && (
        <>
          <div onClick={() => setMoreOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 299 }} />
          <div style={{
            position: 'fixed', bottom: 56, left: 0, right: 0, zIndex: 300,
            background: 'var(--bg-panel)', borderTop: '1px solid var(--border)',
          }}>
            {OVERFLOW_TABS.map(t => (
              <div
                key={t.key}
                onClick={() => go(t.key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '14px 20px', cursor: 'pointer', fontSize: 14,
                  color: activeView === t.key ? 'var(--accent)' : 'var(--text)',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <span style={{ fontSize: 18 }}>{t.icon}</span>
                {t.label}
              </div>
            ))}
          </div>
        </>
      )}
      <nav style={{
        height: 56, display: 'flex', alignItems: 'stretch', flexShrink: 0,
        background: 'var(--bg-sidebar)', borderTop: '1px solid var(--border)',
      }}>
        {(isAdmin ? PRIMARY_TABS.slice(0, 4) : PRIMARY_TABS).map(t => (
          <TabBtn key={t.key} icon={t.icon} label={t.label} active={activeView === t.key} onClick={() => go(t.key)} />
        ))}
        {isAdmin && (
          <TabBtn icon="···" label="More" active={overflowActive || moreOpen} onClick={() => setMoreOpen(o => !o)} />
        )}
      </nav>
    </>
  );
}
