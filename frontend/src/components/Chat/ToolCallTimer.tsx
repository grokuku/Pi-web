// ── Chrono d'un tool call en cours (perf) ────────────────────────────────────
// Extrait de ChatView (LOT 1) pour être partagé avec SubAgentBlock : chaque
// tick du setInterval ne re-render QUE ce chrono, jamais le reste du chat
// (ToolCallRow / SubAgentBlock sont memoïsés et ne dépendent pas de cet état
// interne). Basé sur toolCall.startedAt (absent en historique → 0s).
import { memo, useEffect, useState } from "react";

export const ToolCallTimer = memo(function ToolCallTimer({ startedAt }: { startedAt?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = startedAt ? Math.max(0, now - startedAt) : 0;
  const totalSecs = Math.floor(elapsed / 1000);
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return <span className="text-hacker-text-dim/60 tabular-nums">{m > 0 ? `${m}m ${s}s` : `${s}s`}</span>;
});