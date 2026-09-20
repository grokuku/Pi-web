// ── Tests unitaires : résumés d'outils sans LLM (LOT 1 refonte chat) ────────
// Fonctions pures : aucun DOM, aucun réseau. Chaque règle de la spécification
// est couverte (read/write/edit/bash/grep/find/ls/web_screenshot/analyze_file/
// preview/cbm_*, règle d'erreur uniforme, durée live vs historique).
import { describe, it, expect } from "vitest";
import {
  buildToolSummary,
  buildToolSummaryFromCall,
  computeBashExitCode,
  computeDurationMs,
  formatToolDuration,
  countLines,
} from "./toolSummaries";
import type { ToolCallInfo } from "../types";

function tc(overrides: Partial<ToolCallInfo>): ToolCallInfo {
  return {
    id: "t1",
    name: "read",
    args: {},
    output: "",
    isError: false,
    isStreaming: false,
    ...overrides,
  };
}

const NOW = 1_800_000_000_000;

describe("countLines", () => {
  it("compte les lignes non vides de fin ignorées", () => {
    expect(countLines("a\nb\nc")).toBe(3);
    expect(countLines("a\nb\nc\n\n")).toBe(3);
    expect(countLines("")).toBe(0);
    expect(countLines(undefined)).toBe(0);
    expect(countLines("   \n  ")).toBe(0);
  });
});

describe("buildToolSummary — read", () => {
  it("read <path> · N lignes", () => {
    const s = buildToolSummary({ name: "read", args: { path: "src/app.tsx" }, output: "l1\nl2\nl3" });
    expect(s.text).toBe("read src/app.tsx · 3 lignes");
    expect(s.verb).toBe("read");
    expect(s.target).toBe("src/app.tsx");
    expect(s.lineCount).toBe(3);
  });

  it("ajoute « tronqué » si details.truncation.truncated", () => {
    const s = buildToolSummary({
      name: "read",
      args: { file_path: "big.log" },
      output: "l1\nl2",
      details: { truncation: { truncated: true, totalLines: 5000 } },
    });
    expect(s.text).toBe("read big.log · 2 lignes · tronqué");
  });

  it("pas de segment si output vide (tool en cours)", () => {
    const s = buildToolSummary({ name: "read", args: { path: "x.ts" }, output: "" });
    expect(s.text).toBe("read x.ts");
  });
});

describe("buildToolSummary — write", () => {
  it("N lignes écrites dérivées de args.content", () => {
    const s = buildToolSummary({ name: "write", args: { path: "out.md", content: "a\nb\nc\nd" }, output: "Successfully wrote to out.md" });
    expect(s.text).toBe("write out.md · 4 lignes écrites");
  });

  it("fallback silencieux sans args.content", () => {
    const s = buildToolSummary({ name: "write", args: { path: "out.md" }, output: "Successfully wrote to out.md" });
    expect(s.text).toBe("write out.md");
  });
});

describe("buildToolSummary — edit", () => {
  it("+A/−B depuis details.diff", () => {
    const diff = "+3 nouvelle\n-1 ancienne\n  2 contexte\n+4 autre\n-5 suppr\n  6 contexte";
    const s = buildToolSummary({ name: "edit", args: { path: "f.ts" }, details: { diff }, output: "Successfully replaced 2 block(s) in f.ts." });
    expect(s.text).toBe("edit f.ts · +2/−2");
  });

  it("ignore les en-têtes de fichier +++/--- (aligné sur le backend)", () => {
    const diff = ["--- a/f", "+++ b/f", "contexte", "+ajout1", "+ajout2", "-supp"].join("\n");
    const s = buildToolSummary({ name: "edit", args: { path: "f.ts" }, details: { diff }, output: "ok" });
    expect(s.text).toBe("edit f.ts · +2/−1");
  });

  it("fallback N lignes d'output sans details.diff (historique ancien)", () => {
    const s = buildToolSummary({ name: "edit", args: { path: "f.ts" }, output: "Successfully replaced 3 block(s) in f.ts." });
    expect(s.text).toBe("edit f.ts · 1 lignes");
  });
});

