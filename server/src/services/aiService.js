import { jsonrepair } from 'jsonrepair';

// Local Ollama server (OpenAI-compatible /api/chat). Point these at your setup.
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? 'http://192.168.1.173:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'gemini-gemma4:12b';
const MAX_TOKENS = parseInt(process.env.OLLAMA_MAX_TOKENS, 10) || 8192;
// Local LLMs are slow — give generation generous headroom.
export const REQUEST_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 1_800_000;

// ── Dissect debugging ─────────────────────────────────────────────────────────
// DISSECT_DEBUG=1 lifts the truncation limit and logs the full raw model output
// (content + tool-call arguments) so we can see exactly what the model returns.
export const DISSECT_DEBUG = process.env.DISSECT_DEBUG === '1';
const TRUNC_LIMIT = DISSECT_DEBUG ? 100_000 : 4_000;
function trunc(s, n = TRUNC_LIMIT) {
  if (s === undefined || s === null) s = '';
  if (typeof s !== 'string') { try { s = JSON.stringify(s); } catch { s = String(s); } }
  s = String(s);
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n} chars)` : s;
}
const aiLog = (...a) => console.log('[ai]', ...a);
const aiErr = (...a) => console.error('[ai]', ...a);

const DISSECT_TOOL = {
  type: 'function',
  function: {
    name: 'produce_notes',
    description: 'Output the dissected atomic notes',
    parameters: {
      type: 'object',
      properties: {
        notes: {
          type: 'array',
          description: 'One atomic note per distinct concept; when there is more than one, also include one summary note that links to all the others',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Concise, slug-friendly note title (3–8 words)' },
              content: { type: 'string', description: 'Markdown content for this note, with [[wikilinks]] to other notes in this set' },
              isSummary: { type: 'boolean', description: 'Set true ONLY on the single summary note (the one that links to all the others). Omit or set false on every other note.' },
            },
            required: ['title', 'content'],
          },
        },
      },
      required: ['notes'],
    },
  },
};

const SYSTEM_PROMPT = `You are a note formatting engine. Your only job is to take raw input text and reorganise it into one or more markdown notes. You are NOT having a conversation. Do not answer, interpret, explain, or respond to the content — treat it purely as material to be organised.

COVERAGE: Every piece of information in the input must appear in exactly one output note. Nothing may be dropped, skipped, or summarised away. The output notes together must contain all of the input content, no more and no less.

SPLITTING: Decide note boundaries by topic, not by line breaks or paragraph count.
- If all the input belongs to one topic, produce one note.
- If the input clearly covers multiple distinct topics that would be useful to reference independently, produce one note per topic.
- Do NOT split a single coherent idea into multiple notes just because it spans several lines.

SUMMARY: If you produce multiple notes, the set must also include one summary note. It gives a short overview of the whole input and links to every other note in the set with [[wikilinks]]. It is additional to the other notes — it must not replace or shorten them. Mark that one summary note with "isSummary": true so the client can group the set into a notebook named after it. If the input became a single note, do not add a summary and do not set isSummary on it.

CONTENT: Copy and lightly reformat the source text into markdown. Do not add facts, explanations, or sentences that are not in the input. Do not answer questions in the text — preserve them as-is.

WIKILINKS: Where one note refers to a concept covered in another note in this set, use [[Note Title]] syntax.

TITLES: Concise, descriptive, 3–8 words. Derived from the content, not invented.

