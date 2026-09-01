import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, symlinkSync } from "fs";
import path from "path";
import { join, relative } from "path";
import { v4 as uuid } from "uuid";
import { fileURLToPath } from "url";
import { Mutex } from "../utils/mutex.js";
import { isCwdAllowed } from "../utils/path-security.js";
import { encryptSmbPassword } from "./smb.js";
import { deleteAttachmentsForProject } from "../routes/attachments.js";
import { sanitizeRemoteUrl } from "./remote-url.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_FILE = path.join(__dirname, "..", "..", "..", ".data", "projects.json");
const projectsMutex = new Mutex();

export type StorageType = "local" | "ssh" | "smb" | "linked";
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
  // Projet LIÉ : ids des sous-projets regroupés (placeholder + symlinks).
  // Seulement pour storage === "linked" ; sous-projets locaux uniquement.
  linkedProjectIds?: string[];
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
        return raw
          .map(migrateProject)
          .filter((p) => {
            // Sécurité : un projet dont le cwd est invalide (ex: /etc ou un
            // symlink sortant) ne doit jamais être utilisé par les routes.
            if (!p.cwd || !isCwdAllowed(p.cwd)) {
              console.error(
                `[Projects] Projet ignoré (cwd non autorisé) : ${p.name || p.id} -> ${p.cwd}`
              );
              return false;
            }
            return true;
          });
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
  // BUG-36: lectures non protégées par le mutex — risque faible car writeFileSync est atomique.
  // Rendre ces fonctions async casserait trop d'appelants. Accepté tel quel.
  return loadProjects();
}

export function getProject(id: string): Project | undefined {
  return loadProjects().find((p) => p.id === id);
}

export function getProjectByName(name: string): Project | undefined {
  return loadProjects().find((p) => p.name === name);
}

/**
 * Valide la création d'un projet LIÉ : minimum 2 sous-projets, tous locaux,
 * existants, pas eux-mêmes des projets liés (1 niveau maximum).
 */
function validateLinkedProject(projects: Project[], name: string, linkedProjectIds?: string[]): void {
  if (!Array.isArray(linkedProjectIds) || linkedProjectIds.length < 2) {
    throw new Error("A linked project requires at least 2 existing local projects");
  }
  if (new Set(linkedProjectIds).size !== linkedProjectIds.length) {
    throw new Error("Duplicate project in linked project list");
  }
  for (const id of linkedProjectIds) {
    const sub = projects.find((p) => p.id === id);
    if (!sub) {
      throw new Error(`Linked project not found: ${id}`);
    }
    if (sub.storage === "linked") {
      throw new Error(`Project "${sub.name}" is itself a linked project (nested linked projects are not supported)`);
    }
    if (sub.storage !== "local" && sub.storage !== "smb") {
      throw new Error(`Project "${sub.name}" is a ${sub.storage} project — linked projects only support local and SMB (mounted) sub-projects`);
    }
  }
}

/**
 * Crée le placeholder du projet lié : un dossier contenant un symlink par
 * sous-projet (niveau 1, liens RELATIFS pour survivre aux déplacements de
 * volume). Le nom du symlink = nom du sous-projet (lisible pour le LLM).
 * rm -rf sur ce dossier défait les symlinks sans toucher aux sous-projets
 * (comportement POSIX confirmé par prototype).
 */
function createLinkedPlaceholder(cwd: string, projects: Project[], linkedProjectIds: string[]): void {
  if (existsSync(cwd)) {
    const entries = readdirSync(cwd);
    if (entries.length > 0) {
      throw new Error(`Linked project directory already exists and is not empty: ${cwd}`);
    }
  } else {
    mkdirSync(cwd, { recursive: true });
  }
  for (const id of linkedProjectIds) {
    const sub = projects.find((p) => p.id === id)!;
    const linkPath = join(cwd, sub.name);
    const target = relative(cwd, sub.cwd); // RELATIF — le placeholder suit si /projects est déplacé
    symlinkSync(join(target, "/"), linkPath, "dir");
    console.log(`[Projects] Linked placeholder: ${linkPath} -> ${target}/`);
  }
  // Fichier marqueur : (a) exclut le placeholder du CBM (l'indexation suivrait
  // les symlinks et mélangerait 2 dépôts), (b) documente le groupe sur disque.
  writeFileSync(
    join(cwd, ".pi-web-linked"),
    JSON.stringify({ linked: true, linkedProjectIds, createdAt: new Date().toISOString() }, null, 2),
    "utf-8"
  );
}

