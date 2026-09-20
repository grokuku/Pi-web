/**
 * Tests unitaires de pi/session-history.ts (LOT E1 — consultation des
 * conversations passées).
 *
 * Couverture :
 *  - selectSessionFile : sélection SÛRE par id (aucune traversée de chemin) ;
 *  - readSessionHistoryFile : parsing du .jsonl, reconstruction UI identique
 *    au chat, curseur de pagination (before/beforeId/count/all) ;
 *  - robustesse aux lignes corrompues (parseSessionEntries les ignore).
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { selectSessionFile, readSessionHistoryFile } from "./session-history.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

/** Écrit un fichier de session .jsonl factice et renvoie son chemin. */
function writeSessionFile(entries: any[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-session-history-"));
  tmpDirs.push(dir);
  const file = join(dir, "2026-01-01T00-00-00-000Z_deadbeef.jsonl");
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return file;
}

function msg(id: string, n: number, role = "user"): any {
  return { type: "message", id, timestamp: n, message: { role, content: `m${n}`, timestamp: n } };
}

describe("selectSessionFile", () => {
  const sessions = [
    { id: "s1", path: "/sessions/s1.jsonl" },
    { id: "s2", path: "/sessions/s2.jsonl" },
  ];

  it("renvoie le chemin de la session demandée", () => {
    expect(selectSessionFile(sessions, "s2")).toBe("/sessions/s2.jsonl");
  });

  it("renvoie null si l'id est inconnu ou vide (pas de sessionId client utilisé comme chemin)", () => {
    expect(selectSessionFile(sessions, "inconnu")).toBeNull();
    expect(selectSessionFile(sessions, "")).toBeNull();
    expect(selectSessionFile(sessions, "../../etc/passwd")).toBeNull();
  });

  it("renvoie null sur une liste invalide", () => {
    expect(selectSessionFile(null as any, "s1")).toBeNull();
    expect(selectSessionFile([{ id: "s1" }], "s1")).toBeNull(); // pas de path
  });
});

describe("readSessionHistoryFile", () => {
  it("reconstruit l'historique UI (mêmes entrées que le chat) avec curseur", async () => {
    const file = writeSessionFile([
      { type: "session", id: "hdr", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/x" },
      msg("e1", 1),
      msg("e2", 2, "assistant"),
      msg("e3", 3),
    ]);
    const win = await readSessionHistoryFile(file);
    expect(win.total).toBe(3);
    expect(win.messages.map((m: any) => m.id)).toEqual(["e1", "e2", "e3"]);
    // L'en-tête de session n'est PAS un message affichable.
    expect(win.messages.some((m: any) => m.id === "hdr")).toBe(false);
  });

  it("applique le curseur before (pagination vers le haut)", async () => {
    const file = writeSessionFile([msg("e1", 1), msg("e2", 2), msg("e3", 3), msg("e4", 4)]);
    const win = await readSessionHistoryFile(file, { before: 2, count: 2 });
    expect(win.messages.map((m: any) => m.id)).toEqual(["e1", "e2"]);
    expect(win.from).toBe(0);
    expect(win.hasMore).toBe(false);
  });

  it("all:true renvoie tout ce qui précède le curseur", async () => {
    const file = writeSessionFile(Array.from({ length: 5 }, (_, i) => msg(`e${i}`, i)));
    const win = await readSessionHistoryFile(file, { before: 4, all: true });
    expect(win.messages.map((m: any) => m.id)).toEqual(["e0", "e1", "e2", "e3"]);
    expect(win.from).toBe(0);
  });

  it("ignore les lignes corrompues sans échouer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-session-history-"));
    tmpDirs.push(dir);
    const file = join(dir, "broken.jsonl");
    writeFileSync(
      file,
      [JSON.stringify(msg("e1", 1)), "{ ceci n'est pas du json", JSON.stringify(msg("e2", 2))].join("\n"),
      "utf8",
    );
    const win = await readSessionHistoryFile(file);
    expect(win.messages.map((m: any) => m.id)).toEqual(["e1", "e2"]);
  });
});
