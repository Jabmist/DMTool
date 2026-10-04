import { getDb } from '../db/index.js';

export function recordSignon(userId) {
  const db = getDb();
  db.prepare('INSERT INTO signons (user_id) VALUES (?)').run(userId);
  db.prepare('UPDATE users SET last_seen_at = unixepoch() WHERE id = ?').run(userId);
}
