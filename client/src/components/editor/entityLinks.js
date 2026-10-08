// DMTool entity links (Phase 2). Each of the six symbols, doubled on BOTH sides
// of a display name, is an inline link — `&&Borg the Black&&`, `!!Council!!` —
// see server/src/entityTypes.js for the registry.
//
// `preprocessEntityLinks` rewrites every such span into a standard markdown link
// on the `wiki:` protocol that NotePreview already allows and resolves through
// the existing `GET /api/notes/resolve?title=` path. It MUST run before
// remark-gfm parses (in NotePreview) so `$$Item$$` and `++Player++` are not
// consumed by GFM's emphasis/strikethrough/autolink rules.
//
// A pair only becomes a link when the SAME symbol is doubled on both sides; a
// mismatched pair (e.g. `!!x@@`) is left untouched.

export const ENTITY_LINK_PAIRS = ['!!', '@@', '&&', '$$', '^^', '++'];

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PAIR_ALT = ENTITY_LINK_PAIRS.map(escapeRe).join('|');
// The display name: any non-newline char (spaces allowed), non-greedy so the
// match stops at the first closing pair. Single-line + non-greedy keeps
// adjacent links and cross-paragraph text from bleeding into one span.
const NAME_CLASS = '[^\\n]+?';
// A non-word char must bracket the pair so `c++ and ++` (C++ code, or stray
// `+`s) is NOT treated as a link — mirroring the autocomplete trigger guard.
// Group 1 = opening pair, group 2 = name, group 3 = closing pair.
export const ENTITY_LINK_RE = new RegExp(
  `(?<!\\w)(${PAIR_ALT})(${NAME_CLASS})(${PAIR_ALT})(?!\\w)`,
  'g',
);

export function preprocessEntityLinks(content) {
  return String(content).replace(ENTITY_LINK_RE, (m, open, name, close) => {
    const label = name.trim();
    if (!label || open !== close) return m; // no close / mixed pair → leave raw
    return `[${label}](wiki:${encodeURIComponent(label)})`;
  });
}
