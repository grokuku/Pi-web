// @vitest-environment jsdom
/**
 * StatusBar — indicateur de taille du contexte.
 *
 * Défaut corrigé : après une compaction, l'indicateur restait figé sur la
 * valeur du tour précédent (le SDK renvoie `contextUsage.tokens = null` et le
 * front ignorait cette mise à jour). Il doit désormais afficher un état
 * HONNÊTE (« compacté — taille exacte au prochain message ») jusqu'à la mesure
 * réelle du tour suivant, et continuer à se mettre à jour normalement hors
 * compaction.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { StatusBar } from "./StatusBar";
import type { ContextStats } from "../../utils/context-usage";

const SESSION = { model: { name: "DeepSeek V4.1", contextWindow: 1048576 }, thinkingLevel: "off" };

function renderBar(stats: ContextStats | null) {
  return render(
    <I18nProvider>
      <StatusBar
        activeProject={null}
        isStreaming={false}
        stats={stats}
        session={SESSION}
        connected
        activeMode="code"
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.setItem("pi-web-language", "fr");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("StatusBar — taille du contexte", () => {
  it("affiche la mesure réelle hors compaction (non-régression)", () => {
    renderBar({ tokens: 42000, contextPercent: 4, totalTokens: 1000 });
    expect(screen.getByText("ctx 42.0K")).toBeTruthy();
    expect(screen.getByText("4%")).toBeTruthy();
    expect(screen.getByText("/1M")).toBeTruthy();
  });

  it("après compaction : plus d'ancienne valeur, état explicite « compacté »", () => {
    renderBar({ tokens: null, contextPercent: null, totalTokens: 1000 });
    expect(screen.queryByText("ctx 649.6K")).toBeNull();
    expect(screen.queryByText(/^ctx \d/)).toBeNull();
    const label = screen.getByText("ctx — compacté");
    expect(label).toBeTruthy();
    // Le titre explique POURQUOI la valeur est absente (prochain message).
    expect(label.getAttribute("title")).toContain("prochain message");
    // Aucun pourcentage inventé.
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("retrouve un nombre réel dès que le tour suivant fournit la mesure", () => {
    const { rerender } = renderBar({ tokens: null, contextPercent: null, totalTokens: 1000 });
    expect(screen.getByText("ctx — compacté")).toBeTruthy();
    rerender(
      <I18nProvider>
        <StatusBar
          activeProject={null}
          isStreaming={false}
          stats={{ tokens: 18500, contextPercent: 2, totalTokens: 1000 }}
          session={SESSION}
          connected
          activeMode="code"
        />
      </I18nProvider>,
    );
    expect(screen.queryByText("ctx — compacté")).toBeNull();
    expect(screen.getByText("ctx 18.5K")).toBeTruthy();
  });
});