Always call the produce_notes tool to return your answer. Never reply in plain text.`;

// Run one streaming turn against Ollama. Resolves with `notes` when the model
// called the produce_notes tool (or its content carried them), otherwise with
// `message` — the partial/empty content the turn produced, which the caller
// feeds back into the next turn.
async function runTurn(messages, signal) {
  const lastUser = messages.filter(m => m.role === 'user').pop();
  aiLog(`runTurn start model=${OLLAMA_MODEL} base=${OLLAMA_BASE} msgs=${messages.length} ` +
    `lastUser=${trunc(lastUser?.content, 200)}`);
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: true,
      temperature: 0,
      max_tokens: MAX_TOKENS,
      tools: [DISSECT_TOOL],
      messages,
    }),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    await res.body?.cancel().catch(() => {});
    throw new Error(`Ollama returned HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  if (!res.body) throw new Error('Ollama returned no response body');

  aiLog(`runTurn HTTP ${res.status} ${res.statusText ?? ''} streaming=${res.body ? 'yes' : 'NO'}`);
  let content = '';
  let eventCount = 0;
  const toolCalls = {};
  for await (const line of streamLines(res.body)) {
    if (!line) continue;
    for (const evt of NDJSON_EVENTS(line)) {
      eventCount++;
      const m = evt?.message;
      if (m?.content) content += m.content;
      if (Array.isArray(m?.tool_calls)) {
        m.tool_calls.forEach((tc, ci) => {
          if (!tc?.function) return;
          const cur = (toolCalls[ci] ??= { name: '', arguments: '' });
          cur.name = tc.function.name ?? cur.name;
          const a = tc.function.arguments;
          if (a === undefined || a === null) return;
          // Some servers (Ollama/qwen) deliver `arguments` already parsed as an
          // object; the OpenAI streaming convention delivers streamed string
          // chunks that must be concatenated. Handle both — string-concatenating
          // an object is what produced the "object Object" garbage note.
          if (typeof a === 'string') cur.arguments += a;
          else cur.arguments = a;
        });
      }
      if (evt?.done_error) throw new Error(String(evt.done_error));
    }
  }

  aiLog(`runTurn stream done events=${eventCount} contentLen=${content.length} ` +
    `toolCalls=${Object.values(toolCalls).map(t => `${t.name}(${trunc(t.arguments, 160)})`).join(' | ') || 'none'} ` +
    `contentHead=${JSON.stringify(trunc(content, 300))}`);

  for (const [ci, tc] of Object.entries(toolCalls)) {
    if (!tc.name || !tc.arguments) {
      aiLog(`tool_call[${ci}] INCOMPLETE name=${tc.name ?? '(none)'} argsLen=${tc.arguments?.length ?? 0} — skipped (never parse)`);
      continue;
    }
    try {
      const notes = normalizeNotes(tc.arguments);
      aiLog(`tool_call[${ci}] PARSED OK → ${notes.length} notes: ${notes.map(n => n.title).join(' / ')}`);
      return { notes };
    } catch (e) {
      aiErr(`tool_call[${ci}] parse FAILED: ${e.message}`);
      aiErr(`tool_call[${ci}] args were: ${JSON.stringify(trunc(tc.arguments))}`);
      // fall through; another call or the content may still carry the notes
    }
  }
  if (content) {
    try {
      const notes = normalizeNotes(content);
      aiLog(`content fallback PARSED OK → ${notes.length} notes`);
      return { notes };
    } catch (e) {
      aiErr(`content fallback parse FAILED: ${e.message} (contentHead=${JSON.stringify(trunc(content, 400))})`);
      // not parseable yet — treat content as progress and let the caller decide
    }
  }
  aiLog(`runTurn returning message (no notes): len=${content.length} head=${JSON.stringify(trunc(content, 300))}`);
  return { message: content };
}

async function* streamLines(reader) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of reader) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) yield line;
    }
  }
  const tail = buf.trim();
  if (tail) yield tail;
}

// An NDJSON event may be a JSON array of events as well as a plain object.
function* NDJSON_EVENTS(line) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    return;
  }
  if (Array.isArray(evt)) yield* evt;
  else yield evt;
}

const MAX_TURNS = 20;

// A job-level wall of time. Every turn (across every "continue") draws from the
// SAME budget instead of each getting a fresh 30-minute window. `grantMoreTime` adds
// another chunk to the deadline, so "continue" EXTENDS the time remaining rather
// than resetting the clock.
export function makeBudget(initialMs = REQUEST_TIMEOUT_MS) {
  let deadline = Date.now() + initialMs;
  return {
    chunkMs: initialMs,
    remainingMs() { return Math.max(0, deadline - Date.now()); },
    grantMoreTime(ms) { deadline = Math.max(deadline, Date.now() + ms); },
  };
}

function makeTimeoutError(chunkMs, messages) {
  const t = new Error(`Ollama at ${OLLAMA_BASE} took longer than ${chunkMs / 1000}s without finishing.`);
  t.name = 'TimeoutError';
  // The conversation built so far — the caller can hand this back in via
  // `initialMessages` so a "continue" resumes where the model left off instead
  // of re-dissecting the raw input from scratch.
  t.partialMessages = messages;
  return t;
}

export async function dissectNote(rawText, { timeoutMs = REQUEST_TIMEOUT_MS, budget = null, signal, initialMessages = null } = {}) {
  const b = budget ?? makeBudget(timeoutMs);
  let messages = initialMessages ?? [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: rawText },
  ];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    if (signal?.aborted) throw abortError(signal);
    if (b.remainingMs() <= 0) throw makeTimeoutError(b.chunkMs, messages);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), b.remainingMs());
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    let out;
    try {
      out = await runTurn(messages, controller.signal);
    } catch (e) {
      if (signal?.aborted) {
        throw abortError(signal);
      }
      if (controller.signal.aborted) throw makeTimeoutError(b.chunkMs, messages);
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }

    if (out.notes) {
      aiLog(`dissectNote turn ${turn}: GOT ${out.notes.length} notes`);
      return out.notes;
    }
    if (!out.message) { aiLog(`dissectNote turn ${turn}: empty response — stopping loop`); break; }
    aiLog(`dissectNote turn ${turn}: no notes, message len=${out.message.length} head=${JSON.stringify(trunc(out.message, 200))}`);
    messages.push({ role: 'assistant', content: out.message });
    messages.push({
      role: 'user',
      content: 'Keep going. Finish the dissection and return ALL the notes now — call the produce_notes tool with the complete list.',
    });
  }
  aiErr(`dissectNote EXHAUSTED (model=${OLLAMA_MODEL}, maxTurns=${MAX_TURNS}). ` +
    `last assistant content: ${JSON.stringify(trunc(messages.filter(m => m.role === 'assistant').pop()?.content))} ` +
    `last user prompt: ${JSON.stringify(trunc(messages.filter(m => m.role === 'user').pop()?.content, 300))}`);
  throw new Error('Model did not return notes (model=' + OLLAMA_MODEL + '). See [ai] logs for the raw output.');
}

