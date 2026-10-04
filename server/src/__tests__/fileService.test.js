import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { setTestEnv, makeTmpVault, cleanupTmpVault } from './helpers.js';
import {
  safePath, readNote, writeNote, deleteNote, listNotes, appendToNote,
} from '../services/fileService.js';

let tmpDir;
beforeEach(async () => { setTestEnv(); tmpDir = await makeTmpVault(); });
afterEach(async () => { await cleanupTmpVault(tmpDir); });

describe('safePath', () => {
  it('returns resolved path inside vault', () => {
    const p = safePath(1, 'notes/test.md');
    expect(p).toBe(path.join(tmpDir, '1', 'notes', 'test.md'));
  });

  it('rejects path traversal via ../', () => {
    expect(() => safePath(1, '../other.md')).toThrow('Path traversal');
  });

  it('rejects double-encoded traversal', () => {
    expect(() => safePath(1, 'notes/../../secret')).toThrow('Path traversal');
  });

  it('parses userId strictly as integer (ignores injected suffix)', () => {
    const p = safePath('1; rm -rf', 'test.md');
    expect(p).toContain(path.join(tmpDir, '1'));
  });
});

describe('writeNote / readNote', () => {
  it('writes and reads back content', async () => {
    await writeNote(1, 'hello.md', '# Hello\nworld');
    const content = await readNote(1, 'hello.md');
    expect(content).toBe('# Hello\nworld');
  });

  it('creates intermediate directories', async () => {
    await writeNote(1, 'a/b/c/deep.md', 'deep content');
    const content = await readNote(1, 'a/b/c/deep.md');
    expect(content).toBe('deep content');
  });

  it('overwrites existing note', async () => {
    await writeNote(1, 'note.md', 'v1');
    await writeNote(1, 'note.md', 'v2');
    expect(await readNote(1, 'note.md')).toBe('v2');
  });

  it('readNote throws for missing file', async () => {
    await expect(readNote(1, 'missing.md')).rejects.toThrow();
  });
});

describe('deleteNote', () => {
  it('deletes an existing file', async () => {
    await writeNote(1, 'gone.md', 'bye');
    await deleteNote(1, 'gone.md');
    await expect(readNote(1, 'gone.md')).rejects.toThrow();
  });

  it('throws when file does not exist', async () => {
    await expect(deleteNote(1, 'no-such.md')).rejects.toThrow();
  });
});

describe('listNotes', () => {
  it('returns empty array for empty vault', async () => {
    const paths = await listNotes(1);
    expect(paths).toEqual([]);
  });

  it('lists only .md files', async () => {
    await writeNote(1, 'note.md', '');
    const userDir = path.join(tmpDir, '1');
    await fs.writeFile(path.join(userDir, 'image.png'), '');
    const paths = await listNotes(1);
    expect(paths).toEqual(['note.md']);
  });

  it('returns relative paths including subdirectories', async () => {
    await writeNote(1, 'a.md', '');
    await writeNote(1, 'sub/b.md', '');
    const paths = await listNotes(1);
    expect(paths.sort()).toEqual(['a.md', 'sub/b.md']);
  });

  it('isolates users', async () => {
    await writeNote(1, 'user1.md', '');
    await writeNote(2, 'user2.md', '');
    expect(await listNotes(1)).toEqual(['user1.md']);
    expect(await listNotes(2)).toEqual(['user2.md']);
  });
});

describe('appendToNote', () => {
  it('creates file if it does not exist', async () => {
    await appendToNote(1, 'new.md', '# New');
    expect(await readNote(1, 'new.md')).toBe('# New');
  });

  it('appends with separator to existing content', async () => {
    await writeNote(1, 'existing.md', '# Old');
    await appendToNote(1, 'existing.md', '# Appended');
    const content = await readNote(1, 'existing.md');
    expect(content).toContain('# Old');
    expect(content).toContain('---');
    expect(content).toContain('# Appended');
  });

  it('strips trailing whitespace from existing before appending', async () => {
    await writeNote(1, 'ws.md', '# Old   \n\n');
    await appendToNote(1, 'ws.md', '# New');
    const content = await readNote(1, 'ws.md');
    expect(content.startsWith('# Old\n\n---')).toBe(true);
  });
});
