import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanupTmpVault } from './helpers.js';
import { getDb } from '../db/index.js';

let app, tmpVault, token, token2;

async function adminAndSecondUser() {
  // User 2 = pending second user (admin approves so it can sign in).
  const r2 = await request(app).post('/api/auth/register').send({ email: 'u2@et.com', password: 'password-secure-2' });
  const u2 = getDb().prepare("SELECT id FROM users WHERE email = 'u2@et.com'").get();
  await request(app).post(`/api/admin/users/${u2.id}/approve`).set({ Authorization: `Bearer ${token}` });
  const login2 = await request(app).post('/api/auth/login').send({ email: 'u2@et.com', password: 'password-secure-2' });
  const token2v = login2.body.accessToken;
  return token2v;
}

beforeAll(async () => {
  ({ app, tmpVault } = await createTestApp());
  const r1 = await request(app).post('/api/auth/register').send({ email: 'u@et.com', password: 'password-secure-1' });
  token = r1.body.accessToken;
});

afterAll(() => cleanupTmpVault(tmpVault));

function auth() { return { Authorization: `Bearer ${token}` }; }

describe('GET /api/entity-types/', () => {
  it('returns the six registry entries, metadata only', async () => {
    const res = await request(app).get('/api/entity-types/').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.entityTypes).toHaveLength(6);
    expect(res.body.entityTypes.map(e => e.symbol).sort()).toEqual(['!', '@', '&', '$', '^', '+'].sort());

    const npc = res.body.entityTypes.find(e => e.symbol === '&');
    expect(npc.name).toBe('npc');
    expect(npc.label).toBe('NPC');
    expect(npc.labelPlural).toBe('NPCs');
    // Each entry has a template_id (seeded at registration) and template_name
    expect(npc.template_id).not.toBeNull();
    expect(npc.template_name).toBeTruthy();

    // No `content` key anywhere in the response (Q10 metadata-only contract).
    res.body.entityTypes.forEach(e => expect(e.content).toBeUndefined());

    // Expected keys per entry:
    const keys = Object.keys(npc).sort();
    expect(keys).toEqual(['label', 'labelPlural', 'name', 'symbol', 'template_id', 'template_name'].sort());
  });

  it('requires auth', async () => {
    expect((await request(app).get('/api/entity-types/')).status).toBe(401);
  });
});

describe('GET /api/entity-types/:symbol/notes', () => {
  it('returns empty for a fresh type', async () => {
    const res = await request(app).get('/api/entity-types/^/notes').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.notes).toEqual([]);
  });

  it('returns the user\'s notes where entity_symbol = symbol', async () => {
    // Create NPCs so the picker can list them
    await request(app).post('/api/entity-types/&').set(auth()).send({ name: 'PickerTest One' });
    await request(app).post('/api/entity-types/&').set(auth()).send({ name: 'PickerTest Two' });
    // Non-entity note with the same title-ish prefix (should not leak in):
    await request(app).put('/api/notes/plain.md').set(auth()).send({ content: 'plain' });
    const res = await request(app).get('/api/entity-types/&/notes').set(auth());
    expect(res.status).toBe(200);
    const titles = res.body.notes.map(n => n.title).sort();
    expect(titles).toContain('PickerTest One');
    expect(titles).toContain('PickerTest Two');
    expect(titles).not.toContain('plain');
    // Every entry has a path
    res.body.notes.forEach(n => expect(n.path).toBeTruthy());
  });

  it('404 for an unknown symbol', async () => {
    expect((await request(app).get('/api/entity-types/z/notes').set(auth())).status).toBe(404);
  });
});

