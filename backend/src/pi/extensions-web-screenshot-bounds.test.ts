/**
 * PERF13 (performance) — `web_screenshot` : paramètres BORNÉS et PNG nettoyé.
 *
 * Avant : `timeoutMs`, `width` et `height` étaient pris tels quels
 * (`params.timeoutMs ?? DEFAULT_TIMEOUT_MS`). Un `timeoutMs` à 10^9 immobilisait
 * deux processus Chromium quasi indéfiniment ; un `width` à 100 000 saturait la
 * mémoire. Et chaque capture laissait un PNG dans `/tmp` (seul le HTML était
 * supprimé) : croissance illimitée sur une app en production.
 *
 * Les extensions n'ont pas de harnais de test : on vérifie donc la SOURCE
 * (bornes appliquées, `unlinkSync` du PNG dans le `finally`) et on exécute la
 * fonction de bornage extraite pour contrôler son comportement réel.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const SRC_PATH = fileURLToPath(new URL("../../../extensions/web-screenshot/index.ts", import.meta.url));

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/?\*)/.test(line))
    .join("\n");
}

function extractClampInt(src: string): (v: unknown, fallback: number, min: number, max: number) => number {
  const m = src.match(/function clampInt\([\s\S]*?\n\}/);
  if (!m) throw new Error("clampInt() introuvable dans l'extension web-screenshot");
  // Exécution de la fonction telle quelle (aucune dépendance externe) : on
  // retire seulement les annotations de type de la signature.
  const body = m[0].replace(/:\s*(number|unknown)\b/g, "");
  return new Function(`${body}\nreturn clampInt;`)() as any;
}

describe("PERF13 — web_screenshot borné + PNG supprimé", () => {
  const raw = readFileSync(SRC_PATH, "utf-8");
  const code = codeOnly(raw);

  it("les trois paramètres passent par clampInt (plus de valeur brute)", () => {
    expect(code).not.toMatch(/params\.timeoutMs \?\? DEFAULT_TIMEOUT_MS/);
    expect(code).not.toMatch(/params\.width \?\? DEFAULT_WIDTH/);
    expect(code).not.toMatch(/params\.height \?\? DEFAULT_HEIGHT/);
    expect(code).toMatch(/clampInt\(params\.width, DEFAULT_WIDTH, MIN_DIMENSION, MAX_DIMENSION\)/);
    expect(code).toMatch(/clampInt\(params\.height, DEFAULT_HEIGHT, MIN_DIMENSION, MAX_DIMENSION\)/);
    expect(code).toMatch(/clampInt\(params\.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS\)/);
    // Bornes attendues : 60 s et 4096 px.
    expect(code).toMatch(/MAX_TIMEOUT_MS = 60_000/);
    expect(code).toMatch(/MAX_DIMENSION = 4096/);
  });

  it("clampInt borne réellement et retombe sur le défaut si non numérique", () => {
    const clampInt = extractClampInt(code);
    expect(clampInt(1_000_000_000, 15_000, 1_000, 60_000)).toBe(60_000);
    expect(clampInt(100_000, 1_440, 1, 4_096)).toBe(4_096);
    expect(clampInt(0, 900, 1, 4_096)).toBe(1);
    expect(clampInt("abc", 1_440, 1, 4_096)).toBe(1_440);
    expect(clampInt(undefined, 900, 1, 4_096)).toBe(900);
    expect(clampInt(Number.NaN, 15_000, 1_000, 60_000)).toBe(15_000);
    expect(clampInt(1280, 1_440, 1, 4_096)).toBe(1280);
  });

  it("le PNG temporaire est supprimé dans le finally (plus de fuite /tmp)", () => {
    expect(code).toMatch(/let outPath = ""/);
    expect(code).toMatch(/if \(outPath\) \{[\s\S]{0,200}unlinkSync\(outPath\)/);
  });
});
