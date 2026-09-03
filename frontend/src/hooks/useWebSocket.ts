import { useState, useEffect, useRef, useCallback } from "react";

type WsMessage = {
  type: string;
  [key: string]: any;
};

// ── File d'attente des messages (Lot B — robustesse temps réel) ─────────────
// Taille maximale de la file : au-delà, les nouveaux messages sont REFUSÉS et
// signalés (évènement interne "_ws_queue_full") au lieu d'être perdus en silence.
const QUEUE_MAX = 50;

// Liste blanche EXPLICITE des types mis en file pendant une déconnexion.
// Seules les actions utilisateur pertinentes y figurent :
//  - pi_prompt            : prompt tapé pendant une micro-coupure ;
//  - pi_steer             : direction envoyée pendant un streaming ;
//  - design_send_to_chat  : envoi d'une maquette vers le chat (équivalent prompt).
//  - subscribe            : (sécurité #5) abonnement par projet. Mis en file pour
//    garantir qu'il est bien envoyé à l'ouverture de la connexion (première
//    connexion comme reconnexions), AVANT que le chat ait besoin des events.
// Sont volontairement EXCLUS de la file (envoyés uniquement socket ouverte) :
//  - pi_abort : inutile hors connexion et dangereux à rejouer — provoquerait un
//    « abort fantôme » tuant une génération légitime après reconnexion ;
//  - ping / keepalive : messages de santé de la connexion, sans sens différé ;
//  - messages techniques (pi_start, pi_history_request, mode_switch,
//    terminal_*) : déjà renvoyés ou resynchronisés par la logique existante
//    à la reconnexion (_ws_reconnect / payload "connected").
const QUEUEABLE_TYPES: ReadonlySet<string> = new Set([
  "pi_prompt",
  "pi_steer",
  "design_send_to_chat",
  "subscribe",
]);

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const listenersRef = useRef<Map<string, Set<(msg: any) => void>>>(
    new Map()
  );
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDestroyedRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const hasConnectedBeforeRef = useRef(false);  // persiste entre les reconnexions

  // ── File d'attente ──────────────────────────────────────────────────────────
  // Les messages de la liste blanche envoyés hors connexion sont stockés ici puis
  // rejoués dans l'ordre à la prochaine ouverture effective du WebSocket.
  const queueRef = useRef<WsMessage[]>([]);
  const [queueSize, setQueueSize] = useState(0);

  // Notifie les listeners locaux (même mécanisme que ws.onmessage). Utilisé pour
  // les évènements internes du hook, ex. "_ws_queue_full" (file pleine).
  const notifyListeners = useCallback((type: string, msg: any) => {
    const listeners = listenersRef.current.get(type);
    if (listeners) {
      listeners.forEach((cb) => cb(msg));
    }
    const wildcard = listenersRef.current.get("*");
    if (wildcard) {
      wildcard.forEach((cb) => cb(msg));
    }
  }, []);

  // Rejoue la file dans l'ordre d'arrivée. Appelé à CHAQUE ouverture effective
  // du WebSocket (onopen), première connexion comme reconnexions.
  const flushQueue = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (queueRef.current.length === 0) return;
    const remaining: WsMessage[] = [];
    const msgs = queueRef.current;
    for (let i = 0; i < msgs.length; i++) {
      try {
        ws.send(JSON.stringify(msgs[i]));
      } catch (e) {
        // Socket rompue en cours de rejeu : conserver TOUT le reste depuis
        // l'index en échec (message en échec + tous ceux qui suivent) pour la
        // prochaine reconnexion, au lieu de perdre les messages suivants.
        remaining.push(...msgs.slice(i));
        console.error("[WS] Rejeu de la file interrompu :", e);
        break;
      }
    }
    queueRef.current = remaining;
    setQueueSize(remaining.length);
    if (remaining.length === 0) {
      console.log("[WS] File d'attente vidée après reconnexion");
    }
  }, []);

  const connect = useCallback(() => {
    if (isDestroyedRef.current) return;
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
      // Notifier les listeners de reconnexion (pas la première connexion)
      if (hasConnectedBeforeRef.current) {
        notifyListeners("_ws_reconnect", { type: "_ws_reconnect" });
      }
      hasConnectedBeforeRef.current = true;
      // Rejouer les messages mis en file pendant la déconnexion (APRÈS la
      // notification _ws_reconnect pour laisser la resync UI passer d'abord).
      flushQueue();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        notifyListeners(msg.type, msg);
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
  }, [notifyListeners, flushQueue]);

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

  // Envoie un message. Retourne :
  //  - true  : envoyé immédiatement (socket ouverte) ;
  //  - false : mis en file (hors connexion, type autorisé) OU refusé
  //            (type non fileable ou file pleine).
  const send = useCallback((msg: WsMessage): boolean => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
        return true;
      } catch (e) {
        // Échec malgré readyState OPEN (socket déjà rompue) : retomber sur la
        // mise en file ci-dessous si le type y est éligible.
        console.error("[WS] Échec d'envoi sur socket ouverte :", e);
      }
    }
    // Hors connexion : mise en file UNIQUEMENT pour la liste blanche.
    if (!QUEUEABLE_TYPES.has(msg.type)) {
      // pi_abort, ping/keepalive, messages techniques : refus volontaire,
      // sans mise en file (voir commentaire de QUEUEABLE_TYPES).
      return false;
    }
    if (queueRef.current.length >= QUEUE_MAX) {
      // File pleine : signaler l'échec explicitement au lieu de dropper.
      console.error(`[WS] File d'attente pleine (${QUEUE_MAX}) — message « ${msg.type} » refusé`);
      notifyListeners("_ws_queue_full", { type: "_ws_queue_full" });
      return false;
    }
    queueRef.current.push(msg);
    setQueueSize(queueRef.current.length);
    return false;
  }, [notifyListeners]);

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

  // pending : état « messages en attente d'envoi » pour l'UI (indicateur discret).
  return { connected, send, on, queueSize, pending: queueSize > 0 };
}
