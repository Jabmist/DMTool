import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanupTmpVault } from './helpers.js';
import { getDb } from '../db/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let app, tmpVault, authHeader, authHeader2;

beforeAll(async () => {
  ({ app, tmpVault } = await createTestApp());

  // User 1 = admin + active (first registration)
  const r1 = await request(app).post('/api/auth/register')
    .send({ email: 'nb1@test.com', password: 'nbpassword123!' });
  authHeader = `Bearer ${r1.body.accessToken}`;

  // User 2 registers as pending
  await request(app).post('/api/auth/register')
    .send({ email: 'nb2@test.com', password: 'nbpassword456!' });

  // Admin (user 1) approves user 2
  const u2 = getDb().prepare("SELECT id FROM users WHERE email = 'nb2@test.com'").get();
  await request(app).post(`/api/admin/users/${u2.id}/approve`).set('Authorization', authHeader);

  // User 2 logs in
  const login2 = await request(app).post('/api/auth/login')
    .send({ email: 'nb2@test.com', password: 'nbpassword456!' });
  authHeader2 = `Bearer ${login2.body.accessToken}`;
});

afterAll(async () => { await cleanupTmpVault(tmpVault); });

function auth(req, hdr = authHeader) { return req.set('Authorization', hdr); }

// paths may be a plain string array (not updated) or an object array
// [{ path, updated }] (updated) — check membership either way.
function hasPath(paths, name) {
  return paths.some(p => typeof p === 'string' ? p === name : p.path === name);
}

// True only when `name` resolves to an object entry with updated === true.
// A plain string entry (notebook not "updated") counts as not-flagged.
function noteFlag(paths, name) {
  const entry = (paths ?? []).find(p => (typeof p === 'string' ? p : p.path) === name);
  if (entry === undefined || typeof entry === 'string') return false;
  return Boolean(entry.updated);
}

// Make user 2 (the "member", authHeader2) an accepted editor of nbId.
async function setMember(nbId, email, role) {
  const db = getDb();
  const u2 = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  db.prepare(`
    INSERT INTO notebook_members (notebook_id, user_id, role, invited_by, accepted)
    VALUES (?, ?, ?, 1, 1)
    ON CONFLICT(notebook_id, user_id) DO UPDATE SET
      role = excluded.role, accepted = 1
  `).run(nbId, u2.id, role);
}

describe('GET /api/notebooks', () => {
  it('returns 401 without token', async () => {
    expect((await request(app).get('/api/notebooks')).status).toBe(401);
  });

  it('returns empty list initially', async () => {
    const res = await auth(request(app).get('/api/notebooks'));
    expect(res.status).toBe(200);
    expect(res.body.notebooks).toEqual([]);
  });
});

