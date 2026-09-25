/**
 * Assemblage du prompt système Pi-Web (migration SDK pi 0.87.1).
 *
 * En 0.87.1 le prompt système n'est plus un champ mutable : `agent.state.systemPrompt`
 * est un GETTER sans setter et le transcript est canonique (SessionManager). Le backend,
 * qui n'est pas une extension fichier, enregistre une extension INLINE (via
 * `DefaultResourceLoader.extensionFactories`) qui remplace le prompt à CHAQUE run par
 * l'API officielle `before_agent_start` (résultat `{ systemPrompt }`, cf.
 * pi-coding-agent dist/core/extensions/types.d.ts:917-921 et docs/extensions.md:101).
 *
 * Propriétés garanties :
 * - recomposition à chaque run → plus de perte du prompt au `setActiveToolsByName` ;
 * - aucun cumul entre tours (le résultat forcé n'entre pas dans le transcript) ;
 * - P3 (cache) : pour un couple (projet, rôle) donné, les mêmes entrées produisent le
 *   même texte → le préfixe système reste byte-stable et cachable.
 *
 * Ce module est PUR (aucune I/O, aucun état global) : les textes de mode et
 * l'assemblage sont testables sans créer de session SDK.
 */
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AgentMode } from "./model-library.js";

// ── Marqueurs (identiques à l'ancien mécanisme `_baseSystemPrompt`) ──
const MODE_IDENTITY_MARKER = "<!-- PI_IDENTITY -->";
const MODE_BANNER_START = "<!-- PI_MODE_BANNER -->";
const MODE_BANNER_END = "<!-- /PI_MODE_BANNER -->";

/** Identity overrides for each mode — replaces the default "expert coding assistant" paragraph */
const MODE_IDENTITIES: Record<string, string> = {
  code: "",  // Keep default identity for code mode
  harness: "Tu es le chef de projet de Pi-Web. Ton rôle est d'orchestrer les fonctions de routage et d'être l'interface entre l'utilisateur et l'équipe.",
};

const MODE_INSTRUCTIONS: Record<string, string> = {
  code: `General coding rules:
- Do NOT run git push or git push-like commands unless the user explicitly asks you to
- Do NOT commit changes unless the user explicitly asks you to
- When working on files, make minimal targeted changes — avoid rewriting entire files
- Before editing, always read the current file content to understand the existing code
- Prefer using the edit tool for small changes, write tool only for new files or complete rewrites
- When creating new files, follow existing project conventions (naming, structure, style)
- Test your changes mentally — think about edge cases and error paths
- If a change affects multiple files, list all affected files before starting
- Keep commits atomic — one logical change per commit when possible
- Après chaque modification logique de fichiers, appelle le tool log_commit_note avec un résumé concis (1 ligne) de ce que tu as modifié et pourquoi. Cela construit incrémentalement le message de commit.

## Code exploration: prefer graph tools over grep/find/ls
When the project has been indexed by the knowledge graph (cbm_* tools are visible):
- Use **cbm_search** instead of grep/find to find code by name, label, or meaning
- Use **cbm_search_code** instead of grep -r for text/regex searches
- Use **cbm_trace** instead of manually reading files to trace callers/callees
- Use **cbm_code** to get source code of specific symbols
- Use **cbm_arch** to understand the overall project structure
- Use **cbm_diff** to analyze the impact of uncommitted changes

Règles opérationnelles (déclencheurs concrets) :
- AVANT toute 2e lecture du MÊME fichier → **cbm_code** sur le symbole visé.
- AVANT toute recherche de symbole (définition/appelant/appelé) → **cbm_search** ou **cbm_trace**.
- AVANT un grep structurel/récursif → **cbm_search_code**.
- N'utilise read/grep/find/ls que si le graphe ne peut pas répondre (fichier hors
  projet : Dockerfile, entrypoint.sh, config, script non indexé) ou si cbm_* est absent.

These are 100x more token-efficient than file-by-file exploration. Use them when possible.
grep/find/ls are still available as fallback for files outside the project or if cbm_* tools are not available.`,
  harness: `## Mode HARNESS — Chef de Projet

Tu es le chef de projet. Tu discutes avec l'utilisateur et délègues l'exécution aux fonctions de routage.

### Tes responsabilités
- Comprendre la demande de l'utilisateur
- Évaluer la complexité de la tâche
- Choisir la bonne fonction de routage et lui déléguer
- Présenter les résultats à l'utilisateur de façon claire
- Coordonner plusieurs fonctions de routage si nécessaire

### Règles ABSOLUES
- Tu ne codes JAMAIS. Tu ne débugges JAMAIS. Tu ne fais JAMAIS de plan détaillé.
- Tu ne lis JAMAIS le code pour investiguer un bug. L'investigation est le job des fonctions de routage.
- Tu délègues TOUJOURS l'exécution via le tool delegate.
- Tu peux répondre directement aux questions simples (conseils, explications, clarifications).
- Quand l'utilisateur signale un bug, délègue IMMÉDIATEMENT à la fonction appropriée (review pour investiguer, execute pour fixer). Ne fais pas de recherche toi-même.
- Quand tu n'es pas sûr, demande à l'utilisateur.

### Quand déléguer vs répondre directement
- **Réponds directement** : questions simples, conseils, explications, clarifications, synthèse de résultats
- **Délègue** : toute tâche d'exécution (code, debug, review, test, doc, plan)
- **Tâche complexe** : délègue d'abord à la fonction planning pour un plan, puis à la fonction execute
- **Tâche simple** : délègue directement à la fonction execute
- **Relecture / audit** : délègue à la fonction review
- **Synthèse / rapport final** : délègue à la fonction integrate

### Fonctions de routage disponibles
| Fonction | Rôle |
|----------|------|
| planning | Planification, exploration, architecture |
| execute | Implémentation : code, debug, tests, documentation |
| review | Relecture, audit, qualité, sécurité |
| integrate | Synthèse, rapport final, intégration |

### Comment déléguer
Utilise le tool delegate avec :
- function : la fonction à appeler, parmi planning, execute, review, integrate
- task : la tâche précise et auto-contenue
- context : résumé concis et actionnable du contexte pertinent (2-5 phrases) : décisions clés, contraintes, fichiers concernés, ce qui a déjà été fait. Obligatoire dès que la conversation contient du contexte utile.

⚠️ Le tool s'appelle EXACTEMENT \`delegate\` (paramètre \`function\`). \`delegate_to_expert\` n'existe plus : ce nom a été renommé. Si l'historique de la conversation (session reprise) contient d'anciens appels \`delegate_to_expert\`, ignore-les et appelle \`delegate\`.

⚠ La fonction déléguée ne voit PAS la conversation — elle ne lit QUE task + context (+ le code du projet). Rédige TOUJOURS un résumé du contexte dans \`context\` avant de déléguer, même bref (2-3 phrases). Sans cela, la fonction travaille à l'aveugle sur ce qui s'est dit.

### Après une délégation
- Analyse le résultat retourné par la fonction
- Si la fonction signale un problème ou un besoin de clarification -> demande à l'utilisateur
- Si la tâche est terminée -> résume le résultat pour l'utilisateur
- Si tu as besoin d'une autre fonction -> délègue à nouveau`,
};

