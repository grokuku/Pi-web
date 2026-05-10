import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { useEffect, useRef } from "react";
import type { Project } from "../../types";

interface Props {
  send: (msg: any) => void;
  on: (type: string, cb: (msg: any) => void) => () => void;
  activeProject: Project | null;
  isActive: boolean;
}

export function TerminalView({ send, on, activeProject, isActive }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const projectIdRef = useRef<string | null>(null);

  // ── Create / recreate terminal when project changes ──
  useEffect(() => {
    if (!containerRef.current || !activeProject) return;

    projectIdRef.current = activeProject.id;

    // Clean up previous terminal
    if (terminalRef.current) {
      terminalRef.current.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    }

    // Read accent color from CSS variable for dynamic theme support
    const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00ff41';
    const accentDimColor = getComputedStyle(document.documentElement).getPropertyValue('--accent-dim').trim() || '#00cc34';
    const accentRgb = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || '0 255 65';
    const selectionBg = `rgba(${accentRgb}, 0.12)`;

    const term = new XtermTerminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 14,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      theme: {
        background: "#0a0a0a",
        foreground: "#c0c0c0",
        cursor: accentColor,
        cursorAccent: "#0a0a0a",
        selectionBackground: selectionBg,
        black: "#1a1a1a",
        red: "#ff4444",
        green: "#00ff41",
        yellow: "#ffaa00",
        blue: "#00aaff",
        magenta: "#aa44ff",
        cyan: "#00ffaa",
        white: "#e0e0e0",
        brightBlack: "#444444",
        brightRed: "#ff6666",
        brightGreen: "#44ff66",
        brightYellow: "#ffcc44",
        brightBlue: "#44aaff",
        brightMagenta: "#cc66ff",
        brightCyan: "#44ffcc",
        brightWhite: "#ffffff",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Send input to backend
    term.onData((data) => {
      if (projectIdRef.current) {
        send({
          type: "terminal_input",
          projectId: projectIdRef.current,
          data,
        });
      }
    });

    // Handle resize
    const handleResize = () => {
      if (!fitAddonRef.current || !terminalRef.current || !projectIdRef.current) return;
      try {
        fitAddonRef.current.fit();
        send({
          type: "terminal_resize",
          projectId: projectIdRef.current,
          cols: terminalRef.current.cols,
          rows: terminalRef.current.rows,
        });
      } catch {}
    };

    const resizeObserver = new ResizeObserver(() => handleResize());
    resizeObserver.observe(containerRef.current);

    // ── Request terminal create or reconnect ──
    // The backend will send existing buffer if terminal already exists
    send({
      type: "terminal_create",
      projectId: activeProject.id,
      cwd: activeProject.cwd,
    });

    // ── Also request existing buffer for reconnection ──
    send({
      type: "terminal_buffer",
      projectId: activeProject.id,
    });

    // Listen for terminal output from backend
    const unsub = on("terminal_data", (msg: any) => {
      if (msg.projectId === activeProject.id && terminalRef.current) {
        terminalRef.current.write(msg.data);
      }
    });

    // Listen for terminal exit
    const unsubExit = on("terminal_exit", (msg: any) => {
      if (msg.projectId === activeProject.id && terminalRef.current) {
        terminalRef.current.writeln(
          `\r\n\x1b[33m[Process exited with code ${msg.exitCode}]\x1b[0m`
        );
        // Auto-restart terminal after brief delay
        setTimeout(() => {
          if (terminalRef.current) {
            terminalRef.current.writeln(
              `\r\n\x1b[32m[Auto-restarting terminal...]\x1b[0m`
            );
            send({
              type: "terminal_create",
              projectId: activeProject.id,
              cwd: activeProject.cwd,
            });
          }
        }, 500);
      }
    });

    return () => {
      unsub();
      unsubExit();
      resizeObserver.disconnect();
      // Don't kill the remote terminal on unmount! Only dispose local UI.
      // The terminal on the server persists across reconnections.
      // send({ type: "terminal_kill", projectId: projectIdRef.current }); <-- REMOVED
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      projectIdRef.current = null;
    };
  }, [activeProject?.id]);

  // ── Fit terminal when tab becomes active ──
  useEffect(() => {
    if (isActive && terminalRef.current && fitAddonRef.current && projectIdRef.current) {
      // Small delay to let layout settle after display toggle
      const timer = requestAnimationFrame(() => {
        if (fitAddonRef.current && terminalRef.current && projectIdRef.current) {
          try {
            fitAddonRef.current.fit();
            send({
              type: "terminal_resize",
              projectId: projectIdRef.current,
              cols: terminalRef.current.cols,
              rows: terminalRef.current.rows,
            });
          } catch {}
        }
      });
      return () => cancelAnimationFrame(timer);
    }
  }, [isActive]);

  if (!activeProject) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-hacker-text-dim">
        <span>Select a project to open terminal...</span>
      </div>
    );
  }

  return (
    <div className="min-h-0 w-full flex flex-col">
      <div
        ref={containerRef}
        className="flex-1 min-h-0 border-terminal bg-[#0a0a0a]"
      />
    </div>
  );
}