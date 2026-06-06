import { useState, useEffect, useCallback, useMemo } from "react";
import { BarChart3, X, Calendar, Brain, Hash, BarChart2, PieChart as PieIcon, TrendingUp } from "lucide-react";
import { Bar, Pie, Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";
import { useTranslation } from "../../i18n";
import { ModalDialog } from "../common/ModalDialog";

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
);

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
type ChartType = "bar" | "line" | "pie";

const COLORS = {
  input: "#4ade80",  // green
  output: "#60a5fa", // blue
};

const CHART_TYPES: { type: ChartType; icon: typeof BarChart2; label: string }[] = [
  { type: "bar", icon: BarChart2, label: "Barres" },
  { type: "line", icon: TrendingUp, label: "Ligne" },
  { type: "pie", icon: PieIcon, label: "Camembert" },
];

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
    case "today": return { from: to, to };
    case "week": from.setDate(now.getDate() - 7); return { from: from.toISOString().slice(0, 10), to };
    case "month": from.setMonth(now.getMonth() - 1); return { from: from.toISOString().slice(0, 10), to };
    case "all": return { from: "2024-01-01", to };
  }
}

function getGroupByForPeriod(period: Period, groupBy: GroupBy): GroupBy {
  if (groupBy === "hour" && period === "today") return "hour";
  if (groupBy === "hour") return "day";
  return groupBy;
}

// ── Chart data builders ──────────────────────────────

function buildBarOrLineData(buckets: UsageBucket[], chartType: ChartType) {
  const labels = buckets.map((b) => b.label);
  const totals = buckets.map((b) => b.inputTokens + b.outputTokens);

  if (chartType === "bar") {
    return {
      labels,
      datasets: [
        { label: "Input", data: buckets.map((b) => b.inputTokens), backgroundColor: COLORS.input, stack: "tokens" },
        { label: "Output", data: buckets.map((b) => b.outputTokens), backgroundColor: COLORS.output, stack: "tokens" },
      ],
    };
  }
  // line
  return {
    labels,
    datasets: [
      {
        label: "Total tokens",
        data: totals,
        borderColor: COLORS.input,
        backgroundColor: "rgba(74, 222, 128, 0.15)",
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointHoverRadius: 6,
      },
    ],
  };
}

function buildPieData(buckets: UsageBucket[]) {
  // Aggregate by label so we don't end up with 50 slices
  const agg: Record<string, number> = {};
  for (const b of buckets) {
    agg[b.label] = (agg[b.label] || 0) + b.inputTokens + b.outputTokens;
  }
  const labels = Object.keys(agg);
  const data = Object.values(agg);
  // Cycle through a few distinct colors for slices
  const palette = ["#4ade80", "#60a5fa", "#fbbf24", "#f87171", "#a78bfa", "#34d399", "#fb923c", "#22d3ee", "#e879f9"];
  const backgroundColor = labels.map((_, i) => palette[i % palette.length]);
  return {
    labels,
    datasets: [{ data, backgroundColor, borderColor: "#0a0a0a", borderWidth: 2 }],
  };
}

const baseChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { labels: { color: "#a0a0a0", font: { size: 11 } } },
    tooltip: {
      backgroundColor: "#0a0a0a",
      borderColor: "#4ade80",
      borderWidth: 1,
      titleColor: "#4ade80",
      bodyColor: "#e0e0e0",
      padding: 10,
      callbacks: {
        label: (ctx: any) => {
          const v = ctx.parsed.y ?? ctx.parsed;
          return `${ctx.dataset.label || ctx.label}: ${formatTokens(v)}`;
        },
      },
    },
  },
  scales: {
    x: { ticks: { color: "#808080", font: { size: 10 } }, grid: { color: "rgba(128,128,128,0.08)" } },
    y: { ticks: { color: "#808080", font: { size: 10 }, callback: (v: any) => formatTokens(v) }, grid: { color: "rgba(128,128,128,0.08)" } },
  },
};

const pieOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { position: "right" as const, labels: { color: "#a0a0a0", font: { size: 11 } } },
    tooltip: {
      backgroundColor: "#0a0a0a",
      borderColor: "#4ade80",
      borderWidth: 1,
      titleColor: "#4ade80",
      bodyColor: "#e0e0e0",
      padding: 10,
    },
  },
};

// ── Main Modal ─────────────────────────────────────────

