// ── Helper fetch : parsing blindé des réponses JSON ──
// Contexte : derrière un SSO (Authentik), un fetch peut recevoir du HTML
// (page de login) alors que le frontend attend du JSON. Un res.json() nu
// échoue alors avec un laconique "JSON.parse: unexpected character".
// Ce helper vérifie le Content-Type AVANT de parser et lève des erreurs
// lisibles : session expirée (page de login détectée) ou erreur serveur.

/** Libellés i18n pré-traduits par l'appelant (ce helper n'a pas accès au hook useTranslation). */
export interface ApiErrorLabels {
  sessionExpired: string;
  serverError: (status: number) => string;
}

/** Traces d'une page de login SSO (Authentik / outpost) dans le HTML reçu. */
const LOGIN_PAGE_MARKERS = ["outpost.goauthentik.io", "authentik", "sign-in"];

/**
 * Parse une réponse fetch en JSON, avec garde anti-HTML.
 * - Content-Type non-JSON : lecture du texte ; si ça ressemble à une page de
 *   login Authentik → erreur "session expirée", sinon "erreur serveur <status>".
 * - Content-Type JSON : res.json() classique ; sur !res.ok, throw avec
 *   body.error si présent (le corps complet est attaché à err.data pour les
 *   appelants qui ont besoin de codes structurés, ex. GIT_AUTH_REQUIRED).
 */
export async function parseJsonResponse<T>(res: Response, labels: ApiErrorLabels): Promise<T> {
  const contentType = res.headers.get("content-type") ?? "";

  // ── Réponse non-JSON : probablement du HTML (login SSO, erreur proxy…) ──
  if (!contentType.includes("application/json")) {
    const text = await res.text().catch(() => "");
    const lower = text.toLowerCase();
    if (LOGIN_PAGE_MARKERS.some((marker) => lower.includes(marker))) {
      // Page de login Authentik : la session a été invalidée côté serveur.
      throw new Error(labels.sessionExpired);
    }
    throw new Error(labels.serverError(res.status));
  }

  // ── Réponse JSON : parse classique ──
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    // Content-Type JSON mais corps illisible (réponse tronquée…)
    throw new Error(labels.serverError(res.status));
  }

  // ── Erreur métier renvoyée en JSON : { error: "…" } ──
  if (!res.ok) {
    const body = (data ?? {}) as { error?: unknown };
    const message =
      typeof body.error === "string" && body.error.length > 0
        ? body.error
        : labels.serverError(res.status);
    // Corps complet attaché à l'erreur (codes structurés côté appelant).
    const error = new Error(message) as Error & { data?: unknown };
    error.data = data;
    throw error;
  }

  return data as T;
}