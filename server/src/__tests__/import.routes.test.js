import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import request from 'supertest';
import AdmZip from 'adm-zip';
import { createTestApp, cleanupTmpVault } from './helpers.js';

let app, tmpVault, authHeader;

beforeAll(async () => {
  ({ app, tmpVault } = await createTestApp());
  const reg = await request(app).post('/api/auth/register')
    .send({ email: 'import@test.com', password: 'importpassword123' });
  authHeader = `Bearer ${reg.body.accessToken}`;
});

afterAll(async () => { await cleanupTmpVault(tmpVault); });
afterEach(() => { vi.unstubAllGlobals(); });

function auth(req) { return req.set('Authorization', authHeader); }

function makeFetchMock(html, { ok = true, contentType = 'text/html; charset=utf-8' } = {}) {
  const buf = Buffer.from(html);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 404,
    statusText: ok ? 'OK' : 'Not Found',
    headers: { get: name => name === 'content-type' ? contentType : null },
    body: {
      getReader: () => {
        let done = false;
        return {
          read: vi.fn().mockImplementation(async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: new Uint8Array(buf) };
          }),
        };
      },
    },
  }));
}

const SAMPLE_ARTICLE_HTML = `<!DOCTYPE html>
<html><head><title>Photosynthesis Guide</title></head>
<body>
  <nav>Skip this nav</nav>
  <article>
    <h1>Photosynthesis Guide</h1>
    <p>Photosynthesis is the process by which plants convert sunlight into energy.
    Chlorophyll in the leaves absorbs light and drives the conversion of carbon dioxide
    and water into glucose and oxygen. This process is fundamental to almost all life on Earth.</p>
    <p>The light-dependent reactions occur in the thylakoid membranes, while the
    Calvin cycle takes place in the stroma of the chloroplast.</p>
  </article>
</body></html>`;

