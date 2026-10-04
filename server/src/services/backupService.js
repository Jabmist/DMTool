import crypto from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb, hasDbFile, closeDb, initDb } from '../db/index.js';

const execFileP = promisify(execFile);

// Deferred process restart. A restore replaces the live vault and the on-disk
// db file while the process is still running, so anything with stale state in
// memory (open FTS cursors, cached tokens, the db handle) has to be dropped.
// We therefore schedule a short delayed exit; systemd (obsidian-web) respawns
// the service. `.unref?.()` keeps the pending timer from holding the event
// loop open in tests and short-lived processes.
let restartTimer = null;

export function scheduleRestart(ms = 2000) {
  if (restartTimer) clearTimeout(restartTimer);
  console.log(`[backup] scheduling process restart in ${ms}ms`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    console.log('[backup] restarting process (restore complete)');
    process.exit(0);
  }, ms);
  restartTimer.unref?.();
  return restartTimer;
}

function backupDir() {
  const dir = process.env.BACKUP_DIR;
  if (!dir) throw Object.assign(new Error('BACKUP_DIR is not set'), { status: 500 });
  return dir;
}

function keepWeekly() {
  const n = parseInt(process.env.BACKUP_KEEP_WEEKLY ?? '8', 10);
  return Number.isFinite(n) ? Math.max(0, n) : 8;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

async function countFiles(dir) {
  let n = 0;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) n += await countFiles(full);
    else if (e.isFile()) n += 1;
  }
  return n;
}

async function pruneWeekly() {
  const db = getDb();
  const keep = keepWeekly();
  const stale = db
    .prepare("SELECT id, path FROM backups WHERE kind='weekly' AND status='complete' " +
             "ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?")
    .all(keep);
  let pruned = 0;
  const dir = backupDir();
  for (const r of stale) {
    if (r.path) { try { await fs.unlink(path.join(dir, r.path)); } catch { /* already gone */ } }
    db.prepare('DELETE FROM backups WHERE id = ?').run(r.id);
    pruned += 1;
  }
  if (pruned > 0) console.log(`[backup] pruned ${pruned} old weekly backup(s)`);
  return pruned;
}

let inFlight = null;

export function createBackup(kind = 'manual', createdBy = null) {
  if (inFlight) {
    return Promise.reject(Object.assign(new Error('A backup is already in progress'), { status: 409 }));
  }
  inFlight = runBackup(kind, createdBy).finally(() => { inFlight = null; });
  return inFlight;
}

async function runBackup(kind, createdBy) {
  if (!['manual', 'weekly'].includes(kind)) throw new Error('kind must be manual or weekly');
  const db = getDb();
  const dir = backupDir();
  await fs.mkdir(dir, { recursive: true });
  const vaultRoot = process.env.VAULT_ROOT;
  if (!vaultRoot) throw Object.assign(new Error('VAULT_ROOT is not set'), { status: 500 });

  const id = `${stamp()}-${crypto.randomBytes(3).toString('hex')}`;
  const fileName = `obsidian-${id}.tar.gz`;
  const outFile = path.join(dir, fileName);

  const email = createdBy
    ? (db.prepare('SELECT email FROM users WHERE id = ?').get(createdBy)?.email ?? null)
    : null;
  db.prepare("INSERT INTO backups (id, kind, status, created_by, created_by_email) VALUES (?, ?, 'running', ?, ?)")
    .run(id, kind, createdBy ?? null, email);

  let ok = false;
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-backup-stage-'));
  try {
    const hasDb = hasDbFile();
    if (hasDb) await db.backup(path.join(stage, 'obsidian.db'));

    await fs.mkdir(vaultRoot, { recursive: true });
    await fs.symlink(vaultRoot, path.join(stage, 'vault'), 'dir');

    const members = [...(hasDb ? ['obsidian.db'] : []), 'vault'];
    await execFileP('tar', ['-czf', outFile, '-C', stage, '--dereference', ...members]);

    const sizeBytes = (await fs.stat(outFile)).size;
    const fileCount = await countFiles(vaultRoot);

    db.prepare("UPDATE backups SET status='complete', path=?, size_bytes=?, file_count=?, finished_at=unixepoch() WHERE id=?")
      .run(fileName, sizeBytes, fileCount, id);

    await pruneWeekly();
    ok = true;
    console.log(`[backup] created ${kind} backup ${fileName} (${sizeBytes} bytes, ${fileCount} files)`);
    return { id, path: fileName, sizeBytes, fileCount };
  } catch (e) {
    if (db.prepare('SELECT 1 FROM backups WHERE id = ?').get(id)) {
      db.prepare("UPDATE backups SET status='failed', error=?, finished_at=unixepoch() WHERE id=?")
        .run(String(e?.message ?? e), id);
    }
    console.error(`[backup] ${kind} backup failed:`, String(e?.message ?? e));
    throw e;
  } finally {
    if (!ok) { try { await fs.unlink(outFile); } catch { /* best effort */ } }
    await fs.rm(stage, { recursive: true, force: true });
  }
}

