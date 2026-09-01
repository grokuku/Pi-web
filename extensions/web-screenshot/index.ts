/**
 * web-screenshot Extension for Pi-Web
 *
 * Tool GLOBAL « web_screenshot » : prend un screenshot headless d'une page web
 * ou d'un mockup HTML afin que le LLM puisse voir le rendu réel.
 *
 * Le SDK Pi (pi-coding-agent) accepte du contenu image dans les tool results
 * (type "image" : { data: base64, mimeType }). On retourne donc le PNG encodé
 * en base64 directement dans le résultat — le LLM le voit sans étape
 * supplémentaire. Le PNG est aussi conservé dans /tmp et son chemin est
 * retourné (utile pour un éventuel fallback attachment).
 *
 * Détection du binaire Chromium :
 *   1. variable d'environnement CHROMIUM_PATH
 *   2. `which` sur chromium / chromium-browser / google-chrome / google-chrome-stable
 *   Si aucun → message d'erreur ACTIONNABLE (ajout au Dockerfile).
 *
 * Sources supportées :
 *   - html      : chaîne HTML inline → écrite dans /tmp puis chargée via file://
 *   - htmlPath  : chemin vers un fichier HTML local → file://
 *   - url       : URL distante utilisée telle quelle
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync, spawn } from "child_process";
import { randomUUID } from "crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import path from "path";

type JSONSchema = { type: string; [key: string]: unknown };

// ─── Config ──────────────────────────────────────────────
const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;
const DEFAULT_TIMEOUT_MS = 15000;
const VIRTUAL_TIME_BUDGET_MS = 5000;

// ─── Pi-Web attachments ─────────────────────────────────
// Même répertoire que backend/src/routes/attachments.ts (ATTACHMENTS_DIR).
// On le hardcode ici (identique) car l'extension ne peut pas importer le module
// attachments sans créer un import circulaire. Le backend sert ensuite le fichier
// via GET /api/attachments/:id/file avec Content-Type image/png (inline).
const ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR || "/data/attachments";
const PI_WEB_URL = process.env.PI_WEB_URL || "http://localhost:3000";

/**
 * Uploade un PNG comme attachment Pi-Web (même mécanique que /api/attachments/upload).
 * Écrit le fichier dans ATTACHMENTS_DIR/<uuid>/ et le meta.json associé.
 * Retourne l'id de l'attachment, ou null en cas d'échec (non bloquant).
 */
function uploadScreenshotAsAttachment(
  pngPath: string,
  projectId: string
): { id: string; url: string } | null {
  try {
    const id = randomUUID();
    const ts = Date.now();
    const name = `screenshot-${ts}.png`;
    const size = existsSync(pngPath) ? readFileSync(pngPath).length : 0;

    const dir = path.join(ATTACHMENTS_DIR, id);
    mkdirSync(dir, { recursive: true });
    copyFileSync(pngPath, path.join(dir, name));

    const meta = {
      id,
      name,
      originalName: name,
      mimeType: "image/png",
      size,
      category: "image",
      projectId,
      uploadedAt: new Date().toISOString(),
    };
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");

    return { id, url: `${PI_WEB_URL}/api/attachments/${id}/file` };
  } catch (e: any) {
    console.error("[web-screenshot] Failed to upload attachment:", e?.message || e);
    return null;
  }
}

/**
 * Injecte le screenshot dans le FIL DU CHAT comme miniature cliquable.
 *
 * Appelle la route INTERNE du backend (localhost → apiAuth bypass, pas de
 * Bearer requis) POST /api/attachments/:id/inject-to-chat : elle ajoute à la
 * session Pi du projet un message custom portant `details.attachmentRefs =
 * [{ id, name, category: "image", size }]`. Le frontend (ChatView/UserBubble)
 * rend cette ref comme une miniature cliquable → viewer plein écran.
 *
 * - `cwd` (chemin exact du projet) est la clé de résolution fiable : le ctx
 *   de l'extension n'expose pas l'UUID du projet, et le basename du cwd n'en
 *   est PAS un (le backend retrouve le projet par son cwd).
 * - Échec silencieux : le tool retourne de toute façon l'image base64 au LLM.
 */
