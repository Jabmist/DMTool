import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { setTestEnv, makeTmpVault, cleanupTmpVault, setupDb } from './helpers.js';
import { getDb } from '../db/index.js';
import { writeNote } from '../services/fileService.js';
import { indexNote, searchNotes, getBacklinks, getGraph, deleteFtsNote, deleteFtsUser, cleanupOrphanFts } from '../services/indexService.js';

let tmpDir;
beforeEach(async () => {
  setTestEnv();
  tmpDir = await makeTmpVault();
  const db = setupDb();
  // Insert test users so FK constraints pass
  db.prepare("INSERT INTO users (id, email, password) VALUES (1, 'u1@t.com', 'x'), (2, 'u2@t.com', 'x')").run();
});
afterEach(async () => { await cleanupTmpVault(tmpDir); });

describe('indexNote', () => {
  it('inserts a row in notes table', async () => {
    const { getDb } = await import('../db/index.js');
    await writeNote(1, 'Alpha.md', '# Alpha\nsome content');
    await indexNote(1, 'Alpha.md');
    const row = getDb().prepare('SELECT * FROM notes WHERE user_id=1 AND path=?').get('Alpha.md');
    expect(row.title).toBe('Alpha');
  });

  it('extracts wikilinks into links table', async () => {
    const { getDb } = await import('../db/index.js');
    await writeNote(1, 'Source.md', 'See [[Target]] and [[Other|alias]]');
    await indexNote(1, 'Source.md');
    const links = getDb().prepare('SELECT target_title, label FROM links WHERE user_id=1').all();
    expect(links).toEqual(
      expect.arrayContaining([
        { target_title: 'Target', label: null },
        { target_title: 'Other', label: 'alias' },
      ]),
    );
  });

  it('extracts inline tags', async () => {
    const { getDb } = await import('../db/index.js');
    await writeNote(1, 'Tagged.md', 'Hello #mytag and #another/sub');
    await indexNote(1, 'Tagged.md');
    const tags = getDb().prepare('SELECT tag FROM tags WHERE user_id=1').all().map(r => r.tag);
    expect(tags).toContain('mytag');
    expect(tags).toContain('another/sub');
  });

  it('extracts frontmatter tags', async () => {
    const { getDb } = await import('../db/index.js');
    const content = 'tags: [alpha, beta]\n\n# Note';
    await writeNote(1, 'FM.md', content);
    await indexNote(1, 'FM.md');
    const tags = getDb().prepare('SELECT tag FROM tags WHERE user_id=1').all().map(r => r.tag);
    expect(tags).toContain('alpha');
    expect(tags).toContain('beta');
  });

  it('reads the entity frontmatter symbol into notes.entity_symbol', async () => {
    const { getDb } = await import('../db/index.js');
    const content = '---\nentity: &\n---\n\n## Description\nAn NPC.';
    await writeNote(1, 'entities/npc/Borg the Black.md', content);
    await indexNote(1, 'entities/npc/Borg the Black.md');
    const row = getDb().prepare('SELECT entity_symbol FROM notes WHERE user_id=1 AND path=?').get('entities/npc/Borg the Black.md');
    expect(row.entity_symbol).toBe('&');
  });

  it('leaves notes.entity_symbol NULL when the entity key is absent', async () => {
    const { getDb } = await import('../db/index.js');
    await writeNote(1, 'ordinary.md', 'Just a note.');
    await indexNote(1, 'ordinary.md');
    const row = getDb().prepare('SELECT entity_symbol FROM notes WHERE user_id=1 AND path=?').get('ordinary.md');
    expect(row.entity_symbol).toBeNull();
  });

  it('leaves notes.entity_symbol NULL when the entity value is not one of the six symbols', async () => {
    const { getDb } = await import('../db/index.js');
    await writeNote(1, 'badentity.md', '---\nentity: #\n---\n\nBad value.');
    await indexNote(1, 'badentity.md');
    const row = getDb().prepare('SELECT entity_symbol FROM notes WHERE user_id=1 AND path=?').get('badentity.md');
    expect(row.entity_symbol).toBeNull();
  });

  it('re-classifying a note updates entity_symbol', async () => {
    const { getDb } = await import('../db/index.js');
    await writeNote(1, 'Reclassified.md', 'First, no entity.');
    await indexNote(1, 'Reclassified.md');
    expect(getDb().prepare('SELECT entity_symbol FROM notes WHERE user_id=1 AND path=?').get('Reclassified.md').entity_symbol).toBeNull();
    await writeNote(1, 'Reclassified.md', '---\nentity: !\n---\n\nNow an event.');
    await indexNote(1, 'Reclassified.md');
    expect(getDb().prepare('SELECT entity_symbol FROM notes WHERE user_id=1 AND path=?').get('Reclassified.md').entity_symbol).toBe('!');
  });

  it('re-indexing updates stale data', async () => {
    const { getDb } = await import('../db/index.js');
    await writeNote(1, 'Evolving.md', 'First [[LinkA]]');
    await indexNote(1, 'Evolving.md');
    await writeNote(1, 'Evolving.md', 'Second [[LinkB]]');
    await indexNote(1, 'Evolving.md');
    const links = getDb().prepare('SELECT target_title FROM links WHERE user_id=1').all();
    expect(links.map(l => l.target_title)).not.toContain('LinkA');
    expect(links.map(l => l.target_title)).toContain('LinkB');
  });
});

