// Bridge between the CodeMirror completion source (no access to React state)
// and the Editor component (owns the inline name-prompt UI + the CodeMirror
// view). The Editor registers a handler on mount; the picker's **New…** row
// invokes it with the entity type and the absolute `from` position (just after
// the opening pair). The Editor then shows the prompt, creates the note via
// POST /api/entity-types/:symbol, and inserts `Name&sym` from `from`.
// Kept separate from symbolPalette (pure registry/parsing) so the completion
// source and the Editor stay decoupled and each is directly unit-testable.

let handler = null;

export function setNewEntityHandler(fn) {
  handler = fn;
}

export function clearNewEntityHandler(fn) {
  if (handler === fn) handler = null;
}

export function hasNewEntityHandler() {
  return typeof handler === 'function';
}

// type: a registry entry from symbolPalette.ENTITY_TYPES.
// from: absolute doc index just after the just-typed opening pair.
export function requestNewEntity(type, from) {
  if (typeof handler === 'function') handler(type, from);
}
