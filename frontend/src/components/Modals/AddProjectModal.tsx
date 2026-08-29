import { useState, useEffect, useCallback } from "react";
import { X, ArrowLeft, ArrowRight, AlertTriangle, GitBranch, FolderOpen, Link2 } from "lucide-react";
import { ModalDialog } from "../common/ModalDialog";
import { FileBrowser } from "../common/FileBrowser";
import { useTranslation } from "../../i18n";
import type { Project } from "../../types";

interface Props {
  onClose: () => void;
  onCreated: (project: Project) => void;
}

type StorageType = "local" | "ssh" | "smb" | "linked";
type VersioningType = "git" | "standalone";
type GitProvider = "github" | "gitlab" | "other";

export function AddProjectModal({ onClose, onCreated }: Props) {
  const { t } = useTranslation();
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

  // Linked fields — sous-projets locaux à regrouper (min 2)
  const [linkedProjectIds, setLinkedProjectIds] = useState<string[]>([]);
  const [availableProjects, setAvailableProjects] = useState<Project[]>([]);

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
  // For local storage: if no parent selected, default to /projects.
  // The project folder is created as a subfolder with the project name.
  const effectiveCwd = storage === "ssh" ? sshRemotePath : storage === "smb" ? smbMount : (cwd || "/projects") + (name ? `/${name}` : "").replace(/\/+/g, "/");

  // Candidats au liage : projets locaux OU SMB (le mount est un chemin local
  // du container, /mnt/smb/… — les symlinks fonctionnent). Jamais de liés
  // (1 niveau max) ni de ssh (fichiers absents de ce disque).
  const linkedCandidates = availableProjects.filter(
    (p) => p.storage === "local" || p.storage === "smb"
  );

  // Charger la liste des projets existants (candidats au liage)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/projects");
        if (res.ok) {
          // GET /api/projects renvoie un ARRAY direct (pas { projects: [...] }).
          const data = await res.json();
          setAvailableProjects(Array.isArray(data) ? data : (data.projects || []));
        }
      } catch { /* liste indisponible — candidats vides */ }
    })();
  }, []);

  const toggleLinkedProject = (id: string) => {
    setLinkedProjectIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  // ── Handlers ──

  const handleNext = () => {
    if (step === 1) {
      // Validate Step 1
      if (!name.trim()) {
        setError(t('addProject.errNameRequired'));
        return;
      }
      if (storage === "linked" && linkedProjectIds.length < 2) {
        setError(t('addProject.linkedSelectHint'));
        return;
      }
      if (storage === "linked") {
        // Pas de step versioning pour un lié — création directe (standalone)
        handleSubmit();
        return;
      }
      if (storage === "ssh" && !sshRemotePath) {
        setError(t('addProject.errRemoteWorkingDirRequired'));
        return;
      }
      if (storage === "smb" && !smbMount) {
        setError(t('addProject.errMountPointRequired'));
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
        return t('addProject.conflictWarning', cwd);
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
      setError(t('addProject.errGitRemoteRequired'));
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
        versioning: storage === "linked" ? "standalone" : versioning,
      };
      if (storage === "linked") {
        body.linkedProjectIds = linkedProjectIds;
      }

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
        throw new Error(data.error || t('addProject.createFailed'));
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

  const providerLabel =
    detectedProvider === "github" ? t('addProject.github') :
    detectedProvider === "gitlab" ? t('addProject.gitlab') :
    t('addProject.other');

  return (
    <ModalDialog id="add-project" onClose={onClose}>
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-hacker-accent font-bold text-sm tracking-wider">
              {t('addProject.newProject')}
            </span>
            <span className="text-hacker-text-dim text-[10px]">
              {t('addProject.step', step, 2)}
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
                {t('addProject.name')}
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
                {t('addProject.storage')}
              </label>
              <div className="grid grid-cols-4 gap-2">
                {(["local", "ssh", "smb", "linked"] as StorageType[]).map((s) => (
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
                    {s === "linked" && <Link2 size={14} />}
                    <span>{s === "local" ? t('addProject.local') : s === "ssh" ? t('addProject.ssh') : s === "smb" ? t('addProject.smbNas') : t('addProject.linked')}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Parent directory (optional — defaults to /projects) */}
            {storage === "local" && (
              <div>
                <label className="text-hacker-text-dim text-xs block mb-1.5">
                  {t('addProject.parentDirectory')}
                  <span className="text-hacker-text-dim/50 ml-1">{t('addProject.parentDirectoryHint')}</span>
                </label>
                <FileBrowser
                  initialPath={cwd || "/projects"}
                  storage="local"
                  onSelect={(path) => setCwd(path)}
                  selectedPath={cwd}
                />
                <div className="text-hacker-accent text-[10px] mt-1">
                  {t('addProject.willCreate', cwd || "/projects", name || t('addProject.namePlaceholder'))}
                </div>
              </div>
            )}

            {storage === "ssh" && (
              <div className="space-y-2 border border-hacker-border p-3">
                <div className="text-hacker-info text-[10px] mb-1">{t('addProject.sshConfiguration')}</div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-hacker-text-dim text-[10px] block">{t('addProject.host')}</label>
                    <input
                      type="text"
                      value={sshHost}
                      onChange={(e) => setSshHost(e.target.value)}
                      className="input-hacker w-full text-xs"
                      placeholder="192.168.1.100"
                    />
                  </div>
                  <div>
                    <label className="text-hacker-text-dim text-[10px] block">{t('addProject.port')}</label>
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
                  <label className="text-hacker-text-dim text-[10px] block">{t('addProject.username')}</label>
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
                    {t('addProject.sshKeyPath')}
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
                    {t('addProject.remoteWorkingDirectory')}
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
                <div className="text-hacker-info text-[10px] mb-1">{t('addProject.smbNasConfiguration')}</div>
                <div>
                  <label className="text-hacker-text-dim text-[10px] block">{t('addProject.sharePath')}</label>
                  <input
                    type="text"
                    value={smbShare}
                    onChange={(e) => setSmbShare(e.target.value)}
                    className="input-hacker w-full text-xs"
                    placeholder="//192.168.1.200/projects"
                  />
                </div>
                <div>
                  <label className="text-hacker-text-dim text-[10px] block">{t('addProject.mountPoint')}</label>
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
                    <label className="text-hacker-text-dim text-[10px] block">{t('addProject.username')}</label>
                    <input
                      type="text"
                      value={smbUser}
                      onChange={(e) => setSmbUser(e.target.value)}
                      className="input-hacker w-full text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-hacker-text-dim text-[10px] block">{t('addProject.password')}</label>
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

            {/* Projet LIÉ : sélection des sous-projets à regrouper */}
            {storage === "linked" && (
              <div className="space-y-2 border border-hacker-border p-3">
                <div className="text-hacker-info text-[10px] mb-1">{t('addProject.linkedDescription')}</div>
                {linkedCandidates.length === 0 ? (
                  <div className="text-hacker-warn text-[11px]">{t('addProject.linkedNoCandidates')}</div>
                ) : (
                  <>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-hacker-text-dim text-[10px]">{t('addProject.linkedSelectHint')}</label>
                      <span className={`text-[10px] ${linkedProjectIds.length >= 2 ? "text-hacker-accent" : "text-hacker-warn"}`}>
                        {t('addProject.linkedSelectedCount', linkedProjectIds.length)}
                      </span>
                    </div>
                    <div className="max-h-48 overflow-y-auto space-y-1">
                      {linkedCandidates.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => toggleLinkedProject(p.id)}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 border text-left text-xs transition-colors ${
                            linkedProjectIds.includes(p.id)
                              ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                              : "border-hacker-border text-hacker-text-dim hover:border-hacker-accent/50"
                          }`}
                        >
                          <span className="w-3 text-center">{linkedProjectIds.includes(p.id) ? "☑" : "☐"}</span>
                          <FolderOpen size={12} className="shrink-0" />
                          <span className="flex-1 truncate text-hacker-text-bright">{p.name}</span>
                          <span className="text-[9px] text-hacker-text-dim font-mono">{p.cwd}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

        {/* ─── STEP 2: Versioning ─── */}
        {step === 2 && (
          <div className="space-y-4">
            {/* Versioning type */}
            <div>
              <label className="text-hacker-text-dim text-xs block mb-1.5">
                {t('addProject.versioning')}
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
                    <span>{v === "git" ? t('addProject.git') : t('addProject.standalone')}</span>
                  </button>
                ))}
              </div>
              <p className="text-hacker-text-dim text-[10px] mt-1">
                {versioning === "git"
                  ? t('addProject.gitDescription')
                  : t('addProject.standaloneDescription')}
              </p>
            </div>

            {/* Git configuration */}
            {versioning === "git" && (
              <div className="space-y-3 border border-hacker-border p-3">
                <div className="text-hacker-info text-[10px] mb-1">{t('addProject.gitConfiguration')}</div>

                {/* Provider */}
                <div>
                  <label className="text-hacker-text-dim text-[10px] block mb-1">{t('addProject.gitProvider')}</label>
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
                        {p === "github" ? "🐙 " + t('addProject.github') : p === "gitlab" ? "🦊 " + t('addProject.gitlab') : "📦 " + t('addProject.other')}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Remote URL */}
                <div>
                  <label className="text-hacker-text-dim text-[10px] block mb-1">
                    {t('addProject.remote')}
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
                    {t('addProject.defaultBranch')}
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
              <div className="text-hacker-text-dim mb-1">{t('addProject.summary')}</div>
              <div className="text-hacker-text-bright space-y-0.5">
                <div>{t('addProject.name')}: <span className="text-hacker-accent">{name || t('common.none')}</span></div>
                <div>{t('addProject.storage')}: <span className="text-hacker-accent">
                  {storage === "local" ? "📁 " + t('addProject.local') : storage === "ssh" ? "🔗 " + t('addProject.ssh') : "💾 " + t('addProject.smbNas')}
                </span></div>
                <div>{t('addProject.pathLabel')}: <span className="text-hacker-accent truncate block">{effectiveCwd || t('common.none')}</span></div>
                <div>{t('addProject.versioning')}: <span className="text-hacker-accent">
                  {versioning === "git" ? `${providerLabel} · ${gitBranch || "main"}` : t('addProject.standalone')}
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
                {t('addProject.back')}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="btn-hacker text-xs">
              {t('addProject.cancel')}
            </button>
            {step === 1 ? (
              <button
                type="button"
                onClick={handleNext}
                className="btn-hacker text-xs flex items-center gap-1"
              >
                {t('addProject.next')}
                <ArrowRight size={12} />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                className="btn-hacker text-xs"
                disabled={loading}
              >
                {loading ? t('common.loading').toUpperCase() : t('addProject.create')}
              </button>
            )}
          </div>
        </div>
    </ModalDialog>
  );
}
