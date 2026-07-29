import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import path from "path";
import { getWebclawConfig } from "../webclaw.js";
import { getTavilyConfig } from "../tavily.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "..", "..", "..", ".data", "docs");

// ── Types ──

interface DocEntry {
  name: string;
  version: string;
  type: string;
  description: string;
  filePath: string;
  keywords: string[];
  updatedAt: string;
  sourceUrl?: string;
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
  summary: string;
  keyPoints: string[];
  api: Array<{ signature: string; description: string }>;
  examples: Array<{ title: string; code: string }>;
  breakingChanges?: string[];
  rawContent?: string;
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

export function getWebclawConnection(): { url: string; apiKey: string } {
  const config = getWebclawConfig();
  return { url: config.url, apiKey: config.apiKey };
}

export async function webclawScrape(url: string): Promise<{ content: string; title?: string; description?: string }> {
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
    title: data.title || data.metadata?.title,
    description: data.description || data.metadata?.description,
  };
}

/**
 * Recherche web via Tavily API.
 */
async function tavilySearch(query: string, num: number = 5): Promise<Array<{ title: string; url: string; snippet: string; content?: string }>> {
  const { apiKey } = getTavilyConfig();
  if (!apiKey) throw new Error("Tavily API key not configured");

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: num,
      search_depth: "basic",
      include_answer: false,
    }),
  });
  if (!res.ok) throw new Error(`Tavily search failed: ${res.status}`);
  const data = await res.json();

  return (data.results || []).map((r: any) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.content?.substring(0, 200) || "",
    content: r.content,
  }));
}

/** Sanitize content of search results before returning them */
function sanitizeResults(results: Array<{ title: string; url: string; snippet: string; content?: string }>): Array<{ title: string; url: string; snippet: string; content?: string }> {
  return results.map(r => ({
    ...r,
    content: r.content ? sanitizeContent(r.content) : r.content,
  }));
}

/**
 * Recherche web via Webclaw.
 * Essaie d'abord /v1/search (cloud), puis Tavily, puis fallback sur /v1/scrape de DuckDuckGo (self-hosted).
 */
export async function webclawSearch(query: string, num: number = 5): Promise<Array<{ title: string; url: string; snippet: string; content?: string }>> {
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
      return sanitizeResults(data.results || []);
    }
    // 501 = Not Implemented (self-hosted sans search) → fallback
    if (res.status !== 501) throw new Error(`Webclaw search failed: ${res.status}`);
  } catch (e: any) {
    // Si c'est pas une 501, propager l'erreur
    if (!e.message.includes("501")) throw e;
  }

  // 2. Essayer Tavily (API search dédiée)
  try {
    console.log("[Librarian] Trying Tavily search");
    const tavilyResults = await tavilySearch(query, num);
    if (tavilyResults.length > 0) {
      console.log(`[Librarian] Tavily returned ${tavilyResults.length} results`);
      return sanitizeResults(tavilyResults);
    }
  } catch (e: any) {
    console.log(`[Librarian] Tavily unavailable: ${e.message}`);
  }

  // 3. Fallback : scraper DuckDuckGo HTML pour récupérer les résultats, puis scraper chaque URL
  console.log("[Librarian] Falling back to DuckDuckGo");
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const ddgResult = await webclawScrape(ddgUrl);

  // Extraire les URLs et titres depuis le markdown de DuckDuckGo.
  // DuckDuckGo wrap les URLs dans un redirect : //duckduckgo.com/l/?uddg=<url_encodée>&rut=...
  // Demander plus de résultats que nécessaire pour compenser les doublons
  const rawResults: Array<{ title: string; url: string; snippet: string; content?: string }> = [];
  const linkRegex = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let match;
  while ((match = linkRegex.exec(ddgResult.content)) !== null) {
    const title = match[1];
    let rawUrl = match[2];

    // Extraire l'URL réelle depuis le paramètre uddg du redirect DuckDuckGo
    const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      try { rawUrl = decodeURIComponent(uddgMatch[1]); } catch { continue; }
    }

    // Normaliser les URLs relatives (//example.com → https://example.com)
    if (rawUrl.startsWith("//")) rawUrl = "https:" + rawUrl;

    // Filtrer les liens internes et non-http
    if (!rawUrl.startsWith("http")) continue;
    if (rawUrl.includes("duckduckgo.com") || rawUrl.includes("duckduckgo.org")) continue;

    rawResults.push({ title, url: rawUrl, snippet: "", content: undefined });
  }

  // Dédupliquer par URL — DuckDuckGo retourne souvent le même lien plusieurs fois
  const seenUrls = new Set<string>();
  const results: Array<{ title: string; url: string; snippet: string; content?: string }> = [];
  for (const r of rawResults) {
    if (seenUrls.has(r.url)) continue;
    seenUrls.add(r.url);
    results.push(r);
    if (results.length >= num) break;
  }

  // 3. Scraper le contenu des 3 premiers résultats
  const toScrape = Math.min(3, results.length);
  for (let i = 0; i < toScrape; i++) {
    try {
      const scraped = await webclawScrape(results[i].url);
      results[i].content = sanitizeContent(scraped.content.substring(0, 5000));
      results[i].snippet = scraped.description || scraped.content.substring(0, 200);
      await new Promise(r => setTimeout(r, 1000));
    } catch {
      // Si une page ne peut pas être scrapée, on continue
    }
  }

  return sanitizeResults(results);
}

