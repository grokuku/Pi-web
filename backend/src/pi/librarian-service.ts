import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import path from "path";
import { getWebclawConfig } from "../webclaw.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "..", "..", "..", ".data", "docs");

// ── Types ──

interface DocEntry {
  name: string;           // ex: "express"
  version: string;        // ex: "4.21.0" ou "latest"
  type: string;           // "npm" | "tool" | "runtime"
  description: string;
  filePath: string;       // relative to DOCS_DIR
  keywords: string[];
  updatedAt: string;      // ISO date
  sourceUrl?: string;     // URL de la doc officielle
}

interface DocIndex {
  lastUpdated: string;
  lastScan: string;
  library: DocEntry[];
}

interface DocContent {
  meta: {
    name: string;
    version: string;
    type: string;
    sourceUrl?: string;
    updatedAt: string;
  };
  summary: string;           // résumé concis
  keyPoints: string[];       // points clés
  api: Array<{               // API principales
    signature: string;
    description: string;
  }>;
  examples: Array<{          // exemples pratiques
    title: string;
    code: string;
  }>;
  breakingChanges?: string[]; // si version différente
  rawContent?: string;        // contenu original (cache)
}

// ── Storage ──

function ensureDocsDir(): void {
  if (!existsSync(DOCS_DIR)) mkdirSync(DOCS_DIR, { recursive: true });
  const toolsDir = join(DOCS_DIR, "tools");
  if (!existsSync(toolsDir)) mkdirSync(toolsDir, { recursive: true });
}

export function loadIndex(): DocIndex {
  ensureDocsDir();
  const indexPath = join(DOCS_DIR, "index.json");
  if (!existsSync(indexPath)) {
    return { lastUpdated: "", lastScan: "", library: [] };
  }
  return JSON.parse(readFileSync(indexPath, "utf-8"));
}

export function saveIndex(index: DocIndex): void {
  ensureDocsDir();
  const indexPath = join(DOCS_DIR, "index.json");
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

function loadDoc(filePath: string): DocContent | null {
  const fullPath = join(DOCS_DIR, filePath);
  if (!existsSync(fullPath)) return null;
  return JSON.parse(readFileSync(fullPath, "utf-8"));
}

function saveDoc(filePath: string, doc: DocContent): void {
  ensureDocsDir();
  const fullPath = join(DOCS_DIR, filePath);
  const dir = path.dirname(fullPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, JSON.stringify(doc, null, 2));
}

// ── Webclaw integration ──

/** Get the current Webclaw connection config from settings */
export function getWebclawConnection(): { url: string; apiKey: string } {
  const config = getWebclawConfig();
  return { url: config.url, apiKey: config.apiKey };
}

async function webclawScrape(url: string): Promise<{ content: string; title?: string; description?: string }> {
  const { url: wcUrl, apiKey: wcApiKey } = getWebclawConnection();
  const res = await fetch(`${wcUrl}/v1/scrape`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(wcApiKey ? { "Authorization": `Bearer ${wcApiKey}` } : {}),
    },
    body: JSON.stringify({ url, format: "markdown" }),
  });
  if (!res.ok) throw new Error(`Webclaw scrape failed: ${res.status}`);
  const data = await res.json();
  return {
    content: data.content || data.markdown || "",
    title: data.title,
    description: data.description,
  };
}

/**
 * Recherche web via Webclaw.
 * Essaie d'abord /v1/search (cloud), puis fallback sur /v1/scrape de DuckDuckGo (self-hosted).
 */
