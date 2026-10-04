import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

// Mock bcrypt for speed — auth logic, not hashing, is what we test
vi.mock('bcrypt', () => ({
  default: {
    hash:    async (p) => `hashed:${p}`,
    compare: async (p, h) => h === `hashed:${p}`,
  },
}));

import { setTestEnv, setupDb } from './helpers.js';
import { getDb } from '../db/index.js';

let app;
beforeAll(async () => {
  setTestEnv();
  setupDb();
  const { default: authRoutes } = await import('../routes/auth.js');
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
});

const VALID = { email: 'test@example.com', password: 'strongpassword99!' };

describe('POST /api/auth/register', () => {
  it('first user becomes admin+active — returns 201 with accessToken and cookie', async () => {
    const res = await request(app).post('/api/auth/register').send(VALID);
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.email).toBe(VALID.email);
    expect(res.body.user.role).toBe('admin');
    expect(res.headers['set-cookie']?.[0]).toContain('refresh_token=');
  });

  it('subsequent users are pending — returns 201 with pending:true, no token', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'pending@test.com', password: 'pendingpass123' });
    expect(res.status).toBe(201);
    expect(res.body.pending).toBe(true);
    expect(res.body.accessToken).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('returns 409 for duplicate email', async () => {
    const res = await request(app).post('/api/auth/register').send(VALID);
    expect(res.status).toBe(409);
  });

  it('returns 400 for password shorter than 12 chars', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'b@b.com', password: 'short' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when email is missing', async () => {
    const res = await request(app).post('/api/auth/register').send({ password: 'validpassword!' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  it('returns 200 with accessToken for valid credentials', async () => {
    const res = await request(app).post('/api/auth/login').send(VALID);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('returns 401 for wrong password', async () => {
    const res = await request(app).post('/api/auth/login').send({ ...VALID, password: 'wrongpassword99!' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for unknown email', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'nobody@no.com', password: 'strongpassword99!' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when body is empty', async () => {
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.status).toBe(400);
  });

  it('returns 403 for pending account (valid credentials)', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'pending@test.com', password: 'pendingpass123' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/pending/i);
  });

  it('includes the active announcement (or null) in the login response', async () => {
    const now = Math.floor(Date.now() / 1000);
    // An active window now:
    getDb().prepare('DELETE FROM announcements').run();
    getDb().prepare('INSERT INTO announcements (message, start_time, end_time) VALUES (?, ?, ?)')
      .run('Down for maintenance', now - 60, now + 3600);

    const withActive = await request(app).post('/api/auth/login').send(VALID);
    expect(withActive.status).toBe(200);
    expect(withActive.body.announcement).toMatchObject({ message: 'Down for maintenance' });

    // Expire it — login should now carry null:
    getDb().prepare('UPDATE announcements SET end_time = ?').run(now - 1);
    const after = await request(app).post('/api/auth/login').send(VALID);
    expect(after.status).toBe(200);
    expect(after.body.announcement).toBeNull();
  });
});

describe('GET /api/auth/active-announcement (issue #16)', () => {
  const now = () => Math.floor(Date.now() / 1000);

  async function adminToken() {
    const login = await request(app).post('/api/auth/login').send(VALID);
    return `Bearer ${login.body.accessToken}`;
  }

  function setWindow(message, start, end) {
    const db = getDb();
    db.prepare('UPDATE announcements SET replaced_at = ? WHERE replaced_at IS NULL').run(now());
    db.prepare('INSERT INTO announcements (message, start_time, end_time) VALUES (?, ?, ?)').run(message, start, end);
  }

  it('requires authentication (401 without token)', async () => {
    const res = await request(app).get('/api/auth/active-announcement');
    expect(res.status).toBe(401);
  });

  it('returns the announcement when now is inside the window', async () => {
    setWindow('Inside window', now() - 60, now() + 60);
    const res = await request(app).get('/api/auth/active-announcement')
      .set('Authorization', await adminToken());
    expect(res.status).toBe(200);
    expect(res.body.announcement.message).toBe('Inside window');
  });

  it('returns null when now is before start_time', async () => {
    setWindow('Future only', now() + 3600, now() + 7200);
    const res = await request(app).get('/api/auth/active-announcement')
      .set('Authorization', await adminToken());
    expect(res.body.announcement).toBeNull();
  });

  it('returns null when now is after end_time', async () => {
    setWindow('Past only', now() - 7200, now() - 3600);
    const res = await request(app).get('/api/auth/active-announcement')
      .set('Authorization', await adminToken());
    expect(res.body.announcement).toBeNull();
  });

  it('returns null when no announcement row is active', async () => {
    getDb().prepare('UPDATE announcements SET replaced_at = ? WHERE replaced_at IS NULL').run(now());
    const res = await request(app).get('/api/auth/active-announcement')
      .set('Authorization', await adminToken());
    expect(res.body.announcement).toBeNull();
  });
});

describe('POST /api/auth/refresh', () => {
  it('issues a new accessToken given a valid refresh cookie', async () => {
    const login = await request(app).post('/api/auth/login').send(VALID);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const res = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('returns 401 without a refresh cookie', async () => {
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(401);
  });

  it('rotates the refresh token (old token rejected after use)', async () => {
    const login = await request(app).post('/api/auth/login').send(VALID);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    const second = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(second.status).toBe(401);
  });
});

describe('POST /api/auth/change-password', () => {
  async function login() {
    const res = await request(app).post('/api/auth/login').send(VALID);
    expect(res.status).toBe(200);
    return res.body.accessToken;
  }

  it('returns 400 when newPassword is missing', async () => {
    const token = await login();
    const res = await request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${token}`).send({ currentPassword: 'strongpassword99!' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/newPassword/);
  });

  it('returns 400 when newPassword is shorter than 12 characters', async () => {
    const token = await login();
    const res = await request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${token}`).send({ currentPassword: 'strongpassword99!', newPassword: 'short' });
    expect(res.status).toBe(400);
  });

  it('returns 401 for a wrong current password and leaves the password unchanged', async () => {
    const token = await login();
    const res = await request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${token}`).send({ currentPassword: 'wrongcurrent12!', newPassword: 'newpassword123!' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/current password/i);
    const relogin = await request(app).post('/api/auth/login').send(VALID);
    expect(relogin.status).toBe(200);
  });

  it('changes the password, old password no longer works, new one does', async () => {
    const token = await login();
    const res = await request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${token}`).send({ currentPassword: 'strongpassword99!', newPassword: 'newpassword123!' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const oldRes = await request(app).post('/api/auth/login').send(VALID);
    expect(oldRes.status).toBe(401);

    const newRes = await request(app).post('/api/auth/login').send({ email: VALID.email, password: 'newpassword123!' });
    expect(newRes.status).toBe(200);

    // restore for any later tests relying on VALID
    const restore = await request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${newRes.body.accessToken}`).send({ currentPassword: 'newpassword123!', newPassword: 'strongpassword99!' });
    expect(restore.status).toBe(200);
  });

  it('requires a valid access token', async () => {
    const res = await request(app).post('/api/auth/change-password').send({ currentPassword: 'x', newPassword: 'newpassword123!' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('returns 200 and clears the refresh_token cookie', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const setCookie = res.headers['set-cookie']?.[0] ?? '';
    expect(setCookie).toMatch(/refresh_token=;/);
  });
});

describe('telemetry (issue #6)', () => {
  it('records a signon row and sets last_seen_at on login', async () => {
    const db = getDb();
    const before = db.prepare('SELECT COUNT(*) AS n FROM signons').get().n;
    const uid = db.prepare("SELECT id FROM users WHERE email = ?").get(VALID.email).id;

    const res = await request(app).post('/api/auth/login').send(VALID);
    expect(res.status).toBe(200);

    expect(db.prepare('SELECT COUNT(*) AS n FROM signons').get().n).toBe(before + 1);
    const row = db.prepare('SELECT user_id FROM signons ORDER BY id DESC').get();
    expect(row.user_id).toBe(uid);
    expect(db.prepare('SELECT last_seen_at FROM users WHERE id = ?').get(uid).last_seen_at).toBeGreaterThan(Math.floor(Date.now() / 1000) - 60);
  });

  it('records a signon row on refresh', async () => {
    const db = getDb();
    const login = await request(app).post('/api/auth/login').send(VALID);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const before = db.prepare('SELECT COUNT(*) AS n FROM signons').get().n;

    const res = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM signons').get().n).toBe(before + 1);
  });

  it('pending users do not get a signon row on failed login', async () => {
    const db = getDb();
    const before = db.prepare('SELECT COUNT(*) AS n FROM signons').get().n;
    const res = await request(app).post('/api/auth/login').send({ email: 'pending@test.com', password: 'pendingpass123' });
    expect(res.status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM signons').get().n).toBe(before);
  });

  it('signons rows cascade when the user is deleted', async () => {
    const db = getDb();
    await request(app).post('/api/auth/register').send({ email: 'cascade@test.com', password: 'cascadepass1234' });
    const uid = db.prepare("SELECT id FROM users WHERE email = 'cascade@test.com'").get().id;
    db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(uid);
    const login = await request(app).post('/api/auth/login').send({ email: 'cascade@test.com', password: 'cascadepass1234' });
    expect(login.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM signons WHERE user_id = ?').get(uid).n).toBeGreaterThanOrEqual(1);

    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    expect(db.prepare('SELECT COUNT(*) AS n FROM signons WHERE user_id = ?').get(uid).n).toBe(0);
  });
});
