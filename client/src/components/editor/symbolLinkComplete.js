import { api } from '../../api/client.js';
import { parseTrigger, filterEntityNotes, entityNoteUrl } from './symbolPalette.js';
import { hasNewEntityHandler, requestNewEntity } from './entityLinkBridge.js';

export const NEW_ENTITY_LABEL = 'New…';

// Entity-link completion (Phase 2). Trigger when the text just before the cursor
// is a doubled-symbol pair (`!!`, `@@`, `&&`, `$$`, `^^`, `++`) at a clean word
// boundary (see parseTrigger for the `c++` guard). Options: a pinned **New…** row
// plus that type's existing notes (live-filtered by the name typed after the pair).
//
// Existing note → replace the typed range (opening pair onward) with
// `Name&sym` — the opening pair is kept, the closing pair appended.
// New… → hand off to the Editor (bridge), which shows the name prompt, creates the
// entity via POST /api/entity-types/:symbol, and inserts the link from `from`.
export async function entitySource(context) {
  const before = context.matchBefore(/[^]*$/);
  const trigger = parseTrigger(before?.text ?? '');
  if (!trigger) return null;
  const { type, query } = trigger;
  const from = before.from + trigger.pairIndex + 2; // absolute pos after the opening pair

  const replaceWithName = (view, name) => {
    const to = view.state.selection.main.head;
    const insert = `${name}${type.pair}`;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
  };

  let notes = [];
  try {
    const d = await api.get(entityNoteUrl(type.symbol));
    notes = (d.notes ?? []).map(n => n.title);
  } catch { /* keep the "New…" row even if the list fetch fails */ }
  notes = filterEntityNotes(notes, query);

  const options = [
    ...(hasNewEntityHandler()
      ? [{ label: NEW_ENTITY_LABEL, detail: `new ${type.label}`, apply: () => requestNewEntity(type, from) }]
      : []),
    ...notes.map(title => ({ label: title, apply: (view) => replaceWithName(view, title) })),
  ];

  if (!options.length) return null;
  return { from: before.from + trigger.pairIndex, options, validFor: /^[^\n]*$/ };
}
