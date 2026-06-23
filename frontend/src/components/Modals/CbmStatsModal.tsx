import { useState, useEffect, useCallback } from "react";
import { X, RefreshCw, FolderOpen, Code, FileText, Image, Settings, AlertTriangle } from "lucide-react";

interface Props {
  onClose: () => void;
}

interface CodeFile {
  path: string;
  name: string;
  extension: string;
  lang: string;
  lines: number;
  size: number;
  category: string;
}

interface CodeStats {
  totalCodeFiles: number;
  totalLines: number;
  totalCodeLines: number;
  totalBlank: number;
  totalSize: number;
  langStats: { lang: string; files: number; lines: number; blank: number; codeLines: number }[];
  topFiles: { path: string; name: string; lang: string; lines: number; size: number }[];
  files: CodeFile[];
  scanTimeMs: number;
}

const LANG_COLORS: Record<string, string> = {
  TypeScript: "#3178c6", JavaScript: "#f7df1e", Python: "#3776ab",
  HTML: "#e34c26", CSS: "#563d7c", SCSS: "#cd6799", Sass: "#a53b70",
  Less: "#1e5b5e", Vue: "#41b883", Svelte: "#ff3e00",
  JSON: "#999", YAML: "#cb171e", TOML: "#9c4221",
  Markdown: "#083fa1", SQL: "#e38c00", Shell: "#89e051",
  Dockerfile: "#0db7ed", Go: "#00add8", Rust: "#dea584",
  Java: "#ed8b00", Kotlin: "#7f52ff", C: "#555", "C++": "#f34b7d",
  "C#": "#178600", Swift: "#f05138", Ruby: "#cc342d",
  PHP: "#4f5d95", Lua: "#000080", R: "#198ce7",
  Dart: "#00b4ab", Zig: "#ec915c", Elm: "#60b5cc",
  Unknown: "#666",
};

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

// ── Bar chart ──────────────────────────────────────────

