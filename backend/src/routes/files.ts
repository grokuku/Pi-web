import { Router, type Request, type Response } from "express";
import { readdirSync, statSync, mkdirSync, existsSync, readFileSync, writeFileSync, createReadStream, copyFileSync, unlinkSync, realpathSync } from "fs";
import path from "path";
import { isPathAllowed, getAllowedRoots } from "../utils/path-security.js";

const router = Router();

interface FileEntry {
  name: string;
  type: "dir" | "file";
  size: number; // bytes, 0 for dirs
}

/**
 * Retourne le parent commun le plus proche d'une liste de chemins absolus.
 * Utilisé pour construire une archive dont les membres restent sous la racine
 * commune (aucun `..` dans les noms d'archive).
 */
function commonParentOf(absolutePaths: string[]): string {
  const parts = absolutePaths.map((p) => p.split(path.sep).filter(Boolean));
  const minLen = Math.min(...parts.map((p) => p.length));
  let i = 0;
  while (i < minLen && parts.every((p) => p[i] === parts[0][i])) i++;
  return path.join(path.sep, ...parts[0].slice(0, i));
}

// GET /api/files/browse?path=/projects
router.get("/browse", (req: Request, res: Response) => {
  try {
    const targetPath = (req.query.path as string) || "/";
    const resolved = path.resolve(targetPath);

    if (!isPathAllowed(resolved)) {
      return res.status(403).json({
        error: `Access denied. Path must be within: ${getAllowedRoots().join(", ")}`,
      });
    }

    if (!existsSync(resolved)) {
      return res.status(404).json({
        error: "Directory not found",
        path: targetPath,
      });
    }

    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      return res.status(400).json({
        error: "Path is not a directory",
        path: targetPath,
      });
    }

    const entries: FileEntry[] = [];
    const dirents = readdirSync(resolved, { withFileTypes: true });

    for (const d of dirents) {
      // Skip hidden files/folders (dotfiles)
      if (d.name.startsWith(".")) continue;

      try {
        const fullPath = path.join(resolved, d.name);
        // statSync suit les liens symboliques : un symlink vers un dossier
        // renvoie isDirectory()=true (contrairement à d.isDirectory() qui ne
        // suit pas le lien). Les symlinks cassés lèvent une exception et sont
        // ignorés proprement ici.
        const s = statSync(fullPath);
        entries.push({
          name: d.name,
          type: s.isDirectory() ? "dir" : "file",
          size: s.size,
        });
      } catch {
        // Permission error or broken symlink, skip this entry
      }
    }

    // Sort: directories first, then alphabetically
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const parent = resolved === path.resolve("/") ? null : path.dirname(targetPath);

    res.json({
      path: targetPath,
      resolved: resolved,
      parent: parent && isPathAllowed(parent) ? parent : null,
      entries,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/files/mkdir
router.post("/mkdir", (req: Request, res: Response) => {
  try {
    const { parentPath, name } = req.body;

    if (!parentPath || !name) {
      return res.status(400).json({ error: "parentPath and name are required" });
    }

    // Validate name: no slashes, no dots at start
    if (name.includes("/") || name.includes("\\")) {
      return res.status(400).json({ error: "Folder name cannot contain slashes" });
    }
    if (!/^[a-zA-Z0-9_\-. ]+$/.test(name)) {
      return res.status(400).json({ error: "Folder name contains invalid characters" });
    }

    const resolved = path.resolve(parentPath);
    if (!isPathAllowed(resolved)) {
      return res.status(403).json({ error: "Access denied" });
    }

    const fullPath = path.join(resolved, name);
    if (existsSync(fullPath)) {
      return res.status(409).json({ error: `"${name}" already exists` });
    }

    mkdirSync(fullPath, { recursive: true });
    res.json({ path: path.join(parentPath, name), name });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── Read file content ──
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".js", ".ts", ".jsx", ".tsx", ".vue", ".svelte",
  ".css", ".scss", ".less", ".html", ".xml", ".yaml", ".yml", ".toml",
  ".ini", ".cfg", ".conf", ".sh", ".bash", ".zsh", ".fish",
  ".py", ".rb", ".rs", ".go", ".java", ".kt", ".c", ".h", ".cpp", ".hpp",
  ".cs", ".swift", ".dart", ".lua", ".r", ".sql", ".graphql",
  ".dockerfile", ".gitignore", ".env", ".editorconfig",
  ".makefile", ".cmake", ".gradle",
  ".lock", ".log", ".csv", ".tsv",
]);

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico",
]);

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

// Multer for file uploads (imported dynamically to avoid bundling issues)
let uploadMiddleware: any;
async function getUploadMiddleware() {
  if (!uploadMiddleware) {
    const multer = (await import("multer")).default;
    uploadMiddleware = multer({ dest: "/tmp/pi-web-uploads/", limits: { fileSize: 50 * 1024 * 1024 } });
  }
  return uploadMiddleware;
}

router.get("/read", (req: Request, res: Response) => {
  try {
    const filePath = (req.query.path as string) || "";
    const resolved = path.resolve(filePath);

    if (!isPathAllowed(resolved)) {
      return res.status(403).json({ error: "Access denied" });
    }

    if (!existsSync(resolved)) {
      return res.status(404).json({ error: "File not found" });
    }

    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: "Path is a directory" });
    }

    if (stat.size > MAX_FILE_SIZE) {
      return res.status(413).json({ error: `File too large (${Math.round(stat.size / 1024)}KB). Max ${MAX_FILE_SIZE / 1024 / 1024}MB.` });
    }

    const ext = path.extname(resolved).toLowerCase();
    const isImage = IMAGE_EXTENSIONS.has(ext);
    const isText = TEXT_EXTENSIONS.has(ext) || ext === "" || stat.size < 100 * 1024;

    if (isImage) {
      const buffer = readFileSync(resolved);
      const mimeType = ext === ".svg" ? "image/svg+xml" :
        ext === ".png" ? "image/png" :
        ext === ".gif" ? "image/gif" :
        "image/jpeg";
      // Durcissement XSS (lot sécurité) : un SVG navigué directement peut
      // exécuter du JS sur l'origine. CSP:sandbox l'en empêche sans casser le
      // rendu <img> utilisé par le preview du File Explorer.
      res.setHeader("Content-Type", mimeType);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "sandbox");
      res.setHeader("Content-Length", buffer.length);
      res.send(buffer);
      return;
    }

    if (isText) {
      const content = readFileSync(resolved, "utf-8");
      return res.json({
        path: filePath,
        name: path.basename(resolved),
        ext,
        size: stat.size,
        content,
      });
    }

    return res.status(415).json({ error: `Cannot preview file type: ${ext}` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── Write/save file content ──
router.put("/write", (req: Request, res: Response) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) {
      return res.status(400).json({ error: "path and content are required" });
    }
    const resolved = path.resolve(filePath);
    if (!isPathAllowed(resolved)) {
      return res.status(403).json({ error: "Access denied" });
    }
    writeFileSync(resolved, content, "utf-8");
    res.json({ success: true, path: filePath });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── Download file(s) ──
router.get("/download", (req: Request, res: Response) => {
  try {
    const paths = ((req.query.paths as string) || "").split("|").filter(Boolean);
    if (paths.length === 0) {
      return res.status(400).json({ error: "paths parameter required (pipe-separated)" });
    }

    const resolvedPaths = paths.map(p => path.resolve(p));
    for (const rp of resolvedPaths) {
      if (!isPathAllowed(rp)) return res.status(403).json({ error: `Access denied: ${rp}` });
      if (!existsSync(rp)) return res.status(404).json({ error: `Not found: ${rp}` });
    }

    // Single file (not a directory) — stream directly
    if (resolvedPaths.length === 1 && !statSync(resolvedPaths[0]).isDirectory()) {
      const resolved = resolvedPaths[0];
      const stat = statSync(resolved);
      const filename = path.basename(resolved);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", stat.size);
      createReadStream(resolved).pipe(res);
      return;
    }

    // Répertoire(s) ou plusieurs éléments : on construit une archive tar.gz à
    // la volée. Chaque entrée rencontrée (fichier ou sous-dossier) est
    // revalidée par isPathAllowed() (deny-list + realpath + confinement aux
    // racines autorisées), et les fichiers cachés (dotfiles) sont ignorés pour
    // rester cohérents avec le navigateur de fichiers. Aucun fichier sensible
    // (.git, .env*, credentials.enc, clés SSH, ...) ne peut donc être embarqué.
    const commonParent = commonParentOf(resolvedPaths);
    const files: { abs: string; rel: string }[] = [];
    const visitedDirs = new Set<string>(); // realpaths visités (anti-boucle symlink)

    const collectFiles = (targetPath: string): void => {
      if (!isPathAllowed(targetPath)) return;
      const stat = statSync(targetPath);
      if (!stat.isDirectory()) {
        // Le chemin relatif est toujours calculé par rapport au commonParent
        // (celui utilisé par tar), ce qui garantit une déduplication correcte
        // même pour deux fichiers de même nom dans des dossiers différents.
        files.push({ abs: targetPath, rel: path.relative(commonParent, targetPath) });
        return;
      }
      // Détection des boucles de liens symboliques via le chemin réel.
      let real: string;
      try { real = realpathSync(targetPath); } catch { return; }
      if (visitedDirs.has(real)) return;
      visitedDirs.add(real);

      let dirents;
      try { dirents = readdirSync(targetPath, { withFileTypes: true }); } catch { return; }
      for (const d of dirents) {
        if (d.name.startsWith(".")) continue; // fichiers cachés : masqués dans l'UI
        if (d.name.includes("\n")) continue;  // noms impossibles à passer à tar -T
        const abs = path.join(targetPath, d.name);
        try { collectFiles(abs); } catch { /* entrée inaccessible : ignorée */ }
      }
    };

    for (const rp of resolvedPaths) {
      try { collectFiles(rp); } catch { /* chemin inaccessible : ignoré */ }
    }

    // Déduplication par chemin relatif dans l'archive : le même dossier peut
    // apparaître plusieurs fois si l'utilisateur sélectionne un dossier ET ses
    // fichiers enfants (ex: bouton « select all »).
    const unique = new Map<string, string>();
    for (const f of files) {
      if (!unique.has(f.rel)) unique.set(f.rel, f.abs);
    }
    const entries = [...unique.entries()]
      .map(([rel, abs]) => ({ abs, rel }))
      .sort((a, b) => a.rel.localeCompare(b.rel));

    if (entries.length === 0) {
      return res.status(400).json({ error: "No downloadable files found in the selected paths." });
    }

    const basename = resolvedPaths.length === 1 ? path.basename(resolvedPaths[0]) : "download";
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${basename}.tar.gz"`);

    import("child_process").then(({ spawn }) => {
      const relNames = entries.map((f) => f.rel);
      // `-T -` évite les limites ARG_MAX sur les gros dossiers ; `-h` archive le
      // contenu des liens symboliques (validés par isPathAllowed) au lieu du lien.
      const child = spawn("tar", ["-czf", "-", "-h", "-C", commonParent, "-T", "-"], { cwd: commonParent });
      child.stdin.on("error", () => {}); // EPIPE si tar ferme stdin prématurément
      child.stdin.write(relNames.join("\n") + "\n");
      child.stdin.end();
      child.stdout.pipe(res);
      child.stderr.on("data", (d: Buffer) => console.error("[tar]", d.toString()));
      child.on("error", (e: Error) => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
      child.on("close", (code: number) => {
        if (code !== 0 && !res.headersSent) {
          res.status(500).json({ error: `tar exited with code ${code}` });
        }
      });
    }).catch((e: any) => {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    });
  } catch (error: any) {
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// ── Upload files ──
router.post("/upload", async (req: Request, res: Response) => {
  try {
    const upload = await getUploadMiddleware();
    upload.array("files", 50)(req, res, async (err: any) => {
      if (err) return res.status(400).json({ error: err.message });
      
      const targetPath = (req.body.targetPath as string) || "/projects";
      const resolved = path.resolve(targetPath);
      if (!isPathAllowed(resolved)) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (!existsSync(resolved)) mkdirSync(resolved, { recursive: true });
      
      const files = req.files as Express.Multer.File[];
      const uploaded: string[] = [];
      for (const file of files) {
        // Le nom original est contrôlé par le client : on le réduit à un
        // simple nom de fichier pour neutraliser tout path traversal.
        const safeName = path.basename(file.originalname);
        if (!safeName || safeName === "." || safeName === "..") {
          try { unlinkSync(file.path); } catch {}
          continue;
        }
        const dest = path.join(resolved, safeName);
        // Valide la destination finale avant écriture (et pas seulement targetPath).
        // isPathAllowed résout les liens symboliques réels du chemin existant,
        // ou valide le parent réel si le fichier n'existe pas encore.
        if (!isPathAllowed(path.resolve(dest))) {
          try { unlinkSync(file.path); } catch {}
          return res.status(403).json({ error: "Access denied" });
        }
        copyFileSync(file.path, dest);
        try { unlinkSync(file.path); } catch {}
        uploaded.push(safeName);
      }
      res.json({ success: true, uploaded, path: targetPath });
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
