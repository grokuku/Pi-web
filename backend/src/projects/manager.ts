import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import { fileURLToPath } from "url";
import { Mutex } from "../utils/mutex.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_FILE = path.join(__dirname, "..", "..", "..", ".data", "projects.json");
const projectsMutex = new Mutex();

export type StorageType = "local" | "ssh" | "smb";
export type VersioningType = "git" | "standalone";
export type GitProvider = "github" | "gitlab" | "other";

export interface GitInfo {
  remote: string;
  branch: string;
  provider?: GitProvider;
  autoSync?: boolean;
  lastSync: string | null;
}

export interface Project {
  id: string;
  name: string;
  storage: StorageType;
  versioning: VersioningType;
  cwd: string;
  // SSH config
  ssh?: {
    host: string;
    port: number;
    username: string;
    keyPath?: string;
    remotePath: string;
  };
  // SMB config
  smb?: {
    share: string;
    mountPoint: string;
    username?: string;
    password?: string;
    domain?: string;
  };
  git?: GitInfo;
  // Session persistence
  lastSessionId?: string;  // Resume this Pi session on reconnect
  lastActiveAt?: string;    // When the project was last active
  createdAt: string;
  updatedAt: string;
}

function ensureDataDir(): void {
  const dir = path.dirname(PROJECTS_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function migrateProject(p: any): Project {
  // Migrate from legacy "type" field to "storage"
  if (!p.storage && p.type) {
    p.storage = p.type;
    delete p.type;
  }
  // Add default versioning if missing
  if (!p.versioning) {
    p.versioning = p.git?.remote ? "git" : "standalone";
  }
  // Add default git provider if missing
  if (p.versioning === "git" && p.git && !p.git.provider) {
    const remote = p.git.remote || "";
    if (remote.includes("github.com")) p.git.provider = "github";
    else if (remote.includes("gitlab.com") || remote.includes("gitlab.")) p.git.provider = "gitlab";
    else p.git.provider = "other";
  }
  // Default autoSync
  if (p.git && p.git.autoSync === undefined) {
    p.git.autoSync = false;
  }
  return p as Project;
}

function loadProjects(): Project[] {
  ensureDataDir();
  try {
    if (existsSync(PROJECTS_FILE)) {
      const raw = JSON.parse(readFileSync(PROJECTS_FILE, "utf-8"));
      if (Array.isArray(raw)) {
        return raw.map(migrateProject);
      }
    }
  } catch {
    console.error("Failed to load projects file, starting fresh");
  }
  return [];
}

function saveProjects(projects: Project[]): void {
  ensureDataDir();
  writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), "utf-8");
}

export function getAllProjects(): Project[] {
  return loadProjects();
}

export function getProject(id: string): Project | undefined {
  return loadProjects().find((p) => p.id === id);
}

export function getProjectByName(name: string): Project | undefined {
  return loadProjects().find((p) => p.name === name);
}

export async function createProject(
  name: string,
  storage: StorageType,
  parentCwd: string,
  versioning: VersioningType = "standalone",
  git?: Partial<GitInfo>,
  ssh?: Project["ssh"],
  smb?: Project["smb"]
): Promise<Project> {
  return projectsMutex.run(() => {
    const projects = loadProjects();

  if (!name || !storage || !parentCwd) {
    throw new Error("name, storage, and parentCwd are required");
  }
  if (!/^[a-zA-Z0-9_\-. ]+$/.test(name)) {
    throw new Error("Project name can only contain letters, numbers, spaces, hyphens, underscores, and dots");
  }
  if (!["local", "ssh", "smb"].includes(storage)) {
    throw new Error(`Invalid storage type: ${storage}`);
  }
  if (!["git", "standalone"].includes(versioning)) {
    throw new Error(`Invalid versioning type: ${versioning}`);
  }
  if (projects.some((p) => p.name === name)) {
    throw new Error(`Project "${name}" already exists`);
  }

  // Create the project subdirectory inside the parent directory
  const cwd = path.join(parentCwd, name);
  if (!existsSync(cwd)) {
    mkdirSync(cwd, { recursive: true });
    console.log(`[Projects] Created project directory: ${cwd}`);
  }
  let gitProvider: GitProvider | undefined;
  if (git?.remote) {
    const r = git.remote.toLowerCase();
    if (r.includes("github.com")) gitProvider = "github";
    else if (r.includes("gitlab.com") || r.includes("gitlab.")) gitProvider = "gitlab";
    else gitProvider = git?.provider || "other";
  }

  const now = new Date().toISOString();
  const project: Project = {
    id: uuid(),
    name,
    storage,
    versioning,
    cwd,
    ssh,
    smb,
    git: versioning === "git" ? {
      remote: git?.remote || "",
      branch: git?.branch || "main",
      provider: gitProvider,
      autoSync: git?.autoSync ?? false,
      lastSync: git?.lastSync || null,
    } : undefined,
    createdAt: now,
    updatedAt: now,
  };

  projects.push(project);
  saveProjects(projects);
  return project;
  });
}

export async function updateProject(
  id: string,
  updates: Partial<Omit<Project, "id" | "createdAt">>
): Promise<Project> {
  return projectsMutex.run(() => {
    const projects = loadProjects();
    const index = projects.findIndex((p) => p.id === id);

    if (index === -1) throw new Error(`Project not found: ${id}`);

    projects[index] = {
      ...projects[index],
      ...updates,
      id: projects[index].id,
      createdAt: projects[index].createdAt,
      updatedAt: new Date().toISOString(),
    };

    saveProjects(projects);
    return projects[index];
  });
}

export async function deleteProject(id: string): Promise<void> {
  return projectsMutex.run(() => {
    const projects = loadProjects();
    const filtered = projects.filter((p) => p.id !== id);
    if (filtered.length === projects.length) {
      throw new Error(`Project not found: ${id}`);
    }
    saveProjects(filtered);
  });
}

export async function updateProjectGit(
  id: string,
  gitInfo: Partial<GitInfo>
): Promise<Project> {
  return projectsMutex.run(() => {
    const projects = loadProjects();
    const index = projects.findIndex((p) => p.id === id);
    if (index === -1) throw new Error(`Project not found: ${id}`);

    projects[index].git = {
      ...projects[index].git,
      ...gitInfo,
      remote: gitInfo.remote || projects[index].git?.remote || "",
      branch: gitInfo.branch || projects[index].git?.branch || "main",
      lastSync: gitInfo.lastSync !== undefined ? gitInfo.lastSync : projects[index].git?.lastSync || null,
    };
    projects[index].updatedAt = new Date().toISOString();

    saveProjects(projects);
    return projects[index];
  });
}
