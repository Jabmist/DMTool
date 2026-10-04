import fs from 'fs/promises';
import path from 'path';

export function vaultRoot(userId) {
  const root = process.env.VAULT_ROOT;
  // Prevent path traversal: userId is always a DB integer
  return path.join(root, String(parseInt(userId, 10)));
}

export function safePath(userId, notePath) {
  const root = vaultRoot(userId);
  const resolved = path.resolve(root, notePath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw Object.assign(new Error('Path traversal detected'), { status: 400 });
  }
  return resolved;
}

export async function readNote(userId, notePath) {
  const full = safePath(userId, notePath);
  return fs.readFile(full, 'utf8');
}

export async function writeNote(userId, notePath, content) {
  const full = safePath(userId, notePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

export async function deleteNote(userId, notePath) {
  const full = safePath(userId, notePath);
  await fs.unlink(full);
}

export async function listNotes(userId) {
  const root = vaultRoot(userId);
  await fs.mkdir(root, { recursive: true });
  return walk(root, root);
}

async function walk(dir, root) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      results.push(...await walk(full, root));
    } else if (e.name.endsWith('.md')) {
      results.push(path.relative(root, full));
    }
  }
  return results;
}

export async function appendToNote(userId, notePath, section) {
  let existing = '';
  try { existing = await readNote(userId, notePath); } catch { /* new file */ }
  const separator = existing.trimEnd() ? '\n\n---\n\n' : '';
  await writeNote(userId, notePath, existing.trimEnd() + separator + section);
}
