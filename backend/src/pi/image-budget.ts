/**
 * image-budget.ts — Filtre du budget images envoyé au MODÈLE.
 *
 * Problème résolu : Pi re-injecte TOUT l'historique à chaque tour. Chaque
 * message user portant des pièces jointes-images ET chaque tool result image
 * (ex. web_screenshot) est donc renvoyé au provider à chaque tour, ce qui
 * déclenche l'erreur 400 « limite de 60 images par conversation ».
 *
 * Règles appliquées ici (uniquement le contexte LLM — RIEN n'est supprimé de
 * l'UI Pi-Web ni de la session persistée) :
 *   1. Les images GÉNÉRÉES PAR L'AGENT (rôle `toolResult` ou `assistant`)
 *      ne sont JAMAIS ré-injectées : l'agent a le code qui les a produites,
 *      seule la fenêtre Preview du user doit les voir.
 *   2. Les images du USER (rôle `user`) : seules celles du DERNIER message
 *      user qui contient des images sont conservées. Les messages user
 *      antérieurs gardent leur TEXTE mais perdent leurs images.
 *
 * ── Distinction agent / user ─────────────────────────────────────────────
 * Le SDK pi-ai type le contenu image ainsi :
 *   { type: "image", data: string, mimeType: string }
 * Il n'existe AUCUN champ source/origin/uploadedBy sur ImageContent. La seule
 * distinction disponible dans les données est le RÔLE du message :
 *   - `user`       → image envoyée par l'utilisateur (upload Pi-Web) ;
 *   - `toolResult` → image produite par un tool de l'agent (web_screenshot…) ;
 *   - `assistant`  → image produite par le modèle (rare) = agent.
 * Les messages `custom`/`compactionSummary`/`branchSummary` sont convertis en
 * rôle `user` par le SDK : leurs éventuelles images suivent donc la règle user.
 *
 * Limites : si un tool renvoyait une image « utilisateur » (ex. contenu lu
 * depuis un fichier fourni par le user), elle serait classée agent et exclue.
 * Inversement, une image injectée dans un message custom par une extension
 * serait classée user. La distinction par rôle est la meilleure heuristique
 * disponible avec les structures actuelles du SDK.
 */

/** Vue minimale et structurelle d'un message LLM (`Message` du SDK pi-ai). */
export interface LlmMessageLike {
  role: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
}

/** Texte de substitution quand un message ne contenait QUE des images exclues. */
export const IMAGE_OMITTED_TEXT =
  "[image omise du contexte modèle — budget images Pi-Web]";

/** Vrai si le contenu (non-string) porte au moins une image. */
function containsImage(
  content: string | Array<{ type: string }>
): boolean {
  return Array.isArray(content) && content.some((part) => part.type === "image");
}

/**
 * Filtre les images d'une liste de messages LLM selon le budget.
 *
 * Retourne un nouveau tableau ; les messages sans image sont renvoyés tels
 * quels (même référence). Un message dont TOUTES les images sont retirées et
 * qui n'a plus de contenu reçoit un placeholder texte afin de rester valide.
 */
export function filterImagesForModel<T extends LlmMessageLike>(
  messages: T[]
): T[] {
  // 1) Repérer le DERNIER message user contenant au moins une image.
  let lastUserImageIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user" && containsImage(msg.content)) {
      lastUserImageIndex = i;
      break;
    }
  }

  // 2) Filtrer : images agent exclues, images user limitées au dernier message.
  return messages.map((msg, index) => {
    if (!containsImage(msg.content)) return msg;

    const parts = msg.content as Array<{ type: string }>;
    const keepImages = msg.role === "user" && index === lastUserImageIndex;

    if (keepImages) return msg;

    const filtered = parts.filter((part) => part.type !== "image");

    // Un message vidé de tout contenu casserait l'alternance : placeholder texte.
    if (filtered.length === 0) {
      return { ...msg, content: [{ type: "text", text: IMAGE_OMITTED_TEXT }] } as T;
    }
    return { ...msg, content: filtered } as T;
  });
}
