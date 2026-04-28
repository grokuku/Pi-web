import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer, type WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";

import projectsRouter from "./routes/projects.js";
import settingsRouter from "./routes/settings.js";
import ollamaRouter from "./routes/ollama.js";
import {
  createPiSession,
  subscribeToEvents,
  sendPrompt,
  abortPi,
  getCurrentSession,
} from "./pi/session.js";
import {
  createTerminal,
  writeToTerminal,
  resizeTerminal,
  killTerminal,
  killAllTerminals,
  terminalEvents,
} from "./terminal/pty.js";
import { getProject } from "./projects/manager.js";
import { syncGitInfo } from "./projects/git.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

// ─── Express App ───────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// API Routes
app.use("/api/projects", projectsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/ollama", ollamaRouter);

// Serve frontend in production
const frontendDist = path.join(__dirname, "..", "..", "frontend", "dist");
if (existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── HTTP Server ───────────────────────────────────────
const httpServer = createServer(app);

// ─── WebSocket Server (same HTTP port) ──────────────
const wss = new WebSocketServer({ server: httpServer });

interface ExtendedWS extends WebSocket {
  isAlive: boolean;
}

wss.on("connection", (ws: ExtendedWS) => {
  ws.isAlive = true;
  console.log("WebSocket client connected");

  // Ping/pong to keep alive
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      await handleWsMessage(ws, msg);
    } catch (e) {
      console.error("WS message error:", e);
      ws.send(
        JSON.stringify({ type: "error", error: "Invalid message format" })
      );
    }
  });

  ws.on("close", () => {
    console.log("WebSocket client disconnected");
    unsub();
    terminalEvents.off("data", onTermData);
    terminalEvents.off("exit", onTermExit);
    killAllTerminals();
  });

  // Send initial state
  ws.send(
    JSON.stringify({
      type: "connected",
      data: getCurrentSession().session
        ? {
            sessionId: getCurrentSession()!.session!.sessionId,
            isStreaming: getCurrentSession().isStreaming,
            cwd: getCurrentSession().cwd,
          }
        : null,
    })
  );

  // Subscribe to Pi events
  const unsub = subscribeToEvents((event) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "pi_event", event }));
    }
  });

  // Subscribe to terminal events
  const onTermData = (data: { projectId: string; data: string }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "terminal_data", ...data }));
    }
  };
  const onTermExit = (data: {
    projectId: string;
    exitCode: number;
    signal: number;
  }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "terminal_exit", ...data }));
    }
  };

  terminalEvents.on("data", onTermData);
  terminalEvents.on("exit", onTermExit);
});

// Keep-alive interval
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    const ext = ws as ExtendedWS;
    if (!ext.isAlive) return ws.terminate();
    ext.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on("close", () => clearInterval(interval));

// ─── WebSocket Message Handler ─────────────────────────
async function handleWsMessage(ws: WebSocket, msg: any) {
  switch (msg.type) {
    // ── Pi Actions ──
    case "pi_start": {
      const { projectId } = msg;
      const project = getProject(projectId);
      const cwd = project?.cwd || process.cwd();
      await createPiSession(cwd);

      // Sync git info
      if (project) {
        try {
          await syncGitInfo(project);
        } catch {}
      }

      ws.send(
        JSON.stringify({
          type: "pi_started",
          data: { cwd, projectId },
        })
      );
      break;
    }

    case "pi_prompt": {
      const { message, images } = msg;
      await sendPrompt(message, images);
      break;
    }

    case "pi_abort": {
      await abortPi();
      break;
    }

    // ── Terminal Actions ──
    case "terminal_input": {
      const { projectId, data } = msg;
      writeToTerminal(projectId, data);
      break;
    }

    case "terminal_resize": {
      const { projectId, cols, rows } = msg;
      resizeTerminal(projectId, cols, rows);
      break;
    }

    case "terminal_create": {
      const { projectId, cwd } = msg;
      createTerminal(projectId, cwd);
      break;
    }

    case "terminal_kill": {
      const { projectId } = msg;
      killTerminal(projectId);
      break;
    }

    // ── Ping ──
    case "ping": {
      ws.send(JSON.stringify({ type: "pong" }));
      break;
    }

    default: {
      ws.send(
        JSON.stringify({
          type: "error",
          error: `Unknown message type: ${msg.type}`,
        })
      );
    }
  }
}

// ─── Start Server ──────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║  ⚡ PI-WEB  ███▓▓▒▒░░  v1.0  ░░▒▒▓▓███  ║
  ╠══════════════════════════════════════════╣
  ║  HTTP+WS → http://localhost:${PORT}                  ║
  ║  Mode  → ${process.env.NODE_ENV || "development"}                     ║
  ╚══════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  killAllTerminals();
  wss.close();
  httpServer.close();
  process.exit(0);
});