// ── Public API ──

// Mots trop courants pour être pertinents seuls
const STOPWORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was", "how", "what", "when", "why", "who", "use", "using", "into", "your", "have", "has", "not", "but", "can", "all", "any", "get", "set", "new", "old", "des", "les", "une", "sur", "dan", "par", "pas", "pour", "avec", "tout", "sont", "comment", "cette", "cela"]);

/** Recherche dans la bibliothèque locale */
export function searchLocalDocs(query: string): DocEntry[] {
  const index = loadIndex();
  const queryLower = query.toLowerCase();
  const allTerms = queryLower.split(/\s+/);
  // Filtrer : termes de 4+ chars qui ne sont pas des stopwords
  const terms = allTerms.filter(t => t.length >= 4 && !STOPWORDS.has(t));

  if (terms.length === 0) return [];

  // Scorer chaque doc par le nombre de termes qui matchent
  const scored = index.library
    .map(entry => {
      const searchable = (entry.name + " " + entry.description + " " + entry.keywords.join(" ")).toLowerCase();
      let matchCount = 0;
      for (const term of terms) {
        if (searchable.includes(term)) matchCount++;
      }
      return { entry, score: matchCount };
    })
    .filter(item => {
      // Au moins 2 termes doivent matcher, OU au moins 50% des termes
      const minMatches = Math.max(2, Math.ceil(terms.length * 0.5));
      return item.score >= minMatches;
    })
    .sort((a, b) => b.score - a.score);

  return scored.map(item => item.entry);
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

/** Recherche dans la bibliothèque locale puis sur le web (sans archivage automatique) */
export async function searchAndArchive(query: string): Promise<{
  results: Array<{ title: string; url: string; snippet: string; content?: string }>;
  archived: boolean;
}> {
  // 1. Chercher d'abord dans la bibliothèque locale
  const local = searchLocalDocs(query);
  if (local.length > 0) {
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
  // Sanitize content before persisting
  const sanitizedContent: DocContent = {
    ...content,
    rawContent: content.rawContent ? sanitizeContent(content.rawContent) : undefined,
  };

  ensureDocsDir();
  saveDoc(entry.filePath, sanitizedContent);

  const index = loadIndex();
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

/** Nettoie le contenu pour retirer toute information personnelle avant archivage */
function sanitizeContent(content: string): string {
  let cleaned = content;
  // Emails
  cleaned = cleaned.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email removed]");
  // API keys (sk-xxx, tvly-xxx, Bearer xxx)
  cleaned = cleaned.replace(/(?:sk-[A-Za-z0-9]{20,})|(?:tvly-[A-Za-z0-9]{20,})|(?:Bearer\s+[A-Za-z0-9._-]+)/gi, "[key removed]");
  // Chemins personnels (/home/user, /Users/name)
  cleaned = cleaned.replace(/\/(?:home|Users)\/[^\/\s]+/g, "[path removed]");
  cleaned = cleaned.replace(/C:\\\\Users\\[^\\\s]+/gi, "[path removed]");
  // Numéros de téléphone (format international et US)
  cleaned = cleaned.replace(/\b\+?\d{1,3}[-.\s]?\d{3}[-.\s]?\d{3,4}[-.\s]?\d{0,4}\b/g, "[phone removed]");
  return cleaned;
}

export type { DocEntry, DocContent, DocIndex };