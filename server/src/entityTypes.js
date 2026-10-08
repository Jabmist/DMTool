// Entity-type registry — the single source of truth for DMTool's six fixed
// entity kinds (D1–D3). No DB: this is a type descriptor. Every other module
// (migration, routes, seeding, indexService) imports from here.
//
// Link model (locked D1/D2): an inline link is the symbol doubled on both
// sides of the entity's display name — `&&Borg the Black&&`, `!!Council Summit!!`.
// Never use `#` (tag collision) or `*` (bold collision).

export const ENTITY_TYPES = [
  { symbol: '!', name: 'event',    label: 'Event',    labelPlural: 'Events' },
  { symbol: '@', name: 'location', label: 'Location', labelPlural: 'Locations' },
  { symbol: '&', name: 'npc',      label: 'NPC',      labelPlural: 'NPCs' },
  { symbol: '$', name: 'item',     label: 'Item',     labelPlural: 'Items' },
  { symbol: '^', name: 'trap',     label: 'Trap',     labelPlural: 'Traps' },
  { symbol: '+', name: 'player',   label: 'Player',   labelPlural: 'Players' },
];

// The one-char symbols, as a Set, for fast membership checks (e.g. frontmatter
// parsing in indexService).
export const ENTITY_SYMBOLS = new Set(ENTITY_TYPES.map(t => t.symbol));

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Resolve a registry entry by its symbol. Returns undefined for unknown input
// (callers decide whether that's an error).
export function bySymbol(symbol) {
  return ENTITY_TYPES.find(t => t.symbol === symbol);
}

// Resolve a registry entry by its name (e.g. 'npc'). Returns undefined if
// not found.
export function byName(name) {
  return ENTITY_TYPES.find(t => t.name === name);
}

// A global regex that matches one inline link for the given symbol and
// captures the entity's display name between the doubled symbols.
//   linkRegex('&')  →  /&&([^&]+)&&/g        (matches "&&Borg the Black&&")
//   linkRegex('+')  →  /\+\+([^\+]+)\+\+/g   (matches "++Aria++")
// The name class excludes the symbol char so the match can never bleed into a
// following link of the same type. Intended for Phase-2 extraction + the
// client's preview preprocessor.
export function linkRegex(symbol) {
  const entry = bySymbol(symbol);
  if (!entry) throw new Error(`Unknown entity symbol: ${symbol}`);
  const esc = escapeRegExp(entry.symbol);
  return new RegExp(esc + esc + '([^' + esc + ']+)' + esc + esc, 'g');
}

// Seed-notebook name for a type = its label + 's' (Q3: plain names, no symbol
// prefix). The name is the symbol→notebook binding, and it is safe because the
// six seed notebooks are rename-locked (see routes/notebooks.js PATCH guard).
export function seedNotebookName(label) {
  return `${label}s`;
}

// The six protected seed-notebook names. Used by the rename lock.
export const SEED_NOTEBOOK_NAMES = new Set(
  ENTITY_TYPES.map(t => seedNotebookName(t.label)),
);

// Build the vault-relative path for an entity note (Q4/Q5):
//   entities/<type-name>/<safeName>.md
// Pure join — no slugify, never changes case or spaces, so the filename stays
// byte-identical to the link's display name (the resolve-by-title invariant
// from Q5/Q6). `type` is a registry entry (or name) and `entityName` is the
// already-sanitized display name.
export function entityPath(type, entityName) {
  const entry = (type && typeof type === 'object' && type.name)
    ? type
    : byName(type) ?? bySymbol(type) ?? { name: type };
  return `entities/${entry.name}/${entityName}.md`;
}

// Forbidden filename chars (same set import.js' sanitizeFilename enforces,
// plus C0 controls):  / \ < > : " | ? *
const FORBIDDEN_NAME_RE = /[/\\<>:"|?*\u0000-\u001f]/;
const MAX_NAME_LEN = 200;

// Sanitize an entity's display name for use as a filename (Q5). This is a
// *safety* transform only — it must never change case or convert spaces to
// dashes, or the byte-exact name↔link equality breaks. If the name contains
// any forbidden char it is rejected wholesale (return '') rather than
// rewritten: the caller then 400s. Spaces are kept (they are the point).
export function safeEntityName(name) {
  if (typeof name !== 'string') return '';
  if (FORBIDDEN_NAME_RE.test(name)) return '';
  return name.trim().slice(0, MAX_NAME_LEN);
}

// Default (Q2) starter template content per type — the fill-in shape used when
// seeding a user's per-user template rows at registration and as the Phase-3
// AI draft shape. Resolved by name or symbol so either call style works.
const DEFAULT_TEMPLATES = {
  event: [
    '## Summary',
    '## When                        _session / circumstance_',
    '## Who                         _NPCs & players involved_',
    '## Where                       _@@Location@@_',
    '## Items involved              _$$Item$$_',
    '## Prerequisites               _what needs to happen first — link pre-events !!Event!!_',
    '## Follow-ups                  _what happens after — link post-events !!Event!!_',
    '## Beats / what happens',
    '## Foreshadowing               _hints planted earlier_',
    '## Consequences',
    '## Status                      _planned / in-progress / resolved_',
  ].join('\n'),
  location: [
    '## Parent location             _broader area — link @@Location@@_',
    '## First impression',
    '## How to get there',
    '## Key features',
    '## Inhabitants                 _describe the people here; each linked — &&NPC&&_',
    '## Items found                 _$$Item$$_',
    '## Traps                       _^^Trap^^_',
    '## Events here                 _!!Event!!_',
    '## Secrets',
    '## Status                      _unexplored / explored_',
  ].join('\n'),
  npc: [
    '## Description                 _appearance, manner, tells_',
    '## Personality',
    '## Goals & motivations',
    '## Secrets',
    '## Relationships',
    '## Location                    _@@Location@@_',
    '## Items carried               _$$Item$$_',
    '## Events                      _link !!Event!! they are involved in_',
    '## Disposition                 _friendly / neutral / hostile_',
    '## Plot role & hooks',
  ].join('\n'),
  item: [
    '## Description',
    '## What it does                _properties / effects_',
    '## Rarity & value',
    '## Current holder & location',
    '## Backstory',
    '## Status                      _found / lost / destroyed_',
  ].join('\n'),
  trap: [
    '## Trigger',
    '## Mechanism',
    '## Effect                      _damage / condition / area_',
    '## Save & DC',
    '## Location                    _@@Location@@_',
    '## Countermeasures',
    '## Status                      _armed / disarmed / sprung_',
  ].join('\n'),
  player: [
    '## Player                      _character name / player name_',
    '## Class & level',
    '## Description',
    '## Backstory',
    '## Goals',
    '## Relationships',
    '## Equipment                   _$$Item$$_',
    '## Status                      _alive / injured / gone_',
  ].join('\n'),
};

export function defaultTemplate(name, symbol) {
  const entry = byName(name) ?? (symbol ? bySymbol(symbol) : null);
  if (!entry) return null;
  return DEFAULT_TEMPLATES[entry.name];
}
