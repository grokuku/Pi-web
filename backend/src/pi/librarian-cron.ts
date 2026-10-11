import { scanProjectInventory, getAllItems, type InventoryItem } from "./librarian-scanner.js";
import { loadIndex, saveIndex, archiveDoc, webclawScrape, webclawSearch, type DocEntry, type DocContent } from "./librarian-service.js";
import {
  getLibrarianBackend,
  libryFetch,
  librySearch,
  libryArchive,
  type LibrarianBackend,
} from "../libry/client.js";

const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
const SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000; // Check toutes les 6h

let cronTimer: NodeJS.Timeout | null = null;

// ── Récupération du contenu brut (sans synthèse LLM) ──
// Lot B : la synthèse IA a été RETIRÉE de ce fichier (découplage du SDK Pi).
// Le contenu brut est désormais archivé tel quel, que le libraire soit local
// (archiveDoc) ou Libry (libryArchive). Le CRON reste le seul mécanisme
// d'entretien ; il se contente d'un « inventaire → push ».

async function fetchRawContent(
  item: InventoryItem,
  backend: LibrarianBackend,
): Promise<{ content: string; sourceUrl?: string }> {
  let rawContent = "";
  let sourceUrl = item.source;

  // 1. Si on a une URL source, récupérer directement.
  if (sourceUrl) {
    try {
      rawContent =
        backend === "libry"
          ? (await libryFetch(sourceUrl)).content
          : (await webclawScrape(sourceUrl)).content;
    } catch (e) {
      console.log(`[Librarian] Direct scrape failed for ${item.name}, trying search...`);
    }
  }

  // 2. Sinon, rechercher puis prendre le premier contenu.
  if (!rawContent) {
    try {
      if (backend === "libry") {
        const search = await librySearch(`${item.name} ${item.version} documentation`);
        if (search.results.length > 0 && search.results[0].content) {
          rawContent = search.results[0].content;
          sourceUrl = search.results[0].url;
        }
      } else {
        const results = await webclawSearch(`${item.name} ${item.version} documentation`, 3);
        if (results.length > 0 && results[0].content) {
          rawContent = results[0].content;
          sourceUrl = results[0].url;
        }
      }
    } catch (e) {
      console.log(`[Librarian] Search failed for ${item.name}: ${(e as Error).message}`);
    }
  }

  return { content: rawContent, sourceUrl };
}

/** Construit le doc à partir du contenu BRUT (plus de synthèse LLM). */
function buildInventoryDoc(item: InventoryItem, rawContent: string): DocContent {
  const summary = rawContent.replace(/\s+/g, " ").trim().substring(0, 200);
  return {
    meta: { name: item.name, version: item.version, type: item.type, updatedAt: new Date().toISOString() },
    summary,
    keyPoints: [],
    api: [],
    examples: [],
    rawContent,
  };
}

// ── Récupération + archivage pour un item ──

async function fetchAndArchiveDoc(item: InventoryItem, backend: LibrarianBackend): Promise<boolean> {
  try {
    console.log(`[Librarian] Fetching doc for ${item.name} v${item.version}...`);

    const { content: rawContent, sourceUrl } = await fetchRawContent(item, backend);
    if (!rawContent) {
      console.log(`[Librarian] No content found for ${item.name}`);
      return false;
    }

    const docContent = buildInventoryDoc(item, rawContent);
    docContent.meta.sourceUrl = sourceUrl;

    const filePath = `tools/${item.name}@${item.version}.json`;
    const entry: DocEntry = {
      name: item.name,
      version: item.version,
      type: item.type,
      description: docContent.summary.substring(0, 200),
      filePath,
      keywords: [item.name, item.type, ...docContent.keyPoints.slice(0, 5)],
      updatedAt: new Date().toISOString(),
      sourceUrl,
    };

    if (backend === "libry") {
      await libryArchive({
        name: item.name,
        version: item.version,
        type: item.type,
        sourceUrl,
        content: {
          summary: docContent.summary,
          keyPoints: docContent.keyPoints,
          api: docContent.api,
          examples: docContent.examples,
          rawContent: docContent.rawContent,
        },
      });
    } else {
      archiveDoc(entry, docContent);
    }

    console.log(`[Librarian] Archived doc for ${item.name} v${item.version} (${backend})`);
    return true;
  } catch (error: any) {
    console.error(`[Librarian] Failed to fetch doc for ${item.name}:`, error.message);
    return false;
  }
}

