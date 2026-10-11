import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanupTmpVault } from './helpers.js';
import { draftEntity, warmModel } from '../services/aiService.js';
import { getDb } from '../db/index.js';

const DRAFT_BODY = '## Description\n\nA quiet, scarred rogue who sells rumors and keeps secrets.\n\n## Location\n\n@@The Allhands Bar@@';

// Mock the AI + broadcast so the job lifecycle runs without Ollama / a WS
// server. The factory is hoisted above the consts, so the draft value must be
// a literal here (mirrored as DRAFT_BODY on the assertion side).
vi.mock('../services/aiService.js', () => ({
  REQUEST_TIMEOUT_MS: 180_000,
  makeBudget: (initialMs = 0) => {
    let deadline = Date.now() + initialMs;
    return {
      chunkMs: initialMs,
      remainingMs() { return Math.max(0, deadline - Date.now()); },
      grantMoreTime(ms) { deadline = Math.max(deadline, Date.now() + ms); },
    };
  },
  draftEntity: vi.fn().mockResolvedValue('## Description\n\nA quiet, scarred rogue who sells rumors and keeps secrets.\n\n## Location\n\n@@The Allhands Bar@@'),
  warmModel: vi.fn().mockResolvedValue({ warmed: true, ms: 5 }),
}));

vi.mock('../ws/index.js', () => ({ broadcast: vi.fn() }));

let app, tmpVault, authHeader;

beforeAll(async () => {
  ({ app, tmpVault } = await createTestApp());
  const reg = await request(app).post('/api/auth/register')
    .send({ email: 'draft@test.com', password: 'draftpassword123' });
  authHeader = `Bearer ${reg.body.accessToken}`;
});

afterAll(async () => { await cleanupTmpVault(tmpVault); });

function auth() { return { Authorization: authHeader }; }

async function waitForDraftStatus(jobId, targetStatus, maxMs = 2000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const res = await request(app).get(`/api/entity-types/draft/${jobId}`).set(auth());
    if (res.body.status === targetStatus) return res.body;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`Draft ${jobId} did not reach '${targetStatus}' within ${maxMs}ms`);
}

describe('POST /api/entity-types/:symbol/draft', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).post('/api/entity-types/&/draft').send({ name: 'Borg' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app).post('/api/entity-types/&/draft').set(auth()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/i);
  });

  it('returns 400 when the name has a forbidden char', async () => {
    const res = await request(app).post('/api/entity-types/&/draft').set(auth()).send({ name: 'evil/name' });
    expect(res.status).toBe(400);
  });

  it('404 for an unknown symbol', async () => {
    const res = await request(app).post('/api/entity-types/z/draft').set(auth()).send({ name: 'x' });
    expect(res.status).toBe(404);
  });

  it('submits a draft job (202 + draftEntity called)', async () => {
    draftEntity.mockClear();
    // Ensure a note with this name does not matter here (draft only writes on apply).
    const res = await request(app).post('/api/entity-types/@/draft').set(auth()).send({ name: 'Draft Village', extra: 'make it eerie' });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeTypeOf('string');
    await waitForDraftStatus(res.body.jobId, 'preview');
    expect(draftEntity).toHaveBeenCalledTimes(1);
    expect(draftEntity.mock.calls[0][0]).toMatchObject({ symbol: '@', name: 'Draft Village' });
  });
});

describe('GET /api/entity-types/draft/:jobId', () => {
  it('404 for an unknown job', async () => {
    const res = await request(app).get('/api/entity-types/draft/nope').set(auth());
    expect(res.status).toBe(404);
  });

  it('returns the draft content once in preview', async () => {
    const { body: { jobId } } = await request(app).post('/api/entity-types/^/draft').set(auth()).send({ name: 'Bolt Trap' });
    const job = await waitForDraftStatus(jobId, 'preview');
    expect(job.status).toBe('preview');
    expect(job.content).toBe(DRAFT_BODY);
  });
});

