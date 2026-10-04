import React, { Children, isValidElement, useEffect, useRef } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkDirective from 'remark-directive';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { api } from '../../api/client.js';

// Allow only colour/length CSS values; reject url() and other unsafe patterns.
const isNumber = (v) =>
  /^(0|[1-9]\d*)$/.test(v) || /^\d*\.\d+$/.test(v) || /^\d+\.\d*$/.test(v);

function isSafeValue(value) {
  if (!value) return false;
  if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return true; // #rgb .. #rrggbbaa
  if (/^rgba?\(.+\)$/.test(value)) {
    const parts = value.slice(value.indexOf('(') + 1, -1).split(',').map((s) => s.trim());
    if (parts.length < 3 || parts.length > 4) return false;
    for (let i = 0; i < 3; i++) if (!isNumber(parts[i])) return false;
    if (parts.length === 4 && !isNumber(parts[3])) return false;
    return true;
  }
  if (/^(0|[1-9]\d*)(px|em|rem|pt|vh|vw|%)?$/.test(value)) return true;
  if (/^\d+\.\d+(px|em|rem|pt|vh|vw|%)?$/.test(value)) return true;
  if (/^[a-z][a-z0-9-]*$/i.test(value)) return true; // bare keyword/identifier
  return false;
}

// Whole inline `style` string is safe only if every `prop:value` declaration
// resolves to allowed tokens — no url(), no expression(), no var().
function isSafeStyle(style) {
  if (!style || !style.trim()) return false;
  for (const part of style.split(';')) {
    const decl = part.trim();
    if (!decl) continue;
    if (!decl.includes(':')) return false;
    const [prop, ...rest] = decl.split(':');
    if (!isSafeValue(prop)) return false;
    const tokens = rest.join(':').trim().split(/\s+/);
    if (!tokens.length) return false;
    for (const token of tokens) if (!isSafeValue(token)) return false;
  }
  return true;
}

function safeCssValue(value, fallback) {
  return isSafeValue(value) ? value : fallback;
}

// Extend the default schema: permit the <mark> highlight element and inline
// `style` (re-validated by stripUnsafeStyle below). `style` is allowed here as
// any-value so it survives the sanitizer; the post-pass rejects unsafe values.
const sanitizeSchema = (() => {
  const schema = {
    ...defaultSchema,
    tagNames: defaultSchema.tagNames.includes('mark')
      ? defaultSchema.tagNames
      : [...defaultSchema.tagNames, 'mark'],
    attributes: {
      ...defaultSchema.attributes,
      '*': [...(defaultSchema.attributes['*'] || []), 'style', 'className'],
    },
    protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href || []), 'wiki'] },
  };
  return schema;
})();

// Drop inline `style` attributes that fail the allowlist (url()/expression()/
// data: URIs etc. are rejected by isSafeStyle). Runs after rehype-sanitize.
function stripUnsafeStyle() {
  return (tree) => {
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.children) node.children.forEach(walk);
      if (node.type === 'element' && node.properties && 'style' in node.properties) {
        const val = node.properties.style;
        const str = Array.isArray(val) ? val.join(' ') : String(val ?? '');
        if (val !== undefined && val !== null && !isSafeStyle(str)) {
          delete node.properties.style;
        }
      }
    }
    walk(tree);
  };
}

function remarkColorBox() {
  return (tree) => {
    function walk(node) {
      if (!node.children) return;
      for (const child of node.children) {
        if (child.type === 'containerDirective' && child.name === 'colorbox') {
          const bg = safeCssValue(child.attributes?.bg, 'rgba(148,163,184,0.1)');
          child.data = child.data ?? {};
          child.data.hName = 'div';
          child.data.hProperties = {
            className: 'colorbox',
            style: `background:${bg};padding:12px 16px;border-radius:6px;margin:8px 0;border-left:3px solid rgba(255,255,255,0.1);`,
          };
        }
        walk(child);
      }
    }
    walk(tree);
  };
}

function remarkColumns() {
  return (tree) => {
    function walk(node) {
      if (!node.children) return;
      for (const child of node.children) {
        if (child.type === 'containerDirective') {
          if (child.name === 'columns') {
            child.data = child.data ?? {};
            child.data.hName = 'div';
            child.data.hProperties = {
              className: 'columns',
              style: 'display:flex;gap:16px;align-items:flex-start;margin:8px 0;',
            };
          } else if (child.name === 'col') {
            const w = safeCssValue(child.attributes?.width, null);
            child.data = child.data ?? {};
            child.data.hName = 'div';
            child.data.hProperties = {
              className: 'col',
              style: `${w ? `flex:0 0 ${w}` : 'flex:1'};min-width:0;`,
            };
          }
        }
        walk(child);
      }
    }
    walk(tree);
  };
}

function urlTransform(url) {
  if (url.startsWith('wiki:')) return url;
  return defaultUrlTransform(url);
}

