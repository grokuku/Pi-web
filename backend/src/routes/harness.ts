/**
 * harness.ts — Route INTERNE d'injection de l'activité des sous-agents
 * (LOT 2a, refonte du chat).
 *
 * Précédent : POST /api/attachments/:id/inject-to-chat (web-screenshot) —
 * les extensions Pi appellent l'API en http://127.0.0.1:3000 (apiAuth
 * autorise localhost) pour faire remonter une information dans le fil de
 * chat de la session PRINCIPALE du projet.
 *
 * Ici : à la fin d'une délégation (tool `delegate` de harness-orchestrator),
 * l'extension POSTe le résumé structuré de la vie du sous-agent ; la route
 * l'injecte dans la session principale via injectSubagentActivity (session.ts)
 * sous forme d'une entrée custom courte (customType "subagent_activity",
 * display:false) → persiste dans la session (survit au rechargement) SANS
 * coût LLM.
 *
 * Best-effort de bout en bout : un échec d'injection (session absente,
 * payload invalide, erreur SDK) ne fait JAMAIS échouer la délégation —
 * l'extension n'attend qu'une réponse HTTP, qu'elle ignore en cas d'erreur.
 */

import { Router, type Request, type Response } from "express";

const router = Router();

const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidProjectId(id: unknown): id is string {
  return typeof id === "string" && PROJECT_ID_RE.test(id);
}

/** Garde-fou : au plus 50 actions dans le résumé persisté (spec LOT 2a). */
const MAX_ACTIONS = 50;

/**
 * POST /api/harness/activity
 *
 * Body: { projectId?, cwd?, activity }
 *   - projectId (UUID) prioritaire ; sinon résolution par cwd (chemin exact
 *     du projet — l'extension fournit les deux car sa propre résolution peut
 *     tomber sur le nom du répertoire) ;
 *   - activity : résumé structuré { delegateRunId, function, label, model,
 *     status, attempts, durationMs, actionCount, eventCount, thinkingChars,
 *     cause, errorMessage, actions[], responsePreview }.
 *
 * Réponse: { success, injected, projectId }
 *   - injected=false (session inactive) → l'extension dégrade sans erreur.
 */
router.post("/activity", async (req: Request, res: Response) => {
  const body = (req.body || {}) as {
    projectId?: string;
    cwd?: string;
    activity?: Record<string, unknown>;
  };

  // ── Résolution du projet cible (projectId prioritaire, sinon cwd) ──
  let projectId: string | undefined;
  if (isValidProjectId(body.projectId)) {
    projectId = body.projectId;
  } else if (typeof body.cwd === "string" && body.cwd.trim()) {
    try {
      const { getAllProjects } = await import("../projects/manager.js");
      const project = getAllProjects().find((p) => p.cwd === body.cwd);
      if (project) projectId = project.id;
    } catch (e: any) {
      console.warn(`[harness] activity: project lookup by cwd failed:`, e?.message || e);
    }
  }
  if (!projectId) {
    return res.status(400).json({
      error: "Cannot resolve project: provide projectId (UUID) or a cwd matching a project",
    });
  }

  // ── Validation minimale du résumé ──
  const activity = body.activity;
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) {
    return res.status(400).json({ error: "Invalid activity payload" });
  }

  // Garde-fous défensifs (l'extension applique déjà ces bornes) : actions ≤ 50,
  // résumés ≤ 120 chars — on ne fait jamais confiance au réseau pour la taille.
  try {
    if (Array.isArray(activity.actions) && activity.actions.length > 50) {
      activity.actions = activity.actions.slice(0, 50);
    }
  } catch (e: any) {
    console.warn(`[harness] activity: payload normalization failed:`, e?.message || e);
  }

  // Import dynamique : session.ts importe attachments.ts (et d'autres routes)
  // en statique → un import statique inverse créerait une dépendance
  // circulaire (même pattern que inject-to-chat dans attachments.ts).
  try {
    const { injectSubagentActivity } = await import("../pi/session.js");
    const injected = await injectSubagentActivity(projectId, activity);
    return res.json({ success: true, injected, projectId });
  } catch (e: any) {
    // Best-effort : l'injection ne doit jamais retourner une erreur 500 qui
    // polluerait les logs de la délégation — on signale injected=false.
    console.error(`[harness] activity: injection failed for ${projectId}:`, e?.message || e);
    return res.json({ success: true, injected: false, projectId });
  }
});

export default router;