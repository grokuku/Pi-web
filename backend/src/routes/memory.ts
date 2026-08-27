/**
 * Memory API interne (Lot M3) — gestion UI des mémoires global/projet.
 *
 * Monté sur /api/memory, protégé par apiAuth globale (same-origin, cf. index.ts)
 * : aucune authentification supplémentaire nécessaire.
 *
 * Endpoints :
 *   GET    /global              → listMemories du store GLOBAL {includeSummaries:false}
 *   GET    /project             → listMemories du projet actif (projectId ou cwd en
 *                                   query ; le cwd est résolu via projects/manager)
 *   PUT    /:scope              → upsertMemory { title, content, type, tags? }
 *   DELETE /:scope/:id          → deleteMemory (summary_protected propagé en 403)
 *
 * Le scope est "global" | "project". Le type "summary" est refusé à l'écriture
 * (réservé aux checkpoints de compaction de l'extension compaction-checkpoint).
 */

import { Router, type Request, type Response } from "express";
import {
  listMemories,
  upsertMemory,
  deleteMemory,
  type MemoryScope,
  type WritableMemoryType,
} from "../pi/memory-service.js";
import { getProject } from "../projects/manager.js";
import { isCwdAllowed } from "../utils/path-security.js";

const router = Router();

// ── Constantes de validation ─────────────────────────────

// Types écrivables via l'API interne — "summary" volontairement absent
// (réservé aux checkpoints de compaction), même règle que shared-memory.
const VALID_TYPES: readonly WritableMemoryType[] = ["preference", "decision", "pattern"];

// Garde-fou taille : contenu max ~15 Ko (cohérent avec MAX_CONTENT_LENGTH=15000
// du memory-service, qui tronque de toute façon au-delà).
const MAX_CONTENT_BYTES = 15 * 1024;

// ── Résolution du scope projet ───────────────────────────

type ScopeResolution =
  | { ok: true; scope: MemoryScope }
  | { ok: false; status: number; message: string };

/**
 * Résout un MemoryScope de type "project" depuis la requête :
 * - ?projectId=<id> → cwd résolu via getProject() (source privilégiée) ;
 * - ?cwd=<chemin>   → accepté en secours, validé par isCwdAllowed (deny/allow-list).
 */
function resolveProjectScope(req: Request): ScopeResolution {
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId.trim() : "";
  const cwdParam = typeof req.query.cwd === "string" ? req.query.cwd.trim() : "";

  if (projectId) {
    const project = getProject(projectId);
    if (!project) {
      return { ok: false, status: 404, message: `Projet "${projectId}" introuvable.` };
    }
    return { ok: true, scope: { kind: "project", cwd: project.cwd } };
  }

  if (cwdParam) {
    if (!isCwdAllowed(cwdParam)) {
      return { ok: false, status: 403, message: `Répertoire non autorisé : "${cwdParam}".` };
    }
    return { ok: true, scope: { kind: "project", cwd: cwdParam } };
  }

  return {
    ok: false,
    status: 400,
    message: "Paramètre requis manquant : projectId (ou cwd) pour le scope 'project'.",
  };
}

/** Résout le scope complet ("global" | "project") pour PUT et DELETE. */
function resolveScope(req: Request): ScopeResolution {
  const kind = req.params.scope;
  if (kind !== "global" && kind !== "project") {
    return { ok: false, status: 404, message: `Scope inconnu : "${kind}". Valeurs : global | project.` };
  }
  if (kind === "project") return resolveProjectScope(req);
  return { ok: true, scope: { kind: "global" } };
}

/**
 * Pré-validation du slug d'un titre — même règle que slugifyTitle du
 * memory-service (titre tronqué à 120 caractères avant slugification). Un
 * titre sans aucun caractère alphanumérique produit "_", refusé par l'upsert :
 * détecté ici pour répondre 400 au lieu d'un 500 générique.
 */
function isValidTitleSlug(title: string): boolean {
  const slug = title.slice(0, 120).toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return !!slug && slug !== "_";
}

// ── GET /global — liste des mémoires globales ────────────

router.get("/global", async (_req: Request, res: Response) => {
  try {
    const memories = await listMemories({ kind: "global" }, { includeSummaries: false });
    res.json({ memories });
  } catch (error: any) {
    res.status(500).json({ error: error.message ?? "Erreur interne lors de la lecture des mémoires globales." });
  }
});

// ── GET /project — liste des mémoires du projet actif ────

router.get("/project", async (req: Request, res: Response) => {
  const resolved = resolveProjectScope(req);
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.message });
    return;
  }
  try {
    const memories = await listMemories(resolved.scope, { includeSummaries: false });
    res.json({ memories });
  } catch (error: any) {
    res.status(500).json({ error: error.message ?? "Erreur interne lors de la lecture des mémoires du projet." });
  }
});

// ── PUT /:scope — upsert d'une mémoire ───────────────────

router.put("/:scope", async (req: Request, res: Response) => {
  const resolved = resolveScope(req);
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.message });
    return;
  }

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Validation : content requis, chaîne non vide après trim.
    const content = typeof body.content === "string" ? body.content : "";
    if (!content.trim()) {
      res.status(400).json({ error: "'content' est requis et doit être une chaîne non vide." });
      return;
    }

    // Garde-fou taille (~15 Ko) sur le contenu ET sur le corps total.
    if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
      res.status(413).json({ error: "'content' dépasse la taille maximale de 15 Ko." });
      return;
    }
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_CONTENT_BYTES) {
      res.status(413).json({ error: "Le corps de la requête dépasse la taille maximale de 15 Ko." });
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

    // Titre : fourni, sinon dérivé de la première ligne non vide du contenu
    // (l'id canonique étant le slug du titre, il ne peut pas être vide).
    let title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      title = content.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
    }
    if (!title) {
      res.status(400).json({ error: "'title' est requis (ou doit pouvoir être dérivé d'une ligne non vide de 'content')." });
      return;
    }
    if (!isValidTitleSlug(title)) {
      res.status(400).json({ error: "Titre sans caractère alphanumérique." });
      return;
    }

    // Tags : tableau de chaînes non vides (l'UI envoie les tags parsés).
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((t: unknown): t is string => typeof t === "string" && t.trim().length > 0)
      : [];

    const result = await upsertMemory(resolved.scope, {
      title,
      content,
      type: type as WritableMemoryType,
      tags,
    });

    if (!result.ok) {
      res.status(500).json({ error: `Échec de l'enregistrement de la mémoire "${title}".` });
      return;
    }

    // L'id effectif est le slug du titre — renvoyé pour cohérence avec shared-memory.
    res.status(result.created ? 201 : 200).json({ success: true, id: result.id, created: result.created });
  } catch (error: any) {
    res.status(500).json({ error: error.message ?? "Erreur interne lors de l'écriture de la mémoire." });
  }
});

// ── DELETE /:scope/:id — suppression d'une mémoire ───────

router.delete("/:scope/:id", async (req: Request, res: Response) => {
  const resolved = resolveScope(req);
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.message });
    return;
  }

  try {
    const idOrTitle = String(req.params.id || "").trim();
    const result = await deleteMemory(resolved.scope, idOrTitle);

    if (result.ok) {
      res.json({ success: true, id: idOrTitle });
      return;
    }

    switch (result.reason) {
      case "summary_protected":
        // Checkpoint de compaction : suppression interdite → 403 explicite.
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
});

// ── Fallback : routes inconnues sous /api/memory ─────────

router.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Route mémoire inconnue. Endpoints : GET /global, GET /project, PUT /:scope, DELETE /:scope/:id." });
});

export default router;