export function UsageStatsModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<Period>("week");
  const [groupBy, setGroupBy] = useState<GroupBy>("day");
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const effectiveGroupBy = getGroupByForPeriod(period, groupBy);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = getDateRange(period);
      const res = await fetch(`/api/usage?from=${from}&to=${to}&groupBy=${effectiveGroupBy}`);
      if (res.ok) setData(await res.json());
    } catch {
      setData(null);
    }
    setLoading(false);
  }, [period, effectiveGroupBy]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const bars = data?.buckets || [];
  const hasData = bars.length > 0;

  const chartData = useMemo(() => {
    if (!hasData) return null;
    return chartType === "pie" ? buildPieData(bars) : buildBarOrLineData(bars, chartType);
  }, [bars, chartType, hasData]);

  return (
    <ModalDialog id="usage-stats" onClose={onClose}>
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-hacker-border">
          <div className="flex items-center gap-2 text-hacker-accent font-bold text-sm">
            <BarChart3 size={16} />
            {t('usage.title')}
          </div>
          <button
            onClick={onClose}
            className="text-hacker-text-dim hover:text-hacker-accent"
          >
            <X size={16} />
          </button>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-hacker-border/50">
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
                title={disabled ? t('usage.hourDisabled') : undefined}
              >
                {g === "hour" ? t('usage.hour') : g === "day" ? t('usage.day') : t('usage.model')}
              </button>
            );
          })}

          <span className="text-hacker-border/30 mx-1">│</span>

          {/* Chart type */}
          <span className="text-[10px] text-hacker-text-dim uppercase tracking-wide">Type</span>
          {CHART_TYPES.map(({ type, icon: Icon, label }) => (
            <button
              key={type}
              onClick={() => setChartType(type)}
              className={`text-[10px] px-2 py-0.5 rounded border transition-colors flex items-center gap-1 ${
                chartType === type
                  ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                  : "border-transparent text-hacker-text-dim hover:text-hacker-text hover:border-hacker-border"
              }`}
            >
              <Icon size={10} />
              {label}
            </button>
          ))}
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
          ) : !hasData ? (
            <div className="flex items-center justify-center py-12 text-hacker-text-dim text-sm">
              <Brain size={14} className="mr-2" />
              Aucune donnée pour cette période
            </div>
          ) : (
            <>
              {/* Chart */}
              <div style={{ height: "380px" }}>
                {chartType === "bar" && <Bar data={chartData!} options={baseChartOptions as any} />}
                {chartType === "line" && <Line data={chartData!} options={baseChartOptions as any} />}
                {chartType === "pie" && <Pie data={chartData!} options={pieOptions as any} />}
              </div>

              {/* Totals */}
              <div className="flex flex-wrap gap-4 mt-4 pt-2 border-t border-hacker-border/50 text-xs">
                <span className="text-hacker-text-dim">
                  Total input: <span className="text-hacker-accent">{formatTokens(data.totalInput)}</span>
                </span>
                <span className="text-hacker-text-dim">
                  Total output: <span className="text-hacker-accent">{formatTokens(data.totalOutput)}</span>
                </span>
                <span className="text-hacker-text-dim">
                  Total: <span className="text-hacker-accent font-bold">{formatTokens(data.totalTokens)}</span>
                </span>
              </div>

              {/* Table */}
              <div className="mt-3 max-h-[200px] overflow-auto">
                <table className="w-full text-[11px] border-collapse">
                  <thead className="sticky top-0 bg-hacker-surface">
                    <tr className="text-hacker-text-dim border-b border-hacker-border">
                      <th className="text-left py-1 pr-3 font-medium">
                        {effectiveGroupBy === "model" ? t('usage.model') : t('usage.period')}
                      </th>
                      <th className="text-right py-1 px-2 font-medium w-[70px]">{t('usage.inputTokens')}</th>
                      <th className="text-right py-1 px-2 font-medium w-[70px]">{t('usage.outputTokens')}</th>
                      <th className="text-right py-1 pl-2 font-medium w-[70px]">{t('usage.totalTokens')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bars.map((b) => (
                      <tr key={b.key} className="border-b border-hacker-border/20 hover:bg-hacker-bg/30">
                        <td className="py-1 pr-3 text-hacker-text">{b.label}</td>
                        <td className="text-right py-1 px-2 text-hacker-accent font-mono">{formatTokens(b.inputTokens)}</td>
                        <td className="text-right py-1 px-2 text-hacker-info font-mono">{formatTokens(b.outputTokens)}</td>
                        <td className="text-right py-1 pl-2 text-hacker-text-bright font-mono">{formatTokens(b.inputTokens + b.outputTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </ModalDialog>
  );
}
