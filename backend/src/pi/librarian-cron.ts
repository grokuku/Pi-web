import { completeSimple } from "@earendil-works/pi-ai";
import { scanProjectInventory, getAllItems, type InventoryItem } from "./librarian-scanner.js";
import { loadIndex, saveIndex, archiveDoc, webclawScrape, webclawSearch, type DocEntry, type DocContent } from "./librarian-service.js";
import { getModelRegistry, reloadModelRegistry } from "./session.js";
import { loadModelLibrary, getDefaultModel } from "./model-library.js";

const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
const SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000; // Check toutes les 6h

let cronTimer: NodeJS.Timeout | null = null;

// ── Model resolution ──

async function getLibrarianModel(): Promise<{ model: any; apiKey?: string } | null> {
  try {
    reloadModelRegistry();
    const registry = getModelRegistry();
    const library = loadModelLibrary();

    // 1. Try default model from library
    let model: any = null;
    let apiKey: string | undefined;

    const defaultModel = getDefaultModel(library);
    if (defaultModel) {
      model = registry.find(defaultModel.providerId, defaultModel.modelId);
    }

    // 2. Fallback: first available model
    if (!model?.id) {
      const available = registry.getAvailable();
      if (available.length > 0) {
        model = available[0];
      }
    }

    if (!model?.id) {
      console.warn("[Librarian] No model available for synthesis");
      return null;
    }

    // Get API key
    const auth = await registry.getApiKeyAndHeaders(model);
    if (auth.ok) apiKey = (auth as any).apiKey;

    return { model, apiKey };
  } catch (e: any) {
    console.error("[Librarian] Failed to resolve model:", e.message);
    return null;
  }
}

// ── Synthèse LLM ──

async function synthesizeDoc(item: InventoryItem, rawContent: string): Promise<DocContent> {
  const modelInfo = await getLibrarianModel();
  if (!modelInfo) {
    return {
      meta: { name: item.name, version: item.version, type: item.type, updatedAt: new Date().toISOString() },
      summary: "No LLM model available for synthesis",
      keyPoints: [],
      api: [],
      examples: [],
    };
  }

  const prompt = `Tu es un libraire technique. Synthétise la documentation suivante en une référence concise et utile pour un développeur.

Outil: ${item.name} v${item.version}
Type: ${item.type}

Documentation brute:
${rawContent.substring(0, 8000)}

Produis un JSON avec cette structure exacte:
{
  "summary": "Résumé en 2-3 phrases de ce qu'est cet outil",
  "keyPoints": ["Point clé 1", "Point clé 2", ...],
  "api": [{ "signature": "fonction(params)", "description": "ce qu'elle fait" }],
  "examples": [{ "title": "Titre", "code": "code exemple" }]
}

Règles:
- Sois CONCIS: pas de blabla, pas de répétition
- Inclus seulement l'API principale (pas toutes les fonctions)
- 2-3 exemples maximum, les plus utiles
- Pas plus de 10 key points
- Si le contenu n'est pas pertinent, retourne un JSON vide avec un summary qui dit "Documentation non disponible"
- Réponds en français si la doc est en français, sinon en anglais`;

  const context = {
    systemPrompt: "Tu es un libraire technique expert. Tu produis de la documentation concise et précise en format JSON.",
    messages: [
      {
        role: "user" as const,
        content: prompt,
        timestamp: Date.now(),
      },
    ],
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    const response = await completeSimple(modelInfo.model, context, {
      temperature: 0.3,
      maxTokens: 2000,
      apiKey: modelInfo.apiKey,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    // Extraire le texte de la réponse
    const text = response.content
      ?.filter((c: any) => c.type === "text")
      ?.map((c: any) => c.text || "")
      ?.join("\n")
      ?.trim() || "";

    if (!text) {
      return {
        meta: { name: item.name, version: item.version, type: item.type, updatedAt: new Date().toISOString() },
        summary: "Documentation synthesis failed (empty response)",
        keyPoints: [],
        api: [],
        examples: [],
      };
    }

    // Extraire le JSON de la réponse
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Si pas de JSON, utiliser le texte brut comme summary
      return {
        meta: { name: item.name, version: item.version, type: item.type, updatedAt: new Date().toISOString() },
        summary: text.substring(0, 200),
        keyPoints: [],
        api: [],
        examples: [],
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      meta: { name: item.name, version: item.version, type: item.type, updatedAt: new Date().toISOString() },
      summary: parsed.summary || "",
      keyPoints: parsed.keyPoints || [],
      api: parsed.api || [],
      examples: parsed.examples || [],
    };
  } catch (error: any) {
    console.error(`[Librarian] Synthesis failed for ${item.name}:`, error.message);
    return {
      meta: { name: item.name, version: item.version, type: item.type, updatedAt: new Date().toISOString() },
      summary: `Error: ${error.message}`,
      keyPoints: [],
      api: [],
      examples: [],
    };
  }
}

// ── Fetch + synthesize pour un item ──

async function fetchAndArchiveDoc(item: InventoryItem): Promise<boolean> {
  try {
    console.log(`[Librarian] Fetching doc for ${item.name} v${item.version}...`);

    // 1. Si on a une URL source, scraper directement
    let rawContent = "";
    let sourceUrl = item.source;

    if (sourceUrl) {
      try {
        const scraped = await webclawScrape(sourceUrl);
        rawContent = scraped.content;
      } catch (e) {
        console.log(`[Librarian] Direct scrape failed for ${item.name}, trying search...`);
      }
    }

    // 2. Si pas de contenu, rechercher
    if (!rawContent) {
      try {
        const results = await webclawSearch(`${item.name} ${item.version} documentation`, 3);
        if (results.length > 0 && results[0].content) {
          rawContent = results[0].content;
          sourceUrl = results[0].url;
        }
      } catch (e) {
        console.log(`[Librarian] Search failed for ${item.name}: ${(e as Error).message}`);
      }
    }

    if (!rawContent) {
      console.log(`[Librarian] No content found for ${item.name}`);
      return false;
    }

    // 3. Synthétiser avec le LLM
    const docContent = await synthesizeDoc(item, rawContent);
    docContent.meta.sourceUrl = sourceUrl;

    // 4. Archiver
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

    archiveDoc(entry, docContent);
    console.log(`[Librarian] Archived doc for ${item.name} v${item.version}`);
    return true;
  } catch (error: any) {
    console.error(`[Librarian] Failed to fetch doc for ${item.name}:`, error.message);
    return false;
  }
}

// ── Update cycle ──

export async function updateLibrary(projectCwds: string[]): Promise<{ scanned: number; updated: number; failed: number }> {
  console.log("[Librarian] Starting library update...");

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

  // 4. Fetch + synthesize (rate limited: 2s entre chaque)
  let updated = 0;
  let failed = 0;

  for (const item of itemsToUpdate) {
    const success = await fetchAndArchiveDoc(item);
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