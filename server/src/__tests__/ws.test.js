import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { setTestEnv, setupDb, makeTmpVault, cleanupTmpVault } from './helpers.js';
import { initWs, broadcast, broadcastToNotebook } from '../ws/index.js';
import { getDb } from '../db/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server, wss, tmpVault, port;

beforeAll(async () => {
  setTestEnv();
  tmpVault = await makeTmpVault();
  const db = setupDb();
  db.prepare("INSERT INTO users (id, email, password, role) VALUES (?, ?, ?, 'user')").run(1, 'u1@test.com', 'x');
  db.prepare("INSERT INTO users (id, email, password, role) VALUES (?, ?, ?, 'user')").run(2, 'u2@test.com', 'x');
  db.prepare("INSERT INTO users (id, email, password, role) VALUES (?, ?, ?, 'user')").run(5, 'u5@test.com', 'x');
  db.prepare("INSERT INTO users (id, email, password, role) VALUES (?, ?, ?, 'user')").run(6, 'u6@test.com', 'x');
  db.prepare("INSERT INTO users (id, email, password, role) VALUES (?, ?, ?, 'user')").run(77, 'u77@test.com', 'x');
  server = http.createServer();
  wss = initWs(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  for (const ws of wss.clients) ws.terminate();
  await new Promise((resolve) => server.close(resolve));
  await cleanupTmpVault(tmpVault);
});

function signToken(sub) {
  return jwt.sign({ sub, email: 'ws@test.com', role: 'user' }, process.env.JWT_ACCESS_SECRET, { expiresIn: 900 });
}

async function connectAs(sub) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.send(JSON.stringify({ token: signToken(sub) }));
  await sleep(100); // server does not ack auth; wait for registration to settle
  return ws;
}

function nextMessage(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', onMsg); reject(new Error('no message received')); }, timeoutMs);
    const onMsg = (data) => { clearTimeout(t); resolve(JSON.parse(data)); };
    ws.once('message', onMsg);
  });
}

describe('ws broadcast (end-to-end)', () => {
  it('broadcast(userId, …) reaches an authenticated socket (number sub)', async () => {
    const ws = await connectAs(1);
    const p = nextMessage(ws);
    broadcast(1, { type: 'note:updated', path: 'a.md' });
    await expect(p).resolves.toEqual({ type: 'note:updated', path: 'a.md' });
    ws.terminate();
  });

  it('broadcast(String(userId), …) also reaches the same socket', async () => {
    const ws = await connectAs(2);
    const p = nextMessage(ws);
    broadcast('2', { type: 'note:deleted', path: 'b.md' });
    await expect(p).resolves.toEqual({ type: 'note:deleted', path: 'b.md' });
    ws.terminate();
  });

  it('does not deliver to a different user', async () => {
    const ws = await connectAs(42);
    const p = nextMessage(ws, 500);
    broadcast(999, { type: 'note:updated', path: 'c.md' });
    await expect(p).rejects.toThrow('no message received');
    ws.terminate();
  });

  it('broadcastToNotebook reaches accepted members', async () => {
    const db = getDb();
    const nbId = db.prepare('INSERT INTO notebooks (user_id, name) VALUES (?, ?)').run(5, 'NB').lastInsertRowid;
    db.prepare('INSERT INTO notebook_members (notebook_id, user_id, invited_by, accepted) VALUES (?, ?, ?, 1)')
      .run(nbId, 6, 5);

    const ws = await connectAs(6);
    const p = nextMessage(ws);
    broadcastToNotebook(nbId, { type: 'note:updated', notebookId: nbId });
    await expect(p).resolves.toEqual({ type: 'note:updated', notebookId: nbId });
    ws.terminate();
  });

  it('broadcastToNotebook excludes the acting user', async () => {
    const db = getDb();
    const nbOwner = db.prepare('SELECT id FROM notebooks WHERE user_id = 5').get().id;
    const ws = await connectAs(5);
    const p = nextMessage(ws, 500);
    broadcastToNotebook(nbOwner, { type: 'note:updated' }, 5);
    await expect(p).rejects.toThrow('no message received');
    ws.terminate();
  });

  it('JWT with a string sub still receives broadcasts', async () => {
    const ws = await connectAs('77');
    const p = nextMessage(ws);
    broadcast(77, { type: 'pong' });
    await expect(p).resolves.toEqual({ type: 'pong' });
    ws.terminate();
  });

  it('rejects an invalid token with 1008', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ token: 'garbage' }));
    const code = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no close')), 5000);
      ws.on('close', (c) => { clearTimeout(t); resolve(c); });
    });
    expect(code).toBe(1008);
  });
});
