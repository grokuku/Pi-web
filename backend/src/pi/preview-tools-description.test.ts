/**
 * preview-tools-description.test.ts — les DESCRIPTIONS des tools de preview
 * disent-elles la VÉRITÉ ?
 *
 * Demande produit : « que les LLM comprennent bien comment ça marche ». Les
 * champs `description` / `promptSnippet` / `promptGuidelines` sont injectés dans
 * le prompt À CHAQUE TOUR (cf. commentaire d'en-tête de preview-tools.ts) : une
 * promesse fausse y coûte un tour d'agent à chaque appel. Ce fichier verrouille
 * donc les faits qui existent VRAIMENT dans routes/preview.ts et
 * frontend/src/App.tsx :
 *   - preview_html : 500 Ko max, TTL 10 min, stockage en mémoire (perdu au
 *     redémarrage) — bornes interpolées depuis les constantes de la route, donc
 *     une description qui recopie une valeur en dur divergerait ici ;
 *   - open_preview : chemin RELATIF confiné au cwd (pas d'absolu, pas de ../) ;
 *   - seuls les MIME de MIME_MAP s'affichent, tout le reste est TÉLÉCHARGÉ
 *     (application/octet-stream) : pas de PDF, de vidéo ni de police ;
 *   - assets en relatif côté open_preview, URL absolues côté preview_html ;
 *   - isolation (origine opaque : pas de localStorage / API same-origin) ;
 *   - une seule fenêtre : un nouvel appel REMPLACE l'aperçu courant ;
 *   - la ligne de retour (`Preview available at: …`) reste INCHANGÉE : le
 *     frontend la parse par regex (App.tsx, /api\/preview-inline\/[a-f0-9]+/).
 *
 * Convention de langue verrouillée ici aussi : `description` et descriptions de
 * paramètres en FRANÇAIS, `promptSnippet`/`promptGuidelines` en ANGLAIS — comme
 * memory-tools.ts, librarian-tools.ts, design-tools.ts et commit-draft-tool.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { createAllowedRootMirror } from "../utils/allowed-root-mirror.test-util.js";
import { mimeForPath, INLINE_MAX_SIZE, INLINE_TTL_MS } from "../routes/preview.js";

// Mock du gestionnaire de projets : les tools résolvent le cwd via getProject().
const { getProjectMock } = vi.hoisted(() => ({ getProjectMock: vi.fn() }));
vi.mock("../projects/manager.js", () => ({ getProject: getProjectMock }));

import { openPreviewToolDef, previewHtmlToolDef } from "./preview-tools.js";

// `defineTool` expose ces champs en lecture : on les lit comme le SDK le fait.
const OPEN = openPreviewToolDef as any;
const INLINE = previewHtmlToolDef as any;

/** Tout ce que le modèle lit du tool (les 3 canaux de prompt). */
const OPEN_TEXT = [OPEN.description, OPEN.promptSnippet, ...OPEN.promptGuidelines].join("\n");
const INLINE_TEXT = [INLINE.description, INLINE.promptSnippet, ...INLINE.promptGuidelines].join("\n");

/** Description d'un paramètre TypeBox. */
function paramDoc(def: any, name: string): string {
  const prop = def.parameters?.properties?.[name];
  if (!prop) throw new Error(`Paramètre ${name} introuvable`);
  return String(prop.description ?? "");
}

/** Accents français : absents des guidelines anglaises (verrou de langue). */
const FRENCH_ACCENTS = /[àâçéèêëîïôùûüœÀÂÇÉÈÊËÎÏÔÙÛÜŒ]/;

// Racine autorisée redirigée vers un bac à sable (path-security refuse d'écrire
// hors de /projects ou /mnt/smb) — même utilitaire que routes/preview.test.ts.
const mirror = createAllowedRootMirror("preview-tools-");
const TEST_ROOT = mirror.projects;
const PROJ = path.join(TEST_ROOT, "projA");

beforeEach(() => {
  mirror.install();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJ, { recursive: true });
  getProjectMock.mockReset();
  getProjectMock.mockReturnValue({ id: "projA", cwd: PROJ });
});

afterEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  mirror.uninstall();
});

afterAll(() => {
  mirror.dispose();
});