const WIKILINK_RE = /\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g;

function preprocessWikilinks(content) {
  // Convert [[Target|Alias]] → [Alias](wiki:Target)
  // Convert [[Target]]       → [Target](wiki:Target)
  return content.replace(WIKILINK_RE, (_, target, alias) => {
    const label = alias?.trim() ?? target.trim();
    return `[${label}](wiki:${encodeURIComponent(target.trim())})`;
  });
}

export default function NotePreview({ content, onNavigate }) {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [content]);

  async function handleLinkClick(e, href) {
    if (!href || href.startsWith('#')) return; // let browser handle anchors natively
    e.preventDefault();
    if (href.startsWith('wiki:')) {
      const title = decodeURIComponent(href.slice(5));
      try {
        const { path } = await api.get(`/api/notes/resolve?title=${encodeURIComponent(title)}`);
        onNavigate(path);
      } catch {
        onNavigate(`${title}.md`); // fallback for notes not yet indexed
      }
    } else if (/^https?:\/\//.test(href) || href.startsWith('mailto:')) {
      window.open(href, '_blank', 'noopener,noreferrer');
    } else {
      // Relative markdown link to another note
      const title = decodeURIComponent(href).replace(/\.md$/i, '');
      onNavigate(`${title}.md`);
    }
  }

  return (
    <div ref={scrollRef} style={{
      padding: '24px 32px',
      overflowY: 'auto',
      height: '100%',
      color: 'var(--text)',
      fontFamily: 'var(--font-sans)',
      lineHeight: 1.7,
    }}>
      <style>{previewCss}</style>
      <div className="preview-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkDirective, remarkColorBox, remarkColumns]}
          rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], stripUnsafeStyle]}
          urlTransform={urlTransform}
          components={{
            a({ href, children }) {
              const isWiki = href?.startsWith('wiki:');
              return (
                <a
                  href={href}
                  onClick={e => handleLinkClick(e, href)}
                  style={{ color: isWiki ? 'var(--accent)' : undefined, cursor: 'pointer' }}
                >
                  {children}
                </a>
              );
            },
            code({ inline, className, children }) {
              if (inline) return <code className={className}>{children}</code>;
              return (
                <pre style={{ background: 'var(--bg-panel)', padding: '12px', borderRadius: 4, overflowX: 'auto' }}>
                  <code className={className}>{children}</code>
                </pre>
              );
            },
            blockquote({ children }) {
              return (
                <blockquote style={{
                  borderLeft: '3px solid var(--accent)',
                  margin: '8px 0', padding: '4px 16px',
                  color: 'var(--text-muted)',
                }}>
                  {children}
                </blockquote>
              );
            },
            li({ node, ordered, index: _index, className, children, ...props }) {
              if (!className?.includes('task-list-item')) {
                return <li className={className} {...props}>{children}</li>;
              }
              // Flatten any <p> wrapper so checkbox and label stay on one line
              const flat = [];
              Children.forEach(children, child => {
                if (isValidElement(child) && child.type === 'p') {
                  Children.forEach(child.props.children, c => flat.push(c));
                } else {
                  flat.push(child);
                }
              });
              return (
                <li className={className} {...props} style={{ listStyle: 'none', display: 'flex', alignItems: 'center' }}>
                  {flat}
                </li>
              );
            },
          }}
        >
          {preprocessWikilinks(content)}
        </ReactMarkdown>
      </div>
    </div>
  );
}

const previewCss = `
  .preview-body h1, .preview-body h2, .preview-body h3,
  .preview-body h4, .preview-body h5, .preview-body h6 {
    color: #e0e0e0;
    margin: 1.2em 0 0.4em;
    line-height: 1.3;
  }
  .preview-body h1 { font-size: 1.8em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
  .preview-body h2 { font-size: 1.4em; border-bottom: 1px solid var(--border); padding-bottom: 0.2em; }
  .preview-body p { margin: 0.6em 0; }
  .preview-body ul, .preview-body ol { padding-left: 1.6em; margin: 0.4em 0; }
  .preview-body li { margin: 0.2em 0; }
  .preview-body code { background: var(--bg-panel); padding: 2px 5px; border-radius: 3px; font-family: var(--font-mono); font-size: 0.88em; }
  .preview-body table { border-collapse: collapse; width: 100%; margin: 0.8em 0; }
  .preview-body th, .preview-body td { border: 1px solid var(--border); padding: 6px 12px; }
  .preview-body th { background: var(--bg-panel); }
  .preview-body hr { border: none; border-top: 1px solid var(--border); margin: 1.2em 0; }
  .preview-body li.task-list-item input[type=checkbox] {
    width: auto; padding: 0; background: revert; border: revert; border-radius: 0;
    margin-right: 6px; cursor: default; flex-shrink: 0;
  }
`;
