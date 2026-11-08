import { afterEach, describe, expect, it, vi } from "vitest";
import { getT } from "./index";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("i18n — clé absente", () => {
  it("en production, affiche un repli lisible plutôt que le chemin brut et reste silencieux", () => {
    vi.stubEnv("DEV", false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(getT("en")("settings.general.concurrency.saveError.missing")).not.toContain("settings.general");
    expect(getT("en")("settings.unknown.saveError")).toBe("Save Error");
    expect(warn).not.toHaveBeenCalled();
  });

  it("en développement, signale la clé absente avec le garde-fou Vite", () => {
    vi.stubEnv("DEV", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(getT("en")("settings.unknown.saveError")).toBe("Save Error");
    expect(warn).toHaveBeenCalledWith('[i18n] Missing translation key: "settings.unknown.saveError" for lang "en"');
  });
});
