import React from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../store/authStore.js';
import { APP_VERSION, CHANGELOG } from '../version.js';

export default function VersionPage() {
  const user = useAuthStore(s => s.user);
  const back = user
    ? { to: '/', label: '← Back to notes' }
    : { to: '/login', label: '← Back to sign in' };
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div style={{
        padding: '10px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg-sidebar)',
      }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#e0e0e0' }}>What's new</span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>version {APP_VERSION}</span>
        <span style={{ flex: 1 }} />
        <Link to={back.to} style={{ color: 'var(--accent)', fontSize: 13 }}>{back.label}</Link>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 16px' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
          {CHANGELOG.map(entry => (
            <div key={entry.version} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 20, marginBottom: 4 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <h2 style={{ fontSize: 16, margin: 0 }}>{entry.title}</h2>
                <span style={{ fontSize: 12, color: 'var(--accent)' }}>{entry.version}</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{entry.date}</span>
              </div>
              <ul style={{ margin: '8px 0 0 0', paddingLeft: 18, color: 'var(--text)', fontSize: 14, lineHeight: 1.55 }}>
                {entry.changes.map((change, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>{change}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
