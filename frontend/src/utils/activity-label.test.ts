// ── Tests : décision/libellés d'activité (ligne d'état + StatusBar) ─────────
// Fonctions PURES : cas « délégation en cours » (session principale muette),
// session au repos (rien ne doit s'afficher), pastille « stalled » et libellés
// fr/en (parité).
import { describe, expect, it } from "vitest";
import { getT } from "../i18n";
import {
  activityPhaseLabel,
  resolveActivityDisplay,
  type ActivityInput,
} from "./activity-label";

const fr = getT("fr");
const en = getT("en");

/** Base « session au repos ». */
function base(over: Partial<ActivityInput> = {}): ActivityInput {
  return { activity: null, isStreaming: false, streamingStalled: false, subAgentActive: false, ...over };
}

describe("resolveActivityDisplay — visibilité", () => {
  it("session au repos → indicateur masqué", () => {
    expect(resolveActivityDisplay(base(), fr).visible).toBe(false);
    expect(resolveActivityDisplay(base(), en).visible).toBe(false);
  });

  it("run principal en streaming sans activité fine → « En cours… »", () => {
    const d = resolveActivityDisplay(base({ isStreaming: true }), fr);
    expect(d).toMatchObject({ visible: true, kind: "busy", label: "En cours…" });
    expect(resolveActivityDisplay(base({ isStreaming: true }), en).label).toBe("In progress…");
  });

  it("DÉLÉGATION sans événement de texte (isStreaming absent, batch harness) → visible et honnête", () => {
    // Cas réel : la session principale est bloquée sur l'appel `delegate` (ou
    // pas en streaming) ; le store sous-agents est la source de vérité.
    const d = resolveActivityDisplay(base({ subAgentActive: true }), fr);
    expect(d).toMatchObject({ visible: true, kind: "busy", label: "Délégation en cours…" });
    expect(resolveActivityDisplay(base({ subAgentActive: true }), en).label).toBe(
      "Delegation in progress…",
    );
  });

  it("délégation active → priorité au libellé de délégation sur l'activité fine", () => {
    const d = resolveActivityDisplay(
      base({ isStreaming: true, subAgentActive: true, activity: { type: "thinking" } }),
      fr,
    );
    expect(d.label).toBe("Délégation en cours…");
  });

  it("délégation active → jamais « stalled » (le sous-agent travaille)", () => {
    const d = resolveActivityDisplay(
      base({ isStreaming: true, streamingStalled: true, subAgentActive: true }),
      fr,
    );
    expect(d.kind).toBe("busy");
    expect(d.label).toBe("Délégation en cours…");
  });

  it("run principal silencieux au-delà du seuil → « stalled » explicite", () => {
    const d = resolveActivityDisplay(base({ isStreaming: true, streamingStalled: true }), fr);
    expect(d.kind).toBe("stalled");
    expect(d.label).toBe("sans activité depuis 60 s");
    expect(resolveActivityDisplay(base({ isStreaming: true, streamingStalled: true }), en).label).toBe(
      "no activity for 60s",
    );
  });

  it("fr/en : libellés de délégation et de stalled distincts et non vides (parité)", () => {
    for (const key of ["activity.delegating", "activity.stalled", "activity.stalledTooltip"] as const) {
      expect(fr(key).length).toBeGreaterThan(0);
      expect(en(key).length).toBeGreaterThan(0);
    }
    expect(fr("activity.delegating")).not.toBe(en("activity.delegating"));
    expect(fr("activity.stalled")).not.toBe(en("activity.stalled"));
  });
});

describe("activityPhaseLabel — phases du run principal", () => {
  it("réflexion / outil / génération", () => {
    expect(activityPhaseLabel({ type: "thinking" }, fr)).toBe("En réflexion…");
    expect(activityPhaseLabel({ type: "tool", toolName: "bash" }, fr)).toBe("Exécute un outil…");
    expect(activityPhaseLabel({ type: "generating" }, fr)).toBe("Génère la réponse…");
    expect(activityPhaseLabel({ type: "thinking" }, en)).toBe("Thinking…");
    expect(activityPhaseLabel({ type: "tool" }, en)).toBe("Running a tool…");
    expect(activityPhaseLabel({ type: "generating" }, en)).toBe("Generating response…");
  });

  it("routage : préfixe + fonction, repli « En cours… » sans fonction", () => {
    expect(activityPhaseLabel({ type: "routing", routingFunction: "execute" }, fr)).toBe(
      "Routage : Exécution",
    );
    expect(activityPhaseLabel({ type: "routing", routingFunction: "review" }, en)).toBe(
      "Routing: Reviewing",
    );
    expect(activityPhaseLabel({ type: "routing" }, fr)).toBe("Routage : En cours…");
  });

  it("activité absente → libellé générique", () => {
    expect(activityPhaseLabel(null, fr)).toBe("En cours…");
    expect(activityPhaseLabel(undefined, en)).toBe("In progress…");
  });
});
