// @vitest-environment jsdom
// ── Rendu : outil indisponible dans le mode courant (SDK « Tool X not found ») ─
// Vérifie que la ligne d'outil affiche un libellé LISIBLE (i18n) à la place du
// brut, que l'erreur technique reste accessible dans le bloc déplié, que la
// détection s'applique à un message d'HISTORIQUE rechargé (isError perdu à la
// sérialisation backend) et qu'un résultat normal n'est pas affecté.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { ToolCallRow, ToolResultRow } from "./ChatView";
import type { DisplayMessage, ToolCallInfo } from "../../types";

function tc(overrides: Partial<ToolCallInfo>): ToolCallInfo {
  return {
    id: "t1",
    name: "bash",
    args: {},
    output: "",
    isError: false,
    isStreaming: false,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.setItem("pi-web-language", "en");
});

afterEach(() => {
  cleanup();
});

describe("ToolCallRow — outil indisponible (harness)", () => {
  it("affiche le libellé EN au lieu du brut, et garde le brut dans le bloc déplié", () => {
    render(
      <I18nProvider>
        <ToolCallRow
          toolCall={tc({ name: "bash", args: { command: "ls" }, output: "Tool bash not found", isError: true })}
          blockId="m1:tool:t1"
          turnFailed={false}
        />
      </I18nProvider>,
    );
    // Libellé actionnable (i18n en) à la place de « Tool bash not found ».
    expect(screen.getByText(/Tool "bash" unavailable in harness mode/)).toBeTruthy();
    // L'erreur technique brute reste accessible dans le bloc déplié.
    expect(screen.getByText("Tool bash not found")).toBeTruthy();
  });

  it("historique rechargé (isError perdu) : détection au rendu, même libellé", () => {
    render(
      <I18nProvider>
        <ToolCallRow
          toolCall={tc({ name: "read", args: { path: "x.ts" }, output: "Tool read not found", isError: false })}
          blockId="m2:tool:t2"
          turnFailed={false}
        />
      </I18nProvider>,
    );
    expect(screen.getByText(/Tool "read" unavailable in harness mode/)).toBeTruthy();
    expect(screen.getByText("Tool read not found")).toBeTruthy();
  });

  it("delegate manquant (mode code) : message « travail direct »", () => {
    render(
      <I18nProvider>
        <ToolCallRow
          toolCall={tc({ name: "delegate", output: "Tool delegate not found", isError: true })}
          blockId="m3:tool:t3"
          turnFailed={false}
        />
      </I18nProvider>,
    );
    expect(screen.getByText(/Tool "delegate" unavailable in code mode/)).toBeTruthy();
  });

  it("résultat normal non affecté", () => {
    render(
      <I18nProvider>
        <ToolCallRow
          toolCall={tc({ name: "bash", args: { command: "ls" }, output: "ok", isError: false })}
          blockId="m4:tool:t4"
          turnFailed={false}
        />
      </I18nProvider>,
    );
    expect(screen.getByText("bash ls · exit 0 · 1 lignes")).toBeTruthy();
    expect(screen.queryByText(/unavailable/)).toBeNull();
  });
});

describe("ToolResultRow — outil indisponible (résultat orphelin d'historique)", () => {
  it("applique le même libellé et conserve le texte technique", () => {
    const message = {
      id: "m5",
      role: "toolResult",
      content: "",
      thinking: "",
      toolCalls: [],
      timestamp: 0,
      toolResult: tc({ name: "grep", output: "Tool grep not found", isError: false }),
    } as unknown as DisplayMessage;
    render(
      <I18nProvider>
        <ToolResultRow message={message} />
      </I18nProvider>,
    );
    expect(screen.getByText(/Tool "grep" unavailable in harness mode/)).toBeTruthy();
    expect(screen.getByText("Tool grep not found")).toBeTruthy();
  });
});
