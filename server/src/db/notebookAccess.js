import { getDb } from './index.js';

// Returns { notebookId, ownerId, role } or null if the user has no access.
// role is 'owner' | 'editor' | 'viewer'.
export function getNotebookAccess(notebookId, userId) {
  const db = getDb();
  const nb = db.prepare('SELECT id, user_id FROM notebooks WHERE id = ?').get(notebookId);
  if (!nb) return null;
  if (nb.user_id === userId) return { notebookId: nb.id, ownerId: nb.user_id, role: 'owner' };
  const member = db
    .prepare('SELECT role FROM notebook_members WHERE notebook_id = ? AND user_id = ? AND accepted = 1')
    .get(notebookId, userId);
  if (!member) return null;
  return { notebookId: nb.id, ownerId: nb.user_id, role: member.role };
}

export function getNotebookMemberIds(notebookId) {
  return getDb()
    .prepare('SELECT user_id FROM notebook_members WHERE notebook_id = ? AND accepted = 1')
    .all(notebookId)
    .map(r => r.user_id);
}
