/**
 * B11 (performance) — plus AUCUN `execSync("git …")` sur le chemin d'une
 * requête dans `routes/agent.ts`.
 *
 * Avant : `isGitRepo`, `gitSnapshot` et `getGitChangedFiles` faisaient des
 * `execSync('git …', { timeout: 5000 })`. Sur un gros dépôt, `git diff
 * --name-status` gèle la boucle d'événements → toutes les sessions LLM
 * ouvertes saccadent pendant la génération du snapshot.
 *
 * Après : `execFile` promisifié (`runGit`), mêmes timeouts, handlers async.
 * Aucun réseau, aucun dépôt réel : `child_process` est simulé et le projet de
 * test vit dans un dossier temporaire.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import type { Project } from "../projects/manager.js";

const { execFileMock, execSyncMock, getProjectMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execSyncMock: vi.fn(() => {
    throw new Error("execSync interdit (B11)");
  }),
  getProjectMock: vi.fn(),
}));

vi.mock("child_process", () => ({ execFile: execFileMock, execSync: execSyncMock }));
vi.mock("../middleware/agent-auth.js", () => ({
  agentAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../projects/manager.js", () => ({
  getProject: getProjectMock,
  getAllProjects: vi.fn(() => []),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
}));
vi.mock("../pi/session.js", () => ({}));
vi.mock("../pi/model-library.js", () => ({}));
vi.mock("../pi/providers.js", () => ({}));

const PROJ: Project = {
  id: "p1",
  name: "p1",
  cwd: "",
  storage: "local",
  versioning: "git",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "agent-git-"));
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  PROJ.cwd = dir;
  getProjectMock.mockReturnValue(PROJ);
  execFileMock.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb: (e: unknown, out: unknown) => void) => {
      const mode = args[0];
      const stdout =
        mode === "rev-parse" ? "true"
        : mode === "diff" ? "M\tsrc/a.ts"
        : "src/new.ts";
      setTimeout(() => cb(null, { stdout, stderr: "" }), 30);
    },
  );
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("B11 — snapshots git asynchrones dans routes/agent.ts", () => {
  it("la source n'appelle plus execSync (aucun gel possible)", () => {
    const src = readFileSync(fileURLToPath(new URL("./agent.ts", import.meta.url)), "utf-8");
    const code = src
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/?\*)/.test(line))
      .join("\n");
    expect(code).not.toMatch(/execSync/);
  });

  it("getLinkedChangedFiles() est asynchrone et laisse respirer la boucle d'événements", async () => {
    const { getLinkedChangedFiles } = await import("./agent.js");
    const linked: Project = { ...PROJ, storage: "linked", linkedProjectIds: ["p1"] };
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 2);
    let files: Array<{ path: string; status: string }>;
    try {
      files = await getLinkedChangedFiles(linked);
    } finally {
      clearInterval(timer);
    }
    // Deux commandes git simulées à 30 ms : le handler a attendu sans bloquer.
    expect(ticks).toBeGreaterThan(0);
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(files).toEqual([
      { path: "p1/src/a.ts", status: "M" },
      { path: "p1/src/new.ts", status: "A" },
    ]);
  });
});