function BarChart({ data, maxLabel }: { data: { label: string; value: number; color?: string }[]; maxLabel: string }) {
  if (!data.length) return null;
  const max = data[0].value || 1;
  return (
    <div className="space-y-2">
      {data.map((d, i) => {
        const pct = (d.value / max) * 100;
        return (
          <div key={i}>
            <div className="flex justify-between text-[11px] mb-0.5">
              <span className="font-semibold truncate max-w-[180px]">{d.label}</span>
              <span className="text-hacker-text-dim">{formatNum(d.value)} {maxLabel}</span>
            </div>
            <div className="h-1.5 rounded-full bg-hacker-border/40 overflow-hidden">
              <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: d.color || "var(--hacker-accent)" }} />
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
  const [projects, setProjects] = useState<{ name: string; cwd: string }[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [stats, setStats] = useState<CodeStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState("lines");
  const [sortDir, setSortDir] = useState(-1);
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState<"code" | "asset" | "config" | "all">("code");

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      const data = await res.json();
      const list = (Array.isArray(data) ? data : data.projects || data.data || [])
        .filter((p: any) => p.cwd)
        .map((p: any) => ({ name: p.name || p.id, cwd: p.cwd }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));
      setProjects(list);
      // Select all by default
      setSelectedPaths(list.map((p: { cwd: string }) => p.cwd));
    } catch {}
  }, []);

  const loadStats = useCallback(async (paths: string[]) => {
    if (!paths.length) return;
    setLoading(true);
    setError(null);
    try {
      // Aggregate stats for selected projects
      const results = await Promise.all(
        paths.map(async cwd => {
          try {
            const res = await fetch("/api/cbm/code-stats", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: cwd }),
            });
            if (!res.ok) return null;
            const data = await res.json();
            data._projectName = projects.find(p => p.cwd === cwd)?.name || cwd.split("/").pop();
            return data;
          } catch { return null; }
        })
      );
      const valid = results.filter(Boolean);
      if (valid.length === 0) throw new Error("Aucun projet accessible");

      // Merge
      const merged: CodeStats = {
        totalCodeFiles: 0,
        totalLines: 0,
        totalCodeLines: 0,
        totalBlank: 0,
        totalSize: 0,
        scanTimeMs: 0,
        langStats: [],
        topFiles: [],
        files: [],
      };
      const langMap: Record<string, { files: number; lines: number; blank: number; codeLines: number }> = {};
      const allTopFiles: { path: string; name: string; lang: string; lines: number; size: number }[] = [];

      for (const r of valid) {
        merged.totalCodeFiles += r.totalCodeFiles || 0;
        merged.totalLines += r.totalLines || 0;
        merged.totalCodeLines += r.totalCodeLines || 0;
        merged.totalBlank += r.totalBlank || 0;
        merged.totalSize += r.totalSize || 0;
        merged.scanTimeMs += r.scanTimeMs || 0;
        for (const l of r.langStats || []) {
          if (!langMap[l.lang]) langMap[l.lang] = { files: 0, lines: 0, blank: 0, codeLines: 0 };
          langMap[l.lang].files += l.files;
          langMap[l.lang].lines += l.lines;
          langMap[l.lang].blank += l.blank;
          langMap[l.lang].codeLines += l.codeLines;
        }
        for (const f of r.topFiles || []) {
          const prefix = r._projectName ? `${r._projectName}/` : "";
          allTopFiles.push({ ...f, path: `${prefix}${f.path}` });
        }
        if (r.files) merged.files.push(...r.files);
      }

      merged.langStats = Object.entries(langMap)
        .sort(([, a], [, b]) => b.lines - a.lines)
        .map(([lang, s]) => ({ lang, ...s }));
      merged.topFiles = allTopFiles.sort((a, b) => b.lines - a.lines).slice(0, 15);

      setStats(merged);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projects]);

  // Load stats whenever selected projects change
  useEffect(() => {
    if (selectedPaths.length > 0) loadStats(selectedPaths);
  }, [selectedPaths, loadStats]);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  // File list with sorting + filtering
  const fileList = (stats?.files || [])
    .filter(f => filterCat === "all" || f.category === filterCat)
    .filter(f => search === "" || f.path.toLowerCase().includes(search.toLowerCase()) || f.lang.toLowerCase().includes(search.toLowerCase()));

  const sortedFiles = [...fileList].sort((a, b) => {
    let va: any, vb: any;
    switch (sortCol) {
      case "name": va = a.name.toLowerCase(); vb = b.name.toLowerCase(); return sortDir * va.localeCompare(vb);
      case "ext": va = a.extension; vb = b.extension; return sortDir * va.localeCompare(vb);
      case "size": va = a.size; vb = b.size; break;
      default: va = a.lines; vb = b.lines;
    }
    return sortDir * (va - vb);
  });

  const handleSort = (col: string) => {
    if (sortCol === col) setSortDir(d => -d);
    else { setSortCol(col); setSortDir(-1); }
  };

  const catCount = (cat: string) => stats?.files.filter(f => f.category === cat).length || 0;

  const projectLabel = (p: { name: string }) => p.name;

  return (
    <div className="fixed inset-0 z-50 bg-hacker-bg/95 flex flex-col overflow-hidden" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-hacker-border-bright bg-hacker-surface shrink-0">
        <div className="flex items-center gap-2">
          <Code size={16} className="text-hacker-accent" />
          <span className="text-hacker-accent text-xs font-bold tracking-widest">CODE STATS</span>
          {stats && (
            <span className="text-hacker-text-dim text-[10px] ml-2">
              {(stats.scanTimeMs / 1000).toFixed(1)}s
            </span>
          )}
        </div>
        <button onClick={() => loadStats(selectedPaths)} disabled={loading} className="text-hacker-text-dim hover:text-hacker-accent p-1" title="Refresh">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 max-w-6xl mx-auto w-full">
        {error ? (
          <div className="text-hacker-error text-sm text-center py-12">
            <AlertTriangle size={32} className="mx-auto mb-3 opacity-60" />
            <p className="font-bold mb-1">Erreur</p>
            <p className="text-xs text-hacker-text-dim">{error}</p>
          </div>
        ) : (
          <>
            {/* Project selector — multi-select with Ctrl/Shift */}
            <div className="flex gap-1 flex-wrap mb-2">
              <button onClick={() => {
                if (selectedPaths.length === projects.length) setSelectedPaths([]);
                else setSelectedPaths(projects.map(p => p.cwd));
              }}
                className={`text-xs px-3 py-1.5 rounded border font-semibold transition-all ${
                  selectedPaths.length === projects.length
                    ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                    : "border-hacker-border text-hacker-text-dim hover:text-hacker-text hover:border-hacker-border-bright"}`}
              >📋 Tout</button>
              {projects.map(p => {
                const isSelected = selectedPaths.includes(p.cwd);
                const idx = projects.indexOf(p);
                const handleClick = (e: React.MouseEvent) => {
                  if (e.ctrlKey || e.metaKey) {
                    // Toggle this project
                    setSelectedPaths(prev =>
                      prev.includes(p.cwd)
                        ? prev.filter(c => c !== p.cwd)
                        : [...prev, p.cwd]
                    );
                  } else if (e.shiftKey && projects.length > 0) {
                    // Select range from first selected to this
                    const firstIdx = Math.min(
                      idx,
                      Math.max(0, projects.findIndex(x => selectedPaths.includes(x.cwd)))
                    );
                    const lastIdx = Math.max(idx, firstIdx);
                    setSelectedPaths(projects.slice(firstIdx, lastIdx + 1).map(x => x.cwd));
                  } else {
                    // Replace selection with just this one
                    setSelectedPaths([p.cwd]);
                  }
                };
                return (
                  <button key={p.name} onClick={handleClick}
                    className={`text-xs px-3 py-1.5 rounded border font-semibold transition-all ${
                      isSelected
                        ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                        : "border-hacker-border text-hacker-text-dim hover:text-hacker-text hover:border-hacker-border-bright"}`}
                  >{p.name}</button>
                );
              })}
              {selectedPaths.length > 0 && selectedPaths.length < projects.length && (
                <div className="w-full text-[10px] text-hacker-text-dim mt-1">
                  {selectedPaths.length}/{projects.length} projet{selectedPaths.length > 1 ? "s" : ""} sélectionné{selectedPaths.length > 1 ? "s" : ""}
                  {" · "}
                  <button onClick={() => setSelectedPaths(projects.map(p => p.cwd))}
                    className="text-hacker-accent hover:underline"
                  >Tout sélectionner</button>
                </div>
              )}
            </div>

            {loading ? (
              <div className="text-center py-12">
                <div className="animate-pulse text-hacker-text-dim text-xs mb-2">Analyse en cours...</div>
                <div className="text-hacker-text-dim/60 text-[10px]">Scan des fichiers du projet...</div>
              </div>
            ) : stats ? (
              <div className="space-y-4">
                {/* Stats cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <StatCard icon={<FileText size={14} />} value={formatNum(stats.totalCodeFiles)} label="Fichiers code" color="#00d4aa" />
                  <StatCard icon={<Code size={14} />} value={formatNum(stats.totalCodeLines)} label="Lignes de code" color="#f7df1e" />
                  <StatCard icon={<FileText size={14} />} value={formatNum(stats.totalLines)} label="Lignes total" color="#6a4afc" />
                  <StatCard icon={<Image size={14} />} value={formatBytes(stats.totalSize)} label="Taille projet" color="#fc5c7d" />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <StatCard icon={<FileText size={14} />} value={formatNum(stats.totalBlank)} label="Lignes vides" color="#555" />
                  <StatCard icon={<Settings size={14} />} value={`${catCount("config")}`} label="Config" color="#3178c6" />
                </div>

                {/* Languages + Top files */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="bg-hacker-surface/40 border border-hacker-border rounded-lg p-3">
                    <div className="text-hacker-text-dim text-[10px] uppercase tracking-wider font-bold mb-3">Langages</div>
                    <BarChart
                      data={stats.langStats.map(l => ({
                        label: `${l.lang} (${l.files} fichiers)`,
                        value: l.codeLines,
                        color: LANG_COLORS[l.lang] || "#666",
                      }))}
                      maxLabel="lignes"
                    />
                  </div>
                  <div className="bg-hacker-surface/40 border border-hacker-border rounded-lg p-3">
                    <div className="text-hacker-text-dim text-[10px] uppercase tracking-wider font-bold mb-3">Top fichiers</div>
                    <BarChart
                      data={stats.topFiles.map(f => ({
                        label: f.name,
                        value: f.lines,
                        color: LANG_COLORS[f.lang] || "var(--hacker-accent)",
                      }))}
                      maxLabel="lignes"
                    />
                  </div>
                </div>

                {/* Filter tabs */}
                <div className="flex items-center gap-1 flex-wrap border-b border-hacker-border/40 pb-2">
                  {(["code", "asset", "config", "all"] as const).map(cat => (
                    <button key={cat} onClick={() => setFilterCat(cat)}
                      className={`text-[11px] px-3 py-1 rounded-full font-semibold transition-all ${
                        filterCat === cat ? "bg-hacker-accent/15 text-hacker-accent border border-hacker-accent/30"
                        : "text-hacker-text-dim hover:text-hacker-text"}`}
                    >
                      {cat === "code" && "💻 "}{cat === "asset" && "🖼 "}{cat === "config" && "⚙ "}{cat === "all" && "📋 "}
                      {cat === "all" ? "Tout" : cat.charAt(0).toUpperCase() + cat.slice(1)}
                      <span className="ml-1 text-hacker-text-dim/60">({cat === "all" ? stats.files.length : catCount(cat)})</span>
                    </button>
                  ))}
                  <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                    placeholder="Rechercher…"
                    className="ml-auto bg-hacker-bg border border-hacker-border text-hacker-text text-xs px-2 py-1 rounded w-32 focus:border-hacker-accent outline-none"
                  />
                </div>

                {/* File table */}
                <div className="bg-hacker-surface/40 border border-hacker-border rounded-lg overflow-hidden">
                  <div className="max-h-96 overflow-y-auto">
                    <table className="w-full text-[11px] border-collapse">
                      <thead className="sticky top-0 bg-hacker-surface z-10">
                        <tr className="text-hacker-text-dim text-[10px] uppercase tracking-wider">
                          <th className="text-left p-2 cursor-pointer hover:text-hacker-text" onClick={() => handleSort("name")}>
                            Fichier {sortCol === "name" && <span className="text-hacker-accent">{sortDir === -1 ? "▼" : "▲"}</span>}
                          </th>
                          <th className="text-left p-2 cursor-pointer hover:text-hacker-text" onClick={() => handleSort("ext")}>
                            Type {sortCol === "ext" && <span className="text-hacker-accent">{sortDir === -1 ? "▼" : "▲"}</span>}
                          </th>
                          <th className="text-right p-2 cursor-pointer hover:text-hacker-text w-16" onClick={() => handleSort("lines")}>
                            Lignes {sortCol === "lines" && <span className="text-hacker-accent">{sortDir === -1 ? "▼" : "▲"}</span>}
                          </th>
                          <th className="text-right p-2 cursor-pointer hover:text-hacker-text w-16" onClick={() => handleSort("size")}>
                            Taille {sortCol === "size" && <span className="text-hacker-accent">{sortDir === -1 ? "▼" : "▲"}</span>}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedFiles.slice(0, 500).map((f, i) => (
                          <tr key={i} className="border-t border-hacker-border/20 hover:bg-hacker-border/20">
                            <td className="p-2 font-semibold truncate max-w-[300px]" title={f.path}>{f.name}</td>
                            <td className="p-2">
                              <span className="px-1.5 py-0.5 rounded text-[10px]" style={{ background: `${LANG_COLORS[f.lang] || "#666"}22`, color: LANG_COLORS[f.lang] || "#666" }}>
                                {f.extension || "—"}
                              </span>
                            </td>
                            <td className="p-2 text-right text-hacker-text-dim">
                              {f.category === "asset" ? "—" : formatNum(f.lines)}
                            </td>
                            <td className="p-2 text-right text-hacker-text-dim">{formatBytes(f.size)}</td>
                          </tr>
                        ))}
                        {sortedFiles.length > 500 && (
                          <tr><td colSpan={4} className="p-3 text-center text-hacker-text-dim text-[10px]">
                            {sortedFiles.length - 500} fichiers supplémentaires (filtrer pour affiner)
                          </td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}