// ── Configuration Vitest (frontend) ─────────────────────────────────
// Niveau 1 : environnement node (pas de jsdom). On teste les fonctions
// pures (streaming Pi + parsing JSON) — pas de composants React ici.
//
// NB : en Vitest 5, les fichiers de benchmark sont exécutés dans un projet
// dédié (benchmark.include) et ne doivent PAS être dans test.include, sinon
// la fixture `bench` du contexte de test lève une erreur en run normal.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  benchmark: {
    include: ["src/**/*.bench.ts"],
  },
});