// ── Model preload (warm-up) ──────────────────────────────────────────────────
// Fire a trivial one-token "hi" turn at Ollama. The expensive part of a cold
// start is Ollama loading the model's weights into memory — that loading
// begins as soon as any request for the model is accepted, so even a request
// we abandon leaves the model loaded (Ollama keeps it resident for its
// default keep-alive window). A real dissection issued right after therefore
// skips the load latency.
//
// Concurrency: callers get the SAME in-flight promise; repeat calls while the
// warm-up is running never spawn a second request.
//
// This NEVER throws — it resolves with a result object so the HTTP caller can
// answer 202 immediately while the warm-up settles in the background. The only
// "failure" is a client-side timeout giving up on waiting; loading may still
// be happening on the Ollama side.
const WARM_TIMEOUT_MS = parseInt(process.env.OLLAMA_WARM_TIMEOUT_MS, 10) || 120_000;

let warmPromise = null;

export function warmModel() {
  if (warmPromise) return warmPromise;
  const startedAt = Date.now();
  aiLog(`warm: start model=${OLLAMA_MODEL} base=${OLLAMA_BASE} timeoutMs=${WARM_TIMEOUT_MS}`);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    aiLog(`warm: stopped waiting after ${Date.now() - startedAt}ms (model loads may still finish on the Ollama side)`);
    controller.abort();
  }, WARM_TIMEOUT_MS);
  warmPromise = (async () => {
    try {
      const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          stream: false,
          temperature: 0,
          max_tokens: 4,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Ollama returned HTTP ${res.status}: ${detail.slice(0, 200)}`);
      }
      await res.body?.cancel().catch(() => {});
      aiLog(`warm: ok in ${Date.now() - startedAt}ms — model is now loaded`);
      return { warmed: true, ms: Date.now() - startedAt };
    } catch (e) {
      const ms = Date.now() - startedAt;
      const aborted = controller.signal.aborted;
      aiLog(`warm: ${aborted ? 'timeout' : 'error'} after ${ms}ms: ${e?.message ?? e}`);
      return { warmed: false, reason: aborted ? 'timeout' : e?.message ?? String(e) };
    } finally {
      clearTimeout(timer);
      warmPromise = null;
    }
  })();
  return warmPromise;
}

function abortError(signal) {
  const e = new Error(
    signal?.reason === 'cancelled'
      ? 'Cancelled: Ollama at ' + OLLAMA_BASE + ' was interrupted.'
      : `Ollama at ${OLLAMA_BASE} took longer than ${REQUEST_TIMEOUT_MS / 1000}s without finishing.`,
  );
  e.name = signal?.reason === 'cancelled' ? 'AbortError' : 'TimeoutError';
  return e;
}

function parseJsonish(value) {
  // Returns the parsed value, or null if `value` is not valid JSON.
  if (typeof value === 'string') {
    try {
      return JSON.parse(jsonrepair(value));
    } catch {
      return null;
    }
  }
  return value;
}

export function normalizeNotes(source) {
  // arguments may be an object (already parsed), a JSON string, a JSON string
  // describing a top-level array, or a plain prose string.
  const parsed = parseJsonish(source);
  const isStr = typeof source === 'string';
  aiLog(`normalizeNotes in: srcType=${isStr ? 'string(len=' + String(source).length + ')' : typeof source} ` +
    `parsedType=${parsed === null ? 'null (JSON parse failed)' : Array.isArray(parsed) ? 'array(' + parsed.length + ')' : typeof parsed}${
      parsed && !Array.isArray(parsed) && typeof parsed === 'object' ? ' keys=[' + Object.keys(parsed).join(',') + ']' : ''
    }`);
  const notes = parsed !== null ? (parsed.notes ?? parsed) : parsed;

  if (notes === undefined || notes === null) {
    throw new Error('Model returned no notes (expected an array of { title, content }).');
  }
  if (!Array.isArray(notes)) {
    if (typeof notes === 'string') return [{ title: deriveTitle(notes), content: notes }];
    throw new Error('Model returned notes in an unexpected format (expected an array of { title, content }).');
  }

  return notes.map(note => {
    if (typeof note === 'string') {
      // Some models shortcut the schema and emit a bare string per note.
      return { title: deriveTitle(note), content: note };
    }
    if (note && typeof note.title === 'string' && note.content !== undefined) {
      const out = { title: note.title, content: String(note.content) };
      if (note.isSummary === true) out.isSummary = true;
      return out;
    }
    throw new Error('A note is missing its title or content');
  });
}

function deriveTitle(text) {
  const first = String(text).replace(/^[#>\-\s\[]+/, '').split('\n')[0].trim();
  const slug = (first.length > 48 ? `${first.slice(0, 48).trim()}…` : first) || 'Untitled note';
  return slug.replace(/[\\/:*?"<>|]/g, ' ').trim();
}
