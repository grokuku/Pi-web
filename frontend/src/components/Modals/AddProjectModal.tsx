import { useState } from "react";
import { X, ArrowLeft, ArrowRight, AlertTriangle, GitBranch, FolderOpen } from "lucide-react";
import { FileBrowser } from "../common/FileBrowser";
import type { Project } from "../../types";

interface Props {
  onClose: () => void;
  onCreated: (project: Project) => void;
}

type StorageType = "local" | "ssh" | "smb";
type VersioningType = "git" | "standalone";
type GitProvider = "github" | "gitlab" | "other";

export function AddProjectModal({ onClose, onCreated }: Props) {
  // ── Wizard ──
  const [step, setStep] = useState<1 | 2>(1);

  // ── Step 1: Identity & Storage ──
  const [name, setName] = useState("");
  const [storage, setStorage] = useState<StorageType>("local");
  const [cwd, setCwd] = useState("");

  // SSH fields
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshUser, setSshUser] = useState("");
  const [sshKeyPath, setSshKeyPath] = useState("");
  const [sshRemotePath, setSshRemotePath] = useState("");

  // SMB fields
  const [smbShare, setSmbShare] = useState("");
  const [smbMount, setSmbMount] = useState("");
  const [smbUser, setSmbUser] = useState("");
  const [smbPass, setSmbPass] = useState("");

  // ── Step 2: Versioning ──
  const [versioning, setVersioning] = useState<VersioningType>("standalone");
  const [gitRemote, setGitRemote] = useState("");
  const [gitBranch, setGitBranch] = useState("main");
  const [gitProvider, setGitProvider] = useState<GitProvider>("github");

  // ── General ──
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");

  // ── Derived state ──
  const effectiveCwd = storage === "ssh" ? sshRemotePath : storage === "smb" ? smbMount : cwd;

  // ── Handlers ──

  const handleNext = () => {
    if (step === 1) {
      // Validate Step 1
      if (!name.trim()) {
        setError("Project name is required");
        return;
      }
      if (storage === "local" && !cwd) {
        setError("Working directory is required");
        return;
      }
      if (storage === "ssh" && !sshRemotePath) {
        setError("Remote working directory is required");
        return;
      }
      if (storage === "smb" && !smbMount) {
        setError("Mount point is required");
        return;
      }
      setError("");
      setStep(2);
    }
  };

  const handleBack = () => {
    setError("");
    setWarning("");
    setStep(1);
  };

  // ── Check for Git conflicts ──
  const checkConflicts = async (): Promise<string | null> => {
    if (versioning !== "git" || storage !== "local") return null;

    try {
      const res = await fetch(`/api/files/browse?path=${encodeURIComponent(cwd)}`);
      if (!res.ok) return null;

      const data = await res.json();
      const entries = data.entries || [];

      // Check if directory has a .git folder
      const hiddenRes = await fetch(`/api/files/browse?path=${encodeURIComponent(cwd)}&showHidden=true`);
      // We can't easily detect .git via the API (we filter dotfiles), so check if directory is non-empty
      if (entries.length > 0) {
        return `The directory "${cwd}" is not empty. Cloning a repository here may cause conflicts.`;
      }
    } catch {
      // Can't verify, let it pass
    }
    return null;
  };

  const handleSubmit = async () => {
    // Validate Step 2
    setError("");
    setWarning("");

    if (versioning === "git" && !gitRemote.trim()) {
      setError("Git remote URL is required");
      return;
    }

    // Check conflicts before submitting
    const conflictWarning = await checkConflicts();
    if (conflictWarning) {
      setWarning(conflictWarning);
    }

    setLoading(true);
    try {
      const body: any = {
        name: name.trim(),
        storage,
        cwd: effectiveCwd,
        versioning,
      };

      // Git config
      if (versioning === "git") {
        body.git = {
          remote: gitRemote.trim(),
          branch: gitBranch.trim() || "main",
          provider: gitProvider,
        };
      }

      // SSH config
      if (storage === "ssh") {
        body.ssh = {
          host: sshHost,
          port: parseInt(sshPort) || 22,
          username: sshUser,
          keyPath: sshKeyPath || undefined,
          remotePath: sshRemotePath,
        };
      }

      // SMB config
      if (storage === "smb") {
        body.smb = {
          share: smbShare,
          mountPoint: smbMount,
          username: smbUser || undefined,
          password: smbPass || undefined,
        };
      }

      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create project");
      }

      const project = await res.json();
      onCreated(project);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Auto-detect provider from URL ──
  const remoteLower = gitRemote.toLowerCase();
  const detectedProvider: GitProvider =
    remoteLower.includes("github.com") ? "github" :
    remoteLower.includes("gitlab.com") || remoteLower.includes("gitlab.") ? "gitlab" :
    gitProvider;

  return (
    <div className="modal-overlay">
      <div className="modal-box max-w-lg">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-hacker-accent font-bold text-sm tracking-wider">
              + NEW PROJECT
            </span>
            <span className="text-hacker-text-dim text-[10px]">
              Step {step}/2
            </span>
          </div>
          <button onClick={onClose} className="text-hacker-text-dim hover:text-hacker-text">
            <X size={16} />
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="text-hacker-error text-xs mb-3 border border-hacker-error/30 p-2 flex items-center gap-1.5">
            <AlertTriangle size={12} />
            {error}
          </div>
        )}

        {/* Warning (non-blocking) */}
        {warning && (
          <div className="text-hacker-warn text-xs mb-3 border border-hacker-warn/30 p-2 flex items-center gap-1.5">
            <AlertTriangle size={12} />
            {warning}
          </div>
        )}

        {/* ─── STEP 1: Identity & Storage ─── */}
        {step === 1 && (
          <div className="space-y-4">
            {/* Project name */}
            <div>
              <label className="text-hacker-text-dim text-xs block mb-1">
                Project Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input-hacker w-full"
                placeholder="my-awesome-project"
                autoFocus
              />
            </div>

            {/* Storage type */}
            <div>
              <label className="text-hacker-text-dim text-xs block mb-1.5">
                Storage
              </label>
              <div className="flex gap-2">
                {(["local", "ssh", "smb"] as StorageType[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setStorage(s)}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border text-xs transition-colors ${
                      storage === s
                        ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                        : "border-hacker-border text-hacker-text-dim hover:border-hacker-accent/50"
                    }`}
                  >
                    {s === "local" && <FolderOpen size={14} />}
                    {s === "ssh" && "🔗"}
                    {s === "smb" && "💾"}
                    <span>{s === "local" ? "Local" : s === "ssh" ? "SSH" : "SMB/NAS"}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Working directory */}
            {storage === "local" && (
              <div>
                <label className="text-hacker-text-dim text-xs block mb-1.5">
                  Working Directory
                </label>
                <FileBrowser
                  initialPath={cwd || "/projects"}
                  storage="local"
                  onSelect={(path) => setCwd(path)}
                  selectedPath={cwd}
                />
                {cwd && (
                  <div className="text-hacker-accent text-[10px] mt-1">
                    Selected: {cwd}
                  </div>
                )}
              </div>
            )}

            {storage === "ssh" && (
              <div className="space-y-2 border border-hacker-border p-3">
                <div className="text-hacker-info text-[10px] mb-1">SSH CONFIGURATION</div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-hacker-text-dim text-[10px] block">Host</label>
                    <input
                      type="text"
                      value={sshHost}
                      onChange={(e) => setSshHost(e.target.value)}
                      className="input-hacker w-full text-xs"
                      placeholder="192.168.1.100"
                    />
                  </div>
                  <div>
                    <label className="text-hacker-text-dim text-[10px] block">Port</label>
                    <input
                      type="text"
                      value={sshPort}
                      onChange={(e) => setSshPort(e.target.value)}
                      className="input-hacker w-full text-xs"
                      placeholder="22"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-hacker-text-dim text-[10px] block">Username</label>
                  <input
                    type="text"
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                    className="input-hacker w-full text-xs"
                    placeholder="root"
                  />
                </div>
                <div>
                  <label className="text-hacker-text-dim text-[10px] block">
                    SSH Key Path (optional)
                  </label>
                  <input
                    type="text"
                    value={sshKeyPath}
                    onChange={(e) => setSshKeyPath(e.target.value)}
                    className="input-hacker w-full text-xs"
                    placeholder="~/.ssh/id_rsa"
                  />
                </div>
                <div>
                  <label className="text-hacker-text-dim text-[10px] block">
                    Remote Working Directory
                  </label>
                  <input
                    type="text"
                    value={sshRemotePath}
                    onChange={(e) => setSshRemotePath(e.target.value)}
                    className="input-hacker w-full text-xs"
                    placeholder="/home/user/project"
                  />
                </div>
              </div>
            )}

            {storage === "smb" && (
              <div className="space-y-2 border border-hacker-border p-3">
                <div className="text-hacker-info text-[10px] mb-1">SMB / NAS CONFIGURATION</div>
                <div>
                  <label className="text-hacker-text-dim text-[10px] block">Share Path</label>
                  <input
                    type="text"
                    value={smbShare}
                    onChange={(e) => setSmbShare(e.target.value)}
                    className="input-hacker w-full text-xs"
                    placeholder="//192.168.1.200/projects"
                  />
                </div>
                <div>
                  <label className="text-hacker-text-dim text-[10px] block">Mount Point</label>
                  <input
                    type="text"
                    value={smbMount}
                    onChange={(e) => setSmbMount(e.target.value)}
                    className="input-hacker w-full text-xs"
                    placeholder="/mnt/nas-projects"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-hacker-text-dim text-[10px] block">Username</label>
                    <input
                      type="text"
                      value={smbUser}
                      onChange={(e) => setSmbUser(e.target.value)}
                      className="input-hacker w-full text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-hacker-text-dim text-[10px] block">Password</label>
                    <input
                      type="password"
                      value={smbPass}
                      onChange={(e) => setSmbPass(e.target.value)}
                      className="input-hacker w-full text-xs"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ─── STEP 2: Versioning ─── */}
        {step === 2 && (
          <div className="space-y-4">
            {/* Versioning type */}
            <div>
              <label className="text-hacker-text-dim text-xs block mb-1.5">
                Versioning
              </label>
              <div className="flex gap-2">
                {(["standalone", "git"] as VersioningType[]).map((v) => (
                  <button
                    key={v}
                    onClick={() => setVersioning(v)}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border text-xs transition-colors ${
                      versioning === v
                        ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                        : "border-hacker-border text-hacker-text-dim hover:border-hacker-accent/50"
                    }`}
                  >
                    {v === "git" && <GitBranch size={14} />}
                    {v === "standalone" && "📂"}
                    <span>{v === "git" ? "Git Repository" : "Standalone"}</span>
                  </button>
                ))}
              </div>
              <p className="text-hacker-text-dim text-[10px] mt-1">
                {versioning === "git"
                  ? "Pi will manage pull/push/sync for this project."
                  : "No Git integration. Files are managed manually."}
              </p>
            </div>

            {/* Git configuration */}
            {versioning === "git" && (
              <div className="space-y-3 border border-hacker-border p-3">
                <div className="text-hacker-info text-[10px] mb-1">GIT CONFIGURATION</div>

                {/* Provider */}
                <div>
                  <label className="text-hacker-text-dim text-[10px] block mb-1">Provider</label>
                  <div className="flex gap-1">
                    {(["github", "gitlab", "other"] as GitProvider[]).map((p) => (
                      <button
                        key={p}
                        onClick={() => setGitProvider(p)}
                        className={`flex-1 text-[10px] px-2 py-1 border transition-colors ${
                          detectedProvider === p || (p === "other" && !["github", "gitlab"].includes(detectedProvider) && gitProvider === p)
                            ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                            : "border-hacker-border text-hacker-text-dim hover:border-hacker-accent/50"
                        }`}
                      >
                        {p === "github" ? "🐙 GitHub" : p === "gitlab" ? "🦊 GitLab" : "📦 Other"}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Remote URL */}
                <div>
                  <label className="text-hacker-text-dim text-[10px] block mb-1">
                    Remote URL
                  </label>
                  <input
                    type="text"
                    value={gitRemote}
                    onChange={(e) => setGitRemote(e.target.value)}
                    className="input-hacker w-full text-xs"
                    placeholder="https://github.com/user/repo.git"
                  />
                </div>

                {/* Branch */}
                <div>
                  <label className="text-hacker-text-dim text-[10px] block mb-1">
                    Default Branch
                  </label>
                  <input
                    type="text"
                    value={gitBranch}
                    onChange={(e) => setGitBranch(e.target.value)}
                    className="input-hacker w-full text-xs"
                    placeholder="main"
                  />
                </div>
              </div>
            )}

            {/* Summary */}
            <div className="border border-hacker-border p-3 bg-hacker-bg/30 text-[10px]">
              <div className="text-hacker-text-dim mb-1">SUMMARY</div>
              <div className="text-hacker-text-bright space-y-0.5">
                <div>Name: <span className="text-hacker-accent">{name || "(none)"}</span></div>
                <div>Storage: <span className="text-hacker-accent">
                  {storage === "local" ? "📁 Local" : storage === "ssh" ? "🔗 SSH" : "💾 SMB"}
                </span></div>
                <div>Path: <span className="text-hacker-accent truncate block">{effectiveCwd || "(none)"}</span></div>
                <div>Versioning: <span className="text-hacker-accent">
                  {versioning === "git" ? `${detectedProvider} · ${gitBranch || "main"}` : "Standalone"}
                </span></div>
              </div>
            </div>
          </div>
        )}

        {/* ─── Action buttons ─── */}
        <div className="flex gap-2 justify-between pt-4">
          <div>
            {step === 2 && (
              <button
                type="button"
                onClick={handleBack}
                className="btn-hacker text-xs flex items-center gap-1"
              >
                <ArrowLeft size={12} />
                BACK
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="btn-hacker text-xs">
              CANCEL
            </button>
            {step === 1 ? (
              <button
                type="button"
                onClick={handleNext}
                className="btn-hacker text-xs flex items-center gap-1"
              >
                NEXT
                <ArrowRight size={12} />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                className="btn-hacker text-xs"
                disabled={loading}
              >
                {loading ? "CREATING..." : "CREATE PROJECT"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
