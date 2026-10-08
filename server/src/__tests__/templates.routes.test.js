import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanupTmpVault } from './helpers.js';

let app, tmpVault, token;

beforeAll(async () => {
  ({ app, tmpVault } = await createTestApp());
  const res = await request(app).post('/api/auth/register').send({ email: 'u@t.com', password: 'password-secure-1' });
  token = res.body.accessToken;
});

afterAll(() => cleanupTmpVault(tmpVault));

function auth() { return { Authorization: `Bearer ${token}` }; }

describe('GET /api/templates', () => {
  it('returns the six entity templates seeded at registration', async () => {
    const res = await request(app).get('/api/templates').set(auth());
    expect(res.status).toBe(200);
    const names = res.body.templates.map(t => t.name).sort();
    // Q2/Q3: six seed templates are created per-user at registration.
    expect(names).toEqual([
      'Event Template',
      'Item Template',
      'Location Template',
      'NPC Template',
      'Player Template',
      'Trap Template',
    ]);
  });

  it('requires auth', async () => {
    expect((await request(app).get('/api/templates')).status).toBe(401);
  });
});

describe('POST /api/templates', () => {
  it('creates a template and returns it', async () => {
    const res = await request(app).post('/api/templates').set(auth())
      .send({ name: 'My Template', content: '# {{title}}\n\nContent here.' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('My Template');
    expect(res.body.id).toBeDefined();
  });

  it('rejects missing name', async () => {
    const res = await request(app).post('/api/templates').set(auth()).send({ content: 'x' });
    expect(res.status).toBe(400);
  });

  it('allows empty content (blank template)', async () => {
    const res = await request(app).post('/api/templates').set(auth()).send({ name: 'Empty' });
    expect(res.status).toBe(201);
  });
});

describe('GET /api/templates/:id', () => {
  let tplId;

  beforeAll(async () => {
    const res = await request(app).post('/api/templates').set(auth())
      .send({ name: 'Full', content: '## heading\n\nparagraph' });
    tplId = res.body.id;
  });

  it('returns template with content', async () => {
    const res = await request(app).get(`/api/templates/${tplId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('## heading\n\nparagraph');
    expect(res.body.name).toBe('Full');
  });

  it('returns 404 for unknown id', async () => {
    expect((await request(app).get('/api/templates/99999').set(auth())).status).toBe(404);
  });

  it('cannot access another user\'s template', async () => {
    const r2 = await request(app).post('/api/auth/register').send({ email: 'u2@t.com', password: 'password-secure-2' });
    // user 2 is pending — admin must approve
    const adminRes = await request(app).post(`/api/admin/users/${r2.body.id ?? 2}/approve`).set(auth());
    const loginRes = await request(app).post('/api/auth/login').send({ email: 'u2@t.com', password: 'password-secure-2' });
    const tok2 = loginRes.body.accessToken;
    const res = await request(app).get(`/api/templates/${tplId}`).set({ Authorization: `Bearer ${tok2}` });
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/templates/:id', () => {
  let tplId;

  beforeAll(async () => {
    const res = await request(app).post('/api/templates').set(auth())
      .send({ name: 'Editable', content: 'original content' });
    tplId = res.body.id;
  });

  it('updates name and content', async () => {
    const res = await request(app).put(`/api/templates/${tplId}`).set(auth())
      .send({ name: 'Renamed', content: 'updated content' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
    expect(res.body.content).toBe('updated content');
  });

  it('persists the update on subsequent GET', async () => {
    const res = await request(app).get(`/api/templates/${tplId}`).set(auth());
    expect(res.body.name).toBe('Renamed');
    expect(res.body.content).toBe('updated content');
  });

  it('rejects missing name', async () => {
    const res = await request(app).put(`/api/templates/${tplId}`).set(auth())
      .send({ content: 'no name' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(app).put('/api/templates/99999').set(auth())
      .send({ name: 'x', content: '' });
    expect(res.status).toBe(404);
  });

  it('cannot edit another user\'s template', async () => {
    const r2 = await request(app).post('/api/auth/register').send({ email: 'u3@t.com', password: 'password-secure-3' });
    const adminRes = await request(app).post(`/api/admin/users/${r2.body.id ?? 3}/approve`).set(auth());
    const loginRes = await request(app).post('/api/auth/login').send({ email: 'u3@t.com', password: 'password-secure-3' });
    const tok2 = loginRes.body.accessToken;
    const res = await request(app).put(`/api/templates/${tplId}`)
      .set({ Authorization: `Bearer ${tok2}` })
      .send({ name: 'hacked', content: '' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/templates/:id', () => {
  it('deletes a template', async () => {
    const create = await request(app).post('/api/templates').set(auth()).send({ name: 'ToDelete', content: '' });
    const id = create.body.id;
    expect((await request(app).delete(`/api/templates/${id}`).set(auth())).status).toBe(200);
    expect((await request(app).get(`/api/templates/${id}`).set(auth())).status).toBe(404);
  });

  it('returns 404 for already-deleted template', async () => {
    expect((await request(app).delete('/api/templates/99999').set(auth())).status).toBe(404);
  });
});

describe('Template list after creates', () => {
  it('lists all created templates ordered by name', async () => {
    const res = await request(app).get('/api/templates').set(auth());
    expect(res.status).toBe(200);
    const names = res.body.templates.map(t => t.name);
    expect(names).toContain('My Template');
    expect(names).toContain('Full');
    // content must not be included in list response
    res.body.templates.forEach(t => expect(t.content).toBeUndefined());
  });
});
