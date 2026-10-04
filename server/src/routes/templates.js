import { Router } from 'express';
import { getDb } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, name, created_at FROM templates WHERE user_id = ? ORDER BY name'
  ).all(req.user.sub);
  res.json({ templates: rows });
});

router.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare(
    'SELECT id, name, content FROM templates WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.sub);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/', (req, res) => {
  const { name, content = '' } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const db = getDb();
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO templates (user_id, name, content) VALUES (?, ?, ?)'
  ).run(req.user.sub, name.trim(), content);
  const row = db.prepare('SELECT id, name, created_at FROM templates WHERE id = ?').get(lastInsertRowid);
  res.status(201).json(row);
});

router.put('/:id', (req, res) => {
  const { name, content = '' } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const db = getDb();
  const info = db.prepare(
    'UPDATE templates SET name = ?, content = ? WHERE id = ? AND user_id = ?'
  ).run(name.trim(), content, req.params.id, req.user.sub);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  const row = db.prepare('SELECT id, name, content FROM templates WHERE id = ?').get(req.params.id);
  res.json(row);
});

router.delete('/:id', (req, res) => {
  const db = getDb();
  const info = db.prepare(
    'DELETE FROM templates WHERE id = ? AND user_id = ?'
  ).run(req.params.id, req.user.sub);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

export default router;
