/**
 * Tests unitaires de pi/ui-history.ts (fix « messages récents manquants »).
 *
 * buildFullUiHistory reconstruit l'historique UI depuis les ENTRÉES brutes de
 * la session (sessionManager.getEntries()) au lieu du seul contexte LLM
 * compaction-aware, qui tronquait tout ce qui précède la dernière compaction.
 *
 * Couverture :
 *  - fallback propre sans sessionManager (ancien comportement conservé) ;
 *  - compactions INLINE (role compactionSummary, summary + tokensBefore) à
 *    leur place chronologique, pas en fin de liste ;
 *  - ordre chronologique strict (ordre du fichier de session) ;
 *  - ids d'entrée attachés à CHAQUE message (dédup frontend fiable) ;
 *  - payload borné : images PRÉ-compaction dépouillées, images POST-
 *    compaction conservées ;
 *  - types d'entrée non-message (session/label/model_change/…) exclus.
 */
import { describe, it, expect } from "vitest";
import {
  buildFullUiHistory,
  serializeMessagesForUi,
  sliceUiHistoryWindow,
  HISTORY_PAGE_SIZE,
  HISTORY_PAGE_MAX,
} from "./ui-history.js";

// Fabriquant de liste complète factice : N messages avec ids stables (e0…eN).
function makeFull(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({ id: `e${i}`, role: "user", content: `m${i}`, timestamp: i }));
}

// Petit fabriquant de session factice : entries[] = ordre chronologique du
// fichier de session (c'est la garantie fournie par getEntries()).
function makeSession(entries: any[]) {
  return { sessionManager: { getEntries: () => entries } };
}

describe("buildFullUiHistory", () => {
  it("fallback propre sans sessionManager (ou getEntries absent)", () => {
    // Pas de sessionManager du tout → sérialisation directe du contexte LLM.
    const bare = { messages: [{ id: "m1", role: "user", content: "hello", timestamp: 1 }] };
    expect(buildFullUiHistory(bare)).toEqual([
      { id: "m1", role: "user", content: "hello", timestamp: 1 },
    ]);
    // sessionManager présent mais getEntries non fonctionnel → même fallback.
    expect(buildFullUiHistory({ sessionManager: {}, messages: [] })).toEqual([]);
  });

  it("compactions INLINE (compactionSummary) à leur place chronologique", () => {
    const session = makeSession([
      { type: "message", id: "e1", timestamp: 1, message: { role: "user", content: "avant compaction", timestamp: 1 } },
      { type: "compaction", id: "e2", timestamp: 2, summary: "résumé de la conversation", tokensBefore: 900 },
      { type: "message", id: "e3", timestamp: 3, message: { role: "user", content: "après compaction", timestamp: 3 } },
    ]);
    const ui = buildFullUiHistory(session);
    // La compaction est AU MILIEU de la liste (et non une troncature)…
    expect(ui).toHaveLength(3);
    expect(ui[1]).toMatchObject({
      id: "e2",
      role: "compactionSummary",
      summary: "résumé de la conversation",
      tokensBefore: 900,
      timestamp: 2,
    });
    // …et le message PRÉ-compaction reste visible (c'est tout l'objet du fix).
    expect(ui[0]).toMatchObject({ id: "e1", role: "user", content: "avant compaction" });
  });

  it("ordre chronologique strict (ordre du fichier) et ids d'entrée attachés", () => {
    const session = makeSession([
      { type: "message", id: "e10", timestamp: 10, message: { role: "user", content: "u1", timestamp: 10 } },
      { type: "message", id: "e11", timestamp: 11, message: { role: "assistant", content: [{ type: "text", text: "a1" }], timestamp: 11 } },
      { type: "message", id: "e12", timestamp: 12, message: { role: "user", content: "u2", timestamp: 12 } },
    ]);
    const ui = buildFullUiHistory(session);
    expect(ui.map((m: any) => m.id)).toEqual(["e10", "e11", "e12"]);
    expect(ui.map((m: any) => m.timestamp)).toEqual([10, 11, 12]);
    // L'id de l'ENTRÉE est prioritaire sur tout id dérivé du timestamp.
    expect(ui[1].role).toBe("assistant");
    expect(ui[1].content).toEqual([{ type: "text", text: "a1" }]);
  });

  it("payload borné : images pré-compaction dépouillées, récentes conservées", () => {
    const imageBlock = { type: "image", mimeType: "image/png", data: "base64…" };
    const session = makeSession([
      { type: "message", id: "e1", timestamp: 1, message: { role: "user", content: [{ type: "text", text: "regarde" }, imageBlock], timestamp: 1 } },
      { type: "compaction", id: "e2", timestamp: 2, summary: "s", tokensBefore: 100 },
      { type: "message", id: "e3", timestamp: 3, message: { role: "user", content: [{ type: "text", text: "re-" }, { type: "image", mimeType: "image/png", data: "récent" }], timestamp: 3 } },
    ]);
    const ui = buildFullUiHistory(session);
    // Pré-compaction : l'image est remplacée par un placeholder texte (payload léger).
    expect(ui[0].content).toEqual([
      { type: "text", text: "regarde" },
      { type: "text", text: "[image omise de l'historique ancien]" },
    ]);
    // Post-compaction : l'image est conservée telle quelle.
    expect(ui[2].content[1]).toEqual({ type: "image", mimeType: "image/png", data: "récent" });
  });

  it("ignore les types d'entrée non-message (session/label/model_change/…)", () => {
    const session = makeSession([
      { type: "session", id: "s", timestamp: 1 },
      { type: "label", id: "l", timestamp: 2, label: "test" },
      { type: "model_change", id: "mc", timestamp: 3, model: "gpt" },
      { type: "thinking_level_change", id: "tlc", timestamp: 4, level: "high" },
      { type: "message", id: "e5", timestamp: 5, message: { role: "user", content: "seul vrai message", timestamp: 5 } },
    ]);
    const ui = buildFullUiHistory(session);
    expect(ui).toHaveLength(1);
    expect(ui[0]).toMatchObject({ id: "e5", content: "seul vrai message" });
  });

  it("branch_summary et custom_message deviennent des customs affichables avec id", () => {
    const session = makeSession([
      { type: "branch_summary", id: "b1", timestamp: 1, summary: "résumé de branche" },
      { type: "custom_message", id: "c1", timestamp: 2, customType: "pi_command", content: "/clear", display: true },
    ]);
    const ui = buildFullUiHistory(session);
    expect(ui).toEqual([
      { id: "b1", role: "custom", customType: "branch_summary", content: "résumé de branche", display: true, timestamp: 1 },
      { id: "c1", role: "custom", content: "/clear", customType: "pi_command", display: true, timestamp: 2 },
    ]);
  });
});

