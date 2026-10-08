import { getDb } from '../db/index.js';
import { readNote, listNotes } from './fileService.js';
import { ENTITY_TYPES, ENTITY_SYMBOLS, linkRegex } from '../entityTypes.js';
import path from 'path';

const WIKILINK_RE = /\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g;
const TAG_RE = /(?:^|\s)#([\w/-]+)/g;
const FRONTMATTER_TAG_RE = /^tags:\s*\[([^\]]+)\]/m;
// DMTool entity frontmatter (Q8): `entity: &` — the value is one of the six
// one-char symbols. Loose line-anchored parse, same shape as the tags frontmatter
// regex (no YAML dependency).
const FRONTMATTER_ENTITY_RE = /^entity:\s*([!@&$^+])\s*$/m;

function extractTitle(notePath) {
  return path.basename(notePath, '.md');
}

function stripFrontmatter(content) {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

function extractLinks(content) {
  const links = [];
  for (const m of content.matchAll(WIKILINK_RE)) {
    links.push({ target: m[1].trim(), label: m[2]?.trim() ?? null });
  }
  // DMTool entity links (Phase 2): every `&sym Name &sym` form the same flat,
  // untyped shape as a wikilink — target = the entity's display name, so resolve-
  // by-title, backlinks and the graph all work unchanged (no `link_type` column,
  // per Q2's display rule). Frontmatter is excluded since only one `entity:` line
  // may appear and the `name` capture class never spans `&&Name&&`.
  const body = stripFrontmatter(content);
  for (const t of ENTITY_TYPES) {
    for (const m of body.matchAll(linkRegex(t.symbol))) {
      const name = m[1].trim();
      if (!name) continue;
      if (links.some(l => l.target === name)) continue;
      links.push({ target: name, label: null });
    }
  }
  return links;
}

function extractTags(content) {
  const tags = new Set();
  for (const m of content.matchAll(TAG_RE)) tags.add(m[1]);
  const fm = FRONTMATTER_TAG_RE.exec(content);
  if (fm) fm[1].split(',').forEach(t => tags.add(t.trim().replace(/^['"]|['"]$/g, '')));
  return [...tags];
}

// Read the `entity:` frontmatter key (Q8). Returns the one-char symbol if the
// value is one of the six, otherwise null (note falls back to an ordinary
// note). Absent or invalid values both yield null — graceful downgrade.
function extractEntitySymbol(content) {
  const m = FRONTMATTER_ENTITY_RE.exec(content);
  if (m && ENTITY_SYMBOLS.has(m[1])) return m[1];
  return null;
}

export async function indexNote(userId, notePath, editorId) {
  const db = getDb();
  const content = await readNote(userId, notePath);
  const title = extractTitle(notePath);
  // Who actually wrote this version (a member editing a shared notebook differs
  // from the owner). Defaulted to the owner for private writes / re-indexing.
  const lastEditedBy = editorId ?? userId;
  const entitySymbol = extractEntitySymbol(content);

  // `INSERT OR REPLACE` below will give the note a NEW id (SQLite deletes +
  // re-inserts). FTS rows are keyed by that id (rowid = notes.id), so we must
  // delete the old FTS row BEFORE the upsert and insert the fresh one AFTER.
  const oldRowid = db.prepare('SELECT id FROM notes WHERE user_id = ? AND path = ?').get(userId, notePath)?.id;
  if (oldRowid !== undefined) {
    db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(oldRowid);
  }

  db.prepare('INSERT OR REPLACE INTO notes (user_id, path, title, updated_at, last_edited_by, entity_symbol) VALUES (?, ?, ?, unixepoch(), ?, ?)')
    .run(userId, notePath, title, lastEditedBy, entitySymbol);

  db.prepare('DELETE FROM links WHERE user_id = ? AND source_path = ?').run(userId, notePath);
  const insertLink = db.prepare('INSERT INTO links (user_id, source_path, target_title, label) VALUES (?, ?, ?, ?)');
  for (const { target, label } of extractLinks(content)) insertLink.run(userId, notePath, target, label);

  db.prepare('DELETE FROM tags WHERE user_id = ? AND path = ?').run(userId, notePath);
  const insertTag = db.prepare('INSERT INTO tags (user_id, path, tag) VALUES (?, ?, ?)');
  for (const t of extractTags(content)) insertTag.run(userId, notePath, t);

  db.prepare('INSERT INTO notes_fts(rowid, title, content) SELECT id, ?, ? FROM notes WHERE user_id=? AND path=?')
    .run(title, content, userId, notePath);
}

// FTS is contentless with FTS rows keyed by notes.id (rowid = notes.id).
// These must run BEFORE the corresponding `notes` rows are deleted, so the
// subquery can still resolve the id. See B3.
export function deleteFtsNote(userId, notePath) {
  getDb()
    .prepare('DELETE FROM notes_fts WHERE rowid = (SELECT id FROM notes WHERE user_id = ? AND path = ?)')
    .run(userId, notePath);
}

export function deleteFtsUser(userId) {
  getDb()
    .prepare('DELETE FROM notes_fts WHERE rowid IN (SELECT id FROM notes WHERE user_id = ?)')
    .run(userId);
}

// One-time startup sweep: removes FTS rows whose notes row no longer exists
// (left behind by pre-fix delete paths, see B3). Safe to call on every boot.
export function cleanupOrphanFts() {
  const r = getDb()
    .prepare('DELETE FROM notes_fts WHERE rowid NOT IN (SELECT id FROM notes)')
    .run();
  if (r.changes > 0) console.log(`[fts] cleaned up ${r.changes} orphan row(s)`);
  return r.changes;
}

export async function reindexVault(userId) {
  const paths = await listNotes(userId);
  for (const p of paths) {
    try { await indexNote(userId, p); } catch { /* skip unreadable files */ }
  }
}

// The FTS table is contentless (content=''), so SQLite's snippet() can't work.
// Match + rank via FTS, then build a highlighted snippet by reading the note
// content from disk (the single source of truth).
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function queryTerms(query) {
  const stopwords = new Set(['and', 'or', 'not']);
  const terms = new Set();
  for (const m of String(query).matchAll(/[A-Za-z0-9_]+/g)) {
    const t = m[0].toLowerCase();
    if (t.length >= 2 && !stopwords.has(t)) terms.add(t);
  }
  return [...terms].sort((a, b) => b.length - a.length); // longest first
}

function wordIndexAt(starts, pos) {
  let lo = 0, hi = starts.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function buildSnippet(content, query, before = 10, after = 30) {
  const flat = String(content).replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const words = flat.split(' ');
  const starts = [];
  let off = 0;
  for (const w of words) { starts.push(off); off += w.length + 1; }

  const terms = queryTerms(query);
  const lower = flat.toLowerCase();
  let anchor = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (anchor === -1 || i < anchor)) anchor = i;
  }

  const lo = anchor === -1 ? 0 : Math.max(0, wordIndexAt(starts, anchor) - before);
  const hi = Math.min(words.length, (anchor === -1 ? 0 : wordIndexAt(starts, anchor)) + after);
  const snippet = words.slice(lo, hi).join(' ');

  const highlighted = terms.length
    ? snippet.replace(new RegExp(`\\b(${terms.map(escapeRegExp).join('|')})\\b`, 'gi'), '<mark>$1</mark>')
    : snippet;

  return (lo > 0 ? '… ' : '') + highlighted + (hi < words.length ? ' …' : '');
}

export async function searchNotes(userId, query, limit = 20) {
  let rows;
  try {
    rows = getDb().prepare(`
      SELECT n.path, n.title
      FROM notes_fts
      JOIN notes n ON notes_fts.rowid = n.id
      WHERE notes_fts MATCH ? AND n.user_id = ?
      ORDER BY rank
      LIMIT ?
    `).all(query, userId, limit);
  } catch {
    // FTS5 syntax errors (unbalanced quotes, trailing operators, etc.) — return empty
    return [];
  }
  return Promise.all(rows.map(async (row) => {
    let snippet = '';
    try {
      snippet = buildSnippet(await readNote(userId, row.path), query);
    } catch { /* file missing on disk → empty snippet */ }
    return { ...row, snippet };
  }));
}

export function getBacklinks(userId, noteTitle) {
  return getDb().prepare(`
    SELECT DISTINCT l.source_path, n.title
    FROM links l
    JOIN notes n ON n.user_id = l.user_id AND n.path = l.source_path
    WHERE l.user_id = ? AND l.target_title = ?
  `).all(userId, noteTitle);
}

export function getGraph(userId) {
  const db = getDb();

  const ownNodes = db.prepare('SELECT path, title, NULL AS notebookId FROM notes WHERE user_id = ?').all(userId);
  const ownEdges = db.prepare('SELECT source_path, target_title, label FROM links WHERE user_id = ?').all(userId);

  const sharedNodes = db.prepare(`
    SELECT n.path, n.title, MIN(nb.id) AS notebookId
    FROM notes n
    JOIN notebook_notes nn ON nn.note_path = n.path
    JOIN notebooks nb ON nb.id = nn.notebook_id
    JOIN notebook_members m ON m.notebook_id = nb.id AND m.user_id = ? AND m.accepted = 1
    GROUP BY n.path, n.title
  `).all(userId);

  const sharedEdges = db.prepare(`
    SELECT DISTINCT l.source_path, l.target_title, l.label
    FROM links l
    JOIN notebook_notes nn ON nn.note_path = l.source_path
    JOIN notebooks nb ON nb.id = nn.notebook_id
    JOIN notebook_members m ON m.notebook_id = nb.id AND m.user_id = ? AND m.accepted = 1
  `).all(userId);

  const ownPaths = new Set(ownNodes.map(n => n.path));
  const nodes = [
    ...ownNodes,
    ...sharedNodes.filter(n => !ownPaths.has(n.path)),
  ];

  const ownEdgeKeys = new Set(ownEdges.map(e => `${e.source_path}\x00${e.target_title}`));
  const edges = [
    ...ownEdges,
    ...sharedEdges.filter(e => !ownEdgeKeys.has(`${e.source_path}\x00${e.target_title}`)),
  ];

  return { nodes, edges };
}
