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

  const connect = useCallback(() => {
    const wsUrl =
      import.meta.env.MODE === "development"
        ? "ws://localhost:3000"
        : `ws://${window.location.host}`;

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
      console.log("[WS] Disconnected, reconnecting in 2s...");
      setConnected(false);
      setTimeout(connect, 2000);
    };

    ws.onerror = (e) => {
      console.error("[WS] Error:", e);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
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