describe('POST /api/entity-types/draft/:jobId/apply', () => {
  it('writes the edited draft to the entity note, preserving frontmatter', async () => {
    // The apply target is entities/<type>/<name>.md; a draft is a *suggestion*
    // for that entity, so create the note first to prove apply overwrites it.
    await request(app).post('/api/entity-types/&').set(auth()).send({ name: 'Aldric the Gray' });

    const { body: { jobId } } = await request(app).post('/api/entity-types/&/draft').set(auth()).send({ name: 'Aldric the Gray' });
    await waitForDraftStatus(jobId, 'preview');

    const res = await request(app).post(`/api/entity-types/draft/${jobId}/apply`).set(auth())
      .send({ content: '## Description\n\nAn edited, grayer, more dangerous rogue.' });
    expect(res.status).toBe(200);
    expect(res.body.written).toBe(true);
    expect(res.body.path).toBe('entities/npc/Aldric the Gray.md');

    const note = await request(app).get('/api/notes/entities/npc/Aldric%20the%20Gray.md').set(auth());
    expect(note.status).toBe(200);
    expect(note.body.content).toContain('entity: &');
    expect(note.body.content).toContain('An edited, grayer, more dangerous rogue.');
    expect(note.body.content).not.toContain(DRAFT_BODY.split('\n')[2]);
  });

  it('returns 400 when content is missing', async () => {
    const { body: { jobId } } = await request(app).post('/api/entity-types/&/draft').set(auth()).send({ name: 'Aldric the Gray' });
    await waitForDraftStatus(jobId, 'preview');
    const res = await request(app).post(`/api/entity-types/draft/${jobId}/apply`).set(auth()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/content is required/i);
  });

  it('applies the draft to a note that does NOT exist yet (creates it)', async () => {
    const { body: { jobId } } = await request(app).post('/api/entity-types/+/draft').set(auth()).send({ name: 'New Player' });
    await waitForDraftStatus(jobId, 'preview');
    const res = await request(app).post(`/api/entity-types/draft/${jobId}/apply`).set(auth()).send({ content: '## Player\n\nA fresh hero.' });
    expect(res.status).toBe(200);
    expect(res.body.path).toBe('entities/player/New Player.md');

    const note = await request(app).get('/api/notes/entities/player/New%20Player.md').set(auth());
    expect(note.status).toBe(200);
    expect(note.body.content).toContain('entity: +');
    expect(note.body.content).toContain('A fresh hero.');
  });
});

describe('POST /api/entity-types/draft/:jobId/cancel + continue', () => {
  it('interrupts a running draft and marks it cancelled', async () => {
    draftEntity.mockImplementation((_opts, { signal } = {}) => new Promise((_, reject) => {
      const t = setTimeout(() => { clearTimeout(t); reject(new Error('nope')); }, 10_000);
      const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
    }));
    const { body: { jobId } } = await request(app).post('/api/entity-types/&/draft').set(auth()).send({ name: 'Stall NPC' });
    await waitForDraftStatus(jobId, 'processing');

    const res = await request(app).post(`/api/entity-types/draft/${jobId}/cancel`).set(auth());
    expect(res.status).toBe(202);
    const job = await waitForDraftStatus(jobId, 'cancelled');
    expect(job.status).toBe('cancelled');
    draftEntity.mockReset();
    draftEntity.mockResolvedValue(DRAFT_BODY);
  });

  it('lets a timed-out draft continue to completion', async () => {
    let calls = 0;
    draftEntity.mockImplementation((_opts) => {
      calls++;
      if (calls === 1) return Promise.reject(Object.assign(new Error('slow'), { name: 'TimeoutError' }));
      return Promise.resolve(DRAFT_BODY);
    });
    const { body: { jobId } } = await request(app).post('/api/entity-types/!/draft').set(auth()).send({ name: 'Continued Event' });
    const waiting = await waitForDraftStatus(jobId, 'waiting_continue');
    expect(waiting.status).toBe('waiting_continue');

    const res = await request(app).post(`/api/entity-types/draft/${jobId}/continue`).set(auth());
    expect(res.status).toBe(202);
    const job = await waitForDraftStatus(jobId, 'preview');
    expect(job.content).toBe(DRAFT_BODY);
    draftEntity.mockReset();
    draftEntity.mockResolvedValue(DRAFT_BODY);
  });
});

describe('GET /api/notes/* returns entity_symbol for entities (button gate)', () => {
  it('exposes entity_symbol on the note payload', async () => {
    const res = await request(app).get('/api/notes/entities/npc/Aldric%20the%20Gray.md').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.entity_symbol).toBe('&');
  });

  it('exposes null entity_symbol on a plain note', async () => {
    await request(app).put('/api/notes/plain-note.md').set(auth()).send({ content: 'a plain note' });
    const res = await request(app).get('/api/notes/plain-note.md').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.entity_symbol).toBeNull();
  });
});
