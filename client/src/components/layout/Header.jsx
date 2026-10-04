import React from 'react';

export default function Header({ sidebarOpen, onToggle, activeNotePath }) {
  const noteTitle = activeNotePath
    ? activeNotePath.replace(/\.md$/, '').split('/').pop()
    : 'DMTool';

  return (
    <div style={{
      height: 44, flexShrink: 0,
      display: 'flex', alignItems: 'center', gap: 4, padding: '0 4px',
      background: 'var(--bg-sidebar)', borderBottom: '1px solid var(--border)',
    }}>
      <button
        onClick={onToggle}
        aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
        style={{
          background: 'none', border: 'none', color: 'var(--text)',
          fontSize: 20, lineHeight: 1, padding: '0 8px',
          flexShrink: 0, minHeight: 44, minWidth: 44,
        }}
      >
        ☰
      </button>
      <span style={{
        flex: 1, fontSize: 14, fontWeight: 600,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: activeNotePath ? 'var(--text)' : 'var(--text-muted)',
      }}>
        {noteTitle}
      </span>
    </div>
  );
}
