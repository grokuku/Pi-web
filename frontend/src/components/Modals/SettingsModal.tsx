import { useState } from "react";
import { X } from "lucide-react";

interface Props {
  onClose: () => void;
  send: (msg: any) => void;
  session: any;
}

export function SettingsModal({ onClose, send, session }: Props) {
  const [provider, setProvider] = useState("anthropic");
  const [modelId, setModelId] = useState("claude-sonnet-4-20250514");
  const [thinkingLevel, setThinkingLevel] = useState("medium");

  const handleSetModel = async () => {
    try {
      await fetch("/api/settings/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, modelId }),
      });
    } catch (e) {
      console.error(e);
    }
  };

  const handleSetThinking = async () => {
    try {
      await fetch("/api/settings/thinking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: thinkingLevel }),
      });
    } catch (e) {
      console.error(e);
    }
  };

  const handleCompact = async () => {
    try {
      await fetch("/api/settings/session/compact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <div className="flex items-center justify-between mb-4">
          <span className="text-hacker-accent font-bold text-sm tracking-wider">
            ⚙ SETTINGS
          </span>
          <button onClick={onClose} className="text-hacker-text-dim hover:text-hacker-text">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 text-sm">
          {/* Model Configuration */}
          <div>
            <div className="text-hacker-accent text-xs mb-2">MODEL CONFIGURATION</div>
            <div className="space-y-2">
              <div>
                <label className="text-hacker-text-dim text-[10px] block mb-1">Provider</label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="select-hacker w-full text-xs"
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                  <option value="google">Google Gemini</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="mistral">Mistral</option>
                  <option value="groq">Groq</option>
                  <option value="xai">xAI</option>
                  <option value="openrouter">OpenRouter</option>
                </select>
              </div>
              <div>
                <label className="text-hacker-text-dim text-[10px] block mb-1">Model ID</label>
                <input
                  type="text"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  className="input-hacker w-full text-xs"
                  placeholder="claude-sonnet-4-20250514"
                />
              </div>
              <button onClick={handleSetModel} className="btn-hacker w-full text-xs">
                APPLY MODEL
              </button>
            </div>
          </div>

          {/* Thinking Level */}
          <div>
            <div className="text-hacker-accent text-xs mb-2">THINKING LEVEL</div>
            <div className="space-y-2">
              <select
                value={thinkingLevel}
                onChange={(e) => setThinkingLevel(e.target.value)}
                className="select-hacker w-full text-xs"
              >
                <option value="off">Off</option>
                <option value="minimal">Minimal</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">XHigh (OpenAI Codex only)</option>
              </select>
              <button onClick={handleSetThinking} className="btn-hacker w-full text-xs">
                APPLY THINKING LEVEL
              </button>
            </div>
          </div>

          {/* Current Session */}
          {session && (
            <div>
              <div className="text-hacker-accent text-xs mb-2">CURRENT SESSION</div>
              <div className="bg-hacker-bg/50 border border-hacker-border p-2 text-[10px] space-y-1">
                <div>ID: {session.sessionId?.slice(0, 16)}...</div>
                <div>Model: {session.model?.name || "?"}</div>
                <div>Thinking: {session.thinkingLevel}</div>
                <div>Messages: {session.messageCount}</div>
                <div>Streaming: {session.isStreaming ? "YES" : "NO"}</div>
              </div>
              <button onClick={handleCompact} className="btn-hacker w-full text-xs mt-2">
                COMPACT CONTEXT
              </button>
            </div>
          )}
        </div>

        <div className="flex gap-2 justify-end mt-4 pt-3 border-t border-hacker-border">
          <button onClick={onClose} className="btn-hacker text-xs">
            CLOSE
          </button>
        </div>
      </div>
    </div>
  );
}
