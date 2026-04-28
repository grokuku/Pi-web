import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_FILE = path.join(__dirname, "..", "..", "..", ".data", "projects.json");

export type ProjectType = "local" | "ssh" | "smb";

export interface GitInfo {
  remote: string;
  branch: string;
  lastSync: string | null;
}

export interface Project {
  id: string;
  name: string;
  type: ProjectType;
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
  createdAt: string;
  updatedAt: string;
}

function ensureDataDir(): void {
  const dir = path.dirname(PROJECTS_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadProjects(): Project[] {
  ensureDataDir();
  try {
    if (existsSync(PROJECTS_FILE)) {
      return JSON.parse(readFileSync(PROJECTS_FILE, "utf-8"));
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

export function createProject(
  name: string,
  type: ProjectType,
  cwd: string,
  ssh?: Project["ssh"],
  smb?: Project["smb"]
): Project {
  const projects = loadProjects();

  // Check name uniqueness
  if (projects.some((p) => p.name === name)) {
    throw new Error(`Project "${name}" already exists`);
  }

  const now = new Date().toISOString();
  const project: Project = {
    id: uuid(),
    name,
    type,
    cwd,
    ssh,
    smb,
    createdAt: now,
    updatedAt: now,
  };

  projects.push(project);
  saveProjects(projects);
  return project;
}

export function updateProject(
  id: string,
  updates: Partial<Omit<Project, "id" | "createdAt">>
): Project {
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
}

export function deleteProject(id: string): void {
  const projects = loadProjects();
  const filtered = projects.filter((p) => p.id !== id);
  if (filtered.length === projects.length) {
    throw new Error(`Project not found: ${id}`);
  }
  saveProjects(filtered);
}

export function updateProjectGit(
  id: string,
  gitInfo: Partial<GitInfo>
): Project {
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
}
