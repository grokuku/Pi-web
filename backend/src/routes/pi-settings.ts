import { Router, type Request, type Response } from "express";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import os from "os";

const router = Router();

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const SETTINGS_FILE = path.join(AGENT_DIR, "settings.json");
const PACKAGES_DIR = path.join(AGENT_DIR, "packages");
const BACKEND_DIR = path.join(process.cwd(), "backend");

// ── Types ──────────────────────────────────────────────

interface PiSettings {
  packages?: (string | { source: string; extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[] })[];
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  [key: string]: any;
}

interface PackageInfo {
  source: string;
  scope: "user" | "project";
  installed: boolean;
  installedPath?: string;
  type?: "npm" | "git" | "local";
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}

// ── Helpers ──────────────────────────────────────────────

function loadSettings(): PiSettings {
  try {
    if (existsSync(SETTINGS_FILE)) {
      return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("[pi-settings] Failed to load:", e);
  }
  return {};
}

function saveSettings(settings: PiSettings): void {
  if (!existsSync(AGENT_DIR)) mkdirSync(AGENT_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function detectPackageType(source: string): "npm" | "git" | "local" {
  if (source.startsWith("git+") || source.startsWith("git://") || source.startsWith("https://") && source.endsWith(".git")) return "git";
  if (source.startsWith("./") || source.startsWith("/") || source.startsWith("../")) return "local";
  return "npm";
}

function getPackagesDir(): string {
  // npm packages are installed in node_modules under AGENT_DIR
  return path.join(AGENT_DIR, "node_modules");
}

function listInstalledPackages(): PackageInfo[] {
  const settings = loadSettings();
  const packages: PackageInfo[] = [];

  // List packages from settings.packages
  const pkgSources = settings.packages || [];
  for (const pkg of pkgSources) {
    const source = typeof pkg === "string" ? pkg : pkg.source;
    const pkgType = detectPackageType(source);

    // Check if installed
    let installed = false;
    let installedPath: string | undefined;

    if (pkgType === "npm") {
      // npm package: check node_modules
      const pkgName = source.startsWith("@") ? source.split("/").slice(0, 2).join("/") : source.split("@")[0].split("/")[0];
      const modPath = path.join(getPackagesDir(), pkgName);
      installed = existsSync(modPath);
      installedPath = installed ? modPath : undefined;
    } else if (pkgType === "git") {
      // git package: check extensions/git directory
      const gitDir = path.join(AGENT_DIR, "extensions", "git");
      installed = existsSync(gitDir);
      installedPath = installed ? gitDir : undefined;
    } else {
      // local path: check if exists
      const resolvedPath = path.resolve(AGENT_DIR, source);
      installed = existsSync(resolvedPath);
      installedPath = installed ? resolvedPath : undefined;
    }

    packages.push({
      source,
      scope: "user",
      installed,
      installedPath,
      type: pkgType,
      extensions: typeof pkg === "object" ? pkg.extensions : undefined,
      skills: typeof pkg === "object" ? pkg.skills : undefined,
      prompts: typeof pkg === "object" ? pkg.prompts : undefined,
      themes: typeof pkg === "object" ? pkg.themes : undefined,
    });
  }

  // List standalone extensions
  const extensions = settings.extensions || [];
  for (const ext of extensions) {
    if (!packages.find(p => p.source === ext)) {
      const resolvedPath = path.resolve(AGENT_DIR, ext);
      packages.push({
        source: ext,
        scope: "user",
        installed: existsSync(resolvedPath),
        installedPath: existsSync(resolvedPath) ? resolvedPath : undefined,
        type: detectPackageType(ext),
      });
    }
  }

  // List standalone skills
  const skills = settings.skills || [];
  for (const skill of skills) {
    if (!packages.find(p => p.source === skill)) {
      const resolvedPath = path.resolve(AGENT_DIR, skill);
      packages.push({
        source: skill,
        scope: "user",
        installed: existsSync(resolvedPath),
        installedPath: existsSync(resolvedPath) ? resolvedPath : undefined,
        type: detectPackageType(skill),
      });
    }
  }

  // List standalone prompts
  const prompts = settings.prompts || [];
  for (const prompt of prompts) {
    if (!packages.find(p => p.source === prompt)) {
      const resolvedPath = path.resolve(AGENT_DIR, prompt);
      packages.push({
        source: prompt,
        scope: "user",
        installed: existsSync(resolvedPath),
        installedPath: existsSync(resolvedPath) ? resolvedPath : undefined,
        type: detectPackageType(prompt),
      });
    }
  }

  // List standalone themes
  const themes = settings.themes || [];
  for (const theme of themes) {
    if (!packages.find(p => p.source === theme)) {
      const resolvedPath = path.resolve(AGENT_DIR, theme);
      packages.push({
        source: theme,
        scope: "user",
        installed: existsSync(resolvedPath),
        installedPath: existsSync(resolvedPath) ? resolvedPath : undefined,
        type: detectPackageType(theme),
      });
    }
  }

  return packages;
}

function listAvailableExtensions(): string[] {
  const extDir = path.join(AGENT_DIR, "extensions");
  if (!existsSync(extDir)) return [];
  try {
    return readdirSync(extDir).filter(f => f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".mjs"));
  } catch {
    return [];
  }
}

function listAvailableSkills(): string[] {
  const skillDir = path.join(AGENT_DIR, "skills");
  if (!existsSync(skillDir)) return [];
  try {
    return readdirSync(skillDir).filter(f => {
      const p = path.join(skillDir, f);
      return statSync(p).isDirectory() || f.endsWith(".md");
    });
  } catch {
    return [];
  }
}

function listAvailableThemes(): string[] {
  const themeDir = path.join(AGENT_DIR, "themes");
  if (!existsSync(themeDir)) return [];
  try {
    return readdirSync(themeDir).filter(f => f.endsWith(".json") || f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    return [];
  }
}

// ── Routes ──────────────────────────────────────────────

// GET full settings
router.get("/", (_req: Request, res: Response) => {
  try {
    const settings = loadSettings();
    res.json(settings);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET packages list
router.get("/packages", (_req: Request, res: Response) => {
  try {
    const packages = listInstalledPackages();
    res.json(packages);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET available resources (extensions, skills, themes on disk)
router.get("/available", (_req: Request, res: Response) => {
  try {
    res.json({
      extensions: listAvailableExtensions(),
      skills: listAvailableSkills(),
      themes: listAvailableThemes(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PUT update settings (packages, extensions, skills, etc.)
router.put("/", (req: Request, res: Response) => {
  try {
    const settings = loadSettings();

    // Only allow updating specific fields
    const allowedFields = ["packages", "extensions", "skills", "prompts", "themes", "defaultThinkingLevel", "compaction", "retry", "hideThinkingBlock", "enableSkillCommands"];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        (settings as any)[field] = req.body[field];
      }
    }

    saveSettings(settings);
    res.json(settings);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST install a package (add to settings.packages, then npm install)
router.post("/packages", async (req: Request, res: Response) => {
  try {
    const { source } = req.body;
    if (!source) {
      return res.status(400).json({ error: "source is required" });
    }

    const settings = loadSettings();
    if (!settings.packages) settings.packages = [];

    // Check if already installed
    const exists = settings.packages.some(p => {
      const s = typeof p === "string" ? p : p.source;
      return s === source;
    });

    if (exists) {
      return res.status(409).json({ error: "Package already installed" });
    }

    // Install the package via npm or git
    const pkgType = detectPackageType(source);
    let installError: string | null = null;

    if (pkgType === "npm") {
      try {
        // npm packages are installed in the backend's node_modules
        const pkgName = source.startsWith("@") ? source.split("/").slice(0, 2).join("/") : source.split("@")[0].split("/")[0];
        console.log(`[pi-settings] Installing npm package: ${pkgName}`);
        execSync(`npm install ${pkgName}`, {
          timeout: 120000,
          encoding: "utf-8",
          cwd: BACKEND_DIR,
        });
      } catch (e: any) {
        installError = `npm install failed: ${e.message}`;
        console.error(`[pi-settings] npm install failed:`, e.message);
      }
    } else if (pkgType === "git") {
      try {
        // Git packages are cloned into ~/.pi/agent/git/
        const gitDir = path.join(AGENT_DIR, "git");
        if (!existsSync(gitDir)) mkdirSync(gitDir, { recursive: true });
        console.log(`[pi-settings] Cloning git package: ${source}`);
        execSync(`git clone --depth 1 ${source.includes("@") ? source.split("@")[0] : source} ${path.join(gitDir, source.replace(/[^a-zA-Z0-9]/g, "-"))}`, {
          timeout: 120000,
          encoding: "utf-8",
        });
        // Run npm install in the cloned repo if it has a package.json
        const cloneDir = path.join(gitDir, source.replace(/[^a-zA-Z0-9]/g, "-"));
        if (existsSync(path.join(cloneDir, "package.json"))) {
          execSync("npm install --omit=dev", { timeout: 120000, encoding: "utf-8", cwd: cloneDir });
        }
      } catch (e: any) {
        installError = `git clone failed: ${e.message}`;
        console.error(`[pi-settings] git clone failed:`, e.message);
      }
    }
    // local paths don't need installation

    // Add to settings regardless of install success (user can fix manually)
    settings.packages.push(source);
    saveSettings(settings);

    res.json({
      success: !installError,
      packages: listInstalledPackages(),
      ...(installError ? { warning: installError } : {}),
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE uninstall a package (remove from settings.packages and uninstall)
router.delete("/packages/:source", async (req: Request, res: Response) => {
  try {
    const source = decodeURIComponent(req.params.source);
    const settings = loadSettings();
    const pkgType = detectPackageType(source);
    let uninstallWarning: string | null = null;

    // Uninstall npm package
    if (pkgType === "npm") {
      try {
        const pkgName = source.startsWith("@") ? source.split("/").slice(0, 2).join("/").split("@")[0] : source.split("@")[0].split("/")[0];
        console.log(`[pi-settings] Uninstalling npm package: ${pkgName}`);
        execSync(`npm uninstall ${pkgName}`, { timeout: 60000, encoding: "utf-8", cwd: BACKEND_DIR });
      } catch (e: any) {
        uninstallWarning = `npm uninstall failed: ${e.message}`;
        console.error(`[pi-settings] npm uninstall failed:`, e.message);
      }
    } else if (pkgType === "git") {
      // Remove cloned git repo
      const repoDir = path.join(AGENT_DIR, "git", source.replace(/[^a-zA-Z0-9]/g, "-"));
      try {
        if (existsSync(repoDir)) {
          const { rmSync } = await import("fs");
          rmSync(repoDir, { recursive: true, force: true });
          console.log(`[pi-settings] Removed git package: ${repoDir}`);
        }
      } catch (e: any) {
        uninstallWarning = `Failed to remove git repo: ${e.message}`;
      }
    }

    // Remove from settings regardless of uninstall success
    if (settings.packages) {
      settings.packages = settings.packages.filter(p => {
        const s = typeof p === "string" ? p : p.source;
        return s !== source;
      });
    }

    saveSettings(settings);
    res.json({ success: true, packages: listInstalledPackages(), ...(uninstallWarning ? { warning: uninstallWarning } : {}) });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST reload Pi session for a project (picks up extension/skill changes)
router.post("/reload", async (req: Request, res: Response) => {
  try {
    const { projectId } = req.body as { projectId?: string };
    if (!projectId) {
      return res.status(400).json({ error: "projectId is required" });
    }
    const { disposeSession } = await import("../pi/session.js");
    await disposeSession(projectId);
    // The session will be recreated on next user message, loading fresh settings
    res.json({ success: true, message: "Session disposed. It will reload on next interaction." });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
router.post("/toggle", (req: Request, res: Response) => {
  try {
    const { type, source, enabled } = req.body as { type: "extensions" | "skills" | "prompts" | "themes"; source: string; enabled: boolean };

    if (!["extensions", "skills", "prompts", "themes"].includes(type)) {
      return res.status(400).json({ error: "Invalid type" });
    }

    const settings = loadSettings();
    const list: string[] = settings[type] || [];

    if (enabled && !list.includes(source)) {
      list.push(source);
    } else if (!enabled) {
      const idx = list.indexOf(source);
      if (idx >= 0) list.splice(idx, 1);
    }

    settings[type] = list;
    saveSettings(settings);
    res.json({ success: true, [type]: list });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;