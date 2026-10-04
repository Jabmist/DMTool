import React, { useState, useEffect, useRef } from 'react';

function wrapSelection(view, before, after, placeholder) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const text = selected || placeholder;
  view.dispatch({
    changes: { from, to, insert: `${before}${text}${after}` },
    selection: selected
      ? { anchor: from, head: from + before.length + text.length + after.length }
      : { anchor: from + before.length, head: from + before.length + text.length },
  });
  view.focus();
}

function prefixLines(view, prefix) {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  const startLine = doc.lineAt(from);
  const endLine = doc.lineAt(to);
  const changes = [];
  let cursorDelta = 0;
  for (let ln = startLine.number; ln <= endLine.number; ln++) {
    const line = doc.line(ln);
    if (line.text.startsWith(prefix)) {
      changes.push({ from: line.from, to: line.from + prefix.length, insert: '' });
      if (ln === startLine.number) cursorDelta = -prefix.length;
    } else {
      changes.push({ from: line.from, insert: prefix });
      if (ln === startLine.number) cursorDelta = prefix.length;
    }
  }
  view.dispatch({ changes, selection: { anchor: from + cursorDelta } });
  view.focus();
}

function insertBlock(view, text) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const insert = line.text.trim() ? `\n\n${text}\n` : `${text}\n`;
  view.dispatch({ changes: { from: line.to, insert } });
  view.focus();
}

function applyTextColor(view, color) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  if (!selected) return;
  const insert = `<span style="color:${color}">${selected}</span>`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from, head: from + insert.length },
  });
  view.focus();
}

function insertColorBox(view, color) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const text = selected || 'Content here';
  const doc = view.state.doc;
  const line = doc.lineAt(from);
  const prefix = line.text.trim() ? '\n\n' : '';
  const insert = `${prefix}:::colorbox{bg="${color}"}\n${text}\n:::\n`;
  view.dispatch({
    changes: { from: selected ? from : line.to, to: selected ? to : line.to, insert },
  });
  view.focus();
}

function applyHighlight(view, color) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  if (!selected) return;
  const insert = `<mark style="background:${color}">${selected}</mark>`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from, head: from + insert.length },
  });
  view.focus();
}

const TEXT_COLORS = [
  { label: 'Red',    value: '#f87171' },
  { label: 'Orange', value: '#fb923c' },
  { label: 'Yellow', value: '#fbbf24' },
  { label: 'Green',  value: '#4ade80' },
  { label: 'Cyan',   value: '#22d3ee' },
  { label: 'Blue',   value: '#60a5fa' },
  { label: 'Purple', value: '#a78bfa' },
  { label: 'Pink',   value: '#f472b6' },
];

const BOX_COLORS = [
  { label: 'Red',    value: 'rgba(248,113,113,0.18)' },
  { label: 'Orange', value: 'rgba(251,146,60,0.18)' },
  { label: 'Yellow', value: 'rgba(251,191,36,0.18)' },
  { label: 'Green',  value: 'rgba(74,222,128,0.18)' },
  { label: 'Cyan',   value: 'rgba(34,211,238,0.18)' },
  { label: 'Blue',   value: 'rgba(96,165,250,0.18)' },
  { label: 'Purple', value: 'rgba(167,139,250,0.18)' },
  { label: 'Gray',   value: 'rgba(148,163,184,0.12)' },
];

const HIGHLIGHT_COLORS = [
  { label: 'Yellow', value: '#fef08a' },
  { label: 'Green',  value: '#bbf7d0' },
  { label: 'Blue',   value: '#bfdbfe' },
  { label: 'Pink',   value: '#fecaca' },
  { label: 'Orange', value: '#fed7aa' },
  { label: 'Purple', value: '#e9d5ff' },
];

