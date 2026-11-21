// ── Tests : plafonnement du cache local du fil (en OCTETS) ─────────────────
// Aucun réseau, aucun stockage : module PUR.
//
// Le premier test est la MESURE qui justifie le remplacement du plafond
// historique « 200 messages » (BUG-22) : ce plafond ne protège pas du quota,
// parce que le poids vient de QUELQUES messages (sorties de sous-agents).
import { describe, it, expect } from "vitest";
import {
  fitMessagesToBudget,
  truncateHeavyFields,
  utf8Bytes,
  CACHE_TRUNCATION_SUFFIX,
  CHAT_CACHE_BLOCK_MAX_CHARS,
} from "./chat-cache-budget";
import type { DisplayMessage } from "../types";

function msg(i: number, toolOutputLen = 0, contentLen = 800): DisplayMessage {
  return {
    id: `m-${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: "x".repeat(contentLen),
    thinking: "y".repeat(300),
    toolCalls: toolOutputLen
      ? [{ id: `tc-${i}`, name: "bash", args: { command: "ls -la" }, output: "z".repeat(toolOutputLen), isError: false, isStreaming: false }]
      : [],
    timestamp: 1_700_000_000_000 + i * 1000,
  };
}

const MB = 1024 * 1024;

describe("MESURE — volume qui fait tomber le quota localStorage (~5 Mo)", () => {
  it("200 messages dont 20 outils de 50 000 caractères ≈ 1,2 Mo : le plafond « 200 messages » ne protège pas", () => {
    const thread = Array.from({ length: 200 }, (_, i) => msg(i, i < 20 ? 50_000 : 0));
    const bytes = utf8Bytes(thread);
    expect(bytes).toBeGreaterThan(1 * MB);
    // Preuve : on reste LOIN du quota → le quota ne tombe pas à cause du
    // nombre de messages, mais du poids de quelques-uns.
    expect(bytes).toBeLessThan(3 * MB);
  });

  it("5 messages porteurs d'une sortie de ~1 Mo (≈ 257k tokens) suffisent à dépasser le quota", () => {
    const four = Array.from({ length: 4 }, (_, i) => msg(i, 1_000_000));
    const five = Array.from({ length: 5 }, (_, i) => msg(i, 1_000_000));
    expect(utf8Bytes(four)).toBeLessThan(4.5 * MB);
    expect(utf8Bytes(five)).toBeGreaterThan(4.5 * MB);
  });
});

describe("truncateHeavyFields", () => {
  it("tronque les sorties d'outils, la réflexion et les images inline, sans muter l'entrée", () => {
    const input: DisplayMessage[] = [
      {
        id: "a",
        role: "assistant",
        content: "réponse intacte",
        thinking: "r".repeat(CHAT_CACHE_BLOCK_MAX_CHARS + 100),
        toolCalls: [{ id: "t1", name: "bash", args: {}, output: "o".repeat(CHAT_CACHE_BLOCK_MAX_CHARS + 500), isError: false, isStreaming: false }],
        images: [{ name: "shot.png", mimeType: "image/png", data: "A".repeat(100_000) }],
        timestamp: 1,
      },
    ];
    const { messages, truncated } = truncateHeavyFields(input);

    expect(truncated).toBe(true);
    expect(messages[0].content).toBe("réponse intacte"); // le texte de conversation reste
    expect(messages[0].toolCalls[0].output.endsWith(CACHE_TRUNCATION_SUFFIX)).toBe(true);
    expect(messages[0].toolCalls[0].output.length).toBe(CHAT_CACHE_BLOCK_MAX_CHARS + CACHE_TRUNCATION_SUFFIX.length);
    expect(messages[0].thinking!.length).toBe(CHAT_CACHE_BLOCK_MAX_CHARS + CACHE_TRUNCATION_SUFFIX.length);
    expect(messages[0].images![0].data).toBeUndefined();
    expect(messages[0].images![0].name).toBe("shot.png");

    // Entrée NON mutée (le fil live partage ses objets avec le rendu React).
    expect(input[0].toolCalls[0].output.length).toBe(CHAT_CACHE_BLOCK_MAX_CHARS + 500);
    expect(input[0].images![0].data!.length).toBe(100_000);
  });

  it("contenu court → nothing to truncate", () => {
    const { messages, truncated } = truncateHeavyFields([msg(0, 10)]);
    expect(truncated).toBe(false);
    expect(messages[0].toolCalls[0].output).toBe("z".repeat(10));
  });
});

describe("fitMessagesToBudget", () => {
  it("sous le budget → tout est conservé, rien n'est évincé", () => {
    const thread = Array.from({ length: 10 }, (_, i) => msg(i));
    const fit = fitMessagesToBudget(thread, { maxBytes: 10 * MB });
    expect(fit.dropped).toBe(0);
    expect(fit.messages).toHaveLength(10);
    expect(fit.truncated).toBe(false);
    expect(fit.fits).toBe(true);
  });

  it("au-dessus du budget → les messages les PLUS RÉCENTS sont conservés, les plus anciens évincés", () => {
    // 100 messages de ~15 000 caractères (sous le seuil de troncature du
    // contenu) = ~1,5 Mo : le budget de 1 Mo ne peut pas tout garder.
    const thread = Array.from({ length: 100 }, (_, i) => ({ ...msg(i), content: "x".repeat(15_000) }));
    const budget = 1 * MB;
    const fit = fitMessagesToBudget(thread, { maxBytes: budget });

    expect(fit.fits).toBe(true);
    expect(fit.bytes).toBeLessThanOrEqual(budget);
    expect(fit.dropped).toBeGreaterThan(0);
    // Le dernier message (le plus récent) est TOUJOURS là.
    expect(fit.messages[fit.messages.length - 1].id).toBe("m-99");
    // Les premiers (les plus anciens) sont partis.
    expect(fit.messages.some((m) => m.id === "m-0")).toBe(false);
    // Ordre chronologique préservé.
    const ids = fit.messages.map((m) => Number(m.id.slice(2)));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("plafond du nombre de messages → seuls les N derniers sont gardés", () => {
    const thread = Array.from({ length: 50 }, (_, i) => msg(i));
    const fit = fitMessagesToBudget(thread, { maxBytes: 10 * MB, maxMessages: 5 });
    expect(fit.messages.map((m) => m.id)).toEqual(["m-45", "m-46", "m-47", "m-48", "m-49"]);
    expect(fit.dropped).toBe(45);
  });

  it("un SEUL message plus gros que le budget → fits=false (l'appelant n'écrit pas de monstre)", () => {
    // Le TEXTE de conversation n'est jamais tronqué : un message dont le
    // `content` dépasse à lui seul le budget ne peut pas être réduit.
    const thread = [msg(0), { ...msg(1), content: "x".repeat(5_000_000) }];
    // `truncateBlocks: false` : sans troncature, un `content` de 5 Mo ne peut
    // pas être réduit → l'appelant doit renoncer à écrire.
    const fit = fitMessagesToBudget(thread, { maxBytes: 1 * MB, truncateBlocks: false });
    expect(fit.fits).toBe(false);
    expect(fit.messages).toHaveLength(1);
    expect(fit.messages[0].id).toBe("m-1");
  });

  it("fil vide → résultat vide neutre (aucune exception)", () => {
    expect(fitMessagesToBudget([], { maxBytes: MB })).toMatchObject({ messages: [], bytes: 0, fits: true });
  });
});
