import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { dissectNote, makeBudget, REQUEST_TIMEOUT_MS } from './aiService.js';
import { broadcast } from '../ws/index.js';

export function createJob(userId, type, input) {
  const id = crypto.randomUUID();
  getDb()
    .prepare('INSERT INTO jobs (id, user_id, type, status, input) VALUES (?, ?, ?, ?, ?)')
    .run(id, userId, type, 'pending', typeof input === 'string' ? input : JSON.stringify(input));
  return id;
}

export function getJob(jobId, userId) {
  return getDb()
    .prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?')
    .get(jobId, userId);
}

// On startup, any job still in 'processing'/'waiting_continue' was mid-flight
// when the process died — it will never complete. Mark them all as failed so
// the UI can stop polling and the user can retry. See B3.
export function reapStalledJobs() {
  const r = getDb()
    .prepare("UPDATE jobs SET status = 'failed', error = 'Server restarted during processing', updated_at = unixepoch() WHERE status IN ('processing', 'waiting_continue')")
    .run();
  if (r.changes > 0) console.log(`[jobs] reaped ${r.changes} stalled job(s) → failed`);
  return r.changes;
}

function updateJob(id, fields) {
  const db = getDb();
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE jobs SET ${sets}, updated_at = unixepoch() WHERE id = ?`)
    .run(...Object.values(fields), id);
}

// jobId -> live dissect job: { controller, cancelled, resolveDecision, rejectDecision }
const runningJobs = new Map();

export function runDissectJob(jobId, userId, rawText) {
  const entry = { controller: new AbortController(), cancelled: false, resolveDecision: null, rejectDecision: null };
  runningJobs.set(jobId, entry);

  const finish = (status, error) => {
    if (status === 'failed' && (!error || !/cancelled/i.test(error))) {
      console.error(`[dissect] job ${jobId} failed:`, error);
    } else {
      console.log(`[dissect] job ${jobId} → ${status}`);
    }
    updateJob(jobId, { status, ...(error ? { error } : {}) });
    const type = status === 'cancelled' ? 'job:cancelled' : 'job:failed';
    broadcast(userId, { type, jobId, error });
  };

  (async () => {
    // One budget shared across every "continue". `makeBudget(0)` means the job
    // starts with no time; we grant a fresh REQUEST_TIMEOUT_MS before each attempt
    // so every "continue" EXTENDS the time the model has to finish.
    const budget = makeBudget(0);
    updateJob(jobId, { status: 'processing' });
    broadcast(userId, { type: 'job:processing', jobId, timeoutMs: REQUEST_TIMEOUT_MS });

    let notes;
    let initialMessages = null; // conversation so far — let a "continue" resume where it stopped
    for (;;) {
      if (entry.cancelled) throw Object.assign(new Error('Cancelled by user'), { cancelled: true });
      budget.grantMoreTime(REQUEST_TIMEOUT_MS); // fresh 30-minute window for this attempt
      console.log(`[dissect] job ${jobId} calling the model`);
      try {
        notes = await dissectNote(rawText, { budget, signal: entry.controller.signal, initialMessages });
        break;
      } catch (e) {
        if (entry.cancelled || e?.cancelled || e?.name === 'AbortError') throw Object.assign(new Error('Cancelled by user'), { cancelled: true });
        if (e?.name !== 'TimeoutError') throw e;

        // Keep what the model produced so the next attempt resumes from here
        // instead of re-dissecting rawText from scratch.
        initialMessages = e.partialMessages ?? initialMessages;

        // Turn outlived the window: let the user decide — continue or cancel.
        updateJob(jobId, { status: 'waiting_continue' });
        broadcast(userId, { type: 'job:waiting_continue', jobId });
        console.log(`[dissect] job ${jobId} timed out, waiting for user decision`);
        await new Promise((resolve, reject) => {
          entry.resolveDecision = resolve;
          entry.rejectDecision = reject;
        }).catch(err => { throw err; });
        // Fresh signal so a stale abort from the cancelled turn doesn't fire.
        entry.controller = new AbortController();
      }
    }
    console.log(`[dissect] job ${jobId} got ${notes.length} notes`);

    const db = getDb();

    // Check for collisions with existing vault notes
    const withCollisions = notes.map(note => {
      const slug = `${note.title}.md`;
      const exists = db
        .prepare('SELECT 1 FROM notes WHERE user_id = ? AND title = ?')
        .get(userId, note.title);
      return { ...note, slug, collision: !!exists };
    });

    updateJob(jobId, { status: 'preview', result: JSON.stringify(withCollisions) });
    broadcast(userId, { type: 'job:preview', jobId, notes: withCollisions });
    console.log(`[dissect] job ${jobId} preview broadcast sent to user ${userId}`);
  })()
    .catch(e => {
      const cancelled = entry.cancelled || e?.cancelled === true || /cancelled/i.test(String(e?.message));
      finish(cancelled ? 'cancelled' : 'failed', e?.message ?? String(e));
    })
    .finally(() => {
      runningJobs.delete(jobId);
    });

  return new Promise(() => {}); // never settles; lifecycle lives in the job row
}

export function cancelDissectJob(jobId) {
  const entry = runningJobs.get(jobId);
  if (!entry) return false;
  entry.cancelled = true;
  entry.rejectDecision?.(Object.assign(new Error('Cancelled by user'), { cancelled: true }));
  entry.controller?.abort('cancelled');
  return true;
}

export function continueDissectJob(jobId) {
  const entry = runningJobs.get(jobId);
  if (!entry) return false;
  const resolve = entry.resolveDecision;
  entry.resolveDecision = null;
  resolve?.();
  return true;
}
