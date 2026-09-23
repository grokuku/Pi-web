/**
 * exploration-notes.test.ts — tests du « Carnet d'exploration » (P2).
 *
 * Couvre les garanties du plan :
 *  - rendu PUR : budget jamais dépassé, boost par la tâche, dégradation
 *    ordonnée (complet → court → titres), carnet vide → "";
 *  - parsing JSONL TOLÉRANT (ligne corrompue ignorée, note sans texte rejetée) ;
 *  - stockage : append-only, lecture, recherche, compaction paresseuse
 *    (TTL 90 j + plafond 300 notes), purge du projet ;
 *  - sécurité : segment de dossier assaini (pas de traversée de chemin).
 *
 * Les tests d'E/S écrivent dans un dossier temporaire (opts.dir) — JAMAIS le
 * vrai .data/harness-notes du repo.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendExplorationNote,
  buildNotesDigest,
  compactExplorationNotes,
  EXPLORATION_NOTES_BUDGET_CHARS,
  EXPLORATION_NOTES_MARKER_END,
  EXPLORATION_NOTES_MARKER_START,
  EXPLORATION_NOTES_MAX,
  EXPLORATION_NOTES_TTL_MS,
  normalizeNoteInput,
  notesFilePath,
  parseNotesJsonl,
  purgeProjectNotes,
  readExplorationNotes,
  renderNotesDigestTier,
  safeProjectSegment,
  searchExplorationNotes,
  serializeNote,
  type ExplorationNote,
} from "./exploration-notes.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "exploration-notes-"));
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // nettoyage best-effort
  }
});

/** Carnet de test borné pour un rendu prévisible. */
function makeNotes(): ExplorationNote[] {
  return [
    {
      at: "2026-09-01T10:00:00.000Z",
      kind: "fact",
      text: "Le routage LLM se résout dans un module dédié au routage",
      file: "backend/src/pi/routing.ts",
    },
    {
      at: "2026-09-02T10:00:00.000Z",
      kind: "pitfall",
      text: "buildRepoMap doit rester PUR, sinon les tests deviennent instables",
      file: "backend/src/pi/repo-map.ts",
    },
    {
      at: "2026-09-03T10:00:00.000Z",
      kind: "decision",
      text: "Le stockage du carnet est hors repo sous .data/harness-notes",
    },
  ];
}

describe("constantes et marqueurs", () => {
  it("expose un budget ~2000 chars et des marqueurs appariables", () => {
    expect(EXPLORATION_NOTES_BUDGET_CHARS).toBe(2000);
    expect(EXPLORATION_NOTES_MARKER_START).toBe("<!-- PI_EXPLORATION_NOTES -->");
    expect(EXPLORATION_NOTES_MARKER_END).toBe("<!-- /PI_EXPLORATION_NOTES -->");
  });
});

