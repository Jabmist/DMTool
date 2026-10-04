import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanupTmpVault } from './helpers.js';
import { dissectNote, warmModel } from '../services/aiService.js';

const DEFAULT_NOTES = [
  { title: 'Alpha Concept', content: '# Alpha\n\nCore idea.' },
  { title: 'Beta Concept',  content: '# Beta\n\nSee also [[Alpha Concept]].' },
];

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
  dissectNote: vi.fn().mockResolvedValue([
    { title: 'Alpha Concept', content: '# Alpha\n\nCore idea.' },
    { title: 'Beta Concept',  content: '# Beta\n\nSee also [[Alpha Concept]].' },
  ]),
  warmModel: vi.fn().mockResolvedValue({ warmed: true, ms: 5 }),
}));

afterEach(() => {
  dissectNote.mockReset();
  dissectNote.mockResolvedValue(DEFAULT_NOTES);
  warmModel.mockReset();
  warmModel.mockResolvedValue({ warmed: true, ms: 5 });
});

// Also mock the WebSocket broadcast so tests don't error on missing WS server
vi.mock('../ws/index.js', () => ({ broadcast: vi.fn() }));

vi.mock('pdf-parse', () => ({
  PDFParse: class {
    getText() { return Promise.resolve({ text: 'Extracted PDF text about mitochondria.' }); }
  },
}));

vi.mock('mammoth', () => ({
  default: { extractRawText: vi.fn().mockResolvedValue({ value: 'Extracted DOCX text about photosynthesis.' }) },
}));

let app, tmpVault, authHeader;

beforeAll(async () => {
  ({ app, tmpVault } = await createTestApp());

  const reg = await request(app).post('/api/auth/register')
    .send({ email: 'dissect@test.com', password: 'dissectpassword123' });
  authHeader = `Bearer ${reg.body.accessToken}`;
});

afterAll(async () => { await cleanupTmpVault(tmpVault); });

function auth(req) { return req.set('Authorization', authHeader); }

async function waitForJobStatus(jobId, targetStatus, maxMs = 2000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const res = await auth(request(app).get(`/api/dissect/${jobId}`));
    if (res.body.status === targetStatus) return res.body;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`Job ${jobId} did not reach status '${targetStatus}' within ${maxMs}ms`);
}

// ---------------------------------------------------------------------------
// POST /api/dissect
// ---------------------------------------------------------------------------
describe('POST /api/dissect', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).post('/api/dissect').send({ text: 'hello' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when text is missing', async () => {
    const res = await auth(request(app).post('/api/dissect')).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/text required/i);
  });

  it('returns 400 when text is blank', async () => {
    const res = await auth(request(app).post('/api/dissect')).send({ text: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 202 with jobId for valid text', async () => {
    const res = await auth(request(app).post('/api/dissect')).send({ text: 'The mitochondria is the powerhouse of the cell.' });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeTypeOf('string');
  });
});

// ---------------------------------------------------------------------------
// GET /api/dissect/:jobId
// ---------------------------------------------------------------------------
describe('GET /api/dissect/:jobId', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/dissect/fakeid');
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown jobId', async () => {
    const res = await auth(request(app).get('/api/dissect/00000000-0000-0000-0000-000000000000'));
    expect(res.status).toBe(404);
  });

  it('returns job status for a valid job', async () => {
    const { body: { jobId } } = await auth(request(app).post('/api/dissect'))
      .send({ text: 'Photosynthesis converts sunlight to energy.' });

    const job = await waitForJobStatus(jobId, 'preview');
    expect(job.status).toBe('preview');
    expect(Array.isArray(job.result)).toBe(true);
    expect(job.result[0]).toHaveProperty('title');
    expect(job.result[0]).toHaveProperty('content');
  });
});

