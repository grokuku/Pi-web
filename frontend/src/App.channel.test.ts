/**
 * F15 / F16 — contrat de source d'App.tsx (les invariants ne sont pas
 * observables sans monter le composant complet, qui ouvre une WebSocket réelle).
 *
 *  F15 : le canal `BroadcastChannel('pi-web-file-ref')` était fermé puis
 *        rouvert à chaque changement de panneau (`savePanels` recréée à chaque
 *        rendu, `panels` en dépendance de l'effet) — fenêtre de perte de
 *        message inter-onglets. L'effet doit désormais avoir des dépendances
 *        VIDES et les setters de panneaux doivent être stables (`useCallback`).
 *  F16 : `on("terminal_data", () => {})` — abonnement vide conservé toute la
 *        vie de l'app et appelé à chaque frame terminal. Il doit avoir disparu
 *        d'App.tsx (TerminalView garde le sien).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("App.tsx — F15 BroadcastChannel créé une seule fois", () => {
  it("l'effet qui crée le canal n'a AUCUNE dépendance (pas de fermeture/rouverture)", () => {
    const match = source.match(/useEffect\(\(\) => \{\s*const channel = new BroadcastChannel\('pi-web-file-ref'\);[\s\S]*?\}, ([^)]*)\);/);
    expect(match, "effet BroadcastChannel introuvable dans App.tsx").not.toBeNull();
    const deps = (match?.[1] ?? "").trim();
    expect(deps, `dépendances de l'effet BroadcastChannel : ${deps}`).toBe("[]");
  });

  it("les setters de panneaux sont stables (useCallback), plus de fonction recréée à chaque rendu", () => {
    expect(source).toMatch(/const persistPanels = useCallback\(/);
    expect(source).toMatch(/const updatePanel = useCallback\(/);
    expect(source).toMatch(/const togglePanel = useCallback\(/);
    // Plus aucune affectation directe du type `const togglePanel = (id: …`
    expect(source).not.toMatch(/const togglePanel = \(id:/);
  });
});

describe("App.tsx — F16 abonnement WebSocket vide supprimé", () => {
  it("ne s'abonne plus à terminal_data", () => {
    expect(source).not.toMatch(/on\("terminal_data"/);
  });

  it("ne référence plus un unsubTerm orphelin", () => {
    expect(source).not.toMatch(/unsubTerm/);
  });
});
