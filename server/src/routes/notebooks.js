import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { deleteNote, readNote, writeNote } from '../services/fileService.js';
import { indexNote, deleteFtsNote } from '../services/indexService.js';
import { getNotebookAccess } from '../db/notebookAccess.js';
import { broadcastToNotebook } from '../ws/index.js';
import { SEED_NOTEBOOK_NAMES } from '../entityTypes.js';

const router = Router();
router.use(requireAuth);

// Security (finding #1): notebook content endpoints must only touch notes
// that are explicitly part of the notebook (a `notebook_notes` row). Owners
// can access any note in their own vault — members can only touch notes the
// owner added to the notebook.
function notebookContains(notebookId, notePath) {
  const row = getDb()
    .prepare('SELECT 1 AS x FROM notebook_notes WHERE notebook_id = ? AND note_path = ?')
    .get(notebookId, notePath);
  return row !== undefined;
}

const SHARED_NOTEBOOKS_UNION = `
  SELECT id, name, user_id AS ownerId, 'owner' AS role FROM notebooks WHERE user_id = ?
  UNION
  SELECT n.id, n.name, n.user_id AS ownerId, m.role
  FROM notebooks n
  JOIN notebook_members m ON m.notebook_id = n.id AND m.user_id = ? AND m.accepted = 1
  ORDER BY name
`;

router.get('/', (req, res) => {
  try {
    const uid = req.user.sub;
    const notebooks = getDb().prepare(SHARED_NOTEBOOKS_UNION).all(uid, uid);
    res.json({ notebooks });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal server error' });
  }
});

// Must be defined before /:id routes so 'invites' is not captured as :id
router.get('/invites/pending', (req, res) => {
  try {
    const rows = getDb().prepare(`
      SELECT m.notebook_id AS notebookId, n.name, u.email AS invitedByEmail, m.role,
             m.invited_at AS invitedAt
      FROM notebook_members m
      JOIN notebooks n ON n.id = m.notebook_id
      JOIN users u ON u.id = m.invited_by
      WHERE m.user_id = ? AND m.accepted = 0
      ORDER BY m.invited_at DESC
    `).all(req.user.sub);
    res.json({ invites: rows });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', (req, res) => {
  const { name } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  try {
    const result = getDb()
      .prepare('INSERT INTO notebooks (user_id, name) VALUES (?, ?)')
      .run(req.user.sub, name.trim());
    res.status(201).json({ id: result.lastInsertRowid, name: name.trim(), role: 'owner', ownerId: req.user.sub });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Notebook name already exists' });
    console.error(e); res.status(500).json({ error: 'Internal server error' });
  }
});

// Must be before /:id routes
router.get('/for-note', (req, res) => {
  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'path required' });
  try {
    const uid = req.user.sub;
    const notebooks = getDb().prepare(`
      SELECT DISTINCT n.id, n.name FROM notebooks n
      JOIN notebook_notes nn ON nn.notebook_id = n.id
      LEFT JOIN notebook_members m ON m.notebook_id = n.id AND m.user_id = ?
      WHERE nn.note_path = ?
        AND (n.user_id = ? OR (m.user_id = ? AND m.accepted = 1))
      ORDER BY n.name
    `).all(uid, path, uid, uid);
    res.json({ notebooks });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal server error' });
  }
});

