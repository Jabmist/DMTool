import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { preprocessEntityLinks } from '../components/editor/entityLinks.js';

// ── Wikilink preprocessing (pure function — extracted for direct testing) ──────
const WIKILINK_RE = /\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g;
function preprocessWikilinks(content) {
  return content.replace(WIKILINK_RE, (_, target, alias) => {
    const label = alias?.trim() ?? target.trim();
    return `[${label}](wiki:${encodeURIComponent(target.trim())})`;
  });
}

describe('preprocessWikilinks', () => {
  it('converts [[Target]] to markdown link with wiki: scheme', () => {
    expect(preprocessWikilinks('See [[Alpha]]')).toBe('See [Alpha](wiki:Alpha)');
  });

  it('uses alias as link text when provided', () => {
    expect(preprocessWikilinks('[[Target|My Label]]')).toBe('[My Label](wiki:Target)');
  });

  it('percent-encodes spaces in target', () => {
    expect(preprocessWikilinks('[[My Note]]')).toBe('[My Note](wiki:My%20Note)');
  });

  it('leaves non-wikilink markdown untouched', () => {
    const md = '[normal link](https://example.com)';
    expect(preprocessWikilinks(md)).toBe(md);
  });

  it('handles multiple wikilinks in one string', () => {
    const out = preprocessWikilinks('[[A]] and [[B|bee]]');
    expect(out).toContain('[A](wiki:A)');
    expect(out).toContain('[bee](wiki:B)');
  });

  it('trims whitespace around target and alias', () => {
    expect(preprocessWikilinks('[[ Target | Label ]]')).toBe('[Label](wiki:Target)');
  });
});

// ── Entity-link preprocessing (pure function) ─────────────────────────────────
describe('preprocessEntityLinks', () => {
  it('rewrites each of the six doubled-symbol forms to a wiki: link', () => {
    const out = preprocessEntityLinks('a &&Borg the Black&& b !!Council Summit!! c');
    expect(out).toContain('[Borg the Black](wiki:Borg%20the%20Black)');
    expect(out).toContain('[Council Summit](wiki:Council%20Summit)');
  });

  it('percent-encodes spaces in the name', () => {
    expect(preprocessEntityLinks('@@Small town@@')).toBe('[Small town](wiki:Small%20town)');
  });

  it('does not touch markdown bold (single * / **)', () => {
    expect(preprocessEntityLinks('**bold** text')).toBe('**bold** text');
  });

  it('does not treat a mismatched pair as a link', () => {
    expect(preprocessEntityLinks('!!open@@close')).toBe('!!open@@close');
  });

  it('does not treat a stray single symbol or unclosed pair as a link', () => {
    expect(preprocessEntityLinks('c++ and ++ is raw')).toBe('c++ and ++ is raw');
    expect(preprocessEntityLinks('&& unclosed name')).toBe('&& unclosed name');
  });

  it('handles all six on one line together', () => {
    const out = preprocessEntityLinks('@@Loc@@ &&Npc&& $$Item$$ ^^Trap^^ ++Player++ !!Event!!');
    expect(out).toBe('[Loc](wiki:Loc) [Npc](wiki:Npc) [Item](wiki:Item) [Trap](wiki:Trap) [Player](wiki:Player) [Event](wiki:Event)');
  });
});

// ── NotePreview component ─────────────────────────────────────────────────────
vi.mock('../api/client.js', () => ({
  api: {
    get: vi.fn(),
  },
}));

import { api } from '../api/client.js';
import NotePreview from '../components/editor/NotePreview.jsx';