// ---------------------------------------------------------------------------
// POST /api/import/file
// ---------------------------------------------------------------------------
describe('POST /api/import/file', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).post('/api/import/file')
      .attach('file', Buffer.from('# Hello'), { filename: 'hello.md', contentType: 'text/markdown' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when no file provided', async () => {
    const res = await auth(request(app).post('/api/import/file'));
    expect(res.status).toBe(400);
  });

  it('imports a valid .md file', async () => {
    const res = await auth(request(app).post('/api/import/file'))
      .attach('file', Buffer.from('# Imported\n\nHello.'), { filename: 'imported.md', contentType: 'text/markdown' })
      .field('conflict', 'overwrite');
    expect(res.status).toBe(200);
    expect(res.body.written).toContain('imported.md');
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/vault
// ---------------------------------------------------------------------------
describe('POST /api/import/vault', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).post('/api/import/vault')
      .attach('vault', Buffer.from('not a zip'), { filename: 'vault.zip', contentType: 'application/zip' });
    expect(res.status).toBe(401);
  });

  it('returns 400 for non-zip content', async () => {
    const res = await auth(request(app).post('/api/import/vault'))
      .attach('vault', Buffer.from('not a zip'), { filename: 'vault.zip', contentType: 'application/zip' })
      .field('conflict', 'overwrite');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ZIP/i);
  });

  it('imports .md files from a valid zip, skipping .obsidian/ and unsupported types', async () => {
    const zip = new AdmZip();
    zip.addFile('notes/biology.md', Buffer.from('# Biology\n\nCells.'));
    zip.addFile('notes/ignored.html', Buffer.from('<p>ignored</p>'));
    zip.addFile('.obsidian/workspace.json', Buffer.from('{}'));
    const buf = zip.toBuffer();

    const res = await auth(request(app).post('/api/import/vault'))
      .attach('vault', buf, { filename: 'vault.zip', contentType: 'application/zip' })
      .field('conflict', 'overwrite');
    expect(res.status).toBe(200);
    expect(res.body.written).toContain('notes/biology.md');
    expect(res.body.written.some(p => p.includes('.obsidian'))).toBe(false);
    expect(res.body.written.some(p => p.endsWith('.html'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/text
// ---------------------------------------------------------------------------
describe('POST /api/import/text', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).post('/api/import/text')
      .send({ text: 'hello', filename: 'test' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when text is missing', async () => {
    const res = await auth(request(app).post('/api/import/text')).send({ filename: 'test' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/text required/i);
  });

  it('returns 400 when filename is missing', async () => {
    const res = await auth(request(app).post('/api/import/text')).send({ text: 'hello' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/filename required/i);
  });

  it('returns 400 for a filename with path traversal characters', async () => {
    const res = await auth(request(app).post('/api/import/text'))
      .send({ text: 'hello', filename: '../etc/passwd' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid filename/i);
  });

  it('creates a note from pasted text', async () => {
    const res = await auth(request(app).post('/api/import/text'))
      .send({ text: '# Gravity\n\nObjects fall.', filename: 'Gravity Notes' });
    expect(res.status).toBe(200);
    expect(res.body.written).toContain('Gravity Notes.md');
  });

  it('accepts a filename that already includes .md', async () => {
    const res = await auth(request(app).post('/api/import/text'))
      .send({ text: 'Some content', filename: 'Already Has Extension.md' });
    expect(res.status).toBe(200);
    expect(res.body.written).toContain('Already Has Extension.md');
  });

  it('skips when note exists and conflict=skip', async () => {
    await auth(request(app).post('/api/import/text'))
      .send({ text: 'Original', filename: 'Skip Test', conflict: 'overwrite' });

    const res = await auth(request(app).post('/api/import/text'))
      .send({ text: 'New content', filename: 'Skip Test', conflict: 'skip' });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toContain('Skip Test.md');
    expect(res.body.written).toHaveLength(0);
  });

  it('appends when note exists and conflict=append', async () => {
    await auth(request(app).post('/api/import/text'))
      .send({ text: 'First part.', filename: 'Append Test', conflict: 'overwrite' });

    const res = await auth(request(app).post('/api/import/text'))
      .send({ text: 'Second part.', filename: 'Append Test', conflict: 'append' });
    expect(res.status).toBe(200);
    expect(res.body.written).toContain('Append Test.md');

    const note = await auth(request(app).get('/api/notes/Append%20Test.md'));
    expect(note.body.content).toContain('First part.');
    expect(note.body.content).toContain('Second part.');
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/url
// ---------------------------------------------------------------------------
describe('POST /api/import/url', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).post('/api/import/url').send({ url: 'https://example.com' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when url is missing', async () => {
    const res = await auth(request(app).post('/api/import/url')).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/url required/i);
  });

  it('returns 400 for an invalid URL', async () => {
    const res = await auth(request(app).post('/api/import/url')).send({ url: 'not-a-url' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid URL/i);
  });

  it('returns 400 for a non-http(s) URL', async () => {
    const res = await auth(request(app).post('/api/import/url')).send({ url: 'ftp://example.com/file' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/http/i);
  });

  it('returns 400 for a private/internal host', async () => {
    for (const url of ['http://localhost/page', 'http://127.0.0.1/page', 'http://192.168.1.1/page']) {
      const res = await auth(request(app).post('/api/import/url')).send({ url });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/private|internal/i);
    }
  });

  it('returns 400 when fetch returns non-OK status', async () => {
    makeFetchMock('', { ok: false });
    const res = await auth(request(app).post('/api/import/url'))
      .send({ url: 'https://example.com/missing' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fetch failed/i);
  });

  it('returns 400 when response is not HTML', async () => {
    makeFetchMock('{}', { contentType: 'application/json' });
    const res = await auth(request(app).post('/api/import/url'))
      .send({ url: 'https://example.com/data.json' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/html/i);
  });

  it('imports a URL and saves note using page title as filename', async () => {
    makeFetchMock(SAMPLE_ARTICLE_HTML);
    const res = await auth(request(app).post('/api/import/url'))
      .send({ url: 'https://example.com/photosynthesis' });
    expect(res.status).toBe(200);
    expect(res.body.written).toHaveLength(1);
    expect(res.body.written[0]).toMatch(/photosynthesis/i);
  });

  it('uses provided filename instead of page title', async () => {
    makeFetchMock(SAMPLE_ARTICLE_HTML);
    const res = await auth(request(app).post('/api/import/url'))
      .send({ url: 'https://example.com/photosynthesis', filename: 'My Custom Name' });
    expect(res.status).toBe(200);
    expect(res.body.written).toContain('My Custom Name.md');
  });

  it('includes source URL and page title in the saved note', async () => {
    makeFetchMock(SAMPLE_ARTICLE_HTML);
    await auth(request(app).post('/api/import/url'))
      .send({ url: 'https://example.com/photo2', filename: 'Photo Source Test' });

    const note = await auth(request(app).get('/api/notes/Photo%20Source%20Test.md'));
    expect(note.body.content).toContain('https://example.com/photo2');
    expect(note.body.content).toContain('Photosynthesis');
  });
});
