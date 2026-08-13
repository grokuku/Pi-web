import { useState } from "react";
import { X } from "lucide-react";
import { ModalDialog } from "../common/ModalDialog";
import {
  DEFAULT_ROUTING_CONFIG,
  type CategoryConfig,
  type ProviderConfig,
  type RegisteredModel,
  type RoutingConfig,
  type TaskCategory,
} from "../../types";

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
}: {
  value: string | null;
  onChange: (modelId: string | null) => void;
  models: RegisteredModel[];
  providers: ProviderConfig[];
  noneLabel: string;
  disabled?: boolean;
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

export function RoutingConfigModal({ onClose, onSave, models, providers, config }: Props) {
  const [routing, setRouting] = useState<RoutingConfig>(() => ({
    enabled: config?.enabled ?? true,
    trivial: { modelId: config?.trivial?.modelId ?? DEFAULT_ROUTING_CONFIG.trivial.modelId },
    standard: { modelId: config?.standard?.modelId ?? DEFAULT_ROUTING_CONFIG.standard.modelId },
    complex: { modelId: config?.complex?.modelId ?? DEFAULT_ROUTING_CONFIG.complex.modelId },
    review: { modelId: config?.review?.modelId ?? DEFAULT_ROUTING_CONFIG.review.modelId },
    reviewRiskThreshold: config?.reviewRiskThreshold ?? DEFAULT_ROUTING_CONFIG.reviewRiskThreshold,
    confidenceThreshold: config?.confidenceThreshold ?? DEFAULT_ROUTING_CONFIG.confidenceThreshold,
    classifierModelId: config?.classifierModelId ?? DEFAULT_ROUTING_CONFIG.classifierModelId,
  }));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const updateCategoryModel = (category: TaskCategory, modelId: string | null) => {
    setRouting(prev => ({ ...prev, [category]: { modelId } as CategoryConfig }));
  };

  const handleSave = async () => {
    setLoading(true);
    setError("");
    setSaved(false);
    try {
      await onSave(routing);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
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
              {saved && <span className="text-green-400 text-[10px] font-normal">✓ enregistré</span>}
            </span>
          </div>
          <button onClick={onClose} className="text-hacker-text-dim hover:text-hacker-error">
            <X size={16} />
          </button>
        </div>

        <p className="text-[11px] text-hacker-text-dim">
          Le routage remplace l'ancienne équipe d'experts par 4 catégories de tâches.
          Chaque catégorie peut utiliser un modèle spécifique ; laisse « défaut » pour
          utiliser le modèle par défaut du projet.
        </p>

        {/* Interrupteur principal : active/désactive le routage */}
        <div className="border border-hacker-border bg-hacker-surface/30 rounded p-3">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs font-bold text-hacker-text-bright">🔀 Routage actif</span>
              <p className="text-[10px] text-hacker-text-dim mt-0.5">
                Désactive pour revenir au mode basic, sans triage automatique des tâches.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setRouting(prev => ({ ...prev, enabled: !prev.enabled }))}
              aria-pressed={routing.enabled}
              className={`text-[10px] px-2 py-1 rounded border transition-colors shrink-0 ml-3 ${
                routing.enabled
                  ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                  : "border-hacker-border text-hacker-text-dim"
              }`}
            >
              {routing.enabled ? "● ON" : "○ OFF"}
            </button>
          </div>
        </div>

        {/* Configuration grisée quand le routage est inactif (les valeurs sont conservées) */}
        <div
          className={routing.enabled ? "" : "opacity-50 pointer-events-none select-none"}
          aria-disabled={!routing.enabled}
        >
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
              </div>
              <ModelSelect
                value={routing[cat.id].modelId}
                onChange={modelId => updateCategoryModel(cat.id, modelId)}
                models={models}
                providers={providers}
                noneLabel="— Défaut (modèle par défaut) —"
                disabled={!routing.enabled}
              />
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
              disabled={!routing.enabled}
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
              disabled={!routing.enabled}
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
        </div>

        {/* Classifieur optionnel */}
        <div className="border-t border-hacker-border/30 pt-3">
          <label className="text-hacker-text-dim text-xs block mb-1">
            🔎 Classifieur de triage (optionnel)
          </label>
          <ModelSelect
            value={routing.classifierModelId}
            onChange={modelId => setRouting(prev => ({ ...prev, classifierModelId: modelId }))}
            models={models}
            providers={providers}
            noneLabel="— Aucun (triage heuristique) —"
            disabled={!routing.enabled}
          />
          <p className="text-[10px] text-hacker-text-dim mt-1.5">
            Modèle cheap optionnel pour le triage LLM. Laisse « aucun » pour utiliser le tri
            heuristique par signaux.
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
            {loading ? "Enregistrement…" : saved ? "✓ Enregistré" : "Enregistrer"}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}
