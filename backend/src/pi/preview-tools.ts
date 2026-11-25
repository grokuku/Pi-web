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
 *
 * FAITS RÉELS (à confronter aux descriptions ci-dessous — elles n'ont le droit
 * de promettre QUE ceci, cf. routes/preview.ts) :
 *   - preview_html : stockage EN MÉMOIRE, max 500 Ko, TTL 10 min, perdu au
 *     redémarrage (les bornes sont interpolées depuis les constantes, pas recopiées).
 *   - open_preview : fichier du projet, chemin RELATIF confiné au cwd (isPathAllowed),
 *     pas de TTL.
 *   - Seuls les MIME de MIME_MAP s'affichent ; tout le reste part en
 *     application/octet-stream → TÉLÉCHARGÉ par le navigateur (pas de PDF/vidéo/police).
 *   - Sous-ressources chargées en RELATIF → elles doivent être dans le projet.
 *   - CSP sandbox sans allow-same-origin → scripts OK, pas de localStorage/API Pi-Web.
 *   - UNE seule fenêtre (frontend App.tsx : presentPreview remplace lastPreview).
 */

import { Type, type Static } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync } from "fs";
import path from "path";
import { getProject } from "../projects/manager.js";
import { isPathAllowed } from "../utils/path-security.js";
import { storeInlineHtml, INLINE_MAX_SIZE, INLINE_TTL_MS } from "../routes/preview.js";

/** Limites inline formatées pour le prompt — source unique : routes/preview.ts. */
const INLINE_MAX_KO = Math.round(INLINE_MAX_SIZE / 1024); // 500
const INLINE_TTL_MIN = Math.round(INLINE_TTL_MS / 60_000); // 10

// ── open_preview ──────────────────────────────────────────
// NOTE mécanisme prompt : `promptSnippet` alimente la liste « Available tools »
// et `promptGuidelines` la section « Guidelines: » du prompt système (SDK,
// buildSystemPrompt) TANT QUE le tool est actif — même canal que le tool
// delegate (extensions/harness-orchestrator/index.ts). Renforcer ces champs = renforcer le prompt
// système ; pas d'autre ligne à maintenir ailleurs.
//
// LANGUE (cohérence avec memory-tools.ts / librarian-tools.ts / design-tools.ts
// / commit-draft-tool.ts) : `description` et descriptions de paramètres en
// FRANÇAIS, `promptSnippet` et `promptGuidelines` en ANGLAIS. Ne pas inverser :
// le modèle lit la description du tool et les guidelines dans deux sections
// différentes du prompt, la convention du dépôt est celle ci-dessus.
//
// Incident Yuki : l'agent répondait avec des liens /api/attachments/<id>/file
// (qui n'ouvrent AUCUNE fenêtre) et des web_screenshot (capture pour lui, pas
// pour le user) au lieu d'appeler open_preview. Guidelines ci-dessous
// volontairement explicites et interdictives sur ce point.

const openPreviewSchema = Type.Object({
  projectId: Type.String({
    description:
      "Identifiant du projet Pi-Web (UUID, donné dans le contexte du projet) contenant le fichier à afficher.",
  }),
  path: Type.String({
    description:
      "Chemin RELATIF à la racine du projet (ex: 'index.html' ou 'dist/index.html') — pas de chemin absolu, pas de ../ hors du projet. Formats rendus : .html, .svg, images, .txt, .md.",
  }),
});

