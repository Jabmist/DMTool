import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let db;
let dbPath;

export function getDb() {
  return db;
}

export function getDbPath() {
  return dbPath;
}

// True when the database lives in a real file. ':memory:' databases (tests)
// have nothing on disk to snapshot or restore.
export function hasDbFile() {
  return Boolean(dbPath && dbPath !== ':memory:');
}

export function closeDb() {
  if (db) {
    db.close(); // final WAL checkpoint happens here
    db = undefined;
  }
}

export function reopenDb() {
  if (db) return db;
  return initDb(dbPath);
}

export function initDb(newPath) {
  dbPath = newPath;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations();
  return db;
}

function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT    NOT NULL UNIQUE,
      password   TEXT    NOT NULL,
      role       TEXT    NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token      TEXT    NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      revoked    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      path       TEXT    NOT NULL,
      title      TEXT    NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(user_id, path)
    );

    CREATE TABLE IF NOT EXISTS links (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_path TEXT    NOT NULL,
      target_title TEXT   NOT NULL,
      label       TEXT
    );

    CREATE TABLE IF NOT EXISTS tags (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      path    TEXT    NOT NULL,
      tag     TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id         TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type       TEXT    NOT NULL,
      status     TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','waiting_continue','cancelled','preview','approved','complete','failed')),
      input      TEXT,
      result     TEXT,
      error      TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_links_user_source ON links(user_id, source_path);
  `);
    // Additive migrations — safe to run on existing databases
    try { db.exec('ALTER TABLE links ADD COLUMN label TEXT'); } catch { /* already exists */ }
    try { db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending','active','suspended'))"); } catch { /* already exists */ }
    try { db.exec('ALTER TABLE users ADD COLUMN last_seen_at INTEGER'); } catch { /* already exists */ }

    db.exec(`
      CREATE TABLE IF NOT EXISTS signons (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_signons_user ON signons(user_id, created_at);
    `);

   // CHECK constraints can't be ALTERed in SQLite — rebuild jobs if it was
   // created before 'waiting_continue'/'cancelled' existed.
   const jobsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get()?.sql ?? '';
   if (jobsSql.includes("'pending','processing','preview','approved','complete','failed'")) {
     db.exec(`
       BEGIN;
       CREATE TABLE jobs_migrate (
         id         TEXT    PRIMARY KEY,
         user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         type       TEXT    NOT NULL,
         status     TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','waiting_continue','cancelled','preview','approved','complete','failed')),
         input      TEXT,
         result     TEXT,
         error      TEXT,
         created_at INTEGER NOT NULL DEFAULT (unixepoch()),
         updated_at INTEGER NOT NULL DEFAULT (unixepoch())
       );
       INSERT INTO jobs_migrate SELECT * FROM jobs;
       DROP TABLE jobs;
       ALTER TABLE jobs_migrate RENAME TO jobs;
       COMMIT;
     `);
     console.log('[db] migrated jobs.status CHECK constraint');
   }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_links_user_target ON links(user_id, target_title);
    CREATE INDEX IF NOT EXISTS idx_tags_user_tag     ON tags(user_id, tag);
    CREATE INDEX IF NOT EXISTS idx_notes_user_title  ON notes(user_id, title);
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      title, content, path UNINDEXED, user_id UNINDEXED,
      content='', contentless_delete=1
    );
    CREATE TABLE IF NOT EXISTS notebooks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT    NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(user_id, name)
    );
    CREATE TABLE IF NOT EXISTS notebook_notes (
      notebook_id INTEGER NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL,
      note_path   TEXT    NOT NULL,
      PRIMARY KEY (notebook_id, note_path)
    );
    CREATE TABLE IF NOT EXISTS templates (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT    NOT NULL,
      content    TEXT    NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS notebook_members (
      notebook_id INTEGER NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
      role        TEXT    NOT NULL DEFAULT 'editor' CHECK(role IN ('editor','viewer')),
      invited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      accepted    INTEGER NOT NULL DEFAULT 0,
      invited_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      accepted_at INTEGER,
      PRIMARY KEY (notebook_id, user_id)
    );
      CREATE INDEX IF NOT EXISTS idx_notebook_members_user ON notebook_members(user_id, accepted);
  `);

  // Per-note "updated" dots for shared notebooks: `notebook_note_seen` holds
  // each user's read cursor per note so the server can flag which notes changed
  // since they last opened them.
  db.exec(`
    CREATE TABLE IF NOT EXISTS notebook_note_seen (
      notebook_id INTEGER NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      note_path   TEXT    NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (notebook_id, user_id, note_path)
    );
    CREATE INDEX IF NOT EXISTS idx_notebook_note_seen_user ON notebook_note_seen(user_id);
  `);
  try { db.exec('ALTER TABLE notes ADD COLUMN last_edited_by INTEGER'); } catch { /* already exists */ }

  // Drop the now-obsolete notebook-level "updated" badge plumbing: the
  // per-notebook read cursor table and the `notebooks.updated_at` column it
  // relied on. Both are guarded — a fresh DB never created them, so the DROPs
  // no-op on a clean install.
  try { db.exec('DROP INDEX IF EXISTS idx_notebook_seen_user'); } catch { /* ignore */ }
  try { db.exec('DROP TABLE IF EXISTS notebook_seen'); } catch { /* ignore */ }
  try { db.exec('ALTER TABLE notebooks DROP COLUMN updated_at'); } catch { /* column absent — fresh DB */ }

  // B4: notebook_members.invited_by was `NOT NULL REFERENCES users(id)` with no
  // ON DELETE clause (RESTRICT), so admins could not delete any user who had
  // ever sent an invite. Rebuild the table with `ON DELETE SET NULL`.
  migrateInvitedBy();

  // System backups (issue #19): one row per backup. `path` is the tar.gz
  // relative to BACKUP_DIR; `status` tracks in-flight work so the UI can show
  // progress; `kind` distinguishes scheduled weekly runs from admin-triggered
  // ones.
  db.exec(`
    CREATE TABLE IF NOT EXISTS backups (
      id               TEXT    PRIMARY KEY,
      kind             TEXT    NOT NULL DEFAULT 'manual' CHECK(kind IN ('manual','weekly')),
      status           TEXT    NOT NULL DEFAULT 'running' CHECK(status IN ('running','complete','failed')),
      path             TEXT,
      size_bytes       INTEGER,
      file_count       INTEGER,
      error            TEXT,
      created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by_email TEXT,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      finished_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_backups_created ON backups(created_at DESC);
  `);

  // Admin announcements (issue #16): a single active slot. `start_time` /
  // `end_time` are unix epoch seconds; the announcement is "active" while
  // start_time <= now <= end_time and replaced_at IS NULL. `replaced_at` is a
  // soft mark so the admin can end one early or supersede it without losing
  // the audit trail.
  db.exec(`
    CREATE TABLE IF NOT EXISTS announcements (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      message          TEXT    NOT NULL,
      start_time       INTEGER NOT NULL,
      end_time         INTEGER NOT NULL,
      created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by_email TEXT,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      replaced_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(replaced_at, start_time, end_time);
  `);

  // ── DMTool entity types (Phase 1) ──────────────────────────────────────────
  // `notes.entity_symbol` + `templates.entity_symbol` both hold the one-char
  // symbol (e.g. '&' for NPC), never the name or a compound like '&npc' (Q8).
  // Both are nullable; a note with NULL is an ordinary note.
  try { db.exec('ALTER TABLE notes ADD COLUMN entity_symbol TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE templates ADD COLUMN entity_symbol TEXT'); } catch { /* already exists */ }
  // One seeded template per (user, symbol). SQLite treats NULLs as distinct in
  // a unique index, so pre-existing templates (entity_symbol NULL) never
  // collide, while a second row for the same user+symbol is rejected — making
  // the registration-time seed (ensureSeedData) schema-enforced, not just a
  // SELECT-then-INSERT (Q9).
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_user_entity ON templates(user_id, entity_symbol)');
}

function migrateInvitedBy() {
  const def = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notebook_members'").get()?.sql ?? '';
  if (!/invited_by\s+INTEGER\s+NOT NULL/.test(def)) return;
  db.exec(`
    CREATE TABLE notebook_members_new (
      notebook_id INTEGER NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
      role        TEXT    NOT NULL DEFAULT 'editor' CHECK(role IN ('editor','viewer')),
      invited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      accepted    INTEGER NOT NULL DEFAULT 0,
      invited_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      accepted_at INTEGER,
      PRIMARY KEY (notebook_id, user_id)
    );
    INSERT INTO notebook_members_new (notebook_id, user_id, role, invited_by, accepted, invited_at, accepted_at)
      SELECT notebook_id, user_id, role, invited_by, accepted, invited_at, accepted_at FROM notebook_members;
    DROP TABLE notebook_members;
    ALTER TABLE notebook_members_new RENAME TO notebook_members;
    CREATE INDEX IF NOT EXISTS idx_notebook_members_user ON notebook_members(user_id, accepted);
  `);
}
