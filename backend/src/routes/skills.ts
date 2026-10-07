/**
 * skills.ts — API du panneau SKILLS de Pi-Web (liste, lecture, écriture,
 * restauration, création).
 *
 * Monté sur `/api/skills` (apiAuth globale). S'appuie sur le module PUR/I/O
 * `pi/skills-store.ts` pour toutes les opérations disque et les validations
 * (nom selon le spec Agent Skills, confinement sous `<agentDir>/skills`,
 * écritures atomiques). Le TOGGLE activé/désactivé n'est PAS dupliqué ici : il
 * reste sur POST /api/pi/toggle (motif `!<nom>`, mécanisme existant).
 *
 * Réponses (mêmes formes pour toutes les mutations, pratique côté UI) :
 *   - GET  /                  { skills: SkillInfo[] }
 *   - GET  /:name             { skill: SkillInfo, content, referenceContent }
 *   - PUT  /:name             { success, skill, content, referenceContent }
 *   - POST /:name/restore     { success, skill, content, referenceContent }
 *   - POST /                  { success, skill, content, referenceContent }
 *   avec SkillInfo = SkillEntry du store + `enabled` (dérivé de settings.skills).
 *
 * Codes d'erreur : 400 (nom/contenu invalide), 403 (skill générée, verrouillée),
 * 404 (introuvable), 409 (pas de référence à restaurer / nom déjà pris),
 * 500 (erreur disque).
 */

import { Router, type Request, type Response } from "express";
import {
  createSkill,
  isSkillEnabled,
  listSkills,
  readSkill,
  restoreSkill,
  writeSkill,
  type SkillDetail,
  type SkillEntry,
  type SkillErrorCode,
  type SkillResult,
} from "../pi/skills-store.js";
import { loadSettings } from "./pi-settings.js";

const router = Router();

// ── Helpers ─────────────────────────────────────────────

type SkillInfo = SkillEntry & { enabled: boolean };

/** Ajoute l'état activé/désactivé (settings.skills) à une entrée du store. */
function withEnabled(entry: SkillEntry, settingsSkills?: readonly string[]): SkillInfo {
  const skills = settingsSkills ?? loadSettings().skills;
  return { ...entry, enabled: isSkillEnabled(skills, entry.name) };
}

/** Forme de réponse commune aux lectures et mutations. */
function detailPayload(detail: SkillDetail) {
  const settings = loadSettings();
  return {
    skill: withEnabled(detail.entry, settings.skills),
    content: detail.content,
    referenceContent: detail.referenceContent,
  };
}

const ERROR_STATUS: Record<SkillErrorCode, number> = {
  "invalid-name": 400,
  "invalid-content": 400,
  "not-found": 404,
  generated: 403,
  "no-reference": 409,
  "already-exists": 409,
  "io-error": 500,
};

/** Traduit un échec du store en réponse HTTP cohérente. */
function sendSkillError(res: Response, result: Extract<SkillResult<unknown>, { ok: false }>): void {
  res.status(ERROR_STATUS[result.code] ?? 500).json({ error: result.error, code: result.code });
}

// ── Routes ──────────────────────────────────────────────

// GET liste des skills installées (avec statut, modifiée, activée)
router.get("/", (_req: Request, res: Response) => {
  try {
    const settings = loadSettings();
    res.json({ skills: listSkills().map((entry) => withEnabled(entry, settings.skills)) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "erreur inconnue" });
  }
});

// GET détail d'une skill (fiche + référence de comparaison)
router.get("/:name", (req: Request, res: Response) => {
  try {
    const result = readSkill(req.params.name);
    if (!result.ok) return sendSkillError(res, result);
    res.json(detailPayload(result.value));
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "erreur inconnue" });
  }
});

// PUT fiche éditée (écriture atomique, refus si générée)
router.put("/:name", (req: Request, res: Response) => {
  try {
    const result = writeSkill(req.params.name, (req.body as { content?: unknown } | undefined)?.content);
    if (!result.ok) return sendSkillError(res, result);
    console.log(`[skills] fiche enregistrée : ${result.value.entry.name}`);
    res.json({ success: true, ...detailPayload(result.value) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "erreur inconnue" });
  }
});

// POST restauration depuis la version de référence (livrée ou écosystème)
router.post("/:name/restore", (req: Request, res: Response) => {
  try {
    const result = restoreSkill(req.params.name);
    if (!result.ok) return sendSkillError(res, result);
    console.log(`[skills] restaurée depuis sa référence : ${result.value.entry.name} (${result.value.entry.reference?.kind})`);
    res.json({ success: true, ...detailPayload(result.value) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "erreur inconnue" });
  }
});

// POST création d'une nouvelle skill (nom + description)
router.post("/", (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { name?: unknown; description?: unknown };
    const result = createSkill(body.name, body.description);
    if (!result.ok) return sendSkillError(res, result);
    console.log(`[skills] créée : ${result.value.entry.name}`);
    res.status(201).json({ success: true, ...detailPayload(result.value) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "erreur inconnue" });
  }
});

export default router;
