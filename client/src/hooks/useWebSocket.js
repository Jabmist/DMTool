import { useEffect, useRef, useCallback } from 'react';
import { useAuthStore } from '../store/authStore.js';

const BACKOFF_BASE_MS  = 1_000;
const BACKOFF_MAX_MS   = 30_000;

export function useWebSocket(onMessage) {
  const wsRef      = useRef(null);
  const attemptRef = useRef(0);
  const timerRef   = useRef(null);
  const activeRef  = useRef(false);
  const stoppedRef = useRef(false);
  const getToken   = useAuthStore(s => s.getToken);

  const connect = useCallback(() => {
    if (!activeRef.current || stoppedRef.current) return;
    const token = getToken();
    if (!token) return;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const base = import.meta.env.BASE_URL.replace(/\/$/, ''); // e.g. '/dmtool'
    const ws = new WebSocket(`${proto}://${location.host}/${base}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      attemptRef.current = 0;
      ws.send(JSON.stringify({ token }));
    };

    ws.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch { /* ignore malformed */ }
    };

    ws.onclose = async (e) => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;

      // 1008 = invalid/expired access token. Refresh first and reconnect with
      // the fresh token; if the refresh token is also dead, stop retrying
      // (refresh() clears user+token, so the UI redirects to login).
      if (e?.code === 1008) {
        const fresh = await useAuthStore.getState().refresh();
        if (!activeRef.current) return;
        if (!fresh) { stoppedRef.current = true; return; }
      }

      const delay = Math.min(BACKOFF_BASE_MS * 2 ** attemptRef.current, BACKOFF_MAX_MS);
      attemptRef.current += 1;
      timerRef.current = setTimeout(connect, delay);
    };
  }, [getToken, onMessage]);

  useEffect(() => {
    activeRef.current = true;
    stoppedRef.current = false;
    connect();
    return () => {
      activeRef.current = false;
      stoppedRef.current = true;
      clearTimeout(timerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);
}
