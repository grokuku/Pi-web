import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";

interface ScanResult {
  html: string;
  css: string;
  designSystem?: {
    colors: Record<string, string>;
    fontFamily?: string;
  };
}

export async function scanProjectForDesign(cwd: string): Promise<ScanResult> {
  const result: ScanResult = { html: "", css: "" };

  // 1. Chercher index.html
  const indexHtmlPath = join(cwd, "index.html");
  if (existsSync(indexHtmlPath)) {
    const content = readFileSync(indexHtmlPath, "utf-8");
    // Extraire le body
    const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) {
      result.html = bodyMatch[1].trim();
    }
    // Extraire le CSS inline
    const styleMatch = content.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
    if (styleMatch) {
      result.css = styleMatch.map(s => s.replace(/<\/?style[^>]*>/gi, "")).join("\n");
    }
  }

  // 2. Si pas de HTML trouvé, chercher App.tsx/App.jsx
  if (!result.html) {
    for (const ext of [".tsx", ".jsx", ".js", ".ts"]) {
      const appPath = join(cwd, "src", `App${ext}`);
      if (existsSync(appPath)) {
        const content = readFileSync(appPath, "utf-8");
        // Extraire le JSX/structure de base
        result.html = `<div id="root">\n<!-- Projet React détecté. App${ext} trouvé. -->\n<!-- Demandez au LLM d'analyser le projet pour générer le design. -->\n</div>`;
        break;
      }
    }
  }

  // 3. Chercher les fichiers CSS
  if (!result.css) {
    const cssDirs = ["src", "src/styles", "src/css", "public", "."];
    for (const dir of cssDirs) {
      const cssDir = join(cwd, dir);
      if (existsSync(cssDir)) {
        try {
          const files = readdirSync(cssDir);
          for (const file of files) {
            if (extname(file) === ".css") {
              const cssContent = readFileSync(join(cssDir, file), "utf-8");
              result.css += cssContent + "\n";
            }
          }
        } catch {}
      }
    }
  }

  // 4. Chercher tailwind.config.js pour extraire les couleurs
  const tailwindPath = join(cwd, "tailwind.config.js");
  if (existsSync(tailwindPath)) {
    const content = readFileSync(tailwindPath, "utf-8");
    // Extraire les couleurs (approximatif)
    const colorsMatch = content.match(/colors:\s*{([^}]+)}/);
    if (colorsMatch) {
      const colorLines = colorsMatch[1].match(/(\w+):\s*['"]([^'"]+)['"]/g);
      if (colorLines) {
        result.designSystem = {
          colors: Object.fromEntries(
            colorLines.map(line => {
              const m = line.match(/(\w+):\s*['"]([^'"]+)['"]/);
              return m ? [m[1], m[2]] : null;
            }).filter(Boolean) as [string, string][]
          ),
        };
      }
    }
  }

  // 5. Si toujours rien, mettre un template par défaut
  if (!result.html) {
    result.html = '<div style="padding: 40px; text-align: center;"><h1>Projet détecté</h1><p>Aucun design visuel trouvé. Demandez au LLM de générer un design.</p></div>';
  }

  return result;
}