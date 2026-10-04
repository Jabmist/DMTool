import React from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../store/authStore.js';
import { useMobile } from '../hooks/useMobile.js';
import NotePreview from '../components/editor/NotePreview.jsx';
import { INTRO, SECTIONS } from './helpContent.js';

function sectionText(s) {
  return (s.title + '\n' + s.body).toLowerCase();
}

const navLinkStyle = {
  display: 'block', textAlign: 'left',
  border: 'none', background: 'transparent', cursor: 'pointer',
  fontSize: 12, padding: '4px 6px', borderRadius: 4, color: 'var(--text-muted)',
};

export default function HelpPage() {
  const user = useAuthStore(s => s.user);
  const navigateToNote = React.useCallback(() => { /* no-op from help */ }, []);
  const isMobile = useMobile();
  const [query, setQuery] = React.useState('');
  const [openIds, setOpenIds] = React.useState([]);
  const [topicsOpen, setTopicsOpen] = React.useState(false);
  const sectionRefs = React.useRef({});

  const q = query.trim().toLowerCase();
  const visible = q ? SECTIONS.filter(s => sectionText(s).includes(q)) : SECTIONS;

  // A search opens every matching section, so hits are visible immediately.
  React.useEffect(() => {
    if (!q) return;
    setOpenIds(prev => {
      const added = SECTIONS
        .filter(s => sectionText(s).includes(q))
        .map(s => s.id)
        .filter(id => !prev.includes(id));
      return added.length ? [...prev, ...added] : prev;
    });
  }, [q]);

  const isOpen = id => openIds.includes(id);
  const toggle = id => setOpenIds(prev =>
    prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const goTo = id => {
    setOpenIds(prev => (prev.includes(id) ? prev : [...prev, id]));
    setTopicsOpen(false);
    // The <section> shell stays mounted, so it can be scrolled to immediately.
    const el = sectionRefs.current[id];
    if (el) el.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  const searchBox = (
    <input
      type="search"
      value={query}
      onChange={e => setQuery(e.target.value)}
      placeholder="Search the help…"
      aria-label="Search the help"
      style={{ fontSize: 12, width: '100%', boxSizing: 'border-box' }}
    />
  );

  const topicLinks = visible.map(s => (
    <button key={s.id} onClick={() => goTo(s.id)} style={{ ...navLinkStyle, width: '100%' }}>
      {s.title}
    </button>
  ));

  const backLink = user ? (
    <Link to="/" style={{ color: 'var(--accent)', fontSize: 13 }}>← Back to notes</Link>
  ) : (
    <Link to="/login" style={{ color: 'var(--accent)', fontSize: 13 }}>← Back to sign in</Link>
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div style={{
        padding: '10px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg-sidebar)',
      }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#e0e0e0' }}>Help</span>
        <span style={{ flex: 1 }} />
        {isMobile && (
          <button
            onClick={() => setTopicsOpen(o => !o)}
            aria-expanded={topicsOpen}
            style={{ ...navLinkStyle, width: 'auto' }}
          >
            Topics <span aria-hidden="true">{topicsOpen ? '▾' : '▸'}</span>
          </button>
        )}
        {backLink}
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {!isMobile && (
          <nav
            aria-label="Help topics"
            style={{
              width: 220, flexShrink: 0, borderRight: '1px solid var(--border)',
              background: 'var(--bg-sidebar)', display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>{searchBox}</div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 6px' }}>{topicLinks}</div>
          </nav>
        )}

        <main style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {isMobile && (
            <>
              <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-sidebar)' }}>
                {searchBox}
              </div>
              {topicsOpen && (
                <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', background: 'var(--bg-sidebar)' }}>
                  {topicLinks}
                </div>
              )}
            </>
          )}

          {visible.length === 0 ? (
            <p style={{ padding: '24px 32px', color: 'var(--text-muted)' }}>
              No help topics match <strong>{query}</strong>.
            </p>
          ) : (
            <article style={{ maxWidth: 880, margin: '0 auto', padding: '24px 32px' }}>
              {!q && <NotePreview content={INTRO} onNavigate={navigateToNote} />}
              {visible.map((s, i) => (
                <section
                  key={s.id}
                  id={`help-${s.id}`}
                  data-testid={`help-section-${s.id}`}
                  ref={el => { sectionRefs.current[s.id] = el; }}
                  style={{
                    borderTop: (q ? i > 0 : true) ? '1px solid var(--border)' : 'none',
                    marginTop: 20, paddingTop: 18, scrollMarginTop: 8,
                  }}
                >
                  <h2 style={{ margin: '0 0 10px' }}>
                    <button
                      onClick={() => toggle(s.id)}
                      data-testid={`help-toggle-${s.id}`}
                      aria-expanded={isOpen(s.id)}
                      aria-controls={`help-body-${s.id}`}
                      style={{
                        border: 'none', background: 'transparent', cursor: 'pointer',
                        color: 'var(--text)', fontSize: 16, fontWeight: 600, padding: 0,
                        display: 'flex', alignItems: 'center', gap: 8,
                      }}
                    >
                      <span aria-hidden="true" style={{ width: 12, color: 'var(--text-muted)', fontSize: 12, display: 'inline-block' }}>
                        {isOpen(s.id) ? '▾' : '▸'}
                      </span>
                      {s.title}
                    </button>
                  </h2>
                  {isOpen(s.id) && (
                    <div id={`help-body-${s.id}`} data-testid={`help-body-${s.id}`}>
                      <NotePreview content={s.body} onNavigate={navigateToNote} />
                    </div>
                  )}
                </section>
              ))}
            </article>
          )}
        </main>
      </div>
    </div>
  );
}
