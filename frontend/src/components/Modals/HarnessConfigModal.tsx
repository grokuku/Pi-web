import { useState, useRef, useEffect, useCallback } from "react";
import { X, Plus, Trash2, GripVertical } from "lucide-react";
import { ModalDialog } from "../common/ModalDialog";
import type { RegisteredModel, ProviderConfig, HarnessConfig, HarnessAgentConfig } from "../../types";

interface Props {
  onClose: () => void;
  onChange: (config: HarnessConfig) => void;
  models: RegisteredModel[];
  providers: ProviderConfig[];
  config: HarnessConfig;
}

const DEFAULT_ROLES = [
  { role: "architect", label: "🏗 Architect", desc: "Analyse et planifie" },
  { role: "developer", label: "💻 Developer", desc: "Implémente le code" },
  { role: "reviewer", label: "👁 Reviewer", desc: "Review et corrige" },
  { role: "qa", label: "🧪 QA Tester", desc: "Teste et valide" },
];

export function HarnessConfigModal({ onClose, onChange, models, providers, config }: Props) {
  const [agents, setAgents] = useState<HarnessAgentConfig[]>(
    config.agents?.length > 0 ? config.agents : []
  );
  const [maxRounds, setMaxRounds] = useState(config.maxRounds ?? 1);
  const [synthesize, setSynthesize] = useState(config.synthesize ?? true);
  const [saved, setSaved] = useState(false);
  const [expandedAgent, setExpandedAgent] = useState<number | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSave = useCallback(() => {
    onChange({ agents, maxRounds, synthesize });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }, [agents, maxRounds, synthesize, onChange]);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(doSave, 500);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [agents, maxRounds, synthesize, doSave]);

  const addAgent = (role: string) => {
    setAgents(prev => [...prev, {
      role,
      modelId: null,
      enabled: true,
      systemPrompt: "",
      tools: [],
    }]);
    setExpandedAgent(agents.length);
  };

  const removeAgent = (idx: number) => {
    setAgents(prev => prev.filter((_, i) => i !== idx));
    setExpandedAgent(null);
  };

  const updateAgent = (idx: number, updates: Partial<HarnessAgentConfig>) => {
    setAgents(prev => prev.map((a, i) => i === idx ? { ...a, ...updates } : a));
  };

  const sortedModels = [...models].sort((a, b) => a.name.localeCompare(b.name));

  function getProviderName(providerId: string): string {
    const p = providers.find(p => p.id === providerId);
    return p?.name || p?.type || providerId;
  }

  const getModelName = (modelId: string | null): string => {
    if (!modelId) return "— Default —";
    const m = models.find(m => m.id === modelId);
    return m ? `${m.name} (${getProviderName(m.providerId)})` : modelId;
  };

  // Roles not yet added
  const availableRoles = DEFAULT_ROLES.filter(
    dr => !agents.some(a => a.role === dr.role)
  );

  return (
    <ModalDialog id="harness-config" onClose={onClose}>
      <div className="p-4 space-y-4 max-w-lg">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-hacker-accent text-sm font-bold tracking-wider flex items-center gap-2">
              🏭 HARNESS CONFIG
              {saved && <span className="text-green-400 text-[10px] font-normal">✓ saved</span>}
            </span>
          </div>
          <button onClick={onClose} className="text-hacker-text-dim hover:text-hacker-error">
            <X size={16} />
          </button>
        </div>

        <p className="text-[11px] text-hacker-text-dim">
          Configure les agents qui composeront ton équipe Harness. Chaque agent reçoit un rôle,
          un modèle, et éventuellement un système prompt personnalisé. Les agents s'exécutent
          séquentiellement, chacun recevant l'output du précédent.
        </p>

        {/* Agent list */}
        <div className="space-y-2 max-h-[350px] overflow-y-auto">
          {agents.map((agent, idx) => (
            <div key={idx} className="border border-hacker-border bg-hacker-surface/30 rounded overflow-hidden">
              <div
                className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-hacker-border/20"
                onClick={() => setExpandedAgent(expandedAgent === idx ? null : idx)}
              >
                <GripVertical size={12} className="text-hacker-text-dim/30 shrink-0" />
                <span className="text-xs font-bold text-hacker-accent shrink-0">
                  {DEFAULT_ROLES.find(r => r.role === agent.role)?.label || `🤖 ${agent.role}`}
                </span>
                <span className="text-[10px] text-hacker-text-dim truncate flex-1">
                  {getModelName(agent.modelId)}
                </span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${agent.enabled ? "bg-green-900/30 text-green-400" : "bg-hacker-border/30 text-hacker-text-dim"}`}>
                  {agent.enabled ? "ON" : "OFF"}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); removeAgent(idx); }}
                  className="text-hacker-text-dim/50 hover:text-hacker-error shrink-0"
                >
                  <Trash2 size={12} />
                </button>
              </div>

              {expandedAgent === idx && (
                <div className="px-3 py-2 border-t border-hacker-border/50 space-y-2 bg-hacker-bg/30">
                  {/* Enable toggle */}
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-hacker-text-dim">Activé</span>
                    <button
                      onClick={() => updateAgent(idx, { enabled: !agent.enabled })}
                      className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                        agent.enabled
                          ? "border-green-500/50 text-green-400 bg-green-900/20"
                          : "border-hacker-border text-hacker-text-dim"
                      }`}
                    >
                      {agent.enabled ? "● ON" : "○ OFF"}
                    </button>
                  </div>

                  {/* Model select */}
                  <div>
                    <label className="text-[10px] text-hacker-text-dim block mb-0.5">Modèle</label>
                    <select
                      value={agent.modelId || ""}
                      onChange={e => updateAgent(idx, { modelId: e.target.value || null })}
                      className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-[10px] px-2 py-1 rounded focus:border-hacker-accent outline-none"
                    >
                      <option value="">— Default (session model) —</option>
                      {sortedModels.map(m => (
                        <option key={m.id} value={m.id}>{m.name} ({getProviderName(m.providerId)})</option>
                      ))}
                    </select>
                  </div>

                  {/* System prompt (optional) */}
                  <div>
                    <label className="text-[10px] text-hacker-text-dim block mb-0.5">
                      Système prompt (optionnel — laisse vide pour utiliser le défaut du rôle)
                    </label>
                    <textarea
                      value={agent.systemPrompt || ""}
                      onChange={e => updateAgent(idx, { systemPrompt: e.target.value })}
                      placeholder="Instructions personnalisées pour cet agent..."
                      rows={3}
                      className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-[10px] px-2 py-1 rounded focus:border-hacker-accent outline-none resize-none font-mono"
                    />
                  </div>
                </div>
              )}
            </div>
          ))}

          {agents.length === 0 && (
            <div className="text-center py-6 text-[11px] text-hacker-text-dim border border-dashed border-hacker-border/40 rounded">
              Aucun agent configuré. Ajoute un rôle ci-dessous.
            </div>
          )}
        </div>

        {/* Add agent button */}
        <div className="flex flex-wrap gap-1.5">
          {availableRoles.length > 0 ? (
            availableRoles.map(dr => (
              <button
                key={dr.role}
                onClick={() => addAgent(dr.role)}
                className="flex items-center gap-1 text-[10px] px-2 py-1 border border-hacker-border rounded hover:border-hacker-accent hover:text-hacker-accent transition-colors"
              >
                <Plus size={10} />
                {dr.label}
                <span className="text-hacker-text-dim/50">— {dr.desc}</span>
              </button>
            ))
          ) : (
            <span className="text-[10px] text-hacker-text-dim italic">Tous les rôles sont déjà ajoutés</span>
          )}
        </div>

        <div className="border-t border-hacker-border/30" />

        {/* Global settings */}
        <div className="space-y-3">
          {/* Max rounds */}
          <div>
            <label className="text-hacker-text-dim text-xs block mb-1 flex justify-between">
              <span>🔁 Rounds max</span>
              <span className="text-hacker-accent font-mono">{maxRounds}</span>
            </label>
            <input
              type="range" min={1} max={5} value={maxRounds}
              onChange={e => setMaxRounds(Number(e.target.value))}
              className="w-full accent-hacker-accent"
            />
            <div className="flex justify-between text-[9px] text-hacker-text-dim">
              <span>1 (une passe)</span><span>5 (itérations)</span>
            </div>
          </div>

          {/* Synthesize toggle */}
          <div className="flex items-center justify-between">
            <div>
              <span className="text-hacker-text-dim text-xs block">📝 Synthèse finale</span>
              <span className="text-[10px] text-hacker-text-dim/60">Génère un résumé combiné de tous les agents</span>
            </div>
            <button
              onClick={() => setSynthesize(!synthesize)}
              className={`text-[10px] px-2 py-1 rounded border transition-colors ${
                synthesize
                  ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                  : "border-hacker-border text-hacker-text-dim"
              }`}
            >
              {synthesize ? "● ON" : "○ OFF"}
            </button>
          </div>
        </div>

        {/* Summary */}
        {agents.length > 0 && (
          <div className="border-t border-hacker-border/30 pt-2">
            <div className="text-[10px] text-hacker-text-dim space-y-0.5">
              <div>🏭 {agents.length} agent{agents.length > 1 ? "s" : ""} · {maxRounds} round{maxRounds > 1 ? "s" : ""}</div>
              <div className="flex flex-wrap gap-1 mt-1">
                {agents.filter(a => a.enabled).map(a => (
                  <span key={a.role} className="text-[9px] px-1.5 py-0.5 bg-hacker-accent/10 text-hacker-accent rounded">
                    {a.role}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </ModalDialog>
  );
}
