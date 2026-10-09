# DMTool — Handoff (2026-10-04)

Read this top-to-bottom to get fully up to speed. Current *state* is read from git
(`git log`, `git status`, the phase checkboxes in `DMTool-PLAN.md` at repo root); this
file is the single source of truth for *intent + conventions*.

---

## 1. What is this project

A **Dungeon & Dragons DM tool**, forked from the `obsidian-web` baseline (a private
web-based Markdown notebook: notes, notebooks, sharing, `[[wikilinks]]`, graph, AI
Dissect, import). The fork is at **`/home/steve/source/DMTool`** (this repo). The
baseline (`/home/steve/source/Obsidian`) is untouched and stays the reference.

The DMTool layer (not yet built — Phases 1–3) adds **typed entities** for a campaign:
each game "entity" kind gets a notebook, a template, symbol-based links, and AI-assist
when filling in details. See §6 for the locked spec.

---

## 2. Stack (unchanged from baseline)

- **Server**: Node 22 (v22.22.2), Express 5, `better-sqlite3` v12 (WAL), ESM. No build step —
  `node --watch --env-file=../.env src/index.js`.
- **Client**: Vite 8 + React 18 (plain JSX, no TS), CodeMirror 6 editor, cytoscape graph,
  zustand, zustand auth store. Build → `client/dist`.
- **Workspaces**: root `package.json` wires `server` + `client`; one root `npm ci` installs both
  and `npm run test` runs both test suites.
- **Native modules** `better-sqlite3` + `bcrypt` must load on Node 22 (verified OK).
- `npm run dev` = `concurrently` (server + client).

Useful root scripts: `npm run dev`, `npm run build`, `npm run start`, `npm run test`.
(No lint/typecheck script exists — there is no `lint` entry to run.)

---

## 3. Environment & local dev

