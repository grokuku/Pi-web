import { useState, useEffect, useCallback, useRef } from "react";
import {
  ChevronRight, ChevronDown, Folder, FolderOpen, RefreshCw,
  Image, Code, FileText, Edit3, Save, X, Download, Upload, CheckSquare, Square,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { atomOneDark } from "react-syntax-highlighter/dist/esm/styles/hljs";

interface FileEntry {
  name: string;
  type: "dir" | "file";
  size: number;
}

interface BrowseResult {
  path: string;
  parent: string | null;
  entries: FileEntry[];
}

interface FileContent {
  path: string;
  name: string;
  ext: string;
  size: number;
  content: string;
}

interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  children?: TreeNode[];
  loaded?: boolean;
}

interface Props {
  project: any;
}

// ── Helpers ──
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);
const MARKDOWN_EXTS = new Set([".md", ".mdx", ".markdown"]);
const CODE_EXTS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".vue", ".svelte",
  ".css", ".scss", ".less", ".html", ".xml",
  ".py", ".rb", ".rs", ".go", ".java", ".kt", ".c", ".h", ".cpp", ".hpp",
  ".cs", ".swift", ".dart", ".lua", ".r", ".sql", ".graphql",
  ".json", ".yaml", ".yml", ".toml", ".md",
  ".sh", ".bash", ".zsh", ".fish",
  ".dockerfile", ".gitignore", ".env", ".editorconfig",
  ".cmake", ".gradle", ".ini", ".cfg", ".conf", ".log", ".csv",
]);

const EXT_TO_LANG: Record<string, string> = {
  js: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp",
  swift: "swift", dart: "dart", lua: "lua", r: "r", sql: "sql",
  html: "html", xml: "xml", css: "css", scss: "scss", less: "less",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini",
  sh: "bash", bash: "bash", zsh: "bash", fish: "fish",
  graphql: "graphql", md: "markdown", dockerfile: "dockerfile",
  gitignore: "bash", env: "bash", makefile: "makefile",
  vue: "html", svelte: "html",
};

function getLangFromExt(ext: string): string | undefined {
  const key = ext.replace(".", "").toLowerCase();
  return EXT_TO_LANG[key];
}

function isEditable(ext: string): boolean {
  return CODE_EXTS.has(ext) || MARKDOWN_EXTS.has(ext) || ext === "" || [".txt", ".log", ".csv", ".env"].includes(ext);
}

