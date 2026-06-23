import { useState, useEffect, useCallback } from "react";
import { X, RefreshCw, Database, GitBranch, Network, Zap, Activity } from "lucide-react";

interface Props {
  onClose: () => void;
}

// ── Types ──────────────────────────────────────────────

interface CbmProject {
  name: string;
  root_path: string;
  nodes: number;
  edges: number;
  size_bytes: number;
}

interface NodeLabel {
  label: string;
  count: number;
}

interface EdgeType {
  type: string;
  count: number;
}

interface ArchData {
  project: string;
  total_nodes: number;
  total_edges: number;
  node_labels: NodeLabel[];
  edge_types: EdgeType[];
  languages: { language: string; file_count: number }[];
  hotspots: { name: string; qualified_name: string; fan_in: number }[];
  clusters: { id: number; label: string; members: number; cohesion: number; top_nodes: string[] }[];
}

interface UsageStats {
  totalCalls: number;
  totalErrors: number;
  byTool: Record<string, { ok: number; fail: number }>;
  byMode: Record<string, number>;
  indexedProjects: number;
  since: string;
}

// ── Colors ─────────────────────────────────────────────

const NODE_COLORS: Record<string, string> = {
  Function: "#00d4aa", Method: "#00b894", Class: "#6a4afc", Interface: "#7c5cfc",
  Route: "#fc5c7d", Variable: "#f7df1e", Module: "#3178c6", File: "#555",
  Folder: "#888", Type: "#e84393", Channel: "#fd79a8", Section: "#a29bfe",
  Project: "#fff", Enum: "#00cec9", Struct: "#e17055",
};

const EDGE_COLORS: Record<string, string> = {
  CALLS: "#00d4aa", DEFINES: "#6a4afc", IMPORTS: "#3178c6", USAGE: "#f7df1e",
  HTTP_CALLS: "#fc5c7d", CONTAINS_FILE: "#555", CONTAINS_FOLDER: "#888",
  SEMANTICALLY_RELATED: "#a29bfe", SIMILAR_TO: "#fd79a8", FILE_CHANGES_WITH: "#e17055",
  DEFINES_METHOD: "#00b894", HANDLES: "#fdcb6e", WRITES: "#e84393",
  LISTENS_ON: "#a29bfe", RAISES: "#ff7675", ASYNC_CALLS: "#74b9ff",
};

