// ── Tests unitaires : décision de pin du scroll du chat ─────────────────────
// Couvre le correctif de décrochage automatique : le fil suit toute CROISSANCE
// tant qu'on est (ou revient) en bas, ne décroche QUE sur un geste utilisateur
// franc vers le haut, et n'entraîne jamais de scroll en boucle.
import { describe, it, expect } from "vitest";
import {
  resolveScrollAction,
  isNearBottom,
  BOTTOM_PROXIMITY_PX,
  USER_SCROLL_UP_PX,
  type ScrollState,
} from "./chat-scroll";

/** Raccourci : état collé exactement en bas. */
function atBottomState(overrides: Partial<ScrollState> = {}): ScrollState {
  return { distanceFromBottom: 0, scrollDelta: 0, wasPinned: true, ...overrides };
}

describe("isNearBottom", () => {
  it("vrai strictement sous le seuil", () => {
    expect(isNearBottom(0)).toBe(true);
    expect(isNearBottom(BOTTOM_PROXIMITY_PX - 1)).toBe(true);
  });
  it("faux au seuil et au-delà", () => {
    expect(isNearBottom(BOTTOM_PROXIMITY_PX)).toBe(false);
    expect(isNearBottom(BOTTOM_PROXIMITY_PX + 1)).toBe(false);
  });
});

describe("resolveScrollAction — croissance de contenu (« growth »)", () => {
  it("collé en bas : suit et repositionne", () => {
    // Le wrapper vient de grandir de 600 px (ex. mur de colonnes sous-agents).
    const d = resolveScrollAction(atBottomState({ distanceFromBottom: 600 }), "growth");
    expect(d.pinned).toBe(true);
    expect(d.follow).toBe(true);
    expect(d.showButton).toBe(false);
    expect(d.clearUnread).toBe(false);
  });

  it("déjà exactement au fond : ne re-scrolle pas (pas de boucle)", () => {
    const d = resolveScrollAction(atBottomState({ distanceFromBottom: 0 }), "growth");
    expect(d.pinned).toBe(true);
    expect(d.follow).toBe(false); // suivi conservé mais aucun scroll inutile
  });

  it("utilisateur en haut (décroché) : ne suit JAMAIS, aucune prise de scroll", () => {
    const d = resolveScrollAction(
      { distanceFromBottom: 900, scrollDelta: 0, wasPinned: false },
      "growth",
    );
    expect(d.pinned).toBe(false);
    expect(d.follow).toBe(false);
    expect(d.showButton).toBe(true);
  });

  it("croissance pendant un dépliage au-dessus du curseur : le pin tient", () => {
    // L'auto-dépli ajoute ~400 px ; la distance dépasse le seuil mais on était
    // collé → on suit (le pin ne doit pas être perdu par la croissance).
    const d = resolveScrollAction(atBottomState({ distanceFromBottom: 400 }), "growth");
    expect(d.pinned).toBe(true);
    expect(d.follow).toBe(true);
  });

  it("juste au-dessus du seuil mais collé : reste pinné", () => {
    const d = resolveScrollAction(
      atBottomState({ distanceFromBottom: BOTTOM_PROXIMITY_PX + 1 }),
      "growth",
    );
    expect(d.pinned).toBe(true);
    expect(d.follow).toBe(true);
  });
});

describe("resolveScrollAction — scroll utilisateur (« scroll »)", () => {
  it("geste franc vers le haut : décroche et affiche le bouton", () => {
    const d = resolveScrollAction(
      { distanceFromBottom: 300, scrollDelta: 120, wasPinned: true },
      "scroll",
    );
    expect(d.pinned).toBe(false);
    expect(d.follow).toBe(false);
    expect(d.showButton).toBe(true);
  });

  it("mouvement ambigu (ancrage navigateur / pin en cours) : CONSERVE le pin", () => {
    const d = resolveScrollAction(
      { distanceFromBottom: 80, scrollDelta: USER_SCROLL_UP_PX, wasPinned: true },
      "scroll",
    );
    expect(d.pinned).toBe(true);
    expect(d.showButton).toBe(false);
  });

  it("scroll vers le bas (delta négatif) : conserve le pin", () => {
    const d = resolveScrollAction(
      { distanceFromBottom: 30, scrollDelta: -200, wasPinned: true },
      "scroll",
    );
    expect(d.pinned).toBe(true);
    expect(d.clearUnread).toBe(true);
  });

  it("retour en bas : réarme et remet les non-lus à zéro", () => {
    const d = resolveScrollAction(
      { distanceFromBottom: 0, scrollDelta: -50, wasPinned: false },
      "scroll",
    );
    expect(d.pinned).toBe(true);
    expect(d.follow).toBe(false); // le scroll utilisateur atteint déjà le bas
    expect(d.showButton).toBe(false);
    expect(d.clearUnread).toBe(true);
  });

  it("déjà décroché et toujours en haut : reste décroché", () => {
    const d = resolveScrollAction(
      { distanceFromBottom: 500, scrollDelta: 0, wasPinned: false },
      "scroll",
    );
    expect(d.pinned).toBe(false);
    expect(d.showButton).toBe(true);
  });

  it("un scroll ne déclenche jamais de repositionnement programmatique", () => {
    const d = resolveScrollAction(
      { distanceFromBottom: 700, scrollDelta: -5, wasPinned: true },
      "scroll",
    );
    expect(d.follow).toBe(false);
  });
});

describe("resolveScrollAction — seuils configurables", () => {
  it("respecte un seuil de proximité personnalisé", () => {
    const d = resolveScrollAction(
      { distanceFromBottom: 100, scrollDelta: 0, wasPinned: false },
      "scroll",
      { proximityPx: 150 },
    );
    expect(d.pinned).toBe(true);
    expect(d.clearUnread).toBe(true);
  });

  it("respecte un seuil de geste vers le haut personnalisé", () => {
    const d = resolveScrollAction(
      { distanceFromBottom: 300, scrollDelta: 40, wasPinned: true },
      "scroll",
      { userScrollUpPx: 50 },
    );
    expect(d.pinned).toBe(true); // 40 <= 50 → ambigu → conserve
  });
});