async function injectScreenshotToChat(
  attachmentId: string,
  cwd: string | undefined,
  projectId: string,
  caption: string
): Promise<void> {
  try {
    const res = await fetch(
      `${PI_WEB_URL}/api/attachments/${encodeURIComponent(attachmentId)}/inject-to-chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, cwd, caption }),
      }
    );
    if (!res.ok) {
      console.warn(`[web-screenshot] inject-to-chat failed: HTTP ${res.status}`);
      return;
    }
    const data = await res.json().catch(() => null);
    if (data?.injected === false) {
      console.warn("[web-screenshot] inject-to-chat: no active session for this project");
    } else {
      console.log(`[web-screenshot] Screenshot ${attachmentId} injected to chat`);
    }
  } catch (e: any) {
    // Non bloquant : la miniature dans le fil est un plus, pas une nécessité.
    console.warn("[web-screenshot] inject-to-chat error (ignored):", e?.message || e);
  }
}

// ─── Détection du binaire Chromium ──────────────────────
const CHROMIUM_CANDIDATES = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
];

/**
 * Retourne le chemin du binaire Chromium, ou null si introuvable.
 * Priorité : env CHROMIUM_PATH, puis `which` sur les candidats usuels.
 */
function detectChromium(): string | null {
  if (process.env.CHROMIUM_PATH) {
    return process.env.CHROMIUM_PATH;
  }
  for (const candidate of CHROMIUM_CANDIDATES) {
    try {
      const out = execSync(`which ${candidate}`, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) return out;
    } catch {
      // candidat absent — on continue
    }
  }
  return null;
}

// ─── Exécution avec timeout + kill ──────────────────────
interface RunResult {
  code: number | null;
  signal: string | null;
}

/**
 * Lance une commande avec un timeout. Au dépassement, le process est tué
 * (SIGKILL) pour ne jamais laisser un Chromium orphelin.
 */
function runWithTimeout(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* déjà terminé */
      }
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, signal: null });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/**
 * Capture un screenshot Chromium headless.
 * Essai 1 : --headless=new ; en cas d'échec, essai 2 : --headless (ancien mode).
 * Retourne true si le PNG a bien été produit.
 */
async function captureScreenshot(
  bin: string,
  target: string,
  outPath: string,
  width: number,
  height: number,
  timeoutMs: number
): Promise<boolean> {
  const baseArgs = [
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    `--window-size=${width},${height}`,
    `--screenshot=${outPath}`,
    `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
    target,
  ];

  // Essai 1 : mode headless=new (recommandé)
  const r1 = await runWithTimeout(bin, ["--headless=new", ...baseArgs], timeoutMs);
  if (r1.code === 0 && existsSync(outPath)) return true;

  // Essai 2 : mode headless (ancien) — fallback si le nouveau mode échoue
  const r2 = await runWithTimeout(bin, ["--headless", ...baseArgs], timeoutMs);
  return r2.code === 0 && existsSync(outPath);
}

// ─── Schéma des paramètres ──────────────────────────────
const parameters = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description:
        "URL distante à capturer (ex. https://example.com). Alternative à html/htmlPath.",
    },
    html: {
      type: "string",
      description:
        "Code HTML inline à rendre (mockup). Écrit dans /tmp puis chargé via file://.",
    },
    htmlPath: {
      type: "string",
      description: "Chemin vers un fichier HTML local à rendre (chargé via file://).",
    },
    width: {
      type: "number",
      description: "Largeur de la fenêtre (viewport). Défaut : 1440.",
    },
    height: {
      type: "number",
      description: "Hauteur de la fenêtre (viewport). Défaut : 900.",
    },
    timeoutMs: {
      type: "number",
      description: "Timeout d'exécution en millisecondes. Défaut : 15000.",
    },
  },
} satisfies JSONSchema;