export const openPreviewToolDef = defineTool({
  name: "open_preview",
  label: "Open Preview",
  description:
    "Ouvre un fichier DU PROJET dans la fenêtre Preview du user (fenêtre de rendu) — le SEUL moyen de " +
    "faire VOIR une page au user. À appeler dès qu'il demande à voir une page, une interface, un " +
    "design ou un rendu (« montre-moi », « affiche », « preview », « à quoi ça ressemble ») et après " +
    "toute création/modification d'un fichier HTML. La fenêtre rend : .html, .svg, les images " +
    "(.png .jpg .jpeg .gif .webp .ico), .txt et .md ; tout autre format (PDF, vidéo, police, .tsx…) " +
    "est TÉLÉCHARGÉ au lieu d'être affiché. Le chemin est RELATIF à la racine du projet (chemins " +
    "absolus et ../ sortants refusés) et les assets (CSS/JS/images) doivent être dans le projet et " +
    "référencés en relatif. Une seule fenêtre : un nouvel appel REMPLACE l'aperçu courant. " +
    "HTML ad-hoc sans fichier → preview_html. Ne te contente JAMAIS de donner un lien : les liens " +
    "(notamment /api/attachments/<id>/file) n'ouvrent aucune fenêtre côté user.",
  promptSnippet:
    "Open a project file (relative path) in the user's Preview window — the ONLY way to let the user SEE a page or design",
  promptGuidelines: [
    // Incident Yuki : l'agent donnait des liens d'attachements au lieu d'appeler
    // open_preview. Guidelines actionnables, injectées dans le prompt système
    // tant que le tool est actif.
    "Call open_preview whenever the user wants to SEE a page, a UI, a design or a rendering (show, display, preview, \"what does it look like\") — never answer with a bare link or a description.",
    "/api/attachments/<id>/file links open NO window for the user, and web_screenshot produces an image for YOU: neither shows a page — use open_preview for that.",
    "After creating or editing an HTML file, call open_preview so the user sees the result immediately.",
    "path MUST be relative to the project root ('index.html', 'dist/index.html'): absolute paths and ../ escapes are rejected. Sub-assets (CSS/JS/images) must live in the project and be referenced relatively, otherwise they do not load.",
    "The window renders .html, .svg, images (.png .jpg .jpeg .gif .webp .ico), .txt and .md only — any other format (PDF, video, fonts, .tsx…) is downloaded, not displayed. One window only: a new call REPLACES the current preview.",
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
    description:
      `Le document HTML complet du mockup (max ${INLINE_MAX_KO} Ko). Utilise des URL d'assets ABSOLUES (CDN, data:) : les chemins relatifs ne se résolvent pas dans cette preview.`,
  }),
});

export const previewHtmlToolDef = defineTool({
  name: "preview_html",
  label: "Preview HTML",
  description:
    "Affiche un mockup HTML ad-hoc dans la fenêtre Preview du user — pour un rendu visuel SANS fichier " +
    "(fichier existant du projet → open_preview). Le HTML est gardé EN MÉMOIRE : " +
    `${INLINE_MAX_KO} Ko maximum, expiré au bout de ${INLINE_TTL_MIN} minutes et perdu au redémarrage du serveur — ` +
    "pour un rendu durable, écris un fichier puis appelle open_preview. Les chemins d'assets relatifs ne se " +
    "résolvent pas : utilise des URL absolues (CDN) ou des data:. Le document est isolé (origine opaque) : " +
    "scripts et formulaires fonctionnent, mais aucun accès au localStorage de Pi-Web ni aux API same-origin. " +
    "Une seule fenêtre : un nouvel appel REMPLACE l'aperçu courant.",
  promptSnippet: "Show an ad-hoc HTML mockup in the user's Preview window",
  promptGuidelines: [
    "Use preview_html to show a visual mockup WITHOUT creating a file; for an existing project file use open_preview instead.",
    "Provide the COMPLETE HTML document, with ABSOLUTE asset URLs (CDN or data:) — relative paths do not resolve in this preview.",
    `Hard limits: ${INLINE_MAX_KO} KB per call, ${INLINE_TTL_MIN}-minute expiry, in-memory (lost on server restart). For anything the user must keep, write a file and use open_preview.`,
    "The document is sandboxed (opaque origin): scripts and forms run, but Pi-Web localStorage and same-origin /api calls are NOT reachable. A new call replaces the current preview.",
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