/**
 * Strip the default Pi identity paragraph from the base prompt so we can replace it.
 * The default starts with "You are an expert coding assistant" and ends before "Available tools:".
 */
export function stripDefaultIdentity(prompt: string): { identity: string; rest: string } {
  const marker = "You are an expert coding assistant";
  const idx = prompt.indexOf(marker);
  if (idx === -1) return { identity: "", rest: prompt };
  // Find the end of the identity paragraph — ends at "Available tools:", "Guidelines:", or double newline
  const afterMarker = prompt.slice(idx);
  const endMatch = afterMarker.match(/\n(?:Available tools:|Guidelines:)/);
  if (endMatch && endMatch.index !== undefined) {
    const endIdx = idx + endMatch.index;
    return {
      identity: prompt.slice(idx, endIdx).trim(),
      rest: prompt.slice(0, idx) + prompt.slice(endIdx),
    };
  }
  // Fallback: identity goes to first double newline
  const doubleNl = afterMarker.indexOf("\n\n");
  if (doubleNl !== -1) {
    const endIdx = idx + doubleNl;
    return {
      identity: prompt.slice(idx, endIdx).trim(),
      rest: prompt.slice(0, idx) + prompt.slice(endIdx),
    };
  }
  return { identity: "", rest: prompt };
}

/**
 * Bannière de mode PROÉMINENTE en tête du prompt système.
 * Le SDK Pi inclut la liste des outils actifs dans son prompt, mais la sortir en
 * tête de prompt garantit que l'agent sait s'il est en mode code (travail direct)
 * ou routing (orchestrateur qui délègue), quel que soit l'ordre des sections.
 */
export function buildModeBanner(mode: AgentMode, tools: string[]): string {
  const toolsList = tools.length > 0 ? tools.join(", ") : "(aucun)";
  return mode === "harness"
    ? `${MODE_BANNER_START}\n## ⚠️ MODE ACTUEL : ROUTING — VOUS ÊTES L'ORCHESTRATEUR\n\nRÈGLE ABSOLUE : déléguez TOUTE tâche d'exécution via le tool \`delegate\` (fonctions : planning, execute, review, integrate). Ne codez JAMAIS vous-même, ne faites JAMAIS de recherche/exploration vous-même — déléguez. Vos outils : ${toolsList}.\n${MODE_BANNER_END}\n\n`
    : `${MODE_BANNER_START}\n## MODE ACTUEL : CODE — travail direct\n\nVous travaillez directement avec vos outils. Le tool \`delegate\` n'est PAS disponible dans ce mode. Vos outils : ${toolsList}.\n${MODE_BANNER_END}\n\n`;
}

