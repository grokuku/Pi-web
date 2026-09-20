// ── Conversations passées : normalisation et formatage (LOT E1) ────────────
// Helpers PURS (testables en environnement node) utilisés par le panneau
// « Conversations » de la sidebar : normalisation du payload WS
// `pi_sessions_list`, tri par date, filtre de recherche, aperçu tronqué et
// formatage des métadonnées (date/heure, nombre de messages, taille).
import type { PastSession } from "../types";

/**
 * Normalise le tableau `sessions` d'un message `pi_sessions_list` :
 *  - ignore les entrées sans id exploitable (payload partiel/corrompu) ;
 *  - coerce les champs manquants en valeurs sûres ;
 *  - trie des plus récentes aux plus anciennes (modified, puis created).
 * Le format backend reste inchangé : on ne fait que le rendre consommable.
 */
export function normalizePastSessions(raw: unknown): PastSession[] {
  if (!Array.isArray(raw)) return [];
  const out: PastSession[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const r = s as any;
    if (typeof r.id !== "string" || !r.id) continue;
    out.push({
      id: r.id,
      firstMessage: typeof r.firstMessage === "string" ? r.firstMessage : "",
      messageCount: typeof r.messageCount === "number" && Number.isFinite(r.messageCount) ? r.messageCount : 0,
      created: typeof r.created === "string" ? r.created : "",
      modified: typeof r.modified === "string" ? r.modified : "",
      name: typeof r.name === "string" && r.name.trim() ? r.name : undefined,
      cwd: typeof r.cwd === "string" ? r.cwd : undefined,
      sizeBytes: typeof r.sizeBytes === "number" && Number.isFinite(r.sizeBytes) ? r.sizeBytes : undefined,
    });
  }
  return out.sort((a, b) => sessionDateMs(b) - sessionDateMs(a));
}

/** Timestamp exploitable d'une session (modified prioritaire, sinon created). */
export function sessionDateMs(s: PastSession): number {
  const t = Date.parse(s.modified || s.created);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Formate la date/heure d'une session en locale selon la langue active (fr/en).
 * Renvoie une chaîne vide si la date est illisible (affichage dégradé).
 */
export function formatSessionDate(iso: string, lang: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const locale = lang === "fr" ? "fr-FR" : "en-US";
  const date = d.toLocaleDateString(locale, { year: "numeric", month: "2-digit", day: "2-digit" });
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
}

/** Résumé court d'un message utilisateur (espaces compactés + ellipsis). */
export function truncatePreview(text: string, max = 90): string {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1).trimEnd();
  return `${cut}…`;
}

/** Taille de fichier lisible (B / KB / MB), 0 décimale superflue. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Filtre de recherche simple (insensible à la casse) sur le nom, l'aperçu du
 * premier message et l'id de session. Requête vide → liste inchangée (ordre
 * de tri conservé).
 */
export function filterPastSessions(sessions: PastSession[], query: string): PastSession[] {
  const q = (query || "").trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter(
    (s) =>
      (s.name || "").toLowerCase().includes(q) ||
      s.firstMessage.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q),
  );
}
