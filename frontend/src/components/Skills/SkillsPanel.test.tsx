// @vitest-environment jsdom
/**
 * Tests du panneau SKILLS (liste + éditeur SKILL.md).
 *
 * Couvre :
 *   - la liste : noms, statuts (livrée / écosystème / générée / personnelle),
 *     badge MODIFIÉE, état activé/désactivé ;
 *   - le toggle via le mécanisme existant POST /api/pi/toggle (`!<nom>`) ;
 *   - l'éditeur : ouverture (GET), édition + enregistrement (PUT), feedback ;
 *   - la skill GÉNÉRÉE : avertissement + lecture seule + pas de bouton SAVE ;
 *   - la restauration en deux temps (POST /restore) ;
 *   - la création (nom + description) qui ouvre ensuite l'éditeur ;
 *   - le respect du réglage de repli (CollapsibleBlock / display-detail) ;
 *   - le rechargement de session (projet actif).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { SkillsPanel } from "./SkillsPanel";
import type { SkillDetailResponse, SkillInfo } from "./skills-api";

// ── Données de test ─────────────────────────────────────

function skill(overrides: Partial<SkillInfo> & { name: string }): SkillInfo {
  const base: SkillInfo = {
    description: `description de ${overrides.name}`,
    status: "custom",
    editable: true,
    modified: false,
    reference: null,
    enabled: true,
    dir: `/root/.pi/agent/skills/${overrides.name}`,
    file: `/root/.pi/agent/skills/${overrides.name}/SKILL.md`,
    ...overrides,
  };
  // Référence cohérente avec le statut (sert au bouton « restaurer »).
  if (base.reference === null && (base.status === "bundled" || base.status === "ecosystem")) {
    base.reference = { kind: base.status, dir: `/reference/${overrides.name}` };
  }
  return base;
}

const LIST: SkillInfo[] = [
  skill({ name: "codebase-memory", status: "generated", editable: false, description: "graphe de code CBM" }),
  skill({ name: "holaf-briques", status: "ecosystem", enabled: false, description: "briques holaf réutilisables" }),
  skill({ name: "pi-web-cbm", status: "bundled", modified: true, description: "pièges vérifiés du graphe" }),
  skill({ name: "pi-web-ui", status: "bundled", description: "conventions d'interface" }),
];

function contentOf(name: string, description = `description de ${name}`): string {
  return `---\nname: ${name}\ndescription: "${description}"\n---\n\ncorps de ${name}\n`;
}

function detailFor(name: string, opts: { modified?: boolean } = {}): SkillDetailResponse {
  const info = listState.find((s) => s.name === name) ?? LIST.find((s) => s.name === name) ?? skill({ name });
  return {
    skill: { ...info, modified: opts.modified ?? info.modified },
    content: contentOf(name),
    referenceContent: info.status === "bundled" || info.status === "ecosystem" ? contentOf(name, "référence") : null,
  };
}

// ── Fetch simulé ────────────────────────────────────────

const calls: Array<{ url: string; init?: RequestInit }> = [];
/** Liste renvoyée par GET /api/skills (mutable pour simuler les modifications). */
let listState: SkillInfo[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
  } as unknown as Response;
}

function installFetch() {
  globalThis.fetch = vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const method = (init?.method ?? "GET").toUpperCase();

    if (url === "/api/skills" && method === "GET") {
      return jsonResponse({ skills: listState });
    }
    if (url === "/api/skills" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const created = skill({
        name: body.name,
        description: body.description,
        status: "custom",
        enabled: true,
      });
      listState = [...listState, created];
      return jsonResponse({ success: true, skill: created, content: contentOf(body.name, body.description), referenceContent: null }, 201);
    }
    if (url === "/api/skills/pi-web-ui/restore" && method === "POST") {
      listState = listState.map((s) => (s.name === "pi-web-ui" ? { ...s, modified: false } : s));
      return jsonResponse({ success: true, ...detailFor("pi-web-ui") });
    }
    if (url === "/api/skills/pi-web-cbm/restore" && method === "POST") {
      listState = listState.map((s) => (s.name === "pi-web-cbm" ? { ...s, modified: false } : s));
      return jsonResponse({ success: true, ...detailFor("pi-web-cbm") });
    }
    if (url.startsWith("/api/skills/") && method === "GET") {
      const name = decodeURIComponent(url.slice("/api/skills/".length));
      if (!listState.some((s) => s.name === name)) return jsonResponse({ error: "introuvable" }, 404);
      return jsonResponse(detailFor(name));
    }
    if (url.startsWith("/api/skills/") && method === "PUT") {
      const name = decodeURIComponent(url.slice("/api/skills/".length));
      const body = JSON.parse(String(init?.body ?? "{}"));
      listState = listState.map((s) => (s.name === name ? { ...s, modified: true, description: "modifiée" } : s));
      return jsonResponse({ success: true, ...detailFor(name, { modified: true }) });
    }
    if (url === "/api/pi/toggle" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({ success: true, skills: [body.enabled ? body.source : `!${body.source}`] });
    }
    if (url === "/api/pi/reload" && method === "POST") {
      return jsonResponse({ success: true });
    }
    return jsonResponse({ error: `route non simulée : ${method} ${url}` }, 404);
  }) as unknown as typeof fetch;
}

