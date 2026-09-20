// ── Lecture LECTURE-SEULE de l'historique d'une session passée ────────────
// LOT E1 (navigation dans les conversations passées).
//
// Pourquoi ce module existe : `pi_history_request` / `pi_history_page` ne
// portent PAS de sessionId — ils opèrent sur la session ACTIVE du projet
// (getSession(projectId), avec auto-guérison/reprise au besoin). Les utiliser
// pour consulter une session passée changerait donc la session courante, ce
// que le lot E1 interdit explicitement.
//
// Voie retenue : lecture directe, PUREMENT passive, du fichier .jsonl de la
// session demandée (aucun SessionManager vivant, aucun enregistrement dans
// `sessionsByProject`) puis réutilisation de la MÊME sérialisation que le
// chat (`buildFullUiHistory` + `sliceUiHistoryWindow`). L'historique renvoyé
// est donc strictement identique à celui affiché par le chat, pagination
// comprise, sans aucun effet de bord sur la session active.
import { promises as fs } from "fs";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { buildFullUiHistory, sliceUiHistoryWindow, type UiHistoryWindow } from "./ui-history.js";

/**
 * Sélectionne le fichier de session correspondant à `sessionId` dans la liste
 * produite par `listSessions`. Fonction PURE et testable : la validation
 * d'appartenance au projet est garantie en amont (la liste provient
 * exclusivement du répertoire de sessions du projet), ce qui évite toute
 * traversée de chemin à partir d'un sessionId fourni par le client.
 */
export function selectSessionFile(sessions: any[], sessionId: string): string | null {
  if (!Array.isArray(sessions) || !sessionId) return null;
  const match = sessions.find((s: any) => s && s.id === sessionId);
  return match && typeof match.path === "string" ? match.path : null;
}

/**
 * Reconstruit l'historique UI COMPLET d'un fichier de session puis en renvoie
 * la tranche demandée (curseur before/beforeId, count, all). Lecture seule :
 * aucune écriture, aucune mutation du SDK.
 *
 * `parseSessionEntries` tolère les lignes corrompues (skip) — un fichier
 * partiellement tronqué reste donc exploitable.
 */
export async function readSessionHistoryFile(
  filePath: string,
  opts?: { before?: unknown; beforeId?: unknown; count?: unknown; all?: boolean },
): Promise<UiHistoryWindow> {
  // Lecture ASYNCHRONE : un .jsonl de session peut être volumineux (plusieurs
  // Mo) ; `readFileSync` bloquerait l'event loop Express pendant toute la
  // lecture. La route appelante est déjà async et attend le résultat.
  const content = await fs.readFile(filePath, "utf8");
  const entries = parseSessionEntries(content);
  // buildFullUiHistory s'appuie sur `sessionManager.getEntries()` : on lui
  // fournit un adaptateur minimal, sans SessionManager (lecture passive).
  const full = buildFullUiHistory({ sessionManager: { getEntries: () => entries } });
  return sliceUiHistoryWindow(full, opts);
}