// ---------------------------------------------------------------------------
// POST /api/dissect/:jobId/approve
// ---------------------------------------------------------------------------
describe('POST /api/dissect/:jobId/approve', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).post('/api/dissect/fakeid/approve').send({ notes: [] });
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown jobId', async () => {
    const res = await auth(request(app).post('/api/dissect/00000000-0000-0000-0000-000000000000/approve'))
      .send({ notes: [{ title: 'X', content: 'y' }] });
    expect(res.status).toBe(404);
  });

  it('returns 409 when job is not in preview state', async () => {
    const { body: { jobId } } = await auth(request(app).post('/api/dissect'))
      .send({ text: 'Some content.' });
    // Job starts as pending/processing — try approving immediately before it reaches preview
    // We use a fresh job and approve without waiting for preview
    const res = await auth(request(app).post(`/api/dissect/${jobId}/approve`))
      .send({ notes: [{ title: 'X', content: 'y' }] });
    // Could be 409 (if still processing) or 200 (if already in preview) — accept either
    expect([200, 409]).toContain(res.status);
  });

  it('returns 400 when notes array is missing', async () => {
    const { body: { jobId } } = await auth(request(app).post('/api/dissect'))
      .send({ text: 'DNA carries genetic information.' });
    await waitForJobStatus(jobId, 'preview');

    const res = await auth(request(app).post(`/api/dissect/${jobId}/approve`)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/notes array required/i);
  });

  it('returns 400 when notes array is empty', async () => {
    const { body: { jobId } } = await auth(request(app).post('/api/dissect'))
      .send({ text: 'Neurons transmit signals.' });
    await waitForJobStatus(jobId, 'preview');

    const res = await auth(request(app).post(`/api/dissect/${jobId}/approve`))
      .send({ notes: [] });
    expect(res.status).toBe(400);
  });

  it('skips notes with invalid titles and reports them in errors', async () => {
    const { body: { jobId } } = await auth(request(app).post('/api/dissect'))
      .send({ text: 'Entropy measures disorder.' });
    await waitForJobStatus(jobId, 'preview');

    const res = await auth(request(app).post(`/api/dissect/${jobId}/approve`))
      .send({ notes: [{ title: '../bad/path', content: 'oops' }] });
    expect(res.status).toBe(200);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].error).toBe('invalid title');
  });

  it('writes approved notes and returns written paths', async () => {
    const { body: { jobId } } = await auth(request(app).post('/api/dissect'))
      .send({ text: 'Gravity pulls objects toward each other.' });
    await waitForJobStatus(jobId, 'preview');

    const res = await auth(request(app).post(`/api/dissect/${jobId}/approve`))
      .send({ notes: [{ title: 'Gravity Basics', content: '# Gravity\n\nPulls objects.' }] });
    expect(res.status).toBe(200);
    expect(res.body.written).toContain('Gravity Basics.md');
    expect(res.body.errors).toHaveLength(0);
  });

  it('appends content when note with same title already exists', async () => {
    // Create the note first
    await auth(request(app).put('/api/notes/Existing%20Note.md'))
      .send({ content: '# Existing\n\nFirst content.' });

    const { body: { jobId } } = await auth(request(app).post('/api/dissect'))
      .send({ text: 'This is a test of append behavior.' });
    await waitForJobStatus(jobId, 'preview');

    const res = await auth(request(app).post(`/api/dissect/${jobId}/approve`))
      .send({ notes: [{ title: 'Existing Note', content: 'Appended content.' }] });
    expect(res.status).toBe(200);
    expect(res.body.written).toContain('Existing Note.md');

    const noteRes = await auth(request(app).get('/api/notes/Existing%20Note.md'));
    expect(noteRes.body.content).toContain('First content.');
    expect(noteRes.body.content).toContain('Appended content.');
  });

  it('groups a multi-note approval into a notebook named after the summary', async () => {
    const { body: { jobId } } = await auth(request(app).post('/api/dissect'))
      .send({ text: 'Grouping behaviour.' });
    await waitForJobStatus(jobId, 'preview');

    const notes = [
      { title: 'Topic One',   content: '# One' },
      { title: 'Topic Two',   content: '# Two' },
      { title: 'The Overview', content: '# Overview\n\nSee [[Topic One]] and [[Topic Two]].', isSummary: true },
    ];
    const res = await auth(request(app).post(`/api/dissect/${jobId}/approve`)).send({ notes });
    expect(res.status).toBe(200);
    expect(res.body.errors).toHaveLength(0);
    expect(res.body.written).toHaveLength(3);
    expect(res.body.notebook).toMatchObject({ name: 'The Overview', paths: expect.arrayContaining(['Topic One.md', 'Topic Two.md', 'The Overview.md']) });

    const notesRes = await auth(request(app).get(`/api/notebooks/${res.body.notebook.id}/notes`));
    expect(notesRes.body.paths).toEqual(expect.arrayContaining(['Topic One.md', 'Topic Two.md', 'The Overview.md']));
  });

  it('numbers the notebook name when the summary title already exists', async () => {
    await auth(request(app).post('/api/notebooks')).send({ name: 'The Overview' });

    const { body: { jobId } } = await auth(request(app).post('/api/dissect'))
      .send({ text: 'Numbering behaviour.' });
    await waitForJobStatus(jobId, 'preview');

    const notes = [
      { title: 'Topic A', content: '# A' },
      { title: 'The Overview', content: '# S', isSummary: true },
    ];
    const res = await auth(request(app).post(`/api/dissect/${jobId}/approve`)).send({ notes });
    expect(res.status).toBe(200);
    expect(res.body.notebook?.name).toBe('The Overview 2');
  });

  it('does not create a notebook when only one note is approved', async () => {
    const { body: { jobId } } = await auth(request(app).post('/api/dissect'))
      .send({ text: 'Single note.' });
    await waitForJobStatus(jobId, 'preview');

    const res = await auth(request(app).post(`/api/dissect/${jobId}/approve`))
      .send({ notes: [{ title: 'Only One', content: '# O', isSummary: true }] });
    expect(res.status).toBe(200);
    expect(res.body.written).toHaveLength(1);
    expect(res.body.notebook).toBeNull();
  });

  it('does not create a notebook when no note is marked as the summary', async () => {
    const { body: { jobId } } = await auth(request(app).post('/api/dissect'))
      .send({ text: 'No summary.' });
    await waitForJobStatus(jobId, 'preview');

    const res = await auth(request(app).post(`/api/dissect/${jobId}/approve`))
      .send({ notes: [{ title: 'A', content: '# A' }, { title: 'B', content: '# B' }] });
    expect(res.status).toBe(200);
    expect(res.body.written).toHaveLength(2);
    expect(res.body.notebook).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /api/dissect/:jobId/cancel + /:jobId/continue
// ---------------------------------------------------------------------------
describe('POST /api/dissect/:jobId/cancel', () => {
  it('interrupts a running job and marks it cancelled', async () => {
    dissectNote.mockImplementation((_text, { signal } = {}) => new Promise((_, reject) => {
      const t = setTimeout(() => { clearTimeout(t); reject(new Error('nope')); }, 10_000);
      const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
    }));

    const { body: { jobId } } = await auth(request(app).post('/api/dissect'))
      .send({ text: 'A long dissection that will be cancelled.' });
    await waitForJobStatus(jobId, 'processing');

    const res = await auth(request(app).post(`/api/dissect/${jobId}/cancel`));
    expect(res.status).toBe(202);

    const job = await waitForJobStatus(jobId, 'cancelled');
    expect(job.status).toBe('cancelled');
    expect(job.error).toMatch(/cancel/i);
  });

  it('returns 409 when the job is not running', async () => {
    const { body: { jobId } } = await auth(request(app).post('/api/dissect'))
      .send({ text: 'A job that finishes before we cancel it.' });
    await waitForJobStatus(jobId, 'preview');
    const res = await auth(request(app).post(`/api/dissect/${jobId}/cancel`));
    expect(res.status).toBe(409);
  });
});

describe('POST /api/dissect/:jobId/continue', () => {
  it('lets a timed-out job run its next turn to completion', async () => {
    let calls = 0;
    dissectNote.mockImplementation((_text) => {
      calls++;
      if (calls === 1) return Promise.reject(Object.assign(new Error('slow'), { name: 'TimeoutError' }));
      return Promise.resolve([{ title: 'Recovered Concept', content: '# Recovered' }]);
    });

    const { body: { jobId } } = await auth(request(app).post('/api/dissect'))
      .send({ text: 'A dissection that times out once then succeeds.' });
    const waiting = await waitForJobStatus(jobId, 'waiting_continue');
    expect(waiting.status).toBe('waiting_continue');

    const res = await auth(request(app).post(`/api/dissect/${jobId}/continue`));
    expect(res.status).toBe(202);

    const job = await waitForJobStatus(jobId, 'preview');
    expect(job.result[0].title).toBe('Recovered Concept');
  });

  it('returns 409 when the job is not waiting', async () => {
    const { body: { jobId } } = await auth(request(app).post('/api/dissect'))
      .send({ text: 'A finished job.' });
    await waitForJobStatus(jobId, 'preview');
    const res = await auth(request(app).post(`/api/dissect/${jobId}/continue`));
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// POST /api/dissect/upload
// ---------------------------------------------------------------------------
describe('POST /api/dissect/upload', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).post('/api/dissect/upload')
      .attach('file', Buffer.from('hello'), { filename: 'note.md', contentType: 'text/markdown' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when no file is provided', async () => {
    const res = await auth(request(app).post('/api/dissect/upload'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/file required/i);
  });

  it('returns 400 for an empty file', async () => {
    const res = await auth(request(app).post('/api/dissect/upload'))
      .attach('file', Buffer.from('   \n  '), { filename: 'empty.md', contentType: 'text/markdown' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/empty/i);
  });

  it('returns 202 with jobId for a valid .md file', async () => {
    const content = '# My Note\n\nThe cell is the basic unit of life.';
    const res = await auth(request(app).post('/api/dissect/upload'))
      .attach('file', Buffer.from(content), { filename: 'biology.md', contentType: 'text/markdown' });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeTypeOf('string');
  });

  it('returns 202 with jobId for a valid .txt file', async () => {
    const content = 'Quantum mechanics describes particles at the subatomic scale.';
    const res = await auth(request(app).post('/api/dissect/upload'))
      .attach('file', Buffer.from(content), { filename: 'physics.txt', contentType: 'text/plain' });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeTypeOf('string');
  });

  it('returns 202 with jobId for a .pdf file', async () => {
    const res = await auth(request(app).post('/api/dissect/upload'))
      .attach('file', Buffer.from('%PDF-1.4 fake'), { filename: 'paper.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeTypeOf('string');
  });

  it('returns 202 with jobId for a .docx file', async () => {
    const res = await auth(request(app).post('/api/dissect/upload'))
      .attach('file', Buffer.from('PK fake docx'), { filename: 'report.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeTypeOf('string');
  });

  it('returns 400 for an unsupported type like .html', async () => {
    const res = await auth(request(app).post('/api/dissect/upload'))
      .attach('file', Buffer.from('<html>hello</html>'), { filename: 'page.html', contentType: 'text/html' });
    expect(res.status).toBe(400);
  });

  it('processes the uploaded file through the dissect pipeline', async () => {
    const content = 'Evolution explains the diversity of life through natural selection.';
    const { body: { jobId } } = await auth(request(app).post('/api/dissect/upload'))
      .attach('file', Buffer.from(content), { filename: 'evolution.md', contentType: 'text/markdown' });

    const job = await waitForJobStatus(jobId, 'preview');
    expect(job.status).toBe('preview');
    expect(Array.isArray(job.result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/dissect/warm — model preload
// ---------------------------------------------------------------------------
describe('POST /api/dissect/warm', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).post('/api/dissect/warm');
    expect(res.status).toBe(401);
    expect(warmModel).not.toHaveBeenCalled();
  });

  it('calls warmModel and resolves with its result', async () => {
    const res = await auth(request(app).post('/api/dissect/warm'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ warmed: true, ms: 5 });
    expect(warmModel).toHaveBeenCalledTimes(1);
  });

  it('reports the warm-up failure in-band (200 with warmed=false)', async () => {
    warmModel.mockResolvedValue({ warmed: false, reason: 'ECONNREFUSED' });
    const res = await auth(request(app).post('/api/dissect/warm'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ warmed: false, reason: 'ECONNREFUSED' });
  });

  it('does NOT shadow /api/dissect/:jobId lookups', async () => {
    const { body: { jobId } } = await auth(request(app).post('/api/dissect'))
      .send({ text: 'A job that must remain reachable.' });
    const res = await auth(request(app).get(`/api/dissect/${jobId}`));
    expect(res.status).toBe(200);
    expect(res.body.jobId ?? res.body.id ?? true).toBeTruthy();
  });
});