function getFileIcon(name: string) {
  const ext = name.lastIndexOf(".") >= 0 ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
  if (IMAGE_EXTS.has(ext)) return <Image size={14} className="text-hacker-info shrink-0" />;
  if (CODE_EXTS.has(ext)) return <Code size={14} className="text-hacker-accent shrink-0" />;
  return <FileText size={14} className="text-hacker-text-dim shrink-0" />;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ── Directory Tree Node ──
function DirNode({
  node,
  selectedPaths,
  onSelect,
  onExpand,
  onToggleSelect,
}: {
  node: TreeNode;
  selectedPaths: Set<string>;
  onSelect: (path: string) => void;
  onExpand: (node: TreeNode) => void;
  onToggleSelect: (path: string, type: "dir" | "file") => void;
}) {
  const isExpanded = node.loaded && node.children && node.children.length > 0;
  const isDir = node.type === "dir";
  const isSelected = selectedPaths.has(node.path);

  return (
    <div>
      <div
        className={`flex items-center gap-1 px-1 py-0.5 cursor-pointer hover:bg-hacker-border/50 group ${
          isSelected ? "bg-hacker-accent/10 text-hacker-accent" : "text-hacker-text-dim"
        }`}
        onClick={() => {
          if (isDir) onExpand(node);
          else onSelect(node.path);
        }}
      >
        {/* Checkbox for selection */}
        <span
          className="opacity-0 group-hover:opacity-100 shrink-0"
          onClick={(e) => { e.stopPropagation(); onToggleSelect(node.path, node.type); }}
        >
          {isSelected ? (
            <CheckSquare size={11} className="text-hacker-accent" />
          ) : (
            <Square size={11} className="text-hacker-text-dim" />
          )}
        </span>
        {isDir ? (
          <>
            {isExpanded ? <ChevronDown size={12} className="text-hacker-text-dim shrink-0" /> : <ChevronRight size={12} className="text-hacker-text-dim shrink-0" />}
            {isExpanded ? <FolderOpen size={14} className="text-hacker-warn shrink-0" /> : <Folder size={14} className="text-hacker-warn/70 shrink-0" />}
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            {getFileIcon(node.name)}
          </>
        )}
        <span className="truncate text-[11px]">{node.name}</span>
      </div>
      {isExpanded && node.children && (
        <div className="pl-3">
          {node.children.map((child) => (
            <DirNode
              key={child.path}
              node={child}
              selectedPaths={selectedPaths}
              onSelect={onSelect}
              onExpand={onExpand}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main File Explorer ──
export function FileExplorer({ project }: Props) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageExt, setImageExt] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [previewError, setPreviewError] = useState("");

  // ── Edit state ──
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);

  // ── Selection state ──
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const rootPath = project?.cwd || "/projects";

  // Load root directory
  useEffect(() => {
    if (!project) return;
    const root: TreeNode = { name: project.name || "project", path: rootPath, type: "dir", children: [], loaded: false };
    setTree(root);
    fetch(`/api/files/browse?path=${encodeURIComponent(rootPath)}`)
      .then((r) => r.json())
      .then((data: BrowseResult) => {
        const sorted = sortEntries(data.entries);
        const children: TreeNode[] = sorted.map((e) => ({
          name: e.name, path: `${rootPath}/${e.name}`.replace(/\/+/g, "/"),
          type: e.type, children: e.type === "dir" ? [] : undefined, loaded: false,
        }));
        setTree({ ...root, children, loaded: true });
      })
      .catch((e: any) => setError(e.message));
  }, [project?.id]);

  const sortEntries = (entries: FileEntry[]) =>
    entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1);

  const expandDir = useCallback(async (node: TreeNode) => {
    try {
      const res = await fetch(`/api/files/browse?path=${encodeURIComponent(node.path)}`);
      if (!res.ok) { const data = await res.json(); setError(data.error || "Failed to browse"); return; }
      const data: BrowseResult = await res.json();
      const sorted = sortEntries(data.entries);
      const children: TreeNode[] = sorted.map((e) => ({
        name: e.name, path: `${node.path}/${e.name}`.replace(/\/+/g, "/"),
        type: e.type, children: e.type === "dir" ? [] : undefined, loaded: false,
      }));
      setTree((prev) => {
        if (!prev) return prev;
        const update = (n: TreeNode): TreeNode => n.path === node.path ? { ...n, children, loaded: true } : { ...n, children: n.children?.map(update) };
        return update(prev);
      });
      setError("");
    } catch (e: any) { setError(e.message); }
  }, []);

  const handleExpand = useCallback((node: TreeNode) => {
    if (node.type === "file") return;
    if (node.loaded && node.children && node.children.length > 0) {
      setTree((prev) => {
        if (!prev) return prev;
        const toggle = (n: TreeNode): TreeNode => n.path === node.path ? { ...n, children: [], loaded: false } : { ...n, children: n.children?.map(toggle) };
        return toggle(prev);
      });
      return;
    }
    expandDir(node);
  }, [expandDir]);

  const handleSelect = useCallback(async (filePath: string) => {
    setSelectedPath(filePath);
    setPreviewError("");
    setFileContent(null);
    setImageUrl(null);
    setEditMode(false);

    const ext = filePath.lastIndexOf(".") >= 0 ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";
    if (IMAGE_EXTS.has(ext)) {
      setImageUrl(`/api/files/read?path=${encodeURIComponent(filePath)}`);
      setImageExt(ext);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Failed to load file" }));
        setPreviewError(data.error || "Failed to load file");
        return;
      }
      const contentType = res.headers.get("content-type") || "";
      if (contentType.startsWith("image/")) {
        setImageUrl(`/api/files/read?path=${encodeURIComponent(filePath)}`);
        setImageExt(ext);
        return;
      }
      const data = await res.json();
      setFileContent(data);
      setEditContent(data.content);
    } catch (e: any) { setPreviewError(e.message); }
    finally { setLoading(false); }
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedPath || !editContent) return;
    setSaving(true);
    try {
      const res = await fetch("/api/files/write", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedPath, content: editContent }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Save failed");
        return;
      }
      setEditMode(false);
      // Reload file content
      handleSelect(selectedPath);
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }, [selectedPath, editContent, handleSelect]);

  const handleDownload = useCallback(async () => {
    if (selectedPaths.size === 0 && selectedPath) {
      // Single current file download
      const a = document.createElement("a");
      a.href = `/api/files/download?paths=${encodeURIComponent(selectedPath)}`;
      a.download = "";
      a.click();
      return;
    }
    if (selectedPaths.size > 0) {
      setDownloading(true);
      try {
        const paths = Array.from(selectedPaths).join("|");
        const a = document.createElement("a");
        a.href = `/api/files/download?paths=${encodeURIComponent(paths)}`;
        a.download = "";
        a.click();
      } finally { setDownloading(false); }
      return;
    }
  }, [selectedPaths, selectedPath]);

  const handleUpload = useCallback(async (files: FileList) => {
    if (!project?.cwd || files.length === 0) return;
    setUploading(true);
    try {
      const formData = new FormData();
      for (let i = 0; i < files.length; i++) {
        formData.append("files", files[i]);
      }
      formData.append("targetPath", rootPath);
      const res = await fetch("/api/files/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Upload failed"); return; }
      // Refresh tree
      handleRefresh();
      setSelectedPaths(new Set());
    } catch (e: any) { setError(e.message); }
    finally { setUploading(false); }
  }, [project?.cwd]);

  const handleRefresh = useCallback(() => {
    setSelectedPath(null);
    setFileContent(null);
    setImageUrl(null);
    setPreviewError("");
    setEditMode(false);
    setSelectedPaths(new Set());
    const root: TreeNode = { name: project?.name || "project", path: rootPath, type: "dir", children: [], loaded: false };
    setTree(root);
    fetch(`/api/files/browse?path=${encodeURIComponent(rootPath)}`)
      .then((r) => r.json())
      .then((data: BrowseResult) => {
        const sorted = sortEntries(data.entries);
        const children: TreeNode[] = sorted.map((e) => ({
          name: e.name, path: `${rootPath}/${e.name}`.replace(/\/+/g, "/"),
          type: e.type, children: e.type === "dir" ? [] : undefined, loaded: false,
        }));
        setTree({ ...root, children, loaded: true });
      })
      .catch(() => {});
  }, [project?.id]);

  const toggleSelect = useCallback((path: string, type: "dir" | "file") => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const [treeWidth, setTreeWidth] = useState(240);
  const fileTreeResizeRef = useRef(false);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!fileTreeResizeRef.current) return;
      setTreeWidth((prev) => Math.max(160, Math.min(500, e.clientX)));
    };
    const handleMouseUp = () => { fileTreeResizeRef.current = false; };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => { window.removeEventListener("mousemove", handleMouseMove); window.removeEventListener("mouseup", handleMouseUp); };
  }, []);

  const canEdit = fileContent && isEditable(fileContent.ext);

  if (!project) {
    return (
      <div className="h-full flex items-center justify-center text-hacker-text-dim">
        <span>Select a project to browse files...</span>
      </div>
    );
  }

  return (
    <div className="h-full flex">
      {/* Tree panel */}
      <div style={{ width: treeWidth }} className="shrink-0 border-r border-hacker-border-bright bg-hacker-surface/50 flex flex-col relative">
        <div className="flex items-center justify-between px-2 py-1.5 border-b border-hacker-border">
          <span className="text-hacker-accent text-[10px] tracking-widest">FILES</span>
          <div className="flex items-center gap-1">
            {/* Upload button */}
            <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
              className="text-hacker-text-dim hover:text-hacker-accent disabled:opacity-30" title="Upload files">
              <Upload size={12} />
            </button>
            <input ref={fileInputRef} type="file" multiple className="hidden"
              onChange={(e) => e.target.files && handleUpload(e.target.files)}
            />
            {/* Download button */}
            {(selectedPaths.size > 0 || selectedPath) && (
              <button onClick={handleDownload} disabled={downloading}
                className="text-hacker-text-dim hover:text-hacker-accent disabled:opacity-30" title="Download selected">
                <Download size={12} />
              </button>
            )}
            <button onClick={handleRefresh} className="text-hacker-text-dim hover:text-hacker-accent" title="Refresh">
              <RefreshCw size={12} />
            </button>
          </div>
        </div>

        {selectedPaths.size > 0 && (
          <div className="px-2 py-1 bg-hacker-accent/10 text-hacker-accent text-[10px] border-b border-hacker-border">
            {selectedPaths.size} selected
          </div>
        )}

        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          {tree && (
            <DirNode
              node={tree}
              selectedPaths={selectedPaths}
              onSelect={handleSelect}
              onExpand={handleExpand}
              onToggleSelect={toggleSelect}
            />
          )}
          {error && <div className="p-2 text-hacker-error text-[10px]">{error}</div>}
        </div>
        {/* Resize handle */}
        <div
          onMouseDown={(e) => { e.preventDefault(); fileTreeResizeRef.current = true; }}
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-hacker-accent/30 active:bg-hacker-accent/50 transition-colors"
          title="Resize"
        />
      </div>

      {/* Preview / Editor panel */}
      <div className="flex-1 flex flex-col min-w-0 bg-hacker-bg">
        {!selectedPath ? (
          <div className="flex-1 flex items-center justify-center text-hacker-text-dim text-xs">
            <span>Select a file to preview</span>
          </div>
        ) : loading ? (
          <div className="flex-1 flex items-center justify-center text-hacker-text-dim text-xs">Loading...</div>
        ) : previewError ? (
          <div className="flex-1 flex items-center justify-center text-hacker-error text-xs p-4">{previewError}</div>
        ) : imageUrl ? (
          <div className="flex-1 flex items-center justify-center p-4 overflow-auto">
            <img src={imageUrl} alt={selectedPath} className="max-w-full max-h-full object-contain"
              style={{ imageRendering: imageExt === ".svg" ? "auto" : "pixelated" }} />
          </div>
        ) : fileContent ? (
          <div className="flex-1 flex flex-col min-h-0">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-3 py-1 border-b border-hacker-border">
              <span className="text-[10px] text-hacker-text-dim truncate flex-1">
                {fileContent.name}
                <span className="ml-2 text-hacker-text-dim/60">{formatSize(fileContent.size)}</span>
              </span>
              <div className="flex items-center gap-1">
                {canEdit && !editMode && (
                  <button onClick={() => { setEditMode(true); setEditContent(fileContent.content); }}
                    className="btn-hacker text-[10px] px-1.5 py-0.5 flex items-center gap-1" title="Edit file">
                    <Edit3 size={10} /> EDIT
                  </button>
                )}
                {editMode && (
                  <>
                    <button onClick={handleSave} disabled={saving}
                      className="btn-hacker text-[10px] px-1.5 py-0.5 flex items-center gap-1 text-hacker-accent" title="Save changes">
                      <Save size={10} /> {saving ? "SAVING..." : "SAVE"}
                    </button>
                    <button onClick={() => { setEditMode(false); setEditContent(""); }}
                      className="btn-hacker text-[10px] px-1.5 py-0.5 flex items-center gap-1" title="Cancel editing">
                      <X size={10} /> CANCEL
                    </button>
                  </>
                )}
                <button onClick={handleDownload}
                  className="text-hacker-text-dim hover:text-hacker-accent" title="Download file">
                  <Download size={12} />
                </button>
              </div>
            </div>
            {/* Content */}
            <div className="flex-1 overflow-auto">
              {editMode ? (
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="w-full h-full bg-hacker-bg text-hacker-text-bright font-mono text-xs p-3 resize-none outline-none border-none"
                  spellCheck={false}
                />
              ) : MARKDOWN_EXTS.has(fileContent.ext) ? (
                <div className="prose-hacker p-4">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}
                    components={{
                      code({ className, children, ...props }) {
                        const match = /language-(\w+)/.exec(className || "");
                        const codeStr = String(children).replace(/\n$/, "");
                        if (match) {
                          return (
                            <SyntaxHighlighter style={atomOneDark} language={match[1]} PreTag="div" className="rounded-sm my-2 !text-xs">
                              {codeStr}
                            </SyntaxHighlighter>
                          );
                        }
                        return <code className={className} {...props}>{children}</code>;
                      },
                    }}
                  >
                    {fileContent.content}
                  </ReactMarkdown>
                </div>
              ) : CODE_EXTS.has(fileContent.ext) || !fileContent.ext ? (
                <SyntaxHighlighter
                  style={atomOneDark}
                  language={getLangFromExt(fileContent.ext) || "text"}
                  showLineNumbers wrapLines PreTag="div"
                  className="!m-0 !rounded-none !text-xs !leading-relaxed"
                >
                  {fileContent.content}
                </SyntaxHighlighter>
              ) : (
                <pre className="p-3 text-xs text-hacker-text-bright leading-relaxed font-mono whitespace-pre">
                  {fileContent.content}
                </pre>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}