// Client-side mirror of the server registry (server/src/entityTypes.js) — the
// six fixed entity types with collision-free doubled-symbol link forms.
//
// Kept as a tiny static table (symbols/labels are v1-locked and never served
// per-request) so the CodeMirror completion source and the New… dialog can map
// a typed symbol pair (e.g. `&&`) to its type without a network round-trip.
// The single source of truth for the *server* remains entityTypes.js; the two
// must stay in sync (same order, same symbols).

export const ENTITY_TYPES = [
  { symbol: '!', name: 'event',    label: 'Event',    pair: '!!' },
  { symbol: '@', name: 'location', label: 'Location', pair: '@@' },
  { symbol: '&', name: 'npc',      label: 'NPC',      pair: '&&' },
  { symbol: '$', name: 'item',     label: 'Item',     pair: '$$' },
  { symbol: '^', name: 'trap',     label: 'Trap',     pair: '^^' },
  { symbol: '+', name: 'player',   label: 'Player',   pair: '++' },
];

export const ENTITY_PAIRS = ENTITY_TYPES.map(t => t.pair);
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PAIR_ALT = ENTITY_PAIRS.map(escapeRe).join('|');

// Match a doubled-symbol pair somewhere in the text before the cursor, with a
// look-behind that requires a non-word char (line start, space, etc.) right
// before the pair — so `c++`, `++i`, or a lone symbol inside a word does NOT
// trigger the picker (the "C++ guard" from the Phase 2 spec). Everything after
// the pair (the name being typed) becomes the live-filter query.
//
//   parseTrigger('Meet &&Bo')  →  { type: npc,  query: 'Bo' }
//   parseTrigger('c++ is fun') →  null   (pair not at a clean boundary)
export function parseTrigger(textBeforeCursor) {
  const m = new RegExp(`(?<![\\w])(${PAIR_ALT})([^\\n]*)$`).exec(textBeforeCursor);
  if (!m) return null;
  const type = ENTITY_TYPES.find(t => t.pair === m[1]);
  if (!type) return null;
  return { type, query: m[2], pairIndex: m.index };
}

// Convenience: just the type (or null) for cursor-anchored checks.
export function symbolTypeFromPair(textBeforeCursor) {
  return parseTrigger(textBeforeCursor)?.type ?? null;
}

export function entityNoteUrl(symbol) {
  return `/api/entity-types/${encodeURIComponent(symbol)}/notes`;
}

export function createEntityUrl(symbol) {
  return `/api/entity-types/${encodeURIComponent(symbol)}`;
}

// Filter a type's notes by the live query (case-insensitive substring). An empty
// query returns all — the picker should show the full list when only the pair
// has been typed.
export function filterEntityNotes(notes, query) {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return notes;
  return notes.filter(n => n.toLowerCase().includes(q));
}

