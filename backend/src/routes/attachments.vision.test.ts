/**
 * Tests unitaires de la résolution du modèle vision (getVisionModelInfo +
 * getVisionSetupHint) — bug « No vision model configured » alors que des
 * modèles vision-capables existent dans la model library.
 *
 * Cause racine testée : visionModelId === null devait, selon le contrat
 * documenté (« null = use default or fallback », UI « None (use main model) »),
 * retomber sur le modèle par défaut s'il a la vision, sinon sur le premier
 * modèle vision-capable. L'implémentation retournait null immédiatement.
 *
 * Les I/O disque (model-library.json, providers.json, ~/.pi/agent/models.json)
 * sont mockées : aucun test ne dépend de la config réelle de la machine.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RegisteredModel } from "../pi/model-library.js";

// ── Mocks des modules de config (avant import du module testé) ──
// resolveModelCapability : on réimplémente la règle exacte (l'override manuel
// prime sur le champ inféré) pour rester indépendant du disque.
vi.mock("../pi/model-library.js", () => ({
  loadModelLibrary: vi.fn(),
  resolveModelCapability: (m: any, cap: "vision" | "audio"): boolean => {
    if (cap === "vision") {
      if (m.visionOverride === "yes") return true;
      if (m.visionOverride === "no") return false;
      return m.vision === true;
    }
    if (m.audioOverride === "yes") return true;
    if (m.audioOverride === "no") return false;
    return m.audio === true;
  },
}));

vi.mock("../pi/providers.js", () => ({
  loadProviders: vi.fn(),
}));

// Homedir inexistant : le fallback ~/.pi/agent/models.json de getVisionModelInfo
// ne doit JAMAS lire la config réelle de la machine (tests déterministes).
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const mockOs = { ...actual, homedir: () => "/nonexistent-pi-web-vision-test" };
  return { ...actual, default: mockOs };
});

import { getVisionModelInfo, getVisionSetupHint } from "./attachments.js";
import { loadModelLibrary } from "../pi/model-library.js";
import { loadProviders } from "../pi/providers.js";

// ── Fabriques ──
function makeModel(id: string, overrides: Partial<RegisteredModel> = {}): RegisteredModel {
  return {
    id,
    providerId: "prov1",
    modelId: id,
    name: id,
    isDefault: false,
    reasoning: false,
    vision: false,
    contextWindow: 128000,
    maxTokens: 16384,
    thinkingLevel: "medium",
    ...overrides,
  };
}

const PROV = { id: "prov1", apiKey: "sk-test", baseUrl: "https://prov1.example/v1" };

function mockLibrary(models: RegisteredModel[], visionModelId: string | null, defaultModelId: string | null) {
  (loadModelLibrary as ReturnType<typeof vi.fn>).mockReturnValue({
    models,
    visionModelId,
    defaultModelId,
  });
  (loadProviders as ReturnType<typeof vi.fn>).mockReturnValue([PROV]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getVisionModelInfo — fallback documenté (visionModelId null)", () => {
  it("visionModelId null + modèle par défaut vision=true → fallback sur le défaut", () => {
    const main = makeModel("main", { vision: true });
    mockLibrary([main], null, "main");

    const info = getVisionModelInfo();
    expect(info).not.toBeNull();
    expect(info?.modelId).toBe("main");
    expect(info?.apiKey).toBe("sk-test");
  });

  it("visionModelId null + défaut sans vision → fallback sur le premier vision-capable", () => {
    // Reproduction exacte du cas du user : défaut = deepseek sans vision,
    // mais 3 modèles vision=true existent dans la library.
    const deepseek = makeModel("deepseek-v4-flash", { vision: false });
    const gemma = makeModel("gemma4:31b", { vision: true });
    const kimi = makeModel("kimi-k3", { vision: true });
    mockLibrary([deepseek, gemma, kimi], null, "deepseek-v4-flash");

    const info = getVisionModelInfo();
    expect(info).not.toBeNull();
    expect(info?.modelId).toBe("gemma4:31b");
  });

  it("visionModelId null + visionOverride='no' → l'override prime, aucun fallback", () => {
    const only = makeModel("glm5", { vision: true, visionOverride: "no" });
    mockLibrary([only], null, "glm5");

    expect(getVisionModelInfo()).toBeNull();
  });

  it("visionModelId null + library sans aucun modèle vision → null", () => {
    mockLibrary([makeModel("deepseek", { vision: false })], null, "deepseek");

    expect(getVisionModelInfo()).toBeNull();
    // Ne doit pas retomber sur ~/.pi/agent/models.json avec un id null.
    expect(getVisionSetupHint()).toContain("No vision-capable model exists");
  });
});

describe("getVisionModelInfo — visionModelId explicite (comportement inchangé)", () => {
  it("visionModelId résolvable dans la library → ce modèle est utilisé", () => {
    const a = makeModel("a", { vision: true });
    const b = makeModel("b", { vision: true, providerId: "prov1" });
    mockLibrary([a, b], "b", "a");

    const info = getVisionModelInfo();
    expect(info?.modelId).toBe("b");
  });

  it("visionModelId pointant un modèle disparu + rien dans models.json → null", () => {
    const a = makeModel("a", { vision: true });
    mockLibrary([a], "ghost__nope", "a");

    expect(getVisionModelInfo()).toBeNull();
    // Le hint explique que la sélection est obsolète (garde-fou anti-message générique).
    expect(getVisionSetupHint()).toContain("no longer exists");
  });
});

describe("getVisionSetupHint — messages explicites", () => {
  it("liste les modèles vision quand la résolution provider échoue", () => {
    const gemma = makeModel("gemma4:31b", { vision: true });
    // Provider absent → la résolution du RegisteredModel échoue → null.
    mockLibrary([gemma], "gemma4:31b", "gemma4:31b");
    (loadProviders as ReturnType<typeof vi.fn>).mockReturnValue([]);

    expect(getVisionModelInfo()).toBeNull();
    expect(getVisionSetupHint()).toContain("vision-capable model(s) exist");
    expect(getVisionSetupHint()).toContain("gemma4:31b");
  });
});