// Must be before /:id routes
router.get('/all-with-notes', (req, res) => {
  try {
    const db = getDb();
    const uid = req.user.sub;
    const notebooks = db.prepare(SHARED_NOTEBOOKS_UNION).all(uid, uid);

    for (const nb of notebooks) {
      const strPaths = db
        .prepare('SELECT note_path FROM notebook_notes WHERE notebook_id = ? ORDER BY note_path')
        .all(nb.id)
        .map(r => r.note_path);

      // "Updated" dots only make sense on notebooks shared with at least one
      // other accepted member — a private notebook has no second party to
      // notify, so it stays plain string paths. A note is flagged when it
      // changed after this user last opened it, EXCEPT notes this user last
      // edited (no self-dots). That way an owner sees a member's edits, a
      // member sees the owner's, and neither is dotted for their own changes.
      const memberCount = db
        .prepare('SELECT COUNT(*) AS c FROM notebook_members WHERE notebook_id = ? AND accepted = 1')
        .get(nb.id).c;
      if (memberCount > 0 && strPaths.length) {
        const noteSeen = db
          .prepare('SELECT note_path, last_seen_at FROM notebook_note_seen WHERE notebook_id = ? AND user_id = ?')
          .all(nb.id, uid);
        const noteSeenMap = new Map(noteSeen.map(r => [r.note_path, r.last_seen_at]));
        const noteRows = db
          .prepare('SELECT path, updated_at, last_edited_by FROM notes WHERE user_id = ? AND path IN (' +
            strPaths.map(() => '?').join(',') + ')')
          .all(nb.ownerId, ...strPaths);
        const noteInfoMap = new Map(noteRows.map(r => [r.path, r]));
        nb.paths = strPaths.map(p => {
          const info = noteInfoMap.get(p);
          const changedSinceSeen = (info?.updated_at ?? 0) > (noteSeenMap.get(p) ?? 0);
          const selfEdited = info != null && info.last_edited_by === uid;
          return { path: p, updated: selfEdited ? false : changedSinceSeen };
        });
      } else {
        nb.paths = strPaths;
      }
    }
    res.json({ notebooks });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  try {
    const db = getDb();
    const existing = db.prepare('SELECT name FROM notebooks WHERE id = ? AND user_id = ?')
      .get(id, req.user.sub);
    if (!existing) return res.status(404).json({ error: 'Notebook not found' });
    // Q3 / 1.8b: the six seed entity notebooks are rename-protected.
    if (SEED_NOTEBOOK_NAMES.has(existing.name)) {
      return res.status(409).json({ error: 'This is a required entity notebook and cannot be renamed.' });
    }
    const result = db
      .prepare('UPDATE notebooks SET name = ? WHERE id = ? AND user_id = ?')
      .run(name.trim(), id, req.user.sub);
    if (result.changes === 0) return res.status(404).json({ error: 'Notebook not found' });
    res.json({ id, name: name.trim() });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Notebook name already exists' });
    console.error(e); res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deleteNotes = req.query.deleteNotes === 'true';
  const db = getDb();
  try {
    const notebook = db.prepare('SELECT 1 FROM notebooks WHERE id = ? AND user_id = ?').get(id, req.user.sub);
    if (!notebook) return res.status(404).json({ error: 'Notebook not found' });

    if (deleteNotes) {
      const paths = db
        .prepare('SELECT note_path FROM notebook_notes WHERE notebook_id = ?')
        .all(id)
        .map(r => r.note_path);
      for (const notePath of paths) {
        try {
          await deleteNote(req.user.sub, notePath);
          // FTS row must be removed while the notes row still exists (rowid = notes.id)
          deleteFtsNote(req.user.sub, notePath);
          db.prepare('DELETE FROM notes WHERE user_id = ? AND path = ?').run(req.user.sub, notePath);
        } catch { /* file already gone — continue */ }
      }
    }

    db.prepare('DELETE FROM notebooks WHERE id = ? AND user_id = ?').run(id, req.user.sub);
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/notes', (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const access = getNotebookAccess(id, req.user.sub);
    if (!access) return res.status(404).json({ error: 'Notebook not found' });
    const rows = getDb()
      .prepare('SELECT note_path FROM notebook_notes WHERE notebook_id = ? ORDER BY note_path')
      .all(id);
    res.json({ paths: rows.map(r => r.note_path) });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/seen', (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const db = getDb();
    const access = getNotebookAccess(id, req.user.sub);
    if (!access) return res.status(404).json({ error: 'Notebook not found' });
    const { notePaths } = req.body ?? {};
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare('INSERT INTO notebook_note_seen (notebook_id, user_id, note_path, last_seen_at) VALUES (?,?,?,?) ON CONFLICT(notebook_id, user_id, note_path) DO UPDATE SET last_seen_at = excluded.last_seen_at');
    if (Array.isArray(notePaths) && notePaths.length) {
      for (const p of notePaths) stmt.run(id, req.user.sub, p, now);
    } else {
      for (const r of db.prepare('SELECT note_path FROM notebook_notes WHERE notebook_id = ?').all(id)) stmt.run(id, req.user.sub, r.note_path, now);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id/notes', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { path } = req.body ?? {};
  if (!path) return res.status(400).json({ error: 'path required' });
  try {
    const access = getNotebookAccess(id, req.user.sub);
    if (!access) return res.status(404).json({ error: 'Notebook not found' });
    if (access.role === 'viewer') return res.status(403).json({ error: 'Read-only access' });
    getDb()
      .prepare('INSERT OR IGNORE INTO notebook_notes (notebook_id, user_id, note_path) VALUES (?, ?, ?)')
      .run(id, req.user.sub, path);
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id/notes', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { path } = req.body ?? {};
  if (!path) return res.status(400).json({ error: 'path required' });
  try {
    const access = getNotebookAccess(id, req.user.sub);
    if (!access) return res.status(404).json({ error: 'Notebook not found' });
    if (access.role === 'viewer') return res.status(403).json({ error: 'Read-only access' });
    getDb()
      .prepare('DELETE FROM notebook_notes WHERE notebook_id = ? AND note_path = ?')
      .run(id, path);
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Member management ──────────────────────────────────────────────────────

router.get('/:id/members', (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const access = getNotebookAccess(id, req.user.sub);
    if (!access) return res.status(404).json({ error: 'Notebook not found' });
    const members = getDb().prepare(`
      SELECT m.user_id AS userId, u.email, m.role, m.accepted, m.invited_at AS invitedAt
      FROM notebook_members m
      JOIN users u ON u.id = m.user_id
      WHERE m.notebook_id = ?
      ORDER BY m.invited_at
    `).all(id);
    res.json({ members });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/members', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { email, role = 'editor' } = req.body ?? {};
  if (!email) return res.status(400).json({ error: 'email required' });
  if (!['editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'role must be editor or viewer' });
  try {
    const db = getDb();
    const nb = db.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ?').get(id, req.user.sub);
    if (!nb) return res.status(404).json({ error: 'Notebook not found' });
    const target = db.prepare("SELECT id FROM users WHERE email = ? AND status = 'active'").get(email);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.id === req.user.sub) return res.status(400).json({ error: 'Cannot invite yourself' });
    db.prepare(`
      INSERT OR IGNORE INTO notebook_members (notebook_id, user_id, role, invited_by)
      VALUES (?, ?, ?, ?)
    `).run(id, target.id, role, req.user.sub);
    res.json({ invited: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id/members/:userId', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const targetId = parseInt(req.params.userId, 10);
  const { role } = req.body ?? {};
  if (!['editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'role must be editor or viewer' });
  try {
    const db = getDb();
    const nb = db.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ?').get(id, req.user.sub);
    if (!nb) return res.status(404).json({ error: 'Notebook not found' });
    const result = db
      .prepare('UPDATE notebook_members SET role = ? WHERE notebook_id = ? AND user_id = ?')
      .run(role, id, targetId);
    if (result.changes === 0) return res.status(404).json({ error: 'Member not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id/members/:userId', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const targetId = parseInt(req.params.userId, 10);
  try {
    const db = getDb();
    const isSelf = targetId === req.user.sub;
    if (!isSelf) {
      const nb = db.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ?').get(id, req.user.sub);
      if (!nb) return res.status(403).json({ error: 'Only the notebook owner can remove members' });
    } else {
      const nb = db.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ?').get(id, req.user.sub);
      if (nb) return res.status(400).json({ error: 'Owner cannot leave their own notebook' });
    }
    const result = db
      .prepare('DELETE FROM notebook_members WHERE notebook_id = ? AND user_id = ?')
      .run(id, targetId);
    if (result.changes === 0) return res.status(404).json({ error: 'Member not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/members/accept has a different method from PATCH/DELETE /:id/members/:userId so no conflict
router.post('/:id/members/accept', (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const result = getDb().prepare(`
      UPDATE notebook_members SET accepted = 1, accepted_at = unixepoch()
      WHERE notebook_id = ? AND user_id = ? AND accepted = 0
    `).run(id, req.user.sub);
    if (result.changes === 0) return res.status(404).json({ error: 'No pending invite found' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Notebook-scoped note content (members access owner's vault through these) ──

function noteContentPath(req) {
  return Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
}

router.get('/:id/content/*path', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const access = getNotebookAccess(id, req.user.sub);
    if (!access) return res.status(404).json({ error: 'Notebook not found' });
    const notePath = noteContentPath(req);
    // Members can only read notes that are part of the notebook; owners
    // can read their own vault via the /api/notes route instead.
    if (access.role !== 'owner' && !notebookContains(id, notePath)) {
      return res.status(404).json({ error: 'Note not found' });
    }
    const content = await readNote(access.ownerId, notePath);
    res.json({ content });
  } catch (e) {
    const status = e.status ?? 404;
    res.status(status).json({ error: status < 500 ? e.message : 'Internal server error' });
  }
});

router.put('/:id/content/*path', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { content } = req.body ?? {};
  if (content === undefined) return res.status(400).json({ error: 'content required' });
  try {
    const access = getNotebookAccess(id, req.user.sub);
    if (!access) return res.status(404).json({ error: 'Notebook not found' });
    if (access.role === 'viewer') return res.status(403).json({ error: 'Read-only access' });
    const notePath = noteContentPath(req);
    // Members can only write notes that are part of the notebook; owners
    // can write their own vault via the /api/notes route instead.
    if (access.role !== 'owner' && !notebookContains(id, notePath)) {
      return res.status(404).json({ error: 'Note not found' });
    }
    await writeNote(access.ownerId, notePath, content);
    // Record who wrote this version (a member, or the owner themselves) so the
    // "updated" dot can be suppressed for that user but shown to the others.
    await indexNote(access.ownerId, notePath, req.user.sub);
    broadcastToNotebook(id, { type: 'note:updated', notebookId: id, path: notePath }, req.user.sub);
    res.json({ ok: true });
  } catch (e) {
    const status = e.status ?? 500;
    res.status(status).json({ error: status < 500 ? e.message : 'Internal server error' });
  }
});

router.delete('/:id/content/*path', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const access = getNotebookAccess(id, req.user.sub);
    if (!access) return res.status(404).json({ error: 'Notebook not found' });
    if (access.role !== 'owner') return res.status(403).json({ error: 'Only the notebook owner can delete notes' });
    const notePath = noteContentPath(req);
    const db = getDb();
    // Only owners can reach here — verify the note is in this notebook.
    if (!notebookContains(id, notePath)) {
      return res.status(404).json({ error: 'Note not found' });
    }
    await deleteNote(access.ownerId, notePath);
    // FTS row must be removed while the notes row still exists (rowid = notes.id)
    deleteFtsNote(access.ownerId, notePath);
    db.prepare('DELETE FROM notes WHERE user_id = ? AND path = ?').run(access.ownerId, notePath);
    db.prepare('DELETE FROM links WHERE user_id = ? AND source_path = ?').run(access.ownerId, notePath);
    db.prepare('DELETE FROM tags WHERE user_id = ? AND path = ?').run(access.ownerId, notePath);
    db.prepare('DELETE FROM notebook_notes WHERE notebook_id = ? AND note_path = ?').run(id, notePath);
    broadcastToNotebook(id, { type: 'note:deleted', notebookId: id, path: notePath }, req.user.sub);
    res.json({ ok: true });
  } catch (e) {
    const status = e.status ?? 500;
    res.status(status).json({ error: status < 500 ? e.message : 'Internal server error' });
  }
});

export default router;
