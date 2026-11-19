// ── Message de RÉSULTAT de sous-agent (customType "subagent_result") ─────────
// Le backend réinjecte le résultat d'un run détaché en message CONVERSATIONNEL
// `subagent_result` (display:true, `triggerTurn:true` → vu par le LLM et nouveau
// tour de l'orchestrateur) et place les données STRUCTURÉES dans `details.results`
// (champ free-form jamais envoyé au modèle). Ces helpers purs extraient ces
// métadonnées pour le RENDU (en-tête toujours visible : agent, statut, taille)
// — sans parser le texte, et sans jamais toucher à la nature conversationnelle
// du message (le contenu reste intact et le backend inchangé).
//
// Utilisés par les DEUX chemins d'affichage d'un même message :
//  - live : ChatView, handler `message_start` role custom (details forwardés) ;
//  - relecture : convertHistoryToDisplayMessages (details persistés).
import type { SubAgentResultInfo } from "../types";

/** Extrait `details.results` (payload de livraison backend) en métadonnées sûres. */
export function extractSubagentResults(
  customType: string | undefined,
  details: unknown,
): SubAgentResultInfo[] | undefined {
  if (customType !== "subagent_result") return undefined;
  const raw = (details as { results?: unknown } | null | undefined)?.results;
  if (!Array.isArray(raw)) return undefined;
  const out: SubAgentResultInfo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    // `delegateRunId` est l'identité minimale exploitable : une entrée sans lui
    // (payload tronqué/corrompu) est ignorée au lieu de produire un en-tête muet.
    if (typeof r.delegateRunId !== "string" || !r.delegateRunId) continue;
    out.push({
      delegateRunId: r.delegateRunId,
      delegateFunction: typeof r.delegateFunction === "string" && r.delegateFunction ? r.delegateFunction : undefined,
      label: typeof r.label === "string" && r.label ? r.label : undefined,
      status: typeof r.status === "string" && r.status ? r.status : "success",
      cause: typeof r.cause === "string" && r.cause ? r.cause : undefined,
      errorMessage: typeof r.errorMessage === "string" && r.errorMessage ? r.errorMessage : undefined,
      durationMs: typeof r.durationMs === "number" && Number.isFinite(r.durationMs) ? Math.max(0, r.durationMs) : undefined,
      actionCount: typeof r.actionCount === "number" && Number.isFinite(r.actionCount) ? Math.max(0, r.actionCount) : undefined,
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Un lot de résultats est-il « en échec » pour l'auto-dépli ?
 * Convention alignée sur le reste de l'UI sous-agent (runFromActivity :
 * `failed = status !== "success"`) : succès SEUL = pas d'auto-dépli.
 */
export function isSubagentResultFailed(results: SubAgentResultInfo[] | undefined): boolean {
  return !!results?.some((r) => r.status !== "success");
}

// Clés i18n des statuts connus (cf. SubAgentEndStatus) — la parité fr/en est
// garantie par i18n/parity.test.ts. Statut inconnu → affiché brut.
const STATUS_LABEL_KEYS: Record<string, string> = {
  success: "chat.subAgentStatusSuccess",
  error: "chat.subAgentStatusError",
  "timeout-inactivity": "chat.subAgentStatusTimeoutInactivity",
  "timeout-global": "chat.subAgentStatusTimeoutGlobal",
  aborted: "chat.subAgentStatusAborted",
  cancelled: "chat.subAgentStatusCancelled",
};

/** Clé i18n du libellé d'un statut de sous-agent (null si statut inconnu). */
export function subagentStatusLabelKey(status: string): string | null {
  return STATUS_LABEL_KEYS[status] ?? null;
}

/**
 * Repli quand `details.results` manque (payload plus ancien, entrée réécrite…) :
 * première ligne d'en-tête du contenu, au format backend
 * « ### Label (fn) — statut ». Renvoie null si absente.
 */
export function firstResultHeading(content: string): string | null {
  for (const line of (content || "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("### ")) return trimmed.slice(4).trim();
  }
  return null;
}

/**
 * Corps markdown d'un `subagent_result`, sans la ligne d'en-tête « ### Label (fn)
 * — statut » : celle-ci est DÉJÀ rendue par l'en-tête du bloc repliable (données
 * structurées `details.results`, ou `firstResultHeading` en repli). Rendre le
 * contenu entier afficherait ce titre deux fois.
 *
 * Le reste du contenu est INCHANGÉ (markdown de bout en bout) : c'est lui qui
 * passe au rendu markdown partagé, donc les puces, l'italique, les citations et
 * les tableaux GFM du sous-agent sont rendus — au lieu d'être affichés bruts.
 */
export function resultBodyForMarkdown(content: string): string {
  const text = content || "";
  const lines = text.split("\n");
  const i = lines.findIndex((line) => line.trim().startsWith("### "));
  if (i < 0) return text;
  // On retire la SEULE ligne d'en-tête (pas les suivantes : un lot de plusieurs
  // résultats porte un « ### … » par résultat, qui doit rester visible).
  return [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n").replace(/^\n+/, "");
}

/** Nombre de lignes d'un contenu (0 si vide) — indication de taille repliée. */
export function countContentLines(content: string): number {
  const text = content || "";
  return text ? text.split("\n").length : 0;
}
