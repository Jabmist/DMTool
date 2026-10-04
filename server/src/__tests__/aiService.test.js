import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeNotes, dissectNote, makeBudget, warmModel } from '../services/aiService.js';

describe('normalizeNotes', () => {
  it('accepts a parsed object arguments payload', () => {
    const out = normalizeNotes({ notes: [{ title: 'A', content: 'x' }] });
    expect(out).toEqual([{ title: 'A', content: 'x' }]);
  });

  it('accepts a JSON-string arguments payload', () => {
    const out = normalizeNotes(JSON.stringify({ notes: [{ title: 'A', content: 'x' }] }));
    expect(out).toEqual([{ title: 'A', content: 'x' }]);
  });

  it('accepts a top-level bare array', () => {
    const out = normalizeNotes([{ title: 'A', content: 'x' }, { title: 'B', content: 'y' }]);
    expect(out).toHaveLength(2);
  });

  it('coerces string notes into titled notes (gpt-oss shortcut)', () => {
    const out = normalizeNotes({ notes: ['Photosynthesis converts light into chemical energy.'] });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBeTruthy();
    expect(out[0].content).toMatch(/photosynthesis/i);
  });

  it('repairs slightly-broken JSON (single quotes, unquoted keys)', () => {
    const out = normalizeNotes("{'notes': [{title:'A', content:'x'}]}");
    expect(out).toEqual([{ title: 'A', content: 'x' }]);
    const out2 = normalizeNotes(JSON.stringify([{ title: 'A', content: 'x' }]));
    expect(out2).toEqual([{ title: 'A', content: 'x' }]);
  });

  it('throws when the payload has no usable notes', () => {
    expect(() => normalizeNotes({ foo: 1 })).toThrow();
    expect(() => normalizeNotes({ notes: undefined })).toThrow();
    expect(() => normalizeNotes(42)).toThrow();
    expect(() => normalizeNotes(undefined)).toThrow();
  });

  it('wraps a lone prose string into a single titled note', () => {
    const out = normalizeNotes('The mitochondria is the powerhouse of the cell.');
    expect(out).toHaveLength(1);
    expect(out[0].content).toContain('mitochondria');
    expect(out[0].title).toBeTruthy();
  });
});

