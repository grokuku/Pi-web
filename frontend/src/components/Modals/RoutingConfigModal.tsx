import { useState } from "react";
import { HolafIcon } from "../icons/HolafIcon";
import { ModalDialog } from "../common/ModalDialog";
import {
  DEFAULT_ROUTING_CONFIG,
  DEFAULT_SYSTEM_ONE_CONFIDENCE_THRESHOLD,
  THINKING_LEVELS,
  thinkingLevelsForModel,
  clampThinkingLevel,
  type CategoryConfig,
  type ProviderConfig,
  type RegisteredModel,
  type RoutingConfig,
  type TaskCategory,
  type ThinkingLevel,
} from "../../types";
import { useTranslation, type TFunction } from "../../i18n";
import { toast } from "../../utils/holaf-toast";

interface Props {
  onClose: () => void;
  onSave: (routing: RoutingConfig) => Promise<void>;
  models: RegisteredModel[];
  providers: ProviderConfig[];
  config: RoutingConfig | null;
}

// ── Métadonnées d'affichage des 4 catégories de routage ──
const CATEGORIES: {
  id: TaskCategory;
  emoji: string;
  label: string;
  description: string;
  hint: string;
}[] = [
  {
    id: "trivial",
    emoji: "⚡",
    label: "Trivial",
    description: "Rapide",
    hint: "Tâches rapides et à faible risque : renommage, formatage, documentation.",
  },
  {
    id: "standard",
    emoji: "🔧",
    label: "Standard",
    description: "Exécution",
    hint: "Tâches classiques de développement : implémentation, corrections simples.",
  },
  {
    id: "complex",
    emoji: "🧠",
    label: "Complexe",
    description: "Plan",
    hint: "Planification et architecture : exploration, refactor, migrations.",
  },
  {
    id: "review",
    emoji: "👁",
    label: "Relecture",
    description: "Gate",
    hint: "Gate de relecture : vérifie le travail avant intégration.",
  },
];

/** Sélecteur de modèle réutilisable (dropdown simple, option « défaut » incluse). */
function ModelSelect({
  value,
  onChange,
  models,
  providers,
  noneLabel,
  disabled = false,
  ariaLabel,
}: {
  value: string | null;
  onChange: (modelId: string | null) => void;
  models: RegisteredModel[];
  providers: ProviderConfig[];
  noneLabel: string;
  disabled?: boolean;
  /** Libellé accessible (le `<label>` visuel n'est pas rattaché par `htmlFor`). */
  ariaLabel?: string;
}) {
  const sortedModels = [...models].sort((a, b) => a.name.localeCompare(b.name));

  const getProviderName = (providerId: string): string => {
    const p = providers.find(p => p.id === providerId);
    return p?.name || p?.type || providerId;
  };

  return (
    <select
      value={value || ""}
      onChange={e => onChange(e.target.value || null)}
      disabled={disabled}
      aria-label={ariaLabel}
      className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-[11px] px-2 py-1.5 rounded focus:border-hacker-accent outline-none disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <option value="">{noneLabel}</option>
      {sortedModels.map(m => (
        <option key={m.id} value={m.id}>
          {m.name} ({getProviderName(m.providerId)})
        </option>
      ))}
    </select>
  );
}

/**
 * Sélecteur de NIVEAU DE RÉFLEXION (reasoning effort) réutilisable.
 * Option « défaut » incluse : signifie « garder le niveau de réflexion du mode ».
 * Native <select> → navigable au clavier (flèches + Entrée).
 */
function ThinkingSelect({
  value,
  onChange,
  defaultLabel,
  ariaLabel,
  levels,
  t,
}: {
  value: ThinkingLevel | null;
  onChange: (level: ThinkingLevel | null) => void;
  defaultLabel: string;
  ariaLabel: string;
  /** Niveaux réellement proposables pour le modèle de la catégorie. */
  levels: readonly ThinkingLevel[];
  t: TFunction;
}) {
  return (
    <select
      value={value || ""}
      onChange={e => onChange((e.target.value || null) as ThinkingLevel | null)}
      aria-label={ariaLabel}
      title={ariaLabel}
      className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-[11px] px-2 py-1.5 rounded focus:border-hacker-accent outline-none"
    >
      <option value="">{defaultLabel}</option>
      {levels.map(level => (
        <option key={level} value={level}>
          {t(`routingModal.thinkingLevels.${level}`)}
        </option>
      ))}
    </select>
  );
}

/**
 * Ramène un seuil de confiance à une valeur sûre : non numérique, `NaN`,
 * infini ou hors [0, 1] → `fallback` (jamais d'exception). Même règle que le
 * backend (`normalizeConfidenceThreshold`).
 */