function getColor(map: Record<string, string>, key: string): string {
  return map[key] || "#666";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / 1048576).toFixed(1)} Mo`;
}

function formatNum(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString("fr-FR");
}

// ── Donut chart ────────────────────────────────────────

function DonutChart({ data, total }: { data: { name: string; count: number; color: string }[]; total: number }) {
  if (!data.length || total === 0) return <div className="text-hacker-text-dim text-xs text-center py-8">Aucune donnée</div>;

  const top = data.slice(0, 8);
  const otherCount = data.slice(8).reduce((s, d) => s + d.count, 0);
  if (otherCount > 0) top.push({ name: "Autres", count: otherCount, color: "#666" });

  const R = 60;
  const C = 2 * Math.PI * R;
  let offset = 0;

  return (
    <div className="flex items-center gap-4 flex-wrap">
      <svg width="140" height="140" viewBox="0 0 140 140">
        <circle cx="70" cy="70" r={R} fill="none" stroke="var(--hacker-border)" strokeWidth="14" />
        {top.map((d, i) => {
          const pct = (d.count / total) * 100;
          const len = (pct / 100) * C;
          const arc = (
            <circle
              key={i}
              cx="70" cy="70" r={R} fill="none"
              stroke={d.color} strokeWidth="14"
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={-offset}
              style={{ transition: "stroke-dasharray 0.6s ease" }}
            />
          );
          offset += len;
          return arc;
        })}
        <text x="70" y="66" textAnchor="middle" fill="var(--hacker-text-bright)" fontSize="14" fontWeight="700">
          {formatNum(total)}
        </text>
        <text x="70" y="80" textAnchor="middle" fill="var(--hacker-text-dim)" fontSize="8">total</text>
      </svg>
      <div className="flex flex-col gap-1 flex-1 min-w-[140px]">
        {top.map((d, i) => {
          const pct = ((d.count / total) * 100).toFixed(1);
          return (
            <div key={i} className="flex items-center gap-2 text-[11px] px-1.5 py-0.5 rounded hover:bg-hacker-border/30">
              <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: d.color }} />
              <span className="flex-1 font-semibold truncate">{d.name}</span>
              <span className="text-hacker-text-dim">{pct}%</span>
              <span className="text-hacker-text-dim/60 w-10 text-right">{formatNum(d.count)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Bar chart ──────────────────────────────────────────

function BarChart({ data }: { data: { name: string; count: number; color: string }[] }) {
  if (!data.length) return <div className="text-hacker-text-dim text-xs text-center py-8">Aucune donnée</div>;
  const max = data[0].count || 1;
  return (
    <div className="flex flex-col gap-2">
      {data.map((d, i) => {
        const pct = (d.count / max) * 100;
        return (
          <div key={i}>
            <div className="flex justify-between items-center text-[11px] mb-0.5">
              <span className="font-semibold truncate max-w-[180px]" title={d.name}>{d.name}</span>
              <span className="text-hacker-text-dim">{formatNum(d.count)}</span>
            </div>
            <div className="h-1.5 rounded-full bg-hacker-border/40 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{ width: `${pct}%`, background: d.color }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Stat card ──────────────────────────────────────────

function StatCard({ icon, value, label, color }: { icon: React.ReactNode; value: string; label: string; color: string }) {
  return (
    <div className="relative bg-hacker-surface/60 border border-hacker-border rounded-lg p-3 overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-0.5" style={{ background: `linear-gradient(90deg, ${color}, transparent)` }} />
      <div className="flex items-center gap-1.5 mb-1" style={{ color }}>{icon}</div>
      <div className="text-lg font-bold text-hacker-text-bright leading-none mb-0.5">{value}</div>
      <div className="text-[10px] text-hacker-text-dim uppercase tracking-wide font-semibold">{label}</div>
    </div>
  );
}

// ── Main modal ─────────────────────────────────────────

export function CbmStatsModal({ onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<CbmProject[]>([]);
  const [archData, setArchData] = useState<Record<string, ArchData>>({});
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 1. List projects
      const projRes = await fetch("/rpc", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_projects", arguments: {} } }),
      });
      const projData = await projRes.json();
      const projText = projData?.result?.content?.[0]?.text || "[]";
      const projList: CbmProject[] = JSON.parse(projText).projects || [];
      setProjects(projList);

      // 2. Fetch architecture for each project
      const archPromises = projList.map(async (p) => {
        const res = await fetch("/rpc", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_architecture", arguments: { project: p.name } } }),
        });
        const data = await res.json();
        const text = data?.result?.content?.[0]?.text || "{}";
        return { name: p.name, data: JSON.parse(text) as ArchData };
      });
      const archResults = await Promise.all(archPromises);
      const archMap: Record<string, ArchData> = {};
      archResults.forEach(r => { archMap[r.name] = r.data; });
      setArchData(archMap);

      // 3. Fetch usage stats
      const usageRes = await fetch("/api/cbm/status");
      const usageData = await usageRes.json();
      setUsage(usageData.usage || null);

      // 4. Auto-select first project
      if (projList.length > 0) setSelectedProject(projList[0].name);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Aggregate stats across all projects ──
  const globalStats = {
    totalNodes: projects.reduce((s, p) => s + p.nodes, 0),
    totalEdges: projects.reduce((s, p) => s + p.edges, 0),
    totalSize: projects.reduce((s, p) => s + p.size_bytes, 0),
    totalProjects: projects.length,
  };

  // ── Current project data ──
  const currentArch = selectedProject ? archData[selectedProject] : null;
  const currentProject = projects.find(p => p.name === selectedProject);

  return (
    <div
      className="fixed inset-0 z-50 bg-hacker-bg/95 flex flex-col overflow-hidden"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-hacker-border-bright bg-hacker-surface shrink-0">
        <div className="flex items-center gap-2">
          <Database size={16} className="text-hacker-accent" />
          <span className="text-hacker-accent text-xs font-bold tracking-widest">CBM STATS</span>
          {usage && (
            <span className="text-hacker-text-dim text-[10px] ml-2">
              depuis le {new Date(usage.since).toLocaleDateString("fr-FR")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchData} disabled={loading} className="text-hacker-text-dim hover:text-hacker-accent p-1" title="Refresh">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={onClose} className="text-hacker-text-dim hover:text-hacker-error p-1" title="Close">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {error ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-hacker-error text-sm text-center">
              <p className="font-bold mb-2">Erreur</p>
              <p className="text-xs">{error}</p>
              <button onClick={fetchData} className="btn-hacker mt-4 text-xs px-4 py-2">Retry</button>
            </div>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-hacker-text-dim text-xs animate-pulse">Chargement des stats...</div>
          </div>
        ) : projects.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Database size={48} className="text-hacker-text-dim/30 mx-auto mb-4" />
              <p className="text-hacker-text-dim text-sm">Aucun projet indexé</p>
              <p className="text-hacker-text-dim/60 text-xs mt-1">Démarre une session Pi pour indexer un projet</p>
            </div>
          </div>
        ) : (
          <div className="p-4 space-y-4 max-w-6xl mx-auto">
            {/* ── Global stats ── */}
            <div>
              <div className="text-hacker-text-dim text-[10px] uppercase tracking-wider font-bold mb-2">Vue globale</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <StatCard icon={<Database size={14} />} value={formatNum(globalStats.totalNodes)} label="Nœuds (total)" color="#00d4aa" />
                <StatCard icon={<Network size={14} />} value={formatNum(globalStats.totalEdges)} label="Arêtes (total)" color="#6a4afc" />
                <StatCard icon={<Database size={14} />} value={`${globalStats.totalProjects}`} label="Projets indexés" color="#fc5c7d" />
                <StatCard icon={<Activity size={14} />} value={formatBytes(globalStats.totalSize)} label="Taille index" color="#3178c6" />
              </div>
            </div>

            {/* ── Usage stats ── */}
            {usage && usage.totalCalls + usage.totalErrors > 0 && (
              <div className="bg-hacker-surface/40 border border-hacker-border rounded-lg p-3">
                <div className="text-hacker-text-dim text-[10px] uppercase tracking-wider font-bold mb-2 flex items-center gap-1">
                  <Zap size={12} /> Utilisation des outils CBM
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                  <StatCard icon={<Activity size={14} />} value={formatNum(usage.totalCalls)} label="Appels réussis" color="#00d4aa" />
                  <StatCard icon={<X size={14} />} value={formatNum(usage.totalErrors)} label="Échecs" color="#fc5c7d" />
                  <StatCard icon={<Database size={14} />} value={`${usage.indexedProjects}`} label="Indexations" color="#6a4afc" />
                  <StatCard icon={<Activity size={14} />} value={`${usage.totalCalls + usage.totalErrors > 0 ? Math.round((usage.totalCalls / (usage.totalCalls + usage.totalErrors)) * 100) : 0}%`} label="Taux de succès" color="#3178c6" />
                </div>
                {/* Per-tool breakdown */}
                <div className="space-y-1">
                  {Object.entries(usage.byTool)
                    .sort(([, a], [, b]) => (b.ok + b.fail) - (a.ok + a.fail))
                    .map(([tool, stats]) => {
                      const total = stats.ok + stats.fail;
                      const okPct = total > 0 ? (stats.ok / total) * 100 : 0;
                      return (
                        <div key={tool} className="flex items-center gap-2 text-[11px]">
                          <span className="w-28 font-mono text-hacker-text truncate">{tool}</span>
                          <div className="flex-1 h-3 rounded-full bg-hacker-border/40 overflow-hidden flex">
                            <div className="h-full bg-hacker-accent/60" style={{ width: `${okPct}%` }} />
                            <div className="h-full bg-hacker-error/60" style={{ width: `${100 - okPct}%` }} />
                          </div>
                          <span className="w-20 text-right text-hacker-text-dim">
                            {stats.ok} ok / {stats.fail} fail
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            {/* ── Project selector ── */}
            <div>
              <div className="text-hacker-text-dim text-[10px] uppercase tracking-wider font-bold mb-2">Projet</div>
              <div className="flex gap-1 flex-wrap">
                {projects.map(p => (
                  <button
                    key={p.name}
                    onClick={() => setSelectedProject(p.name)}
                    className={`text-xs px-3 py-1.5 rounded border font-semibold transition-all ${
                      selectedProject === p.name
                        ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                        : "border-hacker-border text-hacker-text-dim hover:text-hacker-text hover:border-hacker-border-bright"
                    }`}
                  >
                    {p.name.replace(/^projects-/, "")}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Per-project details ── */}
            {currentArch && currentProject && (
              <div className="space-y-3">
                {/* Project header */}
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <div className="text-hacker-text-bright text-sm font-bold">{currentProject.name}</div>
                    <div className="text-hacker-text-dim text-[11px] font-mono">{currentProject.root_path}</div>
                  </div>
                  <div className="flex gap-2 text-[11px]">
                    <span className="px-2 py-1 rounded bg-hacker-border/40 text-hacker-text-dim">
                      {formatNum(currentArch.total_nodes)} nœuds
                    </span>
                    <span className="px-2 py-1 rounded bg-hacker-border/40 text-hacker-text-dim">
                      {formatNum(currentArch.total_edges)} arêtes
                    </span>
                    <span className="px-2 py-1 rounded bg-hacker-border/40 text-hacker-text-dim">
                      {formatBytes(currentProject.size_bytes)}
                    </span>
                  </div>
                </div>

                {/* Node labels + Edge types */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="bg-hacker-surface/40 border border-hacker-border rounded-lg p-3">
                    <div className="text-hacker-text-dim text-[10px] uppercase tracking-wider font-bold mb-2">Types de nœuds</div>
                    <DonutChart
                      data={currentArch.node_labels
                        .filter(n => n.label !== "Project")
                        .map(n => ({ name: n.label, count: n.count, color: getColor(NODE_COLORS, n.label) }))
                        .sort((a, b) => b.count - a.count)}
                      total={currentArch.node_labels
                        .filter(n => n.label !== "Project")
                        .reduce((s, n) => s + n.count, 0)}
                    />
                  </div>
                  <div className="bg-hacker-surface/40 border border-hacker-border rounded-lg p-3">
                    <div className="text-hacker-text-dim text-[10px] uppercase tracking-wider font-bold mb-2">Types d'arêtes</div>
                    <BarChart data={currentArch.edge_types
                      .map(e => ({ name: e.type, count: e.count, color: getColor(EDGE_COLORS, e.type) }))
                      .sort((a, b) => b.count - a.count)
                    } />
                  </div>
                </div>

                {/* Languages + Hotspots */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="bg-hacker-surface/40 border border-hacker-border rounded-lg p-3">
                    <div className="text-hacker-text-dim text-[10px] uppercase tracking-wider font-bold mb-2">Langages</div>
                    <div className="flex flex-wrap gap-1.5">
                      {currentArch.languages?.map((lang, i) => (
                        <div key={i} className="flex items-center gap-1.5 px-2 py-1 rounded bg-hacker-border/30 text-[11px]">
                          <span className="font-semibold">{lang.language}</span>
                          <span className="text-hacker-text-dim">{lang.file_count} fichiers</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="bg-hacker-surface/40 border border-hacker-border rounded-lg p-3">
                    <div className="text-hacker-text-dim text-[10px] uppercase tracking-wider font-bold mb-2">Hotspots (fan-in)</div>
                    <div className="space-y-1">
                      {currentArch.hotspots?.slice(0, 8).map((h, i) => (
                        <div key={i} className="flex items-center justify-between text-[11px]">
                          <span className="font-mono text-hacker-text truncate max-w-[200px]" title={h.qualified_name}>
                            {h.name}
                          </span>
                          <span className="text-hacker-warn font-bold">{h.fan_in}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Clusters */}
                {currentArch.clusters && currentArch.clusters.length > 0 && (
                  <div className="bg-hacker-surface/40 border border-hacker-border rounded-lg p-3">
                    <div className="text-hacker-text-dim text-[10px] uppercase tracking-wider font-bold mb-2 flex items-center gap-1">
                      <GitBranch size={12} /> Clusters (modules détectés)
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                      {currentArch.clusters.map((c, i) => (
                        <div key={i} className="bg-hacker-border/20 rounded p-2 text-[11px]">
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-bold text-hacker-accent">{c.label}</span>
                            <span className="text-hacker-text-dim">{c.members} nœuds</span>
                          </div>
                          <div className="text-hacker-text-dim/80 text-[10px]">
                            cohésion: {(c.cohesion * 100).toFixed(0)}%
                          </div>
                          <div className="text-hacker-text-dim/60 text-[10px] mt-1 truncate" title={c.top_nodes.join(", ")}>
                            {c.top_nodes.slice(0, 3).join(", ")}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}