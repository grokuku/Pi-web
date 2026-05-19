import { useState } from "react";
import { X, Zap } from "lucide-react";
import { ModalDialog } from "../common/ModalDialog";
import type { RegisteredModel, YoloConfig } from "../../types";

interface Props {
  onClose: () => void;
  onSave: (config: Partial<YoloConfig>) => void;
  models: RegisteredModel[];
  config: YoloConfig;
}

export function YoloConfigModal({ onClose, onSave, models, config }: Props) {
  const [model1Id, setModel1Id] = useState(config.model1?.modelId || config.model1?.providerId + "__" + config.model1?.modelId || "");
  const [model2Id, setModel2Id] = useState(config.model2?.modelId || config.model2?.providerId + "__" + config.model2?.modelId || "");
  const [planCycles, setPlanCycles] = useState(config.planCycles || 2);
  const [codeCycles, setCodeCycles] = useState(config.codeCycles || 2);
  const [globalCycles, setGlobalCycles] = useState(config.globalCycles || 1);

  const handleSave = () => {
    // Find the selected models from the library
    const m1 = models.find(m => m.id === model1Id);
    const m2 = models.find(m => m.id === model2Id);
    onSave({
      model1: m1 ? { providerId: m1.providerId, modelId: m1.modelId } : null,
      model2: m2 ? { providerId: m2.providerId, modelId: m2.modelId } : null,
      planCycles,
      codeCycles,
      globalCycles,
    });
  };

  // Group models by provider for display
  const sortedModels = [...models].sort((a, b) => a.name.localeCompare(b.name));

  const estimatedTokensMin = planCycles * codeCycles * globalCycles * 2000;
  const estimatedTokensMax = planCycles * codeCycles * globalCycles * 8000;

  return (
    <ModalDialog id="yolo-config" onClose={onClose}>
      <div className="p-4 space-y-4 max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap size={16} className="text-hacker-warn" />
            <span className="text-hacker-accent text-sm font-bold tracking-wider">YOLO CONFIG</span>
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
              <option key={m.id} value={m.id}>{m.name} {m.providerId ? `(${m.providerId})` : ""}</option>
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
              <option key={m.id} value={m.id}>{m.name} {m.providerId ? `(${m.providerId})` : ""}</option>
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

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          <button onClick={handleSave}
            className="flex-1 btn-hacker text-xs px-4 py-2 flex items-center justify-center gap-1.5"
            disabled={!model1Id || !model2Id}
          >
            <Zap size={12} /> SAVE CONFIG
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}
