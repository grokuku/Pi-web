/**
 * Memory Tools — 3 tools exposés au LLM pour le système de mémoire à deux niveaux.
 *
 * Pattern identique à librarian-tools.ts : defineTool + schémas TypeBox.
 * Le scope "project" résout le cwd via ctx.cwd (ExtensionContext du SDK),
 * comme les autres tools custom de la session.
 *
 * Note : le type "summary" n'est jamais exposé au LLM — les checkpoints de
 * compaction sont écrits par l'extension compaction-checkpoint uniquement.
 */

import { Type, type Static } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  upsertMemory,
  searchMemories,
  deleteMemory,
  type MemoryScope,
} from "./memory-service.js";

/** Résout le scope mémoire depuis le paramètre du tool + le cwd du contexte. */
function resolveScope(kind: "project" | "global", ctx: any): MemoryScope {
  return kind === "project" ? { kind: "project", cwd: String(ctx?.cwd || process.cwd()) } : { kind: "global" };
}

/** Extrait compact d'un contenu pour l'affichage des résultats de recherche. */
function excerpt(content: string, max = 300): string {
  const flat = (content || "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max) + " […]";
}

const SCOPE_PARAM = Type.Union([Type.Literal("project"), Type.Literal("global")], {
  description:
    "Portée de la mémoire : 'project' = liée au projet courant (décisions techniques, patterns du repo), 'global' = préférences utilisateur valables partout.",
});

// ── memory_store ─────────────────────────────────────────

const memoryStoreSchema = Type.Object({
  scope: SCOPE_PARAM,
  title: Type.String({
    description:
      "Titre court et explicite de la mémoire (ex: 'Utilise pnpm plutôt que npm', 'API auth via JWT RS256'). Un doublon met à jour l'entrée existante.",
  }),
  content: Type.String({
    description:
      "Contenu détaillé de la mémoire. Sois précis et factuel : c'est tout ce qui sera relu dans les sessions futures.",
  }),
  type: Type.Union(
    [Type.Literal("preference"), Type.Literal("decision"), Type.Literal("pattern")],
    {
      description:
        "'preference' = goût/méthode de travail de l'utilisateur, 'decision' = choix technique acté pour le projet, 'pattern' = convention récurrente du codebase.",
    }
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), {
      description: "Tags optionnels pour affiner les recherches futures (ex: ['build', 'docker']).",
    })
  ),
});

export const memoryStoreToolDef = defineTool({
  name: "memory_store",
  label: "Memory Store",
  description:
    "Mémorise une information durable pour les sessions futures. Utilise ce tool pour : 1) stocker une décision technique du projet (architecture, librairie choisie, commande de build) avec scope='project', 2) stocker une préférence utilisateur globale (style de code, langue, workflow) avec scope='global', 3) stocker un pattern récurrent du projet avec scope='project'. N'utilise PAS ce tool pour des informations temporaires ou déjà visibles dans les fichiers du repo.",
  promptSnippet: "Save durable knowledge (decisions, preferences, patterns) for future sessions",
  promptGuidelines: [
    "Use memory_store when the user states a preference or validates a technical decision worth remembering",
    "Prefer scope='project' for project-specific facts, scope='global' for user-wide preferences",
    "Reusing an existing title UPDATES the memory instead of duplicating it",
  ],
  parameters: memoryStoreSchema,
  async execute(
    toolCallId: string,
    params: Static<typeof memoryStoreSchema>,
    signal: AbortSignal | undefined,
    onUpdate: any,
    ctx: any
  ) {
    try {
      const result = await upsertMemory(resolveScope(params.scope, ctx), {
        title: params.title,
        content: params.content,
        type: params.type,
        tags: params.tags ?? [],
      });

      if (!result.ok) {
        return {
          content: [
            { type: "text" as const, text: `❌ Échec de l'enregistrement mémoire : "${params.title}".` },
          ],
          details: {},
        };
      }

      const action = result.created ? "enregistrée" : "mise à jour (entrée existante)";
      const scopeLabel = params.scope === "project" ? "projet" : "globale";
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Mémoire ${scopeLabel} ${action} : "${params.title}" [${params.type}]${
              params.tags?.length ? ` — tags: ${params.tags.join(", ")}` : ""
            }`,
          },
        ],
        details: {},
      };
    } catch (error: any) {
      return {
        content: [{ type: "text" as const, text: `Erreur memory_store : ${error.message}` }],
        details: {},
      };
    }
  },
});

// ── memory_search ────────────────────────────────────────

const memorySearchSchema = Type.Object({
  query: Type.String({
    description: "Mot(s)-clé ou phrase à rechercher dans les mémoires (titre, contenu et tags).",
  }),
  scope: Type.Optional(
    Type.Union([Type.Literal("project"), Type.Literal("global"), Type.Literal("all")], {
      description: "Portée de la recherche (défaut : 'all' = global + projet).",
    })
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Nombre maximum de résultats (défaut : 8).",
    })
  ),
});

export const memorySearchToolDef = defineTool({
  name: "memory_search",
  label: "Memory Search",
  description:
    "Recherche dans la mémoire persistante (sessions passées) : décisions projet, préférences utilisateur, patterns, résumés. Utilise ce tool en début de tâche pour vérifier si un choix a déjà été acté, ou quand l'utilisateur référence quelque chose de connu ('comme d'habitude', 'on avait décidé que...'). Les résultats incluent aussi les checkpoints de compaction automatiques.",
  promptSnippet: "Search persisted memories from previous sessions",
  promptGuidelines: [
    "Use memory_search before re-asking the user something that may already be recorded",
    "Default scope='all' searches both project and global memories",
  ],
  parameters: memorySearchSchema,
  async execute(
    toolCallId: string,
    params: Static<typeof memorySearchSchema>,
    signal: AbortSignal | undefined,
    onUpdate: any,
    ctx: any
  ) {
    try {
      // Le scope "all" fusionne global + projet : le cwd du contexte est requis.
      const scopeParam = params.scope ?? "all";
      // includeSummaries: true — cf. description du tool : les checkpoints de
      // compaction sont inclus aux résultats (continuité inter-compactions).
      const results = await searchMemories(scopeParam as any, params.query, {
        limit: params.limit ?? 8,
        includeSummaries: true,
        cwd: String(ctx?.cwd || process.cwd()),
      });

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Aucune mémoire trouvée pour : "${params.query}" (scope: ${scopeParam}).`,
            },
          ],
          details: {},
        };
      }

      let output = `## Mémoires trouvées (${results.length}) pour : "${params.query}"\n\n`;
      results.forEach((r, i) => {
        const scopeLabel =
          r.scope === "global" ? "globale" : r.scope === "project" ? "projet" : r.project;
        output += `${i + 1}. **${r.title}** [${r.type}] — scope: ${scopeLabel}\n`;
        output += `   ${excerpt(r.content)}\n`;
        if (r.tags.length > 0) output += `   Tags: ${r.tags.join(", ")}\n`;
        if (r.updated) output += `   Mise à jour : ${r.updated}\n`;
        output += `\n`;
      });
      output += `_Astuce : memory_store avec le même titre met à jour une entrée existante._`;

      return { content: [{ type: "text" as const, text: output }], details: {} };
    } catch (error: any) {
      return {
        content: [{ type: "text" as const, text: `Erreur memory_search : ${error.message}` }],
        details: {},
      };
    }
  },
});

