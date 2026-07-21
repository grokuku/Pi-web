import { Type, type Static } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

// Schéma
const librarianSearchSchema = Type.Object({
  query: Type.String({
    description:
      "La question ou recherche. Peut être un nom d'outil (ex: 'express routing'), une question technique (ex: 'comment configurer WebSocket en Node'), ou une recherche de documentation.",
  }),
});

export const librarianSearchToolDef = defineTool({
  name: "librarian_search",
  label: "Librarian Search",
  description:
    "Recherche dans la bibliothèque de documentation locale ET sur le web. Utilise ce tool pour: 1) Trouver la doc d'un outil/librairie spécifique, 2) Rechercher une information technique, 3) Vérifier une API ou un changement de version. Le libraire cherche d'abord dans sa bibliothèque (mise à jour hebdomadairement), puis sur le web si nécessaire, et archive le résultat.",
  promptSnippet: "Search the documentation library and web for technical information",
  promptGuidelines: [
    "Use librarian_search instead of firecrawl_search for ALL web searches",
    "The librarian caches results, so repeated searches for the same topic are fast and free",
    "Results are archived in the documentation library for future use",
  ],
  parameters: librarianSearchSchema,
  async execute(
    toolCallId: string,
    params: Static<typeof librarianSearchSchema>,
    signal: AbortSignal | undefined,
    onUpdate: any,
    ctx: any,
  ) {
    const { searchAndArchive } = await import("./librarian-service.js");
    try {
      const { results, archived } = await searchAndArchive(params.query);

      if (results.length === 0) {
        return {
          content: [
            { type: "text" as const, text: `No results found for: ${params.query}` },
          ],
          details: {},
        };
      }

      // Formater les résultats pour le LLM
      let output = `## Search results for: "${params.query}"\n\n`;
      results.forEach((r, i) => {
        output += `### ${i + 1}. ${r.title}\n`;
        if (r.url) output += `URL: ${r.url}\n`;
        if (r.snippet) output += `${r.snippet}\n`;
        if (r.content) {
          // Limiter le contenu pour pas exploser le context
          const truncated =
            r.content.length > 3000
              ? r.content.substring(0, 3000) + "\n... (truncated)"
              : r.content;
          output += `\n${truncated}\n`;
        }
        output += `\n---\n\n`;
      });

      if (archived) {
        output += `\n_Results archived in the documentation library._\n`;
      }

      return { content: [{ type: "text" as const, text: output }], details: {} };
    } catch (error: any) {
      return {
        content: [
          { type: "text" as const, text: `Librarian search error: ${error.message}` },
        ],
        details: {},
      };
    }
  },
});

export const librarianTools: ToolDefinition[] = [librarianSearchToolDef];