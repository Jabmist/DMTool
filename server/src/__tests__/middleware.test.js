import { describe, it, expect, beforeAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { setTestEnv } from './helpers.js';
import { requireAuth } from '../middleware/auth.js';

beforeAll(() => setTestEnv());

function makeReqRes(authHeader) {
  const req = { headers: { authorization: authHeader } };
  const res = {
    _status: null, _body: null,
    status(s) { this._status = s; return this; },
    json(b)   { this._body  = b; return this; },
  };
  return { req, res };
}

describe('requireAuth', () => {
  it('calls next() for a valid token', () => {
    const token = jwt.sign({ sub: 1, role: 'user' }, process.env.JWT_ACCESS_SECRET);
    const { req, res } = makeReqRes(`Bearer ${token}`);
    let called = false;
    requireAuth(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(req.user.sub).toBe(1);
  });

  it('returns 401 for missing Authorization header', () => {
    const { req, res } = makeReqRes(undefined);
    requireAuth(req, res, () => {});
    expect(res._status).toBe(401);
  });

  it('returns 401 for malformed header (no Bearer prefix)', () => {
    const { req, res } = makeReqRes('Token abc');
    requireAuth(req, res, () => {});
    expect(res._status).toBe(401);
  });

  it('returns 401 for an invalid/tampered token', () => {
    const { req, res } = makeReqRes('Bearer invalid.token.here');
    requireAuth(req, res, () => {});
    expect(res._status).toBe(401);
  });

  it('returns 401 for an expired token', () => {
    const token = jwt.sign({ sub: 1 }, process.env.JWT_ACCESS_SECRET, { expiresIn: -1 });
    const { req, res } = makeReqRes(`Bearer ${token}`);
    requireAuth(req, res, () => {});
    expect(res._status).toBe(401);
  });
});
