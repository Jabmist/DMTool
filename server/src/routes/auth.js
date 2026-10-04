import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { recordSignon } from '../services/telemetry.js';

const router = Router();
const SALT_ROUNDS = 12;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Issue #16: the single currently-active announcement, if any "now" falls
// inside its [start_time, end_time] window and it hasn't been superseded.
function getActiveAnnouncement(nowSec = Math.floor(Date.now() / 1000)) {
  const row = getDb()
    .prepare('SELECT id, message, start_time, end_time, created_at FROM announcements ' +
             'WHERE replaced_at IS NULL AND start_time <= ? AND end_time >= ?')
    .get(nowSec, nowSec);
  return row ?? null;
}

function issueTokens(user, res) {
  const payload = { sub: user.id, email: user.email, role: user.role };
  const accessToken = jwt.sign(payload, process.env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: parseInt(process.env.JWT_ACCESS_EXPIRES, 10),
  });
  const refreshToken = crypto.randomBytes(40).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + parseInt(process.env.JWT_REFRESH_EXPIRES, 10);

  getDb()
    .prepare('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)')
    .run(user.id, refreshToken, expiresAt);

  recordSignon(user.id);

  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: parseInt(process.env.JWT_REFRESH_EXPIRES, 10) * 1000,
  });

  return accessToken;
}

router.post('/register', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid email address' });
  if (password.length < 12) return res.status(400).json({ error: 'password must be at least 12 characters' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  // First user becomes admin and is immediately active; all others are pending approval
  const isFirst = db.prepare('SELECT COUNT(*) as c FROM users').get().c === 0;
  const role   = isFirst ? 'admin' : 'user';
  const status = isFirst ? 'active' : 'pending';

  const hashed = await bcrypt.hash(password, SALT_ROUNDS);
  const result = db.prepare('INSERT INTO users (email, password, role, status) VALUES (?, ?, ?, ?)').run(email, hashed, role, status);

  if (!isFirst) {
    return res.status(201).json({
      pending: true,
      message: 'Registration received. An admin must approve your account before you can sign in.',
    });
  }

  const user = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(result.lastInsertRowid);
  const accessToken = issueTokens(user, res);
  res.status(201).json({ accessToken, user: { id: user.id, email: user.email, role: user.role } });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  // Validate credentials before revealing account status
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  if (user.status === 'pending')   return res.status(403).json({ error: 'Account pending admin approval' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

  const accessToken = issueTokens(user, res);
  res.json({
    accessToken,
    user: { id: user.id, email: user.email, role: user.role },
    announcement: getActiveAnnouncement(),
  });
});

// Issue #16: current active announcement (or null). Authenticated so the app
// can fetch it on load; a valid token also guards against unauthenticated
// enumeration of the message.
router.get('/active-announcement', requireAuth, (req, res) => {
  res.json({ announcement: getActiveAnnouncement() });
});

router.post('/refresh', (req, res) => {
  const token = req.cookies?.refresh_token;
  if (!token) return res.status(401).json({ error: 'No refresh token' });

  const db = getDb();

  // Atomic SELECT + revoke to prevent concurrent refresh race conditions
  const rotate = db.transaction((tok) => {
    const row = db
      .prepare('SELECT * FROM refresh_tokens WHERE token = ? AND revoked = 0 AND expires_at > unixepoch()')
      .get(tok);
    if (!row) return null;
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?').run(row.id);
    return row;
  });
  const row = rotate(token);
  if (!row) return res.status(401).json({ error: 'Invalid or expired refresh token' });

  const user = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(row.user_id);
  const accessToken = issueTokens(user, res);
  res.json({ accessToken });
});

router.post('/logout', (req, res) => {
  const token = req.cookies?.refresh_token;
  if (token) {
    getDb().prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token = ?').run(token);
  }
  res.clearCookie('refresh_token');
  res.json({ ok: true });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword required' });
  }
  if (newPassword.length < 12) return res.status(400).json({ error: 'password must be at least 12 characters' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(currentPassword, user.password);
  if (!valid) return res.status(403).json({ error: 'Invalid current password' });

  const hashed = await bcrypt.hash(newPassword, SALT_ROUNDS);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, user.id);

  // Revoke every refresh token so other sessions must sign in with the new password
  db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(user.id);

  res.json({ ok: true });
});

export default router;
