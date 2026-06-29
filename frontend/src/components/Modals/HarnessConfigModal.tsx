import { useState, useRef, useEffect, useCallback } from "react";
import { X, GripVertical } from "lucide-react";
import { ModalDialog } from "../common/ModalDialog";
import type { RegisteredModel, ProviderConfig, HarnessConfig, HarnessAgentConfig } from "../../types";

interface Props {
  onClose: () => void;
  onChange: (config: HarnessConfig) => void;
  models: RegisteredModel[];
  providers: ProviderConfig[];
  config: HarnessConfig;
}

// ── Pool d'agents par défaut ─────────────────────────
// Chaque agent a un rôle, une description, un label d'affichage.
// Les system prompts et outils sont définis côté backend.
// Le frontend ne stocke que la metadata pour l'affichage.

export const DEFAULT_HARNESS_AGENTS: { role: string; label: string; description: string; emoji: string }[] = [
  { role: "architect",       label: "Architect",          emoji: "🏗",  description: "Analyse la demande, explore le code, prend les décisions techniques et élabore le plan structuré" },
  { role: "backend-dev",     label: "Backend Developer",  emoji: "⚙️", description: "Implémente la logique serveur : API, endpoints, middleware, services, business logic" },
  { role: "frontend-dev",    label: "Frontend Developer", emoji: "🎨", description: "Implémente les composants UI, styles, interactions, routing frontend" },
  { role: "database-engineer", label: "Database Engineer", emoji: "🗄️", description: "Conçoit les schémas, migrations, queries, optimisations base de données" },
  { role: "api-designer",    label: "API Designer",       emoji: "🔌", description: "Conçoit les contrats API, schemas de validation, documentation OpenAPI" },
  { role: "code-reviewer",   label: "Code Reviewer",      emoji: "👁",  description: "Review le code produit : logique, sécurité, performances, edge cases, qualité" },
  { role: "qa-tester",       label: "QA Tester",          emoji: "🧪",  description: "Exécute les tests, vérifie les critères d'acceptation, crée des tests manquants" },
  { role: "test-writer",     label: "Test Writer",        emoji: "🔬",  description: "Écrit les tests unitaires, integration, e2e avec un coverage complet" },
  { role: "docs-writer",     label: "Documentation Writer", emoji: "📝", description: "Rédige la documentation : README, guides, commentaires de code, API docs" },
  { role: "devops",          label: "DevOps Engineer",     emoji: "🚀",  description: "Configure CI/CD, Docker, scripts de déploiement, automatisation" },
  { role: "security-reviewer", label: "Security Reviewer", emoji: "🔒",  description: "Audit de sécurité : injection, XSS, CSRF, auth, permissions, secrets exposés" },
  { role: "refactoring",     label: "Refactoring Specialist", emoji: "🔧", description: "Refactor le code existant : améliore la structure, élimine la dette technique" },
];

