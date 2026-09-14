/**
 * Tests unitaires du filtre image-budget (pi/image-budget.ts).
 *
 * Le filtre est pur : on teste directement la logique sur des messages
 * LLM factices ({ role, content }) — aucune dépendance SDK ni I/O.
 *
 * Rappel des règles :
 *   - images agent (toolResult/assistant) → toujours exclues ;
 *   - images user → uniquement celles du dernier message user-image.
 */
import { describe, it, expect } from "vitest";
import { filterImagesForModel, IMAGE_OMITTED_TEXT } from "./image-budget.js";

// ── Fabriques de messages de test ──
const text = (t: string) => ({ type: "text", text: t });
const img = (id: string) => ({ type: "image", data: `b64-${id}`, mimeType: "image/png" });

const user = (...parts: Array<{ type: string }>) => ({ role: "user", content: parts });
const assistantText = (t: string) => ({ role: "assistant", content: [text(t)] });
const toolResult = (...parts: Array<{ type: string }>) => ({
  role: "toolResult",
  content: parts,
});

/** Récupère les data des images d'un message (contenu tableau uniquement). */
function imageIds(msg: { content: unknown }): string[] {
  if (!Array.isArray(msg.content)) return [];
  return msg.content
    .filter((p: any) => p.type === "image")
    .map((p: any) => p.data);
}

describe("filterImagesForModel — images agent", () => {
  it("exclut TOUJOURS les images d'un toolResult (web_screenshot)", () => {
    const msgs = [
      user(text("regarde le rendu")),
      toolResult(text("Screenshot 1440x900"), img("shot-1")),
    ];
    const out = filterImagesForModel(msgs);

    expect(imageIds(out[1])).toEqual([]);
    // Le texte du tool result est conservé (l'agent a le contexte du tool).
    expect(out[1].content).toEqual([text("Screenshot 1440x900")]);
  });

  it("exclut les images d'un message assistant (image générée par le modèle)", () => {
    const msgs = [
      user(text("génère un logo")),
      { role: "assistant", content: [text("voici"), img("gen-1")] },
    ];
    const out = filterImagesForModel(msgs as any);

    expect(imageIds(out[1])).toEqual([]);
    expect(out[1].content).toEqual([text("voici")]);
  });

  it("remplace par un placeholder si un tool result n'avait QUE l'image", () => {
    const msgs = [toolResult(img("shot-seul"))];
    const out = filterImagesForModel(msgs);

    expect(out[0].content).toEqual([{ type: "text", text: IMAGE_OMITTED_TEXT }]);
  });
});

describe("filterImagesForModel — images user", () => {
  it("conserve toutes les images du DERNIER message user-image", () => {
    const msgs = [user(text("regarde"), img("a"), img("b"))];
    const out = filterImagesForModel(msgs);

    expect(imageIds(out[0])).toEqual(["b64-a", "b64-b"]);
  });

  it("supprime les images des messages user antérieurs en gardant leur texte", () => {
    const msgs = [
      user(text("première image"), img("old")),
      assistantText("bien reçu"),
      user(text("deuxième image"), img("new")),
    ];
    const out = filterImagesForModel(msgs);

    expect(imageIds(out[0])).toEqual([]);
    expect(out[0].content).toEqual([text("première image")]);
    expect(imageIds(out[2])).toEqual(["b64-new"]);
  });

  it("un message user plus récent avec image prend le dessus (le suivant gagne)", () => {
    const msgs = [
      user(img("m1")),
      user(img("m2")),
      user(img("m3")),
    ];
    const out = filterImagesForModel(msgs);

    expect(imageIds(out[0])).toEqual([]);
    expect(imageIds(out[1])).toEqual([]);
    expect(imageIds(out[2])).toEqual(["b64-m3"]);
  });

  it("remplace par un placeholder un ancien message user vide après retrait", () => {
    const msgs = [user(img("old")), user(text("nouveau"), img("new"))];
    const out = filterImagesForModel(msgs);

    // Message user sans texte : il reste un tour user valide (placeholder).
    expect(out[0].content).toEqual([{ type: "text", text: IMAGE_OMITTED_TEXT }]);
    expect(imageIds(out[1])).toEqual(["b64-new"]);
  });
});

describe("filterImagesForModel — cas divers", () => {
  it("ne modifie pas les contenus texte (chaîne)", () => {
    const msgs = [{ role: "user", content: "simple texte" }];
    const out = filterImagesForModel(msgs);

    expect(out[0]).toBe(msgs[0]);
  });

  it("ne modifie aucun message quand il n'y a aucune image", () => {
    const msgs = [user(text("a")), assistantText("b"), toolResult(text("c"))];
    const out = filterImagesForModel(msgs);

    expect(out).toEqual(msgs);
  });

  it("exclut toutes les images agent quand le user n'en a jamais envoyé", () => {
    const msgs = [
      user(text("lance les tests")),
      toolResult(text("ok"), img("shot-1")),
      assistantText("terminé"),
      toolResult(text("ok2"), img("shot-2")),
    ];
    const out = filterImagesForModel(msgs);

    expect(out.flatMap(imageIds)).toEqual([]);
  });

  it("scénario complet : user(2 img) + screenshot + user(1 img)", () => {
    const msgs = [
      user(text("v1"), img("u1"), img("u2")),
      toolResult(text("rendu v1"), img("shot-v1")),
      assistantText("corrigé"),
      user(text("v2"), img("u3")),
      toolResult(text("rendu v2"), img("shot-v2")),
    ];
    const out = filterImagesForModel(msgs);

    // Anciennes images user retirées, screenshot agent retirés.
    expect(imageIds(out[0])).toEqual([]);
    expect(imageIds(out[1])).toEqual([]);
    expect(imageIds(out[3])).toEqual(["b64-u3"]);
    expect(imageIds(out[4])).toEqual([]);
    // Budget total respecté : exactement 1 image envoyée au modèle.
    expect(out.flatMap(imageIds)).toEqual(["b64-u3"]);
  });
});
