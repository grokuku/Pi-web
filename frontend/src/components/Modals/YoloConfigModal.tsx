import { useState, useRef, useEffect, useCallback } from "react";
import { X, Zap } from "lucide-react";
import { ModalDialog } from "../common/ModalDialog";
import type { RegisteredModel, YoloConfig, ProviderConfig } from "../../types";

interface Props {
  onClose: () => void;
  onChange: (config: Partial<YoloConfig>) => void;
  models: RegisteredModel[];
  providers: ProviderConfig[];
  config: YoloConfig;
}

export function YoloConfigModal({ onClose, onChange, models, providers, config }: Props) {
  // Find the composite model ID (providerId__modelId) matching stored config
  const findModelId = (sel: { providerId: string; modelId: string } | null): string => {
    if (!sel) return "";
    const found = models.find(m => m.providerId === sel.providerId && m.modelId === sel.modelId);
    return found?.id || "";
  };
  const initModel1Id = findModelId(config.model1);
  const initModel2Id = findModelId(config.model2);
  const [model1Id, setModel1Id] = useState(initModel1Id);
  const [model2Id, setModel2Id] = useState(initModel2Id);
  const [planCycles, setPlanCycles] = useState(config.planCycles || 2);
  const [codeCycles, setCodeCycles] = useState(config.codeCycles || 2);
  const [globalCycles, setGlobalCycles] = useState(config.globalCycles || 1);
  const [saved, setSaved] = useState(false);

  // Debounced auto-save
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSave = useCallback(() => {
    const m1 = models.find(m => m.id === model1Id) || null;
    const m2 = models.find(m => m.id === model2Id) || null;
    onChange({
      model1: m1 ? { providerId: m1.providerId, modelId: m1.modelId } : null,
      model2: m2 ? { providerId: m2.providerId, modelId: m2.modelId } : null,
      planCycles,
      codeCycles,
      globalCycles,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }, [model1Id, model2Id, planCycles, codeCycles, globalCycles, models, onChange]);

  // Auto-save on any parameter change (debounced 500ms)
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(doSave, 500);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [model1Id, model2Id, planCycles, codeCycles, globalCycles, doSave]);

  // Group models by provider for display
  const sortedModels = [...models].sort((a, b) => a.name.localeCompare(b.name));

  function getProviderName(providerId: string): string {
    const p = providers.find(p => p.id === providerId);
    if (!p) return providerId;
    return p.name || p.type || providerId;
  }

  const estimatedTokensMin = planCycles * codeCycles * globalCycles * 2000;
  const estimatedTokensMax = planCycles * codeCycles * globalCycles * 8000;

  return (
    <ModalDialog id="yolo-config" onClose={onClose}>
      <div className="p-4 space-y-4 max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap size={16} className="text-hacker-warn" />
            <span className="text-hacker-accent text-sm font-bold tracking-wider flex items-center gap-2">
              YOLO CONFIG
              {saved && <span className="text-green-400 text-[10px] font-normal">✓ saved</span>}
            </span>
          </div>
          <button onClick={onClose} className="text-hacker-text-dim hover:text-hacker-error">
            <X size={16} />
          </button>
        </div>

        {/* Model 1 (Architect / Implementer) */}
        <div>
          <label className="text-hacker-text-dim text-xs block mb-1">🤖 Agent 1 — Architect / Implementer</label>
          <select
            value={model1Id}
            onChange={e => setModel1Id(e.target.value)}
            className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-3 py-1.5 rounded focus:border-hacker-accent outline-none"
          >
            <option value="">— Select model —</option>
            {sortedModels.map(m => (
              <option key={m.id} value={m.id}>{m.name} {m.providerId ? `(${getProviderName(m.providerId)})` : ""}</option>
            ))}
          </select>
        </div>

        {/* Model 2 (Critic / Reviewer) */}
        <div>
          <label className="text-hacker-text-dim text-xs block mb-1">🧠 Agent 2 — Critic / Reviewer</label>
          <select
            value={model2Id}
            onChange={e => setModel2Id(e.target.value)}
            className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-3 py-1.5 rounded focus:border-hacker-accent outline-none"
          >
            <option value="">— Select model —</option>
            {sortedModels.map(m => (
              <option key={m.id} value={m.id}>{m.name} {m.providerId ? `(${getProviderName(m.providerId)})` : ""}</option>
            ))}
          </select>
        </div>

        <div className="border-t border-hacker-border/30" />

        {/* Plan Cycles */}
        <div>
          <label className="text-hacker-text-dim text-xs block mb-1 flex justify-between">
            <span>📝 Plan debate cycles</span>
            <span className="text-hacker-accent font-mono">{planCycles}</span>
          </label>
          <input
            type="range" min={1} max={5} value={planCycles}
            onChange={e => setPlanCycles(Number(e.target.value))}
            className="w-full accent-hacker-accent"
          />
          <div className="flex justify-between text-[9px] text-hacker-text-dim">
            <span>1 (quick)</span><span>5 (thorough)</span>
          </div>
        </div>

        {/* Code Cycles */}
        <div>
          <label className="text-hacker-text-dim text-xs block mb-1 flex justify-between">
            <span>💻 Code debate cycles</span>
            <span className="text-hacker-accent font-mono">{codeCycles}</span>
          </label>
          <input
            type="range" min={1} max={5} value={codeCycles}
            onChange={e => setCodeCycles(Number(e.target.value))}
            className="w-full accent-hacker-accent"
          />
          <div className="flex justify-between text-[9px] text-hacker-text-dim">
            <span>1 (quick)</span><span>5 (thorough)</span>
          </div>
        </div>

        {/* Global Cycles */}
        <div>
          <label className="text-hacker-text-dim text-xs block mb-1 flex justify-between">
            <span>🔁 Global cycles (plan+code repeats)</span>
            <span className="text-hacker-accent font-mono">{globalCycles}</span>
          </label>
          <input
            type="range" min={1} max={3} value={globalCycles}
            onChange={e => setGlobalCycles(Number(e.target.value))}
            className="w-full accent-hacker-accent"
          />
          <div className="flex justify-between text-[9px] text-hacker-text-dim">
            <span>1 (once)</span><span>3 (iterate)</span>
          </div>
        </div>

        <div className="border-t border-hacker-border/30" />

        {/* Cost estimate */}
        <div className="text-[10px] text-hacker-text-dim space-y-1">
          <span>⚠ Estimated tokens: {estimatedTokensMin.toLocaleString()} — {estimatedTokensMax.toLocaleString()}</span>
        </div>
      </div>
    </ModalDialog>
  );
}
