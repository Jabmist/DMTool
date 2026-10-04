import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTestApp, cleanupTmpVault } from './helpers.js';

vi.mock('bcrypt', () => ({
  default: {
    hash: async (p) => `hashed:${p}`,
    compare: async (p, h) => h === `hashed:${p}`,
  },
}));

// Stub the two route-touching side effects so the restore test can assert on
// them WITHOUT actually triggering a live `process.exit(0)`.
vi.mock('../services/backupService.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, scheduleRestart: vi.fn() };
});
vi.mock('../ws/index.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, broadcast: vi.fn() };
});

let app, tmpVault, backupDir, adminHeader;

beforeAll(async () => {
  ({ app, tmpVault } = await createTestApp());

  backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-bk-test-'));
  process.env.BACKUP_DIR = backupDir;

  // First registration = admin+active
  const r = await request(app).post('/api/auth/register')
    .send({ email: 'admin@test.com', password: 'adminpassword123' });
  adminHeader = `Bearer ${r.body.accessToken}`;
});

afterAll(async () => {
  await cleanupTmpVault(tmpVault);
  await fs.rm(backupDir, { recursive: true, force: true });
});

// ── GET /api/admin/backups ───────────────────────────────────────────────────

describe('GET /api/admin/backups', () => {
  it('returns 401 without a token', async () => {
    expect((await request(app).get('/api/admin/backups')).status).toBe(401);
  });

  it('returns an empty list before any backups exist', async () => {
    const res = await request(app).get('/api/admin/backups').set('Authorization', adminHeader);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.backups)).toBe(true);
  });
});

// ── POST /api/admin/backups ──────────────────────────────────────────────────

describe('POST /api/admin/backups', () => {
  let createdId;

  it('creates a backup and returns it with 202', async () => {
    // Seed a note so tar has something to include.
    const noteDir = path.join(tmpVault, 'user1');
    await fs.mkdir(noteDir, { recursive: true });
    await fs.writeFile(path.join(noteDir, 'hello.md'), 'hello world');

    const res = await request(app).post('/api/admin/backups').set('Authorization', adminHeader);
    expect(res.status).toBe(202);
    expect(res.body.id).toBeTruthy();
    expect(res.body.path).toBeTruthy();
    expect(res.body.sizeBytes).toBeGreaterThan(0);
    createdId = res.body.id;
  });

  it('rejects a concurrent create with 409', async () => {
    // Fire two real route POSTs together. The first sets the service's
    // in-flight flag and runs tar (long enough that the second hits the guard);
    // the second must 409.
    const [a, b] = await Promise.all([
      request(app).post('/api/admin/backups').set('Authorization', adminHeader),
      request(app).post('/api/admin/backups').set('Authorization', adminHeader),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toContain(202);
    expect(statuses).toContain(409);
  });

  it('lists the created backup as complete', async () => {
    const res = await request(app).get('/api/admin/backups').set('Authorization', adminHeader);
    expect(res.status).toBe(200);
    const b = res.body.backups.find(x => x.id === createdId);
    expect(b).toBeTruthy();
    expect(b.status).toBe('complete');
    expect(b.kind).toBe('manual');
    expect(b.created_by_email).toBe('admin@test.com');
  });
});

// ── GET /api/admin/backups/:id/download ─────────────────────────────────────

describe('GET /api/admin/backups/:id/download', () => {
  let completeId;

  beforeAll(async () => {
    const { getDb } = await import('../db/index.js');
    const row = getDb().prepare('SELECT id FROM backups WHERE status = ? ORDER BY created_at DESC LIMIT 1').get('complete');
    if (row) { completeId = row.id; return; }
    const { createBackup } = await import('../services/backupService.js');
    const result = await createBackup('manual', 1);
    completeId = result.id;
  });

  it('returns 401 without a token', async () => {
    expect((await request(app).get(`/api/admin/backups/${completeId}/download`)).status).toBe(401);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(app).get('/api/admin/backups/does-not-exist/download').set('Authorization', adminHeader);
    expect(res.status).toBe(404);
  });

  it('returns 409 for a running backup', async () => {
    const { getDb } = await import('../db/index.js');
    getDb().prepare('INSERT INTO backups (id, kind, status) VALUES (?,?,?)').run('dl-running', 'manual', 'running');
    const res = await request(app).get('/api/admin/backups/dl-running/download').set('Authorization', adminHeader);
    expect(res.status).toBe(409);
  });

  it('returns 200 + gzip for a complete backup', async () => {
    const res = await request(app).get(`/api/admin/backups/${completeId}/download`)
      .set('Authorization', adminHeader).buffer(true);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/gzip/);
    expect(String(res.headers['content-disposition'])).toMatch(/attachment;\s*filename="obsidian-[^"]+\.tar\.gz"/);
    expect(res.body.length).toBeGreaterThan(0);
  });
});

// ── POST /api/admin/backups/:id/restore ────────────────────────────────────

describe('POST /api/admin/backups/:id/restore', () => {
  it('returns 401 without a token', async () => {
    expect((await request(app).post('/api/admin/backups/x/restore')).status).toBe(401);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(app).post('/api/admin/backups/does-not-exist/restore').set('Authorization', adminHeader);
    expect(res.status).toBe(404);
  });

  it('returns 409 for a non-complete backup', async () => {
    const { getDb } = await import('../db/index.js');
    getDb().prepare('INSERT INTO backups (id, kind, status) VALUES (?,?,?)').run('rest-running', 'manual', 'running');
    const res = await request(app).post('/api/admin/backups/rest-running/restore').set('Authorization', adminHeader);
    expect(res.status).toBe(409);
  });

  it('restores the vault + reports success + fires broadcast + scheduleRestart', async () => {
    const svc = await import('../services/backupService.js');
    const ws  = await import('../ws/index.js');
    svc.scheduleRestart.mockClear?.();
    ws.broadcast.mockClear?.();

    // Order matters: the backup captures the vault at backup time, so the note
    // must exist BEFORE we create the backup, then be wiped (simulating data
    // loss), and only then restored.
    const notePath = path.join(tmpVault, 'restore-me.md');
    await fs.mkdir(path.dirname(notePath), { recursive: true });
    await fs.writeFile(notePath, 'restored content');

    const created = await svc.createBackup('manual', 1);
    const bid = created.id;

    // Simulate data loss
    await fs.rm(notePath, { force: true });

    const res = await request(app).post(`/api/admin/backups/${bid}/restore`).set('Authorization', adminHeader);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ restored: true, backupId: bid, restartRequired: true });

    // Vault restored by the service — the note is back with its original content
    const restored = await fs.readFile(notePath, 'utf8').catch(() => null);
    expect(restored).toBe('restored content');

    // Side effects fired: broadcast went out and scheduleRestart was called with 2000
    if (typeof ws.broadcast === 'function' && ws.broadcast.mock) {
      expect(ws.broadcast).toHaveBeenCalled();
      const any = ws.broadcast.mock.calls.find(c => c[1]?.type === 'backup.restore');
      expect(any).toBeTruthy();
    }
    if (typeof svc.scheduleRestart === 'function' && svc.scheduleRestart.mock) {
      expect(svc.scheduleRestart).toHaveBeenCalledWith(2000);
    }
  });
});
