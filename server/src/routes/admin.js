import { Router } from 'express';
import fs from 'fs/promises';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { vaultRoot } from '../services/fileService.js';
import { deleteFtsUser } from '../services/indexService.js';
import { createBackup, restoreBackup, scheduleRestart, resolveBackupPath } from '../services/backupService.js';
import { broadcast } from '../ws/index.js';

function backupDirEnv() {
  const dir = process.env.BACKUP_DIR;
  if (!dir) throw Object.assign(new Error('BACKUP_DIR is not set'), { status: 500 });
  return dir;
}

function broadcastToAllUsers(payload) {
  const rows = getDb().prepare('SELECT id FROM users').all();
  for (const u of rows) broadcast(u.id, payload);
}

const router = Router();
router.use(requireAuth, requireAdmin);

// --- Backups (issue #19) ---------------------------------------------------
// The service throws with `status` set on the error; Express 5 forwards the
// rejection to the app-level error middleware which maps it to the right HTTP
// code (e.g. createBackup's 409 in-flight guard, 500 BACKUP_DIR unset).

router.get('/backups', (req, res) => {
  const rows = getDb()
    .prepare(`SELECT id, kind, status, path, size_bytes, file_count, error,
                     created_by_email, created_at, finished_at
             FROM backups ORDER BY created_at DESC, id DESC`)
    .all();
  res.json({ backups: rows });
});

router.post('/backups', async (req, res) => {
  const backup = await createBackup('manual', req.user.sub);
  res.status(202).json(backup);
});

router.get('/backups/:id/download', async (req, res) => {
  const row = getDb().prepare('SELECT * FROM backups WHERE id = ?').get(req.params.id) ?? null;
  if (!row) throw Object.assign(new Error('Backup not found'), { status: 404 });
  if (row.status !== 'complete') {
    throw Object.assign(new Error('Backup is not complete'), { status: 409 });
  }
  const archive = resolveBackupPath(backupDirEnv(), row);
  await fs.access(archive); // ENOENT → 500
  const name = `obsidian-${row.id}.tar.gz`;
  res.download(archive, name, (err) => { if (err && !res.headersSent) res.status(500).json({ error: 'Download failed' }); });
});

router.post('/backups/:id/restore', async (req, res) => {
  const result = await restoreBackup(req.params.id);
  // Let this response flush before the process goes down; systemd respawns it.
  res.json(result);
  broadcastToAllUsers({ type: 'backup.restore', backupId: result.backupId, message: 'A restore completed. The server is restarting — you will reconnect shortly.' });
  scheduleRestart(2000);
});

router.get('/users', (req, res) => {
  try {
    const db = getDb();
    const users = db
      .prepare('SELECT id, email, role, status, created_at, last_seen_at FROM users ORDER BY status, created_at DESC')
      .all();

    const nbCount = db.prepare(`
      SELECT COUNT(DISTINCT id) AS c FROM (
        SELECT id FROM notebooks WHERE user_id = ?
        UNION
        SELECT n.id FROM notebooks n
        JOIN notebook_members m ON m.notebook_id = n.id AND m.user_id = ? AND m.accepted = 1
      )
    `);
    const noteCount = db.prepare('SELECT COUNT(*) AS c FROM notes WHERE user_id = ?');
    const sharedCount = db.prepare(`
      SELECT COUNT(DISTINCT nn.note_path) AS c
      FROM notebook_notes nn
      JOIN notebooks n ON n.id = nn.notebook_id
      WHERE n.user_id = ?
        AND EXISTS (SELECT 1 FROM notebook_members m WHERE m.notebook_id = n.id AND m.accepted = 1)
    `);

    for (const user of users) {
      user.notebooks = nbCount.get(user.id, user.id).c;
      user.notes = noteCount.get(user.id).c;
      user.shared_notes = sharedCount.get(user.id).c;
    }

    res.json({ users });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/users/:id/approve', (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const result = getDb()
      .prepare("UPDATE users SET status = 'active' WHERE id = ? AND status = 'pending'")
      .run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'Pending user not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/users/:id/role', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { role } = req.body;
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'role must be admin or user' });
  if (id === req.user.sub) return res.status(400).json({ error: 'Cannot change your own role' });
  try {
    const result = getDb()
      .prepare('UPDATE users SET role = ? WHERE id = ?')
      .run(role, id);
    if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Announcements (issue #16) -------------------------------------------
// Single active slot. All three handlers operate on the row whose
// `replaced_at IS NULL` (the current one). Times are unix epoch seconds.

function activeAnnouncement() {
  const row = getDb()
    .prepare('SELECT id, message, start_time, end_time, created_at, replaced_at FROM announcements WHERE replaced_at IS NULL')
    .get();
  return row ?? null;
}

router.get('/announcements', (req, res) => {
  res.json({ announcement: activeAnnouncement() });
});

router.post('/announcements', (req, res) => {
  const { message, start_time, end_time } = req.body ?? {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  const start = Number(start_time);
  const end = Number(end_time);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return res.status(400).json({ error: 'start_time and end_time are required' });
  }
  if (end <= start) {
    return res.status(400).json({ error: 'end_time must be after start_time' });
  }
  const now = Math.floor(Date.now() / 1000);
  try {
    const db = getDb();
    const replaceAndInsert = db.transaction(() => {
      // Supersede any current active announcement (soft mark, keeps audit trail).
      db.prepare('UPDATE announcements SET replaced_at = ? WHERE replaced_at IS NULL').run(now);
      const info = db
        .prepare('INSERT INTO announcements (message, start_time, end_time, created_by, created_by_email) VALUES (?, ?, ?, ?, ?)')
        .run(message.trim(), start, end, req.user.sub, req.user.email);
      return info.lastInsertRowid;
    });
    const id = replaceAndInsert();
    const row = db
      .prepare('SELECT id, message, start_time, end_time, created_at, replaced_at FROM announcements WHERE id = ?')
      .get(id);
    res.status(201).json({ announcement: row });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/announcements', (req, res) => {
  try {
    const now = Math.floor(Date.now() / 1000);
    const result = getDb()
      .prepare('UPDATE announcements SET replaced_at = ? WHERE replaced_at IS NULL')
      .run(now);
    if (result.changes === 0) return res.status(404).json({ error: 'No active announcement' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/users/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.sub) return res.status(400).json({ error: 'Cannot delete your own account' });
  try {
    const db = getDb();
    // Must run before DELETE FROM users: FK cascades would remove the notes
    // rows the subquery depends on (notes_fts.rowid = notes.id).
    deleteFtsUser(id);
    // Remove this user's notebook_notes entries (rows in other people's
    // notebooks) — they point into a vault dir that no longer exists (B4).
    // Entries in the user's own notebooks cascade with the notebooks rows.
    db.prepare('DELETE FROM notebook_notes WHERE user_id = ?').run(id);
    const result = db
      .prepare('DELETE FROM users WHERE id = ?')
      .run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
    // Remove the user's vault directory from disk
    await fs.rm(vaultRoot(id), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
