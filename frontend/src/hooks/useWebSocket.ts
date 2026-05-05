import { useState, useEffect, useRef, useCallback } from "react";

type WsMessage = {
  type: string;
  [key: string]: any;
};

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const listenersRef = useRef<Map<string, Set<(msg: any) => void>>>(
    new Map()
  );
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDestroyedRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const wsPathRef = useRef<string | null>(null); // remembers which path worked

  const connect = useCallback(() => {
    // Clear any pending reconnect timer
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    // Close existing connection cleanly
    if (wsRef.current) {
      const old = wsRef.current;
      old.onclose = null;
      old.onerror = null;
      old.close();
      wsRef.current = null;
    }

    // Don't connect if component is destroyed
    if (isDestroyedRef.current) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;

    // If we already know which path works, use it directly
    if (wsPathRef.current) {
      const wsUrl = `${protocol}//${host}${wsPathRef.current}`;
      console.log(`[WS] Reconnecting to ${wsUrl}...`);
      openWs(wsUrl, null);
      return;
    }

    // Try /ws first (works with Vite proxy in dev), fall back to / (root path for reverse proxies)
    const primaryUrl = `${protocol}//${host}/ws`;
    const fallbackUrl = `${protocol}//${host}/`;
    console.log(`[WS] Connecting to ${primaryUrl}${import.meta.env.DEV ? "" : ` (fallback: ${fallbackUrl})`}...`);
    openWs(primaryUrl, import.meta.env.DEV ? null : fallbackUrl);
  }, []);

  const openWs = useCallback((url: string, fallbackUrl: string | null) => {
    const ws = new WebSocket(url);

    ws.onopen = () => {
      // Remember which path worked for future reconnections
      const urlObj = new URL(url);
      wsPathRef.current = urlObj.pathname || "/";
      console.log(`[WS] Connected to ${url}`);
      setConnected(true);
      reconnectAttemptsRef.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const listeners = listenersRef.current.get(msg.type);
        if (listeners) {
          listeners.forEach((cb) => cb(msg));
        }
        // Also notify wildcard listeners
        const wildcard = listenersRef.current.get("*");
        if (wildcard) {
          wildcard.forEach((cb) => cb(msg));
        }
      } catch (e) {
        console.error("[WS] Parse error:", e);
      }
    };

    ws.onclose = (event) => {
      wsRef.current = null;
      // If connection was never established and we have a fallback, try it
      if (event.code === 1006 && !wsPathRef.current && fallbackUrl && reconnectAttemptsRef.current === 0) {
        console.log(`[WS] ${url} failed (code 1006), trying fallback ${fallbackUrl}...`);
        reconnectAttemptsRef.current++;
        openWs(fallbackUrl, null);
        return;
      }
      setConnected(false);
      // Exponential backoff: 1s, 2s, 4s, 8s... max 30s
      const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
      reconnectAttemptsRef.current++;
      if (!isDestroyedRef.current) {
        console.log(`[WS] Disconnected, reconnecting in ${delay}ms...`);
        reconnectTimerRef.current = setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      // onclose will handle reconnection
    };

    wsRef.current = ws;
  }, [connect]);

  useEffect(() => {
    isDestroyedRef.current = false;
    connect();
    return () => {
      isDestroyedRef.current = true;
      // Clear any pending reconnect timer
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      // Close socket without triggering reconnect
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  const send = useCallback((msg: WsMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const on = useCallback(
    (type: string, callback: (msg: any) => void) => {
      if (!listenersRef.current.has(type)) {
        listenersRef.current.set(type, new Set());
      }
      listenersRef.current.get(type)!.add(callback);
      return () => {
        listenersRef.current.get(type)?.delete(callback);
      };
    },
    []
  );

  return { connected, send, on };
}