describe('B3 FTS cleanup', () => {
  const ftsRows = () => getDb().prepare('SELECT COUNT(*) AS n FROM notes_fts').get().n;
  const orphans  = () => getDb().prepare('SELECT COUNT(*) AS n FROM notes_fts WHERE rowid NOT IN (SELECT id FROM notes)').get().n;

  it('deleteFtsNote removes the row for a single note', async () => {
    await writeNote(1, 'FtsOne.md', 'one two three');
    await indexNote(1, 'FtsOne.md');
    const before = ftsRows();
    deleteFtsNote(1, 'FtsOne.md');
    expect(ftsRows()).toBe(before - 1);
    expect(orphans()).toBe(0);
  });

  it('deleteFtsUser removes every FTS row for that user', async () => {
    await writeNote(1, 'UA.md', 'alpha row');
    await writeNote(1, 'UB.md', 'beta row');
    await writeNote(2, 'VA.md', 'gamma row');
    await indexNote(1, 'UA.md');
    await indexNote(1, 'UB.md');
    await indexNote(2, 'VA.md');

    const user1Rows = ftsRows();
    deleteFtsUser(1);

    // User 2's row survives; both user-1 rows are gone and nothing orphans.
    expect(ftsRows()).toBe(user1Rows - 2);
    expect(orphans()).toBe(0);
    const { searchNotes } = await import('../services/indexService.js');
    expect((await searchNotes(1, 'alpha')).length).toBe(0);
    expect((await searchNotes(2, 'gamma')).length).toBeGreaterThan(0);
  });

  it('re-indexing a note never orphans the old FTS row (B3 root cause)', async () => {
    for (let i = 0; i < 5; i++) {
      await writeNote(1, `ReIdx${i}.md`, `content take ${i}`);
      await indexNote(1, `ReIdx${i}.md`);
    }
    // The notes table is stable (INSERT OR REPLACE keeps one row per path),
    // so FTS row count must equal notes row count — zero dangling rows.
    const notesN = getDb().prepare('SELECT COUNT(*) n FROM notes').get().n;
    const ftsN   = getDb().prepare('SELECT COUNT(*) n FROM notes_fts').get().n;
    expect(ftsN).toBe(notesN);
    expect(orphans()).toBe(0);
  });

  it('cleanupOrphanFts removes rows whose notes row no longer exists', async () => {
    await writeNote(1, 'OrphanMe.md', 'orphan test content');
    await indexNote(1, 'OrphanMe.md');
    expect(orphans()).toBe(0);

    // Simulate a pre-fix delete: remove the notes row but leave FTS dangling.
    getDb().prepare('DELETE FROM notes WHERE user_id = 1 AND path = ?').run('OrphanMe.md');
    expect(orphans()).toBe(1);

    cleanupOrphanFts();
    expect(orphans()).toBe(0);
  });
});

describe('searchNotes', () => {
  it('returns matching notes', async () => {
    await writeNote(1, 'Quantum.md', 'quantum entanglement is fascinating');
    await indexNote(1, 'Quantum.md');
    const results = await searchNotes(1, 'quantum');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe('Quantum.md');
  });

  it('returns empty array for no match', async () => {
    await writeNote(1, 'Note.md', 'cats and dogs');
    await indexNote(1, 'Note.md');
    await expect(searchNotes(1, 'xyzzy')).resolves.toEqual([]);
  });

  it('does not return results from another user', async () => {
    await writeNote(1, 'Private.md', 'top secret xyzzy');
    await indexNote(1, 'Private.md');
    await expect(searchNotes(2, 'xyzzy')).resolves.toEqual([]);
  });

  it('returns a non-null snippet with the match highlighted', async () => {
    await writeNote(1, 'Photo.md', 'the quick brown fox jumps over the lazy dog near the riverbank');
    await indexNote(1, 'Photo.md');
    const results = await searchNotes(1, 'fox');
    expect(results[0].snippet).toBeTruthy();
    expect(results[0].snippet).toContain('<mark>fox</mark>');
    expect(results[0].snippet).toContain('brown');
  });

  it('centers the snippet around the match, not the start of the note', async () => {
    const pad = 'unrelated filler '.repeat(12);
    await writeNote(1, 'Long.md', pad + 'zebra crossing at midnight');
    await indexNote(1, 'Long.md');
    const results = await searchNotes(1, 'zebra');
    expect(results[0].snippet).toContain('<mark>zebra</mark>');
    // starts mid-document with a leading ellipsis, not at the first word
    expect(results[0].snippet.startsWith('…')).toBe(true);
  });

  it('handles multi-term queries', async () => {
    await writeNote(1, 'Multi.md', 'apples and oranges and grapes in the market');
    await indexNote(1, 'Multi.md');
    const results = await searchNotes(1, 'apples grapes');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].snippet).toContain('<mark>apples</mark>');
  });

  it('returns empty snippet when the file is missing on disk', async () => {
    await writeNote(1, 'Gone.md', 'something findable here');
    await indexNote(1, 'Gone.md');
    await import('../services/fileService.js').then(({ deleteNote }) => deleteNote(1, 'Gone.md'));
    const results = await searchNotes(1, 'findable');
    expect(results[0].snippet).toBe('');
  });
});

