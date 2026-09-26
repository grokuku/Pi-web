/**
 * Tests du filtrage serveur des événements de terminal (correctif SEC-07).
 *
 * On vérifie avec deux sockets / deux projets qu'un socket n'est servi que pour
 * les projets auxquels il est abonné, ainsi que la stratégie anti-course
 * (données émises avant l'abonnement) : un socket non abonné ne reçoit rien,
 * puis reçoit bien après l'ajout du projet (ce que fait `terminal_create`).
 */
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { sendTerminalData, sendTerminalExit, type TerminalSocketLike } from "./terminal-broadcast.js";

interface FakeSocket extends TerminalSocketLike {
  sent: any[];
}

function makeSocket(subscriptions: string[] = [], readyState: number = WebSocket.OPEN): FakeSocket {
  const sent: any[] = [];
  return {
    readyState,
    subscribedProjects: new Set(subscriptions),
    sent,
    send(data: string) {
      sent.push(JSON.parse(data));
    },
  };
}

describe("terminal-broadcast — filtrage par abonnement (SEC-07)", () => {
  it("socket abonné à P1 reçoit les données de P1, pas celles de P2", () => {
    const socket = makeSocket(["P1"]);
    expect(sendTerminalData(socket, { projectId: "P1", data: "hello-p1" })).toBe(true);
    expect(sendTerminalData(socket, { projectId: "P2", data: "hello-p2" })).toBe(false);
    expect(socket.sent).toEqual([{ type: "terminal_data", projectId: "P1", data: "hello-p1" }]);
  });

  it("deux sockets sur deux projets ne reçoivent que leur propre sortie", () => {
    const socketP1 = makeSocket(["P1"]);
    const socketP2 = makeSocket(["P2"]);
    sendTerminalData(socketP1, { projectId: "P1", data: "a" });
    sendTerminalData(socketP2, { projectId: "P2", data: "b" });
    sendTerminalData(socketP1, { projectId: "P2", data: "b" });

    expect(socketP1.sent.map((m) => m.data)).toEqual(["a"]);
    expect(socketP2.sent.map((m) => m.data)).toEqual(["b"]);
  });

  it("terminal_exit est filtré de la même façon", () => {
    const socket = makeSocket(["P1"]);
    expect(sendTerminalExit(socket, { projectId: "P2", exitCode: 0, signal: 0 })).toBe(false);
    expect(sendTerminalExit(socket, { projectId: "P1", exitCode: 1, signal: 0 })).toBe(true);
    expect(socket.sent).toEqual([{ type: "terminal_exit", projectId: "P1", exitCode: 1, signal: 0 }]);
  });

  it("un socket fermé ne reçoit rien même s'il est abonné", () => {
    const socket = makeSocket(["P1"], WebSocket.CLOSED);
    expect(sendTerminalData(socket, { projectId: "P1", data: "x" })).toBe(false);
    expect(socket.sent).toEqual([]);
  });

  it("anti-course : données émises AVANT l'abonnement ignorées, puis délivrées après", () => {
    const socket = makeSocket([]);
    // La course redoutée : la première sortie arrive avant le {type:"subscribe"}.
    expect(sendTerminalData(socket, { projectId: "P1", data: "early" })).toBe(false);
    expect(socket.sent).toEqual([]);

    // terminal_create ajoute le projet aux abonnements AVANT createTerminal.
    socket.subscribedProjects.add("P1");
    // Le rejeu de tampon émis par createTerminal est alors bien délivré.
    expect(sendTerminalData(socket, { projectId: "P1", data: "buffer", isBuffer: true })).toBe(true);
    expect(socket.sent).toEqual([
      { type: "terminal_data", projectId: "P1", data: "buffer", isBuffer: true },
    ]);
  });
});