async function webclawSearch(query: string, num: number = 5): Promise<Array<{ title: string; url: string; snippet: string; content?: string }>> {
  const { url: wcUrl, apiKey: wcApiKey } = getWebclawConnection();

  // 1. Essayer /v1/search (endpoint cloud — peut ne pas exister en self-hosted)
  try {
    const res = await fetch(`${wcUrl}/v1/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(wcApiKey ? { "Authorization": `Bearer ${wcApiKey}` } : {}),
      },
      body: JSON.stringify({ query, num, scrape: true }),
    });
    if (res.ok) {
      const data = await res.json();
      return data.results || [];
    }
    // 501 = Not Implemented (self-hosted sans search) → fallback
    if (res.status !== 501) throw new Error(`Webclaw search failed: ${res.status}`);
  } catch (e: any) {
    // Si c'est pas une 501, propager l'erreur
    if (!e.message.includes("501")) throw e;
  }

  // 2. Fallback : scraper DuckDuckGo HTML pour récupérer les résultats, puis scraper chaque URL
  console.log("[Librarian] /v1/search unavailable, using DuckDuckGo fallback");
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const ddgResult = await webclawScrape(ddgUrl);

  // Extraire les URLs et titres depuis le markdown de DuckDuckGo
  const results: Array<{ title: string; url: string; snippet: string; content?: string }> = [];
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let match;
  let count = 0;
  while ((match = linkRegex.exec(ddgResult.content)) !== null && count < num) {
    const title = match[1];
    const url = match[2];
    // Filtrer les liens internes DuckDuckGo
    if (url.includes("duckduckgo.com") || url.includes("duckduckgo.org")) continue;
    results.push({ title, url, snippet: "", content: undefined });
    count++;
  }

  // 3. Scraper le contenu des 3 premiers résultats (pour éviter trop de requêtes)
  const toScrape = Math.min(3, results.length);
  for (let i = 0; i < toScrape; i++) {
    try {
      const scraped = await webclawScrape(results[i].url);
      results[i].content = scraped.content.substring(0, 5000);
      results[i].snippet = scraped.description || scraped.content.substring(0, 200);
      // Rate limiting
      await new Promise(r => setTimeout(r, 1000));
    } catch {
      // Si une page ne peut pas être scrapée, on continue
    }
  }

  return results;
}

// ── Public API ──

/** Recherche dans la bibliothèque locale */
export function searchLocalDocs(query: string): DocEntry[] {
  const index = loadIndex();
  const queryLower = query.toLowerCase();
  const terms = queryLower.split(/\s+/);

  return index.library.filter(entry => {
    const searchable = (entry.name + " " + entry.description + " " + entry.keywords.join(" ")).toLowerCase();
    return terms.some(term => searchable.includes(term));
  });
}

/** Récupère le contenu d'un doc */
export function getDocContent(name: string, version?: string): DocContent | null {
  const index = loadIndex();
  const entry = index.library.find(e =>
    e.name === name && (!version || e.version === version)
  );
  if (!entry) return null;
  return loadDoc(entry.filePath);
}

/** Recherche via Webclaw + archivage */
export async function searchAndArchive(query: string): Promise<{
  results: Array<{ title: string; url: string; snippet: string; content?: string }>;
  archived: boolean;
}> {
  // 1. Chercher d'abord dans la bibliothèque locale
  const local = searchLocalDocs(query);
  if (local.length > 0) {
    // Retourner le contenu local
    const docs = local.map(entry => {
      const content = loadDoc(entry.filePath);
      return {
        title: `${entry.name} v${entry.version}`,
        url: entry.sourceUrl || "",
        snippet: content?.summary || entry.description,
        content: content ? formatDocAsText(content) : undefined,
      };
    });
    return { results: docs, archived: false };
  }

  // 2. Sinon, chercher sur le web via Webclaw
  const webResults = await webclawSearch(query, 5);
  return { results: webResults, archived: false };
}

/** Archive un document dans la bibliothèque */
export function archiveDoc(entry: DocEntry, content: DocContent): void {
  ensureDocsDir();
  saveDoc(entry.filePath, content);

  const index = loadIndex();
  // Remplacer si existe déjà (même name + version)
  const existingIdx = index.library.findIndex(e =>
    e.name === entry.name && e.version === entry.version
  );
  if (existingIdx >= 0) {
    index.library[existingIdx] = entry;
  } else {
    index.library.push(entry);
  }
  index.lastUpdated = new Date().toISOString();
  saveIndex(index);
}

/** Liste toute la bibliothèque */
export function listLibrary(): DocIndex {
  return loadIndex();
}

/** Formate un doc en texte pour le LLM */
function formatDocAsText(doc: DocContent): string {
  let text = `# ${doc.meta.name} v${doc.meta.version}\n\n`;
  text += `## Summary\n${doc.summary}\n\n`;
  if (doc.keyPoints.length > 0) {
    text += `## Key Points\n`;
    doc.keyPoints.forEach(p => text += `- ${p}\n`);
    text += "\n";
  }
  if (doc.api.length > 0) {
    text += `## API\n`;
    doc.api.forEach(a => text += `- **${a.signature}**: ${a.description}\n`);
    text += "\n";
  }
  if (doc.examples.length > 0) {
    text += `## Examples\n`;
    doc.examples.forEach(ex => {
      text += `### ${ex.title}\n\`\`\`\n${ex.code}\n\`\`\`\n\n`;
    });
  }
  if (doc.breakingChanges && doc.breakingChanges.length > 0) {
    text += `## Breaking Changes\n`;
    doc.breakingChanges.forEach(c => text += `- ${c}\n`);
  }
  return text;
}

/** Scraping d'une URL pour documentation */
export async function scrapeForDoc(url: string): Promise<{ content: string; title?: string; description?: string }> {
  return webclawScrape(url);
}

/** Récupère le statut de la bibliothèque */
export function getLibraryStatus(): { totalDocs: number; lastUpdated: string; lastScan: string } {
  const index = loadIndex();
  return {
    totalDocs: index.library.length,
    lastUpdated: index.lastUpdated,
    lastScan: index.lastScan,
  };
}

export { webclawScrape, webclawSearch };
export type { DocEntry, DocContent, DocIndex };