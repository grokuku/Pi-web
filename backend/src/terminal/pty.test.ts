/**
 * Tests unitaires de terminal/pty.ts — UNIQUEMENT la logique pure testable
 * SANS PTY réel (aucun spawn node-pty n'est déclenché par ces tests).
 *
 * Ce qui EST testé ici :
 *  - les accès à des sessions inexistantes : valeurs par défaut et no-op
 *    silencieux (getTerminal, getTerminalBuffer, isTerminalRunning,
 *    writeToTerminal, resizeTerminal, killTerminal, killAllTerminals) ;
 *  - la validation du cwd dans createTerminal : les deux chemins d'erreur
 *    (cwd inexistant, cwd hors racines autorisées) lèvent AVANT tout spawn ;
 *  - le bus d'événements terminalEvents (EventEmitter).
 *
 * Ce qui N'EST PAS testable sans PTY réel (exclu de ce fichier) :
 *  - le spawn du shell et la détection de shell (win32 → powershell.exe,
 *    sinon bash) — dépend de process.platform et de node-pty ;
 *  - le ring buffer de 100 000 caractères (logique située dans le callback
 *    onData branché sur le pty spawné) ;
 *  - la réutilisation/reconnexion d'une session existante et la réémission
 *    du buffer avec le flag isBuffer: true ;
 *  - le nettoyage de la map de sessions sur exit du pty (callback onExit) ;
 *  - resize/write/kill sur une session réellement ouverte.
 */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "events";
import {
  createTerminal,
  getTerminal,
  getTerminalBuffer,
  isTerminalRunning,
  killAllTerminals,
  killTerminal,
  resizeTerminal,
  terminalEvents,
  writeToTerminal,
} from "./pty.js";

describe("terminalEvents (bus d'événements)", () => {
  it("est un EventEmitter qui propage les événements émis", () => {
    expect(terminalEvents).toBeInstanceOf(EventEmitter);

    const received: unknown[] = [];
    const onData = (payload: unknown) => received.push(payload);
    terminalEvents.on("data", onData);
    terminalEvents.emit("data", { projectId: "test-bus", data: "hello" });
    terminalEvents.removeListener("data", onData);

    expect(received).toEqual([{ projectId: "test-bus", data: "hello" }]);
  });
});

describe("accès à des sessions inexistantes (no-op silencieux)", () => {
  it("getTerminal retourne undefined pour un id inconnu", () => {
    expect(getTerminal("id-inconnu")).toBeUndefined();
  });

  it("getTerminalBuffer retourne une chaîne vide pour un id inconnu", () => {
    expect(getTerminalBuffer("id-inconnu")).toBe("");
  });

  it("isTerminalRunning retourne false pour un id inconnu", () => {
    expect(isTerminalRunning("id-inconnu")).toBe(false);
  });

  it("writeToTerminal sur un id inconnu n'écrit rien et ne lève pas", () => {
    expect(() => writeToTerminal("id-inconnu", "ls -la")).not.toThrow();
    // Aucune session fantôme ne doit avoir été créée.
    expect(isTerminalRunning("id-inconnu")).toBe(false);
  });

  it("resizeTerminal sur un id inconnu est un no-op, même avec des dimensions invalides", () => {
    expect(() => resizeTerminal("id-inconnu", 120, 40)).not.toThrow();
    // cols/rows <= 0 doivent être ignorés par la garde (cols > 0 && rows > 0).
    expect(() => resizeTerminal("id-inconnu", 0, 0)).not.toThrow();
    expect(() => resizeTerminal("id-inconnu", -5, -5)).not.toThrow();
    expect(isTerminalRunning("id-inconnu")).toBe(false);
  });

  it("killTerminal sur un id inconnu est un no-op silencieux", () => {
    expect(() => killTerminal("id-inconnu")).not.toThrow();
    expect(isTerminalRunning("id-inconnu")).toBe(false);
  });

  it("killAllTerminals sans session active est un no-op silencieux", () => {
    expect(() => killAllTerminals()).not.toThrow();
  });
});

describe("createTerminal — validation du cwd (avant tout spawn)", () => {
  it("rejette un cwd inexistant", () => {
    const cwd = "/pi-web-test-cwd-inexistant-4f2a/sub/dir";
    expect(() => createTerminal("pty-test-inexistant", cwd)).toThrow(
      /Terminal cwd does not exist/
    );
  });

  it("rejette un cwd existant mais hors des racines autorisées (/tmp)", () => {
    // /tmp existe toujours mais n'est ni sous /projects ni sous /mnt/smb :
    // la garde de sécurité (BUG-51/52/53) doit bloquer avant le spawn.
    expect(() => createTerminal("pty-test-hors-racine", "/tmp")).toThrow(
      /Terminal cwd is not allowed/
    );
    // Aucune session fantôme ne doit subsister après l'échec.
    expect(isTerminalRunning("pty-test-hors-racine")).toBe(false);
    expect(getTerminal("pty-test-hors-racine")).toBeUndefined();
  });
});