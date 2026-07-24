import { Type, type Static } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { webclawScrape, archiveDoc } from "./librarian-service.js";
import type { DocEntry, DocContent } from "./librarian-service.js";

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
    "Use librarian_search for ALL web and documentation searches",
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

      output += `\n💡 If these results contain useful technical documentation, use librarian_archive to save them for future reference.\n`;

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

// ── librarian_archive ──

const librarianArchiveSchema = Type.Object({
  url: Type.String({
    description: "The URL of the documentation page to archive",
  }),
  name: Type.String({
    description: "A short name for this documentation (e.g. 'express', 'react-hooks', 'vite-config')",
  }),
  description: Type.Optional(
    Type.String({
      description: "A brief description of what this documentation covers",
    }),
  ),
});

export async function executeArchive(args: {
  url: string;
  name: string;
  description?: string;
}): Promise<string> {
  try {
    // 1. Scraperr l'URL
    const scraped = await webclawScrape(args.url);
    if (!scraped.content || scraped.content.length < 50) {
      return `Could not retrieve content from ${args.url}`;
    }

    // 2. Créer l'entrée de doc
    const safeName = args.name.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 50);
    const docContent: DocContent = {
      meta: {
        name: safeName,
        version: "latest",
        type: "documentation",
        sourceUrl: args.url,
        updatedAt: new Date().toISOString(),
      },
      summary: args.description || scraped.description || scraped.title || "",
      keyPoints: [],
      api: [],
      examples: [],
      rawContent: scraped.content,
    };

    const filePath = `tools/${safeName}@latest.json`;
    const entry: DocEntry = {
      name: safeName,
      version: "latest",
      type: "documentation",
      description: docContent.summary.substring(0, 200),
      filePath,
      keywords: safeName.toLowerCase().split(/[-_]/).filter(t => t.length > 1),
      updatedAt: new Date().toISOString(),
      sourceUrl: args.url,
    };

    // 3. Archiver (sanitizeContent est appelé dans archiveDoc)
    archiveDoc(entry, docContent);

    return `Successfully archived "${safeName}" from ${args.url} (${scraped.content.length} chars)`;
  } catch (error: any) {
    return `Failed to archive: ${error.message}`;
  }
}

export const librarianArchiveToolDef = defineTool({
  name: "librarian_archive",
  label: "Librarian Archive",
  description:
    "Archive a web page as technical documentation in the local library. ALWAYS use this tool when librarian_search returns useful technical documentation (API docs, framework guides, library references, tutorials). This saves the content locally so future searches are instant. Do NOT archive news, weather, error messages, or non-documentation content. When in doubt about whether something is documentation, lean towards archiving it.",
  promptSnippet: "Archive a web page as documentation in the local library",
  promptGuidelines: [
    "Use librarian_archive to save useful documentation pages for future reference",
    "Provide a short, descriptive name (e.g. 'express', 'react-hooks', 'vite-config')",
    "Do NOT archive news articles, error messages, or non-documentation content",
  ],
  parameters: librarianArchiveSchema,
  async execute(
    toolCallId: string,
    params: Static<typeof librarianArchiveSchema>,
    signal: AbortSignal | undefined,
    onUpdate: any,
    ctx: any,
  ) {
    const result = await executeArchive(params);
    return {
      content: [{ type: "text" as const, text: result }],
      details: {},
    };
  },
});

export const librarianTools: ToolDefinition[] = [librarianSearchToolDef, librarianArchiveToolDef];