describe('dissectNote', () => {
  function streamResponse(chunks, { status = 200 } = {}) {
    const payload = chunks.join('\n');
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => 'internal error',
      body: stream,
    };
  }

  const toolEvent = (name, argsChunk) => JSON.stringify({
    message: { role: 'assistant', tool_calls: [{ function: { name, arguments: argsChunk } }] },
    done: false,
  });
  const doneEvent = JSON.stringify({ done: true, done_reason: 'stop' });

  it('POSTs a streaming /api/chat turn and aggregates tool_calls chunks', async () => {
    const argsPart1 = '{"notes":[{"title":"A","cont';
    const argsPart2 = 'ent":"x"}]}';
    let fetchMock;
    fetchMock = vi.fn().mockResolvedValue(streamResponse([toolEvent('produce_notes', argsPart1), toolEvent('produce_notes', argsPart2), doneEvent]));
    globalThis.fetch = fetchMock;

    const out = await dissectNote('my input text');
    expect(out).toEqual([{ title: 'A', content: 'x' }]);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/chat$/);
    const body = JSON.parse(opts.body);
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0);
    expect(body.tools[0].function.name).toBe('produce_notes');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1]).toEqual({ role: 'user', content: 'my input text' });
  });

  it('falls back to message.content when the model skips the tool', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(streamResponse([
      JSON.stringify({ message: { content: JSON.stringify({ notes: [{ title: 'A', content: 'x' }] }) }, done: true }),
    ]));
    expect(await dissectNote('i')).toEqual([{ title: 'A', content: 'x' }]);
  });

  it('rejects as TimeoutError when the model stalls every turn', async () => {
    globalThis.fetch = vi.fn((url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const p = dissectNote('i', { timeoutMs: 30 });
    await expect(p).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts immediately with the cancellation reason when the signal fires', async () => {
    let rejectFetch;
    globalThis.fetch = vi.fn((url, opts) => new Promise((_, reject) => {
      rejectFetch = reject;
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const controller = new AbortController();
    const p = dissectNote('i', { timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => { controller.abort('cancelled'); rejectFetch?.(new Error('socket closed')); }, 10);
    await expect(p).rejects.toThrow(/Cancelled/);
  });

  it('rejects when the model returns no usable message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(streamResponse([
      JSON.stringify({ message: { content: '' }, done: true }),
      doneEvent,
    ]));
    await expect(dissectNote('i')).rejects.toThrow(/did not return notes/);
  });

  it('rejects an empty prose turn after exhausting continuations', async () => {
    globalThis.fetch = vi.fn((url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    await expect(dissectNote('i', { timeoutMs: 30 })).rejects.toThrow(/did not return notes|without finishing/);
  });

  it('times out at the budget ceiling, not after a fresh window each retry', async () => {
    // A single stall that outlives the budget → TimeoutError.
    globalThis.fetch = vi.fn((url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const budget = makeBudget(30);
    const p = dissectNote('i', { budget });
    await expect(p).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('keeps one shared, extendable deadline rather than a per-attempt window', async () => {
    // `grantMoreTime` ADDS to the deadline (it never shrinks it) — that's the
    // mechanism "continue" relies on to extend the model's time.
    const budget = makeBudget(100);
    expect(budget.remainingMs()).toBeGreaterThan(0);
    budget.grantMoreTime(100);
    // After +100ms the deadline must still be ~100ms ahead, not the ~0 a reset clock would give.
    expect(budget.remainingMs()).toBeGreaterThan(50);
  });

  it('attaches the partial conversation to the timeout error for resumption', async () => {
    globalThis.fetch = vi.fn((url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const budget = makeBudget(30);
    try {
      await dissectNote('i', { budget });
      expect.unreachable('should have timed out');
    } catch (e) {
      expect(e.name).toBe('TimeoutError');
      expect(Array.isArray(e.partialMessages)).toBe(true);
      expect(e.partialMessages[0].role).toBe('system');
    }
  });

  it('resumes from initialMessages instead of rebuilding from rawText', async () => {
    const captured = [];
    globalThis.fetch = vi.fn((url, opts) => {
      captured.push(JSON.parse(opts.body).messages);
      return new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    });
    // Simulate a resumed conversation where the assistant already did work.
    const resumed = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'raw' },
      { role: 'assistant', content: 'partial so far' },
    ];
    const budget = makeBudget(30);
    try {
      await dissectNote('i', { budget, initialMessages: resumed });
      expect.unreachable('should have timed out');
    } catch { /* expected */ }

    // The outgoing turn must carry the RESUMED conversation (with the assistant turn),
    // not a freshly rebuilt [system, user] pair.
    const sent = captured[0];
    expect(sent).toHaveLength(resumed.length);
    expect(sent.find(m => m.role === 'assistant' && m.content === 'partial so far')).toBeTruthy();
  });

  it('surfaces a non-OK HTTP status from Ollama', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(streamResponse([], { status: 500 }));
    await expect(dissectNote('i')).rejects.toThrow(/HTTP 500/);
  });
});

describe('warmModel (preload)', () => {
  function plainResponse(body, { status = 200 } = {}) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => 'internal error',
      body: { cancel: async () => {} },
    };
  }

  afterEach(() => {
    if (globalThis.fetch) vi.restoreAllMocks();
  });

  it('POSTs a single non-streaming "hi" turn and resolves with warmed=true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(plainResponse({ message: 'ok' }));
    globalThis.fetch = fetchMock;

    const out = await warmModel();
    expect(out).toMatchObject({ warmed: true });
    expect(out.ms).toBeGreaterThanOrEqual(0);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/chat$/);
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBeLessThanOrEqual(8);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.tools).toBeUndefined();
  });

  it('coalesces concurrent calls into ONE request and shares the promise', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockImplementation(() => new Promise(res =>
      setTimeout(() => res(plainResponse({})), 30)));
    globalThis.fetch = fetchMock;

    const a = warmModel();
    const b = warmModel();
    expect(b).toBe(a);
    await a;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves with warmed=false (never throws) when Ollama is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await warmModel();
    expect(out.warmed).toBe(false);
    expect(out.reason).toMatch(/ECONNREFUSED/);
  });

  it('resolves with warmed=false on a non-OK HTTP status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(plainResponse({}, { status: 404 }));
    const out = await warmModel();
    expect(out.warmed).toBe(false);
    expect(out.reason).toMatch(/HTTP 404/);
  });

  it('allows a fresh warm-up after a settled one (promise slot is released)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(plainResponse({}));
    await warmModel();
    const next = warmModel();
    // The slot was re-armed: a new promise, and a second HTTP call happens.
    await next;
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
