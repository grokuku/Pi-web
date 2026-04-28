import { spawn, type IPty } from "node-pty";
import { existsSync } from "fs";
import { EventEmitter } from "events";

interface TerminalSession {
  pty: IPty;
  cwd: string;
  buffer: string;
}

const terminals: Map<string, TerminalSession> = new Map();
let activeTerminalProject: string | null = null;

export const terminalEvents = new EventEmitter();

export function createTerminal(projectId: string, cwd: string): IPty {
  // Kill existing terminal for this project
  killTerminal(projectId);

  // Fallback cwd if doesn't exist
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

  const session: TerminalSession = { pty, cwd: effectiveCwd, buffer: "" };
  terminals.set(projectId, session);
  activeTerminalProject = projectId;

  pty.onData((data: string) => {
    terminalEvents.emit("data", { projectId, data });
    let buf = session.buffer + data;
    if (buf.length > 100_000) buf = buf.slice(-100_000);
    session.buffer = buf;
  });

  pty.onExit(({ exitCode, signal }) => {
    terminalEvents.emit("exit", { projectId, exitCode, signal });
    terminals.delete(projectId);
    if (activeTerminalProject === projectId) activeTerminalProject = null;
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

export function killAllTerminals(): void {
  for (const [id] of terminals) killTerminal(id);
}

export function getTerminalBuffer(projectId: string): string {
  return terminals.get(projectId)?.buffer || "";
}

export function isTerminalRunning(projectId: string): boolean {
  return terminals.has(projectId);
}