// ── Restore (step #3 of issue #19) ─────────────────────────────────────────
// Restores `backups.id` back over the live state. The archive layout is the
// contract established in step #2: [obsidian.db, vault/], top-level members.
//
// Sequence:
//   1. Validate the row and the archive path.
//   2. Extract to a fresh temp stage (tar -xzf).
//   3. Wipe VAULT_ROOT  → copy the staged vault/ in.
//   4. closeDb()        → better-sqlite3 checkpoints + drops -wal, leaving a
//                          single clean live.db
//   5. copyFile(staged obsidian.db → live.db)
//   6. initDb(live_db_path)  → migrations re-run; idempotent, no data change.
// The caller (step #6 route) is responsible for the deferred process restart so
// the in-memory FTS cursors / job state / cached tokens match the new db file.

function dbPath() {
  const p = process.env.DB_PATH;
  if (!p) throw Object.assign(new Error('DB_PATH is not set'), { status: 500 });
  return p;
}

export function resolveBackupPath(dir, row) {
  if (!row.path) throw Object.assign(new Error('Backup has no archive on disk'), { status: 500 });
  const target = path.resolve(dir, row.path);
  if (!target.startsWith(dir + path.sep) || target === dir) {
    throw Object.assign(new Error('Backup path escapes BACKUP_DIR'), { status: 400 });
  }
  return target;
}

const VAULT_MEMBER = 'vault';
const DB_MEMBER    = 'obsidian.db';

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

let restoreInFlight = false;

export function restoreBackup(id) {
  if (restoreInFlight) {
    return Promise.reject(Object.assign(new Error('A restore is already in progress'), { status: 409 }));
  }
  restoreInFlight = true;
  return runRestore(id).finally(() => { restoreInFlight = false; });
}

async function runRestore(id) {
  const row = getDb().prepare('SELECT * FROM backups WHERE id = ?').get(id) ?? null;
  if (!row) throw Object.assign(new Error('Backup not found'), { status: 404 });
  if (row.status !== 'complete') {
    throw Object.assign(new Error('Backup is not complete'), { status: 409 });
  }

  const dir = backupDir();
  const archive = resolveBackupPath(dir, row);
  await fs.access(archive); // ENOENT → 500

  const root = vaultRootForDb();
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-restore-stage-'));

  try {
    // 1. Unpack to a staging dir — never extract into the live tree in place.
    //    If the archive is corrupt or malformed, we detect before touching anything.
    await execFileP('tar', ['-xzf', archive, '-C', stage]);
    const stagedVault = path.join(stage, VAULT_MEMBER);
    if (!await fileExists(stagedVault)) {
      throw Object.assign(new Error('Archive is missing its vault/ member'), { status: 500 });
    }

    // 2. Wipe the live vault, then bring in the staged tree. This is atomic at
    //    the "wipe first" granularity: after this point the old vault is gone
    //    and the new one will be written; failure here leaves the system in
    //    an empty-vault state (which is what a real restore means), not a
    //    mixed state.
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    await fs.cp(stagedVault, root, { recursive: true });

    // 3. Swap the live DB if we have both a real db file on disk and a db
    //    member in the backup. better-sqlite3's close() runs a final WAL
    //    checkpoint, which drops the -wal/-shm companions, leaving a single
    //    clean .db file for the copy to replace.
    let dbSwapped = false;
    const stagedDb = path.join(stage, DB_MEMBER);
    if (hasDbFile() && await fileExists(stagedDb)) {
      const liveDb = dbPath();            // read only when we will actually swap
      closeDb();                          // checkpoint + drop WAL/SHM
      await fs.copyFile(stagedDb, liveDb);
      initDb(liveDb);                     // re-open; migrations are idempotent
      dbSwapped = true;
    }

    console.log(`[backup] restored ${id} (dbSwapped=${dbSwapped})`);
    return { restored: true, backupId: id, dbSwapped, restartRequired: true };
  } catch (e) {
    console.error('[backup] restore failed for', id, ':', String(e?.message ?? e));
    throw e;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

function vaultRootForDb() {
  const v = process.env.VAULT_ROOT;
  if (!v) throw Object.assign(new Error('VAULT_ROOT is not set'), { status: 500 });
  return v;
}