describe("rendu du digest (pur)", () => {
  it("retourne \"\" quand le carnet est vide", () => {
    expect(buildNotesDigest([])).toBe("");
    expect(buildNotesDigest(undefined as unknown as ExplorationNote[])).toBe("");
  });

  it("respecte le budget pour toute une série de valeurs", () => {
    const notes = makeNotes();
    for (const budget of [60, 120, 300, 800, 2000]) {
      const text = buildNotesDigest(notes, { budget });
      expect(text.length).toBeLessThanOrEqual(budget);
    }
  });

  it("le digest par défaut tient dans les 2000 chars et contient l'en-tête", () => {
    const text = buildNotesDigest(makeNotes());
    expect(text.length).toBeLessThanOrEqual(EXPLORATION_NOTES_BUDGET_CHARS);
    expect(text).toContain("Carnet d'exploration");
    expect(text).toContain("exploration_note");
  });

  it("dégrade complètement → court → titres selon le budget", () => {
    const notes = makeNotes();
    const full = renderNotesDigestTier(notes, "full");
    const short = renderNotesDigestTier(notes, "short");
    const titles = renderNotesDigestTier(notes, "titles");

    expect(full.length).toBeGreaterThan(short.length);
    expect(short.length).toBeGreaterThan(titles.length);

    // Palier complet : chemin de fichier présent.
    expect(full).toContain("backend/src/pi/routing.ts");
    // Palier titres : plus de chemin, mais toujours les libellés de nature.
    expect(titles).not.toContain("backend/src/pi/routing.ts");
    expect(titles).toContain("[fait]");
  });

  it("tronque proprement (fin sur une ligne entière + « … ») à budget minuscule", () => {
    const text = buildNotesDigest(makeNotes(), { budget: 80 });
    expect(text.length).toBeLessThanOrEqual(80);
    expect(text.endsWith("…") || text.length < 80).toBe(true);
  });

  it("booste les notes citées par la tâche", () => {
    const notes = makeNotes();
    // Sans hint : la plus récente (décision, sans fichier) en tête.
    const without = renderNotesDigestTier(notes, "full", { task: "" });
    const firstWithout = without.split("\n")[1];
    expect(firstWithout).toContain("hors repo");

    // Tâche ciblant repo-map.ts → la note de ce fichier remonte en tête.
    const withHint = renderNotesDigestTier(notes, "full", {
      task: "Corrige buildRepoMap dans backend/src/pi/repo-map.ts",
    });
    const firstWith = withHint.split("\n")[1];
    expect(firstWith).toContain("repo-map.ts");
  });
});

describe("normalisation et parsing JSONL", () => {
  it("normalise une entrée en une ligne et rejette un texte vide", () => {
    const note = normalizeNoteInput({
      kind: "pitfall",
      text: "  ligne 1\nligne 2\t ",
    });
    expect(note?.text).toBe("ligne 1 ligne 2");
    expect(note?.kind).toBe("pitfall");
    expect(normalizeNoteInput({ kind: "fact", text: "   " })).toBeNull();
  });

  it("ignore une ligne corrompue et rejette une note sans texte", () => {
    const content = [
      "pas du json",
      JSON.stringify({ at: "2026-01-01T00:00:00.000Z", kind: "fact", text: "ok" }),
      JSON.stringify({ at: "2026-01-01T00:00:00.000Z", kind: "fact", text: "  " }),
      JSON.stringify({ at: "2026-01-01T00:00:00.000Z", kind: "inconnu", text: "kind replié" }),
    ].join("\n");
    const notes = parseNotesJsonl(content);
    expect(notes).toHaveLength(2);
    expect(notes[0].text).toBe("ok");
    expect(notes[1].kind).toBe("fact"); // kind inconnu → repli "fact"
  });

  it("serializeNote ne produit pas de retour à la ligne", () => {
    expect(serializeNote(makeNotes()[0])).not.toContain("\n");
  });
});

describe("stockage append-only", () => {
  it("écrit puis relit une note (aller-retour)", () => {
    const written = appendExplorationNote(
      "projet-1",
      { kind: "fact", text: "Le build tourne avec tsx", file: "backend/package.json" },
      { dir: tmpRoot },
    );
    expect(written?.text).toBe("Le build tourne avec tsx");

    const notes = readExplorationNotes("projet-1", { dir: tmpRoot });
    expect(notes).toHaveLength(1);
    expect(notes[0].file).toBe("backend/package.json");
  });

  it("appende sans écraser (plusieurs notes)", () => {
    appendExplorationNote("p", { kind: "fact", text: "un" }, { dir: tmpRoot });
    appendExplorationNote("p", { kind: "fact", text: "deux" }, { dir: tmpRoot });
    const notes = readExplorationNotes("p", { dir: tmpRoot });
    expect(notes.map((n) => n.text)).toEqual(["un", "deux"]);
  });

  it("rejette une note au texte vide", () => {
    expect(
      appendExplorationNote("p", { kind: "fact", text: "   " }, { dir: tmpRoot }),
    ).toBeNull();
    expect(readExplorationNotes("p", { dir: tmpRoot })).toHaveLength(0);
  });

  it("isole les carnets par projectId", () => {
    appendExplorationNote("a", { kind: "fact", text: "note-a" }, { dir: tmpRoot });
    appendExplorationNote("b", { kind: "fact", text: "note-b" }, { dir: tmpRoot });
    expect(readExplorationNotes("a", { dir: tmpRoot }).map((n) => n.text)).toEqual(["note-a"]);
    expect(readExplorationNotes("b", { dir: tmpRoot }).map((n) => n.text)).toEqual(["note-b"]);
  });

  it("recherche plein texte insensible à la casse", () => {
    appendExplorationNote("p", { kind: "fact", text: "Le routage est dans routing.ts" }, { dir: tmpRoot });
    appendExplorationNote("p", { kind: "pitfall", text: "Attention au cache CBM" }, { dir: tmpRoot });
    expect(searchExplorationNotes("p", "ROUTAGE", { dir: tmpRoot })).toHaveLength(1);
    expect(searchExplorationNotes("p", "cache", { dir: tmpRoot })).toHaveLength(1);
    expect(searchExplorationNotes("p", "inexistant", { dir: tmpRoot })).toHaveLength(0);
  });
});

