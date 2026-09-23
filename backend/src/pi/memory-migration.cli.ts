/**
 * memory-migration.cli.ts — déclenchement MANUEL de la migration mémoire BUG-02.
 *
 * Utile quand la migration automatique du boot a été ignorée (backend non
 * redémarré) ou pour inspecter le résultat. Idempotent : si le marqueur
 * `~/.unipi/.memory-migration-v2.json` est déjà présent, ne fait rien.
 *
 * Usage :
 *   cd backend && npm run migrate:memory
 *   # ou directement : npx tsx src/pi/memory-migration.cli.ts
 */

import { runMemoryMigration } from "./memory-migration.js";

async function main(): Promise<void> {
  const result = await runMemoryMigration();

  if (result.aborted) {
    console.error(`[memory-migration] ABANDON : ${result.reason ?? "sauvegarde non vérifiable"}`);
    console.error("[memory-migration] Aucune donnée n'a été modifiée. Corrigez la cause puis relancez.");
    process.exitCode = 1;
    return;
  }

  if (result.skipped) {
    console.log(`[memory-migration] Rien à faire : ${result.reason ?? "déjà migré"}`);
    return;
  }

  console.log(
    `[memory-migration] Terminé en ${result.durationMs} ms\n` +
      `  déplacés  : ${result.moved}\n` +
      `  ignorés   : ${result.skippedMoves}\n` +
      `  conflits  : ${result.conflicts}\n` +
      `  orphelins : ${result.orphans} (laissés intacts)\n` +
      `  sauvegarde: ${result.backupPath ?? "(aucune donnée)"}`
  );
}

main().catch((err) => {
  console.error(`[memory-migration] Erreur inattendue : ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