function renderPanel(props: { activeProjectId?: string | null } = {}) {
  return render(
    <I18nProvider>
      <SkillsPanel {...props} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.setItem("pi-web-language", "fr"); // libellés déterministes
  calls.length = 0;
  listState = LIST.map((s) => ({ ...s }));
  installFetch();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

// ── Liste ───────────────────────────────────────────────

describe("liste des skills", () => {
  it("affiche les noms avec leurs statuts et le badge MODIFIÉE", async () => {
    renderPanel();
    expect(await screen.findByTestId("skill-name-pi-web-ui")).toBeTruthy();
    expect(screen.getByTestId("skill-name-codebase-memory")).toBeTruthy();
    // Deux skills livrées : on vérifie le libellé du premier badge.
    expect(screen.getAllByTestId("skill-status-bundled")[0].textContent).toBe("LIVRÉE");
    expect(screen.getByTestId("skill-status-ecosystem").textContent).toBe("ÉCOSYSTÈME");
    expect(screen.getByTestId("skill-status-generated").textContent).toBe("GÉNÉRÉE");
    // Une seule skill modifiée (pi-web-cbm).
    expect(screen.getAllByTestId("skill-modified-badge")).toHaveLength(1);
    // État désactivé visible pour holaf-briques.
    expect(screen.getByTestId("skill-toggle-holaf-briques").getAttribute("title")).toContain("Désactivée");
  });

  it("respecte le réglage de repli (description masquée par défaut)", async () => {
    localStorage.setItem("pi-web-display-detail", "false");
    renderPanel();
    const name = await screen.findByTestId("skill-name-pi-web-ui");
    expect(screen.queryByText("conventions d'interface")).toBeNull();
    fireEvent.click(name); // clic sur l'en-tête → déplie (override utilisateur)
    expect(screen.getByText("conventions d'interface")).toBeTruthy();
  });
});

// ── Toggle ──────────────────────────────────────────────

describe("activation / désactivation", () => {
  it("active une skill désactivée via /api/pi/toggle (nom nu)", async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId("skill-toggle-holaf-briques"));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/pi/toggle")).toBe(true));
    const call = calls.find((c) => c.url === "/api/pi/toggle")!;
    expect(JSON.parse(String(call.init?.body))).toEqual({ type: "skills", source: "holaf-briques", enabled: true });
    await waitFor(() => expect(screen.getByTestId("skill-toggle-holaf-briques").getAttribute("title")).toContain("Activée"));
  });

  it("désactive une skill active via le motif !<nom>", async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId("skill-toggle-pi-web-ui"));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/pi/toggle")).toBe(true));
    const call = calls.find((c) => c.url === "/api/pi/toggle")!;
    expect(JSON.parse(String(call.init?.body))).toEqual({ type: "skills", source: "pi-web-ui", enabled: false });
    await waitFor(() => expect(screen.getByTestId("skill-toggle-pi-web-ui").getAttribute("title")).toContain("Désactivée"));
  });
});

// ── Éditeur ─────────────────────────────────────────────

