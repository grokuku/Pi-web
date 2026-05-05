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

    // Close existing connection cleanly (prevent old socket handlers from firing)
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
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[WS] Connected");
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

    ws.onclose = () => {
      wsRef.current = null;
      setConnected(false);
      // Exponential backoff: 1s, 2s, 4s, 8s... max 30s
      const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
      reconnectAttemptsRef.current++;
      if (!isDestroyedRef.current) {
        console.log(`[WS] Disconnected, reconnecting in ${delay}ms...`);
        reconnectTimerRef.current = setTimeout(connect, delay);
      }
    };

    ws.onerror = (e) => {
      console.error("[WS] Error:", e);
    };
  }, []);

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