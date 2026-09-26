// @vitest-environment jsdom
/**
 * Tests — rendu markdown partagé (chat + explorateur).
 *
 * Couvre les 3 améliorations :
 *  1. coloration syntaxique des blocs de code (Prism + thème prism oneDark),
 *     avec conservation du bouton « copier » et non-coloration pendant le
 *     streaming ; le code inline reste inline ;
 *  2. non-régression du rendu GFM (tableaux, cases à cocher, liens) ;
 *  3. images externes non chargées automatiquement (substitut cliquable,
 *     aucune requête avant clic) et rendu direct des images locales/pièces
 *     jointes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { MarkdownContent, isExternalImageSrc, readThemeMode } from "./markdown";

beforeEach(() => {
  // Langue déterministe pour les libellés i18n du substitut d'image.
  localStorage.setItem("pi-web-language", "en");
});

afterEach(cleanup);

function renderMd(content: string, streaming = false) {
  return render(
    <I18nProvider>
      <MarkdownContent content={content} streaming={streaming} />
    </I18nProvider>,
  );
}

describe("MarkdownContent — coloration des blocs de code", () => {
  it("colore un bloc de code avec langage et expose le bouton copier", () => {
    const { container } = renderMd("```js\nconst x = 1;\n```");
    // SyntaxHighlighter (Prism) rend son propre conteneur, pas de <pre> imbriqué.
    expect(container.querySelector(".markdown-code-highlight")).not.toBeNull();
    expect(container.querySelector("code.language-js")).not.toBeNull();
    // Jetons tokenisés et colorés (react-syntax-highlighter pose la couleur en style inline).
    const colored = Array.from(container.querySelectorAll("code.language-js span"))
      .some((span) => (span as HTMLElement).style.color !== "");
    expect(colored).toBe(true);
    // Bouton « copier » conservé.
    expect(container.querySelector('button[title="Copy code"]')).not.toBeNull();
    // Aucun <pre> dans un <pre> (pas de double emballage).
    expect(container.querySelector("pre pre")).toBeNull();
  });

  it("ne colore PAS pendant le streaming mais conserve le bouton copier", () => {
    const { container } = renderMd("```js\nconst x = 1;\n```", true);
    expect(container.querySelector(".markdown-code-highlight")).toBeNull();
    expect(container.querySelector("pre")).not.toBeNull();
    expect(container.querySelector('button[title="Copy code"]')).not.toBeNull();
  });

  it("n'emballe PAS le code inline dans un bloc coloré", () => {
    const { container } = renderMd("Use `inline` code here");
    expect(container.querySelector(".markdown-code-highlight")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    const code = container.querySelector("p code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe("inline");
  });
});

describe("MarkdownContent — non-régression GFM", () => {
  it("rend les tableaux, cases à cocher et liens", () => {
    const md = [
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "- [ ] todo",
      "- [x] done",
      "",
      "[site](https://example.com)",
    ].join("\n");
    const { container } = renderMd(md);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(2);
    const link = container.querySelector('a[href="https://example.com"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe("site");
  });
});

describe("isExternalImageSrc — critère d'externalité", () => {
  it("classe externe/local selon l'hôte et le schéma", () => {
    expect(isExternalImageSrc("https://evil.example/tracker.png")).toBe(true);
    expect(isExternalImageSrc("//evil.example/tracker.png")).toBe(true);
    expect(isExternalImageSrc("https://localhost:3000/x.png")).toBe(false);
    expect(isExternalImageSrc("//localhost:3000/x.png")).toBe(false);
    expect(isExternalImageSrc("/api/attachments/abc/file")).toBe(false);
    expect(isExternalImageSrc("./local.png")).toBe(false);
    expect(isExternalImageSrc("data:image/png;base64,AAAA")).toBe(false);
    expect(isExternalImageSrc("blob:http://localhost:3000/uuid")).toBe(false);
    expect(isExternalImageSrc("")).toBe(false);
  });
});

describe("MarkdownContent — images externes non chargées automatiquement", () => {
  it("affiche le substitut, aucune requête avant clic, puis l'image après clic", () => {
    const { container } = renderMd("![pic](https://evil.example/tracker.png)");
    // Aucun élément <img> → aucune requête réseau vers l'hôte externe.
    expect(container.querySelector("img")).toBeNull();
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain("Click to load image");

    fireEvent.click(button!);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("https://evil.example/tracker.png");
  });

  it("retombe sur un lien cliquable si le chargement échoue", () => {
    const { container } = renderMd("![pic](https://evil.example/tracker.png)");
    fireEvent.click(container.querySelector("button")!);
    const img = container.querySelector("img")!;
    fireEvent.error(img);
    const fallback = container.querySelector("a[href='https://evil.example/tracker.png']");
    expect(fallback).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("affiche directement une image servie par Pi-Web (pièce jointe)", () => {
    const { container } = renderMd("![att](/api/attachments/abc/file)");
    expect(container.querySelector("button")).toBeNull();
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("/api/attachments/abc/file");
  });

  it("affiche directement une image relative locale", () => {
    const { container } = renderMd("![x](./local.png)");
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe("./local.png");
  });
});

describe("MarkdownContent — thème de coloration adaptatif", () => {
  const root = document.documentElement;
  afterEach(() => { root.className = ""; });

  /** Fond inline posé par le thème Prism sur le conteneur coloré. */
  function highlightBg(container: HTMLElement): string {
    const el = container.querySelector<HTMLElement>(".markdown-code-highlight");
    return el ? el.style.background : "";
  }

  it("readThemeMode suit la classe light/dark de <html>", () => {
    root.className = "dark";
    expect(readThemeMode()).toBe("dark");
    root.className = "light";
    expect(readThemeMode()).toBe("light");
  });

  it("applique un fond clair en mode clair et sombre en mode sombre", () => {
    root.className = "dark";
    const dark = renderMd("```js\nconst x = 1;\n```");
    const darkBg = highlightBg(dark.container);
    cleanup();
    root.className = "light";
    const light = renderMd("```js\nconst x = 1;\n```");
    const lightBg = highlightBg(light.container);
    expect(darkBg).not.toBe("");
    expect(lightBg).not.toBe("");
    expect(lightBg).not.toBe(darkBg);
  });

  it("change de style immédiatement quand le thème bascule en direct", async () => {
    root.className = "dark";
    const { container } = renderMd("```js\nconst x = 1;\n```");
    const before = highlightBg(container);
    // Simule la bascule App.tsx (classList.toggle sur documentElement).
    root.className = "light";
    await waitFor(() => expect(highlightBg(container)).not.toBe(before));
  });
});
