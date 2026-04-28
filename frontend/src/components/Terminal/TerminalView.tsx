import { Terminal as XtermTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { useEffect, useRef } from "react";
import type { Project } from "../../types";

interface Props {
  send: (msg: any) => void;
  on: (type: string, cb: (msg: any) => void) => () => void;
  activeProject: Project | null;
}

export function TerminalView({ send, on, activeProject }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current || !activeProject) return;

    // Clean up previous
    if (terminalRef.current) {
      terminalRef.current.dispose();
    }

    const term = new XtermTerminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 14,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      theme: {
        background: "#0a0a0a",
        foreground: "#c0c0c0",
        cursor: "#00ff41",
        cursorAccent: "#0a0a0a",
        selectionBackground: "#00ff4120",
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

    // Fit initially and on resize
    fitAddon.fit();

    const handleResize = () => {
      fitAddon.fit();
      send({
        type: "terminal_resize",
        projectId: activeProject.id,
        cols: term.cols,
        rows: term.rows,
      });
    };

    const resizeObserver = new ResizeObserver(() => handleResize());
    resizeObserver.observe(containerRef.current);

    // Send input to backend
    term.onData((data) => {
      send({
        type: "terminal_input",
        projectId: activeProject.id,
        data,
      });
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Request terminal creation
    send({
      type: "terminal_create",
      projectId: activeProject.id,
      cwd: activeProject.cwd,
    });

    // Listen for terminal output from backend
    const unsub = on("terminal_data", (msg: any) => {
      if (msg.projectId === activeProject.id) {
        term.write(msg.data);
      }
    });

    // Listen for terminal exit
    const unsubExit = on("terminal_exit", (msg: any) => {
      if (msg.projectId === activeProject.id) {
        term.writeln(
          `\r\n\x1b[33m[Process exited with code ${msg.exitCode}]\x1b[0m`
        );
      }
    });

    return () => {
      unsub();
      unsubExit();
      resizeObserver.disconnect();
      send({ type: "terminal_kill", projectId: activeProject.id });
      term.dispose();
      terminalRef.current = null;
    };
  }, [activeProject?.id]);

  return (
    <div className="h-full w-full p-0.5">
      <div
        ref={containerRef}
        className="h-full w-full border-terminal bg-[#0a0a0a]"
      />
      {!activeProject && (
        <div className="h-full flex items-center justify-center text-hacker-text-dim">
          <span>Select a project to open terminal...</span>
        </div>
      )}
    </div>
  );
}
