import { useState, useEffect, useCallback, useRef } from "react";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  RefreshCw,
  Image,
  Code,
  FileText,
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
  project: any; // Project | null
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
  selectedPath,
  onSelect,
  onExpand,
}: {
  node: TreeNode;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onExpand: (node: TreeNode) => void;
}) {
  const isExpanded = node.loaded && node.children && node.children.length > 0;
  const isDir = node.type === "dir";

  return (
    <div>
      <div
        className={`flex items-center gap-1 px-2 py-0.5 cursor-pointer hover:bg-hacker-border/50 ${
          selectedPath === node.path ? "bg-hacker-accent/10 text-hacker-accent" : "text-hacker-text-dim"
        }`}
        onClick={() => {
          if (isDir) {
            onExpand(node);
          } else {
            onSelect(node.path);
          }
        }}
      >
        {isDir ? (
          <>
            {isExpanded ? (
              <ChevronDown size={12} className="text-hacker-text-dim shrink-0" />
            ) : (
              <ChevronRight size={12} className="text-hacker-text-dim shrink-0" />
            )}
            {isExpanded ? (
              <FolderOpen size={14} className="text-hacker-warn shrink-0" />
            ) : (
              <Folder size={14} className="text-hacker-warn/70 shrink-0" />
            )}
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
              selectedPath={selectedPath}
              onSelect={onSelect}
              onExpand={onExpand}
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

  const rootPath = project?.cwd || "/projects";

  // Load root directory
  useEffect(() => {
    if (!project) return;
    const root: TreeNode = {
      name: project.name || "project",
      path: rootPath,
      type: "dir",
      children: [],
      loaded: false,
    };
    setTree(root);
    // Trigger initial expand via a fetch
    fetch(`/api/files/browse?path=${encodeURIComponent(rootPath)}`)
      .then((r) => r.json())
      .then((data: BrowseResult) => {
        const sorted = data.entries.sort((a, b) => {
          if (a.type === b.type) return a.name.localeCompare(b.name);
          return a.type === "dir" ? -1 : 1;
        });
        const children: TreeNode[] = sorted.map((e) => ({
          name: e.name,
          path: `${rootPath}/${e.name}`.replace(/\/+/g, "/"),
          type: e.type,
          children: e.type === "dir" ? [] : undefined,
          loaded: false,
        }));
        setTree({ ...root, children, loaded: true });
      })
      .catch((e: any) => setError(e.message));
  }, [project?.id]);

  const expandDir = useCallback(async (node: TreeNode) => {
    try {
      const res = await fetch(`/api/files/browse?path=${encodeURIComponent(node.path)}`);
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to browse");
        return;
      }
      const data: BrowseResult = await res.json();

      // Sort: directories first, then files
      const sorted = data.entries.sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === "dir" ? -1 : 1;
      });

      const children: TreeNode[] = sorted.map((e) => ({
        name: e.name,
        path: `${node.path}/${e.name}`.replace(/\/+/g, "/"),
        type: e.type,
        children: e.type === "dir" ? [] : undefined,
        loaded: false,
      }));

      setTree((prev) => {
        if (!prev) return prev;
        const update = (n: TreeNode): TreeNode => {
          if (n.path === node.path) {
            return { ...n, children, loaded: true };
          }
          return { ...n, children: n.children?.map(update) };
        };
        return update(prev);
      });
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const handleExpand = useCallback(
    (node: TreeNode) => {
      if (node.type === "file") return;
      if (node.loaded && node.children && node.children.length > 0) {
        // Toggle collapse
        setTree((prev) => {
          if (!prev) return prev;
          const toggle = (n: TreeNode): TreeNode => {
            if (n.path === node.path) {
              return { ...n, children: [], loaded: false };
            }
            return { ...n, children: n.children?.map(toggle) };
          };
          return toggle(prev);
        });
        return;
      }
      expandDir(node);
    },
    [expandDir]
  );

  const handleSelect = useCallback(async (filePath: string) => {
    setSelectedPath(filePath);
    setPreviewError("");
    setFileContent(null);
    setImageUrl(null);

    const ext = filePath.lastIndexOf(".") >= 0 ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";

    if (IMAGE_EXTS.has(ext)) {
      // Load image
      setImageUrl(`/api/files/read?path=${encodeURIComponent(filePath)}`);
      setImageExt(ext);
      return;
    }

    // Try to read as text
    setLoading(true);
    try {
      const res = await fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Failed to load file" }));
        setPreviewError(data.error || "Failed to load file");
        return;
      }

      // Check if it's an image response (content-type header)
      const contentType = res.headers.get("content-type") || "";
      if (contentType.startsWith("image/")) {
        setImageUrl(`/api/files/read?path=${encodeURIComponent(filePath)}`);
        setImageExt(ext);
        return;
      }

      const data = await res.json();
      setFileContent(data);
    } catch (e: any) {
      setPreviewError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRefresh = useCallback(() => {
    setSelectedPath(null);
    setFileContent(null);
    setImageUrl(null);
    setPreviewError("");
    // Re-trigger initial load
    const root: TreeNode = {
      name: project?.name || "project",
      path: rootPath,
      type: "dir",
      children: [],
      loaded: false,
    };
    setTree(root);
    fetch(`/api/files/browse?path=${encodeURIComponent(rootPath)}`)
      .then((r) => r.json())
      .then((data: BrowseResult) => {
        const sorted = data.entries.sort((a, b) => {
          if (a.type === b.type) return a.name.localeCompare(b.name);
          return a.type === "dir" ? -1 : 1;
        });
        const children: TreeNode[] = sorted.map((e) => ({
          name: e.name,
          path: `${rootPath}/${e.name}`.replace(/\/+/g, "/"),
          type: e.type,
          children: e.type === "dir" ? [] : undefined,
          loaded: false,
        }));
        setTree({ ...root, children, loaded: true });
      })
      .catch(() => {});
  }, [project?.id]);

  const [treeWidth, setTreeWidth] = useState(240);
  const fileTreeResizeRef = useRef(false);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!fileTreeResizeRef.current) return;
      setTreeWidth((prev) => Math.max(160, Math.min(500, e.clientX)));
    };
    const handleMouseUp = () => {
      fileTreeResizeRef.current = false;
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

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
          <button
            onClick={handleRefresh}
            className="text-hacker-text-dim hover:text-hacker-accent"
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          {tree && (
            <DirNode
              node={tree}
              selectedPath={selectedPath}
              onSelect={handleSelect}
              onExpand={handleExpand}
            />
          )}
          {error && (
            <div className="p-2 text-hacker-error text-[10px]">{error}</div>
          )}
        </div>
        {/* Resize handle */}
        <div
          onMouseDown={(e) => { e.preventDefault(); fileTreeResizeRef.current = true; }}
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-hacker-accent/30 active:bg-hacker-accent/50 transition-colors"
          title="Resize"
        />
      </div>

      {/* Preview panel */}
      <div className="flex-1 flex flex-col min-w-0 bg-hacker-bg">
        {!selectedPath ? (
          <div className="flex-1 flex items-center justify-center text-hacker-text-dim text-xs">
            <span>Select a file to preview</span>
          </div>
        ) : loading ? (
          <div className="flex-1 flex items-center justify-center text-hacker-text-dim text-xs">
            Loading...
          </div>
        ) : previewError ? (
          <div className="flex-1 flex items-center justify-center text-hacker-error text-xs p-4">
            {previewError}
          </div>
        ) : imageUrl ? (
          <div className="flex-1 flex items-center justify-center p-4 overflow-auto">
            <img
              src={imageUrl}
              alt={selectedPath}
              className="max-w-full max-h-full object-contain"
              style={{ imageRendering: imageExt === ".svg" ? "auto" : "pixelated" }}
            />
          </div>
        ) : fileContent ? (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex items-center justify-between px-3 py-1 border-b border-hacker-border">
              <span className="text-[10px] text-hacker-text-dim truncate flex-1">
                {fileContent.name}
                <span className="ml-2 text-hacker-text-dim/60">{formatSize(fileContent.size)}</span>
              </span>
            </div>
            <div className="flex-1 overflow-auto">
              {MARKDOWN_EXTS.has(fileContent.ext) ? (
                /* ── Markdown: rendered ── */
                <div className="prose-hacker p-4">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      code({ className, children, ...props }) {
                        const match = /language-(\w+)/.exec(className || "");
                        const codeStr = String(children).replace(/\n$/, "");
                        if (match) {
                          return (
                            <SyntaxHighlighter
                              style={atomOneDark}
                              language={match[1]}
                              PreTag="div"
                              className="rounded-sm my-2 !text-xs"
                            >
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
                /* ── Code: syntax highlighted ── */
                <SyntaxHighlighter
                  style={atomOneDark}
                  language={getLangFromExt(fileContent.ext) || "text"}
                  showLineNumbers
                  wrapLines
                  PreTag="div"
                  className="!m-0 !rounded-none !text-xs !leading-relaxed"
                >
                  {fileContent.content}
                </SyntaxHighlighter>
              ) : (
                /* ── Default: plain monospace ── */
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