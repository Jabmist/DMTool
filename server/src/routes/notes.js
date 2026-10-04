import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { requireAuth } from '../middleware/auth.js';
import { readNote, writeNote, deleteNote, listNotes, safePath } from '../services/fileService.js';
import { indexNote, searchNotes, getBacklinks, getGraph, deleteFtsNote } from '../services/indexService.js';
import { getDb } from '../db/index.js';
import { broadcastToNotebook } from '../ws/index.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const paths = await listNotes(req.user.sub);
    res.json({ paths });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    res.json({ results: await searchNotes(req.user.sub, q) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/graph', (req, res) => {
  try {
    res.json(getGraph(req.user.sub));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/backlinks', (req, res) => {
  const { title } = req.query;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    res.json({ backlinks: getBacklinks(req.user.sub, title) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/resolve', (req, res) => {
  const { title } = req.query;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const note = getDb()
      .prepare('SELECT path FROM notes WHERE user_id = ? AND title = ? LIMIT 1')
      .get(req.user.sub, title);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    res.json({ path: note.path });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function notePath(req) {
  return Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
}

router.get('/*path', async (req, res) => {
  try {
    const content = await readNote(req.user.sub, notePath(req));
    res.json({ content });
  } catch (e) {
    const status = e.status ?? 404;
    res.status(status).json({ error: status < 500 ? e.message : 'Internal server error' });
  }
});

router.put('/*path', async (req, res) => {
  const { content } = req.body ?? {};
  if (content === undefined) return res.status(400).json({ error: 'content required' });
  try {
    const p = notePath(req);
    await writeNote(req.user.sub, p, content);
    // Attribute the write to the acting user (the private PUT means the owner).
    await indexNote(req.user.sub, p, req.user.sub);
    const nbs = getDb().prepare('SELECT notebook_id FROM notebook_notes WHERE note_path = ? AND user_id = ?').all(p, req.user.sub);
    for (const nb of nbs) {
      broadcastToNotebook(nb.notebook_id, { type: 'note:updated', notebookId: nb.notebook_id, path: p }, req.user.sub);
    }
    res.json({ ok: true });
  } catch (e) {
    const status = e.status ?? 500;
    res.status(status).json({ error: status < 500 ? e.message : 'Internal server error' });
  }
});

router.patch('/*path', async (req, res) => {
  const { newPath } = req.body ?? {};
  if (!newPath) return res.status(400).json({ error: 'newPath required' });
  if (!newPath.endsWith('.md')) return res.status(400).json({ error: 'newPath must end with .md' });

  try {
    const oldP = notePath(req);
    if (oldP === newPath) return res.json({ ok: true, newPath });

    const oldFull = safePath(req.user.sub, oldP);
    const newFull = safePath(req.user.sub, newPath);

    // Reject if destination already exists
    await fs.access(newFull).then(() => {
      throw Object.assign(new Error('A note with that name already exists'), { status: 409 });
    }, () => {});

    await fs.mkdir(path.dirname(newFull), { recursive: true });
    await fs.rename(oldFull, newFull);

    const db = getDb();
    const oldTitle = path.basename(oldP, '.md');
    const newTitle = path.basename(newPath, '.md');

    db.prepare('UPDATE notes SET path=?, title=?, updated_at=unixepoch(), last_edited_by=? WHERE user_id=? AND path=?')
      .run(newPath, newTitle, req.user.sub, req.user.sub, oldP);
    db.prepare('UPDATE links SET source_path=? WHERE user_id=? AND source_path=?')
      .run(newPath, req.user.sub, oldP);
    db.prepare('UPDATE tags SET path=? WHERE user_id=? AND path=?')
      .run(newPath, req.user.sub, oldP);
    db.prepare(`UPDATE notebook_notes SET note_path=?
      WHERE note_path=? AND notebook_id IN (SELECT id FROM notebooks WHERE user_id=?)`)
      .run(newPath, oldP, req.user.sub);

    // Update [[OldTitle]] and [[OldTitle|alias]] wikilinks in every note that links here
    const toReindex = new Set([newPath]);
    if (oldTitle !== newTitle) {
      const escaped = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const linkRe  = new RegExp(`\\[\\[${escaped}(\\|[^\\]]*)?\\]\\]`, 'g');
      const linkers = db
        .prepare('SELECT DISTINCT source_path FROM links WHERE user_id=? AND target_title=?')
        .all(req.user.sub, oldTitle);
      for (const { source_path } of linkers) {
        try {
          const content = await readNote(req.user.sub, source_path);
          const updated = content.replace(linkRe, (_, alias) => `[[${newTitle}${alias ?? ''}]]`);
          if (updated !== content) await writeNote(req.user.sub, source_path, updated);
          toReindex.add(source_path);
        } catch { /* skip unreadable notes */ }
      }
    }

    for (const p of toReindex) await indexNote(req.user.sub, p).catch(() => {});
    res.json({ ok: true, newPath, linksUpdated: toReindex.size - 1 });
  } catch (e) {
    const status = e.status ?? 500;
    res.status(status).json({ error: status < 500 ? e.message : 'Internal server error' });
  }
});

router.delete('/*path', async (req, res) => {
  try {
    const p = notePath(req);
    await deleteNote(req.user.sub, p);
    const db = getDb();
    // FTS row must be removed while the notes row still exists (rowid = notes.id)
    deleteFtsNote(req.user.sub, p);
    db.prepare('DELETE FROM notes WHERE user_id = ? AND path = ?').run(req.user.sub, p);
    db.prepare('DELETE FROM links WHERE user_id = ? AND source_path = ?').run(req.user.sub, p);
    db.prepare('DELETE FROM tags WHERE user_id = ? AND path = ?').run(req.user.sub, p);
    db.prepare(`DELETE FROM notebook_notes WHERE note_path=?
      AND notebook_id IN (SELECT id FROM notebooks WHERE user_id=?)`)
      .run(p, req.user.sub);
    res.json({ ok: true });
  } catch (e) {
    const status = e.status ?? 500;
    res.status(status).json({ error: status < 500 ? e.message : 'Internal server error' });
  }
});

export default router;
