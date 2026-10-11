/**
 * client.ts — Client REST du service Libry (Lot B de la migration Pi-Web → Libry).
 *
 * Pi-Web cesse progressivement d'être le libraire et devient CLIENT de Libry.
 * Ce module ne fait QUE préparer le terrain : aucun comportement n'est basculé
 * ici. Le libraire local (pi/librarian-service.ts) reste actif tant que
 * l'interrupteur `librarianBackend` vaut "local" (défaut).
 *
 * Contrat Libry (identique à Pi-Web, mêmes routes / mêmes formes) :
 *   GET  /api/librarian/status          (PUBLIQUE — pas de clé requise)
 *   GET  /api/librarian/library
 *   POST /api/librarian/search          { query }
 *   GET  /api/librarian/doc/:name?version=
 *   POST /api/librarian/archive         { name, version, type?, sourceUrl?, content }
 *   POST /api/librarian/fetch           { url, format? }  (équivalent REST de webclawScrape)
 *   POST /api/librarian/screenshot      { url, width?, height?, timeoutMs? } → métadonnées PNG
 *   GET  /api/librarian/shot/:id.png    (PNG servi à part)
 *
 * Auth SORTANTE : `Authorization: Bearer <clé libry_…>` (Libry accepte aussi
 * X-API-Key, mais Pi-Web n'en a pas besoin).
 *
 * Persistance : `.data/libry-config.json` — même famille que
 * webclaw-config.json / tavily-config.json. Résolution `env ?? fichier ?? défaut`,
 * RELECTURE À CHAQUE APPEL (aucun cache) → l'interrupteur est modifiable à chaud.
 */

import { writeFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Même convention que utils/logger.ts : <racine projet>/.data — 3 niveaux depuis
// backend/dist/libry (prod node) comme depuis backend/src/libry (dev tsx).
const DATA_DIR = path.join(__dirname, "..", "..", "..", ".data");
const LIBRY_CONFIG_FILE = path.join(DATA_DIR, "libry-config.json");

export const DEFAULT_LIBRY_URL = "http://libry:3007";

/** Backend du libraire : "local" (Pi-Web, défaut) ou "libry" (service autonome). */
export type LibrarianBackend = "libry" | "local";

export interface LibryConfig {
  url: string;
  apiKey: string;
  /**
   * Interrupteur `librarian.backend`. NON câblé sur un backend ici : il n'est
   * que lu (par les outils, le CRON et, plus tard, les routes). Défaut "local" :
   * tant qu'il vaut "local", le libraire local de Pi-Web reste intégralement actif.
   */
  librarianBackend: LibrarianBackend;
}

// ── Erreurs typées (messages actionnables, jamais de fuite de clé) ──

export type LibryErrorCode =
  | "url_missing"
  | "key_missing"
  | "unauthorized"
  | "unreachable"
  | "timeout"
  | "http_error"
  | "bad_response";

export class LibryError extends Error {
  readonly code: LibryErrorCode;
  readonly status?: number;

  constructor(message: string, code: LibryErrorCode, status?: number) {
    super(message);
    this.name = "LibryError";
    this.code = code;
    this.status = status;
  }
}

// ── Persistance ──

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function normalizeBackend(value: unknown): LibrarianBackend | null {
  return value === "libry" || value === "local" ? value : null;
}

/** Normalise une URL de base (retire les slashes de fin). */
function trimBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Configuration Libry — priorité `env ?? fichier ?? défaut`.
 * Relit le fichier à CHAQUE appel (pas de cache) : l'interrupteur et l'URL
 * peuvent être changés sans redémarrage.
 */
export function getLibryConfig(): LibryConfig {
  let fileUrl = "";
  let fileKey = "";
  let fileBackend: LibrarianBackend | null = null;

  try {
    ensureDataDir();
    if (existsSync(LIBRY_CONFIG_FILE)) {
      const data = JSON.parse(readFileSync(LIBRY_CONFIG_FILE, "utf-8"));
      fileUrl = typeof data.url === "string" ? data.url : "";
      fileKey = typeof data.apiKey === "string" ? data.apiKey : "";
      fileBackend = normalizeBackend(data.librarianBackend);
    }
  } catch (e) {
    console.error("[libry] Failed to load config:", e);
  }

  // env ?? fichier ?? défaut (une variable d'env VIDE est traitée comme absente).
  const envUrl = process.env.LIBRY_URL || "";
  const envKey = process.env.LIBRY_API_KEY || "";
  const envBackend = normalizeBackend(process.env.LIBRARIAN_BACKEND);

  return {
    url: envUrl || fileUrl || DEFAULT_LIBRY_URL,
    apiKey: envKey || fileKey || "",
    librarianBackend: envBackend ?? fileBackend ?? "local",
  };
}

/**
 * Écrit la config Libry (keep-if-absent : un champ absent ou vide conserve la
 * valeur courante — même contrat que setWebclawConfig / setTavilyConfig).
 */
export function setLibryConfig(config: Partial<LibryConfig>): LibryConfig {
  ensureDataDir();
  const current = getLibryConfig();
  const next: LibryConfig = {
    url: config.url ? config.url : current.url,
    apiKey: config.apiKey ? config.apiKey : current.apiKey,
    librarianBackend: normalizeBackend(config.librarianBackend) ?? current.librarianBackend,
  };
  writeFileSync(LIBRY_CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

/**
 * Interrupteur du libraire, lu À CHAUD (relecture du fichier de config à chaque
 * appel, aucun cache). Défaut "local" : le libraire local reste actif.
 */
export function getLibrarianBackend(): LibrarianBackend {
  return getLibryConfig().librarianBackend;
}

// ── Vue publique (API de réglages) — la clé n'est JAMAIS renvoyée en clair ──

export function toPublicLibryConfig(config: LibryConfig): {
  url: string;
  hasApiKey: boolean;
  apiKeyPreview: string;
  librarianBackend: LibrarianBackend;
  /** true = la valeur EFFECTIVE vient de l'environnement (env non vide prime fichier/défaut). */
  urlFromEnv: boolean;
  apiKeyFromEnv: boolean;
  backendFromEnv: boolean;
} {
  return {
    url: config.url,
    hasApiKey: !!config.apiKey,
    apiKeyPreview: config.apiKey ? `••••${config.apiKey.slice(-4)}` : "",
    librarianBackend: config.librarianBackend,
    // Même sémantique que getLibryConfig : une variable d'env VIDE est absente.
    urlFromEnv: !!(process.env.LIBRY_URL || ""),
    apiKeyFromEnv: !!(process.env.LIBRY_API_KEY || ""),
    backendFromEnv: normalizeBackend(process.env.LIBRARIAN_BACKEND) !== null,
  };
}

// ── Requête HTTP bas niveau ──

const DEFAULT_TIMEOUT_MS = 15_000;

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
  /** true (défaut) = clé obligatoire ; false = envoi de la clé si présente (ex. /status public). */
  requireKey?: boolean;
}

async function libryRequest<T>(pathname: string, options: RequestOptions = {}): Promise<T> {
  const config = getLibryConfig();
  const base = trimBaseUrl(config.url);

  if (!base) {
    throw new LibryError(
      "Libry : URL non configurée. Définir LIBRY_URL ou le réglage /api/settings/libry.",
      "url_missing",
    );
  }
  if (options.requireKey !== false && !config.apiKey) {
    throw new LibryError(
      "Libry : clé API absente. Définir LIBRY_API_KEY ou le réglage /api/settings/libry.",
      "key_missing",
    );
  }

  const url = `${base}${pathname}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new LibryError(`Libry : délai dépassé sur ${pathname}.`, "timeout");
    }
    throw new LibryError(
      `Libry injoignable à ${base}. Vérifier LIBRY_URL et que le service Libry est démarré (${e?.message ?? "erreur réseau"}).`,
      "unreachable",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 401 || res.status === 403) {
    throw new LibryError(
      `Libry a refusé la clé (HTTP ${res.status}) sur ${pathname}. Vérifier LIBRY_API_KEY (clé libry_…).`,
      "unauthorized",
      res.status,
    );
  }
  if (!res.ok) {
    let detail = "";
    try {
      const payload: any = await res.json();
      if (payload && typeof payload.error === "string") detail = payload.error;
    } catch {
      /* corps non-JSON : ignoré */
    }
    throw new LibryError(
      `Libry : erreur HTTP ${res.status} sur ${pathname}${detail ? ` (${detail})` : ""}.`,
      "http_error",
      res.status,
    );
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new LibryError(`Libry : réponse illisible (JSON attendu) sur ${pathname}.`, "bad_response");
  }
}

// ── API publique ──

export interface LibryLibraryStatus {
  totalDocs: number;
  lastUpdated: string;
  lastScan: string;
}

/** Statut de la bibliothèque Libry (route PUBLIQUE : la clé est facultative). */
export function libryStatus(): Promise<LibryLibraryStatus> {
  return libryRequest<LibryLibraryStatus>("/api/librarian/status", { requireKey: false });
}

export interface LibrySearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
}

export interface LibrySearchResponse {
  results: LibrySearchResult[];
  archived: boolean;
}

/** Recherche web + bibliothèque (Libry). */
export function librySearch(query: string): Promise<LibrySearchResponse> {
  return libryRequest<LibrySearchResponse>("/api/librarian/search", {
    method: "POST",
    body: { query },
  });
}

export interface LibryDocContent {
  summary?: string;
  keyPoints?: string[];
  api?: Array<{ signature: string; description: string }>;
  examples?: Array<{ title: string; code: string }>;
  breakingChanges?: string[];
  rawContent?: string;
}

export interface LibryArchiveInput {
  name: string;
  version: string;
  type?: string;
  sourceUrl?: string;
  content: LibryDocContent;
}

export interface LibryArchiveResponse {
  success: boolean;
  entry?: unknown;
}

/**
 * Archive un document déjà extrait (`content` obligatoire — le contrat Libry
 * n'extrait PAS le contenu lui-même, contrairement au libraire local).
 */
export function libryArchive(input: LibryArchiveInput): Promise<LibryArchiveResponse> {
  return libryRequest<LibryArchiveResponse>("/api/librarian/archive", {
    method: "POST",
    body: input,
  });
}

export interface LibryFetchResult {
  url: string;
  content: string;
  title?: string;
  description?: string;
  contentType?: string;
  origin?: string;
}

/**
 * Récupère le contenu d'une page via Libry (`POST /api/librarian/fetch`, cible
 * soumise au SSRF côté Libry). C'est l'équivalent REST de `webclawScrape` : à
 * utiliser AVANT `libryArchive`, qui exige un `content` déjà extrait.
 */
export function libryFetch(url: string, format = "markdown"): Promise<LibryFetchResult> {
  return libryRequest<LibryFetchResult>("/api/librarian/fetch", {
    method: "POST",
    body: { url, format },
  });
}

export interface LibryScreenshotOptions {
  url: string;
  width?: number;
  height?: number;
  timeoutMs?: number;
}

export interface LibryScreenshotResult {
  id: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  url: string;
  origin: string;
}

/** Lance une capture d'écran côté Libry et renvoie les métadonnées du PNG. */
export function libryScreenshot(options: LibryScreenshotOptions): Promise<LibryScreenshotResult> {
  return libryRequest<LibryScreenshotResult>("/api/librarian/screenshot", {
    method: "POST",
    body: options,
    // Une capture (spawn Chromium) peut être lente : borne plus large.
    timeoutMs: 90_000,
  });
}

/** URL du PNG produit par `libryScreenshot` (auth requise). */
export function libryShotPngUrl(id: string): string {
  return `${trimBaseUrl(getLibryConfig().url)}/api/librarian/shot/${encodeURIComponent(id)}.png`;
}