describe("compaction paresseuse", () => {
  it("expire les notes plus vieilles que le TTL (90 j)", () => {
    const file = notesFilePath("p", { dir: tmpRoot });
    mkdirSync(path.dirname(file), { recursive: true });
    const now = Date.parse("2026-09-01T00:00:00.000Z");
    const old = new Date(now - EXPLORATION_NOTES_TTL_MS - 1000).toISOString();
    const fresh = new Date(now - 1000).toISOString();
    writeFileSync(
      file,
      [
        serializeNote({ at: old, kind: "fact", text: "trop vieille" }),
        serializeNote({ at: fresh, kind: "fact", text: "récente" }),
      ].join("\n") + "\n",
    );

    const removed = compactExplorationNotes("p", { dir: tmpRoot, now });
    expect(removed).toBe(1);
    const notes = readExplorationNotes("p", { dir: tmpRoot });
    expect(notes.map((n) => n.text)).toEqual(["récente"]);
  });

  it("plafonne à EXPLORATION_NOTES_MAX notes (les plus récentes gagnent)", () => {
    for (let i = 0; i < EXPLORATION_NOTES_MAX + 5; i++) {
      appendExplorationNote(
        "p",
        { kind: "fact", text: `note-${i}` },
        { dir: tmpRoot, now: Date.parse("2026-09-01T00:00:00.000Z") + i * 1000 },
      );
    }
    const notes = readExplorationNotes("p", { dir: tmpRoot });
    expect(notes.length).toBe(EXPLORATION_NOTES_MAX);
    expect(notes[0].text).toBe("note-5"); // les 5 plus anciennes ont été retirées
    expect(notes[notes.length - 1].text).toBe(`note-${EXPLORATION_NOTES_MAX + 4}`);
  });

  it("ne réécrit pas quand rien n'a expiré (retourne 0)", () => {
    appendExplorationNote("p", { kind: "fact", text: "stable" }, { dir: tmpRoot });
    expect(compactExplorationNotes("p", { dir: tmpRoot })).toBe(0);
  });
});

describe("purge du projet", () => {
  it("supprime le dossier du carnet", () => {
    appendExplorationNote("p", { kind: "fact", text: "à purger" }, { dir: tmpRoot });
    const dir = path.dirname(notesFilePath("p", { dir: tmpRoot }));
    expect(existsSync(dir)).toBe(true);
    expect(purgeProjectNotes("p", { dir: tmpRoot })).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(readExplorationNotes("p", { dir: tmpRoot })).toHaveLength(0);
  });

  it("ne jette pas si le carnet n'existe pas", () => {
    expect(purgeProjectNotes("inconnu", { dir: tmpRoot })).toBe(false);
  });
});

describe("sécurité du chemin", () => {
  it("refuse la traversée et assainit le segment de dossier", () => {
    expect(safeProjectSegment("../../etc")).not.toContain("/");
    expect(safeProjectSegment("../../etc")).not.toContain("..");
    expect(safeProjectSegment("nom de dossier")).toBe("nom_de_dossier");
    expect(safeProjectSegment("")).toBe("_unknown");
  });
});
