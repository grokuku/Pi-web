/**
 * Shared Memory API — accès REST externe au système de mémoire à deux niveaux
 * (Lot M2, cf. docs/shared-memory-api.md).
 *
 * Namespace v1 : "public" uniquement — alias du store GLOBAL du memory-service
 * (~/.unipi/memory/_global_). Les mémoires de projet ne sont PAS exposées ici.
 * Tout autre namespace demandé → 501 (réservé aux lots futurs : agent:<id>,
 * private — cf. ROADMAP.md « Mémoire partagée »).
 *
 * Authentification dédiée (sharedMemoryAuth), accepte si :
 *   (a) requête locale — même logique isLocalhost que api-auth / librarian ;
 *   (b) Authorization: Bearer <agent-token> valide (validateToken d'agent-keys) ;
 *   (c) X-API-Key <clé librarian> valide (validateKey de librarian-auth).
 * Sinon 401.
 *
 * Toute écriture effectuée via une clé externe reçoit côté serveur le tag
 * additionnel "external:<keyName>" (traçabilité de l'origine des entrées),
 * et son contenu passe par sanitizeContent (retrait des données personnelles).
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import {
  searchMemories,
  listMemories,
  upsertMemory,
  deleteMemory,
  type WritableMemoryType,
} from "../pi/memory-service.js";
import { validateToken } from "./agent-keys.js";
import { validateKey, findKeyName } from "../pi/librarian-auth.js";
import { sanitizeContent } from "../pi/librarian-service.js";

const router = Router();

// ── Types ────────────────────────────────────────────────

/** Identité de l'appelant résolue par le middleware d'auth. */
type MemoryCaller =
  | { source: "localhost" }
  | { source: "agent-token"; keyName: string }
  | { source: "librarian-key"; keyName: string };

/** Request enrichi avec l'identité de l'appelant (posé par sharedMemoryAuth). */
interface SharedMemoryRequest extends Request {
  memoryCaller?: MemoryCaller;
}

// ── Authentification ─────────────────────────────────────

/**
 * Détection localhost — copie conforme de api-auth.ts / librarian-auth.ts
 * (les deux la dupliquent déjà entre eux ; elle est privée chez chacun).
 */
function isLocalhost(req: Request): boolean {
  const remoteIp = req.ip || req.socket.remoteAddress;
  return (
    remoteIp === "127.0.0.1" ||
    remoteIp === "::1" ||
    remoteIp === "::ffff:127.0.0.1"
  );
}

/**
 * Middleware d'auth de la mémoire partagée : localhost ∥ Bearer agent ∥ X-API-Key librarian.
 * Résout et attache l'identité de l'appelant sur req.memoryCaller (utilisé pour le tag external:*).
 */
export function sharedMemoryAuth(req: SharedMemoryRequest, res: Response, next: NextFunction): void {
  // (a) Requête locale (Pi-Web interne) → bypass, comme api-auth / librarianAuth.
  if (isLocalhost(req)) {
    req.memoryCaller = { source: "localhost" };
    next();
    return;
  }

  // (b) Jeton agent valide (Bearer). validateToken retourne la clé complète (avec .name).
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const key = validateToken(authHeader.slice(7));
    if (key) {
      req.memoryCaller = { source: "agent-token", keyName: key.name };
      next();
      return;
    }
  }

  // (c) Clé librarian valide (X-API-Key) — même validation que librarianAuth.
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim()) {
    if (validateKey(apiKey)) {
      req.memoryCaller = { source: "librarian-key", keyName: findKeyName(apiKey) ?? "unknown" };
      next();
      return;
    }
  }

  res.status(401).json({
    error:
      "Authentification requise : requête locale, en-tête 'Authorization: Bearer <agent token>' ou 'X-API-Key: <clé librarian>' valide.",
  });
}

// ── Helpers métier ───────────────────────────────────────

// Garde-fou taille : contenu max ~20 Ko (cohérent avec MAX_CONTENT_LENGTH=15000
// du memory-service, qui tronque de toute façon à 15 000 chars).
const MAX_CONTENT_BYTES = 20 * 1024;

// Types écrivables via l'API externe — "summary" volontairement absent
// (réservé aux checkpoints de compaction de l'extension).
const VALID_TYPES: readonly WritableMemoryType[] = ["preference", "decision", "pattern"];

/** Tag de traçabilité injecté côté serveur quand une clé externe est utilisée. */
function externalTag(caller: MemoryCaller | undefined): string | null {
  return caller && "keyName" in caller ? `external:${caller.keyName}` : null;
}

