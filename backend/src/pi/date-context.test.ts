import { describe, it, expect } from "vitest";
import {
  DATE_CONTEXT_CUSTOM_TYPE,
  buildDateContextContent,
  buildDateContextMessage,
  dateContextDeliveryOptions,
  formatCompactDateTime,
} from "./date-context.js";

describe("formatCompactDateTime", () => {
  it("produit YYYY-MM-DD HH:mm en heure LOCALE", () => {
    // Date construite en local : les getters locaux doivent renvoyer ces valeurs
    // quel que soit le fuseau du process de test.
    const d = new Date(2026, 9, 4, 14, 32); // mois 9 = octobre
    expect(formatCompactDateTime(d)).toBe("2026-10-04 14:32");
  });

  it("zéro-pad mois, jour, heure et minute", () => {
    const d = new Date(2026, 0, 8, 9, 5); // 8 janvier, 09:05
    expect(formatCompactDateTime(d)).toBe("2026-01-08 09:05");
  });

  it("minuit et 23:59 sont correctement formatés", () => {
    expect(formatCompactDateTime(new Date(2026, 11, 31, 0, 0))).toBe("2026-12-31 00:00");
    expect(formatCompactDateTime(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31 23:59");
  });

  it("est triable lexicographiquement (ordre ISO année-mois-jour)", () => {
    const a = formatCompactDateTime(new Date(2026, 9, 4, 23, 59));
    const b = formatCompactDateTime(new Date(2026, 9, 5, 0, 0));
    expect(a < b).toBe(true);
  });
});

describe("buildDateContextContent / buildDateContextMessage", () => {
  it("le contenu contient la date compacte et un marqueur de métadonnées", () => {
    const d = new Date(2026, 9, 4, 14, 32);
    const content = buildDateContextContent(d);
    expect(content).toContain("2026-10-04 14:32");
    expect(content).toContain("[horodatage]");
  });

  it("le message est un custom display:false (jamais affiché à l'utilisateur)", () => {
    const msg = buildDateContextMessage(new Date(2026, 9, 4, 14, 32));
    expect(msg.customType).toBe(DATE_CONTEXT_CUSTOM_TYPE);
    expect(msg.display).toBe(false);
    expect(msg.content).toContain("2026-10-04 14:32");
  });

  it("customType hors liste des messages non conversationnels (donc VU par le LLM)", () => {
    // Garde-fou : le type ne doit pas être capté par le filtre d'affichage seul.
    expect(DATE_CONTEXT_CUSTOM_TYPE).not.toBe("subagent_activity");
  });
});

describe("dateContextDeliveryOptions", () => {
  it("session idle → triggerTurn:false (ajout sans déclencher de tour)", () => {
    expect(dateContextDeliveryOptions(false)).toEqual({ triggerTurn: false });
  });

  it("session en streaming → deliverAs:'steer' (injecté avec le steer utilisateur)", () => {
    expect(dateContextDeliveryOptions(true)).toEqual({ deliverAs: "steer" });
  });
});