// ── memory_delete ────────────────────────────────────────

const memoryDeleteSchema = Type.Object({
  scope: SCOPE_PARAM,
  title: Type.String({
    description: "Titre exact (ou slug) de la mémoire à supprimer. Utilise memory_search pour le vérifier avant.",
  }),
});

export const memoryDeleteToolDef = defineTool({
  name: "memory_delete",
  label: "Memory Delete",
  description:
    "Supprime une mémoire obsolète ou erronée (par titre exact). Utilise ce tool uniquement sur demande explicite de l'utilisateur ou pour corriger une information fausse. Les résumés de compaction (type 'summary') ne peuvent PAS être supprimés.",
  promptSnippet: "Delete an obsolete or wrong memory entry",
  parameters: memoryDeleteSchema,
  async execute(
    toolCallId: string,
    params: Static<typeof memoryDeleteSchema>,
    signal: AbortSignal | undefined,
    onUpdate: any,
    ctx: any
  ) {
    try {
      const result = await deleteMemory(resolveScope(params.scope, ctx), params.title);

      if (result.ok) {
        const scopeLabel = params.scope === "project" ? "projet" : "globale";
        return {
          content: [
            { type: "text" as const, text: `🗑️ Mémoire ${scopeLabel} supprimée : "${params.title}".` },
          ],
          details: {},
        };
      }

      switch (result.reason) {
        case "summary_protected":
          return {
            content: [
              {
                type: "text" as const,
                text: `⛔ Suppression refusée : "${params.title}" est un checkpoint de compaction (type 'summary'), géré automatiquement par l'extension compaction-checkpoint. Ces entrées ne sont pas supprimables.`,
              },
            ],
            details: {},
          };
        case "not_found":
          return {
            content: [
              {
                type: "text" as const,
                text: `Aucune mémoire "${params.title}" trouvée (scope: ${params.scope}). Utilise memory_search pour lister les titres exacts.`,
              },
            ],
            details: {},
          };
        default:
          return {
            content: [{ type: "text" as const, text: `❌ Échec de la suppression de "${params.title}".` }],
            details: {},
          };
      }
    } catch (error: any) {
      return {
        content: [{ type: "text" as const, text: `Erreur memory_delete : ${error.message}` }],
        details: {},
      };
    }
  },
});

export const memoryTools: ToolDefinition[] = [memoryStoreToolDef, memorySearchToolDef, memoryDeleteToolDef];
