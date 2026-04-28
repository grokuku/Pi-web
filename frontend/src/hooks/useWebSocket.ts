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
    const wsUrl =
      import.meta.env.MODE === "development"
        ? "ws://localhost:3000"
        : `${protocol}//${window.location.host}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[WS] Connected");
      setConnected(true);
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
      // Only reconnect if component is still alive
      if (!isDestroyedRef.current) {
        console.log("[WS] Disconnected, reconnecting in 2s...");
        reconnectTimerRef.current = setTimeout(connect, 2000);
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
