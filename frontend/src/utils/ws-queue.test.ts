// ── Tests unitaires : file d'attente WS (dédoublonnage « dernier gagne ») ──
// Régression 6210d1c : pi_history_request doit être remis en file si le WS est
// coupé, SANS rafale de N demandes identiques au retour de la connexion.
import { describe, it, expect } from "vitest";
import { upsertDedup, type QueueableMessage } from "./ws-queue";

const DEDUP = new Set(["pi_history_request"]);

describe("upsertDedup", () => {
  it("remplace sur place le doublon (même type + même projectId) — dernier gagne", () => {
    const queue: QueueableMessage[] = [
      { type: "pi_start", projectId: "p1" },
      { type: "pi_history_request", projectId: "p1", ts: 1 },
    ];
    const out = upsertDedup(queue, { type: "pi_history_request", projectId: "p1", ts: 2 }, DEDUP);
    expect(out).not.toBe(queue); // nouvelle instance (immutabilité)
    expect(out).toHaveLength(2);
    // Position d'origine conservée → l'ordre relatif avec pi_start est intact.
    expect(out[0].type).toBe("pi_start");
    expect(out[1]).toMatchObject({ type: "pi_history_request", ts: 2 });
  });

  it("n'empile pas : le doublon est remplacé, pas ajouté en fin de file (dernier gagne)", () => {
    // Contrat : upsertDedup NE pousse JAMAIS — il remplace si un doublon
    // existe. L'appelant (useWebSocket.send) pousse uniquement quand la file
    // est retournée inchangée (même référence).
    let queue: QueueableMessage[] = [{ type: "pi_history_request", projectId: "p1", ts: 1 }];
    let replaced = upsertDedup(queue, { type: "pi_history_request", projectId: "p1", ts: 2 }, DEDUP);
    expect(replaced).toHaveLength(1);
    expect(replaced[0].ts).toBe(2);
    replaced = upsertDedup(replaced, { type: "pi_history_request", projectId: "p1", ts: 3 }, DEDUP);
    expect(replaced).toHaveLength(1);
    expect(replaced[0].ts).toBe(3);
  });

  it("garde des demandes de projets DIFFÉRENTS : une demande par projet (pas de remplacement)", () => {
    // La demande de p2 ne remplace PAS celle de p1 → la file est retournée
    // inchangée (même référence) et l'appelant poussera p2 séparément.
    const queue: QueueableMessage[] = [{ type: "pi_history_request", projectId: "p1" }];
    const msg2: QueueableMessage = { type: "pi_history_request", projectId: "p2" };
    const out = upsertDedup(queue, msg2, DEDUP);
    expect(out).toBe(queue); // inchangé → l'appelant push le nouveau message
    expect(out[0].projectId).toBe("p1");
  });

  it("ne touche pas les types hors liste de dédoublonnage (les prompts s'empilent)", () => {
    const queue: QueueableMessage[] = [{ type: "pi_prompt", projectId: "p1", message: "a" }];
    const out = upsertDedup(queue, { type: "pi_prompt", projectId: "p1", message: "b" }, DEDUP);
    expect(out).toBe(queue); // inchangé (par référence)
    expect(out).toHaveLength(1);
  });

  it("message sans projectId : pas de dédoublonnage (file inchangée)", () => {
    const queue: QueueableMessage[] = [{ type: "pi_history_request" }];
    const out = upsertDedup(queue, { type: "pi_history_request" }, DEDUP);
    expect(out).toBe(queue);
    expect(out).toHaveLength(1);
  });
});