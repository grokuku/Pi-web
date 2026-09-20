// ── usePastSessions : liste des conversations passées d'un projet (LOT E1) ──
// Le backend sait déjà produire `pi_sessions_list` (SessionManager.list du
// SDK) en réponse à `pi_list_sessions`, mais AUCUN listener frontend ne
// l'écoutait (« donnée invisible » de l'audit). Ce hook :
//  - demande la liste à l'ouverture / au changement de projet ;
//  - écoute `pi_sessions_list` (filtré par projectId) et normalise le payload ;
//  - redemande la liste à la reconnexion WS (la demande initiale peut avoir
//    été perdue pendant une coupure : `pi_list_sessions` n'est pas mis en file
//    par useWebSocket — c'est une requête/réponse idempotente).
//
// État LOCAL au sous-arbre qui l'utilise (Sidebar) : aucune donnée ne remonte
// à App, donc les mises à jour de la liste ne re-rendent PAS le chat courant.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PastSession } from "../types";
import { normalizePastSessions } from "../utils/pastSessions";

type OnFn = (type: string, cb: (msg: any) => void) => () => void;
type SendFn = (msg: any) => boolean;

export function usePastSessions(projectId: string, on: OnFn, send: SendFn) {
  const [sessions, setSessions] = useState<PastSession[]>([]);
  const [loading, setLoading] = useState(false);
  // Identifiant du projet courant lu par les handlers (évite les closures
  // périmées quand le projet change pendant une requête en vol).
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const refresh = useCallback(() => {
    const pid = projectIdRef.current;
    if (!pid) {
      setSessions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    // `send()` renvoie false quand le socket n'est pas ouvert (fermé/absent) :
    // la requête n'a alors PAS été mise en file (pi_list_sessions est une
    // requête/réponse idempotente, pas un message bufferisé). Sans ce garde,
    // `loading` resterait bloqué à true pour toujours → on le réarme. La
    // reconnexion WS rejouera la demande (listener « connected » ci-dessous).
    if (send({ type: "pi_list_sessions", projectId: pid }) === false) {
      setLoading(false);
    }
  }, [send]);

  // Changement de projet : on vide immédiatement la liste de l'ancien projet
  // puis on demande celle du nouveau (évite d'afficher brièvement les
  // conversations d'un autre projet).
  useEffect(() => {
    setSessions([]);
    if (projectId) refresh();
    else setLoading(false);
  }, [projectId, refresh]);

  // Écoute de la réponse backend (filtrée par projet).
  useEffect(() => {
    const unsub = on("pi_sessions_list", (msg: any) => {
      if (!msg || msg.projectId !== projectIdRef.current) return;
      setSessions(normalizePastSessions(msg.sessions));
      setLoading(false);
    });
    return unsub;
  }, [on]);

  // Connexion WS (1re connexion comme reconnexions) : la demande initiale a pu
  // être perdue (envoi avant ouverture du socket / coupure). « connected » est
  // émis par le backend à CHAQUE connexion — on en profite pour (re)demander la
  // liste si un projet est actif.
  useEffect(() => {
    const unsub = on("connected", () => {
      if (projectIdRef.current) refresh();
    });
    return unsub;
  }, [on, refresh]);

  return { sessions, loading, refresh };
}
