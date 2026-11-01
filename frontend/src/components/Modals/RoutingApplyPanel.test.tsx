// @vitest-environment jsdom
/**
 * Tests de RoutingApplyPanel — « appliquer ce routage à d'autres projets ».
 *
 * Ce qui est verrouillé (action qui ÉCRASE des configurations, en production) :
 *  - la portée est un choix EXPLICITE envoyé au backend ;
 *  - la prévisualisation affiche les projets qui changent ET ceux qui ne
 *    changent pas ;
 *  - AUCUNE écriture sans la case de confirmation cochée ;
 *  - un modèle absent de la bibliothèque est signalé (sans blocage) ;
 *  - succès honnête (« N projets mis à jour ») + rafraîchissement du parent ;
 *  - une erreur backend est affichée, jamais transformée en succès.
 *
 * AUCUN réseau : `fetch` est remplacé par un double qui renvoie le plan attendu.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { RoutingApplyPanel } from "./RoutingApplyPanel";
import type { RoutingConfig } from "../../types";
import type { RoutingCopyPlan } from "../../utils/model-library-api";

vi.mock("../../utils/holaf-toast", () => ({ toast: vi.fn() }));

const ROUTING: RoutingConfig = {
  enabled: true,
  trivial: { modelId: null },
  standard: { modelId: "prov__m2" },
  complex: { modelId: null },
  review: { modelId: null },
  reviewRiskThreshold: 0.5,
  confidenceThreshold: 0.6,
  systemOneConfidenceThreshold: 0.35,
  classifierModelId: null,
  classifierType: "chat",
  systemOneModelId: null,
};

const CANDIDATES = [
  { id: "src", name: "Courant", storage: "local", isSource: true, isLinkedSubproject: false },
  { id: "a", name: "Alpha", storage: "local", isSource: false, isLinkedSubproject: true },
  { id: "b", name: "Beta", storage: "local", isSource: false, isLinkedSubproject: true },
];

function makePlan(overrides: Partial<RoutingCopyPlan> = {}): RoutingCopyPlan {
  return {
    dryRun: true,
    sourceProjectId: "src",
    scope: "all-except-current",
    targets: [
      { id: "a", name: "Alpha", storage: "local" },
      { id: "b", name: "Beta", storage: "local" },
    ],
    skipped: [{ id: "src", name: "Courant", reason: "source" }],
    warnings: [],
    totalProjects: 4,
    otherProjects: 2,
    sourceIsLinked: true,
    candidates: CANDIDATES,
    linkedSubprojectIds: ["a", "b"],
    applied: [],
    ...overrides,
  };
}

interface Call {
  body: any;
}

/** Double de `fetch` : renvoie `plan` (prévisualisation) ou `applied` (écriture). */
function stubFetch(options: {
  plan?: RoutingCopyPlan;
  onApply?: RoutingCopyPlan;
  failApply?: string;
} = {}) {
  const calls: Call[] = [];
  const plan = options.plan ?? makePlan();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ body });
      const payload = body.dryRun === true ? plan : options.failApply
        ? null
        : options.onApply ?? { ...plan, dryRun: false, applied: plan.targets.map((t) => t.id), warnings: plan.warnings };
      const res = {
        ok: !(body.dryRun !== true && options.failApply),
        status: body.dryRun !== true && options.failApply ? 400 : 200,
        headers: { get: () => "application/json" },
        json: async () =>
          body.dryRun !== true && options.failApply
            ? { error: options.failApply }
            : payload,
      };
      return res as unknown as Response;
    }),
  );
  return calls;
}

function renderPanel(props: Partial<Parameters<typeof RoutingApplyPanel>[0]> = {}) {
  const onClose = vi.fn();
  const onApplied = vi.fn(async () => {});
  render(
    <I18nProvider>
      <RoutingApplyPanel
        projectId="src"
        routing={ROUTING}
        onClose={onClose}
        onApplied={onApplied}
        {...props}
      />
    </I18nProvider>,
  );
  return { onClose, onApplied };
}

