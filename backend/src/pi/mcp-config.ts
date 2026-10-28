/**
 * mcp-config.ts — lecture SEULE de la configuration MCP du SDK (aucune écriture).
 *
 * Le SDK lit lui-même les serveurs MCP (`createMcpExtension`) dans :
 *   - `~/.pi/agent/mcp.json`                    (Utilisateur — TOUJOURS lu)
 *   - `<projet>/.pi/mcp.json`                   (Projet — seulement si le projet
 *     est « trusted » ; Pi-Web crée son `SettingsManager` sans option
 *     `projectTrusted`, or le SDK vaut `true` par défaut → le fichier projet est
 *     lu comme un projet approuvé).
 *
 * Ce module ne sert QU'À l'affichage (écran Réglages → Extensions) et aux logs de
 * démarrage : il ne configure rien. Toute erreur (fichier absent, JSON invalide)
 * est retournée, jamais levée — l'UI doit rester utilisable.
 */

import { existsSync, readFileSync } from "fs";
import path from "path";

export type McpTransport = "stdio" | "http";

export interface McpServerSummary {
  name: string;
  transport: McpTransport;
  enabled: boolean;
  description?: string;
  /** Fichier `mcp.json` qui déclare (ou surcharge) l'entrée. */
  source: string;
}

export interface McpConfigFileSummary {
  path: string;
  exists: boolean;
  /** Erreur de lecture/parsing de CE fichier (JSON invalide, etc.). */
  error?: string;
}

export interface McpConfigSummary {
  files: McpConfigFileSummary[];
  servers: McpServerSummary[];
  /** Erreurs cumulées (lecture + parsing), pour un affichage/journal honnête. */
  errors: string[];
}

/** `mcpServers` d'un fichier mcp.json, ou une erreur lisible. */
function readServersFile(
  file: string,
): { entries: Record<string, unknown>; error?: string } {
  if (!existsSync(file)) return { entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    const raw = parsed?.mcpServers;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { entries: {}, error: `${file}: "mcpServers" manquant ou invalide` };
    }
    return { entries: raw as Record<string, unknown> };
  } catch (e: any) {
    return { entries: {}, error: `${file}: ${e?.message || e}` };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalise une entrée `mcpServers[name]` du SDK en résumé d'affichage. */
function summarizeEntry(
  name: string,
  raw: unknown,
  source: string,
  inherited?: McpServerSummary,
): McpServerSummary | null {
  if (!isRecord(raw)) return null;
  const transport: McpTransport =
    typeof raw.command === "string" && raw.command.length > 0
      ? "stdio"
      : typeof raw.url === "string" && raw.url.length > 0
        ? "http"
        : (raw.type === "http" || raw.type === "streamable-http" ? "http" : undefined) ??
          inherited?.transport ??
          "stdio";
  const enabled = raw.enabled === false ? false : inherited?.enabled ?? true;
  const description =
    typeof raw.description === "string" && raw.description.length > 0
      ? raw.description
      : inherited?.description;
  const summary: McpServerSummary = { name, transport, enabled, source };
  if (description) summary.description = description;
  return summary;
}

/**
 * Résumé lecture seule des serveurs MCP configurés.
 *
 * `projectCwd` optionnel : quand il est fourni, `<projectCwd>/.pi/mcp.json` est
 * lu aussi (même règle que le SDK : une entrée projet remplace l'entrée
 * utilisateur du même nom ; une entrée projet SANS `command`/`url`/`type` ne
 * surcharge que `enabled`/`exposure`).
 */
export function readMcpConfigSummary(agentDir: string, projectCwd?: string): McpConfigSummary {
  const files: McpConfigFileSummary[] = [];
  const errors: string[] = [];

  const userFile = path.join(agentDir, "mcp.json");
  const userRead = readServersFile(userFile);
  files.push({ path: userFile, exists: existsSync(userFile), ...(userRead.error ? { error: userRead.error } : {}) });
  if (userRead.error) errors.push(userRead.error);

  const byName = new Map<string, McpServerSummary>();
  for (const [name, raw] of Object.entries(userRead.entries)) {
    const summary = summarizeEntry(name, raw, userFile);
    if (summary) byName.set(name, summary);
    else errors.push(`${userFile}: serveur "${name}" ignoré (entrée invalide)`);
  }

  if (projectCwd) {
    const projectFile = path.join(projectCwd, ".pi", "mcp.json");
    const projectRead = readServersFile(projectFile);
    files.push({
      path: projectFile,
      exists: existsSync(projectFile),
      ...(projectRead.error ? { error: projectRead.error } : {}),
    });
    if (projectRead.error) errors.push(projectRead.error);

    for (const [name, raw] of Object.entries(projectRead.entries)) {
      const summary = summarizeEntry(name, raw, projectFile, byName.get(name));
      if (summary) byName.set(name, summary);
      else errors.push(`${projectFile}: serveur "${name}" ignoré (entrée invalide)`);
    }
  }

  return { files, servers: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}
