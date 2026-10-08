import { Router } from 'express';
import { getDb } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import {
  ENTITY_TYPES,
  bySymbol,
  safeEntityName,
  entityPath,
  seedNotebookName,
  defaultTemplate,
} from '../entityTypes.js';
import { indexNote } from '../services/indexService.js';
import { writeNote } from '../services/fileService.js';
import { ensureSeedData } from '../services/entitySeeding.js';

const router = Router();
router.use(requireAuth);

// ── GET / — registry metadata (Q10) ───────────────────────────────────────────
// Returns the six registry entries + each user's template_id / template_name for
// that symbol. Template content is deliberately excluded (client fetches it from
// the existing /api/templates/:id endpoint).
router.get('/', (req, res) => {
  const uid = req.user.sub;
  const db = getDb();
  const tplStmt = db.prepare(
    'SELECT id, name FROM templates WHERE user_id = ? AND entity_symbol = ?'
  );
  const entityTypes = ENTITY_TYPES.map(t => {
    const tpl = tplStmt.get(uid, t.symbol);
    return {
      symbol: t.symbol,
      name: t.name,
      label: t.label,
      labelPlural: t.labelPlural,
      template_id: tpl?.id ?? null,
      template_name: tpl?.name ?? null,
    };
  });
  res.json({ entityTypes });
});

// ── GET /:symbol/notes — picker (drives the client's entity autocomplete) ─────
// Returns the user's notes where entity_symbol matches.
router.get('/:symbol/notes', (req, res) => {
  const uid = req.user.sub;
  const symbol = req.params.symbol;
  if (!bySymbol(symbol)) return res.status(404).json({ error: 'Unknown entity type' });
  try {
    const notes = getDb().prepare(
      'SELECT id, path, title, updated_at FROM notes WHERE user_id = ? AND entity_symbol = ? ORDER BY title'
    ).all(uid, symbol);
    res.json({ notes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /:symbol/template — update the user's own template content (Q7) ─────
// Only `content` is writable here; `name` stays managed via PUT /api/templates/:id.
// Owner only — scoped by user_id in the WHERE clause (no admin/permission gate).
router.put('/:symbol/template', (req, res) => {
  const uid = req.user.sub;
  const symbol = req.params.symbol;
  const { content } = req.body ?? {};
  if (content === undefined || content === null) {
    return res.status(400).json({ error: 'content is required' });
  }
  const type = bySymbol(symbol);
  if (!type) return res.status(404).json({ error: 'Unknown entity type' });

  const db = getDb();
  const row = db.prepare(
    'SELECT id, name FROM templates WHERE user_id = ? AND entity_symbol = ?'
  ).get(uid, symbol);
  if (!row) return res.status(404).json({ error: 'Template not found' });

  const info = db.prepare(
    'UPDATE templates SET content = ? WHERE id = ? AND user_id = ?'
  ).run(content, row.id, uid);
  if (info.changes === 0) return res.status(404).json({ error: 'Template not found' });

  const fresh = db.prepare(
    'SELECT id, name, content, entity_symbol, created_at FROM templates WHERE id = ?'
  ).get(row.id);
  res.json(fresh);
});

// ── POST /:symbol — create an entity note (1.5) ──────────────────────────────
// Body: { name: 'Borg the Black', content?: 'custom body' }
// Returns: 201 { path, name, symbol }
router.post('/:symbol', async (req, res) => {
  const uid = req.user.sub;
  const symbol = req.params.symbol;
  const type = bySymbol(symbol);
  if (!type) return res.status(404).json({ error: 'Unknown entity type' });

  const { name: rawName, content: customContent } = req.body ?? {};
  if (!rawName || typeof rawName !== 'string') {
    return res.status(400).json({ error: 'name is required' });
  }

  // Safety: sanitize (Q5). Reject if forbidden chars present.
  const safeName = safeEntityName(rawName.trim());
  if (!safeName) {
    return res.status(400).json({ error: 'name contains forbidden characters' });
  }

  // Seeding is cheap + idempotent (Q9); call before any DB reads.
  ensureSeedData(uid);

  const db = getDb();

  // Strict dup check (Q6): any note with this title → 409.
  const dup = db.prepare(
    'SELECT 1 FROM notes WHERE user_id = ? AND title = ?'
  ).get(uid, safeName);
  if (dup) {
    return res.status(409).json({ error: 'A note with this title already exists.' });
  }

  // Build note body: frontmatter + template body (or caller-supplied content).
  const body = customContent !== undefined && customContent !== null
    ? String(customContent)
    : (defaultTemplate(type.name, symbol) ?? '');
  const fullContent = `---\nentity: ${symbol}\n---\n\n${body}\n`;

  const notePath = entityPath(type, safeName);

  // 404 if the file already exists (a note with the *path* already exists,
  // e.g. a plain file at the same path). This is a distinct guard from the
  // title check above (the title check uses the notes table).
  const pathDup = db.prepare(
    'SELECT 1 FROM notes WHERE user_id = ? AND path = ?'
  ).get(uid, notePath);
  if (pathDup) {
    return res.status(409).json({ error: 'A note at this path already exists.' });
  }

  try {
    await writeNote(uid, notePath, fullContent);
    await indexNote(uid, notePath, uid);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create entity note' });
  }

  // File the note into that type's seed notebook (idempotent via UNIQUE(user_id,name)).
  const nbName = seedNotebookName(type.label);
  const nb = db.prepare(
    'SELECT id FROM notebooks WHERE user_id = ? AND name = ?'
  ).get(uid, nbName);
  if (nb) {
    db.prepare(
      'INSERT OR IGNORE INTO notebook_notes (notebook_id, user_id, note_path) VALUES (?, ?, ?)'
    ).run(nb.id, uid, notePath);
  }

  res.status(201).json({ path: notePath, name: safeName, symbol });
});

export default router;