describe("buildToolSummary — bash", () => {
  it("bash <cmd 50c> · exit 0 · N lignes (succès)", () => {
    const s = buildToolSummary({ name: "bash", args: { command: "ls -la" }, output: "f1\nf2\nf3" });
    expect(s.text).toBe("bash ls -la · exit 0 · 3 lignes");
    expect(s.failed).toBe(false);
    expect(s.exitCode).toBe(0);
  });

  it("commande tronquée à 50 chars", () => {
    const cmd = "x".repeat(80);
    const s = buildToolSummary({ name: "bash", args: { command: cmd }, output: "ok" });
    expect(s.target).toBe("x".repeat(49) + "…");
    expect(s.text.startsWith("bash ")).toBe(true);
  });

  it("exit≠0 → failed (parsing du message SDK « Command exited with code N »)", () => {
    const output = "partiel\n\nCommand exited with code 2";
    const s = buildToolSummary({ name: "bash", args: { command: "make" }, output, isError: true });
    expect(s.failed).toBe(true);
    expect(s.exitCode).toBe(2);
    // Règle d'erreur uniforme : ⚠ + 1re ligne de l'output.
    expect(s.text).toBe("⚠ partiel");
  });

  it("exit≠0 même sans isError (ceinture et bretelles)", () => {
    const s = buildToolSummary({ name: "bash", args: { command: "cmd" }, output: "x\n\nCommand exited with code 130" });
    expect(s.failed).toBe(true);
    expect(s.exitCode).toBe(130);
  });

  it("en streaming : pas de segments exit/lignes (durée live affichée par le chrono)", () => {
    const s = buildToolSummary(
      { name: "bash", args: { command: "sleep 30" }, output: "…", isStreaming: true, startedAt: NOW - 5000 },
      NOW,
    );
    expect(s.text).toBe("bash sleep 30");
    expect(s.durationMs).toBe(5000);
  });

  it("tronqué si details.truncation", () => {
    const s = buildToolSummary({ name: "bash", args: { command: "cat big" }, output: "a\nb", details: { truncation: { truncated: true } } });
    expect(s.text).toBe("bash cat big · exit 0 · 2 lignes · tronqué");
  });
});

describe("buildToolSummary — grep / find / ls", () => {
  it("grep <pattern> · N résultats (notices exclues)", () => {
    const output = "f1:match\nf2:match\n\n[200 results limit reached]";
    const s = buildToolSummary({ name: "grep", args: { pattern: "TODO" }, output });
    expect(s.text).toBe("grep TODO · 2 résultats");
  });

  it("find <glob> · N fichiers", () => {
    const s = buildToolSummary({ name: "find", args: { pattern: "**/*.ts" }, output: "a.ts\nb.ts\nc.ts" });
    expect(s.text).toBe("find **/*.ts · 3 fichiers");
  });

  it("ls <dir> · N entrées ; répertoire vide → pas de segment", () => {
    const s1 = buildToolSummary({ name: "ls", args: { path: "src" }, output: "a\nb" });
    expect(s1.text).toBe("ls src · 2 entrées");
    const s2 = buildToolSummary({ name: "ls", args: { path: "empty" }, output: "(empty directory)" });
    expect(s2.text).toBe("ls empty");
  });
});

describe("buildToolSummary — web_screenshot / analyze_file / preview / cbm_*", () => {
  it("screenshot <url>", () => {
    const s = buildToolSummary({ name: "web_screenshot", args: { url: "https://example.com" } });
    expect(s.text).toBe("screenshot https://example.com");
  });

  it("screenshot (html) sans url", () => {
    const s = buildToolSummary({ name: "web_screenshot", args: { html: "<html>…" } });
    expect(s.text).toBe("screenshot (html)");
  });

  it("analyze <fichier> · OK (succès)", () => {
    const s = buildToolSummary({ name: "analyze_file", args: { file_id: "abc-123" }, output: "Texte extrait…" });
    expect(s.text).toBe("analyze abc-123 · OK");
  });

  it("preview <path> (open_preview) et preview sans path (preview_html)", () => {
    const s1 = buildToolSummary({ name: "open_preview", args: { projectId: "p", path: "index.html" } });
    expect(s1.text).toBe("preview index.html");
    const s2 = buildToolSummary({ name: "preview_html", args: { html: "<html>…" } });
    expect(s2.text).toBe("preview");
  });

  it("cbm <sub> <query> · N lignes", () => {
    const s = buildToolSummary({ name: "cbm_search", args: { pattern: "ChatView" }, output: "r1\nr2\nr3" });
    expect(s.text).toBe("cbm search ChatView · 3 lignes");
  });
});

