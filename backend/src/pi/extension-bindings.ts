/**
 * extension-bindings.ts — branchement des extensions du SDK dans une session Pi-Web.
 *
 * POURQUOI CE MODULE EXISTE
 * -------------------------
 * Le SDK `@earendil-works/pi-coding-agent` n'émet l'événement `session_start`
 * QUE depuis `AgentSession.bindExtensions()` (dist/core/agent-session.js :
 * `await this._extensionRunner.emit(this._sessionStartEvent)` est DANS
 * `bindExtensions`). Pi-Web n'appelait jamais cette méthode : aucun handler
 * `session_start` ne tournait, et l'extension MCP du SDK — qui connecte ses
 * serveurs sur `session_start` — ne pouvait donc JAMAIS se connecter.
 *
 * Les modes du SDK (modes/print-mode.js, modes/rpc/rpc-mode.js,
 * modes/interactive/interactive-mode.js) appellent tous `bindExtensions(...)`
 * juste après la création de session ; on copie leur forme d'appel.
 *
 * GARANTIES
 * ---------
 * 1. Un handler de n'importe quel événement qui LÈVE est intercepté par
 *    l'`ExtensionRunner` du SDK (`emit` → try/catch handler par handler, puis
 *    `emitError`) : il n'empêche jamais la session de démarrer. Le try/catch
 *    local couvre ce qui reste hors `emit` (ex. `resources_discover`).
 * 2. `onError` est OBLIGATOIRE : sans listener, `emitError` n'écrit RIEN
 *    (dist/core/extensions/runner.js) → échec silencieux, interdit ici.
 * 3. `uiContext` « log seulement » : Pi-Web n'a pas de TUI, mais le SDK
 *    rapporte les problèmes MCP (serveur en échec, config invalide, sign-in
 *    requise) UNIQUEMENT via `ctx.ui.notify`. Sans uiContext, le SDK substitue
 *    `noOpUIContext` (`notify: () => {}`) et ces messages seraient perdus :
 *    on fournit donc un `notify` qui écrit dans les logs Pi-Web, le reste
 *    étant des no-op (aucune UI interactive n'est pilotée depuis le backend).
 */
import { createMcpExtension } from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  ExtensionUIContext,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { createPromptExtension, type PiWebPromptContext } from "./system-prompt.js";

/** Signature EXACTE de `bindExtensions` (le type n'est pas exporté par le paquet). */
export type ExtensionBindings = Parameters<AgentSession["bindExtensions"]>[0];

/** Tout ce dont le branchement a besoin : un objet qui sait lier des extensions. */
export type BindableSession = Pick<AgentSession, "bindExtensions">;

/**
 * Extensions INLINE fournies au `DefaultResourceLoader` de la session.
 *
 * - `createPromptExtension` : prompt système Pi-Web (contexte projet + mémoire
 *   + bannière de mode) via `before_agent_start`, et garde-fou git `tool_call`.
 * - `createMcpExtension` : intégration MCP du SDK (serveurs de
 *   `~/.pi/agent/mcp.json` et, projet approuvé, `.pi/mcp.json`). Elle s'enregistre
 *   au chargement mais ne CONNECTE ses serveurs qu'au `session_start` — d'où
 *   l'appel à `bindPiWebExtensions` après la création de session.
 */
export function createPiWebExtensionFactories(promptContext: PiWebPromptContext): InlineExtension[] {
  return [createPromptExtension(promptContext), createMcpExtension()];
}

/**
 * Contexte UI minimal : `notify` journalise, tout le reste est un no-op.
 *
 * L'objet est EXPLICITE (pas un Proxy) : `_applyExtensionBindings` recopie le
 * contexte via un spread (`wrapUIPromptContext`), un Proxy ne survivrait pas.
 */
export function createLogOnlyUIContext(
  log: (level: "info" | "warning" | "error", message: string) => void = defaultUILog,
): ExtensionUIContext {
  const noop = () => undefined;
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: (message: string, type?: "info" | "warning" | "error") => {
      log(type ?? "info", message);
    },
    onTerminalInput: () => () => {},
    setStatus: noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setWidget: noop,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    custom: async () => undefined,
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: () => undefined,
    // Aucune session TUI : ni thème ni éditeur ne sont jamais utilisés ici.
    theme: undefined as unknown as ExtensionUIContext["theme"],
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "UI not available" }),
    getToolsExpanded: () => false,
    setToolsExpanded: noop,
  } as unknown as ExtensionUIContext;
}

function defaultUILog(level: "info" | "warning" | "error", message: string): void {
  const line = `[PiSession][ui-notify] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warning") console.warn(line);
  else console.log(line);
}

/**
 * Lie les extensions à la session — ÉMET `session_start` (donc `resources_discover`).
 *
 * Appelée UNE fois, après `createAgentSession`. Ne lève jamais : un échec du
 * branchement est journalisé et la session reste utilisable.
 */
export async function bindPiWebExtensions(session: BindableSession, label: string): Promise<void> {
  try {
    await session.bindExtensions({
      mode: "print",
      uiContext: createLogOnlyUIContext(),
      onError: (err) => {
        console.error(
          `[PiSession] Extension error (${err.extensionPath} — ${err.event}) : ${err.error}`,
        );
        if (err.stack) console.error(err.stack);
      },
    });
    console.log(`[PiSession] Extensions bound (session_start emitted) for ${label}`);
  } catch (e: any) {
    console.error(`[PiSession] bindExtensions failed (${label}) : ${e?.message || e}`);
  }
}