// ── preview_html : limites inline ─────────────────────────

describe("preview_html : les limites annoncées sont celles du code", () => {
  it("annonce 500 Ko et 10 minutes, avec les constantes de routes/preview.ts", () => {
    // Les valeurs de référence : celles que la route applique réellement.
    expect(INLINE_MAX_SIZE / 1024).toBe(500);
    expect(INLINE_TTL_MS / 60_000).toBe(10);

    // La description les interpole (pas de recopie en dur) → aucune dérive possible.
    expect(INLINE_TEXT).toContain(`${INLINE_MAX_SIZE / 1024} Ko`);
    expect(INLINE_TEXT).toContain(`${INLINE_TTL_MS / 60_000} minutes`);
    // Et le paramètre `html` porte la limite de taille au plus près de l'appel.
    expect(paramDoc(INLINE, "html")).toContain(`${INLINE_MAX_SIZE / 1024} Ko`);
  });

  it("dit que le stockage est EN MÉMOIRE et perdu au redémarrage", () => {
    expect(INLINE_TEXT).toMatch(/en mémoire/i);
    expect(INLINE_TEXT).toMatch(/redémarrage/i);
  });

  it("le dépassement de taille est réellement refusé et l'erreur annonce 500KB", async () => {
    const big = "x".repeat(INLINE_MAX_SIZE + 1);
    const res = await INLINE.execute("t1", { html: big }, undefined, undefined, {});
    const text = res.content.map((c: any) => c.text).join("");
    expect(text).toContain("Erreur preview_html");
    expect(text).toContain("500KB");
  });
});

// ── open_preview : formats affichés vs téléchargés ────────

/** Extensions que la fenêtre Preview rend vraiment (MIME_MAP non-octet-stream). */
const DISPLAYED = [".html", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".txt", ".md"];
/** Extensions citées comme NON affichées (téléchargées). */
const DOWNLOADED = [".pdf", ".mp4", ".woff2", ".tsx"];

describe("formats : ce qui s'affiche et ce qui se télécharge", () => {
  it("chaque format annoncé comme rendu a bien un MIME dans MIME_MAP", () => {
    for (const ext of DISPLAYED) {
      expect(mimeForPath(`f${ext}`), ext).not.toBe("application/octet-stream");
      expect(OPEN_TEXT, ext).toContain(ext);
    }
  });

  it("les formats non mappés partent en application/octet-stream (téléchargement)", () => {
    for (const ext of DOWNLOADED) {
      expect(mimeForPath(`f${ext}`), ext).toBe("application/octet-stream");
    }
    // La description doit prévenir du téléchargement, pas promettre un rendu.
    expect(OPEN_TEXT).toMatch(/TÉLÉCHARGÉ/);
    expect(OPEN_TEXT).toMatch(/PDF/);
  });
});

// ── open_preview : confinement du chemin + assets relatifs ──

describe("open_preview : chemin relatif confiné au projet", () => {
  it("la description et le paramètre `path` exigent un chemin RELATIF", () => {
    expect(OPEN_TEXT).toMatch(/RELATIF/);
    expect(OPEN_TEXT).toMatch(/absolu/i);
    expect(paramDoc(OPEN, "path")).toMatch(/RELATIF/);
    expect(paramDoc(OPEN, "path")).toMatch(/absolu/i);
  });

  it("dit que les assets doivent être DANS le projet et référencés en relatif", () => {
    expect(OPEN_TEXT).toMatch(/assets/);
    expect(OPEN_TEXT).toMatch(/relatif/i);
  });

  it("un chemin absolu hors projet est refusé à l'exécution", async () => {
    const res = await OPEN.execute(
      "t1",
      { projectId: "projA", path: "/etc/hostname" },
      undefined,
      undefined,
      {},
    );
    expect(res.content[0].text).toContain("introuvable ou inaccessible");
  });

  it("une traversée ../ hors projet est refusée à l'exécution", async () => {
    const outside = path.join(TEST_ROOT, "other", "secret.html");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, "<h1>secret</h1>");
    const res = await OPEN.execute(
      "t1",
      { projectId: "projA", path: path.join("..", "other", "secret.html") },
      undefined,
      undefined,
      {},
    );
    expect(res.content[0].text).toContain("introuvable ou inaccessible");
  });
});

