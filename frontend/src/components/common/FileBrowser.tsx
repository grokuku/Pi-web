import { useState, useEffect, useCallback } from "react";
import { Folder, File, ChevronRight, Plus, FolderPlus, Check, RefreshCw, AlertTriangle } from "lucide-react";

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

interface Props {
  initialPath: string;
  storage: "local" | "ssh" | "smb";
  onSelect: (path: string) => void;
  selectedPath?: string;
}

export function FileBrowser({ initialPath, storage, onSelect, selectedPath }: Props) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);

  const browse = useCallback(async (targetPath: string) => {
    if (storage !== "local") return; // Only local supported for now

    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/files/browse?path=${encodeURIComponent(targetPath)}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to browse directory");
      }
      const data: BrowseResult = await res.json();
      setEntries(data.entries);
      setParent(data.parent);
      setCurrentPath(data.path);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [storage]);

  useEffect(() => {
    browse(initialPath);
  }, [initialPath, browse]);

  const handleNavigate = (entry: FileEntry) => {
    if (entry.type === "dir") {
      const newPath = currentPath.endsWith("/")
        ? `${currentPath}${entry.name}`
        : `${currentPath}/${entry.name}`;
      browse(newPath);
    }
  };

  const handleBreadcrumbClick = (targetPath: string) => {
    browse(targetPath);
  };

  const handleSelect = () => {
    onSelect(currentPath);
  };

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;

    setCreatingFolder(true);
    setError("");
    try {
      const res = await fetch("/api/files/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentPath: currentPath, name }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create folder");
      }

      setNewFolderName("");
      setShowNewFolder(false);
      // Refresh the current directory
      await browse(currentPath);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleNewFolderKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleCreateFolder();
    if (e.key === "Escape") {
      setShowNewFolder(false);
      setNewFolderName("");
    }
  };

  // Build breadcrumbs
  const breadcrumbs = currentPath.split("/").filter(Boolean);
  const breadcrumbItems: { label: string; path: string }[] = [
    { label: "/", path: "/" },
    ...breadcrumbs.map((part, i) => ({
      label: part,
      path: "/" + breadcrumbs.slice(0, i + 1).join("/"),
    })),
  ];

  // Only show dirs in the main list (files are grayed out)
  const dirs = entries.filter((e) => e.type === "dir");
  const files = entries.filter((e) => e.type === "file");

  const isSelected = currentPath === selectedPath;

  return (
    <div className="border border-hacker-border bg-hacker-bg/30 overflow-hidden text-xs">
      {/* Breadcrumb */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-hacker-border bg-hacker-surface/50 overflow-x-auto">
        {breadcrumbItems.map((item, i) => (
          <div key={item.path} className="flex items-center gap-0.5 shrink-0">
            {i > 0 && <ChevronRight size={10} className="text-hacker-text-dim shrink-0" />}
            <button
              onClick={() => handleBreadcrumbClick(item.path)}
              className={`hover:text-hacker-accent transition-colors whitespace-nowrap ${
                i === breadcrumbItems.length - 1
                  ? "text-hacker-accent font-bold"
                  : "text-hacker-text-dim"
              }`}
            >
              {item.label}
            </button>
          </div>
        ))}
        <button
          onClick={() => browse(currentPath)}
          className="ml-auto text-hacker-text-dim hover:text-hacker-accent shrink-0"
          title="Refresh"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {/* Loading / Error */}
      {loading && (
        <div className="px-3 py-4 text-center text-hacker-text-dim">
          <RefreshCw size={14} className="animate-spin inline mr-2" />
          Loading...
        </div>
      )}

      {error && (
        <div className="px-3 py-2 text-hacker-error flex items-center gap-1.5">
          <AlertTriangle size={12} />
          {error}
        </div>
      )}

      {/* Directory listing */}
      {!loading && !error && (
        <div className="max-h-[200px] overflow-y-auto">
          {dirs.length === 0 && files.length === 0 && (
            <div className="px-3 py-4 text-center text-hacker-text-dim italic">
              Empty directory
            </div>
          )}

          {/* Directories */}
          {dirs.map((entry) => (
            <button
              key={entry.name}
              onClick={() => handleNavigate(entry)}
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-hacker-accent/10 text-hacker-text-bright transition-colors text-left"
            >
              <Folder size={14} className="text-hacker-accent shrink-0" />
              <span className="truncate">{entry.name}</span>
            </button>
          ))}

          {/* Files (muted) */}
          {files.map((entry) => (
            <div
              key={entry.name}
              className="flex items-center gap-2 px-3 py-1 text-hacker-text-dim/50"
            >
              <File size={14} className="shrink-0" />
              <span className="truncate">{entry.name}</span>
              <span className="ml-auto text-[10px] shrink-0">
                {formatSize(entry.size)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* New folder input */}
      {showNewFolder && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-hacker-border bg-hacker-surface/50">
          <FolderPlus size={12} className="text-hacker-accent shrink-0" />
          <input
            type="text"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={handleNewFolderKeyDown}
            placeholder="folder name..."
            className="bg-transparent border-b border-hacker-border text-hacker-text-bright text-xs flex-1 outline-none px-1 py-0.5 focus:border-hacker-accent"
            autoFocus
          />
          <button
            onClick={handleCreateFolder}
            disabled={!newFolderName.trim() || creatingFolder}
            className="text-hacker-accent hover:text-hacker-text-bright disabled:opacity-30"
          >
            <Check size={12} />
          </button>
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-hacker-border bg-hacker-surface/50">
        <button
          onClick={() => { setShowNewFolder(true); setNewFolderName(""); }}
          className="flex items-center gap-1 text-hacker-text-dim hover:text-hacker-accent transition-colors"
        >
          <Plus size={12} />
          <span>New Folder</span>
        </button>

        <div className="flex-1" />

        <button
          onClick={handleSelect}
          className={`flex items-center gap-1 px-2 py-0.5 border text-xs transition-colors ${
            isSelected
              ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
              : "border-hacker-border text-hacker-text-dim hover:border-hacker-accent hover:text-hacker-accent"
          }`}
        >
          <Check size={12} />
          {isSelected ? "Selected" : "Select"}
        </button>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
