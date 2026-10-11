import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "../../../i18n";
import { toast } from "../../../utils/holaf-toast";

// ── Libry — service libraire : réglages + interrupteur du libraire ────
// Pi-Web est CLIENT du service Libry (documents + recherche web + capture).
// Ce bloc reprend le contrat exact des blocs WebClaw/Tavily de SettingsModal :
//  - GET/POST /api/settings/libry, la clé n'est JAMAIS réaffichée en clair
//    (champ vide au chargement, champ vide = clé conservée au save) ;
//  - la réponse du POST est appliquée telle quelle (pas d'état optimiste faux).
//
// Interrupteur `librarian.backend` (défaut "local" = libraire interne de
// Pi-Web, comportement inchangé) : "libry" fait passer les outils du libraire
// (librarian_search, librarian_archive) et l'entretien automatique par le
// service Libry. Côté serveur la valeur est relue à chaud (aucun cache) :
// la bascule s'applique sans redémarrage, et est réversible à tout moment.

type LibrarianBackend = "local" | "libry";

interface LibryPublicConfig {
  url: string;
  hasApiKey: boolean;
  apiKeyPreview: string;
  librarianBackend: LibrarianBackend;
  urlFromEnv: boolean;
  apiKeyFromEnv: boolean;
  backendFromEnv: boolean;
}

/** Valeur inconnue → "local" (même normalisation que le backend). */
function normalizeBackend(value: unknown): LibrarianBackend {
  return value === "libry" ? "libry" : "local";
}

function LibrySection() {
  const { t } = useTranslation();

  // Formulaire
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [backend, setBackend] = useState<LibrarianBackend>("local");

  // Vue serveur (clé en clair jamais renvoyée : hasApiKey + aperçu masqué)
  const [hasApiKey, setHasApiKey] = useState(false);
  const [keyPreview, setKeyPreview] = useState("");
  const [activeBackend, setActiveBackend] = useState<LibrarianBackend>("local");
  const [envManaged, setEnvManaged] = useState({ url: false, apiKey: false, backend: false });

  const applyResponse = useCallback((data: LibryPublicConfig) => {
    setUrl(data.url || "");
    setApiKey(""); // clé jamais renvoyée : champ vide = inchangée au save
    setHasApiKey(!!data.hasApiKey);
    setKeyPreview(data.apiKeyPreview || "");
    const effective = normalizeBackend(data.librarianBackend);
    setBackend(effective);
    setActiveBackend(effective);
    setEnvManaged({
      url: !!data.urlFromEnv,
      apiKey: !!data.apiKeyFromEnv,
      backend: !!data.backendFromEnv,
    });
  }, []);

  const loadLibryConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/libry");
      if (res.ok) applyResponse(await res.json());
    } catch {}
  }, [applyResponse]);

  const saveLibryConfig = async () => {
    try {
      const res = await fetch("/api/settings/libry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // apiKey omis si le champ est vide → le backend garde la clé existante
        body: JSON.stringify({
          url,
          librarianBackend: backend,
          ...(apiKey ? { apiKey } : {}),
        }),
      });
      if (res.ok) {
        applyResponse(await res.json());
        toast(t("common.saved"), "success");
      } else {
        toast(t("settings.general.libry.saveError"), "error");
      }
    } catch (e: any) {
      console.error("[libry] Failed to save:", e);
      toast(t("settings.general.libry.saveError"), "error");
    }
  };

  useEffect(() => { loadLibryConfig(); }, [loadLibryConfig]);

  return (
    <div className="border border-hacker-border rounded p-3" data-testid="libry-section">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-xs font-bold text-hacker-text-bright flex items-center gap-1.5">
            <span>📚</span> {t("settings.general.libry.title")}
          </div>
          <div className="text-[10px] text-hacker-text-dim mt-0.5">
            {t("settings.general.libry.description")}
          </div>
        </div>
      </div>
      <div className="space-y-2">
        {/* Interrupteur librarian.backend — défaut « local » (aucun risque) */}
        <div>
          <label className="text-hacker-text-dim text-xs block mb-1">
            {t("settings.general.libry.backendLabel")}
          </label>
          <div className="flex gap-1">
            {(["local", "libry"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setBackend(mode)}
                aria-pressed={backend === mode}
                data-testid={`libry-backend-${mode}`}
                className={`text-xs px-3 py-1.5 rounded border transition-colors ${
                  backend === mode
                    ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                    : "border-hacker-border text-hacker-text-dim hover:text-hacker-text"
                }`}
              >
                {mode === "local"
                  ? t("settings.general.libry.backendLocal")
                  : t("settings.general.libry.backendLibry")}
              </button>
            ))}
          </div>
          <div className="text-[10px] text-hacker-text-dim mt-1" data-testid="libry-active-backend">
            {t(
              "settings.general.libry.activeBackend",
              activeBackend === "libry"
                ? t("settings.general.libry.backendLibry")
                : t("settings.general.libry.backendLocal"),
            )}
          </div>
          {envManaged.backend && (
            <div className="text-[10px] text-yellow-400 mt-0.5">
              {t("settings.general.libry.envManaged")}
            </div>
          )}
          <div className="text-[10px] text-hacker-text-dim mt-1">
            {t("settings.general.libry.backendHint")}
          </div>
        </div>

        {/* URL du service */}
        <div>
          <label className="text-hacker-text-dim text-xs block mb-1">
            {t("settings.general.libry.urlLabel")}
          </label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://libry:3007"
            data-testid="libry-url"
            className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-3 py-1.5 rounded focus:border-hacker-accent outline-none"
          />
          {envManaged.url && (
            <div className="text-[10px] text-yellow-400 mt-0.5">
              {t("settings.general.libry.envManaged")}
            </div>
          )}
        </div>

        {/* Clé API — jamais réaffichée en clair (aperçu masqué uniquement) */}
        <div>
          <label className="text-hacker-text-dim text-xs block mb-1">
            {t("settings.general.libry.apiKeyLabel")}
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasApiKey ? keyPreview : "••••••••"}
            data-testid="libry-api-key"
            className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-3 py-1.5 rounded focus:border-hacker-accent outline-none"
          />
          <div className="text-[10px] text-hacker-text-dim mt-0.5">
            {t("settings.general.libry.apiKeyHint")}
          </div>
          {envManaged.apiKey && (
            <div className="text-[10px] text-yellow-400 mt-0.5">
              {t("settings.general.libry.envManaged")}
            </div>
          )}
        </div>

        <button onClick={saveLibryConfig} className="btn-hacker text-xs px-4 py-1.5">
          {t("settings.general.libry.save")}
        </button>
      </div>
    </div>
  );
}

export default LibrySection;
