import { Type, type Static } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { appendDraft } from "./commit-draft.js";

// Schéma
const logCommitNoteSchema = Type.Object({
  note: Type.String({
    description:
      "Résumé concis (1 ligne) de ce qui vient d'être modifié et pourquoi (intention réelle de la modification).",
  }),
});

/**
 * Tool log_commit_note : construit incrémentalement le draft de commit.
 * Le projectId est capturé dans la closure au moment de la création de la
 * session (même pattern que createDesignTools dans design-tools.ts), car le
 * contexte d'exécution du SDK (ExtensionContext) ne contient que `cwd`.
 */
export function createCommitDraftTool(projectId: string): ToolDefinition {
  return defineTool({
    name: "log_commit_note",
    label: "Log Commit Note",
    description:
      "Enregistre une note dans le draft de commit incrémental du projet. Appelle ce tool après chaque modification logique de fichiers avec un résumé concis (1 ligne) de ce qui a été modifié et pourquoi. Ces notes sont fusionnées et nettoyées par un LLM à l'ouverture de la modale de commit pour produire un message conventionnel.",
    promptSnippet: "Log a one-line note about the changes you just made (for the commit draft)",
    promptGuidelines: [
      "Call log_commit_note after each logical batch of file modifications, with a concise one-line summary of what changed and why",
      "Focus on the intent (what/why), not on listing file names — the files are captured automatically",
      "Do not log before editing — only after the edits are done",
    ],
    parameters: logCommitNoteSchema,
    async execute(toolCallId: string, params: Static<typeof logCommitNoteSchema>, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      appendDraft(projectId, "[intent] " + params.note);
      return {
        content: [{ type: "text" as const, text: "Commit note logged to the incremental commit draft." }],
        details: {},
      };
    },
  });
}
