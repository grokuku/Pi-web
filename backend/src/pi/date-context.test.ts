import { describe, it, expect } from "vitest";
import {
  DATE_CONTEXT_CUSTOM_TYPE,
  buildDateContextContent,
  buildDateContextMessage,
  dateContextDeliveryOptions,
  formatCompactDateTime,
  isValidTimeZone,
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

  it("formate le repère dans la zone du navigateur transmise (format inchangé)", () => {
    // Format `[horodatage] YYYY-MM-DD HH:mm (heure locale)` STRICTEMENT conservé
    // (des prompts/agents peuvent en dépendre) ; seule la zone change.
    const msg = buildDateContextMessage(new Date("2026-10-21T05:03:00Z"), "Europe/Paris");
    expect(msg.content).toBe("[horodatage] 2026-10-21 07:03 (heure locale)");
    expect(msg.display).toBe(false);
  });

  it("customType hors liste des messages non conversationnels (donc VU par le LLM)", () => {
    // Garde-fou : le type ne doit pas être capté par le filtre d'affichage seul.
    expect(DATE_CONTEXT_CUSTOM_TYPE).not.toBe("subagent_activity");
  });
});

describe("formatCompactDateTime — heure locale de l'UTILISATEUR (timeZone)", () => {
  // ⚠️ Le process de test (comme le conteneur de production) tourne en UTC.
  // Instants exprimés en UTC, attendus exprimés dans la zone de l'utilisateur.
  const INSTANT = new Date("2026-10-21T05:03:00Z");

  it("reproduit le bug historique : le calcul serveur (UTC) est décalé de 2 h en été", () => {
    // Ancien comportement = getters locaux du process, soit UTC ici : 05:03.
    const serverLocal = formatCompactDateTime(INSTANT, "UTC");
    // Heure réellement vue par l'utilisateur à Paris (CEST = UTC+2) : 07:03.
    const userLocal = formatCompactDateTime(INSTANT, "Europe/Paris");
    expect(serverLocal).toBe("2026-10-21 05:03");
    expect(userLocal).toBe("2026-10-21 07:03");
    expect(serverLocal).not.toBe(userLocal);
  });

  it("Europe/Paris — heure d'été (CEST, UTC+2)", () => {
    expect(formatCompactDateTime(new Date("2026-07-15T05:03:00Z"), "Europe/Paris")).toBe(
      "2026-07-15 07:03",
    );
  });

  it("Europe/Paris — heure d'hiver (CET, UTC+1)", () => {
    expect(formatCompactDateTime(new Date("2026-01-15T05:03:00Z"), "Europe/Paris")).toBe(
      "2026-01-15 06:03",
    );
  });

  it("Europe/Paris — jour du passage à l'heure d'été (2026-03-29) : +1 puis +2", () => {
    // Bascule à 01:00 UTC : 02:00 → 03:00 locales.
    expect(formatCompactDateTime(new Date("2026-03-29T00:30:00Z"), "Europe/Paris")).toBe(
      "2026-03-29 01:30",
    );
    expect(formatCompactDateTime(new Date("2026-03-29T01:30:00Z"), "Europe/Paris")).toBe(
      "2026-03-29 03:30",
    );
  });

  it("Europe/Paris — jour du retour à l'heure d'hiver (2026-10-25) : +2 puis +1", () => {
    // Bascule à 01:00 UTC : 03:00 → 02:00 locales.
    expect(formatCompactDateTime(new Date("2026-10-25T00:30:00Z"), "Europe/Paris")).toBe(
      "2026-10-25 02:30",
    );
    expect(formatCompactDateTime(new Date("2026-10-25T01:30:00Z"), "Europe/Paris")).toBe(
      "2026-10-25 02:30",
    );
  });

  it("minuit dans une zone décalée → '00:00' (jamais '24:00')", () => {
    expect(formatCompactDateTime(new Date("2026-12-31T23:00:00Z"), "Europe/Paris")).toBe(
      "2027-01-01 00:00",
    );
  });

  it("utilisateur dans un autre fuseau (Asia/Tokyo, UTC+9)", () => {
    expect(formatCompactDateTime(INSTANT, "Asia/Tokyo")).toBe("2026-10-21 14:03");
  });

  it("zone absente ou invalide → repli sur le fuseau du process, sans exception", () => {
    const d = new Date(2026, 9, 4, 14, 32);
    expect(formatCompactDateTime(d, undefined)).toBe("2026-10-04 14:32");
    expect(formatCompactDateTime(d, null)).toBe("2026-10-04 14:32");
    expect(formatCompactDateTime(d, "Pas/UneZone")).toBe("2026-10-04 14:32");
    expect(formatCompactDateTime(d, "  ")).toBe("2026-10-04 14:32");
  });
});

describe("isValidTimeZone", () => {
  it("accepte une zone IANA", () => {
    expect(isValidTimeZone("Europe/Paris")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("refuse tout le reste (type, vide, zone inconnue)", () => {
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidTimeZone(2)).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("Europe/Paris2")).toBe(false);
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
