// ── Tests : cible du bouton « Réessayer » (C2) ─────────────────────────────
import { describe, expect, it } from "vitest";
import type { DisplayMessage } from "../types";
import {
  attachmentsFromDisplayMessage,
  buildRetrySendArgs,
  findRetryTargetUserMessage,
  retryTextForMessage,
} from "./retry-message";

function msg(over: Partial<DisplayMessage> & { id: string; role: DisplayMessage["role"] }): DisplayMessage {
  return { content: "", thinking: "", toolCalls: [], timestamp: 1, ...over };
}

describe("findRetryTargetUserMessage", () => {
  const user = msg({ id: "u1", role: "user", content: "Explique-moi ce bug" });
  const failed = msg({ id: "a1", role: "assistant", stopReason: "error", errorMessage: "boom" });

  it("remonte au dernier message user simple avant l'ancre", () => {
    expect(findRetryTargetUserMessage([user, failed], "a1")?.id).toBe("u1");
  });

  it("ignore les messages système/injectés (customType, injected, kind)", () => {
    const system = msg({ id: "s1", role: "user", content: "système", injected: true });
    const custom = msg({ id: "c1", role: "user", content: "cmd", customType: "pi_command" });
    const bash = msg({ id: "b1", role: "assistant", kind: "bashExecution" });
    expect(findRetryTargetUserMessage([user, system, custom, bash, failed], "a1")?.id).toBe("u1");
  });

  it("ancre inconnue → part de la fin de liste", () => {
    expect(findRetryTargetUserMessage([user, failed], "inconnu")?.id).toBe("u1");
  });

  it("aucun message user renvoyable → null", () => {
    expect(findRetryTargetUserMessage([failed], "a1")).toBeNull();
    expect(findRetryTargetUserMessage([], "a1")).toBeNull();
  });
});

describe("attachmentsFromDisplayMessage", () => {
  it("reconstruit les pièces jointes depuis les vignettes (uploadStatus done)", () => {
    const user = msg({
      id: "u1",
      role: "user",
      content: "regarde",
      attachmentRefs: [
        { id: "att-1", name: "photo.png", category: "image", size: 1234 },
        { id: "att-2", name: "notes.pdf", category: "pdf", size: 99_999 },
      ],
    });
    const atts = attachmentsFromDisplayMessage(user);
    expect(atts).toHaveLength(2);
    expect(atts[0]).toMatchObject({
      id: "att-1",
      attachmentId: "att-1",
      name: "photo.png",
      category: "image",
      mimeType: "image/png",
      size: 1234,
      uploadStatus: "done",
    });
    expect(atts[1].mimeType).toBe("application/pdf");
  });

  it("ajoute les images inline uploadées absentes des refs, sans doublon", () => {
    const user = msg({
      id: "u1",
      role: "user",
      content: "",
      attachmentRefs: [{ id: "att-1", name: "photo.png", category: "image", size: 10 }],
      images: [
        { attachmentId: "att-1", name: "photo.png", mimeType: "image/webp" },
        { attachmentId: "att-2", name: "autre.jpg", mimeType: "image/jpeg" },
      ],
    });
    const atts = attachmentsFromDisplayMessage(user);
    expect(atts.map((a) => a.id)).toEqual(["att-1", "att-2"]);
    // Le mime de l'image inline prime quand il est connu.
    expect(atts[1].mimeType).toBe("image/jpeg");
  });

  it("ignore les images legacy inline (base64 sans attachmentId)", () => {
    const user = msg({ id: "u1", role: "user", content: "x", images: [{ data: "data:image/png;base64,AAA", name: "p.png", mimeType: "image/png" }] });
    expect(attachmentsFromDisplayMessage(user)).toEqual([]);
  });
});

describe("retryTextForMessage", () => {
  it("sans pièce jointe → contenu tel quel", () => {
    expect(retryTextForMessage(msg({ id: "u1", role: "user", content: "salut" }))).toBe("salut");
  });

  it("placeholder d'affichage optimiste « 📎 nom » → texte vide (les refs sont reconstruites)", () => {
    const user = msg({
      id: "u1",
      role: "user",
      content: "📎 photo.png",
      attachmentRefs: [{ id: "att-1", name: "photo.png", category: "image", size: 10 }],
    });
    expect(retryTextForMessage(user)).toBe("");
  });

  it("message COMMITÉ (bloc de refs + texte) → seul le texte est renvoyé", () => {
    const user = msg({
      id: "u1",
      role: "user",
      content: "🖼️ **photo.png** (id: att-1, 10 B)\n\nExplique cette image",
      attachmentRefs: [{ id: "att-1", name: "photo.png", category: "image", size: 10 }],
    });
    expect(retryTextForMessage(user)).toBe("Explique cette image");
  });

  it("message commité avec pièce jointe SANS texte → texte vide", () => {
    const user = msg({
      id: "u1",
      role: "user",
      content: "📎 **notes.pdf** (id: att-2, 97.7 KB)",
      attachmentRefs: [{ id: "att-2", name: "notes.pdf", category: "pdf", size: 99_999 }],
    });
    expect(retryTextForMessage(user)).toBe("");
  });
});

describe("buildRetrySendArgs — chaîne complète du renvoi (bouton Réessayer)", () => {
  it("ancre → message d'origine → texte + pièces jointes (args de handleSend)", () => {
    const failed = msg({ id: "a1", role: "assistant", stopReason: "error", errorMessage: "boom" });
    const args = buildRetrySendArgs(
      [
        msg({
          id: "u1",
          role: "user",
          content: "🖼️ **photo.png** (id: att-1, 10 B)\n\nQue vois-tu ?",
          attachmentRefs: [{ id: "att-1", name: "photo.png", category: "image", size: 10 }],
          images: [{ attachmentId: "att-1", name: "photo.png", mimeType: "image/png" }],
        }),
        failed,
      ],
      "a1",
    );
    expect(args).not.toBeNull();
    expect(args!.text).toBe("Que vois-tu ?");
    expect(args!.attachments).toHaveLength(1);
    expect(args!.attachments[0]).toMatchObject({ attachmentId: "att-1", category: "image", uploadStatus: "done" });
  });

  it("aucun message d'origine → null (l'UI signale l'échec, rien n'est envoyé)", () => {
    const failed = msg({ id: "a1", role: "assistant", stopReason: "error" });
    expect(buildRetrySendArgs([failed], "a1")).toBeNull();
  });
});
