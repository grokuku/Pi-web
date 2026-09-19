// ── File d'attente WS : dédoublonnage « dernier gagne » ─────────────────────
// Logique pure extraite de useWebSocket pour être testable hors React.
//
// Certains messages mis en file pendant une déconnexion sont IDEMPOTENTS et
// n'ont de sens qu'en UN SEUL exemplaire par projet (ex. pi_history_request :
// une seule resync d'historique par projet suffit — en empiler 10 les rejouerait
// tous en rafale à la reconnexion). Pour ces types, un doublon (même type +
// même projectId) déjà présent dans la file est REMPLACÉ SUR PLACE : la
// position d'origine est conservée (l'ordre relatif avec les autres messages,
// ex. pi_start avant pi_history_request, reste respecté) et seul le dernier
// exemplaire est envoyé à la reconnexion.

export type QueueableMessage = {
  type: string;
  projectId?: string;
  [key: string]: any;
};

/**
 * Remplace sur place le doublon (même type + même projectId) de `queue` par
 * `msg` si le type est éligible au dédoublonnage. Retourne une NOUVELLE
 * instance de la file en cas de remplacement, sinon `queue` inchangée
 * (comparaison par référence : permet à l'appelant de détecter le cas).
 */
export function upsertDedup(
  queue: QueueableMessage[],
  msg: QueueableMessage,
  dedupTypes: ReadonlySet<string>
): QueueableMessage[] {
  if (!dedupTypes.has(msg.type)) return queue;
  if (msg.projectId === undefined) return queue;
  const idx = queue.findIndex((m) => m.type === msg.type && m.projectId === msg.projectId);
  if (idx === -1) return queue;
  const next = queue.slice();
  next[idx] = msg;
  return next;
}