describe("buildToolSummary — fallbacks et échec uniforme", () => {
  it("outil inconnu : verbe court (miroir de shortName) + 1er arg string + N lignes", () => {
    const s = buildToolSummary({ name: "git_status", args: { path: "/repo" }, output: "clean" });
    expect(s.text).toBe("status /repo · 1 lignes");
  });

  it("règle d'erreur (tous) : ⚠ <1re ligne, 120c> — tronquée à 120", () => {
    const line = "E".repeat(300);
    const s = buildToolSummary({ name: "read", args: { path: "x" }, output: `${line}\nsuite`, isError: true });
    expect(s.failed).toBe(true);
    expect(s.text.startsWith("⚠ ")).toBe(true);
    // 120 chars de ligne + « ⚠ » + espace + ellipse
    expect(s.text.length).toBeLessThanOrEqual(123);
    expect(s.text.endsWith("…")).toBe(true);
    expect(s.segments).toEqual([]);
  });

  it("échec sans output : ⚠ + cible", () => {
    const s = buildToolSummary({ name: "grep", args: { pattern: "x" }, output: "", isError: true });
    expect(s.text).toBe("⚠ x");
  });

  it("isError prime : analyze_file en erreur n'affiche pas OK", () => {
    const s = buildToolSummary({ name: "analyze_file", args: { file_id: "f" }, output: "Boom", isError: true });
    expect(s.failed).toBe(true);
    expect(s.text).toBe("⚠ Boom");
  });

  it("texte global clampé à ~100 chars : cible tronquée à 60 (title = texte complet)", () => {
    const s = buildToolSummary({ name: "read", args: { path: "p".repeat(80) }, output: "l" });
    expect(s.text.length).toBeLessThanOrEqual(100);
    // La cible a été tronquée avec ellipse par oneLine(target, 60).
    expect(s.text).toContain("…");
    expect(s.target!.length).toBe(60);
  });
});

describe("durée (computeDurationMs / formatToolDuration)", () => {
  it("historique : pas de startedAt → durée omise", () => {
    expect(computeDurationMs({ startedAt: NOW - 2500, isStreaming: false })).toBeUndefined();
    const s = buildToolSummary({ name: "bash", args: { command: "ls" }, output: "f" });
    expect(s.durationMs).toBeUndefined();
    expect(s.text).toBe("bash ls · exit 0 · 1 lignes"); // pas de segment durée
  });

  it("live terminé : startedAt + endedAt → durée exacte", () => {
    const s = buildToolSummary({ name: "bash", args: { command: "ls" }, output: "f", startedAt: NOW - 65_000, endedAt: NOW });
    expect(s.durationMs).toBe(65_000);
  });

  it("live en cours : elapsed (now injecté, testable)", () => {
    expect(computeDurationMs({ isStreaming: true, startedAt: NOW - 2500 }, NOW)).toBe(2500);
    // sans now : pas de durée déterministe
    expect(computeDurationMs({ isStreaming: true, startedAt: NOW - 2500 })).toBeUndefined();
  });

  it("formatToolDuration : 12s / 1m 05s", () => {
    expect(formatToolDuration(12_400)).toBe("12s");
    expect(formatToolDuration(65_000)).toBe("1m 05s");
  });
});

describe("computeBashExitCode", () => {
  it("details.exitCode prioritaire", () => {
    expect(computeBashExitCode("x", { exitCode: 3 }, true)).toBe(3);
  });
  it("parse le message SDK", () => {
    expect(computeBashExitCode("a\n\nCommand exited with code 42", undefined, true)).toBe(42);
  });
  it("succès implicite → 0 ; échec sans code → undefined", () => {
    expect(computeBashExitCode("ok", undefined, false)).toBe(0);
    expect(computeBashExitCode("boom", undefined, true)).toBeUndefined();
  });
});

describe("buildToolSummaryFromCall (branchement ToolCallRow)", () => {
  it("propage endedAt/details/isError du ToolCallInfo", () => {
    const call = tc({
      name: "bash",
      args: { command: "make test" },
      output: "fail\n\nCommand exited with code 1",
      isError: true,
      startedAt: NOW - 3000,
      endedAt: NOW,
      details: { truncation: { truncated: false } },
    });
    const s = buildToolSummaryFromCall(call, NOW);
    expect(s.failed).toBe(true);
    expect(s.exitCode).toBe(1);
    expect(s.durationMs).toBe(3000);
    expect(s.text).toBe("⚠ fail");
  });

  it("outil en cours de streaming : pas d'exit segment", () => {
    const call = tc({ name: "bash", args: { command: "top" }, output: "…", isStreaming: true, startedAt: NOW - 1000 });
    const s = buildToolSummaryFromCall(call, NOW);
    expect(s.failed).toBe(false);
    expect(s.text).toBe("bash top");
  });
});