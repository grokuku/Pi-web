// Stockage en mémoire du design actif par projectId
const activeDesigns = new Map<string, { html: string; css: string }>();

export function setActiveDesign(projectId: string, html: string, css: string) {
  activeDesigns.set(projectId, { html, css });
}

export function getActiveDesign(projectId: string): { html: string; css: string } | null {
  return activeDesigns.get(projectId) ?? null;
}

export async function handleRenderDesign(projectId: string, html: string, css?: string): Promise<string> {
  const current = getActiveDesign(projectId) ?? { html: "", css: "" };
  const newDesign = {
    html: html || current.html,
    css: css !== undefined ? css : current.css,
  };
  activeDesigns.set(projectId, newDesign);

  // Émettre l'événement WebSocket
  const { emitToSubscribers } = await import("./session.js");
  emitToSubscribers({ type: "design_update", html: newDesign.html, css: newDesign.css } as any, projectId);

  return "Design updated on canvas";
}

export async function handleGetDesign(projectId: string): Promise<string> {
  const design = getActiveDesign(projectId);
  if (!design || (!design.html && !design.css)) return "No design loaded. Use import or create a design first.";
  return JSON.stringify({ html: design.html, css: design.css });
}

export async function sendDesignToChat(projectId: string, html: string, css: string): Promise<void> {
  const { getProjectSession } = await import("./session.js");
  const state = getProjectSession(projectId);
  if (!state?.session) throw new Error("No active session for this project");

  const designContext = `## Current Design (HTML/CSS)\n\n\`\`\`html\n${html}\n\`\`\`\n\n\`\`\`css\n${css}\n\`\`\``;
  await state.session.sendCustomMessage(
    { customType: "design_context", content: designContext, display: true, details: { html, css } },
    { triggerTurn: false }
  );
}