function ColumnPicker({ viewRef }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handleOutside(e) {
      if (!containerRef.current?.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  function insert(count) {
    if (!viewRef.current) return;
    const cols = Array.from({ length: count }, () => ':::col\nContent\n:::').join('\n');
    insertBlock(viewRef.current, `::::columns\n${cols}\n::::`);
    setOpen(false);
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        title="Insert columns"
        className="secondary"
        onMouseDown={e => { e.preventDefault(); setOpen(o => !o); }}
        style={{ padding: '2px 7px', fontSize: 12, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}
      >
        ⊞
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 300,
          background: 'var(--bg-panel)', border: '1px solid var(--border)',
          borderRadius: 4, padding: '4px 0',
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)', minWidth: 100,
        }}>
          {[2, 3, 4].map(n => (
            <div
              key={n}
              onMouseDown={e => { e.preventDefault(); insert(n); }}
              style={{
                padding: '5px 12px', cursor: 'pointer', fontSize: 12,
                color: 'var(--text)', userSelect: 'none',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(124,106,247,0.15)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              {n} columns
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ColorPicker({ icon, title, colors, onApply, viewRef }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handleOutside(e) {
      if (!containerRef.current?.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        title={title}
        className="secondary"
        onMouseDown={e => { e.preventDefault(); setOpen(o => !o); }}
        style={{
          padding: '2px 7px', fontSize: 12, border: 'none',
          background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer',
        }}
      >
        {icon}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 300,
          background: 'var(--bg-panel)', border: '1px solid var(--border)',
          borderRadius: 4, padding: 6,
          display: 'grid', gridTemplateColumns: 'repeat(4, 20px)', gap: 4,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        }}>
          {colors.map(c => (
            <div
              key={c.value}
              title={c.label}
              onMouseDown={e => {
                e.preventDefault();
                if (viewRef.current) onApply(viewRef.current, c.value);
                setOpen(false);
              }}
              style={{
                width: 20, height: 20, borderRadius: 3, cursor: 'pointer',
                background: c.value,
                border: '1px solid rgba(255,255,255,0.15)',
                boxSizing: 'border-box',
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const DIVIDER = null;

const TOOLS = [
  { label: 'B',    title: 'Bold',           style: { fontWeight: 'bold' },  action: v => wrapSelection(v, '**', '**', 'bold text') },
  { label: 'I',    title: 'Italic',          style: { fontStyle: 'italic' }, action: v => wrapSelection(v, '*', '*', 'italic text') },
  { label: 'S',    title: 'Strikethrough',   style: { textDecoration: 'line-through' }, action: v => wrapSelection(v, '~~', '~~', 'text') },
  { label: '`',    title: 'Inline code',     style: { fontFamily: 'monospace' }, action: v => wrapSelection(v, '`', '`', 'code') },
  DIVIDER,
  { label: 'H1',   title: 'Heading 1',       action: v => prefixLines(v, '# ') },
  { label: 'H2',   title: 'Heading 2',       action: v => prefixLines(v, '## ') },
  { label: 'H3',   title: 'Heading 3',       action: v => prefixLines(v, '### ') },
  DIVIDER,
  { label: '•',    title: 'Bullet list',     action: v => prefixLines(v, '- ') },
  { label: '1.',   title: 'Numbered list',   action: v => prefixLines(v, '1. ') },
  { label: '☐',   title: 'Checkbox',        action: v => prefixLines(v, '- [ ] ') },
  DIVIDER,
  { label: '❝',   title: 'Blockquote',      action: v => prefixLines(v, '> ') },
  { label: '```',  title: 'Code block',      style: { fontFamily: 'monospace', fontSize: 10 }, action: v => insertBlock(v, '```\n\n```') },
  { label: '—',   title: 'Horizontal rule', action: v => insertBlock(v, '---') },
];

export default function EditorToolbar({ viewRef }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 2,
      padding: '3px 8px', borderBottom: '1px solid var(--border)',
      background: 'var(--bg-sidebar)', flexWrap: 'wrap',
    }}>
      {TOOLS.map((tool, i) => {
        if (tool === DIVIDER) {
          return <div key={i} style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />;
        }
        return (
          <button
            key={tool.title}
            title={tool.title}
            className="secondary"
            onMouseDown={e => {
              e.preventDefault();
              if (viewRef.current) tool.action(viewRef.current);
            }}
            style={{
              padding: '2px 7px', fontSize: 12, minWidth: 28,
              border: 'none', background: 'transparent',
              color: 'var(--text-muted)',
              ...tool.style,
            }}
          >
            {tool.label}
          </button>
        );
      })}

      <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />

      <ColorPicker
        icon={<span style={{ borderBottom: '2px solid #f87171', lineHeight: 1 }}>A</span>}
        title="Text color"
        colors={TEXT_COLORS}
        onApply={applyTextColor}
        viewRef={viewRef}
      />
      <ColorPicker
        icon={<span style={{ background: '#fef08a', color: '#1a1a1a', padding: '0 2px', borderRadius: 2, lineHeight: 1 }}>H</span>}
        title="Highlight"
        colors={HIGHLIGHT_COLORS}
        onApply={applyHighlight}
        viewRef={viewRef}
      />
      <ColorPicker
        icon={<span style={{ border: '2px solid #60a5fa', borderRadius: 3, padding: '0 2px', lineHeight: 1, fontSize: 10 }}>▭</span>}
        title="Color box"
        colors={BOX_COLORS}
        onApply={insertColorBox}
        viewRef={viewRef}
      />
      <ColumnPicker viewRef={viewRef} />
    </div>
  );
}
