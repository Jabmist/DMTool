# DMTool — Build Plan (multi-session)

Status key: `[ ]` not started · `[~]` in progress · `[x]` done
Update statuses as you go. Decisions in §1 are locked — do not re-litigate without Steve.

Goal: fork the obsidian-web baseline into a D&D DM tool at `~/source/DMTool`.
Spec seed: `DMTool.txt`. Baseline docs: `handoff2.md`, `SETUP.md` (in this repo).

---

## 1. Locked decisions (2026-10-04)

- **Folder**: `~/source/DMTool` (= `/home/steve/source/DMTool`).
- **Entity types (fixed set, v1)** — collision-free inline symbols, link form `&sym Name &sym`:

  | symbol | type     | link form    | note                                   |
  |--------|----------|--------------|----------------------------------------|
  | `!`    | event    | `!!Name!!`   |                                        |
  | `@`    | location | `@@Name@@`   |                                        |
  | `&`    | npc      | `&&Name&&`   | was `#` — `##`/`#tag` collision        |
  | `$`    | item     | `$$Name$$`   |                                        |
  | `^`    | trap     | `^^Name^^`   |                                        |
  | `+`    | player   | `++Name++`   | was `*` — `**bold**` collision         |

- **Link syntax**: doubled-symbol wrap, `!!Event Name!!`. One uniform mechanism for all six.
- **Baseline scope**: keep ALL obsidian-web features (dissect/import, notebooks+sharing, graph, admin).
- **Templates**: per-type entity templates (one per type), seeded at user registration.

Derived invariant: inline double-symbol pairs are entity links; single `#tag` stays the
plain-tag mechanism; extraction/preview/autocomplete use one uniform rule set.

---

## 2. Phase 0 — Scaffold [x]  (done 2026-10-04)

- [x] Copy from `/home/steve/source/Obsidian` into `/home/steve/source/DMTool`:
      `server/` `client/` root `package.json` `package-lock.json` `.env.example`
      `.env` (local keys) `nginx/` `SETUP.md` `docs/`
    **Exclude**: `.git/` `node_modules/` `data/` `cards/` `.claude/` `.opencode/` and all
    loose planning/spec files (`plan*.md` `plan*.json` `Plan19.*` `MOBILE.md` `security.md`
    `sharebook.md` `review.md` `aifail.txt` `hold.txt` `handoff2.md` `DMTool.txt` — this file
    excluded too).
      _Note: `cp -a` pulled in `server/|client/node_modules/` + `client/dist`; deleted those
      before first commit so the fork installs/compiles fresh and has zero baseline deps._
- [x] `git init` + first local commit (no push until Steve says so).
      _Commits: a0ce05e (fork) → cc51a5b (vite proxy env). Working tree clean._
- [x] Rename: `"name"` in root/server/client `package.json` → `dmtl` / `dmtl-client` /
      `dmtl-server` (lock file updated to match); app title → "DMTool" in
      `client/index.html`, `Header.jsx` default, help `INTRO`; `APP_VERSION` in
      `client/src/version.js` → `0.1.0` with a v0.1.0 "Forked from obsidian-web" entry.
      _The "Can I import from desktop Obsidian?" help line is a legit reference to the real
      app — intentionally left. Backup filename prefix `obsidian-` in backupService.js is
      archive-internal / a test assert — intentionally left (not user-facing branding)._
- [x] `npm ci` → native modules load on Node v22 (better-sqlite3 + bcrypt OK) →
      `npm run dev` boots → `npm run test` green: **server 297/297, client 66/66 (363 total)**.