describe('POST /api/notebooks', () => {
  it('creates a notebook and returns 201', async () => {
    const res = await auth(request(app).post('/api/notebooks').send({ name: 'Work' }));
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Work');
    expect(res.body.id).toBeTruthy();
  });

  it('appears in GET /api/notebooks', async () => {
    const res = await auth(request(app).get('/api/notebooks'));
    expect(res.body.notebooks.some(n => n.name === 'Work')).toBe(true);
  });

  it('returns 409 for duplicate name (same user)', async () => {
    const res = await auth(request(app).post('/api/notebooks').send({ name: 'Work' }));
    expect(res.status).toBe(409);
  });

  it('allows same name for different users', async () => {
    const res = await auth(request(app).post('/api/notebooks').send({ name: 'Work' }), authHeader2);
    expect(res.status).toBe(201);
  });

  it('returns 400 for missing name', async () => {
    const res = await auth(request(app).post('/api/notebooks').send({}));
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/notebooks/:id', () => {
  let nbId;
  beforeAll(async () => {
    const r = await auth(request(app).post('/api/notebooks').send({ name: 'Rename Me' }));
    nbId = r.body.id;
  });

  it('renames the notebook', async () => {
    const res = await auth(request(app).patch(`/api/notebooks/${nbId}`).send({ name: 'Renamed' }));
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
  });

  it('returns 404 for another user\'s notebook', async () => {
    const res = await auth(request(app).patch(`/api/notebooks/${nbId}`).send({ name: 'Stolen' }), authHeader2);
    expect(res.status).toBe(404);
  });
});

describe('Notebook note membership', () => {
  let nbId;
  beforeAll(async () => {
    // Create a notebook and a note for user1
    const r = await auth(request(app).post('/api/notebooks').send({ name: 'Reading' }));
    nbId = r.body.id;
    await auth(request(app).put('/api/notes/article.md').send({ content: '# Article' }));
  });

  it('GET /:id/notes returns empty initially', async () => {
    const res = await auth(request(app).get(`/api/notebooks/${nbId}/notes`));
    expect(res.status).toBe(200);
    expect(res.body.paths).toEqual([]);
  });

  it('PUT /:id/notes adds a note', async () => {
    const res = await auth(request(app).put(`/api/notebooks/${nbId}/notes`).send({ path: 'article.md' }));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /:id/notes returns the added note', async () => {
    const res = await auth(request(app).get(`/api/notebooks/${nbId}/notes`));
    expect(res.body.paths).toContain('article.md');
  });

  it('GET /for-note returns notebooks containing the note', async () => {
    const res = await auth(request(app).get('/api/notebooks/for-note?path=article.md'));
    expect(res.status).toBe(200);
    expect(res.body.notebooks.some(n => n.id === nbId)).toBe(true);
  });

  it('DELETE /:id/notes removes a note from the notebook', async () => {
    await auth(request(app).delete(`/api/notebooks/${nbId}/notes`).send({ path: 'article.md' }));
    const res = await auth(request(app).get(`/api/notebooks/${nbId}/notes`));
    expect(res.body.paths).not.toContain('article.md');
  });

  it('/for-note returns empty after removal', async () => {
    const res = await auth(request(app).get('/api/notebooks/for-note?path=article.md'));
    expect(res.body.notebooks.some(n => n.id === nbId)).toBe(false);
  });

  it('GET /for-note returns 400 without path param', async () => {
    const res = await auth(request(app).get('/api/notebooks/for-note'));
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/notebooks/:id', () => {
  it('deletes the notebook', async () => {
    const r = await auth(request(app).post('/api/notebooks').send({ name: 'Temporary' }));
    const id = r.body.id;
    const del = await auth(request(app).delete(`/api/notebooks/${id}`));
    expect(del.status).toBe(200);
    const list = await auth(request(app).get('/api/notebooks'));
    expect(list.body.notebooks.some(n => n.id === id)).toBe(false);
  });

  it('returns 404 for another user\'s notebook', async () => {
    const r = await auth(request(app).post('/api/notebooks').send({ name: 'Mine' }));
    const res = await auth(request(app).delete(`/api/notebooks/${r.body.id}`), authHeader2);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/notebooks/all-with-notes', () => {
  it('returns notebooks with their note paths', async () => {
    const nb = await auth(request(app).post('/api/notebooks').send({ name: 'AllWithNotes Test' }));
    await auth(request(app).put('/api/notes/awn-note.md').send({ content: '# AWN' }));
    await auth(request(app).put(`/api/notebooks/${nb.body.id}/notes`).send({ path: 'awn-note.md' }));
    const res = await auth(request(app).get('/api/notebooks/all-with-notes'));
    expect(res.status).toBe(200);
    const found = res.body.notebooks.find(n => n.id === nb.body.id);
    expect(found).toBeDefined();
    expect(hasPath(found.paths, 'awn-note.md')).toBe(true);
  });

  it('returns empty paths array for notebook with no notes', async () => {
    const nb = await auth(request(app).post('/api/notebooks').send({ name: 'Empty NB' }));
    const res = await auth(request(app).get('/api/notebooks/all-with-notes'));
    const found = res.body.notebooks.find(n => n.id === nb.body.id);
    expect(found.paths).toEqual([]);
  });

  it('does not return other users notebooks', async () => {
    await auth(request(app).post('/api/notebooks').send({ name: 'User1 Private' }));
    const res = await auth(request(app).get('/api/notebooks/all-with-notes'), authHeader2);
    expect(res.body.notebooks.some(n => n.name === 'User1 Private')).toBe(false);
  });
});

describe('Note deletion cleans up notebook_notes', () => {
  it('note removed from notebook when note is deleted', async () => {
    const nb = await auth(request(app).post('/api/notebooks').send({ name: 'Cleanup Test' }));
    await auth(request(app).put('/api/notes/ephemeral.md').send({ content: '# Ephemeral' }));
    await auth(request(app).put(`/api/notebooks/${nb.body.id}/notes`).send({ path: 'ephemeral.md' }));
    await auth(request(app).delete('/api/notes/ephemeral.md'));
    const res = await auth(request(app).get(`/api/notebooks/${nb.body.id}/notes`));
    expect(res.body.paths).not.toContain('ephemeral.md');
  });
});

// ── Sharing ────────────────────────────────────────────────────────────────

describe('GET /api/notebooks/invites/pending', () => {
  it('returns empty list when no invites pending', async () => {
    const res = await auth(request(app).get('/api/notebooks/invites/pending'));
    expect(res.status).toBe(200);
    expect(res.body.invites).toBeInstanceOf(Array);
  });
});

describe('Notebook member management', () => {
  let nbId;

  beforeAll(async () => {
    const r = await auth(request(app).post('/api/notebooks').send({ name: 'Shared NB' }));
    nbId = r.body.id;
    await auth(request(app).put('/api/notes/shared-note.md').send({ content: '# Shared' }));
    await auth(request(app).put(`/api/notebooks/${nbId}/notes`).send({ path: 'shared-note.md' }));
  });

  it('POST /:id/members — 404 for unknown user email', async () => {
    const res = await auth(request(app).post(`/api/notebooks/${nbId}/members`)
      .send({ email: 'nobody@nope.invalid', role: 'editor' }));
    expect(res.status).toBe(404);
  });

  it('POST /:id/members — 400 when inviting yourself', async () => {
    const res = await auth(request(app).post(`/api/notebooks/${nbId}/members`)
      .send({ email: 'nb1@test.com', role: 'editor' }));
    expect(res.status).toBe(400);
  });

  it('POST /:id/members — owner invites user 2', async () => {
    const res = await auth(request(app).post(`/api/notebooks/${nbId}/members`)
      .send({ email: 'nb2@test.com', role: 'editor' }));
    expect(res.status).toBe(200);
    expect(res.body.invited).toBe(true);
  });

  it('GET /invites/pending — user 2 sees pending invite', async () => {
    const res = await auth(request(app).get('/api/notebooks/invites/pending'), authHeader2);
    expect(res.status).toBe(200);
    expect(res.body.invites.some(i => i.notebookId === nbId)).toBe(true);
  });

  it('GET /:id/notes — user 2 cannot access before accepting', async () => {
    const res = await auth(request(app).get(`/api/notebooks/${nbId}/notes`), authHeader2);
    expect(res.status).toBe(404);
  });

  it('POST /:id/members/accept — user 2 accepts', async () => {
    const res = await auth(request(app).post(`/api/notebooks/${nbId}/members/accept`), authHeader2);
    expect(res.status).toBe(200);
  });

  it('GET /api/notebooks — user 2 sees shared notebook after accepting', async () => {
    const res = await auth(request(app).get('/api/notebooks'), authHeader2);
    expect(res.status).toBe(200);
    const nb = res.body.notebooks.find(n => n.id === nbId);
    expect(nb).toBeDefined();
    expect(nb.role).toBe('editor');
  });

  it('GET /all-with-notes — user 2 sees shared notebook notes', async () => {
    const res = await auth(request(app).get('/api/notebooks/all-with-notes'), authHeader2);
    const nb = res.body.notebooks.find(n => n.id === nbId);
    expect(nb).toBeDefined();
    expect(hasPath(nb.paths, 'shared-note.md')).toBe(true);
  });

  it('GET /:id/notes — user 2 can list notes after accepting', async () => {
    const res = await auth(request(app).get(`/api/notebooks/${nbId}/notes`), authHeader2);
    expect(res.status).toBe(200);
    expect(res.body.paths).toContain('shared-note.md');
  });

  it('GET /:id/content — user 2 can read note content', async () => {
    const res = await auth(request(app).get(`/api/notebooks/${nbId}/content/shared-note.md`), authHeader2);
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('# Shared');
  });

  it('PUT /:id/content — editor can write note content', async () => {
    const res = await auth(request(app).put(`/api/notebooks/${nbId}/content/shared-note.md`)
      .send({ content: '# Shared (edited by member)' }), authHeader2);
    expect(res.status).toBe(200);
    // Verify change is visible to owner
    const check = await auth(request(app).get(`/api/notebooks/${nbId}/content/shared-note.md`));
    expect(check.body.content).toBe('# Shared (edited by member)');
  });

  it('PUT /:id/notes — editor can add a note', async () => {
    await auth(request(app).put('/api/notes/editor-added.md').send({ content: '# By owner' }));
    const res = await auth(request(app).put(`/api/notebooks/${nbId}/notes`)
      .send({ path: 'editor-added.md' }), authHeader2);
    expect(res.status).toBe(200);
  });

  it('GET /:id/members — lists accepted member', async () => {
    const res = await auth(request(app).get(`/api/notebooks/${nbId}/members`));
    expect(res.status).toBe(200);
    const m = res.body.members.find(m => m.email === 'nb2@test.com');
    expect(m).toBeDefined();
    expect(m.accepted).toBe(1);
    expect(m.role).toBe('editor');
  });

  it('PATCH /:id/members/:userId — owner changes role to viewer', async () => {
    const { getDb } = await import('../db/index.js');
    const u2 = getDb().prepare("SELECT id FROM users WHERE email = 'nb2@test.com'").get();
    const res = await auth(request(app).patch(`/api/notebooks/${nbId}/members/${u2.id}`)
      .send({ role: 'viewer' }));
    expect(res.status).toBe(200);
  });

  it('PUT /:id/content — viewer cannot write', async () => {
    const res = await auth(request(app).put(`/api/notebooks/${nbId}/content/shared-note.md`)
      .send({ content: 'hacked' }), authHeader2);
    expect(res.status).toBe(403);
  });

  it('PUT /:id/notes — viewer cannot add note', async () => {
    const res = await auth(request(app).put(`/api/notebooks/${nbId}/notes`)
      .send({ path: 'shared-note.md' }), authHeader2);
    expect(res.status).toBe(403);
  });

  it('DELETE /:id/members/:userId — user 2 can leave (self-removal)', async () => {
    const { getDb } = await import('../db/index.js');
    const u2 = getDb().prepare("SELECT id FROM users WHERE email = 'nb2@test.com'").get();
    const res = await auth(request(app).delete(`/api/notebooks/${nbId}/members/${u2.id}`), authHeader2);
    expect(res.status).toBe(200);
  });

  it('GET /:id/notes — user 2 cannot access after leaving', async () => {
    const res = await auth(request(app).get(`/api/notebooks/${nbId}/notes`), authHeader2);
    expect(res.status).toBe(404);
  });

  it('DELETE /:id/content — non-owner cannot delete note file', async () => {
    // Re-invite and accept to set up the check
    await auth(request(app).post(`/api/notebooks/${nbId}/members`).send({ email: 'nb2@test.com', role: 'editor' }));
    await auth(request(app).post(`/api/notebooks/${nbId}/members/accept`), authHeader2);
    const res = await auth(request(app).delete(`/api/notebooks/${nbId}/content/shared-note.md`), authHeader2);
    expect(res.status).toBe(403);
  });

  it('DELETE /:id/content — owner can delete note file', async () => {
    const res = await auth(request(app).delete(`/api/notebooks/${nbId}/content/shared-note.md`));
    expect(res.status).toBe(200);
  });
});