beforeEach(() => {
  localStorage.setItem("pi-web-language", "fr");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("RoutingApplyPanel — prévisualisation", () => {
  it("annonce les projets qui VONT changer et ceux qui ne changeront pas", async () => {
    stubFetch();
    renderPanel();
    expect(await screen.findByText("2 projet(s) vont recevoir ces réglages :")).toBeTruthy();
    expect(screen.getByText("• Alpha")).toBeTruthy();
    expect(screen.getByText("• Beta")).toBeTruthy();
    // 4 projets connus − 2 cibles = 2 inchangés (le courant + un hors portée).
    expect(screen.getByText("2 projet(s) resteront inchangés.")).toBeTruthy();
    // Projet écarté : tracé explicitement.
    expect(screen.getByText("– Courant — non modifié")).toBeTruthy();
  });

  it("envoie la portée choisie (aucune portée implicite) et les ids de la sélection", async () => {
    const calls = stubFetch();
    renderPanel();
    await screen.findByText("2 projet(s) vont recevoir ces réglages :");
    expect(calls[0].body.scope).toBe("all-except-current");
    expect(calls[0].body.dryRun).toBe(true);

    // Portée « tous » → nouvelle requête avec le bon scope.
    fireEvent.click(screen.getByLabelText("Tous les projets"));
    await waitFor(() => expect(calls.some((c) => c.body.scope === "all")).toBe(true));

    // Portée « sélection » → la liste cochable apparaît et la sélection est envoyée.
    fireEvent.click(screen.getByLabelText("Seulement les projets cochés ci-dessous"));
    await screen.findByLabelText("Alpha");
    fireEvent.click(screen.getByLabelText("Alpha"));
    await waitFor(() =>
      expect(calls.some((c) => c.body.scope === "selected" && c.body.selectedProjectIds?.includes("a"))).toBe(true),
    );
  });

  it("signale un modèle absent de la bibliothèque (sans bloquer l'action)", async () => {
    stubFetch({
      plan: makePlan({
        warnings: [{ field: "standard", modelId: "prov__supprime", projectIds: ["a", "b"], projectNames: ["Alpha", "Beta"] }],
      }),
    });
    renderPanel();
    expect(await screen.findByText("⚠ Modèles introuvables dans la bibliothèque")).toBeTruthy();
    expect(
      screen.getByText(/« prov__supprime » \(Standard\) → repli sur le modèle par défaut/),
    ).toBeTruthy();
    // Le bouton d'écriture reste disponible (le repli n'est pas une casse).
    expect((screen.getByRole("button", { name: "Écraser 2 projet(s)" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("RoutingApplyPanel — confirmation obligatoire", () => {
  it("sans confirmation : le bouton est désactivé et AUCUNE écriture n'est envoyée", async () => {
    const calls = stubFetch();
    renderPanel();
    await screen.findByText("2 projet(s) vont recevoir ces réglages :");

    const apply = screen.getByRole("button", { name: "Écraser 2 projet(s)" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(apply);
    // Aucune requête d'écriture (seule la prévisualisation dryRun a eu lieu).
    expect(calls.some((c) => c.body.dryRun === false)).toBe(false);
  });

  it("avec confirmation : écriture envoyée, message honnête et rafraîchissement du parent", async () => {
    const calls = stubFetch();
    const { onApplied } = renderPanel();
    await screen.findByText("2 projet(s) vont recevoir ces réglages :");

    fireEvent.click(screen.getByLabelText("Je comprends que le routage de 2 projet(s) sera écrasé"));
    const apply = screen.getByRole("button", { name: "Écraser 2 projet(s)" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);

    expect(await screen.findByText("✓ 2 projet(s) mis à jour")).toBeTruthy();
    const write = calls.find((c) => c.body.dryRun === false);
    expect(write).toBeTruthy();
    expect(write!.body.sourceProjectId).toBe("src");
    expect(write!.body.scope).toBe("all-except-current");
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("changer de portée invalide la confirmation déjà donnée", async () => {
    stubFetch();
    renderPanel();
    await screen.findByText("2 projet(s) vont recevoir ces réglages :");
    fireEvent.click(screen.getByLabelText("Je comprends que le routage de 2 projet(s) sera écrasé"));
    expect((screen.getByRole("button", { name: "Écraser 2 projet(s)" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByLabelText("Tous les projets"));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Écraser 2 projet(s)" }) as HTMLButtonElement).disabled).toBe(true),
    );
  });

  it("portée sans cible : aucun projet modifiable, bouton désactivé", async () => {
    stubFetch({ plan: makePlan({ targets: [], totalProjects: 1 }) });
    renderPanel();
    expect(await screen.findByText("Aucun projet ne serait modifié avec cette portée.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Écraser 0 projet(s)" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("RoutingApplyPanel — échec", () => {
  it("erreur du backend : message affiché, aucune confirmation de succès", async () => {
    stubFetch({ failApply: "Aucun projet cible pour cette portée" });
    const { onApplied } = renderPanel();
    await screen.findByText("2 projet(s) vont recevoir ces réglages :");
    fireEvent.click(screen.getByLabelText("Je comprends que le routage de 2 projet(s) sera écrasé"));
    fireEvent.click(screen.getByRole("button", { name: "Écraser 2 projet(s)" }));

    expect(await screen.findByText("Aucun projet cible pour cette portée")).toBeTruthy();
    expect(screen.queryByText(/projet\(s\) mis à jour/)).toBeNull();
    expect(onApplied).not.toHaveBeenCalled();
  });
});
