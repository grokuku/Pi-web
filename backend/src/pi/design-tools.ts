import { Type, type Static } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

// Schémas
const renderDesignSchema = Type.Object({
  html: Type.String({ description: "Le HTML complet de la page à rendre" }),
  css: Type.Optional(Type.String({ description: "Le CSS optionnel à appliquer" })),
});

const getDesignSchema = Type.Object({});

// Les outils seront wrappés dans design-bridge.ts avec l'accès au projectId
// Ici on définit juste la structure, execute() est un placeholder
export const renderDesignToolDef = defineTool({
  name: "render_design",
  label: "Render Design",
  description: "Met à jour le design dans le canvas GrapesJS avec le HTML/CSS fourni. Appelle ce tool pour appliquer visuellement les modifications de design demandées par l'utilisateur.",
  promptSnippet: "Apply visual design changes to the GrapesJS canvas",
  promptGuidelines: [
    "Use render_design when the user asks to visually modify the page layout, colors, typography, or any visual element",
    "Always provide the COMPLETE html (full page structure), not just the changed part",
    "Provide css when styling changes are needed",
  ],
  parameters: renderDesignSchema,
  async execute(toolCallId: string, params: Static<typeof renderDesignSchema>, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
    // Le ctx contient projectId via une propriété qu'on ajoutera
    // Pour l'instant, on délègue à design-bridge
    const projectId = (ctx as any)._projectId || "unknown";
    const { handleRenderDesign } = await import("./design-bridge.js");
    const result = await handleRenderDesign(projectId, params.html, params.css);
    return { content: [{ type: "text" as const, text: result }], details: {} };
  },
});

export const getDesignToolDef = defineTool({
  name: "get_design",
  label: "Get Design",
  description: "Récupère le design actuel (HTML + CSS) du canvas GrapesJS. Utilise ce tool pour lire le design avant de le modifier.",
  promptSnippet: "Read the current design HTML/CSS from the canvas",
  parameters: getDesignSchema,
  async execute(toolCallId: string, params: Static<typeof getDesignSchema>, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
    const projectId = (ctx as any)._projectId || "unknown";
    const { handleGetDesign } = await import("./design-bridge.js");
    const result = await handleGetDesign(projectId);
    return { content: [{ type: "text" as const, text: result }], details: {} };
  },
});

export const designCustomTools: ToolDefinition[] = [renderDesignToolDef, getDesignToolDef];