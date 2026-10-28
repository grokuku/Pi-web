/**
 * mcp-config.test.ts — lecture en LECTURE SEULE de la config MCP du SDK.
 *
 * Règle du projet : pas d'échec silencieux. Ces tests verrouillent donc :
 *  - fichier absent → 0 serveur, AUCUNE erreur (l'UI doit rester utilisable) ;
 *  - JSON invalide → erreur remontée, jamais d'exception ;
 *  - entrées valides → nom, transport, `enabled: false`, description ;
 *  - fichier PROJET → il remplace l'entrée utilisateur du même nom, et une
 *    entrée projet sans `command`/`url` ne surcharge que `enabled`.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMcpConfigSummary } from "./mcp-config.js";

let root: string;
let agentDir: string;
let projectDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "piweb-mcp-"));
  agentDir = path.join(root, "agent");
  projectDir = path.join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeUserConfig(content: unknown): void {
  writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(content, null, 2));
}

function writeProjectConfig(content: unknown): void {
  mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  writeFileSync(path.join(projectDir, ".pi", "mcp.json"), JSON.stringify(content, null, 2));
}

describe("readMcpConfigSummary — fichier absent", () => {
  it("retourne 0 serveur et aucune erreur", () => {
    const summary = readMcpConfigSummary(agentDir);
    expect(summary.servers).toEqual([]);
    expect(summary.errors).toEqual([]);
    expect(summary.files).toHaveLength(1);
    expect(summary.files[0]).toMatchObject({ path: path.join(agentDir, "mcp.json"), exists: false });
  });

  it("avec un cwd projet et aucun fichier projet : toujours 0 serveur, 0 erreur", () => {
    const summary = readMcpConfigSummary(agentDir, projectDir);
    expect(summary.servers).toEqual([]);
    expect(summary.errors).toEqual([]);
    expect(summary.files).toHaveLength(2);
    expect(summary.files.every((f) => !f.exists)).toBe(true);
  });
});

describe("readMcpConfigSummary — configuration utilisateur", () => {
  it("décrit stdio et HTTP, `enabled: false` et `description`", () => {
    writeUserConfig({
      mcpServers: {
        filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },
        docs: { url: "https://example.com/mcp", description: "Documentation interne" },
        sentry: { url: "https://mcp.sentry.dev/mcp", enabled: false },
      },
    });
    const summary = readMcpConfigSummary(agentDir);
    expect(summary.errors).toEqual([]);
    expect(summary.servers.map((s) => s.name)).toEqual(["docs", "filesystem", "sentry"]);
    const byName = new Map(summary.servers.map((s) => [s.name, s]));
    expect(byName.get("filesystem")).toMatchObject({ transport: "stdio", enabled: true });
    expect(byName.get("docs")).toMatchObject({ transport: "http", description: "Documentation interne" });
    expect(byName.get("sentry")).toMatchObject({ transport: "http", enabled: false });
    // Aucune valeur de `env` / `headers` n'est exposée (jamais de secret affiché).
    expect(JSON.stringify(summary)).not.toContain("Authorization");
  });

  it("JSON invalide → erreur remontée, pas d'exception", () => {
    writeFileSync(path.join(agentDir, "mcp.json"), "{ pas du json");
    const summary = readMcpConfigSummary(agentDir);
    expect(summary.servers).toEqual([]);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain("mcp.json");
  });

  it("`mcpServers` absent → erreur explicite, pas d'exception", () => {
    writeUserConfig({ autres: true });
    const summary = readMcpConfigSummary(agentDir);
    expect(summary.servers).toEqual([]);
    expect(summary.errors[0]).toContain("mcpServers");
  });
});

describe("readMcpConfigSummary — fichier projet (le SDK le lit si le projet est approuvé)", () => {
  it("une entrée projet remplace l'entrée utilisateur du même nom", () => {
    writeUserConfig({ mcpServers: { tools: { command: "uvx", args: ["tools-mcp"] } } });
    writeProjectConfig({ mcpServers: { tools: { command: "node", args: ["tools.js"] } } });
    const summary = readMcpConfigSummary(agentDir, projectDir);
    expect(summary.servers).toHaveLength(1);
    expect(summary.servers[0].source).toBe(path.join(projectDir, ".pi", "mcp.json"));
  });

  it("une entrée projet sans command/url ne surcharge que `enabled`", () => {
    writeUserConfig({ mcpServers: { tools: { command: "uvx", args: ["tools-mcp"] } } });
    writeProjectConfig({ mcpServers: { tools: { enabled: false } } });
    const summary = readMcpConfigSummary(agentDir, projectDir);
    expect(summary.servers).toHaveLength(1);
    expect(summary.servers[0]).toMatchObject({ name: "tools", transport: "stdio", enabled: false });
  });

  it("ajoute les serveurs projet qui n'existent pas côté utilisateur", () => {
    writeUserConfig({ mcpServers: { docs: { url: "https://example.com/mcp" } } });
    writeProjectConfig({ mcpServers: { local: { command: "mcp-local" } } });
    const summary = readMcpConfigSummary(agentDir, projectDir);
    expect(summary.servers.map((s) => s.name)).toEqual(["docs", "local"]);
  });
});
