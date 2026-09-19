/**
 * Preview Tools — 2 tools exposés au LLM pour la fenêtre Preview du user.
 *
 * Pattern identique à memory-tools.ts / librarian-tools.ts : defineTool +
 * schémas TypeBox. Le stockage inline est partagé avec la route
 * /api/preview-inline/:id (même Map mémoire, cf. routes/preview.ts).
 *
 * Contrat frontend (fixé) :
 *   - open_preview {projectId, path} → « Preview available at: /api/preview/<id>/<path> »
 *   - preview_html {html} → « Preview available at: /api/preview-inline/<id> »
 *     (ligne EXACTE — le frontend la parse par regex /api\/preview-inline\/[a-f0-9]+/).
 */

import { Type, type Static } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync } from "fs";
import path from "path";
import { getProject } from "../projects/manager.js";
import { isPathAllowed } from "../utils/path-security.js";
import { storeInlineHtml } from "../routes/preview.js";

// ── open_preview ──────────────────────────────────────────
// NOTE mécanisme prompt : `promptSnippet` alimente la liste « Available tools »
// et `promptGuidelines` la section « Guidelines: » du prompt système (SDK,
// buildSystemPrompt) TANT QUE le tool est actif — même canal que le tool
// delegate (extensions/harness-orchestrator/index.ts). Renforcer ces champs = renforcer le prompt
// système ; pas d'autre ligne à maintenir ailleurs.
//
// Incident Yuki : l'agent répondait avec des liens /api/attachments/<id>/file
// (qui n'ouvrent AUCUNE fenêtre) et des web_screenshot (capture pour lui, pas
// pour le user) au lieu d'appeler open_preview. Guidelines ci-dessous
// volontairement explicites et interdictives sur ce point.

const openPreviewSchema = Type.Object({
  projectId: Type.String({
    description: "Identifiant du projet Pi-Web (UUID) contenant le fichier à afficher.",
  }),
  path: Type.String({
    description:
      "Chemin relatif du fichier à afficher dans la fenêtre Preview du user (ex: 'index.html' ou 'dist/index.html').",
  }),
});

export const openPreviewToolDef = defineTool({
  name: "open_preview",
  label: "Open Preview",
  description:
    "Ouvre une page du projet dans la fenêtre Preview du user (popup de rendu) — le SEUL moyen de " +
    "faire VOIR une page au user. À appeler dès qu'il demande à voir une page, une interface, un " +
    "design ou un rendu (« montre-moi », « affiche », « preview », « à quoi ça ressemble ») et après " +
    "toute création/modification d'un fichier HTML. Ne te contente JAMAIS de donner un lien : les " +
    "liens (notamment /api/attachments/<id>/file) n'ouvrent aucune fenêtre côté user.",
  promptSnippet: "Open a project page in the user's Preview window (popup) — the ONLY way to let the user SEE a page or design",
  promptGuidelines: [
    // Incident Yuki : l'agent donnait des liens d'attachements au lieu d'appeler
    // open_preview. Guidelines actionnables, injectées dans le prompt système
    // tant que le tool est actif.
    "Quand l'utilisateur demande à VOIR une page, une interface, un design ou un rendu (voir, montrer, afficher, preview, « à quoi ça ressemble »…), appelle open_preview avec le chemin du fichier — ne réponds JAMAIS avec un simple lien ni une description.",
    "Les liens /api/attachments/<id>/file n'ouvrent AUCUNE fenêtre chez le user : ne les donne JAMAIS pour montrer une page. Une capture (web_screenshot…) est une image pour TOI, pas une fenêtre pour le user.",
    "Après avoir créé ou modifié un fichier HTML, appelle open_preview pour que le user voie immédiatement le rendu.",
    "Fichier existant du projet → open_preview (projectId + chemin relatif, ex. 'index.html' ou 'dist/index.html') ; HTML ad-hoc sans fichier → preview_html.",
  ],
  parameters: openPreviewSchema,
  async execute(
    toolCallId: string,
    params: Static<typeof openPreviewSchema>,
    signal: AbortSignal | undefined,
    onUpdate: any,
    ctx: any
  ) {
    const project = getProject(params.projectId);
    if (!project) {
      return {
        content: [{ type: "text" as const, text: `Projet introuvable : ${params.projectId}` }],
        details: {},
      };
    }
    const resolved = path.resolve(project.cwd, params.path);
    if (!isPathAllowed(resolved, project.cwd) || !existsSync(resolved)) {
      return {
        content: [
          { type: "text" as const, text: `Fichier introuvable ou inaccessible : ${params.path}` },
        ],
        details: {},
      };
    }
    return {
      content: [
        { type: "text" as const, text: `Preview available at: /api/preview/${params.projectId}/${params.path}` },
      ],
      details: {},
    };
  },
});

// ── preview_html ──────────────────────────────────────────

const previewHtmlSchema = Type.Object({
  html: Type.String({
    description: "Le HTML complet du mockup à afficher dans la fenêtre Preview du user.",
  }),
});

export const previewHtmlToolDef = defineTool({
  name: "preview_html",
  label: "Preview HTML",
  description:
    "Affiche un mockup HTML ad-hoc dans la fenêtre Preview du user — pour les rendus visuels sans fichier.",
  promptSnippet: "Show an ad-hoc HTML mockup in the user's Preview window",
  promptGuidelines: [
    "Use preview_html to show a visual mockup without creating a file (for an existing project file, use open_preview instead)",
    "Provide the complete HTML to render",
  ],
  parameters: previewHtmlSchema,
  async execute(
    toolCallId: string,
    params: Static<typeof previewHtmlSchema>,
    signal: AbortSignal | undefined,
    onUpdate: any,
    ctx: any
  ) {
    try {
      const id = storeInlineHtml(params.html);
      return {
        content: [{ type: "text" as const, text: `Preview available at: /api/preview-inline/${id}` }],
        details: {},
      };
    } catch (error: any) {
      return {
        content: [{ type: "text" as const, text: `Erreur preview_html : ${error.message}` }],
        details: {},
      };
    }
  },
});

export const previewTools: ToolDefinition[] = [openPreviewToolDef, previewHtmlToolDef];
