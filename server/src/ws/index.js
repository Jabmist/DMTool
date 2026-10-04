import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { getDb } from '../db/index.js';

// userId -> Set<WebSocket>
const clients = new Map();

const AUTH_TIMEOUT_MS = 10_000;

export function initWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    let userId = null;

    // Close the connection if the client doesn't authenticate within 10 seconds
    const authTimeout = setTimeout(() => {
      if (userId === null) ws.close(1008, 'Authentication timeout');
    }, AUTH_TIMEOUT_MS);

    // Expect the first message to be { token: "<jwt>" }
    ws.once('message', (data) => {
      clearTimeout(authTimeout);
      try {
        const { token } = JSON.parse(data);
        const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
        userId = String(payload.sub);
        if (!clients.has(userId)) clients.set(userId, new Set());
        clients.get(userId).add(ws);
        console.log(`[ws] user ${userId} connected (${clients.get(userId).size} socket(s))`);
      } catch {
        console.log('[ws] connection rejected: bad token');
        ws.close(1008, 'Unauthorized');
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      if (userId !== null) {
        clients.get(userId)?.delete(ws);
        if (clients.get(userId)?.size === 0) clients.delete(userId);
      }
    });
  });

  return wss;
}

export function broadcastToNotebook(notebookId, payload, excludeUserId = null) {
  const db = getDb();
  const owner = db.prepare('SELECT user_id FROM notebooks WHERE id = ?').get(notebookId);
  const memberIds = db
    .prepare('SELECT user_id FROM notebook_members WHERE notebook_id = ? AND accepted = 1')
    .all(notebookId)
    .map(r => r.user_id);
  const allIds = owner ? [owner.user_id, ...memberIds] : memberIds;
  for (const uid of allIds) {
    if (uid === excludeUserId) continue;
    broadcast(uid, payload);
  }
}

export function broadcast(userId, payload) {
  const sockets = clients.get(String(userId));
  if (!sockets) { console.log(`[ws] broadcast: no clients for user ${userId}`); return; }
  const msg = JSON.stringify(payload);
  let sent = 0;
  for (const ws of sockets) {
    if (ws.readyState === 1) { ws.send(msg); sent++; }
  }
  console.log(`[ws] broadcast ${payload.type} → user ${userId}: ${sent}/${sockets.size} sockets`);
}
