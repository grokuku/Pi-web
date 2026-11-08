/**
 * harness-thinking-fallback.test.ts — FILET « réflexion seule ⇒ réponse » des
 * DÉLÉGUÉS du harness (incident Beam : tokens comptés, zéro caractère).
 *
 * Le SDK expose la réflexion dans des blocs `thinking` DISTINCTS du texte. Les
 * deux points de lecture de la réponse (`fullResponse` et
 * `collectExpertResponse`, extensions/harness-orchestrator/index.ts) ne lisaient
 * que `.text` ⇒ un modèle à raisonnement qui renvoie tout son contenu dans le
 * raisonnement produisait « Aucun message assistant produit ».
 *
 * La logique testée est la copie EXACTE de `promoteThinkingOnlyAnswer`
 * (frontend/src/utils/pi-events.ts, source de vérité de la session principale).
 * L'extension n'est PAS importable depuis le backend (dépendance SDK, cf.
 * prompt-stability.test.ts) : le CÂBLAGE est verrouillé par lecture STATIQUE de
 * sa source (fs, aucun réseau, aucun appel LLM).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  THINKING_FALLBACK_MARKER,
  emptyResponseMessage,
  markThinkingFallback,
  promoteThinkingOnlyAnswerFromMessages,
} from "./harness-thinking-fallback.js";

const EXTENSION_SOURCE = readFileSync(
  fileURLToPath(new URL("../../../extensions/harness-orchestrator/index.ts", import.meta.url)),
  "utf8",
);

const THINKING = "Je vérifie d'abord la config, puis je conclus.";

/** Message assistant au format SDK (content en blocs typés). */
function assistant(content: unknown[], extra: Record<string, unknown> = {}) {
  return { role: "assistant", content, ...extra };
}

describe("filet réflexion seule — cas 1 : texte + réflexion", () => {
  it("utilise le TEXTE et IGNORE la réflexion (non-régression, jamais mélangés)", () => {
    const messages = [
      assistant([
        { type: "thinking", thinking: THINKING },
        { type: "text", text: "Voici la réponse finale." },
      ]),
    ];
    // Aucune promotion : `fullResponse` (agrégat des `.text`) est non vide et
    // c'est lui qui est rendu — la réflexion n'entre JAMAIS dans la réponse.
    expect(promoteThinkingOnlyAnswerFromMessages(messages)).toBeNull();
  });

  it("ignore aussi la réflexion quand elle précède des tours avec outils", () => {
    const messages = [
      assistant([{ type: "toolCall", id: "t1" }]),
      assistant([{ type: "thinking", thinking: THINKING }], { stopReason: "toolUse" }),
      assistant([{ type: "text", text: "Terminé." }]),
    ];
    expect(promoteThinkingOnlyAnswerFromMessages(messages)).toBeNull();
  });
});

describe("filet réflexion seule — cas 2 : réflexion seule", () => {
  it("utilise la réflexion ET la marque visiblement", () => {
    const messages = [
      assistant([{ type: "thinking", thinking: THINKING }], { stopReason: "stop" }),
    ];
    const fallback = promoteThinkingOnlyAnswerFromMessages(messages);
    expect(fallback).not.toBeNull();
    expect(fallback!.text).toBe(THINKING);

    const marked = markThinkingFallback(fallback!.text);
    // Marquage VISIBLE : l'utilisateur sait que ce n'est pas le texte final.
    expect(marked.startsWith(THINKING_FALLBACK_MARKER)).toBe(true);
    expect(marked).toContain(THINKING);
    expect(marked).toContain("RÉFLEXION");
    // Idempotent (pas de double préfixe).
    expect(markThinkingFallback(marked)).toBe(marked);
  });

  it("agrège plusieurs tours de réflexion (même règle que le frontend, tour par tour)", () => {
    const messages = [
      assistant([{ type: "thinking", thinking: "Premier constat." }]),
      assistant([{ type: "thinking", thinking: "Second constat." }]),
    ];
    const fallback = promoteThinkingOnlyAnswerFromMessages(messages);
    expect(fallback?.text).toBe("Premier constat.\n\nSecond constat.");
  });

  it("ne promeut PAS un tour en erreur ni un tour avec appel d'outil", () => {
    expect(
      promoteThinkingOnlyAnswerFromMessages([
        assistant([{ type: "thinking", thinking: THINKING }], { stopReason: "error", errorMessage: "429" }),
      ]),
    ).toBeNull();
    expect(
      promoteThinkingOnlyAnswerFromMessages([assistant([{ type: "toolCall", id: "t1" }])]),
    ).toBeNull();
  });
});