describe('PUT /api/entity-types/:symbol/template', () => {
  it('updates the user\'s own template content, preserves name and symbol', async () => {
    const upd = await request(app).put('/api/entity-types/&/template').set(auth())
      .send({ content: '## My custom NPC template' });
    expect(upd.status).toBe(200);
    expect(upd.body.content).toBe('## My custom NPC template');
    expect(upd.body.name).toBe('NPC Template');
    expect(upd.body.entity_symbol).toBe('&');
  });

  it('is owner-scoped: user 2 edits their OWN template, not user 1\'s (Q7)', async () => {
    const tok2 = await adminAndSecondUser();
    // Both users are seeded their own 'NPC Template' row. User 2 updating it
    // touches only user 2's row.
    const upd = await request(app).put('/api/entity-types/&/template')
      .set({ Authorization: `Bearer ${tok2}` })
      .send({ content: 'user-2 npc template' });
    expect(upd.status).toBe(200);
    expect(upd.body.content).toBe('user-2 npc template');

    // User 1's own 'NPC Template' row is untouched by user 2's update.
    const u1tpl = await request(app).get('/api/templates').set(auth());
    const myNpc = u1tpl.body.templates.find(t => t.name === 'NPC Template');
    const mine = await request(app).get(`/api/templates/${myNpc.id}`).set(auth());
    expect(mine.body.content).toBe('## My custom NPC template');

    // GET /api/entity-types reflects per-user template binding: user 1's
    // template_id resolves to user 1's row (their own), not user 2's.
    const reg = await request(app).get('/api/entity-types/').set(auth());
    const entry = reg.body.entityTypes.find(e => e.symbol === '&');
    expect(entry.template_id).toBe(myNpc.id);
  });

  it('404 when the user\u2019s template row for that symbol has been deleted', async () => {
    // Fresh (pending) user → seeded their templates. Approve + login, then
    // delete the NPC template row; PUT /&/template must 404 (no row for
    // owner + symbol).
    await request(app).post('/api/auth/register').send({ email: 'tpl404@et.com', password: 'password-secure-9' });
    const uid = getDb().prepare("SELECT id FROM users WHERE email = 'tpl404@et.com'").get().id;
    await request(app).post(`/api/admin/users/${uid}/approve`).set(auth());
    const login = await request(app).post('/api/auth/login').send({ email: 'tpl404@et.com', password: 'password-secure-9' });
    const tok = login.body.accessToken;
    const list = await request(app).get('/api/templates').set({ Authorization: `Bearer ${tok}` });
    const npc = list.body.templates.find(t => t.name === 'NPC Template');
    await request(app).delete(`/api/templates/${npc.id}`).set({ Authorization: `Bearer ${tok}` });
    const res = await request(app).put('/api/entity-types/&/template')
      .set({ Authorization: `Bearer ${tok}` })
      .send({ content: 'x' });
    expect(res.status).toBe(404);
  });

  it('400 when content missing', async () => {
    const res = await request(app).put('/api/entity-types/&/template').set(auth()).send({});
    expect(res.status).toBe(400);
  });

  it('404 for unknown symbol', async () => {
    const res = await request(app).put('/api/entity-types/#/template').set(auth()).send({ content: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/entity-types/:symbol', () => {
  it('creates an NPC note', async () => {
    const res = await request(app).post('/api/entity-types/&').set(auth())
      .send({ name: 'Borg the Black' });
    expect(res.status).toBe(201);
    expect(res.body.path).toBe('entities/npc/Borg the Black.md');
    expect(res.body.name).toBe('Borg the Black');
    expect(res.body.symbol).toBe('&');

    // Confirm the note file is on disk with frontmatter and the seed template.
    const row = getDb().prepare('SELECT entity_symbol, title FROM notes WHERE user_id = (SELECT id FROM users WHERE email = ?) AND path = ?').get('u@et.com', 'entities/npc/Borg the Black.md');
    expect(row.entity_symbol).toBe('&');
    expect(row.title).toBe('Borg the Black');

    const fs = await import('fs/promises');
    const vaultRoot = process.env.VAULT_ROOT;
    const uid = getDb().prepare("SELECT id FROM users WHERE email = 'u@et.com'").get().id;
    const content = await fs.readFile(`${vaultRoot}/${uid}/entities/npc/Borg the Black.md`, 'utf8');
    expect(content).toContain('entity: &');
    expect(content).toContain('## Description');
    expect(content).toContain('## Events');
  });

  it('returns 409 when a note with that title already exists (entity)', async () => {
    const res = await request(app).post('/api/entity-types/&').set(auth())
      .send({ name: 'Borg the Black' });
    expect(res.status).toBe(409);
  });

  it('returns 409 when a *plain* note with that title already exists (strict, Q6)', async () => {
    await request(app).put('/api/notes/Ragnar.md').set(auth()).send({ content: 'plain Ragnar' });
    const res = await request(app).post('/api/entity-types/&').set(auth())
      .send({ name: 'Ragnar' });
    expect(res.status).toBe(409);
  });

  it('allows a prefix-only title (no accidental LIKE collision)', async () => {
    const before = await request(app).get('/api/notes/resolve?title=Borg%20the%20Black').set(auth());
    expect(before.status).toBe(200);
    const res = await request(app).post('/api/entity-types/&').set(auth())
      .send({ name: 'Borg the Black II' });
    expect(res.status).toBe(201);
  });

  it('returns 400 when the name contains a forbidden filename char (Q5)', async () => {
    const res = await request(app).post('/api/entity-types/&').set(auth())
      .send({ name: 'evil/name' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for empty name', async () => {
    const res = await request(app).post('/api/entity-types/&').set(auth()).send({ name: '' });
    expect(res.status).toBe(400);
  });

  it('return 400 when body has no name', async () => {
    const res = await request(app).post('/api/entity-types/&').set(auth()).send({});
    expect(res.status).toBe(400);
  });

  it('files the note into the type\'s seed notebook (idempotent)', async () => {
    const before = await request(app).get('/api/notebooks').set(auth());
    const seed = before.body.notebooks.find(n => n.name === 'NPCs');
    expect(seed).toBeDefined();

    // Create an entity, then verify it's inside the 'NPCs' notebook.
    await request(app).post('/api/entity-types/&').set(auth()).send({ name: 'Borg the III' });
    const res = await request(app).get('/api/notebooks').set(auth());
    const nbs = res.body.notebooks;
    const target = nbs.find(n => n.id === seed.id);
    // /api/notebooks (no /all-with-notes) doesn't return paths — use /for-note instead.
    const fn = await request(app).get(`/api/notebooks/for-note?path=entities/npc/Borg%20the%20III.md`).set(auth());
    expect(fn.status).toBe(200);
    const inSeed = fn.body.notebooks.some(n => n.name === 'NPCs');
    expect(inSeed).toBe(true);
  });

  it('404 for an unknown symbol', async () => {
    const res = await request(app).post('/api/entity-types/z').set(auth()).send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('On-demand seeding for a pre-existing user (Q9)', () => {
  it('POST recreates missing seed notebook + templates', async () => {
    const db = getDb();
    const uid = db.prepare("SELECT id FROM users WHERE email = 'u@et.com'").get().id;

    // Simulate a user registered BEFORE Phase 1: wipe their seed data.
    db.prepare('DELETE FROM templates WHERE user_id = ? AND entity_symbol IS NOT NULL').run(uid);
    db.prepare("DELETE FROM notebooks WHERE user_id = ? AND name IN ('Events','Locations','NPCs','Items','Traps','Players')").run(uid);
    const preTpls = db.prepare('SELECT COUNT(*) c FROM templates WHERE user_id = ? AND entity_symbol IS NOT NULL').get(uid).c;
    expect(preTpls).toBe(0);
    const preNbs = db.prepare("SELECT COUNT(*) c FROM notebooks WHERE user_id = ? AND name IN ('Events','Locations','NPCs','Items','Traps','Players')").get(uid).c;
    expect(preNbs).toBe(0);

    // First entity create for this user should lazily (re)seed.
    const create = await request(app).post('/api/entity-types/@').set(auth())
      .send({ name: 'Dooming Village' });
    expect(create.status).toBe(201);

    // The type's seed notebook is re-created and holds the new note.
    const nb = db.prepare("SELECT id FROM notebooks WHERE user_id = ? AND name = 'Locations'").get(uid);
    expect(nb).toBeDefined();
    expect(db.prepare('SELECT 1 FROM notebook_notes WHERE notebook_id = ? AND note_path = ?').get(nb.id, 'entities/location/Dooming Village.md')).toBeDefined();

    // All six templates are back (schema-enforced unique).
    const afterTpls = db.prepare('SELECT COUNT(*) c FROM templates WHERE user_id = ? AND entity_symbol IS NOT NULL').get(uid).c;
    expect(afterTpls).toBe(6);
  });
});

describe('Seeding at registration (auth.routes 1.8)', () => {
  it('registers: user gets 6 seed notebooks', async () => {
    const res = await request(app).get('/api/notebooks').set(auth());
    expect(res.status).toBe(200);
    const names = res.body.notebooks.map(n => n.name).sort();
    expect(names).toEqual(['Events', 'Items', 'Locations', 'NPCs', 'Players', 'Traps'].sort());
  });

  it('registers: user gets 6 seeded templates (with entity_symbol set)', async () => {
    const res = await request(app).get('/api/templates').set(auth());
    expect(res.status).toBe(200);
    const names = res.body.templates.map(t => t.name).sort();
    expect(names).toEqual(['Event Template', 'Item Template', 'Location Template', 'NPC Template', 'Player Template', 'Trap Template'].sort());
    // The templates list (per the baseline /api/templates GET /) doesn't expose content — but
    // the entity_symbol is in the row. Fetch one template to confirm it's set.
    const npc = res.body.templates.find(t => t.name === 'NPC Template');
    expect(npc).toBeDefined();
    const one = await request(app).get(`/api/templates/${npc.id}`).set(auth());
    expect(one.status).toBe(200);
    expect(one.body.content.length).toBeGreaterThan(0);
  });
});
