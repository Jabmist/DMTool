import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanupTmpVault } from './helpers.js';

let app, tmpVault, authHeader;

beforeAll(async () => {
  ({ app, tmpVault } = await createTestApp());

  // Register a user and grab the access token
  const reg = await request(app).post('/api/auth/register')
    .send({ email: 'notes@test.com', password: 'notespassword123' });
  authHeader = `Bearer ${reg.body.accessToken}`;
});

afterAll(async () => { await cleanupTmpVault(tmpVault); });

function auth(req) { return req.set('Authorization', authHeader); }

describe('GET /api/notes', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/notes');
    expect(res.status).toBe(401);
  });

  it('returns empty list initially', async () => {
    const res = await auth(request(app).get('/api/notes'));
    expect(res.status).toBe(200);
    expect(res.body.paths).toEqual([]);
  });
});

describe('PUT /api/notes/:path', () => {
  it('creates a note and returns ok', async () => {
    const res = await auth(request(app).put('/api/notes/hello.md').send({ content: '# Hello' }));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('note then appears in GET /api/notes list', async () => {
    const res = await auth(request(app).get('/api/notes'));
    expect(res.body.paths).toContain('hello.md');
  });

  it('returns 400 when content is missing', async () => {
    const res = await auth(request(app).put('/api/notes/bad.md').send({}));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/notes/:path', () => {
  it('returns the note content', async () => {
    const res = await auth(request(app).get('/api/notes/hello.md'));
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('# Hello');
  });

  it('returns 404 for missing note', async () => {
    const res = await auth(request(app).get('/api/notes/missing.md'));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/notes/search', () => {
  it('returns matching results', async () => {
    await auth(request(app).put('/api/notes/search-test.md').send({ content: 'bananas are yellow fruit' }));
    const res = await auth(request(app).get('/api/notes/search?q=bananas'));
    expect(res.status).toBe(200);
    expect(res.body.results.some(r => r.path === 'search-test.md')).toBe(true);
  });

  it('returns 400 without q param', async () => {
    const res = await auth(request(app).get('/api/notes/search'));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/notes/backlinks', () => {
  it('returns notes that link to the given title', async () => {
    await auth(request(app).put('/api/notes/src.md').send({ content: 'See [[Target]]' }));
    await auth(request(app).put('/api/notes/Target.md').send({ content: '# Target' }));
    const res = await auth(request(app).get('/api/notes/backlinks?title=Target'));
    expect(res.status).toBe(200);
    expect(res.body.backlinks.some(b => b.source_path === 'src.md')).toBe(true);
  });

  it('returns 400 without title param', async () => {
    const res = await auth(request(app).get('/api/notes/backlinks'));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/notes/resolve', () => {
  it('resolves a title to its path', async () => {
    await auth(request(app).put('/api/notes/Resolve Me.md').send({ content: '# Resolve Me' }));
    const res = await auth(request(app).get('/api/notes/resolve?title=Resolve%20Me'));
    expect(res.status).toBe(200);
    expect(res.body.path).toBe('Resolve Me.md');
  });

  it('returns 404 for unknown title', async () => {
    const res = await auth(request(app).get('/api/notes/resolve?title=DoesNotExist'));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/notes/graph', () => {
  it('returns nodes and edges', async () => {
    const res = await auth(request(app).get('/api/notes/graph'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(Array.isArray(res.body.edges)).toBe(true);
  });
});

describe('PATCH /api/notes/:path (rename)', () => {
  it('renames a note and returns the new path', async () => {
    await auth(request(app).put('/api/notes/original.md').send({ content: '# Original' }));
    const res = await auth(request(app).patch('/api/notes/original.md').send({ newPath: 'renamed.md' }));
    expect(res.status).toBe(200);
    expect(res.body.newPath).toBe('renamed.md');
  });

  it('new path is accessible; old path is gone', async () => {
    const got  = await auth(request(app).get('/api/notes/renamed.md'));
    const gone = await auth(request(app).get('/api/notes/original.md'));
    expect(got.status).toBe(200);
    expect(got.body.content).toBe('# Original');
    expect(gone.status).toBe(404);
  });

  it('updates the note in the list', async () => {
    const list = await auth(request(app).get('/api/notes'));
    expect(list.body.paths).toContain('renamed.md');
    expect(list.body.paths).not.toContain('original.md');
  });

  it('returns 409 when destination already exists', async () => {
    await auth(request(app).put('/api/notes/existing.md').send({ content: '' }));
    await auth(request(app).put('/api/notes/also-existing.md').send({ content: '' }));
    const res = await auth(request(app).patch('/api/notes/also-existing.md').send({ newPath: 'existing.md' }));
    expect(res.status).toBe(409);
  });

  it('returns 400 when newPath does not end with .md', async () => {
    const res = await auth(request(app).patch('/api/notes/renamed.md').send({ newPath: 'no-extension' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when newPath is missing', async () => {
    const res = await auth(request(app).patch('/api/notes/renamed.md').send({}));
    expect(res.status).toBe(400);
  });

  it('no-op when newPath equals current path', async () => {
    const res = await auth(request(app).patch('/api/notes/renamed.md').send({ newPath: 'renamed.md' }));
    expect(res.status).toBe(200);
  });

  it('updates [[wikilinks]] in other notes that reference the old title', async () => {
    await auth(request(app).put('/api/notes/LinkSource.md').send({ content: 'See [[LinkTarget]] and [[LinkTarget|alias]]' }));
    await auth(request(app).put('/api/notes/LinkTarget.md').send({ content: '# Target' }));
    await auth(request(app).patch('/api/notes/LinkTarget.md').send({ newPath: 'LinkRenamed.md' }));
    const src = await auth(request(app).get('/api/notes/LinkSource.md'));
    expect(src.body.content).toContain('[[LinkRenamed]]');
    expect(src.body.content).toContain('[[LinkRenamed|alias]]');
    expect(src.body.content).not.toContain('[[LinkTarget]]');
  });

  it('reports linksUpdated count in response', async () => {
    await auth(request(app).put('/api/notes/CountA.md').send({ content: '[[CountTarget]]' }));
    await auth(request(app).put('/api/notes/CountB.md').send({ content: '[[CountTarget]]' }));
    await auth(request(app).put('/api/notes/CountTarget.md').send({ content: '# Count' }));
    const res = await auth(request(app).patch('/api/notes/CountTarget.md').send({ newPath: 'CountNew.md' }));
    expect(res.body.linksUpdated).toBe(2);
  });

  it('preserves notebook membership after rename', async () => {
    const nb = await auth(request(app).post('/api/notebooks').send({ name: 'Rename NB' }));
    await auth(request(app).put('/api/notes/nb-note.md').send({ content: '' }));
    await auth(request(app).put(`/api/notebooks/${nb.body.id}/notes`).send({ path: 'nb-note.md' }));
    await auth(request(app).patch('/api/notes/nb-note.md').send({ newPath: 'nb-note-renamed.md' }));
    const members = await auth(request(app).get(`/api/notebooks/${nb.body.id}/notes`));
    expect(members.body.paths).toContain('nb-note-renamed.md');
    expect(members.body.paths).not.toContain('nb-note.md');
  });
});

describe('DELETE /api/notes/:path', () => {
  it('deletes a note', async () => {
    await auth(request(app).put('/api/notes/tobedeleted.md').send({ content: 'bye' }));
    const del = await auth(request(app).delete('/api/notes/tobedeleted.md'));
    expect(del.status).toBe(200);
    const get = await auth(request(app).get('/api/notes/tobedeleted.md'));
    expect(get.status).toBe(404);
  });

  it('removed from note list after deletion', async () => {
    const list = await auth(request(app).get('/api/notes'));
    expect(list.body.paths).not.toContain('tobedeleted.md');
  });

  it('removes the FTS row when a note is deleted (B3)', async () => {
    const { getDb } = await import('../db/index.js');
    const db = getDb();
    const orphans = () => db.prepare('SELECT COUNT(*) AS n FROM notes_fts WHERE rowid NOT IN (SELECT id FROM notes)').get().n;

    await auth(request(app).put('/api/notes/ftstest.md').send({ content: 'zebra quantum banana' }));
    expect(db.prepare('SELECT id FROM notes WHERE path = ?').get('ftstest.md')).toBeDefined();
    expect(orphans()).toBe(0);

    const del = await auth(request(app).delete('/api/notes/ftstest.md'));
    expect(del.status).toBe(200);

    // The notes row is gone AND no FTS row may dangle off it (the orphan class).
    expect(db.prepare('SELECT id FROM notes WHERE path = ?').get('ftstest.md')).toBeUndefined();
    expect(orphans()).toBe(0);
  });
});