// ── Chargement par lots : fenêtre envoyée au client (fix de fond) ───────
describe("sliceUiHistoryWindow — tranche et curseur", () => {
  it("fenêtre par défaut : les N derniers messages + curseur + hasMore", () => {
    const full = makeFull(1000);
    const win = sliceUiHistoryWindow(full);
    expect(win.messages).toHaveLength(HISTORY_PAGE_SIZE); // 300
    // Les RÉCENTS sont toujours inclus : la dernière tranche est la fin de liste.
    expect(win.messages[0].id).toBe("e700");
    expect(win.messages[win.messages.length - 1].id).toBe("e999");
    expect(win.from).toBe(1000 - HISTORY_PAGE_SIZE);
    expect(win.total).toBe(1000);
    expect(win.hasMore).toBe(true);
    expect(win.end).toBe(1000);
  });

  it("session courte : tout est envoyé, hasMore=false, curseur à 0", () => {
    const full = makeFull(120);
    const win = sliceUiHistoryWindow(full);
    expect(win.messages).toHaveLength(120);
    expect(win.from).toBe(0);
    expect(win.hasMore).toBe(false);
  });

  it("lot antérieur via curseur before : [before-count, before-1]", () => {
    const full = makeFull(1000);
    // Le client a les 300 derniers (from=700) ; il demande le lot précédent.
    const win = sliceUiHistoryWindow(full, { before: 700 });
    expect(win.messages).toHaveLength(HISTORY_PAGE_SIZE);
    expect(win.messages[0].id).toBe("e400");
    expect(win.messages[win.messages.length - 1].id).toBe("e699");
    expect(win.from).toBe(400);
    expect(win.total).toBe(1000);
    expect(win.hasMore).toBe(true);
  });

  it("dernier lot antérieur : from=0, hasMore=false, tranche partielle", () => {
    const full = makeFull(1000);
    const win = sliceUiHistoryWindow(full, { before: 100, count: 300 });
    expect(win.messages).toHaveLength(100); // tronqué au début de liste
    expect(win.messages[0].id).toBe("e0");
    expect(win.messages[win.messages.length - 1].id).toBe("e99");
    expect(win.from).toBe(0);
    expect(win.hasMore).toBe(false);
  });

  it("beforeId prime sur before et est robuste au décalage d'index", () => {
    const full = makeFull(500);
    // L'id du premier message chargé est e200 → la fenêtre s'arrête AVANT.
    const win = sliceUiHistoryWindow(full, { before: 999, beforeId: "e300" });
    expect(win.end).toBe(300);
    expect(win.messages[win.messages.length - 1].id).toBe("e299");
    expect(win.from).toBe(0); // 300 - 300
    expect(win.hasMore).toBe(false);
    // beforeId inconnu (purge) → retombe sur le curseur numérique.
    const win2 = sliceUiHistoryWindow(full, { before: 300, beforeId: "ghost" });
    expect(win2.end).toBe(300);
  });

  it("all=true : tout ce qui précède le curseur en un seul lot", () => {
    const full = makeFull(1000);
    const win = sliceUiHistoryWindow(full, { before: 700, all: true });
    expect(win.messages).toHaveLength(700);
    expect(win.from).toBe(0);
    expect(win.hasMore).toBe(false);
    // Sans curseur, all renvoie aussi la liste complète.
    expect(sliceUiHistoryWindow(full, { all: true }).messages).toHaveLength(1000);
  });

  it("plafond de sécurité : count borné à [1, HISTORY_PAGE_MAX]", () => {
    const full = makeFull(5000);
    // count énorme (client buggé) → plafonné.
    expect(sliceUiHistoryWindow(full, { count: 999_999 }).messages).toHaveLength(HISTORY_PAGE_MAX);
    expect(sliceUiHistoryWindow(full, { count: 999_999 }).from).toBe(5000 - HISTORY_PAGE_MAX);
    // count nul/négatif → plancher à 1 ; count non numérique → défaut (300).
    expect(sliceUiHistoryWindow(full, { count: 0 }).messages).toHaveLength(1);
    expect(sliceUiHistoryWindow(full, { count: -50 }).messages).toHaveLength(1);
    expect(sliceUiHistoryWindow(full, { count: "beaucoup" as any }).messages).toHaveLength(HISTORY_PAGE_SIZE);
  });

  it("curseurs dégénérés : NaN/négatif/au-delà de total → bornés", () => {
    const full = makeFull(100);
    // NaN (non numérique) → fin de liste par défaut.
    expect(sliceUiHistoryWindow(full, { before: "x" as any }).end).toBe(100);
    // Au-delà du total → borné au total.
    expect(sliceUiHistoryWindow(full, { before: 5000 }).end).toBe(100);
    // Négatif → borné à 0 (lot vide, hasMore=false).
    const win = sliceUiHistoryWindow(full, { before: -10 });
    expect(win.end).toBe(0);
    expect(win.messages).toHaveLength(0);
    expect(win.hasMore).toBe(false);
  });

  it("liste vide : fenêtre vide, pas d'erreur", () => {
    const win = sliceUiHistoryWindow([]);
    expect(win.messages).toEqual([]);
    expect(win.total).toBe(0);
    expect(win.from).toBe(0);
    expect(win.hasMore).toBe(false);
  });

  it("stabilité des curseurs : pages successives recouvrent la liste complète", () => {
    const full = makeFull(1000);
    // Simule le client : page 1 (par défaut), puis before=from, etc.
    const pages: number[][] = [];
    let cursor: number | undefined;
    for (let i = 0; i < 10; i++) {
      const win = sliceUiHistoryWindow(full, { before: cursor });
      pages.push(win.messages.map((m: any) => Number(m.id.slice(1))));
      if (!win.hasMore) break;
      cursor = win.from;
    }
    // Aucun trou, aucun doublon, couverture totale (les pages sont des blocs
    // DESCENDANTS : la 1re page contient les plus récents, chaque lot suivant
    // remonte vers le début de liste).
    const flat = pages.flat();
    const sorted = [...flat].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    expect(new Set(flat).size).toBe(1000);
    // Le dernier lot remonte bien jusqu'au tout premier message (e0).
    expect(pages[pages.length - 1][0]).toBe(0);
  });
});

describe("serializeMessagesForUi", () => {
  it("normalise tool_use → toolCall et préserve stopReason/errorMessage (BUG-68)", () => {
    const out = serializeMessagesForUi([{
      id: "a1", role: "assistant", timestamp: 1, stopReason: "error", errorMessage: "boom",
      content: [{ type: "tool_use", name: "read", arguments: { path: "x" } }, { type: "thinking", thinking: "hmm" }],
    }]);
    expect(out[0].content[0]).toMatchObject({ type: "toolCall", name: "read", arguments: { path: "x" } });
    expect(out[0].thinking).toBe("hmm");
    expect(out[0].stopReason).toBe("error");
    expect(out[0].errorMessage).toBe("boom");
  });
});