describe("filet réflexion seule — cas 3 : réponse vraiment vide", () => {
  it("aucune promotion possible (ni texte ni réflexion)", () => {
    expect(promoteThinkingOnlyAnswerFromMessages([])).toBeNull();
    expect(promoteThinkingOnlyAnswerFromMessages([assistant([])])).toBeNull();
    expect(promoteThinkingOnlyAnswerFromMessages([assistant([{ type: "thinking", thinking: "   " }])])).toBeNull();
    expect(promoteThinkingOnlyAnswerFromMessages(undefined)).toBeNull();
  });

  it("le message d'erreur est ACTIONNABLE (réflexion seule évoquée + 2 leviers réels)", () => {
    const message = emptyResponseMessage({
      funcLabel: "Exécution",
      modelLabel: "switchy/Beam",
      thinkingChars: 4200,
    });
    expect(message).toContain("aucune réponse");
    expect(message).toContain("switchy/Beam");
    // Dit que le modèle n'a émis que du raisonnement.
    expect(message).toContain("raisonnement");
    expect(message).toContain("4200");
    // Deux leviers réels, sans inventer de config utilisateur.
    expect(message).toContain("niveau de réflexion");
    expect(message).toContain("reasoning: true");
    expect(message).toContain("bibliothèque de modèles");
  });

  it("variante sans réflexion observée : message également actionnable", () => {
    const message = emptyResponseMessage({ funcLabel: "Revue", modelLabel: "p/m", thinkingChars: 0 });
    expect(message).toContain("ni texte ni réflexion");
    expect(message).toContain("niveau de réflexion");
  });
});

describe("câblage de l'extension (les DEUX points de lecture)", () => {
  it("l'extension importe le module du filet (module backend pur, résolu par jiti)", () => {
    expect(EXTENSION_SOURCE).toContain('from "../../backend/src/pi/harness-thinking-fallback.js"');
  });

  it("le filet est appliqué aux DEUX points de lecture de la réponse", () => {
    const calls = EXTENSION_SOURCE.match(/promoteThinkingOnlyAnswerFromMessages\(/g) ?? [];
    // Une occurrence pour `collectExpertResponse`, une pour `fullResponse`
    // (+ l'import n'utilise pas cette forme d'appel).
    expect(calls).toHaveLength(2);

    // Point 1 : collectExpertResponse (travail partiel d'un run interrompu).
    const collect = EXTENSION_SOURCE.slice(
      EXTENSION_SOURCE.indexOf("function collectExpertResponse"),
      EXTENSION_SOURCE.indexOf("// ── Helpers de routage"),
    );
    expect(collect).toContain("promoteThinkingOnlyAnswerFromMessages(messages)");
    expect(collect).toContain("markThinkingFallback(fallback.text)");

    // Point 2 : fullResponse (chemin nominal de la délégation).
    const at = EXTENSION_SOURCE.indexOf('const fullResponse = assistantTexts.join("\\n\\n")');
    expect(at).toBeGreaterThan(-1);
    const block = EXTENSION_SOURCE.slice(at, at + 1500);
    expect(block).toContain("promoteThinkingOnlyAnswerFromMessages(messages)");
    expect(block).toContain("markThinkingFallback(thinkingFallback.text)");
  });

  it("le texte reste PRIORITAIRE (réflexion seulement si aucun texte)", () => {
    expect(EXTENSION_SOURCE).toContain("const thinkingFallback = fullResponse.trim()");
    expect(EXTENSION_SOURCE).toContain("? null");
    expect(EXTENSION_SOURCE).toContain(
      "const responseText = thinkingFallback ? markThinkingFallback(thinkingFallback.text) : fullResponse;",
    );
  });

  it("la réponse rendue est marquée et signalée dans les détails du tool", () => {
    expect(EXTENSION_SOURCE).toContain("thinkingFallbackUsed = true");
    expect(EXTENSION_SOURCE).toContain("thinkingFallback: thinkingFallbackUsed");
  });

  it("le chemin « réponse vide » renvoie le message actionnable (plus le générique)", () => {
    expect(EXTENSION_SOURCE).toContain("text: emptyResponseMessage({");
    expect(EXTENSION_SOURCE).toContain("thinkingChars,");
    expect(EXTENSION_SOURCE).not.toContain("n'a produit aucune réponse. ` +\n");
  });
});
