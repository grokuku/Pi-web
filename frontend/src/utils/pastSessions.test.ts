import { describe, it, expect } from "vitest";
import {
  normalizePastSessions,
  filterPastSessions,
  truncatePreview,
  formatBytes,
  formatSessionDate,
  sessionDateMs,
} from "./pastSessions";
import type { PastSession } from "../types";

function session(partial: Partial<PastSession> & { id: string }): PastSession {
  return {
    firstMessage: "",
    messageCount: 0,
    created: "",
    modified: "",
    ...partial,
  };
}

describe("normalizePastSessions", () => {
  it("coerce les champs et ignore les entrées sans id", () => {
    const out = normalizePastSessions([
      { id: "s1", firstMessage: "hello", messageCount: 12, created: "2026-01-01T10:00:00.000Z", modified: "2026-01-02T10:00:00.000Z", sizeBytes: 2048, name: "  " },
      { firstMessage: "sans id" },
      null,
      { id: "s2" },
    ]);
    expect(out.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(out[0]).toMatchObject({ firstMessage: "hello", messageCount: 12, sizeBytes: 2048 });
    // name vide → undefined ; champs absents → valeurs sûres.
    expect(out[0].name).toBeUndefined();
    expect(out[1]).toMatchObject({ firstMessage: "", messageCount: 0, created: "", modified: "" });
  });

  it("trie des plus récentes aux plus anciennes (modified, puis created)", () => {
    const out = normalizePastSessions([
      { id: "vieux", modified: "2026-01-01T00:00:00.000Z" },
      { id: "recent", modified: "2026-03-01T00:00:00.000Z" },
      { id: "inter", modified: "2026-02-01T00:00:00.000Z" },
    ]);
    expect(out.map((s) => s.id)).toEqual(["recent", "inter", "vieux"]);
  });

  it("renvoie un tableau vide sur payload non-tableau", () => {
    expect(normalizePastSessions(undefined)).toEqual([]);
    expect(normalizePastSessions({ sessions: [] })).toEqual([]);
  });
});

describe("sessionDateMs", () => {
  it("privilégie modified puis created", () => {
    expect(sessionDateMs(session({ id: "a", modified: "2026-02-01T00:00:00.000Z", created: "2026-01-01T00:00:00.000Z" })))
      .toBe(Date.parse("2026-02-01T00:00:00.000Z"));
    expect(sessionDateMs(session({ id: "a", created: "2026-01-01T00:00:00.000Z" })))
      .toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  });

  it("renvoie 0 si aucune date exploitable", () => {
    expect(sessionDateMs(session({ id: "a" }))).toBe(0);
    expect(sessionDateMs(session({ id: "a", modified: "pas une date" }))).toBe(0);
  });
});

describe("truncatePreview", () => {
  it("compacte les espaces et coupe avec une ellipsis", () => {
    expect(truncatePreview("  bonjour   le   monde  ")).toBe("bonjour le monde");
    const long = "a".repeat(200);
    const cut = truncatePreview(long, 10);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(10);
  });
});

describe("formatBytes", () => {
  it("formate B / KB / MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1024 * 1024 * 3)).toBe("3.0 MB");
    expect(formatBytes(NaN)).toBe("");
  });
});

describe("formatSessionDate", () => {
  it("renvoie une date+heure non vide et vide sur valeur illisible", () => {
    const s = formatSessionDate("2026-01-02T15:04:00.000Z", "fr");
    expect(s).toContain("2026");
    expect(s.length).toBeGreaterThan(6);
    expect(formatSessionDate("", "fr")).toBe("");
    expect(formatSessionDate("bidon", "en")).toBe("");
  });
});

describe("filterPastSessions", () => {
  const list = [
    session({ id: "s1", name: "Refonte chat", firstMessage: "Ajoute la pagination" }),
    session({ id: "s2", firstMessage: "Corrige le bug de session" }),
    session({ id: "abc-123", firstMessage: "Autre chose" }),
  ];

  it("requête vide → liste inchangée", () => {
    expect(filterPastSessions(list, "  ")).toBe(list);
  });

  it("filtre sur le nom, l'aperçu et l'id, insensible à la casse", () => {
    expect(filterPastSessions(list, "REFONTE").map((s) => s.id)).toEqual(["s1"]);
    expect(filterPastSessions(list, "bug").map((s) => s.id)).toEqual(["s2"]);
    expect(filterPastSessions(list, "ABC").map((s) => s.id)).toEqual(["abc-123"]);
  });

  it("aucun résultat → tableau vide", () => {
    expect(filterPastSessions(list, "zzz")).toEqual([]);
  });
});
