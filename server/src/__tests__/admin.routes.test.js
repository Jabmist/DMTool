import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanupTmpVault } from './helpers.js';

vi.mock('bcrypt', () => ({
  default: {
    hash:    async (p) => `hashed:${p}`,
    compare: async (p, h) => h === `hashed:${p}`,
  },
}));

let app, tmpVault, adminHeader, pendingId;

beforeAll(async () => {
  ({ app, tmpVault } = await createTestApp());

  // First registration = admin+active
  const r = await request(app).post('/api/auth/register')
    .send({ email: 'admin@test.com', password: 'adminpassword123' });
  adminHeader = `Bearer ${r.body.accessToken}`;

  // Register a second user (pending)
  const p = await request(app).post('/api/auth/register')
    .send({ email: 'waiting@test.com', password: 'waitingpassword123' });
  expect(p.body.pending).toBe(true);

  // Register a third user (also pending, used for deletion tests)
  await request(app).post('/api/auth/register')
    .send({ email: 'todelete@test.com', password: 'deletepassword123' });

  const { getDb } = await import('../db/index.js');
  pendingId = getDb().prepare("SELECT id FROM users WHERE email = 'waiting@test.com'").get().id;
});

afterAll(async () => { await cleanupTmpVault(tmpVault); });

describe('GET /api/admin/users', () => {
  it('returns 401 without token', async () => {
    expect((await request(app).get('/api/admin/users')).status).toBe(401);
  });

  it('returns 403 for non-admin user', async () => {
    // Approve waiting@test.com so it can log in, then test it can't hit admin
    const { getDb } = await import('../db/index.js');
    const uid = getDb().prepare("SELECT id FROM users WHERE email='waiting@test.com'").get().id;
    await request(app).post(`/api/admin/users/${uid}/approve`).set('Authorization', adminHeader);
    const login = await request(app).post('/api/auth/login')
      .send({ email: 'waiting@test.com', password: 'waitingpassword123' });
    const userHeader = `Bearer ${login.body.accessToken}`;
    const res = await request(app).get('/api/admin/users').set('Authorization', userHeader);
    expect(res.status).toBe(403);
  });

  it('returns all users for admin', async () => {
    const res = await request(app).get('/api/admin/users').set('Authorization', adminHeader);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
    expect(res.body.users.some(u => u.email === 'admin@test.com')).toBe(true);
  });

  it('includes status field for each user', async () => {
    const res = await request(app).get('/api/admin/users').set('Authorization', adminHeader);
    res.body.users.forEach(u => expect(['pending', 'active', 'suspended']).toContain(u.status));
  });

  it('does not expose password hashes', async () => {
    const res = await request(app).get('/api/admin/users').set('Authorization', adminHeader);
    res.body.users.forEach(u => expect(u.password).toBeUndefined());
  });

  it('includes last_seen_at (issue #6 telemetry)', async () => {
    const res = await request(app).get('/api/admin/users').set('Authorization', adminHeader);
    expect(res.status).toBe(200);
    res.body.users.forEach(u => expect('last_seen_at' in u).toBe(true));
  });
});

