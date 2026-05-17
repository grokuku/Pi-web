import { useState, useEffect, useCallback } from "react";
import { BarChart3, X, Clock, Calendar, Brain, Hash } from "lucide-react";

interface UsageBucket {
  key: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
}

interface UsageResponse {
  from: string;
  to: string;
  groupBy: string;
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
  buckets: UsageBucket[];
}

type Period = "today" | "week" | "month" | "all";
type GroupBy = "hour" | "day" | "model";

const COLORS: Record<string, string> = {
  input: "#4ade80",
  output: "#60a5fa",
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function getDateRange(period: Period): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date();

  switch (period) {
    case "today":
      return { from: to, to };
    case "week":
      from.setDate(now.getDate() - 7);
      return { from: from.toISOString().slice(0, 10), to };
    case "month":
      from.setMonth(now.getMonth() - 1);
      return { from: from.toISOString().slice(0, 10), to };
    case "all":
      return { from: "2024-01-01", to };
  }
}

function getGroupByForPeriod(period: Period, groupBy: GroupBy): GroupBy {
  if (groupBy === "hour" && period === "today") return "hour";
  if (groupBy === "hour") return "day";
  return groupBy;
}

// ── Simple SVG Bar Chart ──────────────────────────────
function BarChart({
  buckets,
  maxTokens,
}: {
  buckets: UsageBucket[];
  maxTokens: number;
}) {
  if (buckets.length === 0) return null;

  const chartW = 100; // %
  const chartH = 160; // px
  const barGap = 2;
  const barW = Math.max(4, Math.floor((chartW / buckets.length) * 2 - barGap));
  const scale = chartH / Math.max(maxTokens, 1);

  return (
    <div className="mt-3 pt-3 border-t border-hacker-border">
      <svg
        viewBox={`0 0 ${buckets.length * (barW + barGap) + 10} ${chartH + 20}`}
        className="w-full"
        style={{ maxHeight: chartH + 20 }}
      >
        {buckets.map((b, i) => {
          const inputH = Math.max(2, b.inputTokens * scale);
          const outputH = Math.max(2, b.outputTokens * scale);
          const totalH = inputH + outputH;
          const x = i * (barW + barGap) + 5;
          const y = chartH - totalH;

          return (
            <g key={b.key} className="group">
              {/* Output (top) */}
              <rect
                x={x}
                y={y}
                width={barW}
                height={outputH}
                fill={COLORS.output}
                opacity={0.8}
                rx={1}
              />
              {/* Input (bottom) */}
              <rect
                x={x}
                y={y + outputH}
                width={barW}
                height={inputH}
                fill={COLORS.input}
                opacity={0.9}
                rx={1}
              />
              {/* Label */}
              <text
                x={x + barW / 2}
                y={chartH + 12}
                textAnchor="middle"
                className="fill-hacker-text-dim"
                style={{ fontSize: "8px" }}
              >
                {b.label}
              </text>
            </g>
          );
        })}
      </svg>
      {/* Legend */}
      <div className="flex gap-4 justify-center mt-1 text-[10px]">
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: COLORS.input }} />
          <span className="text-hacker-text-dim">Input</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: COLORS.output }} />
          <span className="text-hacker-text-dim">Output</span>
        </span>
      </div>
    </div>
  );
}

// ── Main Modal ─────────────────────────────────────────