### Phase 0 notes for the next session
- **Baseline actually v0.21.0** (handoff2.md's "0.15.0" was stale; code has advanced).
  version.js changelog was **reset to the fork point** per plan — this is deliberate, not a
  regression. Keep it this way (or Steve may ask to carry the old history forward); if
  carried forward, change §1/§2 accordingly.
- **`.env` repointed** off the baseline `Obsidian/data/*` to the fork's own
  `data/{vaults,uploads,backups}` + `data/dmtl.db` (new, empty) — fork is independent of the
  baseline's data. `data/` and `.env` are gitignored (not committed).
- **Vite dev proxy is now env-overridable** (`DMTL_API_ORIGIN`, default `localhost:3000`) —
  commit cc51a5b. Needed to run a second instance side-by-side with the baseline Obsidian
  (which holds `:3000` + `:5173`). To run DMTool dev side-by-side:
      `PORT=3042 DMTL_API_ORIGIN=http://localhost:3042 npm run dev`  (it auto-picks :5174).
  Production still hard-codes :3000 via .env, so this change is a no-op for prod.

## 3. Phase 1 — Entity-type registry [x]  (done 2026-10-07)

### 3a. Decisions already reached (from handoff.md §6 + plan §1 — locked)

| # | Decision | Source |
|---|----------|--------|
| D1 | 6 entity types, fixed symbols: `!`event `@`location `&`npc `$`item `^`trap `+`player | handoff §6, plan §1 |
| D2 | Link form is `&sym Name &sym` (symbol doubled both sides) | handoff §6, plan §1 |
| D3 | `server/src/entityTypes.js` is single source of truth (no DB for the registry itself) | handoff §6 |
| D4 | Helpers: `bySymbol()`, `linkRegex(symbol)` | handoff §6 |
| D5 | `notes.entity_symbol` column (TEXT, nullable) — additive migration | handoff §6 |
| D6 | Frontmatter on the note file carries the entity type — source of truth stays the file | plan §3 line 98-99 |
| D7 | Routes mounted at `/api/entity-types` (auth required) | plan §3 line 85 |
| D8 | `GET /` → registry; `GET /:symbol/notes` → picker; `POST /:symbol` → create; `PUT /:symbol/template` → edit template | plan §3 lines 86-91 |
| D9 | Per-type notebooks seeded at registration (idempotent) | plan §3 lines 94-97 |
| D10 | Two baseline tests will change: `notebooks.routes.test.js:70` (empty→seeded) and `templates.routes.test.js:21` (empty→seeded) — update them to expect seeded items | handoff §6 lines 201-206 |
| D11 | Existing `#tag`/`[[link]]` extraction untouched | plan §3 line 100 |
| D12 | Note body path: subfolder under `entities/` in the user's vault (exact folder name TBD) | handoff §6 line 188 |

### 3b. Decisions (Q1 resolved 2026-10-05; rest open — resolve one at a time before implementing)

#### Q1 — RESOLVED (2026-10-05): **per-user templates in the existing `templates` table (option B)**

Decision: seed the entity templates as **per-user rows in the existing `templates` table**
(keyed by `user_id`, like every existing template), NOT as a single global
`entity_templates(symbol PK)` table.

Why B (and not A):
- **Locked D10 requires it.** D10 says `templates.routes.test.js:21` (the
  `GET /api/templates` "returns empty list initially" assert) flips from empty→seeded.
  `GET /api/templates` reads `templates WHERE user_id = req.user.sub`
  (see `routes/templates.js:8`). That only becomes non-empty after registration if the entity
  templates are **per-user rows in `templates`**. A global `entity_templates` table would leave
  `GET /api/templates` empty — contradicting the already-locked D10.
- **Consistent with D9** (per-user type-notebooks seeded at registration) and the existing
  templates permission model (all of `routes/templates.js` is scoped to `user_id = req.user.sub`;
  there is no admin gate).
- The client already speaks `/api/templates` CRUD; per-user editing reuses it.

Consequences (fold into subtasks 1.2 / 1.6):
1. **1.2 (migration):** in addition to the `notes.entity_symbol` column (D5) and notebook seeding
   (D9), add a guarded nullable column `templates.entity_symbol TEXT`
   (`ALTER TABLE templates ADD COLUMN entity_symbol TEXT`, same try/catch pattern as D5).
   At registration seed one `templates` row **per type** (six), `name` = registry label
   (e.g. `NPC Template`), `content` = that type's starter template, `entity_symbol` = the symbol —
   idempotently (check `user_id + entity_symbol` before insert, or `INSERT OR IGNORE` on a
   `UNIQUE(user_id, entity_symbol)` guard where possible).
2. **1.6 (`PUT /api/entity-types/:symbol/template`):** resolve the *current user's* row via
   `SELECT id FROM templates WHERE user_id = ? AND entity_symbol = ?`, then update `content`.
   The `templates.entity_symbol` column keeps this **rename-proof** (a user may rename the
   template via the existing `PUT /api/templates/:id`, which would break a name-based lookup).
3. **Q7 → resolves to B:** the **current user** edits their own template copy; the admin-only
   branch (Q1-A) is moot. No new admin permission concept is introduced.

Plumbing (decided with Q1, 2026-10-05): bind symbol→row via the new
`templates.entity_symbol` column (mirror of D5's `notes.entity_symbol`, rename-proof).
NOT a name-based lookup. Seeded once per user at registration (see 1.2).

#### Q2 — RESOLVED (2026-10-05): **use the six starter templates below as the seed content (option A)**

Note: Q2's old phrasing ("are the §3 starter template outlines good enough") is stale —
**no outlines were ever written down** (spec `DMTool.txt:5` says the template is "to be
defined later"). Option A = adopt the six below (each user still editable via `/api/templates`
from Q1); Steve dictated the adjustments folded in here.

Steve's 2026-10-05 adjustments:
- **Event**: added `Items involved` (links `$$Item$$`); added `Prerequisites` (link pre-events
  `!!Event!!` — what needs to happen before) and `Follow-ups` (link post-events `!!Event!!` —
  what happens after). `Where` already carries the `@@Location@@` link.
- **Location**: `Inhabitants` clarified as a description of the people here, each one an
  `&&NPC&&` link; added `Parent location` for nested containment
  (e.g. "Allhands Bar" → "Small town business district" → "Small town").
- **NPC**: added `Events` (links `!!Event!!` they are involved in).

Display rule (see below): even the bidirectional-looking relationships (Prerequisites/
Follow-ups, Events here, NPC→Events, Parent location) render as their own named sections,
not as a generic "Backlinks" sidebar.

Content (seeds each user's `templates` rows at registration per Q1; also the Phase-3 AI fill-in
shape). Cross-type sections hint at the symbol link syntax so the user sees the mechanic in
context.

**Display rule (Steve 2026-10-05)**: even where the relationship is conceptually
bidirectional — e.g. an Event's `Prerequisites`/`Follow-ups`, a Location's `Events here`, a
NPC's `Events`, a Location's `Parent location` — each field MUST render as its own named
headed section (with its own list of `!!…!!`/`@@…@@`/`&&…&&` symbol links), NOT be collapsed
into one generic "Backlinks" sidebar. The data model is unaffected: the underlying links are
still the flat, untyped `links` rows Phase 2's extractor produces (same shape as `[[wikilink]]`);
only the *rendering* treats each section as a distinct block, per how the author wrote it in
the note body. Phase 2 must NOT invent a separate link entity type or a `link_type` column for
these.

```
-- ! Event (link !!Name!!) --
## Summary
## When                        _session / circumstance_
## Who                         _NPCs & players involved_
## Where                       _@@Location@@_
## Items involved              _$$Item$$_
## Prerequisites               _what needs to happen first — link pre-events !!Event!!_
## Follow-ups                  _what happens after — link post-events !!Event!!_
## Beats / what happens
## Foreshadowing               _hints planted earlier_
## Consequences
## Status                      _planned / in-progress / resolved_

-- @ Location (link @@Name@@) --
## Parent location             _broader area — link @@Location@@_
## First impression
## How to get there
## Key features
## Inhabitants                 _describe the people here; each linked — &&NPC&&_
## Items found                 _$$Item$$_
## Traps                       _^^Trap^^_
## Events here                 _!!Event!!_
## Secrets
## Status                      _unexplored / explored_

-- & NPC (link &&Name&&) --
## Description                 _appearance, manner, tells_
## Personality
## Goals & motivations
## Secrets
## Relationships
## Location                    _@@Location@@_
## Items carried               _$$Item$$_
## Events                      _link !!Event!! they are involved in_
## Disposition                 _friendly / neutral / hostile_
## Plot role & hooks

-- $ Item (link $$Name$$) --
## Description
## What it does                _properties / effects_
## Rarity & value
## Current holder & location
## Backstory
## Status                      _found / lost / destroyed_

-- ^ Trap (link ^^Name^^) --
## Trigger
## Mechanism
## Effect                      _damage / condition / area_
## Save & DC
## Location                    _@@Location@@_
## Countermeasures
## Status                      _armed / disarmed / sprung_

-- + Player (link ++Name++) --
## Player                      _character name / player name_
## Class & level
## Description
## Backstory
## Goals
## Relationships
## Equipment                   _$$Item$$_
## Status                      _alive / injured / gone_
```

#### Q3 — RESOLVED (2026-10-05): **six seed notebooks, plain names, rename + delete-contents locked**

Decision: **six** seed notebooks (D9 stays locked; option B "one Entities" re-litigates D9
and is out). Names are the **plain** per-type labels **without the symbol prefix**, all
derived as `label + 's'` from `entityTypes.js`:

| symbol | name (registry `label`) | seed notebook name |
|--------|------------------------|--------------------|
| `!`    | Event                  | `Events`           |
| `@`    | Location               | `Locations`        |
| `&`    | NPC                    | `NPCs`             |
| `$`    | Item                   | `Items`            |
| `^`    | Trap                   | `Traps`            |
| `+`    | Player                 | `Players`          |

No extra schema column is added for symbol→notebook binding (unlike Q1's
`templates.entity_symbol` or D5's `notes.entity_symbol`). The name **is** the binding
— and that is safe because renaming the six seed notebooks is **forbidden** (see below), so
the name can never drift out of sync with the symbol.

Seed-notebook protection (steve 2026-10-05):

1. **Rename is forbidden.** `PATCH /api/notebooks/:id` returns **409** with a clear error
   (`{ error: 'This is a required entity notebook and cannot be renamed.' }`) if the target
   notebook is one of the six seed notebooks. Detection = notebook name is in the known set
   `{ Events, Locations, NPCs, Items, Traps, Players }` AND the owner is the requesting user
   (members can't rename anyway — they'd hit 403/404 from the existing auth path). This
   rule lives in `routes/notebooks.js` (the one function that renames).

   *Subtask 1.8b (new, after 1.8):* enforce the rename lock in `routes/notebooks.js PATCH
   /:id` (return 409 on a seed notebook), and add a test in `notebooks.routes.test.js`
   asserting 409 when trying to rename `Events` to whatever.

2. **Delete semantics — the notebook and its notes are removed; the type's template is left
   intact.** On `DELETE /api/notebooks/:id` for a seed notebook:
   - All notes in the notebook are deleted (their `.md` files + `notes`/`links`/`tags`/FTS
     rows + `notebook_notes` rows) through the existing `deleteNotes=true` flow in
     `routes/notebooks.js:148-186`.
   - The notebook row itself is deleted (existing behavior).
   - The user's **`templates`** rows (Q1's per-user seed) are **not touched** — the seed
     template for that symbol is still there, still editable, still the `fill-in shape` used
     by `POST /api/entity-types/:symbol` (D8) and by Phase 3's AI draft (D-3, §5 in §6).
   - The user can get the notebook back by creating one more entity of that type — the
     `POST /:symbol` flow re-creates the seed notebook idempotently (a `notebook_notes` row
     is added to a fresh `INSERT` of the notebook), so the notebook does not have to persist
     in the DB to keep the symbol→template binding alive.

    *Subtask 1.8b (continued):* verify the existing `DELETE /:id` behavior in
    `routes/notebooks.js:148-186` is **not** changed, and add a test in
    `notebooks.routes.test.js` asserting that after `DELETE /api/notebooks/<id-of-Events>`:
    (a) the notebook row for `Events` is gone, (b) all notes it contained are gone from the
    vault + DB, and (c) the user's `templates` row for symbol `!` (Event) is **still present
    with its content intact**. The `templates` row is the Q1 symbol→template binding, not
    the notebook; deleting the notebook is orthogonal to the template.

3. **Seed timing** = registration (1.8, idempotent) + on-demand in `POST /:symbol` (1.5):
   if the seed notebook is missing for that symbol, create it with the plain name at the
   same moment the note is filed into it. The `UNIQUE(user_id, name)` constraint gives us
   idempotency for free.

4. **D8 `POST /:symbol`** is the canonical "create an entity of type Y" flow — it is the
   place that knows the seed notebook name for that `:symbol`. It does its lookup against
   the name table above (or by a small helper in `entityTypes.js`: `seedNotebookName(label)`).
   The symbol→name binding lives in `entityTypes.js` as the single source of truth (D3).

Consequences for subtasks (fold in):
- **1.1** (`entityTypes.js`): registry entries include `label` (singular) AND a derived
  `labelPlural` (e.g. `Events`, `NPCs`, `Players`). A small helper
  `seedNotebookName(label)` returns `label + 's'`. Unit test. (No new DB column.)
- **1.5** (`POST /:symbol`): on create, if no seed notebook exists for `:symbol`,
  `INSERT OR IGNORE` one with `name = seedNotebookName(label)`. Idempotent.
- **1.8** (register seeds): seed the six notebooks by plain name, idempotent.
- **1.8b (new, after 1.8)**: enforce the rename lock on the six seed notebooks in
  `routes/notebooks.js`; add tests (rename → 409; delete → templates intact; delete → notes
  gone).

#### Q4 — RESOLVED (2026-10-06): **`entities/<name>/<slug>.md` (option A)**

Decision: entity notes live at **`entities/<type-name>/<slug>.md`**, e.g.
`entities/npc/borg-the-black.md`, `entities/event/council-summit.md`. The type name is the
registry `name` (lowercase) from `entityTypes.js` (D1/D3 — the locked registry; the name never
drifts, unlike seed-notebook names which are user-visible but rename-locked per Q3).

Why A (and not B, i.e. `entities/&npc/`):
- **Handoff §6 line 188 already says `entities/npc/<slug>.md`.** The plan's `&npc` was the
  outlier; aligning to the handoff convention. The `&` in the plan text was shorthand for
  "the symbol", not a literal path requirement.
- **Path safety across the stack.** `path` is the note's *identity* — the same string is the
  key in `notes`, `links.source_path`, `tags.path`, `notebook_notes.note_path`,
  `notebook_note_seen`, and the FTS rowid join (`server/src/db/index.js:62-69`,
  `indexService.js:39-56`). The client does **not** URL-encode note paths — it string-interpolates
  them raw into fetch URLs (`Editor.jsx:111/167/292`, `Sidebar.jsx:146-153`). A folder literally
  named `&npc` puts an unencoded `&` in every request line for every NPC note. `&` *is* legal in a
  path segment (RFC 3986; it is only a query-string delimiter), so it works — but a raw `&` in the
  URL is a sharp edge for any proxy, access log, or tool that treats `&` as a query delimiter.
- **The symbol carries no information in the path.** The type is already persisted in
  `notes.entity_symbol` (D5) and in the `templates.entity_symbol` column (Q1). The folder is
  pure organization; the symbol adds nothing there.
- **Name-based folders are safe here** precisely because the name is fixed by the locked
  registry (D1/D3) — it is not user-renameable the way a notebook name is, so it cannot drift
  out of sync with the symbol.

Consequences for subtasks (fold in):
- **1.1** (`entityTypes.js`): add a helper `entityPath(name, entityName)` that returns
  `` `entities/${name}/${entityName}.md` `` (the entity's display name verbatim — see Q5; the
  name is filename-safe per Q5's guard). No DB column needed — the path encodes the type, and
  `notes.entity_symbol` remains the source of truth for queries.
- **1.5** (`POST /:symbol`): the note is written to `entityPath(type.name, name)`, e.g.
  `entities/npc/Borg the Black.md`. The filename is the safe display name (Q5).
- The client needs **zero changes**: it already accepts any subfolder in `path`
  (`Sidebar.jsx:131`, `Editor.jsx:90-94`) and the server's `fileService.writeNote` handles
  subdirs (`fileService.js:24-28`), so the new folder shape rides existing plumbing.

#### Q5 — RESOLVED (2026-10-06): **verbatim display name as the filename (option B — keep the name, do not slugify)**

Decision: the entity note's filename is the entity's **display name verbatim** (safe subset,
see guard below), e.g. `entities/npc/Borg the Black.md`, `entities/event/Council Summit.md`.
We do **not** lowercase, dash-ify, or otherwise slugify the name.

Why B (and not A, i.e. `borg-the-black.md`):
- **The link model requires byte-exact name↔filename equality.** This is not a preference.
  In the baseline, `notes.title` is **always** `path.basename(path, '.md')` — verbatim, no
  slugify, no case change (`indexService.js:9-11`). `GET /api/notes/resolve` is an **exact,
  case-sensitive** `=` match on `title` and returns `path` (`notes.js:54-67`). Backlinks store
  the **raw authored target text** (`indexService.js:13-19`, `WHERE target_title = ?` case-
  sensitive at `indexService.js:174`). And the client sends the link's **Target** text as
  `title=`, not the Alias (`NotePreview.jsx:143-151,167`).
- The six entity links (locked D1/D2, Q2/Q4) put the entity's **display name** between the
  doubled symbols: `&&Borg the Black&&`. For that link to resolve to the note, the display
  name must equal `notes.title`, i.e. the filename basename, **byte for byte** (case and
  spaces). A slugified filename `borg-the-black.md` would store title `borg-the-black`, and a
  link typed `&&Borg the Black&&` would **404** and fall through to the client's
  `onNavigate('Borg the Black.md')` fallback (`NotePreview.jsx:170`) — which 404s too. Every
  cross-type symbol link (Q2's Prerequisites / Location / NPC→Events sections) relies on this.
- **Making slugs work would require changing shared baseline link infrastructure** —
  `extractTitle`, `resolve`, `backlinks` — to canonicalize case + spaces for *every* note
  (including the plain `[[wikilink]]` baseline feature), and a slugify helper that does not
  exist anywhere in the repo. That touches the retained baseline contract (D11) and risks
  regressing existing notes. Out of scope for Phase 1.
- **Verbatim names are already a tested, working baseline feature.** The baseline test
  `notes.routes.test.js:94-99` creates a note literally `Resolve Me.md` and asserts
  `GET /api/notes/resolve?title=Resolve%20Me` → 200 with path `Resolve Me.md`. The browser/Node
  transport normalizes a space between path segments (it is a valid unreserved path-segment
  char, RFC 3986), so the round-trip is clean. The client's rename flow (`Editor.jsx:90-94`)
  already edits the basename verbatim, so users will expect `Borg the Black` to *be* the
  filename.

Filename safety guard (fold into 1.5): the display name is used as the filename, but **must
be sanitized to a filesystem-safe subset** before writing, reusing the repo's existing
"forbidden filename chars" rule (the same set `routes/import.js:146-151` `sanitizeFilename`
already encodes): strip/replace `/ \ < > : " | ? *` and C0 control chars, trim, cap length,
and reject if empty. Spaces are **allowed** (they are the point). This is a *safety*
transform only — it never changes case or converts spaces to dashes, so it cannot break the
byte-exact name↔link equality above (the user just can't use one of those ~8 forbidden chars
in an entity name — same restriction the web-import already imposes). Apply the identical
transform in any client "new name" path (Phase 2) so client and server agree.

Consequences for subtasks (fold in):
- **1.1** (`entityTypes.js`): the `entityPath(name, entityName)` helper (added per Q4) takes
  the **safe display name**, not a slug. Keep it a pure path join — no slugify here.
- **1.5** (`POST /:symbol`): sanitize `name` with the forbidden-chars guard above, then write
  to `entityPath(type.name, safeName)` and set `title` = the same `safeName` (it already is,
  via `extractTitle`). Reject (400) if `safeName` is empty. Route test: `POST /api/entity-types/&
  {name:"Borg the Black"}` → note at `entities/npc/Borg the Black.md`, title `Borg the Black`;
  `POST` with `name:"a/b"` → 400.
- **No `entitySymbol`/frontmatter change** from Q5 — the name/format decision is orthogonal
  to Q8.

#### Q6 — RESOLVED (2026-10-06, Steve chose A): **strict — 409 if ANY note with that title exists for the user**

Decision: `POST /api/entity-types/:symbol {name}` returns **409** when the user has **any**
note (entity *or* plain) whose `title` already equals `safeName`. Only when the title is
free across the whole user vault does the create succeed.

Why A (and not B, i.e. type-scoped):
- **Links resolve by `title` only — type is not in the lookup.** `resolve` matches
  `WHERE user_id=? AND title=? LIMIT 1` and returns the first match (`notes.js:54-67`); the
  six entity links (locked D1/D2, Q2 display rule) and the baseline `[[wikilink]]` all funnel
  to the same `resolve?title=…`. The "flat, untyped `links` rows — do NOT invent a `link_type`
  column" constraint (Q2 / Phase 2) means two notes sharing a title are indistinguishable to
  a link click. Making them distinguishable would require un-locking that flat-links rule and
  making `resolve` + backlinks type-aware — a re-litigation of a §1-locked decision. So the
  only way B can ever stay *correct* is to keep `title` unique per user.
- **Title uniqueness is the invariant the link model needs**, and strict 409 enforces it at the
  one place we control: entity creation. It also protects the existing `[[wikilink]]` feature
  from being silently shadowed by a same-titled entity (e.g. a plain "Ragnar" + an NPC "Ragnar"
  would make a `[[Ragnar]]` link resolve to an arbitrary one).
- **It matches the baseline's model** that note identity is `(user_id, path)` and that a link
  target is a *title* — we are merely asserting that title is 1:1 within a user, which is the
  safe, minimal extension.

What's unchanged:
- **No new schema constraint.** The baseline `notes` table only enforces `UNIQUE(user_id, path)`
  (not `UNIQUE(user_id, title)`). We do **not** add a `UNIQUE(user_id, title)` constraint —
  existing users may already have notes that share a title, and a schema constraint would make
  `indexService` re-index of any existing duplicate fail. The uniqueness check lives in the
  one new write path (entity `POST`) as an application-level `SELECT … LIMIT 1`, matching the
  existing 409-on-name-style checks the routes already use. Existing notes and existing
  `[[wikilink]]`/`#tag`/`resolve`/backlink behavior are untouched (D11).
- **No client changes.** The duplicate guard is server-side at create time; the client
  picker (`GET /:symbol/notes`) and "New…" flow just surface whatever the server allows.

Consequences for subtasks (fold in):
- **1.5** (`POST /:symbol`): before writing, `SELECT 1 FROM notes WHERE user_id = ? AND title
  = ?` on the user for `safeName`; if a row exists, **409** with
  `{ error: 'A note with this title already exists.' }`. Check runs *after* the forbidden-char
  400 (Q5) — i.e. order: sanitize (400) → dup check (409) → write (200/201).
- Route tests to add in `entityTypes.routes.test.js` (new file per 1.3/1.5):
  - `POST /api/entity-types/& {name:"Ragnar"}` → 201, note at
    `entities/npc/Ragnar.md`, `title` = `Ragnar`.
  - Same `POST` again → **409**.
  - Create a plain note `PUT /api/notes/Ragnar.md`, then `POST /api/entity-types/& {name:
    "Ragnar"}` → **409** (the strict case from the Q6 prompt).
  - `POST /api/entity-types/& {name:"Ragnar X"}` while `Ragnar` exists → 201 (titles that
    merely *prefix* the existing one must still succeed — `=` match, not `LIKE`).
  - `POST` with `name:"a/b"` → **400** (Q5 guard, takes precedence over the 409 check).

#### Q7 — RESOLVED (inherited from Q1, 2026-10-05): **any authenticated user edits their own per-user template copy; no admin role**

Decision: `PUT /api/entity-types/:symbol/template {content}` requires **only** authentication —
it updates **the requesting user's own** `templates` row where `user_id = req.user.sub AND
entity_symbol = :symbol`, and 404s if no such row exists. There is **no admin-only branch**,
no permission flag, no sharing model, and no owner/editor distinction. "The current user edits
their own copy" is the resolution.

Why (and why this is code-determined, not a policy choice):
- **The locked Q1 decision (per-user `templates` rows) forces it.** Q1 rejected the global
  `entity_templates(symbol PK)` table *precisely* so each user has their own editable rows in
  the existing `templates` table. That schema has one permission axis:
  `WHERE user_id = req.user.sub`. Every existing endpoint in `routes/templates.js`
  (`GET /:1-14`, `POST/25-34`, `PUT/36-46`, `DELETE/48-55`) is scoped exactly that way and
  404s for rows the caller doesn't own. There is no admin role, no `templates.owner_id`, and
  no sharing table — nothing in the codebase to attach a stricter guard to.
- **Handoff §6 line 91 "admin/owner edits" is superseded by Q1.** Q1 line 123 says it
  verbatim: *"The admin-only branch (Q1-A) is moot. No new admin permission concept is
  introduced."* Q7 was the last open question carrying that handoff wording; Q1 closed it.
- **Rename-proofness requires the same axis.** Q1 added the `templates.entity_symbol` column
  to bind symbol → row (instead of by name) *because* a user can rename their template via
  the existing `PUT /api/templates/:id`. The only way a *different* user's request could touch
  that row is if we introduced cross-user access — which we have not. The
  `WHERE user_id = ? AND entity_symbol = ?` predicate is the entire access model.

Consequences for subtasks (fold in; none change the schema, this is documentation only):
- **1.2** (migration): the `templates.entity_symbol TEXT` column (already in 1.2 per Q1) is the
  sole binding; **do not** add any `owner_id`, `admin_only`, or permission column.
- **1.6** (`PUT /:symbol/template`): implementation =
  `SELECT id FROM templates WHERE user_id = ? AND entity_symbol = ?` → 404 if none →
  `UPDATE templates SET content = ? WHERE id = ? AND user_id = ?` → 200 with the updated row.
  No new auth middleware, no admin gate. The route mirrors the existing
  `templates.js:36-46` `PUT /:id` exactly, differing only by the lookup key
  (`entity_symbol` instead of `id`).
- **Route tests** to add in `entityTypes.routes.test.js`:
  - `PUT /api/entity-types/&/template` by the **owning** user → 200, content updated,
    `entity_symbol` preserved, `name` unchanged (only `content` is writable via this route —
    the `name` remains user-manageable via the existing `PUT /api/templates/:id`).
  - `PUT /api/entity-types/&/template` by a **second, different** authenticated user → 404
    (they have no row with that `user_id + entity_symbol`; the existing owner-scoped guard in
    the schema enforces this — this test is a regression guard on D10's "per-user" semantics).
  - `PUT` for a symbol **before** registration-seeding (defensive, should not happen for valid
    authenticated users since 1.8 seeds all six) → 404.
- **No client changes.** The existing templates UI already speaks `/api/templates` CRUD per
  user; the new `PUT /api/entity-types/:symbol/template` is a *server-side helper* (used by
  Phase 3's AI-draft "apply" flow and by tests), not a new client surface.

#### Q8 — RESOLVED (2026-10-06): **frontmatter key = `entity:`; the stored `notes.entity_symbol` column holds the symbol character (e.g. `&`), never the name (`npc`) or the compound string (`&npc`)**

Decision: an entity note's file carries one frontmatter key — **`entity:`** — whose value is
the type's **symbol character** from the registry, e.g.

```
---
entity: &
---
```
(for NPC; `entity: !` for Event, `entity: @` for Location, `entity: $` for Item, `entity: ^`
for Trap, `entity: +` for Player). `indexService.indexNote()` reads that key and resolves the
symbol via `bySymbol()` to persist into `notes.entity_symbol` — and **`notes.entity_symbol`
stores the symbol character `&`, not the name.** That is what D5/D8/1.4 (`SELECT … WHERE
entity_symbol = :symbol`) and Q1's `templates.entity_symbol` (also storing `&`) both already
assume.

Why this, and why it resolves the plan/handoff contradiction:
- **The plan and handoff disagreed on both the key *and* the value.** Plan §3 line 99 wrote
  `type: "&npc"`; handoff §6 line 191 wrote "optional `entity:` frontmatter". Both carried the
  compound value `&npc`, which is neither the name nor the symbol. This answer fixes both:
  **key = `entity:`** (handoff side — it's the domain term used everywhere: "entity type",
  `entity_symbol`, `entity-types` route; `type:` would read as a *note* type, which is a
  different concept), and **value = the symbol char** (not `&npc`).
- **Storing the bare symbol (not the name) is what keeps the column queryable and consistent.**
  `notes.entity_symbol` is keyed against the *symbol* throughout: the picker
  (`GET /api/entity-types/:symbol/notes` → `WHERE entity_symbol = :symbol`, 1.4), the create
  (`POST /api/entity-types/:symbol`, 1.5), and the mirror column `templates.entity_symbol`.
  If the frontmatter value were the name or `&npc`, `indexService` would have to translate
  name→symbol to store it — but the symbol *is* the stable identifier used in every query and
  is stable across any label/name change, whereas a `name` value would couple the column to a
  display string. One rule: **the `*entity_symbol*` columns and the frontmatter all hold the
  symbol character.**
- **Follows the existing frontmatter parsing convention.** There is no YAML parser in the repo
  — `indexService` reads frontmatter via loose line-anchored regexes
  (`FRONTMATTER_TAG_RE = /^tags:\s*\[([^\]]+)\]/m`, `indexService.js:7,24`). The new key will
  be the same shape: `FRONTMATTER_ENTITY_RE = /^entity:\s*([!@&$^+])\s*$/m`. `indexService`
  already strips the surrounding `---` block handling for `tags:`, so `entity:` rides the same
  loose-parse path. **No new YAML dependency.**
- **The symbol char in frontmatter is a safe, unambiguous token.** It is one char from the fixed
  six (`!@&$^+`), none of which form YAML value ambiguity (no `:`/`#`/quotes), so the loose
  regex is sufficient and robust. A user who deletes the `entity:` line (or writes a value
  outside the six) simply leaves `notes.entity_symbol = NULL` — the note becomes an ordinary
  note; nothing breaks, and re-adding the line re-classifies it. That graceful downgrade matters
  because D6 says *the file is the source of truth*.

Consequences for subtasks (fold in):
- **1.7** (`indexService`): add `FRONTMATTER_ENTITY_RE`; in `indexNote`, read the value, and if
  it is one of the six symbols set it, else leave `NULL`. Store the **symbol char** into
   `notes.entity_symbol` (the upsert gains a **6th column** — see 1.2 column (a)). If the key
   is absent / invalid, pass `NULL` so the note is not classified.
   Do **not** touch `WIKILINK_RE`, `TAG_RE`, or the frontmatter `tags:` regex (D11).
   (Concretely: the existing `INSERT OR REPLACE INTO notes (user_id, path, title, updated_at, last_edited_by)`
   at `indexService.js:45-46` gains one column → `(user_id, path, title, updated_at, last_edited_by,
   entity_symbol)` with a matching bind.)
- **1.5** (`POST /:symbol`): when writing the `.md`, include the frontmatter block
  `---\nentity: <symbol>\n---\n` on top of the (Q2) template body, *before* calling
  `indexService.indexNote` — so the round-trip (read back → parse → store) yields the symbol
  even for a client that never re-saves. Route test asserts `notes.entity_symbol = '&'` after
  creating an NPC, without a re-save.
- **1.2** (migration): the `notes.entity_symbol` column already exists per D5 (added by 1.2(a)
  in an earlier draft — *this session confirms it is `TEXT`, nullable, symbol-char value, not a
  name). `templates.entity_symbol` (Q1) stores the same symbol char. **The two columns are
  aligned** — both hold the one-char symbol.
- **Do not** add a `notes.entity_name` or `notes.entity_label` column; the *name* of the type is
  always resolved from `entity_symbol` via the registry (`entityTypes.js`), per D3.

#### Q9 — RESOLVED (2026-10-06): **seed at registration + on demand in `POST /:symbol`; NOT a migration-time backfill**

Decision: seed (six seed notebooks + six `templates` rows with `entity_symbol` set) happens in
(1) the `auth.js` `register` handler — idempotent, in the same request that creates the user —
and (2) lazily in `POST /api/entity-types/:symbol` — if the user's seed notebook for that
symbol is missing, create it (`INSERT OR IGNORE`, `UNIQUE(user_id,name)` on `notebooks`
gives idempotency for free per Q3) and/or the six `templates` rows (guarded `WHERE user_id=?
AND entity_symbol IS NULL/MISSING` check before insert) — for pre-existing users who
registered before this feature existed. There is **no migration-time `FOR user IN users` loop**
and **no lazy per-request seeding middleware** attached to every authed call.

Why A-ish (registration + on-demand) and not the Q9 table's B ("lazy on first request"):
- **The Q9 table's "B (lazy on first authenticated API call per user)" is a trap.** The
  baseline auth middleware (`middleware/auth.js`) runs on *every* authenticated route. Attaching
  "seed if missing" there means every `GET /api/notes` by a pre-existing user triggers
  six notebook inserts + six template inserts (guarded, but still a write path on the hottest
  read path). That turns a cold start into a write, races the first request, and makes the
  "empty notebook on first sign-in" baseline UX (D10's flip from empty→seeded, `notebooks.routes.test.js:70`)
  *appear non-deterministic* to a client that lists notebooks immediately after `login`.
- **Registration is the one clean, user-scoped, transactional moment we own.** `auth.js:49-77`
  already has both the `INSERT INTO users` and the per-user branching (`isFirst ? admin :
  user`). Seeding the two seed-sets there is a small, additive, idempotent block that runs
  once in the same request that creates the user — zero latency on subsequent requests, zero
  middleware changes, and the test in 1.8 (`register → verify 6 + 6 seeded`) is a natural fit.
- **Pre-existing users (registered before this feature) get on-demand seeding at the *first*
  `POST /:symbol` call they make.** That is the only new entry point that *needs* the seed
  data (the seed notebook it will file the new note into). Everything else — the existing
  `/api/notebooks`, `/api/templates`, `/api/notes` flows — never needs to see them, so we don't
  fabricate a "seed on the user's first note list" hook. Q3's seed-timing bullet (3) already
  says "Seed timing = registration (1.8, idempotent) + on-demand in `POST /:symbol` (1.5)"
  — this answer keeps that, and *closes the Q9 open question* by explicitly rejecting the
  migration-time alternative from the Q9 table: `runMigrations()` runs once per server start,
  is schema-only, and the baseline never does per-user data seeding in `runMigrations`
  (see `db/index.js:44-246` — tables, indexes, FTS only; zero per-user inserts), so adding
  a `for user in users` loop there would be a new code shape with no precedent in the repo.

Consequences for subtasks (fold in):
- **1.8** (`auth.js register`): after the `INSERT INTO users` (and before the `pending` / `admin`
  branch returns), call a new helper `ensureSeedData(userId)` (lives in a new
  `server/src/services/entitySeeding.js`). That helper, in one transaction: (a) `INSERT OR
  IGNORE INTO notebooks (user_id, name) VALUES (?, 'Events')` … for the six Q3 names
  (`Events, Locations, NPCs, Items, Traps, Players`); (b) for each of the six symbols, guarded
  check `if NOT EXISTS (SELECT 1 FROM templates WHERE user_id=? AND entity_symbol=?)` then
  `INSERT INTO templates (user_id, name, content, entity_symbol) VALUES (?, '<label> Template',
  <Q2 content>, '<symbol>')`. Returns void. Idempotent — safe to call twice.
- **1.5** (`POST /:symbol`): before writing the note, call the *same* `ensureSeedData(userId)`
  (cheap, idempotent, guarded) — so a pre-existing user's first entity-create gets their
  notebooks + templates without waiting for a second registration. Route test in
  `entityTypes.routes.test.js`: register a second user (pending), approve (existing admin
  flow or test helper), sign in as them, `POST /api/entity-types/& {name:'Fresh'}` → 201,
  and `SELECT COUNT(*) FROM templates WHERE user_id=? AND entity_symbol IS NOT NULL` → 6.
- **`runMigrations()`** (`db/index.js`): **no per-user loop**. Only the two `ALTER TABLE …
  ADD COLUMN entity_symbol TEXT` guards (1.2) and the schema stays schema-only. Add a
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_user_entity ON templates(user_id, entity_symbol)`
  so the guarded-insert in `ensureSeedData` is *enforced by the schema* rather than by the
  SELECT-then-INSERT pattern (this also protects the 1.6 "404 for second user" invariant and
  gives the Q1 "UNIQUE(user_id, entity_symbol) guard where possible" from the Q1 plan text —
  its absence from the baseline `templates` DDL (`db/index.js:159-165`) is a gap that 1.2
  closes).
- **Baseline test (D10) impact** is limited to the two asserts (1.9): the new user gets 6
  notebooks and 6 *entity* templates on registration, but existing plain
  `GET /api/notebooks` *empty on fresh sign-in* tests written before this feature were
  asserting on an *unregistered* user, so they are only updated if the test actually registers
  a user first (see 1.9: check each test's setup before editing).

#### Q10 — RESOLVED (2026-10-06): **`GET /api/entity-types/` returns registry metadata only; template content is fetched separately via the existing `/api/templates` flow or via `PUT/GET /api/entity-types/:symbol/template`**

Decision: `GET /api/entity-types/` returns the six registry entries — `symbol`, `name`,
`label`, `labelPlural` (Q3), and **`template` name** (the user's current `templates.name`
for that symbol, if any) — but *not* the template **content**. The client fetches content
on demand from the existing per-user `templates` API (`GET /api/templates/:id`, already
present; the `name` field on each registry entry points to it — or the client calls
`PUT /api/entity-types/:symbol/template` to *write* and reads back the row).

Why B (metadata-only) and not A (inline content):
- **The registry is a *type* descriptor; the template is *per-user* user data.** Q1 locked
  the per-user `templates` rows (keyed `user_id + entity_symbol`). Inlining their content
  into `GET /api/entity-types/` would (a) couple a *global shape* endpoint to *per-user rows*
  (the same request has to be `requireAuth` and `SELECT` six `templates` rows per call —
  that's fine, but it conflates two concerns), and (b) make the payload grow with each
  user's template length — which Q2's six starter templates (each ~20–30 lines) is already
  ~10–15 KB per template, ~60–90 KB per user per full registry fetch. The client's
  "picker" UI (Phase 2 `symbolLinkComplete.js`) needs the registry to *choose a symbol*; it
  does not need the content at that moment. The client's "New…" prompt (Phase 2) needs the
  content for exactly one symbol — fetch it for that symbol, not all six.
- **The baseline already models these as two resources** — `/api/notebooks` (global
  *types* of notes) and `/api/templates` (per-user starter *text*). Mirroring that split
  (`/api/entity-types` = types, `/api/templates` = text) keeps the REST surface
  predictable. Q10-A would introduce a *new* shape where one GET returns both — no
  precedent in the repo.
- **It also keeps the "registry" cheap to re-fetch** after a user edits one template
  (which they do via 1.6 `PUT /api/entity-types/:symbol/template`). A
  metadata-only response means the registry endpoint never invalidates client caches on
  template edits; the `templates` API (existing) is where content mutations live.
- **The content is trivially reachable** when needed: (a) the existing
  `GET /api/templates/:id` (baseline, already owner-scoped, `templates.js:16-23`) — the
  client knows each registry entry's `name` and can `GET /api/templates?q=<name>`-style
  resolve (there is no search endpoint, but the *list* `GET /api/templates` returns
  `id`+`name`+`created_at` per row, and the client can map `name → id` once); (b) the
  new `PUT /api/entity-types/:symbol/template` (1.6, Q7) returns the full row including
  content — so a "get template for symbol" *read* can piggy-back that endpoint via GET,
  **but** that would introduce a GET variant that doesn't exist today. So the cleanest
  answer is: **`GET /api/entity-types/` = metadata (symbol, name, label, labelPlural,
  template_id?, template_name), and the client reads content via `GET /api/templates/:id`**
  (using the `template_id` the registry supplies — one stable id per user/symbol, stable
  across renames because it's the row's PK, not the name).

Consequences for subtasks (fold in):
- **1.3** (`routes/entityTypes.js` `GET /`): response shape =
  `{ entityTypes: [ { symbol, name, label, labelPlural, template_id: <templates.id|null>, template_name: <templates.name|null> } x6 ] }`.
  Implementation: build the six registry entries from `entityTypes.js`, and for each do
  `SELECT id, name FROM templates WHERE user_id=? AND entity_symbol=? LIMIT 1` (cheap — a
  single indexed lookup per symbol, six total per request, and it's the only way to return
  `template_id` — which the client needs to call `GET /api/templates/:id`).
  **No `content`** in the response. This keeps D10's "empty on fresh sign-in" test
  (`templates.routes.test.js:21`) intact — the *templates* API is unchanged and now also
  lists the six seeded rows (with `entity_symbol`), while `entity-types` is a *new*
  metadata-only surface.
- **Route test** for `GET /api/entity-types/` (new file per 1.3): register user →
  `GET /api/entity-types/` → 200, body has 6 entries, each with `symbol`, `name`, `label`,
  `labelPlural`, `template_id` (non-null post-seed, `null` for a user created before 1.8
  ran), `template_name` (e.g. `NPC Template`), and **no `content` key anywhere in the
  response** (assert `Object.keys(res.body.entityTypes[0])` excludes `content`).
- **Client (Phase 2)**: the picker uses `entityTypes` to pick a symbol; the "New…" prompt
  does `GET /api/templates/{template_id}` for the chosen symbol; on Apply, `PUT /api/entity-types/:symbol/template`
  (1.6) or the existing `PUT /api/templates/:id`. No new "inline content" path needed.
- **1.2** already adds `templates.entity_symbol` (Q1); **Q9's new
  `idx_templates_user_entity` unique index** (`db/index.js`) is what makes the
  `SELECT id, name FROM templates WHERE user_id=? AND entity_symbol=?` in 1.3 an indexed
  point lookup rather than a scan.

### 3c. Subtasks (ordered, each small and independently testable)

> Resolve the relevant Q# before starting each subtask.
> Each subtask ends with `npm run test` green.

| ID | Subtask | Depends on | Qs to resolve first |
|----|---------|-----------|---------------------|
| 1.1 | Create `server/src/entityTypes.js`: registry array `[{symbol, name, label, labelPlural}]` + `bySymbol()` + `linkRegex(symbol)` + `seedNotebookName(label)` (Q3: returns `label + 's'`) + `entityPath(name, entityName)` (Q4/Q5: `` `entities/${name}/${entityName}.md` ``, pure join — no slugify) + `safeEntityName(name)` (Q5: strip/replace the forbidden filename chars `{/ \ < > : " | ? *}` + C0 controls, trim, cap length, return `''` if empty — *never* changes case or spaces). No DB, no routes. Write a small unit test for `bySymbol`, `linkRegex`, `seedNotebookName`, `entityPath`, and `safeEntityName` (e.g. `safeEntityName("Borg the Black")` → `"Borg the Black"`; `safeEntityName("a/b")` → `""`). | — | D1-D4 (already locked); Q3, Q4, Q5 |
| 1.2 | Add DB migrations in `runMigrations()`: (a) `ALTER TABLE notes ADD COLUMN entity_symbol TEXT` (guarded, **symbol-char value per Q8**), (b) `ALTER TABLE templates ADD COLUMN entity_symbol TEXT` (guarded, **symbol-char value per Q8**), (c) **`CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_user_entity ON templates(user_id, entity_symbol)`** (Q9 — makes the per-user per-symbol row unique in the schema so the guarded-insert in 1.8 is schema-enforced, not just application-layer, and protects 1.6's "second user → 404" invariant), (d) content seeds stay in the registration path (1.8), NOT in migrations — **no per-user loop in `runMigrations()`** (Q9). Verify `npm run test` still passes. | 1.1 | **Q1, Q2, Q8, Q9** |
| 1.3 | Create `routes/entityTypes.js` with `GET /` (per Q10: registry **metadata only** — `{ entityTypes: [{symbol, name, label, labelPlural, template_id, template_name}] }`, **no template content**; each `template_id`/`template_name` via `SELECT id, name FROM templates WHERE user_id=? AND entity_symbol=? LIMIT 1`; client reads content via existing `GET /api/templates/:id`). Mount in `index.js` under `/api/entity-types`. Add route test (200, 6 entries, each has `symbol/name/label/labelPlural/template_id/template_name`, **no `content` key**). | 1.2 | **Q1, Q10** (template storage, response shape) |
| 1.4 | Add `GET /:symbol/notes` endpoint (return user's notes WHERE `entity_symbol = :symbol`). Add route test (filter correctness). | 1.3 | — |
| 1.5 | Add `POST /:symbol` endpoint (create note from template: call `ensureSeedData(userId)` (Q9) first; sanitize the name via `safeEntityName` (Q5 — reject 400 if empty, never slugify); **strict dup check (Q6) — `SELECT 1 FROM notes WHERE user_id=? AND title=?`, 409 if any note with that title exists for the user**; write `.md` verbatim under `entityPath(type.name, safeName)` (Q4) **with a leading `---\nentity: <symbol>\n---` frontmatter block (Q8)** on top of the (Q2) template body; `indexService.indexNote` parses it → `notes.entity_symbol = <symbol char>` (Q8); file into the type's seed notebook, 201). Add route test (create `Ragnar` → `entities/npc/Ragnar.md` + `title=Ragnar` + `entity_symbol='&'` (no re-save needed); dup → 409; plain `Ragnar` note then `POST` NPC `Ragnar` → 409; forbidden char → 400). | 1.4, 1.7 | **Q3, Q4, Q5, Q6, Q8, Q9** |
| 1.6 | Add `PUT /:symbol/template {content}` endpoint (**per Q7: owner-only, no admin/permission gate** — resolve the requesting user's row via `SELECT id FROM templates WHERE user_id=? AND entity_symbol=?`, 404 if none; `UPDATE templates SET content=? WHERE id=? AND user_id=?`; only `content` is writable here, `name` stays managed via existing `PUT /api/templates/:id`). Add route test (owner update → 200 content changed, `entity_symbol` + `name` preserved; second user → 404). | 1.3 | **Q1, Q7** |
| 1.7 | Wire `indexService.indexNote()` to read the **`entity:` frontmatter key (Q8)** via a new `FRONTMATTER_ENTITY_RE = /^entity:\s*([!@&$^+])\s*$/m` (same loose-parse shape as the existing `FRONTMATTER_TAG_RE`, `indexService.js:7` — no YAML dep), resolve via `bySymbol()`, and store the **symbol char** (e.g. `&`) into `notes.entity_symbol` (add the column to the `INSERT OR REPLACE … (… entity_symbol)` upsert); absent/invalid → `NULL` (note becomes ordinary). Add indexService test (frontmatter `entity: &` → `notes.entity_symbol = '&'`; absent → `NULL`). Do NOT touch `#tag` or `[[link]]` extraction (D11). | 1.2 | **Q8** (frontmatter key name + value) |
| 1.8 | Wire `auth.js register` to seed per-user data (Q9): call a new `ensureSeedData(userId)` helper (new `server/src/services/entitySeeding.js`) in one transaction — (a) `INSERT OR IGNORE INTO notebooks (user_id, name)` for the six Q3 names (`Events, Locations, NPCs, Items, Traps, Players`), (b) for each symbol, guarded `INSERT INTO templates (user_id, name, content, entity_symbol)` (`name=<label> Template`, `content=Q2 draft`, `entity_symbol=<symbol>`), idempotent (schema-enforced by Q9's unique index). No middleware, no first-request hook, no `runMigrations()` loop (Q9). Add auth test (register → verify 6 seed notebooks + 6 templates with `entity_symbol` set). | 1.2, 1.7 | **Q1, Q3, Q9** |
| 1.8b | Enforce seed-notebook rename lock in `routes/notebooks.js` (`PATCH /:id` → 409 on one of the six plain seed names); verify the existing `DELETE /:id` semantics already leave `templates` rows intact; add notebooks route tests (rename `Events` → 409; delete `Events` → the `!` `templates` row is still present and its content unchanged; all of the notebook's notes are gone from the vault). | 1.8 | **Q3** (rename-forbidden; delete-leaves-template-intact) |
| 1.9 | Update the two baseline test asserts (`notebooks.routes.test.js:70` → expect 6 seeded notebooks; `templates.routes.test.js:21` → expect 6 seeded templates). | 1.8 | D10 (already decided) |
| 1.10 | Full integration: run `npm run test` (server + client), fix any cross-test interference, commit. | 1.1–1.9 | — |

## 4. Phase 2 — Symbol-link editing UX [ ]

- [ ] `client/src/components/editor/symbolLinkComplete.js` (new, beside `wikilinkComplete.js`):
      CodeMirror CompletionSource triggered when text before cursor matches
      `(!!|@@|&&|$$|^^|\+\+)` and that pair was just typed (guard: don't fire on mid-word
      `++` like C++ code — require line-start or whitespace before the pair, and require the
      pair to be a *complete* typed run; refine after first pass).
      Options: pinned **New…** row at top + that type's notes (fetch `GET /api/entity-types/:symbol/notes`).
      - Existing note → insert `&sym Name &sym` (i.e. complete the closing pair).
      - New → small inline name prompt (CodeMirror dialog or a modal component) →
        `POST /api/entity-types/:symbol` → insert link with returned name.
- [ ] Preview (`components/editor/NotePreview.jsx`): extend `preprocessWikilinks()` (or add
      `preprocessEntityLinks()` alongside) — rewrite each `&sym Name &sym` → `[Name](wiki:Name)`
      using the same `wiki:` protocol + `resolve` endpoint, so clicks navigate via existing
      `onNavigate` path. Must run BEFORE remark-gfm parses (so `$$x$$` is not treated as
      anything, `++x++` is not bold — verify against the 6 forms).
      **Display rule (from Q2 2026-10-05)**: render each template section (e.g. Event's
      `Prerequisites` and `Follow-ups`, Location's `Events here`, NPC's `Events`) as its own
      `##`-headed block with its own list of symbol links. Do NOT collapse these into a
      generic "Backlinks" panel, even where the link is conceptually bidirectional.
- [ ] Server extraction (`services/indexService.js`): alongside the `[[ ]]` extractor add an
      entity-link extractor using `linkRegex()` from entityTypes.js → rows in `links` table
      (same shape, so backlinks + graph + FTS work unchanged). Strip entity-link spans from
      the text before FTS indexing? (check what `[[ ]]` does and mirror it.)
- [ ] Sidebar "new note" flow: offer "create entity" → pick type from the 6 → name → same
      `POST /api/entity-types/:symbol` endpoint.
- [ ] `pages/helpContent.js`: document the six symbols, link form, autocomplete trigger,
      New… flow, per-type templates.
- [ ] Browser test (dev server): type `&&` → list appears → pick new "Borg the Black" →
      link `&&Borg the Black&&` inline in note; preview renders clickable link; backlinks
      panel of the NPC note shows the source note. Repeat sanity for all six symbols.

## 5. Phase 3 — AI assist [ ]

- [ ] `server/src/services/aiService.js`: add `draftEntity({symbol, name, extra})`:
      system prompt = that type's template (from entity_templates) as the fill-in shape +
      "you are a D&D DM assistant; fill plausible, in-character detail; return markdown
      matching the template sections" + name as given. Reuse existing Ollama chat loop,
      streaming, budgets, warm path.
- [ ] `routes/entityTypes.js`: `POST /:symbol/draft` → create `jobs` row (reuse jobService +
      WS progress exactly like `routes/dissect.js`) → final content streamed;
      `POST /draft/:jobId/apply` optionally writes/updates the note body.
- [ ] Client: `EditorToolbar` "AI assist" button (visible when note is an entity —
      determined by `entity_symbol` from the note GET payload) → panel reusing
      `DissectPanel.jsx` patterns (progress, preview/edit the draft, Apply / Discard),
      simplified to a single content blob (no multi-note approval).
- [ ] Server test: job lifecycle with a stubbed Ollama (mirror existing dissect tests).
- [ ] Keep existing dissect/import feature untouched (retained, works for free).

## 6. Phase 4 — Deploy (later, on Steve's go) [ ]

- [ ] New private GitHub repo `Jabmist/DMTool`; first push `.32`→GitHub (account token helper).
- [ ] `.202`: new system user + `/opt/dmtl/{app,data}` (mirror obsidian layout);
      clone; `npm ci && npm run build`; **new system user name TBD, suggest `dmtl`**;
      systemd `dmtl-web.service` on **port 3001** (obsidian-web stays 3000);
      Ollama reused (`OLLAMA_BASE_URL` same as obsidian's .env); fresh `.env` with new JWT secrets.
- [ ] Read-only deploy key for DMTool repo (handoff2.md pattern): new keypair on `.202`,
      GitHub deploy key for `Jabmist/DMTool`, SSH config pin (separate from BedRock's).
- [ ] Choose public path: **TBD — suggest `https://www.littlehillservices.com/dnd/`**
      (must be a fresh path; do NOT reuse `/notes/`).
- [ ] `.201`: nginx `location /dnd/` — static root `dmtl/client/dist`,
      proxy `/dnd/api` + `/dnd/ws` (`Upgrade` headers) → `127.0.0.1:3001`;
      301 `/dnd` → `/dnd/`; TLS via existing cert.
- [ ] Client build for the `/dnd/` base — same 4 invariants as notes (handoff2.md):
      `vite.config.js` `base: '/dnd/'` (+ dev proxy keys `/dnd/api`,`/dnd/ws` with rewrite),
      `src/api/client.js` already uses `BASE_URL` relative (verify), `useWebSocket.js`
      URL → `${proto}://${host}/dnd/ws`, `main.jsx` `basename="/dnd"`.
      Dev on `.32` needs `npm run dev` base handling (BASE_URL in dev = `/dnd/` — confirm the
      vite proxy + dev server serve under that mount; mirror whatever obsidian-web does for `/notes/`).
- [ ] Verification checklist: copy handoff2.md's 7-step checklist, rewrite for `/dnd/` +
      :3001 (301, 200 index, asset path check `dnd/assets/index-*.js`, 400 JSON from
      `/dnd/api/auth/login`, 101 WS upgrade).

---

## 7. Cross-cutting rules (every session)

- Test command: `npm run test` (server vitest + client vitest) in the DMTool repo. Must be
  green before moving to next task; never "fix later".
- Lint/typecheck: repo has no separate lint script (verify `package.json` scripts); if you
  add one, record it here for future sessions.
- Git: commit locally each completed task with a clear message; **push only on Steve's
  explicit direction** (also global rule).
- Don't touch `/home/steve/source/Obsidian` once the fork has code — it stays the baseline.
- This plan file stays in the Obsidian repo (baseline's workspace); when the fork proves
  stable, consider moving it into `DMTool/` and re-committing history accordingly.

## 8. Open questions (ask Steve when they bite)

- Public path for deploy (`/dnd/` suggested) — Phase 4.
- `.202` service user name for DMTool (`dmtl` suggested) — Phase 4.
- Templates content: **Q2 (2026-10-05) RESOLVED** — the six starter templates (with Steve's
  Event/Location/NPC adjustments) are the locked seed content in §3b. Still per-user editable at
  runtime via `/api/templates`.
- Multi-DM sharing: notebooks already support sharing; is sharing *campaigns* in scope or
  single-DM local for v1? (baseline sharing retained per decision, but verify it fits.)
