/**
 * stream-silence.test.ts — Détecteur de SILENCE DE FLUX.
 *
 * Scénarios couverts :
 *  - un run ACTIF de plusieurs heures (événements réguliers) n'est jamais coupé ;
 *  - un run silencieux au-delà du délai est arrêté proprement (verdict + motif) ;
 *  - un run EN ATTENTE de slot (pause) au-delà du délai n'est PAS tué ;
 *  - le garde-fou de dernier recours est désactivé par défaut ;
 *  - normalisation tolérante des valeurs de config (jamais d'exception) ;
 *  - propagation de la config au manager et au pont globalThis des extensions.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_HARD_TIMEOUT_MS,
  DEFAULT_STREAM_SILENCE_TIMEOUT_MS,
  MAX_STREAM_SILENCE_TIMEOUT_MS,
  MIN_STREAM_SILENCE_TIMEOUT_MS,
  StreamSilenceDetector,
  formatDurationMs,
  hardTimeoutMessage,
  isHardTimeoutMessage,
  isSilenceTimeoutMessage,
  sanitizeAgentHardTimeoutMs,
  sanitizeStreamSilenceTimeoutMs,
  streamSilenceMessage,
} from "./stream-silence.js";
import { CONCURRENCY_BRIDGE_KEY, concurrencyManager } from "./concurrency.js";

/** Horloge simulée minimale (aucun timer réel : les tests n'en dépendent pas). */
function makeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

describe("StreamSilenceDetector — un run ACTIF n'est jamais coupé", () => {
  it("reste 'alive' pendant 4 h avec un événement toutes les minutes", () => {
    const clock = makeClock();
    const detector = new StreamSilenceDetector({
      silenceTimeoutMs: DEFAULT_STREAM_SILENCE_TIMEOUT_MS,
      now: clock.now,
    });
    const fourHours = 4 * 60 * 60_000;
    for (let elapsed = 0; elapsed < fourHours; elapsed += 60_000) {
      clock.advance(60_000);
      detector.touch(); // événement streamé (delta, tool call…)
      expect(detector.evaluate().status).toBe("alive");
    }
    // Preuve de durée : bien au-delà de l'ancien plafond global (30 min).
    expect(detector.elapsedMs).toBeGreaterThan(30 * 60_000);
  });
});

describe("StreamSilenceDetector — silence réel", () => {
  it("passe par 'warning' puis 'silence' avec le bon silentMs", () => {
    const clock = makeClock();
    const detector = new StreamSilenceDetector({ silenceTimeoutMs: 900_000, now: clock.now });

    clock.advance(300_000); // 5 min : sous le seuil (1/3 = 5 min)
    const warn = detector.evaluate();
    expect(warn.status).toBe("warning");
    expect(warn.silentMs).toBe(300_000);

    clock.advance(600_000); // 15 min au total
    const verdict = detector.evaluate();
    expect(verdict.status).toBe("silence");
    expect(verdict.silentMs).toBe(900_000);
  });

  it("0 = illimité : aucun silence fatal", () => {
    const clock = makeClock();
    const detector = new StreamSilenceDetector({ silenceTimeoutMs: 0, now: clock.now });
    clock.advance(72 * 60 * 60_000); // 72 h sans événement
    expect(detector.evaluate().status).toBe("alive");
  });
});

describe("StreamSilenceDetector — attente légitime sans flux (file du limiteur)", () => {
  it("un run en attente de slot n'est PAS tué", () => {
    const clock = makeClock();
    const detector = new StreamSilenceDetector({ silenceTimeoutMs: 900_000, now: clock.now });
    detector.pause(); // entrée dans la file d'attente LLM
    clock.advance(3 * 60 * 60_000); // 3 h d'attente
    expect(detector.waiting).toBe(true);
    expect(detector.evaluate().status).toBe("alive");
    expect(detector.silentMs).toBe(0);

    detector.resume(); // sortie de file : le silence repart de zéro
    clock.advance(899_999);
    expect(detector.evaluate().status).not.toBe("silence");
    clock.advance(1);
    expect(detector.evaluate().status).toBe("silence");
  });
});

describe("StreamSilenceDetector — garde-fou de dernier recours", () => {
  it("est DÉSACTIVÉ par défaut (pas de hard-timeout même après 100 h)", () => {
    const clock = makeClock();
    const detector = new StreamSilenceDetector({ silenceTimeoutMs: 0, now: clock.now });
    clock.advance(100 * 60 * 60_000);
    expect(detector.evaluate().status).toBe("alive");
    expect(DEFAULT_AGENT_HARD_TIMEOUT_MS).toBe(0);
  });

  it("activé explicitement : déclenche 'hard-timeout'", () => {
    const clock = makeClock();
    const detector = new StreamSilenceDetector({
      silenceTimeoutMs: 900_000,
      hardTimeoutMs: 3_600_000,
      now: clock.now,
    });
    // Le flux vit (touch) → pas de silence fatal, mais la borne dure s'applique.
    for (let i = 0; i < 70; i++) {
      clock.advance(60_000);
      detector.touch();
    }
    expect(detector.evaluate().status).toBe("hard-timeout");
  });
});

