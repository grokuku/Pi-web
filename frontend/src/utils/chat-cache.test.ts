// ── Tests unitaires : garde d'ancienneté du snapshot chat localStorage ─────
// Volet 3 du correctif 6210d1c : un snapshot très ancien ne doit jamais être
// présenté comme l'état courant de la conversation.
import { describe, it, expect } from "vitest";
import { parseChatCacheSnapshot, CHAT_CACHE_MAX_AGE_MS } from "./chat-cache";

const NOW = 1_800_000_000_000; // horloge figée
const H = 3_600_000;

function msg(ts: number, content = "hello") {
  return { id: `u-${ts}`, role: "user", content, thinking: "", toolCalls: [], timestamp: ts };
}

describe("parseChatCacheSnapshot", () => {
  it("null si snapshot absent / vide / corrompu", () => {
    expect(parseChatCacheSnapshot(null, NOW)).toBeNull();
    expect(parseChatCacheSnapshot("", NOW)).toBeNull();
    expect(parseChatCacheSnapshot("[]", NOW)).toBeNull();
    expect(parseChatCacheSnapshot("{pas du json", NOW)).toBeNull();
    expect(parseChatCacheSnapshot(JSON.stringify({ pas: "un tableau" }), NOW)).toBeNull();
  });

  it("snapshot frais (< 24 h) → fresh=true, messages conservés", () => {
    const raw = JSON.stringify([msg(NOW - 2 * H), msg(NOW - H)]);
    const snap = parseChatCacheSnapshot(raw, NOW);
    expect(snap).not.toBeNull();
    expect(snap!.fresh).toBe(true);
    expect(snap!.messages).toHaveLength(2);
    expect(snap!.ageMs).toBe(H);
  });

  it("snapshot à la limite exacte (24 h) → fresh (<= maxAge)", () => {
    const raw = JSON.stringify([msg(NOW - CHAT_CACHE_MAX_AGE_MS)]);
    expect(parseChatCacheSnapshot(raw, NOW)!.fresh).toBe(true);
  });

  it("snapshot de plus de 24 h → fresh=false (ne pas l'afficher comme état courant)", () => {
    const raw = JSON.stringify([msg(NOW - CHAT_CACHE_MAX_AGE_MS - 1), msg(NOW - 48 * H)]);
    const snap = parseChatCacheSnapshot(raw, NOW);
    expect(snap).not.toBeNull();
    expect(snap!.fresh).toBe(false);
    expect(snap!.ageMs).toBeGreaterThan(CHAT_CACHE_MAX_AGE_MS);
  });

  it("la fraîcheur est jugée sur le message le PLUS RÉCENT (pas le plus ancien)", () => {
    // Un vieux message n'empêche pas la fraîcheur si le snapshot contient du récent.
    const raw = JSON.stringify([msg(NOW - 72 * H), msg(NOW - H)]);
    expect(parseChatCacheSnapshot(raw, NOW)!.fresh).toBe(true);
    // Inversement, si TOUS les messages sont hors délai, le plus récent (25 h)
    // fait périmé le snapshot.
    const raw2 = JSON.stringify([msg(NOW - 30 * H), msg(NOW - 25 * H)]);
    expect(parseChatCacheSnapshot(raw2, NOW)!.fresh).toBe(false);
  });

  it("snapshot sans horodatage exploitable → réputé périmé (défaut sûr)", () => {
    const raw = JSON.stringify([{ id: "u1", role: "user", content: "x", toolCalls: [] }]);
    const snap = parseChatCacheSnapshot(raw, NOW);
    expect(snap).not.toBeNull();
    expect(snap!.fresh).toBe(false);
    expect(snap!.ageMs).toBe(Infinity);
  });
});