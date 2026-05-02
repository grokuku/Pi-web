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
import modelLibraryRouter from "./routes/model-library.js";
import filesRouter from "./routes/files.js";
import {
  createPiSession,
  subscribeToEvents,
  sendPrompt,
  steerPrompt,
  abortPi,
  getSession,
  getSessionInfo,
  getSessionMessages,
  disposeAllSessions,
  listSessions,
  newSession as newPiSession,
  compactSession,
  setModel,
  setThinkingLevel,
  cycleModel,
} from "./pi/session.js";
import {
  createTerminal,
  writeToTerminal,
  resizeTerminal,
  killTerminal,
  killAllTerminals,
  getTerminalBuffer,
  terminalEvents,
} from "./terminal/pty.js";
import { getProject, getAllProjects } from "./projects/manager.js";
import { credentialStore } from "./projects/credential-store.js";
import { syncGitInfo } from "./projects/git.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

// ─── Express App ───────────────────────────────────────
const app = express();

// CORS: restrict to same origin in production, allow localhost for dev
app.use(cors({
  origin: process.env.NODE_ENV === "development"
    ? true // Allow all origins in dev
    : ["http://localhost:3000", "http://localhost:3005"], // Restrict in prod
}));
app.use(express.json({ limit: "50mb" }));

// API Routes
app.use("/api/projects", projectsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/ollama", ollamaRouter);
app.use("/api/model-library", modelLibraryRouter);
app.use("/api/files", filesRouter);

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

// ── REST API for session history (for reconnection) ──
app.get("/api/sessions/:projectId/history", (req, res) => {
  const { projectId } = req.params;
  const messages = getSessionMessages(projectId);
  res.json({ messages });
});

app.get("/api/sessions/:projectId/info", (req, res) => {
  const { projectId } = req.params;
  const info = getSessionInfo(projectId);
  res.json(info);
});

// ─── HTTP Server ───────────────────────────────────────
const httpServer = createServer(app);

// ─── WebSocket Server (same HTTP port) ──────────────
const wss = new WebSocketServer({ server: httpServer });

interface ExtendedWS extends WebSocket {
  isAlive: boolean;
  projectId?: string;  // Track which project this client is viewing
}

wss.on("connection", (ws: ExtendedWS) => {
  ws.isAlive = true;
  let cleanedUp = false;
  console.log("WebSocket client connected");

  // Ping/pong to keep alive
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  // ── Subscribe to Pi events (routed by projectId) ──
  const unsub = subscribeToEvents((event, projectId) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "pi_event", event, projectId }));
    }
  });

  // ── Subscribe to terminal events ──
  const onTermData = (data: { projectId: string; data: string }) => {
    if (ws.readyState === ws.OPEN) {
      // Only send terminal data for the project this client is interested in
      // (or send all and let the frontend filter)
      ws.send(JSON.stringify({ type: "terminal_data", ...data }));
    }
  };
  const onTermExit = (data: { projectId: string; exitCode: number; signal: number }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "terminal_exit", ...data }));
    }
  };

  terminalEvents.on("data", onTermData);
  terminalEvents.on("exit", onTermExit);

  // ── Send initial state (all active sessions) ──
  const projects = getAllProjects();
  const activeSessions: Record<string, any> = {};
  for (const project of projects) {
    const info = getSessionInfo(project.id);
    if (info) {
      activeSessions[project.id] = info;
    }
  }

  ws.send(
    JSON.stringify({
      type: "connected",
      data: {
        activeSessions,
        // Backward compat: return first active session
        session: Object.values(activeSessions)[0] || null,
      },
    })
  );

  // ── Cleanup helper (idempotent) ──
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    console.log("WebSocket client disconnected");
    unsub();
    terminalEvents.off("data", onTermData);
    terminalEvents.off("exit", onTermExit);
    // IMPORTANT: Do NOT kill all terminals or sessions on disconnect!
    // Sessions and terminals persist across WebSocket reconnections.
  };

  // ── Message handler ──
  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      await handleWsMessage(ws, msg);
    } catch (e) {
      console.error("WS message error:", e);
      const errorMessage = e instanceof Error ? e.message : "Unknown error";
      ws.send(
        JSON.stringify({ type: "error", error: errorMessage })
      );
    }
  });

  // ── Close handler ──
  ws.on("close", cleanup);
  ws.on("error", cleanup);
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
async function handleWsMessage(ws: ExtendedWS, msg: any) {
  // Always update ws.projectId when a projectId is provided
  // This ensures fallback routing uses the latest project context
  if (msg.projectId) ws.projectId = msg.projectId;

  const projectId = msg.projectId || ws.projectId || "";

  switch (msg.type) {
    // ── Pi Actions (now project-scoped) ──
    case "pi_start": {
      const pid = msg.projectId || projectId;
      if (!pid) {
        ws.send(JSON.stringify({ type: "error", error: "projectId is required" }));
        return;
      }
      const project = getProject(pid);
      const cwd = project?.cwd || process.cwd();

      try {
        const state = await createPiSession(cwd, pid, {
          resume: msg.resume !== false, // Resume by default!
          sessionId: msg.sessionId,
        });

        // Sync git info
        if (project) {
          try { await syncGitInfo(project); } catch {}
        }

        ws.send(
          JSON.stringify({
            type: "pi_started",
            data: {
              cwd,
              projectId: pid,
              sessionId: state.session?.sessionId,
              resumed: !!state.session?.sessionId, // Indicate if this was a resume
            },
          })
        );

        // Send full message history for UI reconstruction
        if (state.session) {
          const messages = state.session.messages || [];
          ws.send(JSON.stringify({
            type: "pi_history",
            projectId: pid,
            messages: messages.map((m: any) => {
              // Serialize fully to allow UI reconstruction.
              // Each message can be UserMessage, AssistantMessage, ToolResultMessage,
              // or custom (bashExecution, compactionSummary, etc.)
              const base: any = {
                id: m.id,
                role: m.role,
                timestamp: m.timestamp,
              };

              if (m.role === "user") {
                // UserMessage: content can be string or content block array
                base.content = m.content;
              } else if (m.role === "assistant") {
                // AssistantMessage: content is array of blocks (text, thinking, tool_use, toolCall, etc.)
                // Normalize content blocks so the frontend always gets a consistent format
                const rawContent = Array.isArray(m.content) ? m.content : m.content;
                base.content = Array.isArray(rawContent)
                  ? rawContent.map((b: any) => {
                      // Normalize tool call blocks: "tool_use" → "toolCall"
                      if (b.type === "tool_use" || b.type === "function") {
                        return {
                          ...b,
                          type: "toolCall",
                          // Normalize property names: input → arguments, toolName → name
                          name: b.name || b.toolName || "unknown",
                          arguments: b.arguments || b.input || b.args || {},
                        };
                      }
                      return b;
                    })
                  : rawContent;
                base.usage = m.usage;
                // Extract thinking from content blocks
                base.thinking = Array.isArray(base.content)
                  ? base.content.filter((b: any) => b.type === "thinking").map((b: any) => b.thinking || "").join("")
                  : undefined;
              } else if (m.role === "toolResult") {
                // ToolResultMessage
                base.toolCallId = m.toolCallId;
                base.toolName = m.toolName;
                base.content = m.content;
                base.details = m.details;
              } else if (m.role === "bashExecution") {
                base.command = m.command;
                base.output = m.output;
                base.exitCode = m.exitCode;
                base.cancelled = m.cancelled;
              } else if (m.role === "compactionSummary") {
                base.summary = m.summary;
                base.tokensBefore = m.tokensBefore;
              } else if (m.role === "custom") {
                base.content = m.content;
                base.customType = m.customType;
                base.display = m.display;
                base.details = m.details;
              }

              return base;
            }),
          }));
        }
      } catch (e: any) {
        console.error("Failed to create/resume Pi session:", e);
        ws.send(
          JSON.stringify({ type: "error", error: `Failed to start Pi session: ${e.message}` })
        );
      }
      break;
    }

    // ── Request history refresh for a project's active session ──
    case "pi_history_request": {
      const state = getSession(projectId);
      if (state?.session) {
        const messages = state.session.messages || [];
        ws.send(JSON.stringify({
          type: "pi_history",
          projectId,
          messages: messages.map((m: any) => {
            const base: any = {
              id: m.id,
              role: m.role,
              timestamp: m.timestamp,
            };
            if (m.role === "user") {
              base.content = m.content;
            } else if (m.role === "assistant") {
                // Normalize content blocks: "tool_use"/"function" → "toolCall"
                const rawContent2 = Array.isArray(m.content) ? m.content : m.content;
                base.content = Array.isArray(rawContent2)
                  ? rawContent2.map((b: any) => {
                      if (b.type === "tool_use" || b.type === "function") {
                        return {
                          ...b,
                          type: "toolCall",
                          name: b.name || b.toolName || "unknown",
                          arguments: b.arguments || b.input || b.args || {},
                        };
                      }
                      return b;
                    })
                  : rawContent2;
                base.usage = m.usage;
                base.thinking = Array.isArray(base.content)
                  ? base.content.filter((b: any) => b.type === "thinking").map((b: any) => b.thinking || "").join("")
                  : undefined;
            } else if (m.role === "toolResult") {
              base.toolCallId = m.toolCallId;
              base.toolName = m.toolName;
              base.content = m.content;
              base.details = m.details;
            } else if (m.role === "bashExecution") {
              base.command = m.command;
              base.output = m.output;
              base.exitCode = m.exitCode;
              base.cancelled = m.cancelled;
            } else if (m.role === "compactionSummary") {
              base.summary = m.summary;
              base.tokensBefore = m.tokensBefore;
            } else if (m.role === "custom") {
              base.content = m.content;
              base.customType = m.customType;
              base.display = m.display;
              base.details = m.details;
            }
            return base;
          }),
        }));
      }
      break;
    }

    // ── List available sessions for a project ──
    case "pi_list_sessions": {
      const project = getProject(projectId);
      if (!project) {
        ws.send(JSON.stringify({ type: "error", error: "Project not found" }));
        return;
      }
      try {
        const sessions = await listSessions(project.cwd);
        ws.send(JSON.stringify({ type: "pi_sessions_list", projectId, sessions }));
      } catch (e: any) {
        ws.send(JSON.stringify({ type: "error", error: e.message }));
      }
      break;
    }

    case "pi_prompt": {
      const pid = msg.projectId || projectId;
      if (!pid) {
        ws.send(JSON.stringify({ type: "error", error: "projectId is required" }));
        return;
      }
      const { message, images } = msg;
      try {
        const result = await sendPrompt(message, pid, images);
        // If it was a slash command, send the result back
        if (result && result.command) {
          ws.send(JSON.stringify({
            type: "pi_command_result",
            projectId: pid,
            command: result.command,
            result: result.result,
          }));
        }
      } catch (e: any) {
        ws.send(JSON.stringify({ type: "error", error: e.message }));
      }
      break;
    }

    case "pi_abort": {
      const pid = msg.projectId || projectId;
      try {
        await abortPi(pid);
      } catch (e: any) {
        ws.send(JSON.stringify({ type: "error", error: e.message }));
      }
      break;
    }

    case "pi_steer": {
      const pid = msg.projectId || projectId;
      const { message } = msg;
      if (!message) break;
      try {
        await steerPrompt(message, pid);
      } catch (e: any) {
        ws.send(JSON.stringify({ type: "error", error: e.message }));
      }
      break;
    }

    // ── Terminal Actions (now project-scoped, persist across connections) ──
    case "terminal_input": {
      const { projectId: termProjectId, data } = msg;
      writeToTerminal(termProjectId || projectId, data);
      break;
    }

    case "terminal_resize": {
      const { projectId: termProjectId, cols, rows } = msg;
      resizeTerminal(termProjectId || projectId, cols, rows);
      break;
    }

    case "terminal_create": {
      const { projectId: termProjectId, cwd } = msg;
      const pid = termProjectId || projectId;
      const project = getProject(pid);
      const termCwd = cwd || project?.cwd || process.cwd();
      createTerminal(pid, termCwd);
      break;
    }

    case "terminal_kill": {
      const { projectId: termProjectId } = msg;
      killTerminal(termProjectId || projectId);
      break;
    }

    // ── Request terminal buffer (for reconnection) ──
    case "terminal_buffer": {
      const pid = msg.projectId || projectId;
      const buffer = getTerminalBuffer(pid);
      ws.send(JSON.stringify({
        type: "terminal_buffer",
        projectId: pid,
        buffer,
      }));
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

// ─── Global error handler (catch unhandled errors) ────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[Express] Unhandled error:", err);
  const message = err?.message || (typeof err === "string" ? err : "Internal server error");
  res.status(500).json({ error: message });
});

// ─── Start Server ──────────────────────────────────────
httpServer.listen(PORT, () => {
  // Re-create temp files for any persisted credentials (needed by GIT_ASKPASS)
  credentialStore.ensureTempFiles();

  console.log(`
  ╔══════════════════════════════════════════╗
  ║  ⚡ PI-WEB  ███▓▓▒▒░░  v2.0  ░░▒▒▓▓███  ║
  ╠══════════════════════════════════════════╣
  ║  HTTP+WS → http://localhost:${PORT}                  ║
  ║  Mode  → ${process.env.NODE_ENV || "development"}                     ║
  ╚══════════════════════════════════════════╝
  `);
});

// Graceful shutdown
const shutdown = async () => {
  console.log("Shutting down...");
  clearInterval(interval);
  // Don't kill terminals on shutdown — they should persist
  // (In production with tmux, they'd survive process restarts)
  await disposeAllSessions();
  wss.close();
  httpServer.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);