describe('POST /api/admin/users/:id/approve', () => {
  it('approves a pending user', async () => {
    const { getDb } = await import('../db/index.js');
    const deleteId = getDb().prepare("SELECT id FROM users WHERE email='todelete@test.com'").get().id;
    const res = await request(app).post(`/api/admin/users/${deleteId}/approve`).set('Authorization', adminHeader);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const user = getDb().prepare('SELECT status FROM users WHERE id=?').get(deleteId);
    expect(user.status).toBe('active');
  });

  it('approved user can now log in', async () => {
    const login = await request(app).post('/api/auth/login')
      .send({ email: 'todelete@test.com', password: 'deletepassword123' });
    expect(login.status).toBe(200);
    expect(login.body.accessToken).toBeTruthy();
  });

  it('returns 404 for already-active user', async () => {
    const res = await request(app).post(`/api/admin/users/${pendingId}/approve`).set('Authorization', adminHeader);
    // pendingId was already approved in a previous test — should now be 404
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/admin/users/:id/role', () => {
  let targetId;

  beforeAll(async () => {
    const { getDb } = await import('../db/index.js');
    targetId = getDb().prepare("SELECT id FROM users WHERE email='waiting@test.com'").get().id;
  });

  it('promotes a user to admin', async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${targetId}/role`)
      .set('Authorization', adminHeader)
      .send({ role: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const { getDb } = await import('../db/index.js');
    const u = getDb().prepare('SELECT role FROM users WHERE id=?').get(targetId);
    expect(u.role).toBe('admin');
  });

  it('demotes an admin to user', async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${targetId}/role`)
      .set('Authorization', adminHeader)
      .send({ role: 'user' });
    expect(res.status).toBe(200);
    const { getDb } = await import('../db/index.js');
    const u = getDb().prepare('SELECT role FROM users WHERE id=?').get(targetId);
    expect(u.role).toBe('user');
  });

  it('rejects invalid role value', async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${targetId}/role`)
      .set('Authorization', adminHeader)
      .send({ role: 'superuser' });
    expect(res.status).toBe(400);
  });

  it('prevents admin from changing their own role', async () => {
    const { getDb } = await import('../db/index.js');
    const selfId = getDb().prepare("SELECT id FROM users WHERE email='admin@test.com'").get().id;
    const res = await request(app)
      .patch(`/api/admin/users/${selfId}/role`)
      .set('Authorization', adminHeader)
      .send({ role: 'user' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown user', async () => {
    const res = await request(app)
      .patch('/api/admin/users/99999/role')
      .set('Authorization', adminHeader)
      .send({ role: 'admin' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/admin/users/:id', () => {
  it('removes a user', async () => {
    const { getDb } = await import('../db/index.js');
    const delId = getDb().prepare("SELECT id FROM users WHERE email='todelete@test.com'").get().id;
    const res = await request(app).delete(`/api/admin/users/${delId}`).set('Authorization', adminHeader);
    expect(res.status).toBe(200);
    const gone = getDb().prepare('SELECT id FROM users WHERE id=?').get(delId);
    expect(gone).toBeUndefined();
  });

  it('returns 400 when admin tries to delete themselves', async () => {
    const { getDb } = await import('../db/index.js');
    const selfId = getDb().prepare("SELECT id FROM users WHERE email='admin@test.com'").get().id;
    const res = await request(app).delete(`/api/admin/users/${selfId}`).set('Authorization', adminHeader);
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown user id', async () => {
    const res = await request(app).delete('/api/admin/users/99999').set('Authorization', adminHeader);
    expect(res.status).toBe(404);
  });

  it('removes that user\u2019s FTS rows when the user is deleted (B3)', async () => {
    const { getDb } = await import('../db/index.js');
    const db = getDb();

    // Register a fresh user with an indexed note
    const r = await request(app).post('/api/auth/register')
      .send({ email: 'ftsuser@test.com', password: 'ftsdeletepassword1' });
    const uid = db.prepare("SELECT id FROM users WHERE email = 'ftsuser@test.com'").get().id;
    await request(app).post(`/api/admin/users/${uid}/approve`).set('Authorization', adminHeader);
    const login = await request(app).post('/api/auth/login')
      .send({ email: 'ftsuser@test.com', password: 'ftsdeletepassword1' });
    const hdr = `Bearer ${login.body.accessToken}`;

    await request(app).put('/api/notes/ftsvictim.md').set('Authorization', hdr).send({ content: 'quantum banana zebra' });
    expect(db.prepare('SELECT id FROM notes WHERE user_id = ? AND path = ?').get(uid, 'ftsvictim.md')).toBeDefined();

    const orphans = () => db.prepare('SELECT COUNT(*) AS n FROM notes_fts WHERE rowid NOT IN (SELECT id FROM notes)').get().n;
    expect(orphans()).toBe(0);

    const del = await request(app).delete(`/api/admin/users/${uid}`).set('Authorization', adminHeader);
    expect(del.status).toBe(200);

    expect(db.prepare('SELECT id FROM users WHERE id = ?').get(uid)).toBeUndefined();
    expect(orphans()).toBe(0);
  });

  it('deletes a user who has invited someone (B4: invited_by no longer blocks)', async () => {
    const { getDb } = await import('../db/index.js');
    const db = getDb();
    const inviterId = db.prepare("SELECT id FROM users WHERE email='waiting@test.com'").get().id;

    const login = await request(app).post('/api/auth/login')
      .send({ email: 'waiting@test.com', password: 'waitingpassword123' });
    const hdr = `Bearer ${login.body.accessToken}`;

    // Inviter's own notebook, with a note, plus an accepted invitee
    const nb = await request(app).post('/api/notebooks').set('Authorization', hdr).send({ name: 'B4 NB' });
    const nbId = nb.body.id;
    await request(app).put('/api/notes/b4note.md').set('Authorization', hdr).send({ content: '# B4' });
    await request(app).put(`/api/notebooks/${nbId}/notes`).set('Authorization', hdr).send({ path: 'b4note.md' });

    await request(app).post('/api/auth/register')
      .send({ email: 'b4invitee@test.com', password: 'b4inviteepass1' });
    const inviteeId = db.prepare("SELECT id FROM users WHERE email='b4invitee@test.com'").get().id;
    await request(app).post(`/api/admin/users/${inviteeId}/approve`).set('Authorization', adminHeader);
    const inv = await request(app).post(`/api/notebooks/${nbId}/members`)
      .set('Authorization', hdr).send({ email: 'b4invitee@test.com', role: 'editor' });
    expect(inv.status).toBe(200);
    expect(db.prepare('SELECT invited_by FROM notebook_members WHERE notebook_id = ? AND user_id = ?').get(nbId, inviteeId).invited_by).toBe(inviterId);

    // Previously 500: FOREIGN KEY constraint failed on invited_by (RESTRICT)
    const del = await request(app).delete(`/api/admin/users/${inviterId}`).set('Authorization', adminHeader);
    expect(del.status).toBe(200);

    expect(db.prepare('SELECT id FROM users WHERE id = ?').get(inviterId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM notebooks WHERE id = ?').get(nbId)).toBeUndefined();
    // Invitations made by the deleted user no longer reference them
    expect(db.prepare('SELECT COUNT(*) AS n FROM notebook_members WHERE invited_by = ?').get(inviterId).n).toBe(0);
  });

  it('deleting the invitee works and removes their notebook_notes entries (B4)', async () => {
    const { getDb } = await import('../db/index.js');
    const db = getDb();

    // Owner P with a surviving shared notebook, and member Q whose note is in it
    const mk = async (email, pw) => {
      await request(app).post('/api/auth/register').send({ email, password: pw });
      const id = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
      await request(app).post(`/api/admin/users/${id}/approve`).set('Authorization', adminHeader);
      const login = await request(app).post('/api/auth/login').send({ email, password: pw });
      return { id, hdr: `Bearer ${login.body.accessToken}` };
    };
    const p = await mk('b4owner@test.com', 'b4ownerpass123');
    const q = await mk('b4member@test.com', 'b4memberpass123');

    const nb = await request(app).post('/api/notebooks').set('Authorization', p.hdr).send({ name: 'B4 Surviving NB' });
    const nbId = nb.body.id;
    await request(app).post(`/api/notebooks/${nbId}/members`).set('Authorization', p.hdr)
      .send({ email: 'b4member@test.com', role: 'editor' });
    await request(app).post(`/api/notebooks/${nbId}/members/accept`).set('Authorization', q.hdr);

    await request(app).put('/api/notes/b4membernote.md').set('Authorization', q.hdr).send({ content: '# Member note' });
    await request(app).put(`/api/notebooks/${nbId}/notes`).set('Authorization', q.hdr).send({ path: 'b4membernote.md' });
    expect(db.prepare('SELECT 1 FROM notebook_notes WHERE user_id = ? AND note_path = ?').get(q.id, 'b4membernote.md')).toBeDefined();

    const del = await request(app).delete(`/api/admin/users/${q.id}`).set('Authorization', adminHeader);
    expect(del.status).toBe(200);
    expect(db.prepare('SELECT id FROM users WHERE id = ?').get(q.id)).toBeUndefined();
    // Their note is gone from the surviving notebook...
    expect(db.prepare('SELECT 1 FROM notebook_notes WHERE user_id = ?').get(q.id)).toBeUndefined();
    // ...but the notebook itself (owned by P) survives
    expect(db.prepare('SELECT id FROM notebooks WHERE id = ?').get(nbId)).toBeDefined();
  });

  it('invited_by column is nullable in the schema (B4 constraint)', async () => {
    const { getDb } = await import('../db/index.js');
    const col = getDb().prepare('PRAGMA table_info(notebook_members)').all()
      .find(c => c.name === 'invited_by');
    expect(col).toBeDefined();
    expect(col.notnull).toBe(0);
  });
});

describe('Announcements (issue #16)', () => {
  const now = () => Math.floor(Date.now() / 1000);

  // Reset the single active slot to a known-empty state.
  async function clearActive() {
    const { getDb } = await import('../db/index.js');
    getDb().prepare('UPDATE announcements SET replaced_at = ? WHERE replaced_at IS NULL').run(now());
  }

  async function nonAdminHeader() {
    // Create a fresh, approved, non-admin user (earlier suites may have
    // deleted the pre-registered non-admins).
    const db = (await import('../db/index.js')).getDb();
    const email = 'annnobody@test.com';
    if (!db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
      await request(app).post('/api/auth/register').send({ email, password: 'annnobodypass1' });
      const uid = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
      await request(app).post(`/api/admin/users/${uid}/approve`).set('Authorization', adminHeader);
    }
    const login = await request(app).post('/api/auth/login').send({ email, password: 'annnobodypass1' });
    return `Bearer ${login.body.accessToken}`;
  }

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/admin/announcements');
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin user', async () => {
    const hdr = await nonAdminHeader();
    const res = await request(app).get('/api/admin/announcements').set('Authorization', hdr);
    expect(res.status).toBe(403);
  });

  it('returns { announcement: null } when none is active', async () => {
    await clearActive();
    const res = await request(app).get('/api/admin/announcements').set('Authorization', adminHeader);
    expect(res.status).toBe(200);
    expect(res.body.announcement).toBeNull();
  });

  it('POST rejects a missing message', async () => {
    const res = await request(app).post('/api/admin/announcements').set('Authorization', adminHeader)
      .send({ start_time: now() - 60, end_time: now() + 60 });
    expect(res.status).toBe(400);
  });

  it('POST rejects end_time not after start_time', async () => {
    const res = await request(app).post('/api/admin/announcements').set('Authorization', adminHeader)
      .send({ message: 'x', start_time: now() + 100, end_time: now() + 100 });
    expect(res.status).toBe(400);
  });

  it('POST creates an active announcement (201) and GET returns it', async () => {
    await clearActive();
    const res = await request(app).post('/api/admin/announcements').set('Authorization', adminHeader)
      .send({ message: 'Scheduled maintenance tonight', start_time: now() - 60, end_time: now() + 3600 });
    expect(res.status).toBe(201);
    expect(res.body.announcement.message).toBe('Scheduled maintenance tonight');
    expect(res.body.announcement.replaced_at).toBeNull();

    const get = await request(app).get('/api/admin/announcements').set('Authorization', adminHeader);
    expect(get.body.announcement.message).toBe('Scheduled maintenance tonight');
  });

  it('POST replaces the active announcement (prior row superseded)', async () => {
    const first = await request(app).get('/api/admin/announcements').set('Authorization', adminHeader);
    const firstId = first.body.announcement.id;

    const res = await request(app).post('/api/admin/announcements').set('Authorization', adminHeader)
      .send({ message: 'Water is brown — known issue', start_time: now() - 60, end_time: now() + 3600 });
    expect(res.status).toBe(201);
    expect(res.body.announcement.id).not.toBe(firstId);

    const db = (await import('../db/index.js')).getDb();
    const superseded = db.prepare('SELECT replaced_at FROM announcements WHERE id = ?').get(firstId);
    expect(superseded.replaced_at).not.toBeNull();
    const stillActive = db.prepare('SELECT COUNT(*) AS n FROM announcements WHERE replaced_at IS NULL').get().n;
    expect(stillActive).toBe(1);
  });

  it('DELETE ends the active announcement; subsequent GET is null', async () => {
    const del = await request(app).delete('/api/admin/announcements').set('Authorization', adminHeader);
    expect(del.status).toBe(200);
    const get = await request(app).get('/api/admin/announcements').set('Authorization', adminHeader);
    expect(get.body.announcement).toBeNull();
  });

  it('DELETE returns 404 when nothing is active', async () => {
    const res = await request(app).delete('/api/admin/announcements').set('Authorization', adminHeader);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/admin/users (issue #15 activity)', () => {
  const memberEmail = 'issue15member@test.com';
  const memberPassword = 'issue15memberpw1';

  beforeAll(async () => {
    const { getDb } = await import('../db/index.js');
    const db = getDb();

    // Admin: one note, one notebook, shared with at least one accepted member
    await request(app).put('/api/notes/issue15-a.md')
      .set('Authorization', adminHeader).send({ content: 'Issue 15 shared note A' });
    const nb = await request(app).post('/api/notebooks')
      .set('Authorization', adminHeader).send({ name: 'Issue15 NB' });
    expect(nb.status).toBe(201);
    const nbId = nb.body.id;
    await request(app).put(`/api/notebooks/${nbId}/notes`)
      .set('Authorization', adminHeader).send({ path: 'issue15-a.md' });

    // Fresh, approved member user (independent of other suites)
    await request(app).post('/api/auth/register')
      .send({ email: memberEmail, password: memberPassword });
    const memberId = db.prepare('SELECT id FROM users WHERE email = ?').get(memberEmail).id;
    await request(app).post(`/api/admin/users/${memberId}/approve`)
      .set('Authorization', adminHeader);
    const login = await request(app).post('/api/auth/login')
      .send({ email: memberEmail, password: memberPassword });
    const memberHeader = `Bearer ${login.body.accessToken}`;

    await request(app).post(`/api/notebooks/${nbId}/members`)
      .set('Authorization', adminHeader).send({ email: memberEmail, role: 'editor' });
    await request(app).post(`/api/notebooks/${nbId}/members/accept`)
      .set('Authorization', memberHeader);
  });

  it('admin user has notebooks, notes, and shared_notes all >= 1', async () => {
    const res = await request(app).get('/api/admin/users').set('Authorization', adminHeader);
    expect(res.status).toBe(200);

    const admin = res.body.users.find(u => u.email === 'admin@test.com');
    expect(admin.notebooks).toBeGreaterThanOrEqual(1);
    expect(admin.notes).toBeGreaterThanOrEqual(1);
    expect(admin.shared_notes).toBeGreaterThanOrEqual(1);
  });

  it('a member who owns nothing has notebooks >= 1 and notes/shared = 0', async () => {
    const res = await request(app).get('/api/admin/users').set('Authorization', adminHeader);
    const member = res.body.users.find(u => u.email === memberEmail);
    expect(member.notebooks).toBeGreaterThanOrEqual(1);
    expect(member.notes).toBe(0);
    expect(member.shared_notes).toBe(0);
  });

  it('counts only notebooks the user owns or is an accepted member of', async () => {
    const { getDb } = await import('../db/index.js');
    const db = getDb();
    const ownerHeader = await (async () => {
      await request(app).post('/api/auth/register').send({ email: 'nbowner2@test.com', password: 'nbowner2pass1' });
      const oid = db.prepare('SELECT id FROM users WHERE email = ?').get('nbowner2@test.com').id;
      await request(app).post(`/api/admin/users/${oid}/approve`).set('Authorization', adminHeader);
      const login = await request(app).post('/api/auth/login').send({ email: 'nbowner2@test.com', password: 'nbowner2pass1' });
      return `Bearer ${login.body.accessToken}`;
    })();

    // Owner creates two private (unshared) notebooks — member is invited to only one.
    const nb1 = await request(app).post('/api/notebooks').set('Authorization', ownerHeader).send({ name: 'O2 NB1' });
    const nb2 = await request(app).post('/api/notebooks').set('Authorization', ownerHeader).send({ name: 'O2 NB2' });

    // Member is an accepted member of nb1 only
    const memberId = db.prepare('SELECT id FROM users WHERE email = ?').get(memberEmail).id;
    await request(app).post(`/api/notebooks/${nb1.body.id}/members`)
      .set('Authorization', ownerHeader).send({ email: memberEmail, role: 'editor' });
    const memberLogin = await request(app).post('/api/auth/login').send({ email: memberEmail, password: memberPassword });
    const memberHeader = `Bearer ${memberLogin.body.accessToken}`;
    await request(app).post(`/api/notebooks/${nb1.body.id}/members/accept`).set('Authorization', memberHeader);

    const me = await request(app).get('/api/notebooks').set('Authorization', memberHeader);
    const myNbs = me.body.notebooks;
    const ownerNbs = (await request(app).get('/api/notebooks').set('Authorization', ownerHeader)).body.notebooks;
    const admin = await request(app).get('/api/admin/users').set('Authorization', adminHeader);
    const adminRow = admin.body.users.find(u => u.email === 'nbowner2@test.com');
    const memberRow = admin.body.users.find(u => u.email === memberEmail);

    // The admin report agrees with what each user actually sees in their
    // "My notebooks" sidebar (owned ∪ accepted-member).
    expect(ownerNbs.length).toBeGreaterThanOrEqual(2);
    expect(adminRow.notebooks).toBe(ownerNbs.length);
    expect(myNbs.some(n => n.id === nb1.body.id)).toBe(true);
    expect(memberRow.notebooks).toBe(myNbs.length);
  });
});
