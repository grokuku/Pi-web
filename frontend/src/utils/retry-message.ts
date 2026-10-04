// ── Bouton « Réessayer » (C2) : cible + reconstruction du message d'origine ──
// Logique PURE (testée) : le rendu ne fait que brancher le clic sur
// `handleSend` (le canal d'envoi EXISTANT de ChatView — aucun nouveau canal).
//
// Un turn LLM échoué est rattaché au DERNIER message utilisateur SIMPLE qui le
// précède (même définition que le fil : les messages système/injectés —
// customType, injected, kind — ne sont pas des prompts utilisateur).
// Pour renvoyer le message À L'IDENTIQUE, on reconstruit aussi ses pièces
// jointes (le backend les attend via `attachmentId` + texte) :

import type { Attachment, DisplayMessage } from "../types";
import { normalizeUserContentForMatch } from "./pi-events";

/**
 * Trouve le message utilisateur d'origine d'un turn échoué, à partir de l'id
 * de l'ancre du bloc d'erreur (1re tentative ratée). Parcourt la liste en
 * remontant : le premier message `role: "user"` non système/non injecté.
 */
export function findRetryTargetUserMessage(
  messages: DisplayMessage[],
  anchorId: string,
): DisplayMessage | null {
  const anchorIdx = messages.findIndex((m) => m.id === anchorId);
  const from = anchorIdx >= 0 ? anchorIdx : messages.length - 1;
  for (let i = from; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (m.customType || m.injected || m.kind) continue;
    return m;
  }
  return null;
}

/** Mime minimal par catégorie (les refs d'affichage ne portent pas le mime). */
function defaultMime(category: string): string {
  switch (category) {
    case "image":
      return "image/png";
    case "text":
      return "text/plain";
    case "pdf":
      return "application/pdf";
    case "audio":
      return "audio/mpeg";
    case "video":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}

/**
 * Reconstruit les `Attachment[]` attendus par `handleSend` depuis un
 * DisplayMessage utilisateur (vignettes `attachmentRefs` + images inline
 * uploadées). Les images legacy inline (base64 sans attachmentId) ne sont pas
 * renvoyables au backend via ce canal : elles sont ignorées (le texte reste).
 */
export function attachmentsFromDisplayMessage(msg: DisplayMessage): Attachment[] {
  const out: Attachment[] = [];
  const seen = new Set<string>();
  const push = (id: string, name: string, category: string, size: number, mimeType?: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      name: name || "fichier",
      mimeType: mimeType || defaultMime(category),
      size: Number.isFinite(size) ? size : 0,
      category: (category as Attachment["category"]) || "binary",
      data: "",
      attachmentId: id,
      uploadStatus: "done",
    });
  };
  for (const ref of msg.attachmentRefs || []) push(ref.id, ref.name, ref.category, ref.size);
  for (const img of msg.images || []) {
    if (img.attachmentId) push(img.attachmentId, img.name, "image", 0, img.mimeType);
  }
  return out;
}

/**
 * Texte à renvoyer pour un message utilisateur :
 *  - sans pièce jointe → le contenu affiché ;
 *  - avec pièces jointes → on neutralise les lignes de références d'attachement
 *    (message COMMITÉ : « 🖼️ **img.png** (id: …)\n\ntexte ») et le placeholder
 *    d'affichage optimiste (« 📎 img.png ») pour ne pas les envoyer deux fois
 *    (le texte des refs est reconstruit par `handleSend` à partir des
 *    `attachmentId`).
 */
export function retryTextForMessage(msg: DisplayMessage): string {
  const content = msg.content || "";
  const refs = msg.attachmentRefs || [];
  if (refs.length === 0) return content;
  const trimmed = content.trim();
  const placeholder = refs.map((r) => `📎 ${r.name}`).join(", ");
  if (trimmed === placeholder) return "";
  return normalizeUserContentForMatch(content);
}

export interface RetrySendArgs {
  text: string;
  attachments: Attachment[];
}

/**
 * Chaîne complète du bouton « Réessayer » : depuis l'ancre du bloc d'erreur,
 * retrouve le message utilisateur d'origine et reconstruit EXACTEMENT les
 * arguments attendus par `handleSend` (texte neutralisé + pièces jointes).
 * `null` = aucun message d'origine retrouvé (l'UI signale l'échec).
 */
export function buildRetrySendArgs(
  messages: DisplayMessage[],
  anchorId: string,
): RetrySendArgs | null {
  const target = findRetryTargetUserMessage(messages, anchorId);
  if (!target) return null;
  return { text: retryTextForMessage(target), attachments: attachmentsFromDisplayMessage(target) };
}
