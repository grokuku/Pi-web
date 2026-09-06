import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "../../../i18n";

// ── Docker Hub — compte pour les docker pull / compose pull du container ──
// Évite l'erreur « toomanyrequests: unauthenticated pull rate limit ». Pattern
// clés API masquées : le token n'est jamais renvoyé par l'API et le champ
// reste vide au chargement (jamais pré-rempli).
interface DockerHubStatusData {
  configured: boolean;
  username: string | null;
}

function DockerHubSection() {
  const { t } = useTranslation();
  const [dhUsername, setDhUsername] = useState("");
  const [dhToken, setDhToken] = useState(""); // jamais pré-rempli (token jamais renvoyé)
  const [dhStatus, setDhStatus] = useState<DockerHubStatusData | null>(null);
  const [dhSaving, setDhSaving] = useState(false);
  const [dhSaved, setDhSaved] = useState(false);
  const [dhError, setDhError] = useState("");

  // État courant lu au chargement du modal : configured + username uniquement.
  const loadDockerHubStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/dockerhub");
      if (res.ok) setDhStatus(await res.json());
    } catch {}
  }, []);

  useEffect(() => { loadDockerHubStatus(); }, [loadDockerHubStatus]);

  const connectDockerHub = async () => {
    if (dhSaving || !dhUsername.trim() || !dhToken.trim()) return;
    setDhSaving(true);
    setDhError("");
    try {
      const res = await fetch("/api/settings/dockerhub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: dhUsername.trim(), token: dhToken }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        // details = sortie docker (sans token) renvoyée par le backend.
        throw new Error(data.details ? `${t("settings.dockerhub.error")} (${data.details})` : t("settings.dockerhub.error"));
      }
      setDhStatus({ configured: true, username: data.username });
      setDhToken(""); // le token n'est jamais conservé dans l'état du formulaire
      setDhSaved(true);
      setTimeout(() => setDhSaved(false), 2000);
    } catch (e: any) {
      setDhError(e.message);
    } finally {
      setDhSaving(false);
    }
  };

  return (
    <div className="border border-hacker-border rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-xs font-bold text-hacker-text-bright flex items-center gap-1.5">
            <span>🐳</span> {t("settings.dockerhub.title")}
          </div>
        </div>
      </div>

      {/* État courant (GET au chargement) */}
      <div className="mb-2 text-[11px]">
        {dhStatus?.configured && dhStatus.username ? (
          <span className="text-green-400">{t("settings.dockerhub.connectedAs", dhStatus.username)}</span>
        ) : (
          <span className="text-hacker-warn">{t("settings.dockerhub.notConfigured")}</span>
        )}
      </div>

      {dhError && (
        <div className="text-hacker-error text-[11px] border border-hacker-error/30 p-2 mb-2">
          {dhError}
          <button onClick={() => setDhError("")} className="ml-2 text-hacker-text-dim hover:text-hacker-error">✕</button>
        </div>
      )}

      <div className="space-y-2">
        <div>
          <label className="text-hacker-text-dim text-xs block mb-1">{t("settings.dockerhub.username")}</label>
          <input
            type="text"
            value={dhUsername}
            onChange={e => setDhUsername(e.target.value)}
            placeholder="username"
            className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-3 py-1.5 rounded focus:border-hacker-accent outline-none"
          />
        </div>
        <div>
          <label className="text-hacker-text-dim text-xs block mb-1">{t("settings.dockerhub.token")}</label>
          <input
            type="password"
            value={dhToken}
            onChange={e => setDhToken(e.target.value)}
            onKeyDown={e => e.key === "Enter" && connectDockerHub()}
            placeholder="dckr_pat_••••••••"
            className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-3 py-1.5 rounded focus:border-hacker-accent outline-none"
          />
        </div>
        <div className="flex items-center justify-between">
          <div className="text-[10px] text-hacker-text-dim">
            {t("settings.dockerhub.tokenHint")}{" "}
            <a href="https://hub.docker.com/settings/security" target="_blank" rel="noopener noreferrer" className="text-hacker-accent hover:underline">hub.docker.com</a>
          </div>
          <button
            onClick={connectDockerHub}
            disabled={dhSaving || !dhUsername.trim() || !dhToken.trim()}
            className={`btn-hacker text-xs px-4 py-1.5 disabled:opacity-30 ${dhSaved ? "text-hacker-accent border-hacker-accent" : ""}`}
          >
            {dhSaved ? t("settings.dockerhub.saved") : t("settings.dockerhub.connect")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default DockerHubSection;