export async function createProject(
  name: string,
  storage: StorageType,
  cwd: string,
  versioning: VersioningType = "standalone",
  git?: Partial<GitInfo>,
  ssh?: Project["ssh"],
  smb?: Project["smb"],
  linkedProjectIds?: string[]
): Promise<Project> {
  return projectsMutex.run(() => {
    const projects = loadProjects();

  if (!storage || !cwd) {
    throw new Error("name, storage, and cwd are required");
  }
  if (!name) {
    throw new Error("name, storage, and cwd are required");
  }
  if (!/^[a-zA-Z0-9_\-. ]+$/.test(name)) {
    throw new Error("Project name can only contain letters, numbers, spaces, hyphens, underscores, and dots");
  }
  if (!["local", "ssh", "smb", "linked"].includes(storage)) {
    throw new Error(`Invalid storage type: ${storage}`);
  }
  if (!["git", "standalone"].includes(versioning)) {
    throw new Error(`Invalid versioning type: ${versioning}`);
  }
  if (projects.some((p) => p.name === name)) {
    throw new Error(`Project "${name}" already exists`);
  }
  if (projects.some((p) => p.cwd === cwd)) {
    throw new Error(`A project already uses working directory: ${cwd}`);
  }

  // Sécurité : refuser les cwd hors des racines de travail autorisées.
  // Sinon un appelant authentifié pourrait créer un projet avec cwd=/etc
  // puis lire des fichiers sensibles via les endpoints de fichiers.
  if (!isCwdAllowed(cwd)) {
    throw new Error("Working directory must be within an allowed root (/projects, /mnt/smb)");
  }

  // Projet LIÉ : un placeholder contenant des symlinks vers plusieurs projets
  // locaux existants, pour travailler dessus comme un projet unique.
  if (storage === "linked") {
    validateLinkedProject(projects, name, linkedProjectIds);
    createLinkedPlaceholder(cwd, projects, linkedProjectIds!);
  }

  // cwd is the full path (frontend already includes the project name as subfolder)
  if (!existsSync(cwd)) {
    mkdirSync(cwd, { recursive: true });
    console.log(`[Projects] Created project directory: ${cwd}`);
  }
  let gitProvider: GitProvider | undefined;
  if (git?.remote) {
    const r = sanitizeRemoteUrl(git.remote).toLowerCase();
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
    linkedProjectIds: storage === "linked" ? linkedProjectIds : undefined,
    ssh,
    smb: smb ? { ...smb, password: smb.password ? encryptSmbPassword(smb.password) : undefined } : undefined,
    git: versioning === "git" ? {
      remote: git?.remote ? sanitizeRemoteUrl(git.remote) : "",
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

    // Sécurité : un cwd mis à jour doit aussi rester sous une racine autorisée.
    if (updates.cwd !== undefined && !isCwdAllowed(updates.cwd)) {
      throw new Error("Working directory must be within an allowed root (/projects, /mnt/smb)");
    }

    projects[index] = {
      ...projects[index],
      ...updates,
      id: projects[index].id,
      createdAt: projects[index].createdAt,
      updatedAt: new Date().toISOString(),
    };

    // Sécurité : ne jamais persister de credentials dans le remote stocké.
    if (projects[index].git?.remote) {
      projects[index].git.remote = sanitizeRemoteUrl(projects[index].git.remote);
    }

    saveProjects(projects);
    return projects[index];
  });
}

export async function deleteProject(id: string, deleteFiles: boolean = false): Promise<void> {
  return projectsMutex.run(() => {
    const projects = loadProjects();
    const project = projects.find((p) => p.id === id);
    if (!project) {
      throw new Error(`Project not found: ${id}`);
    }

    const cwd = project.cwd;
    const storage = project.storage;

    // Sécurité : refuser la suppression d'un projet référencé par un projet
    // LIÉ (sinon les symlinks du placeholder deviendraient des dangling links).
    for (const other of projects) {
      if (other.storage === "linked" && Array.isArray(other.linkedProjectIds) && other.linkedProjectIds.includes(id)) {
        throw new Error(`Cannot delete: project is linked in "${other.name}" — remove it from that linked project first`);
      }
    }

    // Remove from projects list
    const filtered = projects.filter((p) => p.id !== id);
    saveProjects(filtered);

    // Delete associated attachments
    deleteAttachmentsForProject(id);

    // Delete files only if requested AND it's a local project
    if (deleteFiles && storage === "local" && cwd) {
      try {
        // Check if directory exists and is a project directory (safety check)
        if (existsSync(cwd)) {
          console.log(`[Projects] Deleting project directory: ${cwd}`);
          rmSync(cwd, { recursive: true, force: true });
        }
      } catch (e: any) {
        console.error(`[Projects] Failed to delete directory ${cwd}:`, e.message);
        // Don't throw - project is already removed from list
      }
    }

    // For remote projects (ssh/smb), we NEVER delete remote content
    if (deleteFiles && (storage === "ssh" || storage === "smb")) {
      console.log(`[Projects] Skipping remote file deletion for ${storage} project: ${project.name}`);
    }
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
      remote: gitInfo.remote ? sanitizeRemoteUrl(gitInfo.remote) : projects[index].git?.remote || "",
      branch: gitInfo.branch || projects[index].git?.branch || "main",
      lastSync: gitInfo.lastSync !== undefined ? gitInfo.lastSync : projects[index].git?.lastSync || null,
    };
    projects[index].updatedAt = new Date().toISOString();

    saveProjects(projects);
    return projects[index];
  });
}

/** Reorder projects — takes an array of project IDs in the desired order */
export async function reorderProjects(orderedIds: string[]): Promise<Project[]> {
  return projectsMutex.run(() => {
    const projects = loadProjects();
    const idSet = new Set(orderedIds);

    // Validate all IDs exist
    for (const id of orderedIds) {
      if (!projects.find((p) => p.id === id)) {
        throw new Error(`Project not found: ${id}`);
      }
    }

    // Build reordered array: ordered IDs first, then any not mentioned (appended at end)
    const reordered: Project[] = orderedIds.map(id => projects.find((p) => p.id === id)!);
    for (const p of projects) {
      if (!idSet.has(p.id)) reordered.push(p);
    }

    saveProjects(reordered);
    return reordered;
  });
}