// ── isolation + fenêtre unique ─────────────────────────────

describe("isolation et fenêtre unique", () => {
  it("preview_html annonce l'isolation (pas de localStorage ni d'API same-origin)", () => {
    expect(INLINE_TEXT).toContain("localStorage");
    expect(INLINE_TEXT).toMatch(/same-origin/);
    // Et que les scripts fonctionnent quand même (sinon la maquette serait morte).
    expect(INLINE_TEXT).toMatch(/scripts/i);
  });

  it("preview_html prévient que les chemins relatifs ne se résolvent pas", () => {
    expect(INLINE_TEXT).toMatch(/URL absolues/i);
    expect(paramDoc(INLINE, "html")).toMatch(/ABSOLUES/);
  });

  it("les deux tools disent qu'un nouvel appel REMPLACE l'aperçu courant", () => {
    // Frontend : presentPreview() écrase lastPreview (une seule fenêtre).
    expect(OPEN_TEXT).toMatch(/REMPLACE/);
    expect(INLINE_TEXT).toMatch(/REMPLACE/);
  });

  it("chaque tool renvoie explicitement à l'autre selon le cas d'usage", () => {
    // Fichier existant vs mockup ad-hoc : pas de recouvrement ambigu.
    expect(OPEN_TEXT).toContain("preview_html");
    expect(INLINE_TEXT).toContain("open_preview");
  });
});

// ── langue : cohérence avec les autres tools du projet ────

describe("langue des champs de prompt", () => {
  it("les descriptions sont en français (comme memory/librarian/design tools)", () => {
    expect(OPEN.description).toMatch(FRENCH_ACCENTS);
    expect(INLINE.description).toMatch(FRENCH_ACCENTS);
    expect(OPEN.description).toMatch(/fenêtre/);
  });

  it("les promptSnippet et promptGuidelines sont en anglais (aucun accent)", () => {
    for (const [name, def] of [
      ["open_preview", OPEN],
      ["preview_html", INLINE],
    ] as const) {
      expect(def.promptSnippet, name).not.toMatch(FRENCH_ACCENTS);
      for (const g of def.promptGuidelines as string[]) {
        expect(g, `${name} : ${g}`).not.toMatch(FRENCH_ACCENTS);
      }
    }
  });

  it("reste concis : peu de guidelines, injectées à chaque tour", () => {
    expect(OPEN.promptGuidelines.length).toBeLessThanOrEqual(5);
    expect(INLINE.promptGuidelines.length).toBeLessThanOrEqual(4);
  });
});

// ── contrat de retour INCHANGÉ (regex frontend) ───────────

describe("format de retour inchangé (contrat frontend)", () => {
  it("preview_html renvoie EXACTEMENT `Preview available at: /api/preview-inline/<hex32>`", async () => {
    const res = await INLINE.execute("t1", { html: "<h1>ok</h1>" }, undefined, undefined, {});
    const text = res.content.map((c: any) => c.text).join("");
    expect(text).toMatch(/^Preview available at: \/api\/preview-inline\/[a-f0-9]{32}$/);
    // La regex du frontend (App.tsx) doit matcher cette ligne telle quelle.
    expect(text.match(/\/api\/preview-inline\/[a-f0-9]+/)?.[0]).toBe(text.replace("Preview available at: ", ""));
  });

  it("open_preview renvoie EXACTEMENT `Preview available at: /api/preview/<projectId>/<path>`", async () => {
    fs.writeFileSync(path.join(PROJ, "index.html"), "<h1>ok</h1>");
    const res = await OPEN.execute(
      "t1",
      { projectId: "projA", path: "index.html" },
      undefined,
      undefined,
      {},
    );
    expect(res.content[0].text).toBe("Preview available at: /api/preview/projA/index.html");
  });

  it("les noms des tools et de leurs paramètres sont inchangés", () => {
    expect(OPEN.name).toBe("open_preview");
    expect(INLINE.name).toBe("preview_html");
    expect(Object.keys(OPEN.parameters.properties).sort()).toEqual(["path", "projectId"]);
    expect(Object.keys(INLINE.parameters.properties)).toEqual(["html"]);
  });
});