describe('getBacklinks', () => {
  it('returns notes that link to the target title', async () => {
    await writeNote(1, 'A.md', 'See [[B]]');
    await writeNote(1, 'B.md', '# B');
    await indexNote(1, 'A.md');
    await indexNote(1, 'B.md');
    const bl = getBacklinks(1, 'B');
    expect(bl.map(r => r.source_path)).toContain('A.md');
  });

  it('returns empty for a note with no backlinks', async () => {
    await writeNote(1, 'Lonely.md', '# Lonely');
    await indexNote(1, 'Lonely.md');
    expect(getBacklinks(1, 'Lonely')).toEqual([]);
  });
});

describe('getGraph', () => {
  it('returns nodes and edges', async () => {
    await writeNote(1, 'N1.md', '[[N2]]');
    await writeNote(1, 'N2.md', '');
    await indexNote(1, 'N1.md');
    await indexNote(1, 'N2.md');
    const graph = getGraph(1);
    expect(graph.nodes.map(n => n.path)).toEqual(expect.arrayContaining(['N1.md', 'N2.md']));
    expect(graph.edges.some(e => e.source_path === 'N1.md' && e.target_title === 'N2')).toBe(true);
  });

  it('includes shared notebook notes for member user', async () => {
    const { getDb } = await import('../db/index.js');
    const db = getDb();

    // Owner (user 1) has a note with a link
    await writeNote(1, 'Shared.md', '[[Target]]');
    await writeNote(1, 'Target.md', '');
    await indexNote(1, 'Shared.md');
    await indexNote(1, 'Target.md');

    // Create a notebook owned by user 1, add both notes
    const { lastInsertRowid: nbId } = db.prepare('INSERT INTO notebooks (user_id, name) VALUES (1, ?)').run('TestNB');
    db.prepare('INSERT INTO notebook_notes (notebook_id, user_id, note_path) VALUES (?, 1, ?)').run(nbId, 'Shared.md');
    db.prepare('INSERT INTO notebook_notes (notebook_id, user_id, note_path) VALUES (?, 1, ?)').run(nbId, 'Target.md');

    // User 2 is an accepted member
    db.prepare('INSERT INTO notebook_members (notebook_id, user_id, role, invited_by, accepted) VALUES (?, 2, ?, 1, 1)').run(nbId, 'editor');

    const graph = getGraph(2);
    const paths = graph.nodes.map(n => n.path);
    expect(paths).toContain('Shared.md');
    expect(paths).toContain('Target.md');

    const sharedNode = graph.nodes.find(n => n.path === 'Shared.md');
    expect(sharedNode.notebookId).toBe(nbId);

    expect(graph.edges.some(e => e.source_path === 'Shared.md' && e.target_title === 'Target')).toBe(true);
  });

  it('does not duplicate a note the member also owns', async () => {
    const { getDb } = await import('../db/index.js');
    const db = getDb();

    await writeNote(1, 'Owned.md', '');
    await indexNote(1, 'Owned.md');
    await writeNote(2, 'Owned.md', '');
    await indexNote(2, 'Owned.md');

    const { lastInsertRowid: nbId } = db.prepare('INSERT INTO notebooks (user_id, name) VALUES (1, ?)').run('NB2');
    db.prepare('INSERT INTO notebook_notes (notebook_id, user_id, note_path) VALUES (?, 1, ?)').run(nbId, 'Owned.md');
    db.prepare('INSERT INTO notebook_members (notebook_id, user_id, role, invited_by, accepted) VALUES (?, 2, ?, 1, 1)').run(nbId, 'editor');

    const graph = getGraph(2);
    const matches = graph.nodes.filter(n => n.path === 'Owned.md');
    expect(matches).toHaveLength(1);
    // Own note takes priority — notebookId is null
    expect(matches[0].notebookId).toBeNull();
  });
});