// ── Update cycle ──

export async function updateLibrary(projectCwds: string[]): Promise<{ scanned: number; updated: number; failed: number }> {
  console.log("[Librarian] Starting library update...");

  // Lot B : le backend est résolu UNE fois par cycle (relecture à chaud au tick suivant).
  const backend = getLibrarianBackend();

  // 1. Collecter tous les items de tous les projets
  const allItems: InventoryItem[] = [];
  for (const cwd of projectCwds) {
    try {
      const inventory = await scanProjectInventory(cwd);
      allItems.push(...getAllItems(inventory));
    } catch (e) {
      // Skip si le projet n'a pas de package.json
    }
  }

  // 2. Dédupliquer
  const seen = new Map<string, InventoryItem>();
  for (const item of allItems) {
    const key = `${item.name}@${item.version}`;
    if (!seen.has(key)) seen.set(key, item);
  }
  const uniqueItems = Array.from(seen.values());

  console.log(`[Librarian] Found ${uniqueItems.length} unique items to document`);

  // 3. Vérifier lesquels ont besoin d'une mise à jour
  const index = loadIndex();
  const now = Date.now();
  const itemsToUpdate: InventoryItem[] = [];

  for (const item of uniqueItems) {
    const existing = index.library.find(e => e.name === item.name && e.version === item.version);
    if (!existing) {
      itemsToUpdate.push(item);
    } else {
      const age = now - new Date(existing.updatedAt).getTime();
      if (age > WEEKLY_MS) {
        itemsToUpdate.push(item);
      }
    }
  }

  console.log(`[Librarian] ${itemsToUpdate.length} items need update`);

  // 4. Fetch + archive (rate limited: 2s entre chaque)
  let updated = 0;
  let failed = 0;

  for (const item of itemsToUpdate) {
    const success = await fetchAndArchiveDoc(item, backend);
    if (success) updated++;
    else failed++;

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // 5. Update index timestamps
  const finalIndex = loadIndex();
  finalIndex.lastUpdated = new Date().toISOString();
  finalIndex.lastScan = new Date().toISOString();
  saveIndex(finalIndex);

  console.log(`[Librarian] Update complete: ${updated} updated, ${failed} failed`);
  return { scanned: uniqueItems.length, updated, failed };
}

// ── Cron ──

export function startLibrarianCron(getProjectCwds: () => string[]): void {
  if (cronTimer) {
    clearInterval(cronTimer);
  }

  // Check toutes les 6h si une update est nécessaire
  cronTimer = setInterval(async () => {
    try {
      const index = loadIndex();
      const lastUpdated = index.lastUpdated ? new Date(index.lastUpdated).getTime() : 0;
      const age = Date.now() - lastUpdated;

      if (age > WEEKLY_MS) {
        console.log("[Librarian] Weekly update triggered");
        const cwds = getProjectCwds();
        if (cwds.length > 0) {
          try {
            await updateLibrary(cwds);
          } catch (e: any) {
            console.error("[Librarian] Cron update failed:", e.message);
          }
        }
      }
    } catch (e: any) {
      console.error("[Librarian] Cron tick error:", e.message);
    }
  }, SCAN_INTERVAL_MS);

  console.log("[Librarian] Cron started (checking every 6h, weekly updates)");
}

export function stopLibrarianCron(): void {
  if (cronTimer) {
    clearInterval(cronTimer);
    cronTimer = null;
  }
}
