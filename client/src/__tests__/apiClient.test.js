import { describe, it, expect, beforeEach, vi } from 'vitest';

// Reset module registry between tests so token state is fresh
let api, setTokenGetter, setUnauthorizedHandler;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import('../api/client.js');
  api = mod.api;
  setTokenGetter = mod.setTokenGetter;
  setUnauthorizedHandler = mod.setUnauthorizedHandler;
});

function mockFetch(status, body) {
  global.fetch = vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
}

describe('api.get', () => {
  it('makes a GET request to the given URL', async () => {
    mockFetch(200, { ok: true });
    await api.get('/api/test');
    expect(fetch).toHaveBeenCalledWith('/api/test', expect.objectContaining({ method: 'GET' }));
  });

  it('injects Bearer token when a getter is configured', async () => {
    setTokenGetter(() => 'my-token');
    mockFetch(200, { data: 1 });
    await api.get('/api/secure');
    const opts = fetch.mock.calls[0][1];
    expect(opts.headers.Authorization).toBe('Bearer my-token');
  });

  it('omits Authorization header when no token', async () => {
    setTokenGetter(() => null);
    mockFetch(200, {});
    await api.get('/api/open');
    const opts = fetch.mock.calls[0][1];
    expect(opts.headers.Authorization).toBeUndefined();
  });

  it('throws with server error message on non-ok response', async () => {
    mockFetch(500, { error: 'Internal failure' });
    await expect(api.get('/api/bad')).rejects.toThrow('Internal failure');
  });
});

describe('api.post', () => {
  it('sends JSON body', async () => {
    mockFetch(200, { ok: true });
    await api.post('/api/create', { name: 'Test' });
    const opts = fetch.mock.calls[0][1];
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ name: 'Test' });
  });
});

describe('api.put', () => {
  it('sends PUT with JSON body', async () => {
    mockFetch(200, { ok: true });
    await api.put('/api/update', { content: 'hi' });
    expect(fetch.mock.calls[0][1].method).toBe('PUT');
  });
});

describe('api.patch', () => {
  it('sends PATCH with JSON body', async () => {
    mockFetch(200, { ok: true });
    await api.patch('/api/notes/old.md', { newPath: 'new.md' });
    const opts = fetch.mock.calls[0][1];
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ newPath: 'new.md' });
  });
});

describe('api.delete', () => {
  it('sends DELETE with optional body', async () => {
    mockFetch(200, { ok: true });
    await api.delete('/api/item', { path: 'note.md' });
    const opts = fetch.mock.calls[0][1];
    expect(opts.method).toBe('DELETE');
    expect(JSON.parse(opts.body)).toEqual({ path: 'note.md' });
  });
});

describe('401 handling', () => {
  it('calls onUnauthorized handler and throws', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    mockFetch(401, { error: 'Unauthorized' });
    await expect(api.get('/api/secure')).rejects.toThrow('Unauthorized');
    expect(handler).toHaveBeenCalled();
  });
});