describe("normalisation de la config", () => {
  it("délai de silence : valeurs invalides → défaut, 0 conservé (illimité)", () => {
    expect(sanitizeStreamSilenceTimeoutMs(undefined)).toBe(DEFAULT_STREAM_SILENCE_TIMEOUT_MS);
    expect(sanitizeStreamSilenceTimeoutMs("abc")).toBe(DEFAULT_STREAM_SILENCE_TIMEOUT_MS);
    expect(sanitizeStreamSilenceTimeoutMs(-1)).toBe(DEFAULT_STREAM_SILENCE_TIMEOUT_MS);
    expect(sanitizeStreamSilenceTimeoutMs(12.5)).toBe(DEFAULT_STREAM_SILENCE_TIMEOUT_MS);
    expect(sanitizeStreamSilenceTimeoutMs(MIN_STREAM_SILENCE_TIMEOUT_MS - 1)).toBe(
      DEFAULT_STREAM_SILENCE_TIMEOUT_MS,
    );
    expect(sanitizeStreamSilenceTimeoutMs(MAX_STREAM_SILENCE_TIMEOUT_MS + 1)).toBe(
      DEFAULT_STREAM_SILENCE_TIMEOUT_MS,
    );
    expect(sanitizeStreamSilenceTimeoutMs(0)).toBe(0);
    expect(sanitizeStreamSilenceTimeoutMs(1_800_000)).toBe(1_800_000);
  });

  it("garde-fou : invalide → 0 (désactivé)", () => {
    expect(sanitizeAgentHardTimeoutMs(undefined)).toBe(0);
    expect(sanitizeAgentHardTimeoutMs(-5)).toBe(0);
    expect(sanitizeAgentHardTimeoutMs("x")).toBe(0);
    expect(sanitizeAgentHardTimeoutMs(0)).toBe(0);
    expect(sanitizeAgentHardTimeoutMs(7_200_000)).toBe(7_200_000);
  });
});

describe("messages honnêtes", () => {
  it("le motif de silence est explicite et reconnu", () => {
    const msg = streamSilenceMessage("Exécution", 900_000);
    expect(msg).toContain("flux silencieux");
    expect(msg).toContain("15 min");
    expect(isSilenceTimeoutMessage(msg)).toBe(true);
  });

  it("le motif du garde-fou est reconnu", () => {
    const msg = hardTimeoutMessage("Exécution", 3_600_000);
    expect(isHardTimeoutMessage(msg)).toBe(true);
    expect(isSilenceTimeoutMessage(msg)).toBe(false);
  });

  it("formatDurationMs", () => {
    expect(formatDurationMs(42_000)).toBe("42s");
    expect(formatDurationMs(7 * 60_000)).toBe("7 min");
    expect(formatDurationMs(65 * 60_000)).toBe("1 h 05 min");
  });
});

describe("propagation de la config (manager + pont globalThis)", () => {
  const original = concurrencyManager.getConfig();
  afterEach(() => {
    concurrencyManager.setConfig(original);
  });

  it("setConfig normalise puis publie via le pont des extensions", () => {
    concurrencyManager.setConfig({ streamSilenceTimeoutMs: -42, agentHardTimeoutMs: 999_999_999 });
    // Valeur invalide → défaut ; garde-fou hors bornes → désactivé.
    expect(concurrencyManager.getStreamSilenceTimeoutMs()).toBe(DEFAULT_STREAM_SILENCE_TIMEOUT_MS);
    expect(concurrencyManager.getAgentHardTimeoutMs()).toBe(0);

    const bridge = (globalThis as any)[CONCURRENCY_BRIDGE_KEY];
    expect(typeof bridge.getStreamSilenceTimeoutMs).toBe("function");
    expect(bridge.getStreamSilenceTimeoutMs()).toBe(DEFAULT_STREAM_SILENCE_TIMEOUT_MS);
    expect(bridge.getAgentHardTimeoutMs()).toBe(0);

    concurrencyManager.setConfig({ streamSilenceTimeoutMs: 600_000, agentHardTimeoutMs: 3_600_000 });
    expect(bridge.getStreamSilenceTimeoutMs()).toBe(600_000);
    expect(bridge.getAgentHardTimeoutMs()).toBe(3_600_000);
  });
});