function normalizeThreshold(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0 || value > 1) return fallback;
  return value;
}

export function RoutingConfigModal({ onClose, onSave, models, providers, config }: Props) {
  const { t } = useTranslation();
  // Conserve le thinkingLevel existant s'il est présent (rétro-compatibilité :
  // une config historique sans thinkingLevel reste valide = défaut du mode).
  const initCategory = (c: TaskCategory): CategoryConfig => {
    const existing = config?.[c];
    return {
      modelId: existing?.modelId ?? DEFAULT_ROUTING_CONFIG[c].modelId,
      ...(existing?.thinkingLevel ? { thinkingLevel: existing.thinkingLevel } : {}),
    };
  };
  const [routing, setRouting] = useState<RoutingConfig>(() => ({
    enabled: config?.enabled ?? true,
    trivial: initCategory("trivial"),
    standard: initCategory("standard"),
    complex: initCategory("complex"),
    review: initCategory("review"),
    reviewRiskThreshold: config?.reviewRiskThreshold ?? DEFAULT_ROUTING_CONFIG.reviewRiskThreshold,
    confidenceThreshold: config?.confidenceThreshold ?? DEFAULT_ROUTING_CONFIG.confidenceThreshold,
    // Seuil PROPRE au classifieur System One (défaut 0,35). Une config
    // enregistrée avant ce champ récupère le défaut (migration douce) ; une
    // valeur hors [0,1] est ramenée au défaut.
    systemOneConfidenceThreshold: normalizeThreshold(
      config?.systemOneConfidenceThreshold,
      DEFAULT_SYSTEM_ONE_CONFIDENCE_THRESHOLD,
    ),
    classifierModelId: config?.classifierModelId ?? DEFAULT_ROUTING_CONFIG.classifierModelId,
    // Rétro-compatibilité : une config enregistrée avant l'arrivée de System One
    // n'a pas ces champs → classifieur `chat`, aucun modèle System One.
    classifierType: config?.classifierType === "system-one" ? "system-one" : "chat",
    systemOneModelId: config?.systemOneModelId ?? null,
  }));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const updateCategoryModel = (category: TaskCategory, modelId: string | null) => {
    setRouting(prev => {
      const next: CategoryConfig = { ...prev[category], modelId } as CategoryConfig;
      // Le modèle change : un niveau enregistré devenu indisponible est ramené
      // au « défaut » (clamp) plutôt que de rester affiché/soumis.
      const clamped = clampThinkingLevel(next.thinkingLevel, levelsForModelId(modelId));
      if (clamped) next.thinkingLevel = clamped;
      else delete next.thinkingLevel;
      return { ...prev, [category]: next };
    });
  };

  const updateCategoryThinking = (category: TaskCategory, level: ThinkingLevel | null) => {
    setRouting(prev => {
      const next: CategoryConfig = { ...prev[category] };
      if (level) next.thinkingLevel = level;
      else delete next.thinkingLevel;
      return { ...prev, [category]: next };
    });
  };

  /** Libellé du modèle de la catégorie (nom lisible ou « défaut »). */
  const modelLabelFor = (category: TaskCategory): string => {
    const id = routing[category].modelId;
    if (!id) return t("routingModal.summaryModelDefault");
    return models.find(m => m.id === id)?.name || id;
  };

  /**
   * Niveaux de réflexion PROPOSABLES pour un modèle donné. Source de vérité :
   * `thinkingLevelsForModel` (niveaux déclarés par le provider). Catégorie sur
   * « défaut » (modèle non déterminé) ou modèle introuvable → repli sur TOUS les
   * niveaux : on conserve le comportement historique.
   */
  const levelsForModelId = (modelId: string | null): readonly ThinkingLevel[] => {
    if (!modelId) return THINKING_LEVELS;
    const m = models.find(mm => mm.id === modelId);
    return m ? thinkingLevelsForModel(m) : THINKING_LEVELS;
  };

  const levelsForCategory = (category: TaskCategory): readonly ThinkingLevel[] =>
    levelsForModelId(routing[category].modelId);

  /** Résumé lisible de la catégorie : « <modèle> · réflexion <niveau> ». */
  const categorySummary = (category: TaskCategory): string => {
    const modelLabel = modelLabelFor(category);
    const level = routing[category].thinkingLevel;
    if (!level) return t("routingModal.summaryDefaultThinking", modelLabel);
    return t("routingModal.summaryWithThinking", modelLabel, t(`routingModal.thinkingLevels.${level}`));
  };

  const handleSave = async () => {
    setLoading(true);
    setError("");
    try {
      await onSave(routing);
      toast("Routage enregistré", "success");
    } catch (e: any) {
      setError(e?.message || "Échec de l'enregistrement du routage");
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalDialog id="routing-config" onClose={onClose}>
      <div className="p-4 space-y-4 max-w-lg">
        {/* En-tête */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-hacker-accent text-sm font-bold tracking-wider flex items-center gap-2">
              🧭 CONFIGURATION DU ROUTAGE
            </span>
          </div>
          <button onClick={onClose} className="text-hacker-text-dim hover:text-hacker-error">
            <HolafIcon name="x" size={16} />
          </button>
        </div>

        <p className="text-[11px] text-hacker-text-dim">
          Le routage remplace l'ancienne équipe d'experts par 4 catégories de tâches.
          Chaque catégorie peut utiliser un modèle spécifique et un niveau de réflexion
          propre ; laisse « défaut » pour utiliser le modèle ou le niveau de réflexion du
          mode.
        </p>

        <div>
        {/* Catégories */}
        <div className="space-y-2">
          {CATEGORIES.map(cat => (
            <div
              key={cat.id}
              className="border border-hacker-border bg-hacker-surface/30 rounded p-3"
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-sm">{cat.emoji}</span>
                <span className="text-xs font-bold text-hacker-text-bright">{cat.label}</span>
                <span className="text-[10px] text-hacker-text-dim">{cat.description}</span>
                {/* Résumé lisible : modèle · niveau de réflexion */}
                <span
                  className="ml-auto text-[10px] text-hacker-accent font-mono truncate max-w-[55%]"
                  title={categorySummary(cat.id)}
                >
                  {categorySummary(cat.id)}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <ModelSelect
                  value={routing[cat.id].modelId}
                  onChange={modelId => updateCategoryModel(cat.id, modelId)}
                  models={models}
                  providers={providers}
                  noneLabel="— Défaut (modèle par défaut) —"
                  disabled={false}
                />
                <ThinkingSelect
                  value={clampThinkingLevel(routing[cat.id].thinkingLevel, levelsForCategory(cat.id))}
                  onChange={level => updateCategoryThinking(cat.id, level)}
                  defaultLabel={t("routingModal.thinkingDefaultOption")}
                  ariaLabel={`${t("routingModal.thinkingLabel")} — ${cat.label}`}
                  levels={levelsForCategory(cat.id)}
                  t={t}
                />
              </div>
              <p className="text-[10px] text-hacker-text-dim mt-1.5 leading-relaxed">{cat.hint}</p>
            </div>
          ))}
        </div>

        {/* Seuils */}
        <div className="border-t border-hacker-border/30 pt-3 space-y-4">
          <div>
            <label className="text-hacker-text-dim text-xs block mb-1 flex justify-between">
              <span>⚠ Seuil de risque (review)</span>
              <span className="text-hacker-accent font-mono">
                {(routing.reviewRiskThreshold * 100).toFixed(0)}%
              </span>
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={routing.reviewRiskThreshold}
              onChange={e => setRouting(prev => ({ ...prev, reviewRiskThreshold: Number(e.target.value) }))}
              disabled={false}
              className="w-full accent-hacker-accent"
            />
            <div className="flex justify-between text-[9px] text-hacker-text-dim">
              <span>0% (jamais)</span>
              <span>100% (toujours)</span>
            </div>
            <p className="text-[10px] text-hacker-text-dim mt-1">
              Au-delà de ce score de risque, la tâche est forcée en relecture.
            </p>
          </div>

          {/* Seuil du classifieur CHAT : masqué quand System One est choisi
              (il a le sien, juste en dessous du modèle de décision). */}
          {routing.classifierType !== "system-one" && (
          <div>
            <label className="text-hacker-text-dim text-xs block mb-1 flex justify-between">
              <span>🎯 Confiance minimale</span>
              <span className="text-hacker-accent font-mono">
                {(routing.confidenceThreshold * 100).toFixed(0)}%
              </span>
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={routing.confidenceThreshold}
              onChange={e => setRouting(prev => ({ ...prev, confidenceThreshold: Number(e.target.value) }))}
              disabled={false}
              className="w-full accent-hacker-accent"
            />
            <div className="flex justify-between text-[9px] text-hacker-text-dim">
              <span>0% (permissif)</span>
              <span>100% (strict)</span>
            </div>
            <p className="text-[10px] text-hacker-text-dim mt-1">
              Confiance minimale pour accepter une décision de triage (sinon repli standard).
            </p>
          </div>
          )}
        </div>

        {/* Classifieur optionnel */}
        <div className="border-t border-hacker-border/30 pt-3">
          <label className="text-hacker-text-dim text-xs block mb-1">
            🔎 Classifieur de triage (optionnel)
          </label>
          <select
            value={routing.classifierType === "system-one" ? "system-one" : "chat"}
            onChange={e => {
              const type = e.target.value === "system-one" ? "system-one" : "chat";
              setRouting(prev => ({ ...prev, classifierType: type }));
            }}
            aria-label="Type de classifieur de triage"
            className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-[11px] px-2 py-1.5 rounded focus:border-hacker-accent outline-none"
          >
            <option value="chat">Chat — le modèle répond un JSON de triage</option>
            <option value="system-one">System One — décision native (choix + probabilité)</option>
          </select>

          {routing.classifierType === "system-one" ? (
            <div className="mt-2">
              <label className="text-hacker-text-dim text-xs block mb-1">
                🧩 Modèle de décision (System One)
              </label>
              <ModelSelect
                value={routing.systemOneModelId ?? null}
                onChange={modelId => setRouting(prev => ({ ...prev, systemOneModelId: modelId }))}
                models={models}
                providers={providers}
                noneLabel="— Aucun (triage heuristique) —"
                ariaLabel="Modèle de décision (System One)"
                disabled={false}
              />
              <p className="text-[10px] text-hacker-text-dim mt-1.5">
                Modèle de <strong>décision</strong> (par ex. <code>clef</code> chez Ollama Cloud, en direct ou via
                Switchy). Il ne rédige aucun texte : il rend une catégorie, une probabilité de risque et une
                confiance en une seule passe. Laisse « aucun » pour garder le tri heuristique.
              </p>

              {/* Seuil PROPRE à System One : sa confiance plafonne bas (un choix à
                  4 options), d'où un défaut plus permissif que celui du chat. */}
              <div className="mt-3">
                <label className="text-hacker-text-dim text-xs block mb-1 flex justify-between">
                  <span>🎯 Seuil de confiance (System One)</span>
                  <span className="text-hacker-accent font-mono">
                    {(
                      (routing.systemOneConfidenceThreshold ?? DEFAULT_SYSTEM_ONE_CONFIDENCE_THRESHOLD) * 100
                    ).toFixed(0)}
                    %
                  </span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={routing.systemOneConfidenceThreshold ?? DEFAULT_SYSTEM_ONE_CONFIDENCE_THRESHOLD}
                  onChange={e =>
                    setRouting(prev => ({ ...prev, systemOneConfidenceThreshold: Number(e.target.value) }))
                  }
                  aria-label="Seuil de confiance (System One)"
                  className="w-full accent-hacker-accent"
                />
                <div className="flex justify-between text-[9px] text-hacker-text-dim">
                  <span>0% (permissif)</span>
                  <span>100% (strict)</span>
                </div>
                <p className="text-[10px] text-hacker-text-dim mt-1 leading-relaxed">
                  Plus bas = plus de décisions prises par le modèle. Un choix à 4 options a une confiance
                  naturellement basse ; le seuil de risque protège indépendamment.
                </p>
              </div>
            </div>
          ) : (
            <div className="mt-2">
              <label className="text-hacker-text-dim text-xs block mb-1">
                💬 Modèle du classifieur chat
              </label>
              <ModelSelect
                value={routing.classifierModelId}
                onChange={modelId => setRouting(prev => ({ ...prev, classifierModelId: modelId }))}
                models={models}
                providers={providers}
                noneLabel="— Aucun (triage heuristique) —"
                ariaLabel="Modèle du classifieur chat"
                disabled={false}
              />
            </div>
          )}

          <p className="text-[10px] text-hacker-text-dim mt-1.5">
            Modèle cheap optionnel pour le triage. Laisse « aucun » pour utiliser le tri heuristique par signaux
            (toujours utilisé en repli si le classifieur échoue).
          </p>
        </div>
        </div>

        {/* Erreur */}
        {error && (
          <div className="px-3 py-2 bg-hacker-error/10 text-hacker-error text-xs border border-hacker-error/30 rounded">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="btn-hacker text-xs px-3 py-1.5"
            disabled={loading}
          >
            Fermer
          </button>
          <button
            onClick={handleSave}
            disabled={loading}
            className="btn-hacker text-xs px-4 py-1.5 text-hacker-accent border-hacker-accent disabled:opacity-50"
          >
            {loading ? "Enregistrement…" : "Enregistrer"}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}
