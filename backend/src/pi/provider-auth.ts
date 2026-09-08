/**
 * Sentinelle d'authentification pour les providers enregistrés dans le runtime Pi.
 *
 * ── Pourquoi une sentinelle ? ──
 * Le SDK Pi (@earendil-works/pi-coding-agent 0.85.1) exige une clé API configurée
 * pour chaque provider avant tout setModel/completions :
 *   - `ModelRuntime.checkAuth(providerId)` retourne `undefined` si le provider
 *     n'a aucune méthode d'auth (composeApiKeyAuth → undefined quand ni clé
 *     statique, ni héritage, ni oauth) → la composition du provider échoue
 *     (« no authentication method configured ») et le provider est RETIRÉ du runtime.
 *   - `session.setModel(model)` throw alors « No API key for provider_x/model ».
 *
 * Or les serveurs LOCAUX (ollama, llama.cpp server, LM Studio…) ignorent
 * totalement la clé API : n'importe quelle valeur non vide fait passer le
 * checkAuth du SDK, et la requête part sans auth réelle. La sentinelle "ollama"
 * est donc une valeur factice inoffensive, adoptée comme convention dans tout
 * le projet (voir extensions/harness-orchestrator/index.ts, même convention).
 *
 * Sans elle : un provider openai-compatible sans clé (cas llama.cpp) écrit dans
 * models.json SANS champ apiKey fait échouer la composition du provider à chaque
 * reload du registre → « No API key for provider_x/qwen3.8-flash-next » au
 * sendPrompt suivant (mode HARNESS notamment).
 *
 * Convention de clé partagée par TOUS les chemins d'enregistrement :
 *   1. writeModelsJson (sync-providers.ts) — models.json, rechargé au boot et
 *      après chaque sync (delete provider, add/remove modèle…).
 *   2. registerProvider dynamique (session.ts, applyModelAndThinking).
 *   3. ré-enregistrement dans les tempSessions (extensions/harness-orchestrator,
 *      copie de la convention — ne peut pas importer ce module).
 */

/** Valeur sentinelle posée quand un provider n'a pas de clé API stockée. */
export const LOCAL_PROVIDER_API_KEY_FALLBACK = "ollama";

/**
 * Retourne la clé API à enregistrer pour un provider : la clé existante si
 * présente, sinon la sentinelle "ollama" (inoffensive pour les serveurs locaux,
 * indispensable pour que le SDK compose le provider et laisse setModel passer).
 */
export function resolveProviderApiKey(existingApiKey: string | undefined | null): string {
  return existingApiKey || LOCAL_PROVIDER_API_KEY_FALLBACK;
}