- `.env` (gitignored) — data paths point at **the fork's own** `data/` (independent of the
  baseline, deliberately):
  ```
  NODE_ENV=production  PORT=3000
  VAULT_ROOT=/home/steve/source/DMTool/data/vaults
  UPLOAD_TMP=/home/steve/source/DMTool/data/uploads
  DB_PATH=/home/steve/source/DMTool/data/dmtl.db   # new/empty SQLite DB
  BACKUP_DIR=/home/steve/source/DMTool/data/backups
  OLLAMA_BASE_URL=http://192.168.1.173:11434  OLLAMA_MODEL=qwen3.8
  ```
  (Also present: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_EXPIRES=900`,
  `JWT_REFRESH_EXPIRES=604800`. Do not commit these.)
- `data/` is gitignored (vaults/uploads/backups/*.db). The `data/dmtl.db` file is a fresh,
  empty per-fork database (the backup *archive member name* inside a backup is still literally
  `obsidian.db` — that's an internal naming constant in `backupService.js`, not the file path).
- **Port collision to be aware of**: the baseline Obsidian dev server is often running and
  holds **3000 + 5173**. DMTool's default dev also wants 3000, so it collides. To run DMTool
  side-by-side with the baseline (commit `cc51a5b` made this clean):
  ```
  PORT=3042 DMTL_API_ORIGIN=http://localhost:3042 npm run dev
  ```
  Vite auto-bumps to 5174 when 5173 is taken. `DMTL_API_ORIGIN` (default `http://localhost:3000`)
  is read in `client/vite.config.js` and overrides both `/dmtool/api` and `/dmtool/ws` proxy
  targets. **Production is unaffected** (nginx + server use `.env`, not this var).

### Dev loop (`.32`, this box)
```
edit  →  npm run dev (in repo root)  →  npm run test   →  git add/commit
```
- Verify with `npm run dev` for anything UI/touchy, and **`npm run test` after anything that
  has tests** (server + client vitest). Tests must be green before a task is "done".
- `npm run test` runs server then client; a failure in either aborts.

---

## 4. Deployment pipeline (for later — Phase 4)

Not deployed yet. When it is, mirror the `obsidian-web` pattern (documented in the baseline's
`handoff2.md` and `SETUP.md`, both also copied into this repo's context):

```
dev (.32)                              app (.202)                                  proxy (.201)
edit + git push  →  git pull + npm ci + npm run build  →  rsync + nginx -t
```
- **Repo is private**; `.32` pushes over HTTPS with the GitHub account token (credential helper
  `!gh auth git-credential` — keyless). `.202` pulls over a **read-only deploy key** (see
  baseline `handoff2.md` §Credentials for the rotation procedure).
- `.202`: new system user (suggest `dmtl`) + `/opt/dmtl/{app,data}`; clone; `npm ci && npm run
  build`; `systemctl` service `dmtl-web` on **port 3001** (obsidian-web keeps 3000); Ollama
  reused; fresh `.env` with new JWT secrets.
- `.201`: nginx `location /dmtool/` — static root `dmtl/client/dist`; proxy `/dmtool/api` + `/dmtool/ws`
  (with `Upgrade` headers) → `127.0.0.1:3001`; 301 `/dmtool` → `/dmtool/`; existing TLS cert.
- Client build for the subpath — the **4 invariants** (from baseline `handoff2.md`), all of
  which must resolve to `/dmtool/`: `vite.config.js` `base` + dev proxy keys; `api/client.js`
  `BASE_URL`-relative `resolve()`; `useWebSocket.js` WS URL; `main.jsx` `BrowserRouter basename`.
  In practice only **`vite.config.js` is the hard-coded set** (today `/dmtool/`) — the other
  three derive from `BASE_URL` and follow automatically.
  Leave the `BASE_URL`-relative code untouched. (Detail + exact code in §5.)

**Sanity check before touching nginx (per baseline checklist, rewritten for `/dmtool/`):**
```
grep -o 'dmtool/assets/index-[A-Za-z0-9_-]*\.js' /var/www/dmtool/index.html   # must be "dmtool/assets/..." not "/assets/..."
```

---

## 5. Conventions & gotchas (do not regress)

- **Single source of truth for version + changelog**: `client/src/version.js`.
  `APP_VERSION = '0.1.0'` here; the changelog was **reset to the fork point** (v0.1.0
  "Forked from obsidian-web"). Do **not** rely on `package.json` `"version"` (all `0.1.0`,
  cosmetic). Do **not** try to restore the baseline's 0.21.0 history unless Steve explicitly
  asks.
- **Notes are files (source of truth) + a SQLite index.** Each user's notes are `.md` under
  `VAULT_ROOT/<user_id>/` (see `services/fileService.js`). The DB holds metadata + index only
  (`notes`, `links`, `tags`, FTS5), plus `notebooks`, `templates`, `jobs`, etc. `indexService.js`
  (`indexNote`) upserts the `notes` row, re-extracts `[[wikilinks]]` into `links` and `#tags`
  into `tags`, and rebuilds the FTS row. **This is the integration point for Phase 1/2.**
- **Client build invariants** (must hold for any subpath — `/dmtool/`). Today all
  read the fork's `base: '/dmtool/'`. **`vite.config.js`'s `base` is the single hard-coded
  set**; `client.js` / `useWebSocket.js` / `main.jsx` derive from `BASE_URL` so they follow
  automatically. **Do not hard-code the subpath in those three files.**
  - `vite.config.js`: `base` **and** the dev proxy keys (today `/dmtool/api`, `/dmtool/ws`, with
    rewrite stripping `/dmtool`) — both are the target subpath (`/dmtool/`).
  - `src/api/client.js`: `BASE = BASE_URL` (trailing slash stripped); every fetch via `resolve(url)`.
    `BASE_URL` ends in `/` — never concatenate an absolute path directly (e.g. `/dmtool//api/...`
    would break `location ^~`).
  - `src/hooks/useWebSocket.js` (`useWebSocket.js:21-22`):
    `const base = import.meta.env.BASE_URL.replace(/\/$/, '');` then
    `new WebSocket(`${proto}://${location.host}/${base}/ws`)`.
  - `src/main.jsx:18`: `BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}`.
- **Preview rendering** (`components/editor/NotePreview.jsx`): `[[Target|Alias]]` is preprocessed
  (string `replace`, `WIKILINK_RE`) into `[Alias](wiki:Target)` **before** ReactMarkdown sees it;
  the `wiki:` protocol is allow-listed in the sanitize schema; link clicks call
  `GET /api/notes/resolve?title=…` then `onNavigate(path)`. `rehypeRaw` is on, so raw markup
  like `&&` would otherwise be parsed as an HTML entity — **the preprocess-before-parse order is
  what keeps the double-symbol entity links (Phase 2) from being mangled**.
- **Auth/perm model**: first registered user is admin+active, others `pending` until an admin
  approves (`POST /api/admin/users/:id/approve`). Notebooks are shareable (owner/editor/viewer,
  invite flow, per-note read cursor in `notebook_note_seen`).

---

## 6. Locked spec (Phase 1+ — do not re-litigate without Steve)

- **Folder**: `~/source/DMTool`.
- **Entity types — FIXED set, v1.** Six kinds with collision-free *inline* symbols. A formed
  link is `&sym Name &sym` (the symbol doubled on both sides):

  | sym | type     | link form    | why this symbol                          |
  |-----|----------|--------------|------------------------------------------|
  | `!` | event    | `!!Name!!`   |                                          |
  | `@` | location | `@@Name@@`   |                                          |
  | `&` | npc      | `&&Name&&`   | was `#` — `##`/`#tag` collide            |
  | `$` | item     | `$$Name$$`   |                                          |
  | `^` | trap     | `^^Name^^`   |                                          |
  | `+` | player   | `++Name++`   | was `*` — `**bold**` collides            |

  `#` (NCP) and `*` (player) were replaced precisely because of those collisions. **Do not use
  `#` or `*`.**
- **Editing UX** (Phase 2): the user types the double-symbol pair (e.g. `&&`) → a picker
  appears listing that type's existing notes plus a **"new"** option. Existing → insert the
  closing symbol to form link. "new" → a name field → entity is auto-created **from that type's
  template**, linked, and filed into that type's notebook.
- **Templates** (Phase 1): one template per type ("to be defined later" in the original spec —
  `DMTool.txt`). Per-type notebooks seeded at registration.
- **AI assist** (Phase 3): when filling in an entity's details, an AI-assist option (reuse the
  existing Ollama-backed `services/aiService.js` / dissect job + WebSocket plumbing).
- **Keep all baseline features** (dissect, import, sharing, graph, admin).

### Phase 1 design (agreed in the prior session, NOT yet written)

- `server/src/entityTypes.js` — single source of truth:
  `[{symbol:'!',name:'event',label:'Event'}, … {symbol:'+',name:'player',label:'Player'}]`
  + helpers `bySymbol()`, `linkRegex(symbol)`, and a `defaultTemplate(name, symbol)` builder.
  No DB needed for the registry itself.
- `server/src/db/index.js` `runMigrations()` (additive, the repo's established pattern of
  `CREATE … IF NOT EXISTS` + guarded `ALTER`/`INSERT OR IGNORE`):
  - `ALTER TABLE notes ADD COLUMN entity_symbol TEXT` (guarded).
  - `CREATE TABLE entity_templates (symbol TEXT PRIMARY KEY, name TEXT, label TEXT,
    content TEXT, created_at INTEGER)` + seed one row per symbol.
- `server/src/routes/entityTypes.js`, mounted at `/api/entity-types` in `index.js`
  (auth required):
  - `GET /` → registry.
  - `GET /:symbol/notes` → the user's notes where `entity_symbol = :symbol` (drives the picker).
  - `POST /:symbol` → create entity: body `{name, content?}` → write `.md` under the user's
    vault (default `entities/npc/<slug>.md`), set `entity_symbol`, index the note, optionally
    auto-create (or reuse) that type's notebook and file the note into it. Return `{path, name, symbol}`.
  - Note type carried **in the note frontmatter** (`type: &npc`-style key) **and/or** a `notes`
    column, so it survives and is queryable (decide at implementation; the plan leans on a
    `notes.entity_symbol` column + optional `entity:` frontmatter — keep it consistent with
    `indexNote`).
  - Templates: create per-type "Blank/NPC template" seeded rows in the existing `templates`
    table at user registration **and** expose/edit them via the existing `/api/templates` flow
    (or a new `entityTemplates` route) — pick one approach in Phase 1 and keep the client using it.
- Wire into **`auth.js` `register`** (and backfill for pre-existing users): on registration,
  create the six type-notebooks (or a single "Entities" notebook) + the six templates, idempotently.
- **Server tests** (mirror existing `__tests__/*.routes.test.js` + `helpers.js` `createTestApp`):
  round-trip create/list a type-note; picker endpoint filters correctly; register auto-creates
  notebooks/templates. **NOTE:** two existing baseline tests assert an **empty**
  `GET /api/notebooks` and `GET /api/templates` right after registration
  (`notebooks.routes.test.js:70`, `templates.routes.test.js:21`). If you seed per-user
  notebooks/templates at register (as the spec says), **these two asserts will change** — update
  them to expect the newly-seeded items, and make the new tests assert the same. (That was the
  open thread this handoff resolves: the prior session had just checked these two asserts before
  writing code.)

---

## 7. Key file map (DMTool = same as baseline; only these are DMTool-specific/changed)

- `client/vite.config.js` — the ONLY client file changed in the fork (env-overridable dev proxy,
  commit `cc51a5b`). Default behaviour identical to baseline.
- `client/src/version.js` — reset to `0.1.0` + fork changelog entry (baseline had 0.21.0).
- `client/index.html`, `client/src/components/layout/Header.jsx`,
  `client/src/pages/helpContent.js` (INTRO line) — brand string "Obsidian Web" → "DMTool".
  (The help line "Can I import from desktop Obsidian?" is a legit reference to the real app and
  was intentionally left.)
- `package.json` / `client/package.json` / `server/package.json` — names now `dmtl` /
  `dmtl-client` / `dmtl-server` (lock file updated to match).
- `server/src/services/backupService.js` — still names backup archives `obsidian-*.tar.gz` and
  the archive DB member `obsidian.db`; a test asserts that. Intentionally left (not branding the
  user sees).
- Everything else: **identical to the baseline obsidian-web** (server routes, services, client
  components). Baseline docs for reference: `SETUP.md`, `docs/nginx-notes.md`, `nginx/obsidian.conf`
  (all copied into this repo). The baseline's `handoff2.md` (deploy pattern + credentials +
  verification checklist) lives at `/home/steve/source/Obsidian/handoff2.md`.