export function HarnessConfigModal({ onClose, onChange, models, providers, config }: Props) {
  // Construire la liste complète des agents : pool + agents custom (non présents dans le pool)
  const poolRoles = new Set(DEFAULT_HARNESS_AGENTS.map(a => a.role));
  const savedAgents = config.agents || [];

  // Fusionner : on garde l'ordre du pool, puis les customs
  const [allAgents, setAllAgents] = useState<HarnessAgentConfig[]>(() => {
    const pool = DEFAULT_HARNESS_AGENTS.map(da => {
      const saved = savedAgents.find(a => a.role === da.role);
      return {
        role: da.role,
        description: da.description,
        modelId: saved?.modelId ?? null,
        enabled: saved?.enabled ?? true, // all enabled by default
        systemPrompt: saved?.systemPrompt,
        tools: saved?.tools,
      };
    });
    // Ajouter les customs (non présents dans le pool)
    const customs = savedAgents.filter(a => !poolRoles.has(a.role));
    return [...pool, ...customs];
  });

  const [synthesize, setSynthesize] = useState(config.synthesize ?? true);
  const [agentTimeout, setAgentTimeout] = useState(config.agentTimeout ?? 300);
  const [maxTasks, setMaxTasks] = useState(config.maxTasks ?? 20);
  const [saved, setSaved] = useState(false);
  const [expandedAgent, setExpandedAgent] = useState<number | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSave = useCallback(() => {
    onChange({ agents: allAgents, synthesize, agentTimeout, maxTasks });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }, [allAgents, synthesize, agentTimeout, maxTasks, onChange]);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(doSave, 500);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [allAgents, synthesize, agentTimeout, maxTasks, doSave]);

  const toggleAgent = (idx: number) => {
    setAllAgents(prev => prev.map((a, i) => i === idx ? { ...a, enabled: !a.enabled } : a));
  };

  const updateAgent = (idx: number, updates: Partial<HarnessAgentConfig>) => {
    setAllAgents(prev => prev.map((a, i) => i === idx ? { ...a, ...updates } : a));
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

  const getAgentInfo = (role: string) => {
    return DEFAULT_HARNESS_AGENTS.find(a => a.role === role);
  };

  const enabledCount = allAgents.filter(a => a.enabled).length;

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
          Active ou désactive les agents qui composeront ton équipe. L'architecte sélectionnera
          les agents pertinents pour chaque tâche lors de la phase de planification.
          <br/><strong>{enabledCount}/{allAgents.length} agents activés</strong>
        </p>

        {/* Agent list */}
        <div className="space-y-1.5 max-h-[350px] overflow-y-auto">
          {allAgents.map((agent, idx) => {
            const info = getAgentInfo(agent.role);
            return (
              <div key={agent.role} className="border border-hacker-border bg-hacker-surface/30 rounded overflow-hidden">
                <div
                  className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-hacker-border/20"
                  onClick={() => setExpandedAgent(expandedAgent === idx ? null : idx)}
                >
                  <GripVertical size={12} className="text-hacker-text-dim/30 shrink-0" />
                  <span className="text-[10px] shrink-0">{info?.emoji || "🤖"}</span>
                  <span className="text-xs font-bold text-hacker-text-bright shrink-0">
                    {info?.label || agent.role}
                  </span>
                  <span className="text-[10px] text-hacker-text-dim truncate flex-1 ml-1">
                    {agent.description?.slice(0, 50)}{agent.description?.length > 50 ? "…" : ""}
                  </span>
                  <span
                    className={`text-[9px] px-1.5 py-0.5 rounded cursor-pointer shrink-0 ${
                      agent.enabled ? "bg-green-900/30 text-green-400" : "bg-hacker-border/30 text-hacker-text-dim"
                    }`}
                    onClick={(e) => { e.stopPropagation(); toggleAgent(idx); }}
                  >
                    {agent.enabled ? "● ON" : "○ OFF"}
                  </span>
                </div>

                {expandedAgent === idx && (
                  <div className="px-3 py-2 border-t border-hacker-border/50 space-y-2 bg-hacker-bg/30">
                    {/* Description complète */}
                    <div className="text-[10px] text-hacker-text-dim/80 leading-relaxed">
                      {agent.description}
                    </div>

                    {/* Model select */}
                    <div>
                      <label className="text-[10px] text-hacker-text-dim block mb-0.5">Modèle (optionnel)</label>
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
                        Système prompt personnalisé (optionnel)
                      </label>
                      <textarea
                        value={agent.systemPrompt || ""}
                        onChange={e => updateAgent(idx, { systemPrompt: e.target.value })}
                        placeholder="Laisse vide pour utiliser le prompt par défaut du rôle..."
                        rows={2}
                        className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-[10px] px-2 py-1 rounded focus:border-hacker-accent outline-none resize-none font-mono"
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Custom agent add */}
        <div className="flex items-center gap-1">
          <input
            type="text"
            id="custom-agent-input"
            placeholder="Ajouter un agent custom..."
            className="flex-1 bg-hacker-bg border border-hacker-border text-hacker-text-bright text-[10px] px-2 py-1 rounded focus:border-hacker-accent outline-none"
            onKeyDown={e => {
              if (e.key === "Enter") {
                const val = (e.target as HTMLInputElement).value.trim();
                if (val && !allAgents.some(a => a.role === val)) {
                  setAllAgents(prev => [...prev, {
                    role: val,
                    description: "Agent personnalisé",
                    modelId: null,
                    enabled: true,
                  }]);
                  setExpandedAgent(allAgents.length);
                  (e.target as HTMLInputElement).value = "";
                }
              }
            }}
          />
          <button
            onClick={() => {
              const el = document.getElementById("custom-agent-input") as HTMLInputElement;
              if (el && el.value.trim() && !allAgents.some(a => a.role === el.value.trim())) {
                setAllAgents(prev => [...prev, {
                  role: el.value.trim(),
                  description: "Agent personnalisé",
                  modelId: null,
                  enabled: true,
                }]);
                setExpandedAgent(allAgents.length);
                el.value = "";
              }
            }}
            className="text-[10px] px-2 py-1 border border-hacker-border rounded hover:border-hacker-accent hover:text-hacker-accent transition-colors shrink-0"
          >
            + Ajouter
          </button>
        </div>

        <div className="border-t border-hacker-border/30" />

        {/* Global settings */}
        <div className="space-y-3">
          {/* Agent timeout */}
          <div>
            <label className="text-hacker-text-dim text-xs block mb-1 flex justify-between">
              <span>⏱ Timeout par agent</span>
              <span className="text-hacker-accent font-mono">{agentTimeout < 60 ? `${agentTimeout}s` : `${Math.round(agentTimeout / 60)}min`}</span>
            </label>
            <input
              type="range" min={30} max={1800} step={30} value={agentTimeout}
              onChange={e => setAgentTimeout(Number(e.target.value))}
              className="w-full accent-hacker-accent"
            />
            <div className="flex justify-between text-[9px] text-hacker-text-dim">
              <span>30s (cloud rapide)</span><span>30min (modèle local)</span>
            </div>
          </div>

          {/* Max tasks */}
          <div>
            <label className="text-hacker-text-dim text-xs block mb-1 flex justify-between">
              <span>📋 Tâches max (sécurité)</span>
              <span className="text-hacker-accent font-mono">{maxTasks}</span>
            </label>
            <input
              type="range" min={3} max={50} step={1} value={maxTasks}
              onChange={e => setMaxTasks(Number(e.target.value))}
              className="w-full accent-hacker-accent"
            />
            <div className="flex justify-between text-[9px] text-hacker-text-dim">
              <span>3 (mini)</span><span>50 (gros projet)</span>
            </div>
          </div>

          {/* Synthesize toggle */}
          <div className="flex items-center justify-between">
            <div>
              <span className="text-hacker-text-dim text-xs block">📝 Synthèse finale</span>
              <span className="text-[10px] text-hacker-text-dim/60">Affiche un résumé structuré de toutes les tâches</span>
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
        <div className="border-t border-hacker-border/30 pt-2">
          <div className="text-[10px] text-hacker-text-dim space-y-0.5">
            <div>🏭 {enabledCount}/{allAgents.length} agents actifs · max {maxTasks} tâches</div>
            <div className="flex flex-wrap gap-1 mt-1">
              {allAgents.filter(a => a.enabled).map(a => {
                const info = getAgentInfo(a.role);
                return (
                  <span key={a.role} className="text-[9px] px-1.5 py-0.5 bg-hacker-accent/10 text-hacker-accent rounded">
                    {info?.emoji || "🤖"} {info?.label || a.role}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </ModalDialog>
  );
}
