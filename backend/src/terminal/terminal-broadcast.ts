/**
 * Filtrage serveur des événements de terminal par abonnement (correctif SEC-07).
 *
 * Avant ce correctif, `onTermData`/`onTermExit` (index.ts) diffusaient la sortie
 * d'un terminal à TOUS les sockets connectés : n'importe quel onglet/projet
 * recevait la sortie (et les identifiants de projet) des terminaux des autres.
 * Le filtrage n'existait QUE côté client, après réception.
 *
 * On route désormais un événement de terminal uniquement vers les sockets dont
 * `subscribedProjects` contient le `projectId` de l'événement — même modèle que
 * les événements Pi (cf. `subscribeToEvents` dans index.ts).
 *
 * Stratégie anti-course (la toute première sortie d'un terminal peut arriver
 * avant le `{type:"subscribe"}`) :
 *   1. `terminal_create` ajoute immédiatement le projet aux abonnements du
 *      socket émetteur AVANT d'appeler `createTerminal` ;
 *   2. `createTerminal` ré-émet le tampon existant (isBuffer) lors d'une
 *      reconnexion — il est donc reçu par le socket déjà abonné, sans doublon
 *      avec un éventuel `terminal_buffer` explicite.
 * Aucune sortie du projet de l'utilisateur n'est ainsi perdue.
 */
import { WebSocket } from "ws";

/** Sous-ensemble d'un socket WS nécessaire au filtrage (facilite les tests). */
export interface TerminalSocketLike {
  readyState: number;
  subscribedProjects: Set<string>;
  send(data: string): void;
}

export interface TerminalDataEvent {
  projectId: string;
  data: string;
  isBuffer?: boolean;
}

export interface TerminalExitEvent {
  projectId: string;
  exitCode: number;
  signal: number;
}

/**
 * Envoie un événement `terminal_data` au socket s'il est ouvert ET abonné au
 * projet concerné. Retourne true si l'événement a été transmis.
 */
export function sendTerminalData(socket: TerminalSocketLike, event: TerminalDataEvent): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (!socket.subscribedProjects.has(event.projectId)) return false;
  socket.send(JSON.stringify({ type: "terminal_data", ...event }));
  return true;
}

/**
 * Idem pour `terminal_exit`. Retourne true si l'événement a été transmis.
 */
export function sendTerminalExit(socket: TerminalSocketLike, event: TerminalExitEvent): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (!socket.subscribedProjects.has(event.projectId)) return false;
  socket.send(JSON.stringify({ type: "terminal_exit", ...event }));
  return true;
}