describe('NotePreview', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders markdown content', () => {
    render(<NotePreview content="# Hello World" onNavigate={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hello World');
  });

  it('renders wikilinks as anchor elements', async () => {
    render(<NotePreview content="See [[Alpha]]" onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Alpha' })).toBeInTheDocument());
  });

  it('calls onNavigate with resolved path when wikilink is clicked', async () => {
    api.get.mockResolvedValue({ path: 'Alpha.md' });
    const onNavigate = vi.fn();
    render(<NotePreview content="See [[Alpha]]" onNavigate={onNavigate} />);
    const link = await screen.findByRole('link', { name: 'Alpha' });
    fireEvent.click(link);
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('Alpha.md'));
  });

  it('falls back to title.md when resolve API fails', async () => {
    api.get.mockRejectedValue(new Error('not found'));
    const onNavigate = vi.fn();
    render(<NotePreview content="[[Unknown Note]]" onNavigate={onNavigate} />);
    const link = await screen.findByRole('link', { name: 'Unknown Note' });
    fireEvent.click(link);
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('Unknown Note.md'));
  });

  it('renders entity links as clickable anchors', async () => {
    render(<NotePreview content="Visit &&Borg the Black&&" onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Borg the Black' })).toBeInTheDocument());
  });

  it('resolves an entity link via the resolve endpoint on click', async () => {
    api.get.mockResolvedValue({ path: 'entities/npc/Borg the Black.md' });
    const onNavigate = vi.fn();
    render(<NotePreview content="Visit &&Borg the Black&&" onNavigate={onNavigate} />);
    const link = await screen.findByRole('link', { name: 'Borg the Black' });
    fireEvent.click(link);
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('entities/npc/Borg the Black.md'));
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining('/api/notes/resolve?title=Borg%20the%20Black'));
  });

  it('renders GFM tables', async () => {
    render(<NotePreview content={'| A | B |\n|---|---|\n| 1 | 2 |'} onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
  });

  it('renders task list checkboxes', async () => {
    render(<NotePreview content={'- [x] Done\n- [ ] Todo'} onNavigate={vi.fn()} />);
    await waitFor(() => {
      const boxes = screen.getAllByRole('checkbox');
      expect(boxes.length).toBe(2);
    });
  });

  it('renders inline HTML color spans', async () => {
    render(<NotePreview content={'<span style="color:#f87171">red text</span>'} onNavigate={vi.fn()} />);
    await waitFor(() => {
      const el = screen.getByText('red text');
      expect(el.tagName).toBe('SPAN');
      expect(el.style.color).toBe('rgb(248, 113, 113)');
    });
  });

  it('renders mark highlight elements', async () => {
    render(<NotePreview content={'<mark style="background:#fef08a">highlighted</mark>'} onNavigate={vi.fn()} />);
    await waitFor(() => {
      const el = screen.getByText('highlighted');
      expect(el.tagName).toBe('MARK');
      expect(el.style.background).toBeTruthy();
    });
  });

  it('renders colorbox directive as a div with background style', async () => {
    const md = ':::colorbox{bg="rgba(96,165,250,0.18)"}\nBox content\n:::';
    render(<NotePreview content={md} onNavigate={vi.fn()} />);
    await waitFor(() => {
      const el = screen.getByText('Box content');
      const box = el.closest('.colorbox');
      expect(box).not.toBeNull();
      expect(box.style.background).toBeTruthy();
    });
  });

  it('renders markdown inside a colorbox directive', async () => {
    const md = ':::colorbox{bg="rgba(74,222,128,0.18)"}\n**bold inside box**\n:::';
    render(<NotePreview content={md} onNavigate={vi.fn()} />);
    await waitFor(() => {
      const bold = screen.getByText('bold inside box');
      expect(bold.tagName).toBe('STRONG');
    });
  });

  it('uses default background when bg attribute is missing', async () => {
    const md = ':::colorbox\nDefault box\n:::';
    render(<NotePreview content={md} onNavigate={vi.fn()} />);
    await waitFor(() => {
      const box = screen.getByText('Default box').closest('.colorbox');
      expect(box).not.toBeNull();
    });
  });

  it('renders a two-column layout with flex container', async () => {
    const md = '::::columns\n:::col\nLeft content\n:::\n:::col\nRight content\n:::\n::::';
    render(<NotePreview content={md} onNavigate={vi.fn()} />);
    await waitFor(() => {
      const left  = screen.getByText('Left content');
      const right = screen.getByText('Right content');
      const leftCol  = left.closest('.col');
      const rightCol = right.closest('.col');
      expect(leftCol).not.toBeNull();
      expect(rightCol).not.toBeNull();
      const container = leftCol.closest('.columns');
      expect(container).not.toBeNull();
      expect(container.style.display).toBe('flex');
    });
  });

  it('renders markdown inside column cells', async () => {
    const md = '::::columns\n:::col\n**bold in col**\n:::\n:::col\nplain\n:::\n::::';
    render(<NotePreview content={md} onNavigate={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('bold in col').tagName).toBe('STRONG');
    });
  });

  it('renders three columns', async () => {
    const md = '::::columns\n:::col\nA\n:::\n:::col\nB\n:::\n:::col\nC\n:::\n::::';
    render(<NotePreview content={md} onNavigate={vi.fn()} />);
    await waitFor(() => {
      const cols = document.querySelectorAll('.col');
      expect(cols.length).toBe(3);
    });
  });

  it('applies custom width on col directive', async () => {
    const md = '::::columns\n:::col{width="30%"}\nNarrow\n:::\n:::col\nWide\n:::\n::::';
    render(<NotePreview content={md} onNavigate={vi.fn()} />);
    await waitFor(() => {
      const narrow = screen.getByText('Narrow').closest('.col');
      expect(narrow.style.flex).toContain('30%');
    });
  });
});

// ── Security: stored XSS via raw HTML must be neutralised (security.md #2) ──────
describe('NotePreview XSS safety', () => {
  it('strips <script> tags from raw HTML', async () => {
    render(<NotePreview content={'text <script>window.__pwned=1</script> more'} onNavigate={vi.fn()} />);
    await waitFor(() => expect(document.querySelector('.preview-body')).toHaveTextContent(/more/));
    expect(document.querySelector('script')).toBeNull();
    expect(window.__pwned).toBeUndefined();
    delete window.__pwned;
  });

  it('strips inline event handlers (onerror) from injected elements', async () => {
    render(<NotePreview content={'<img src=x onerror="window.__pwned=1">'} onNavigate={vi.fn()} />);
    await waitFor(() => expect(document.querySelector('img')).not.toBeNull());
    expect(document.querySelector('img')?.getAttribute('onerror')).toBeNull();
    expect(window.__pwned).toBeUndefined();
    delete window.__pwned;
  });

  it('does not allow javascript: hrefs on links', async () => {
    render(<NotePreview content={'[click](javascript:alert(1))'} onNavigate={vi.fn()} />);
    const link = await screen.findByText('click');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
  });

  it('removes dangerous url()/expression() from inline style, keeps safe styles', async () => {
    const { container } = render(
      <NotePreview content={'<span style="background:url(javascript:alert(1))">a</span><span style="color:#f87171">b</span>'} onNavigate={vi.fn()} />
    );
    await waitFor(() => expect(screen.getByText('b')).toBeInTheDocument());
    const spans = container.querySelectorAll('span');
    const aStyle = spans[0].getAttribute('style') ?? '';
    const bSpan = spans[1];
    expect(aStyle).not.toContain('url(');
    expect(aStyle).not.toContain('javascript');
    expect(bSpan.style.color).toBe('rgb(248, 113, 113)');
  });
});
