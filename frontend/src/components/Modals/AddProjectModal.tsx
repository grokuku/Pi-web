import { useState } from "react";
import { X } from "lucide-react";
import type { Project } from "../../types";

interface Props {
  onClose: () => void;
  onCreated: (project: Project) => void;
}

export function AddProjectModal({ onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"local" | "ssh" | "smb">("local");
  const [cwd, setCwd] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const body: any = { name, type, cwd };

      if (type === "ssh") {
        body.ssh = {
          host: sshHost,
          port: parseInt(sshPort),
          username: sshUser,
          keyPath: sshKeyPath || undefined,
          remotePath: sshRemotePath,
        };
        body.cwd = sshRemotePath;
      }

      if (type === "smb") {
        body.smb = {
          share: smbShare,
          mountPoint: smbMount,
          username: smbUser || undefined,
          password: smbPass || undefined,
        };
        body.cwd = smbMount;
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

  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <div className="flex items-center justify-between mb-4">
          <span className="text-hacker-accent font-bold text-sm tracking-wider">
            + NEW PROJECT
          </span>
          <button onClick={onClose} className="text-hacker-text-dim hover:text-hacker-text">
            <X size={16} />
          </button>
        </div>

        {error && (
          <div className="text-hacker-error text-xs mb-3 border border-hacker-error/30 p-2">
            ERROR: {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3 text-sm">
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
              required
            />
          </div>

          <div>
            <label className="text-hacker-text-dim text-xs block mb-1">
              Type
            </label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as any)}
              className="select-hacker w-full"
            >
              <option value="local">📁 Local</option>
              <option value="ssh">🔗 SSH</option>
              <option value="smb">💾 SMB / NAS</option>
            </select>
          </div>

          {type === "local" && (
            <div>
              <label className="text-hacker-text-dim text-xs block mb-1">
                Working Directory
              </label>
              <input
                type="text"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                className="input-hacker w-full"
                placeholder="/projects/my-app"
                required
              />
            </div>
          )}

          {type === "ssh" && (
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

          {type === "smb" && (
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

          <div className="flex gap-2 justify-end pt-2">
            <button type="button" onClick={onClose} className="btn-hacker text-xs">
              CANCEL
            </button>
            <button type="submit" className="btn-hacker text-xs" disabled={loading}>
              {loading ? "CREATING..." : "CREATE PROJECT"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
