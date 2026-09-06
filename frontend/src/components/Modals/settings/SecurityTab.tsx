import { useState, useCallback, useEffect } from "react";
import { Shield, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "../../../i18n";

// ── Security Tab ──────────────────────────────────────

// État renvoyé par GET/PUT /api/settings/allowed-origins.
interface AllowedOriginsData {
  origins: string[];
  effectiveOrigins: string[];
  allowAll: boolean;
  sources: string[];
}

function SecurityTab() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [origins, setOrigins] = useState<string[]>([]);
  const [effective, setEffective] = useState<AllowedOriginsData | null>(null);

  const loadOrigins = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch("/api/settings/allowed-origins");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: AllowedOriginsData = await res.json();
      setOrigins(data.origins || []);
      setEffective(data);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadOrigins(); }, [loadOrigins]);

  const updateOrigin = (index: number, value: string) =>
    setOrigins(prev => prev.map((o, i) => (i === index ? value : o)));
  const removeOrigin = (index: number) =>
    setOrigins(prev => prev.filter((_, i) => i !== index));
  const addOrigin = () => setOrigins(prev => [...prev, ""]);

  const saveOrigins = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/settings/allowed-origins", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origins: origins.map(o => o.trim()).filter(Boolean) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.error === "invalid_origin_list" && Array.isArray(data.details)) {
          // Entrées invalides remontées par le backend → message localisé.
          const bad = data.details
            .map((d: any) => t("settings.security.origins.invalidOrigin", String(d.origin)))
            .join(" · ");
          throw new Error(`${t("settings.security.origins.saveError")} — ${bad}`);
        }
        throw new Error(data.error || t("settings.security.origins.saveError"));
      }
      setOrigins(data.origins || []);
      setEffective(data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  // Libellé localisé de la source de la valeur effective (env / UI / union).
  const sourceLabel = (sources: string[] | undefined): string => {
    const hasEnv = !!sources?.includes("env");
    const hasUi = !!sources?.includes("ui");
    if (hasEnv && hasUi) return t("settings.security.origins.sourceEnvUi");
    if (hasEnv) return t("settings.security.origins.sourceEnv");
    if (hasUi) return t("settings.security.origins.sourceUi");
    return t("settings.security.origins.sourceDefault");
  };

  return (
    <div className="p-3 space-y-4">
      <div className="border border-hacker-border bg-hacker-surface/50">
        <div className="px-3 py-2 border-b border-hacker-border bg-hacker-bg/50 flex items-center gap-2">
          <Shield size={14} className="text-hacker-accent" />
          <span className="text-xs font-bold text-hacker-accent tracking-wider">{t('settings.security.origins.title')}</span>
        </div>
        <div className="p-3 space-y-3">
          <p className="text-[11px] text-hacker-text-dim">
            {t('settings.security.origins.description')}
          </p>

          {loading ? (
            <div className="text-xs text-hacker-text-dim py-2">{t('settings.security.origins.loading')}</div>
          ) : loadError ? (
            <div className="text-xs text-hacker-error py-2">{t('settings.security.origins.loadError')}</div>
          ) : (
            <>
              {/* Liste éditable d'origines */}
              <div className="space-y-1.5">
                {origins.map((o, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <input
                      type="text"
                      value={o}
                      onChange={e => updateOrigin(i, e.target.value)}
                      onKeyDown={e => e.key === "Enter" && saveOrigins()}
                      placeholder="https://pi.example.com"
                      spellCheck={false}
                      className="input-hacker flex-1 text-xs py-1.5 px-2 font-mono"
                    />
                    <button
                      onClick={() => removeOrigin(i)}
                      className="text-hacker-text-dim hover:text-hacker-error shrink-0"
                      title={t('settings.security.origins.remove')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>

              <button onClick={addOrigin} className="btn-hacker text-xs px-3 py-1.5 flex items-center gap-1">
                <Plus size={12} /> {t('settings.security.origins.add')}
              </button>

              {error && (
                <div className="text-hacker-error text-[11px] border border-hacker-error/30 p-2">
                  {error}
                  <button onClick={() => setError("")} className="ml-2 text-hacker-text-dim hover:text-hacker-error">✕</button>
                </div>
              )}

              <div className="flex items-center justify-between pt-1">
                <button
                  onClick={saveOrigins}
                  disabled={saving}
                  className={`btn-hacker text-xs px-4 py-1.5 disabled:opacity-30 ${saved ? "text-hacker-accent border-hacker-accent" : ""}`}
                >
                  {saving ? t('settings.security.origins.saving') : saved ? t('settings.security.origins.saved') : t('settings.security.origins.save')}
                </button>
                <span className="text-[10px] text-hacker-text-dim">{t('settings.security.origins.wildcardHint')}</span>
              </div>

              {/* Valeur effective + source (lecture seule) */}
              {effective && (
                <div className="text-[10px] text-hacker-text-dim space-y-1 mt-2 pt-2 border-t border-hacker-border/30">
                  <div className="flex items-baseline gap-1">
                    <span className="shrink-0">{t('settings.security.origins.effectiveValue')} :</span>
                    <code className="text-hacker-accent break-all">
                      {effective.allowAll ? "*" : (effective.effectiveOrigins.join(", ") || "—")}
                    </code>
                  </div>
                  <div>{t('settings.security.origins.source')} : {sourceLabel(effective.sources)}</div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default SecurityTab;
