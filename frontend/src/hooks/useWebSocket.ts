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
    // Runtime detection: localhost dev uses /ws (Vite proxy), everything else uses / (reverse proxy friendly)
    const isLocalDev = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    const wsPath = isLocalDev ? "/ws" : "/";
    const wsUrl = `${protocol}//${window.location.host}${wsPath}`;

    console.log(`[WS] Connecting to ${wsUrl}...`);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log(`[WS] Connected to ${wsUrl}`);
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
        const wildcard = listenersRef.current.get("*");
        if (wildcard) {
          wildcard.forEach((cb) => cb(msg));
        }
      } catch (e) {
        console.error("[WS] Parse error:", e);
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      setConnected(false);
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
  }, []);

  useEffect(() => {
    isDestroyedRef.current = false;
    connect();
    return () => {
      isDestroyedRef.current = true;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
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