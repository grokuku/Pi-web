import { readFileSync, existsSync } from "fs";
import { join } from "path";

interface InventoryItem {
  name: string;
  version: string;
  type: "npm" | "runtime" | "tool";
  source?: string;  // URL de la doc
}

interface ProjectInventory {
  runtime: InventoryItem[];
  dependencies: InventoryItem[];
  devDependencies: InventoryItem[];
  tools: InventoryItem[];
}

/** Scan l'inventaire technique d'un projet */
export async function scanProjectInventory(cwd: string): Promise<ProjectInventory> {
  const inventory: ProjectInventory = {
    runtime: [],
    dependencies: [],
    devDependencies: [],
    tools: [],
  };

  // 1. Node.js version
  const nvmrcPath = join(cwd, ".nvmrc");
  if (existsSync(nvmrcPath)) {
    const version = readFileSync(nvmrcPath, "utf-8").trim();
    inventory.runtime.push({
      name: "node",
      version,
      type: "runtime",
      source: `https://nodejs.org/docs/v${version}/api/`,
    });
  }

  // 2. package.json — chercher à la racine et dans les sous-dossiers communs
  const possiblePkgPaths = [
    join(cwd, "package.json"),
    join(cwd, "backend", "package.json"),
    join(cwd, "frontend", "package.json"),
    join(cwd, "server", "package.json"),
    join(cwd, "client", "package.json"),
    join(cwd, "web", "package.json"),
    join(cwd, "api", "package.json"),
    join(cwd, "app", "package.json"),
  ];

  // Utiliser un Set pour ne pas parser deux fois le même fichier
  const seenPkgPaths = new Set<string>();
  for (const pkgPath of possiblePkgPaths) {
    if (!existsSync(pkgPath) || seenPkgPaths.has(pkgPath)) continue;
    seenPkgPaths.add(pkgPath);

    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

      // Dependencies
      if (pkg.dependencies) {
        for (const [name, version] of Object.entries(pkg.dependencies)) {
          inventory.dependencies.push({
            name,
            version: version as string,
            type: "npm",
            source: `https://www.npmjs.com/package/${name}`,
          });
        }
      }

      // DevDependencies
      if (pkg.devDependencies) {
        for (const [name, version] of Object.entries(pkg.devDependencies)) {
          inventory.devDependencies.push({
            name,
            version: version as string,
            type: "npm",
            source: `https://www.npmjs.com/package/${name}`,
          });
        }
      }

      // Engines (Node version requirement)
      if (pkg.engines?.node) {
        inventory.runtime.push({
          name: "node",
          version: pkg.engines.node,
          type: "runtime",
          source: "https://nodejs.org/docs/latest/api/",
        });
      }
    } catch (e) {
      // package.json invalide, on skip
    }
  }

  // 3. Outils de build communs (détection par présence de fichiers)
  const toolFiles: Record<string, InventoryItem> = {
    "tsconfig.json": { name: "typescript", version: "latest", type: "tool", source: "https://www.typescriptlang.org/docs/" },
    "tailwind.config.js": { name: "tailwindcss", version: "latest", type: "tool", source: "https://tailwindcss.com/docs" },
    "tailwind.config.ts": { name: "tailwindcss", version: "latest", type: "tool", source: "https://tailwindcss.com/docs" },
    "vite.config.ts": { name: "vite", version: "latest", type: "tool", source: "https://vitejs.dev/guide/" },
    "vite.config.js": { name: "vite", version: "latest", type: "tool", source: "https://vitejs.dev/guide/" },
    "Dockerfile": { name: "docker", version: "latest", type: "tool", source: "https://docs.docker.com/" },
    "docker-compose.yml": { name: "docker-compose", version: "latest", type: "tool", source: "https://docs.docker.com/compose/" },
  };

  for (const [file, item] of Object.entries(toolFiles)) {
    if (existsSync(join(cwd, file))) {
      inventory.tools.push(item);
    }
  }

  return inventory;
}

/** Retourne tous les items à documenter (unique par name) */
export function getAllItems(inventory: ProjectInventory): InventoryItem[] {
  const all = [
    ...inventory.runtime,
    ...inventory.dependencies,
    ...inventory.devDependencies,
    ...inventory.tools,
  ];
  // Dédupliquer par name (garder la version la plus spécifique)
  const seen = new Map<string, InventoryItem>();
  for (const item of all) {
    const existing = seen.get(item.name);
    if (!existing || (item.version !== "latest" && existing.version === "latest")) {
      seen.set(item.name, item);
    }
  }
  return Array.from(seen.values());
}

export type { ProjectInventory, InventoryItem };