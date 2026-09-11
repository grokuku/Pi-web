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
    "Affiche une page du projet dans la fenêtre Preview du user — à utiliser après avoir créé/modifié un fichier HTML pour qu'il voie le rendu.",
  promptSnippet: "Open a project page in the user's Preview window",
  promptGuidelines: [
    "Use open_preview after creating or modifying an HTML file so the user can see the rendered result",
    "Provide the projectId and the relative path to the file within the project",
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
    "Affiche un mockup HTML ad-hoc — pour les rendus visuels sans fichier.",
  promptSnippet: "Show an ad-hoc HTML mockup in the user's Preview window",
  promptGuidelines: [
    "Use preview_html to show a visual mockup without creating a file",
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