export function UsageStatsModal({ onClose }: { onClose: () => void }) {
  const [period, setPeriod] = useState<Period>("week");
  const [groupBy, setGroupBy] = useState<GroupBy>("day");
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const effectiveGroupBy = getGroupByForPeriod(period, groupBy);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = getDateRange(period);
      const res = await fetch(
        `/api/usage?from=${from}&to=${to}&groupBy=${effectiveGroupBy}`
      );
      if (res.ok) setData(await res.json());
    } catch {
      setData(null);
    }
    setLoading(false);
  }, [period, effectiveGroupBy]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const maxTokens = data
    ? Math.max(
        ...data.buckets.map((b) => b.inputTokens + b.outputTokens),
        1
      )
    : 1;

  const bars = data?.buckets || [];

  return (
    <div className="fixed inset-0 bg-black/60 z-[200] flex items-center justify-center p-4">
      <div className="bg-hacker-surface border border-hacker-accent/30 shadow-lg rounded-lg w-full max-w-[720px] max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-hacker-border">
          <div className="flex items-center gap-2 text-hacker-accent font-bold text-sm">
            <BarChart3 size={16} />
            Token Usage Stats
          </div>
          <button
            onClick={onClose}
            className="text-hacker-text-dim hover:text-hacker-accent"
          >
            <X size={16} />
          </button>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-hacker-border/50">
          {/* Period */}
          <span className="text-[10px] text-hacker-text-dim uppercase tracking-wide flex items-center gap-1">
            <Calendar size={10} /> Période
          </span>
          {(["today", "week", "month", "all"] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                period === p
                  ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                  : "border-transparent text-hacker-text-dim hover:text-hacker-text hover:border-hacker-border"
              }`}
            >
              {p === "today" ? "Aujourd'hui" : p === "week" ? "Semaine" : p === "month" ? "Mois" : "Tout"}
            </button>
          ))}

          <span className="text-hacker-border/30 mx-1">│</span>

          {/* Grouping */}
          <span className="text-[10px] text-hacker-text-dim uppercase tracking-wide flex items-center gap-1">
            <Hash size={10} /> Groupe
          </span>
          {(["hour", "day", "model"] as GroupBy[]).map((g) => {
            const disabled = g === "hour" && period !== "today";
            return (
              <button
                key={g}
                disabled={disabled}
                onClick={() => setGroupBy(g)}
                className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                  disabled
                    ? "border-transparent text-hacker-text-dim/30 cursor-not-allowed"
                    : effectiveGroupBy === g
                    ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                    : "border-transparent text-hacker-text-dim hover:text-hacker-text hover:border-hacker-border"
                }`}
                title={disabled ? "Disponible uniquement sur Aujourd'hui" : undefined}
              >
                {g === "hour" ? "Heure" : g === "day" ? "Jour" : "Modèle"}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto px-4 py-3">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-hacker-text-dim text-sm">
              <BarChart3 className="animate-pulse mr-2" size={14} />
              Chargement...
            </div>
          ) : !data ? (
            <div className="flex items-center justify-center py-12 text-hacker-text-dim text-sm">
              Erreur de chargement
            </div>
          ) : bars.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-hacker-text-dim text-sm">
              <Brain size={14} className="mr-2" />
              Aucune donnée pour cette période
            </div>
          ) : (
            <>
              {/* Bar Chart */}
              <BarChart buckets={bars} maxTokens={maxTokens} />

              {/* Totals */}
              <div className="flex gap-4 mt-3 pt-2 border-t border-hacker-border/50 text-xs">
                <span className="text-hacker-text-dim">
                  Total input:{" "}
                  <span className="text-hacker-accent">
                    {formatTokens(data.totalInput)}
                  </span>
                </span>
                <span className="text-hacker-text-dim">
                  Total output:{" "}
                  <span className="text-hacker-accent">
                    {formatTokens(data.totalOutput)}
                  </span>
                </span>
                <span className="text-hacker-text-dim">
                  Total:{" "}
                  <span className="text-hacker-accent font-bold">
                    {formatTokens(data.totalTokens)}
                  </span>
                </span>
              </div>

              {/* Table */}
              <div className="mt-3 max-h-[200px] overflow-auto">
                <table className="w-full text-[11px] border-collapse">
                  <thead className="sticky top-0 bg-hacker-surface">
                    <tr className="text-hacker-text-dim border-b border-hacker-border">
                      <th className="text-left py-1 pr-3 font-medium">
                        {effectiveGroupBy === "model" ? "Modèle" : "Période"}
                      </th>
                      <th className="text-right py-1 px-2 font-medium w-[70px]">
                        Input
                      </th>
                      <th className="text-right py-1 px-2 font-medium w-[70px]">
                        Output
                      </th>
                      <th className="text-right py-1 pl-2 font-medium w-[70px]">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {bars.map((b) => (
                      <tr
                        key={b.key}
                        className="border-b border-hacker-border/20 hover:bg-hacker-bg/30"
                      >
                        <td className="py-1 pr-3 text-hacker-text">
                          {b.label}
                        </td>
                        <td className="text-right py-1 px-2 text-hacker-accent font-mono">
                          {formatTokens(b.inputTokens)}
                        </td>
                        <td className="text-right py-1 px-2 text-hacker-info font-mono">
                          {formatTokens(b.outputTokens)}
                        </td>
                        <td className="text-right py-1 pl-2 text-hacker-text-bright font-mono">
                          {formatTokens(b.inputTokens + b.outputTokens)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
