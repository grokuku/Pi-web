import { beforeEach, describe, expect, it, vi } from "vitest";

const { modelLibraryMock } = vi.hoisted(() => ({
  modelLibraryMock: {
    loadModelLibrary: vi.fn(() => ({ models: [], projectModes: {} })),
    setProjectModeEnabled: vi.fn(),
    setProjectModeHarnessConfig: vi.fn(),
    setProjectRoutingConfig: vi.fn(),
  },
}));

vi.mock("../pi/model-library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pi/model-library.js")>()),
  ...modelLibraryMock,
}));

vi.mock("../pi/session.js", () => ({
  setModel: vi.fn(),
  setThinkingLevel: vi.fn(),
  reloadModelRegistry: vi.fn(),
  getModelRegistry: vi.fn(),
  getActiveMode: vi.fn(),
  reapplyAllSessions: vi.fn(),
  getSession: vi.fn(),
  compactSession: vi.fn(),
}));

import router from "./model-library.js";

function putMode(body: Record<string, unknown>) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const req: any = { method: "PUT", url: "/projects/p1/mode", body, headers: {}, query: {}, params: {} };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    (router as any)(req, res, () => resolve({ status: 404, body: { error: "no matching route" } }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PUT /api/model-library/projects/:projectId/mode — champs harness", () => {
  it("refuse enabled/config/routing sans mode=harness au lieu de répondre 200 sans écrire", async () => {
    for (const mode of [undefined, "code"]) {
      for (const field of ["enabled", "config", "routing"]) {
        const res = await putMode({ ...(mode ? { mode } : {}), [field]: field === "enabled" ? true : {} });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("mode requis pour enabled/config/routing");
      }
    }
    expect(modelLibraryMock.loadModelLibrary).not.toHaveBeenCalled();
    expect(modelLibraryMock.setProjectModeEnabled).not.toHaveBeenCalled();
    expect(modelLibraryMock.setProjectModeHarnessConfig).not.toHaveBeenCalled();
    expect(modelLibraryMock.setProjectRoutingConfig).not.toHaveBeenCalled();
  });
});