describe("éditeur", () => {
  it("ouvre la fiche, enregistre les modifications et le signale", async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId("skill-edit-pi-web-ui"));
    const input = (await screen.findByTestId("skill-content-input")) as HTMLTextAreaElement;
    expect(input.value).toContain("description de pi-web-ui");
    expect(input.readOnly).toBe(false);

    fireEvent.change(input, { target: { value: contentOf("pi-web-ui", "version éditée") } });
    const save = screen.getByTestId("skill-save") as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);

    await waitFor(() => expect(calls.some((c) => c.url === "/api/skills/pi-web-ui" && c.init?.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.url === "/api/skills/pi-web-ui" && c.init?.method === "PUT")!;
    expect(JSON.parse(String(put.init?.body)).content).toContain("version éditée");
    await waitFor(() => expect(screen.getByTestId("skill-save").textContent).toContain("ENREGISTRÉ"));
  });

  it("verrouille une skill générée : avertissement, lecture seule, pas de SAVE", async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId("skill-edit-codebase-memory"));
    expect(await screen.findByTestId("skill-generated-warning")).toBeTruthy();
    const input = screen.getByTestId("skill-content-input") as HTMLTextAreaElement;
    expect(input.readOnly).toBe(true);
    expect(screen.queryByTestId("skill-save")).toBeNull();
    expect(screen.queryByTestId("skill-restore")).toBeNull();
  });

  it("restaure la version livrée en deux temps (confirmation puis POST)", async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId("skill-edit-pi-web-cbm"));
    await screen.findByTestId("skill-restore-bar");
    const restore = await screen.findByTestId("skill-restore");

    fireEvent.click(restore); // 1er clic : demande confirmation, aucun appel
    expect(restore.textContent).toContain("CONFIRMER");
    expect(calls.some((c) => c.url.includes("/restore"))).toBe(false);

    fireEvent.click(restore); // 2e clic : restaure
    await waitFor(() => expect(calls.some((c) => c.url === "/api/skills/pi-web-cbm/restore")).toBe(true));
    // La copie ne diverge plus : la barre disparaît et le badge MODIFIÉE aussi.
    await waitFor(() => expect(screen.queryByTestId("skill-restore-bar")).toBeNull());
    expect(screen.queryByTestId("skill-modified-badge")).toBeNull();
  });
});

// ── Création ────────────────────────────────────────────

describe("création", () => {
  it("refuse un nom invalide puis crée la skill et ouvre son éditeur", async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId("skills-new"));
    const nameInput = screen.getByTestId("skill-create-name") as HTMLInputElement;
    const descInput = screen.getByTestId("skill-create-desc") as HTMLTextAreaElement;
    const submit = screen.getByTestId("skill-create-submit") as HTMLButtonElement;

    fireEvent.change(nameInput, { target: { value: "Bad Name" } });
    fireEvent.change(descInput, { target: { value: "ma description" } });
    fireEvent.click(submit);
    expect(screen.getByText(/Nom invalide/)).toBeTruthy();
    expect(calls.some((c) => c.url === "/api/skills" && c.init?.method === "POST")).toBe(false);

    fireEvent.change(nameInput, { target: { value: "ma-skill" } });
    fireEvent.click(submit);
    await waitFor(() => expect(calls.some((c) => c.url === "/api/skills" && c.init?.method === "POST")).toBe(true));
    const post = calls.find((c) => c.url === "/api/skills" && c.init?.method === "POST")!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ name: "ma-skill", description: "ma description" });
    // L'éditeur de la nouvelle skill s'ouvre.
    expect(await screen.findByTestId("skill-content-input")).toBeTruthy();
    expect(screen.getByText("ma-skill")).toBeTruthy();
  });
});

// ── Rechargement de session ─────────────────────────────

describe("rechargement de session", () => {
  it("propose le rechargement après un changement quand un projet est actif", async () => {
    renderPanel({ activeProjectId: "p1" });
    fireEvent.click(await screen.findByTestId("skill-toggle-pi-web-ui"));
    await waitFor(() => expect(screen.getByText(/Modifications enregistrées/)).toBeTruthy());
    fireEvent.click(screen.getByTestId("skills-reload-session"));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/pi/reload")).toBe(true));
    const call = calls.find((c) => c.url === "/api/pi/reload")!;
    expect(JSON.parse(String(call.init?.body))).toEqual({ projectId: "p1" });
    await waitFor(() => expect(screen.getByTestId("skills-reload-session").textContent).toContain("RECHARGÉE"));
  });

  it("n'affiche pas le bouton de rechargement sans projet actif", async () => {
    renderPanel();
    await screen.findByTestId("skill-name-pi-web-ui");
    expect(screen.queryByTestId("skills-reload-session")).toBeNull();
  });
});