// ─── Extension Entry Point ──────────────────────────────
export default function (pi: ExtensionAPI) {
  console.log("[web-screenshot] Extension loaded, registering web_screenshot tool...");

  // Tool GLOBAL : s'assurer qu'il est actif dans toutes les sessions.
  pi.on("session_start", () => {
    try {
      const active = pi.getActiveTools();
      if (!active.includes("web_screenshot")) {
        pi.setActiveTools([...active, "web_screenshot"]);
        console.log("[web-screenshot] Added web_screenshot to active tools");
      }
    } catch (e: any) {
      console.error("[web-screenshot] Failed to activate tool:", e.message);
    }
  });

  pi.registerTool({
    name: "web_screenshot",
    label: "Web Screenshot",
    description:
      "Prend un screenshot headless d'une page web ou d'un mockup HTML et le renvoie " +
      "en image au LLM. Accepte une URL distante, du HTML inline, ou un chemin vers un " +
      "fichier HTML local. Utilisez-le pour vérifier le rendu réel d'un mockup ou d'une page.",
    promptSnippet: "Capture a headless screenshot of a web page or HTML mockup",
    promptGuidelines: [
      "Utilisez web_screenshot pour vérifier le rendu réel d'un mockup HTML ou d'une page web.",
      "Passez du HTML inline via le paramètre html, un fichier via htmlPath, ou une URL via url.",
      "Ajustez width/height pour contrôler la taille du viewport (défaut 1440x900).",
    ],
    parameters,
    async execute(
      _toolCallId: string,
      params: {
        url?: string;
        html?: string;
        htmlPath?: string;
        width?: number;
        height?: number;
        timeoutMs?: number;
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: any
    ) {
      const width = params.width ?? DEFAULT_WIDTH;
      const height = params.height ?? DEFAULT_HEIGHT;
      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      // 1) Détection du binaire — message d'erreur ACTIONNABLE si absent.
      const bin = detectChromium();
      if (!bin) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Chromium not found — add to Dockerfile: apt-get install -y chromium",
            },
          ],
          details: {},
        };
      }

      // 2) Déterminer la cible (url / html / htmlPath).
      let target: string;
      let tempHtmlPath: string | null = null;
      try {
        if (params.html) {
          tempHtmlPath = `/tmp/web-screenshot-${Date.now()}.html`;
          writeFileSync(tempHtmlPath, params.html, "utf-8");
          target = `file://${tempHtmlPath}`;
        } else if (params.htmlPath) {
          target = `file://${path.resolve(params.htmlPath)}`;
        } else if (params.url) {
          target = params.url;
        } else {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "web_screenshot : fournir au moins un des paramètres url, html ou htmlPath.",
              },
            ],
            details: {},
          };
        }

        // 3) Capture du screenshot.
        const outPath = `/tmp/web-screenshot-${Date.now()}.png`;
        const ok = await captureScreenshot(bin, target, outPath, width, height, timeoutMs);
        if (!ok || !existsSync(outPath)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `web_screenshot : échec de la capture (binaire=${bin}, cible=${target}).`,
              },
            ],
            details: {},
          };
        }

        // 4) Lire le PNG, encoder en base64, retourner en image.
        const buffer = readFileSync(outPath);
        const base64 = buffer.toString("base64");
        const size = buffer.length;

        // 4bis) Uploader le PNG comme attachment Pi-Web pour que l'UTILISATEUR
        // puisse le voir dans son browser (URL cliquable) sans commande docker.
        const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : "";
        const projectId = cwd ? cwd.split("/").pop() || "" : "";
        const attachment = uploadScreenshotAsAttachment(outPath, projectId);

        // 4ter) Injecter la miniature dans le fil du chat (route interne,
        // échec silencieux — le LLM a déjà l'image base64 dans le tool result).
        if (attachment) {
          const targetDesc = params.url || tempHtmlPath || params.htmlPath || "inline html";
          await injectScreenshotToChat(
            attachment.id,
            cwd,
            projectId,
            `📸 Web screenshot ${width}×${height} — ${targetDesc}`
          );
        }

        const text = attachment
          ? `Screenshot ${width}x${height} (${size} bytes) — chemin: ${outPath}\n` +
            `Attachment: ${attachment.id}\n` +
            `Ouvrir dans le navigateur: ${attachment.url}`
          : `Screenshot ${width}x${height} (${size} bytes) — chemin: ${outPath} (upload attachment échoué)`;

        return {
          content: [
            { type: "text" as const, text },
            { type: "image" as const, data: base64, mimeType: "image/png" },
          ],
          details: {},
        };
      } catch (e: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `web_screenshot : erreur — ${e?.message || String(e)}`,
            },
          ],
          details: {},
        };
      } finally {
        // 5) Nettoyage du fichier HTML temporaire (le PNG de /tmp est conservé).
        if (tempHtmlPath) {
          try {
            unlinkSync(tempHtmlPath);
          } catch {
            /* déjà supprimé */
          }
        }
      }
    },
  });
}