// ── Route publique (health) — avant le middleware d'auth ──

// GET /api/shared-memory/status — statut du service (health check)
router.get("/status", (_req: Request, res: Response) => {
  res.json({ ok: true, namespaces: ["public"] });
});

// ── Routes authentifiées (localhost ∥ Bearer agent ∥ X-API-Key librarian) ──

router.use(sharedMemoryAuth);

/**
 * GET /memories?q=<recherche>&limit=<n> — liste/recherche dans la mémoire publique (globale).
 * - q présent → searchMemories (sous-chaîne insensible à la casse) ;
 * - q absent  → listMemories (tri updated DESC, summaries exclus).
 */
router.get(["/public/memories", "/memories"], async (req: SharedMemoryRequest, res: Response) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    if (q) {
      // limit optionnel, borné [1..50] par le service.
      const rawLimit = Number(req.query.limit);
      const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : undefined;
      const memories = await searchMemories({ kind: "global" }, q, {
        includeSummaries: false,
        ...(limit !== undefined ? { limit } : {}),
      });
      res.json({ memories });
      return;
    }

    const memories = await listMemories({ kind: "global" }, { includeSummaries: false });
    res.json({ memories });
  } catch (error: any) {
    res.status(500).json({ error: error.message ?? "Erreur interne lors de la lecture des mémoires." });
  }
});

/**
 * GET /memories/:id — une mémoire par id (slug) ou titre exact.
 * Lecture seule : les summaries sont ici récupérables par id (utile au debug),
 * contrairement à la liste qui les exclut.
 */
router.get(
  ["/public/memories/:id", "/memories/:id"],
  async (req: SharedMemoryRequest, res: Response) => {
    try {
      const idOrTitle = String(req.params.id || "").trim();
      const entries = await listMemories({ kind: "global" }, { includeSummaries: true });
      const entry = entries.find((m) => m.id === idOrTitle || m.title === idOrTitle);
      if (!entry) {
        res.status(404).json({ error: `Mémoire "${idOrTitle}" introuvable.` });
        return;
      }
      res.json({ memory: entry });
    } catch (error: any) {
      res.status(500).json({ error: error.message ?? "Erreur interne lors de la lecture de la mémoire." });
    }
  }
);

/**
 * PUT /memories/:id — upsert { title?, content, type?, tags? }.
 * - id ignoré au profit du slug du titre (identifiant canonique du store,
 *   cohérent avec les tools LLM : un même titre = mise à jour) ;
 * - content requis non vide, plafonné à ~20 Ko ;
 * - contenu sanitizé (sanitizeContent) avant stockage ;
 * - tag additionnel "external:<keyName>" injecté côté serveur si écriture via clé externe.
 */
