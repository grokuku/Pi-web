import { Router, type Request, type Response } from "express";
import { loadModelLibrary, getProjectRoutingConfig } from "../pi/model-library.js";
import { extractSignals, resolveRoute, pickModel } from "../pi/routing.js";
import type { SignalsInput } from "../pi/routing-types.js";

const router = Router();

/** Retourne la première valeur d'un query param (string | string[] | undefined). */
function first(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toBool(value: unknown): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  const s = String(value).toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return undefined;
}

/**
 * Construit un SignalsInput à partir des paramètres optionnels de la requête.
 * Les champs absents restent `undefined` et seront normalisés par extractSignals.
 */
function buildSignalsInput(req: Request): SignalsInput {
  const q = (req.method === "GET" ? req.query : req.body) ?? {};
  const signals: SignalsInput = {};

  const toolErrorRate = toNumber(q.toolErrorRate);
  if (toolErrorRate !== undefined) signals.toolErrorRate = toolErrorRate;

  const spinning = toBool(q.spinning);
  if (spinning !== undefined) signals.spinning = spinning;

  const exploringRatio = toNumber(q.exploringRatio);
  if (exploringRatio !== undefined) signals.exploringRatio = exploringRatio;

  const recentProductionIntensity = toNumber(q.recentProductionIntensity);
  if (recentProductionIntensity !== undefined) signals.recentProductionIntensity = recentProductionIntensity;

  const riskKeywords = toBool(q.riskKeywords);
  if (riskKeywords !== undefined) signals.riskKeywords = riskKeywords;

  const changedFiles = toNumber(q.changedFiles);
  if (changedFiles !== undefined) signals.changedFiles = changedFiles;

  const diffSize = toNumber(q.diffSize);
  if (diffSize !== undefined) signals.diffSize = diffSize;

  const contextUsage = toNumber(q.contextUsage);
  if (contextUsage !== undefined) signals.contextUsage = contextUsage;

  return signals;
}

async function handleDecision(req: Request, res: Response): Promise<void> {
  try {
    const source = req.method === "GET" ? req.query : req.body;
    const projectId = first(source?.projectId);
    const request = first(source?.request);

    if (!projectId || !request) {
      res.status(400).json({ error: "projectId and request are required (query or body)" });
      return;
    }

    const library = loadModelLibrary();
    const config = getProjectRoutingConfig(library, projectId);
    const signals = extractSignals(buildSignalsInput(req));
    const route = resolveRoute(request, config, signals);
    const model = pickModel(route, config, library);

    res.json({ route, modelId: model?.id ?? null });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

// GET /api/routing/decision?projectId=...&request=... (debug)
router.get("/decision", handleDecision);

// POST /api/routing/decision { projectId, request, ...signals } (debug)
router.post("/decision", handleDecision);

export default router;