---

## 8. Credentials & access

- **Dev (this box)**: you are the repo owner. Plain `git commit` / `git push`.
- **GitHub**: account token via credential helper (already configured on this box). Do **not**
  copy tokens onto `.202`. `git ls-remote origin HEAD` is the quick push-path health check.
  `origin` is the DMTool repo — `https://github.com/Jabmist/DMTool.git` (not the baseline) —
  and local branch `master` tracks `origin/main` (the remote's default branch is `main`; the
  local branch name is `master`, so a plain `git push` pushes `master → main` via
  `push.default=simple`).
- **`/home/steve/source/Obsidian`** is the untouched baseline — read-only reference for you.
- Ollama AI server: `http://192.168.1.173:11434`, model `qwen3.8` (same as baseline `.env`).

---

## 9. How to pick up where this left off

1. You're reading `handoff.md`; next read the task list: `DMTool-PLAN.md` (repo root)
   → §3 **Phase 1** is the next work.
2. Re-run `npm run test` from the repo root — everything green before you start. Start the
   server (`npm run dev`, side-by-side command in §3 if the baseline is on 3000).
3. Implement Phase 1 per §6: `entityTypes.js` → `db` migration → `routes/entityTypes.js` +
   mount in `index.js` → `auth.js` register/seeding → **update the two baseline
   empty-collection test asserts** → add the new Phase 1 tests → `npm run test` green → commit.
4. Phase 2 (client symbol-link picker + `NotePreview` entity-link preprocess + `indexService`
   link extraction) and Phase 3 (AI-draft endpoint + toolbar/panel) follow.
5. **Do not commit to `origin` / push** without Steve's explicit go (global rule).
6. Keep `data/`, `.env`, `node_modules/` out of git (they're gitignored — respect that; a fresh
   clone/`npm ci` recreates `node_modules`, and a fresh `data/dmtl.db` is expected to be empty).

If anything here contradicts the code, **trust the code** and fix this handoff.