router.put(
  ["/public/memories/:id", "/memories/:id"],
  async (req: SharedMemoryRequest, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;

      // Validation : content requis, chaîne non vide après trim.
      const content = typeof body.content === "string" ? body.content : "";
      if (!content.trim()) {
        res.status(400).json({ error: "'content' est requis et doit être une chaîne non vide." });
        return;
      }

      // Garde-fou taille (~20 Ko) sur le contenu ET sur le corps total.
      if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
        res.status(413).json({ error: "'content' dépasse la taille maximale de 20 Ko." });
        return;
      }
      if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_CONTENT_BYTES) {
        res.status(413).json({ error: "Le corps de la requête dépasse la taille maximale de 20 Ko." });
        return;
      }

      // Type : optionnel, défaut "pattern" ; "summary" refusé (réservé aux checkpoints).
      const type = body.type === undefined ? "pattern" : body.type;
      if (typeof type !== "string" || !VALID_TYPES.includes(type as WritableMemoryType)) {
        res.status(400).json({
          error: `'type' invalide (${JSON.stringify(type)}). Valeurs acceptées : preference | decision | pattern. Le type "summary" est réservé aux checkpoints internes.`,
        });
        return;
      }

      // Sanitization AVANT tout usage : ni email/clé/chemin perso ne doit fuiter
      // vers le system prompt (le titre peut dériver du contenu).
      const safeContent = sanitizeContent(content);

      // Titre : fourni, sinon dérivé de la première ligne non vide du contenu
      // (l'id canonique étant le slug du titre, il ne peut pas être vide).
      let title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) {
        title = safeContent.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
      }
      if (!title) {
        res.status(400).json({
          error: "'title' est requis (ou doit pouvoir être dérivé d'une ligne non vide de 'content').",
        });
        return;
      }

      // Pré-validation du slug : même règle que slugifyTitle du memory-service
      // (titre tronqué à 120 caractères avant slugification). Un titre sans
      // aucun caractère alphanumérique (ex. "!!!") produit "_", refusé par
      // l'upsert côté service — détecté ici pour répondre 400 (validation
      // client) au lieu du 500 générique.
      const slug = title.slice(0, 120).toLowerCase().replace(/[^a-z0-9]+/g, "_");
      if (!slug || slug === "_") {
        res.status(400).json({ error: "Titre sans caractère alphanumérique." });
        return;
      }

      // Tags : filtrés (chaînes non vides). Le préfixe "external:" est réservé
      // au serveur (traçabilité des écritures via clé externe, injecté ci-dessous) :
      // toute tentative du client de le forger est rejetée en 400 plutôt que
      // filtrée en silence, pour garder ce tag fiable et le contrat explicite.
      const tags = Array.isArray(body.tags)
        ? body.tags.filter((t: unknown): t is string => typeof t === "string" && t.trim().length > 0)
        : [];
      if (tags.some((t) => t.toLowerCase().startsWith("external:"))) {
        res.status(400).json({
          error:
            'Les tags commençant par "external:" sont réservés au serveur (traçabilité des écritures via clé externe) et ne peuvent pas être fournis par le client.',
        });
        return;
      }
      const extTag = externalTag(req.memoryCaller);
      if (extTag && !tags.includes(extTag)) tags.push(extTag);

      const result = await upsertMemory({ kind: "global" }, {
        title,
        content: safeContent,
        type: type as WritableMemoryType,
        tags,
      });

      if (!result.ok) {
        res.status(500).json({ error: `Échec de l'enregistrement de la mémoire "${title}".` });
        return;
      }

      // L'id effectif est le slug du titre — renvoyé pour que le client puisse
      // enchaîner GET/DELETE sans deviner la règle de slugification.
      res.status(result.created ? 201 : 200).json({
        success: true,
        id: result.id,
        created: result.created,
        title,
        ...(extTag ? { taggedAs: extTag } : {}),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message ?? "Erreur interne lors de l'écriture de la mémoire." });
    }
  }
);

/**
 * DELETE /memories/:id — supprime par id (slug) ou titre exact.
 * Le service refuse les summaries → propagation en 403 (summary_protected).
 */
router.delete(
  ["/public/memories/:id", "/memories/:id"],
  async (req: SharedMemoryRequest, res: Response) => {
    try {
      const idOrTitle = String(req.params.id || "").trim();
      const result = await deleteMemory({ kind: "global" }, idOrTitle);

      if (result.ok) {
        res.json({ success: true, id: idOrTitle });
        return;
      }

      switch (result.reason) {
        case "summary_protected":
          res.status(403).json({
            error: `Suppression refusée : "${idOrTitle}" est un checkpoint de compaction (type 'summary'), géré automatiquement par l'extension compaction-checkpoint.`,
          });
          return;
        case "not_found":
          res.status(404).json({ error: `Mémoire "${idOrTitle}" introuvable.` });
          return;
        default:
          res.status(500).json({ error: `Échec de la suppression de "${idOrTitle}".` });
          return;
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message ?? "Erreur interne lors de la suppression de la mémoire." });
    }
  }
);

// ── Fallback : namespaces non supportés & routes inconnues ──

/**
 * Répartition du fallback :
 * - premier segment hors "memories"/"public"/"status" → namespace pas encore
 *   implémenté (agent:<id>, private, v1, v2…) → 501 ;
 * - sinon → sous-route inconnue d'un namespace supporté (ex. /public/foo,
 *   /memories) → 404. Syntaxe volontairement sans wildcard (Express 4/5).
 */
const KNOWN_SEGMENTS: readonly string[] = ["memories", "public", "status"];
router.use((req: Request, res: Response) => {
  const firstSegment = req.path.split("/").filter(Boolean)[0] ?? "";
  if (firstSegment && !KNOWN_SEGMENTS.includes(firstSegment)) {
    res.status(501).json({
      error: `Namespace "${firstSegment}" non implémenté. Seul "public" (alias du store global) est disponible en v1.`,
    });
    return;
  }
  res.status(404).json({ error: "Route inconnue. Voir docs/shared-memory-api.md." });
});

export default router;
