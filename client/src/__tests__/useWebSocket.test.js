import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

class FakeWebSocket {
  static instances = [];
  readyState = 0;
  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data) { this.lastSent = data; }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  // test helpers
  open() { this.readyState = 1; this.onopen?.({}); }
  closeWith(code) { this.readyState = 3; this.onclose?.({ code }); }
}

vi.mock('../store/authStore.js', () => {
  const store = {
    accessToken: 'tok-1',
    getToken: () => store.accessToken,
    refresh: vi.fn(async () => { store.accessToken = 'tok-2'; return store.accessToken; }),
    logout: vi.fn(),
  };
  const useAuthStore = (selector) => (selector ? selector(store) : store);
  useAuthStore.getState = () => store;
  return { useAuthStore };
});

import { useWebSocket } from '../hooks/useWebSocket.js';
import { useAuthStore } from '../store/authStore.js';

const store = useAuthStore.getState();

async function renderConnected() {
  const result = renderHook(() => useWebSocket(() => {}));
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  act(() => { ws.open(); });
  return { ...result, ws };
}

async function settle(ms) {
  await act(async () => {});                    // flush the refresh() promise
  act(() => { vi.advanceTimersByTime(ms); });   // fire the reconnect timer
}

describe('useWebSocket reconnect with stale token (B5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances.length = 0;
    store.accessToken = 'tok-1';
    store.refresh = vi.fn(async () => { store.accessToken = 'tok-2'; return store.accessToken; });
    store.logout.mockClear();
    global.WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the current token on initial connect', async () => {
    const { unmount, ws } = await renderConnected();
    expect(JSON.parse(ws.lastSent).token).toBe('tok-1');
    unmount();
  });

  it('refreshes on 1008 and reconnects with the fresh token', async () => {
    const { unmount, ws } = await renderConnected();
    ws.closeWith(1008);
    await settle(1000);

    expect(store.refresh).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const ws2 = FakeWebSocket.instances[1];
    act(() => { ws2.open(); });
    expect(JSON.parse(ws2.lastSent).token).toBe('tok-2');
    unmount();
  });

  it('does not refresh on benign close codes, just backs off and retries', async () => {
    const { unmount, ws } = await renderConnected();
    ws.closeWith(1006); // transport error
    await settle(1000);
    expect(store.refresh).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(2);
    unmount();
  });

  it('stops retrying permanently when the refresh token is also dead', async () => {
    store.refresh = vi.fn(async () => { store.accessToken = null; return null; });
    const { unmount, ws } = await renderConnected();
    ws.closeWith(1008);
    await settle(1000);

    expect(store.refresh).toHaveBeenCalledTimes(1);
    expect(store.accessToken).toBeNull();

    // no scheduled retries to fire
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(FakeWebSocket.instances).toHaveLength(1);
    unmount();
  });

  it('does not reconnect or refresh after unmount', async () => {
    const { unmount, ws } = await renderConnected();
    unmount();
    expect(ws.readyState).toBe(3);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(store.refresh).not.toHaveBeenCalled();
  });
});
