import { beforeEach, describe, it, expect, vi } from 'vitest';
import { setTestEnv, makeTmpVault, cleanupTmpVault, setupDb } from './helpers.js';
import { getDb } from '../db/index.js';
import { createJob, reapStalledJobs, runDissectJob, continueDissectJob } from '../services/jobService.js';
import { dissectNote } from '../services/aiService.js';

vi.mock('../ws/index.js', () => ({ broadcast: vi.fn() }));
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
  dissectNote: vi.fn(),
}));

let tmpDir;
beforeEach(async () => {
  setTestEnv();
  tmpDir = await makeTmpVault();
  const db = setupDb();
  db.prepare("INSERT INTO users (id, email, password) VALUES (1, 'u1@t.com', 'x')").run();
  dissectNote.mockReset();
  dissectNote.mockResolvedValue([{ title: 'N', content: 'c' }]);
});

describe('reapStalledJobs (B3)', () => {
  it('marks processing jobs as failed and leaves others alone', () => {
    const db = getDb();
    const stalled = createJob(1, 'dissect', 'stuck input');
    const pending = createJob(1, 'dissect', 'pending input');
    const done = createJob(1, 'dissect', 'done input');

    db.prepare("UPDATE jobs SET status = 'processing' WHERE id = ?").run(stalled);
    db.prepare("UPDATE jobs SET status = 'complete' WHERE id = ?").run(done);

    const r = reapStalledJobs();
    expect(r).toBe(1);

    expect(db.prepare('SELECT status, error FROM jobs WHERE id = ?').get(stalled)).toEqual({
      status: 'failed',
      error: 'Server restarted during processing',
    });
    expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(pending).status).toBe('pending');
    expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(done).status).toBe('complete');
  });

  it('is a no-op when nothing is stuck', () => {
    createJob(1, 'dissect', 'x');
    expect(reapStalledJobs()).toBe(0);
  });
});

describe('runDissectJob + continue', () => {
  async function waitForStatus(jobId, target, maxMs = 2000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const j = getDb().prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
      if (j.status === target) return j;
      await new Promise(r => setTimeout(r, 10));
    }
    const j = getDb().prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    await expect(j.status).toBe(target);
  }

  it('lets "continue" extend the SAME budget and resume the partial conversation', async () => {
    const partial = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'raw' },
      { role: 'assistant', content: 'worked so far' },
    ];
    const optsForCall = [];
    dissectNote.mockImplementation((_text, opts) => {
      optsForCall.push(opts);
      if (optsForCall.length === 1) {
        const e = new Error('too slow');
        e.name = 'TimeoutError';
        e.partialMessages = partial; // progress the model made before stalling
        return Promise.reject(e);
      }
      return Promise.resolve([{ title: 'Done', content: 'c' }]);
    });

    const jobId = createJob(1, 'dissect', 'some raw text');
    runDissectJob(jobId, 1, 'some raw text');

    await waitForStatus(jobId, 'waiting_continue');
    // First attempt: a shared budget exists; no prior conversation to resume.
    expect(optsForCall[0].budget).toBeTruthy();
    expect(optsForCall[0].initialMessages).toBeNull();

    expect(continueDissectJob(jobId)).toBe(true);
    await waitForStatus(jobId, 'preview');

    // Second attempt runs on the SAME budget object (time EXTENDED, not reset)
    // and resumes from the conversation built on the first attempt.
    expect(optsForCall[1].budget).toBe(optsForCall[0].budget);
    expect(optsForCall[1].initialMessages).toEqual(partial);
  });
});
