import { spawn, type IPty } from "node-pty";
import { existsSync, mkdirSync } from "fs";
import { EventEmitter } from "events";
import { execSync } from "child_process";

interface TerminalSession {
  pty: IPty;
  cwd: string;
  buffer: string;
  tmuxSession?: string; // If using tmux
}

const terminals: Map<string, TerminalSession> = new Map();

export const terminalEvents = new EventEmitter();

/**
 * Check if tmux is available on the system.
 */
function hasTmux(): boolean {
  try {
    execSync("which tmux", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create or reconnect to a terminal session for a project.
 *
 * Strategy:
 * 1. If a terminal already exists for this projectId, return it (and send buffer).
 * 2. If tmux is available and a tmux session exists for this project, reconnect to it.
 * 3. Otherwise, create a new PTY (and optionally a tmux session).
 */
export function createTerminal(projectId: string, cwd: string): IPty {
  // ── Reuse existing terminal ──
  const existing = terminals.get(projectId);
  if (existing) {
    // Terminal already exists — emit buffer event for reconnection
    terminalEvents.emit("data", {
      projectId,
      data: existing.buffer,
      isBuffer: true, // Flag for frontend to distinguish from new output
    });
    return existing.pty;
  }

  // ── Create new terminal ──
  const effectiveCwd = existsSync(cwd) ? cwd : "/";
  const shell = process.platform === "win32" ? "powershell.exe" : "bash";

  const pty = spawn(shell, [], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: effectiveCwd,
    env: {
      ...(process.env as Record<string, string>),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      HOME: process.env.HOME || "/root",
    },
  });

  const session: TerminalSession = {
    pty,
    cwd: effectiveCwd,
    buffer: "",
  };

  terminals.set(projectId, session);

  pty.onData((data: string) => {
    terminalEvents.emit("data", { projectId, data });
    let buf = session.buffer + data;
    if (buf.length > 100_000) buf = buf.slice(-100_000);
    session.buffer = buf;
  });

  pty.onExit(({ exitCode, signal }) => {
    terminalEvents.emit("exit", { projectId, exitCode, signal });
    terminals.delete(projectId);
  });

  return pty;
}

export function getTerminal(projectId: string): TerminalSession | undefined {
  return terminals.get(projectId);
}

export function writeToTerminal(projectId: string, data: string): void {
  const session = terminals.get(projectId);
  if (session) session.pty.write(data);
}

export function resizeTerminal(projectId: string, cols: number, rows: number): void {
  const session = terminals.get(projectId);
  if (session && cols > 0 && rows > 0) session.pty.resize(cols, rows);
}

export function killTerminal(projectId: string): void {
  const session = terminals.get(projectId);
  if (session) {
    try { session.pty.kill(); } catch {}
    terminals.delete(projectId);
  }
}

/**
 * Kill all terminals.
 * WARNING: Only call this on server shutdown, not on WebSocket disconnect!
 */
export function killAllTerminals(): void {
  for (const [id] of terminals) killTerminal(id);
}

export function getTerminalBuffer(projectId: string): string {
  return terminals.get(projectId)?.buffer || "";
}

export function isTerminalRunning(projectId: string): boolean {
  return terminals.has(projectId);
}