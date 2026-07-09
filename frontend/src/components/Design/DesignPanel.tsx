import { useState, useRef, useCallback, useEffect } from "react";
import { DesignCanvas } from "./DesignCanvas";
import { Toolbar } from "./Toolbar";
import { ExportModal } from "./ExportModal";

interface DesignPanelProps {
  projectId?: string;
  designId?: string;
}

interface DesignListItem {
  id: string;
  name: string;
  updatedAt: string;
}

export function DesignPanel({ projectId, designId }: DesignPanelProps) {
  const [designs, setDesigns] = useState<DesignListItem[]>([]);
  const [currentDesign, setCurrentDesign] = useState<{
    id: string;
    name: string;
    html: string;
    css: string;
  } | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [mode, setMode] = useState<"selector" | "editor">("selector");
  const [showExport, setShowExport] = useState(false);
  const [htmlContent, setHtmlContent] = useState("");
  const [cssContent, setCssContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<any>(null);

  // Track editor content for export
  const exportHtmlRef = useRef("");
  const exportCssRef = useRef("");

  // ── Load design list ──
  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    fetch(`/api/design?projectId=${projectId}`)
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load designs");
        return r.json();
      })
      .then((data: DesignListItem[]) => {
        setDesigns(data);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, [projectId]);

  // ── Load specific design ──
  const loadDesign = useCallback(
    async (id: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/design/${id}`);
        if (!res.ok) throw new Error("Failed to load design");
        const data = await res.json();
        setCurrentDesign({
          id: data.id,
          name: data.name,
          html: data.html || "",
          css: data.css || "",
        });
        setHtmlContent(data.html || "");
        setCssContent(data.css || "");
        setIsDirty(false);
        setMode("editor");
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // ── Save design ──
  const handleSave = useCallback(async () => {
    if (!currentDesign || !currentDesign.id) return;
    const html = editorRef.current?.getHtml?.() ?? htmlContent;
    const css = editorRef.current?.getCss?.() ?? cssContent;
    try {
      const res = await fetch(`/api/design/${currentDesign.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html, css }),
      });
      if (!res.ok) throw new Error("Failed to save");
      setIsDirty(false);
      setHtmlContent(html);
      setCssContent(css);
    } catch (err: any) {
      setError(err.message);
    }
  }, [currentDesign, htmlContent, cssContent]);

  // ── Export ──
  const handleExport = useCallback(() => {
    const html = editorRef.current?.getHtml?.() ?? htmlContent;
    const css = editorRef.current?.getCss?.() ?? cssContent;
    exportHtmlRef.current = html;
    exportCssRef.current = css;
    setShowExport(true);
  }, [htmlContent, cssContent]);

  // ── Undo / Redo ──
  const handleUndo = useCallback(() => {
    editorRef.current?.UndoManager?.undo?.();
  }, []);

  const handleRedo = useCallback(() => {
    editorRef.current?.UndoManager?.redo?.();
  }, []);

  // ── Preview ──
  const handlePreview = useCallback(() => {
    const html = editorRef.current?.getHtml?.() ?? htmlContent;
    const css = editorRef.current?.getCss?.() ?? cssContent;
    const full = `<!DOCTYPE html><html><head><style>${css}</style></head><body>${html}</body></html>`;
    const win = window.open("", "_blank");
    if (win) {
      win.document.write(full);
      win.document.close();
    }
  }, [htmlContent, cssContent]);

  // ── Back to selector ──
  const handleBack = useCallback(() => {
    setMode("selector");
    setCurrentDesign(null);
    setHtmlContent("");
    setCssContent("");
    setIsDirty(false);
  }, []);

  // ── Editor ready ──
  const handleEditorReady = useCallback((editor: any) => {
    editorRef.current = editor;
  }, []);

  // ── Editor change ──
  const handleEditorChange = useCallback((html: string, css: string) => {
    setHtmlContent(html);
    setCssContent(css);
    setIsDirty(true);
  }, []);

  // ── Render ──
  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-hacker-error text-sm font-mono p-4">
        {error}
      </div>
    );
  }

  if (loading && !currentDesign) {
    return (
      <div className="h-full flex items-center justify-center text-hacker-text-dim text-sm font-mono">
        Loading...
      </div>
    );
  }

  // ── Selector mode ──
  if (mode === "selector") {
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between px-3 h-10 border-b border-hacker-accent/20 bg-hacker-surface shrink-0">
          <span className="text-xs font-bold text-hacker-accent tracking-wider">
            DESIGN PROJECTS
          </span>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {designs.length === 0 && !loading && (
            <div className="text-hacker-muted text-sm text-center mt-8">
              No designs yet. Create one via API or select a project.
            </div>
          )}
          {designs.map((d) => (
            <button
              key={d.id}
              onClick={() => loadDesign(d.id)}
              className="w-full text-left px-3 py-2 mb-1 border border-hacker-border rounded hover:bg-hacker-accent/5 hover:border-hacker-accent/40 transition-colors"
            >
              <div className="text-sm font-bold text-hacker-text">{d.name}</div>
              <div className="text-[10px] text-hacker-text-dim mt-0.5">
                {new Date(d.updatedAt).toLocaleString()}
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Editor mode ──
  return (
    <div className="h-full flex flex-col">
      <Toolbar
        onBack={handleBack}
        onSave={handleSave}
        onExport={handleExport}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onPreview={handlePreview}
        isDirty={isDirty}
      />
      <div className="flex-1 overflow-hidden">
        <DesignCanvas
          html={currentDesign?.html}
          css={currentDesign?.css}
          onChange={handleEditorChange}
          onReady={handleEditorReady}
        />
      </div>

      {/* Export modal */}
      {showExport && (
        <ExportModal
          html={exportHtmlRef.current}
          css={exportCssRef.current}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}