/** Contexte par session injecté par le backend dans le prompt système. */
export interface PiWebPromptContext {
  /** Bloc brut `<!-- PI_PROJECT_CONTEXT -->…` (vide si pas de nom de projet). */
  projectContext: string;
  /** Bloc brut `<!-- PI_MEMORY_CONTEXT -->…` (vide si aucune mémoire). */
  memoryContext: string;
  /** Mode courant, relu à chaque run (l'état de session peut changer). */
  getMode: () => AgentMode;
}

/**
 * Assemble le prompt système effectif pour un mode donné.
 *
 * Ordre : bannière de mode (tête) + [identité remplacée] + prompt SDK +
 * [instructions de mode] + contexte projet + mémoire. Fonction pure et
 * déterministe : mêmes entrées → même sortie (stabilité du préfixe pour le cache).
 */
export function buildPiWebSystemPrompt(
  basePrompt: string,
  mode: AgentMode,
  tools: string[],
  context: Pick<PiWebPromptContext, "projectContext" | "memoryContext">,
): string {
  // Nettoyage défensif : retire tout bloc déjà injecté (idempotence si le prompt
  // d'entrée provient déjà d'un handler antérieur).
  let prompt = (basePrompt || "")
    .replace(/\n*<!-- PI_MODE:\w+ -->[\s\S]*?<!-- \/PI_MODE:\w+ -->\n*/g, "\n")
    .replace(/\n*<!-- PI_IDENTITY -->[\s\S]*?<!-- \/PI_IDENTITY -->\n*/g, "\n")
    .replace(/\n*<!-- PI_MODE_BANNER -->[\s\S]*?<!-- \/PI_MODE_BANNER -->\n*/g, "\n")
    .replace(/\n*<!-- PI_PROJECT_CONTEXT -->[\s\S]*?<!-- \/PI_PROJECT_CONTEXT -->\n*/g, "\n")
    .replace(/\n*<!-- PI_MEMORY_CONTEXT -->[\s\S]*?<!-- \/PI_MEMORY_CONTEXT -->\n*/g, "\n")
    .trimEnd();

  // Identité spécifique au mode (remplace l'identité par défaut du SDK).
  const identityOverride = MODE_IDENTITIES[mode] || "";
  if (identityOverride) {
    const { rest } = stripDefaultIdentity(prompt);
    prompt = rest.trimEnd();
    prompt += `\n\n${MODE_IDENTITY_MARKER}\n${identityOverride}\n<!-- /PI_IDENTITY -->\n`;
  }

  // Instructions spécifiques au mode, avec marqueurs (utilisés par la gate de
  // l'extension harness : `<!-- PI_MODE:HARNESS -->`).
  const instructions = MODE_INSTRUCTIONS[mode] || "";
  if (instructions.trim()) {
    const openTag = `<!-- PI_MODE:${mode.toUpperCase()} -->`;
    const closeTag = `<!-- /PI_MODE:${mode.toUpperCase()} -->`;
    prompt += `\n\n${openTag}\n## Current Mode: ${mode.toUpperCase()}\n\n${instructions}\n${closeTag}\n`;
  }

  // Blocs de contexte reconstruits à chaque run : ils incluent leur propre
  // séparateur `\n\n`.
  if (context.projectContext) prompt += context.projectContext;
  if (context.memoryContext) prompt += context.memoryContext;

  // Bannière en TÊTE (toujours visible).
  return buildModeBanner(mode, tools) + prompt.trimStart();
}

/**
 * Crée l'extension INLINE qui remplace le prompt système à chaque run.
 *
 * Le backend n'étant pas une extension fichier, c'est le seul point d'entrée
 * officiel pour poser le prompt : `before_agent_start` (types.d.ts:917-921).
 * Les outils actifs proviennent de `systemPromptOptions.selectedTools` (source de
 * vérité du SDK pour le run courant), pas d'un accès interne.
 */
export function createPromptExtension(
  context: PiWebPromptContext,
  options?: { name?: string; hidden?: boolean },
): InlineExtension {
  const factory = (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event) => {
      try {
        const tools: string[] = event.systemPromptOptions?.selectedTools ?? [];
        const mode = context.getMode();
        return { systemPrompt: buildPiWebSystemPrompt(event.systemPrompt, mode, tools, context) };
      } catch (e: any) {
        // Ne jamais casser un tour à cause du prompt : on laisse le prompt SDK.
        console.warn(`[system-prompt] build failed: ${e?.message || e}`);
        return undefined;
      }
    });
  };
  return {
    name: options?.name ?? "pi-web-system-prompt",
    factory,
    hidden: options?.hidden ?? true,
  };
}
