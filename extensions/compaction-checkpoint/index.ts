/**
 * Compaction Checkpoint Extension
 *
 * When context compaction is about to happen, this extension:
 * 1. Extracts key information from the messages that will be lost
 * 2. Saves it as individual, searchable memories (not one big blob)
 * 3. Also preserves the full compaction summary as a safety net
 *
 * After compaction, the LLM sees a hidden prompt asking it to review
 * the compacted context and save anything important to memory — this
 * leverages the LLM's intelligence to decide what's worth keeping.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import path from "path";
import os from "os";

// ─── Config ──────────────────────────────────────────────
const MEMORY_DIR = path.join(os.homedir(), ".unipi", "memory");
const MAX_CONTENT_LENGTH = 15000;
const MAX_USER_MESSAGES = 15; // Max individual user messages to extract
const MAX_USER_MSG_LENGTH = 500; // Truncate individual messages
const MAX_SUMMARY_LENGTH = 12000;

function getProjectName(cwd: string): string {
  return path.basename(cwd).replace(/[^a-zA-Z0-9_]/g, "_");
}

// ─── Direct DB Access (for programmatic storage) ─────────

function openDb(projectName: string): any | null {
  let Database: any;
  try {
    try {
      Database = require("better-sqlite3");
    } catch {
      Database = require("/usr/local/lib/node_modules/@pi-unipi/memory/node_modules/better-sqlite3");
    }
  } catch {
    return null;
  }

  const dbPath = path.join(MEMORY_DIR, projectName, "memory.db");
  const fs = require("fs");
  if (!fs.existsSync(dbPath)) return null;

  try {
    return new Database(dbPath, { readonly: false });
  } catch {
    return null;
  }
}

function storeMemory(
  projectName: string,
  title: string,
  content: string,
  type: "preference" | "decision" | "pattern" | "summary",
  tags: string[]
): boolean {
  let db: any;
  try {
    db = openDb(projectName);
    if (!db) return false;

    if (content.length > MAX_CONTENT_LENGTH) {
      content = content.slice(0, MAX_CONTENT_LENGTH) + `\n\n[... truncated]`;
    }

    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const now = new Date().toISOString();
    const tagsJson = JSON.stringify(tags);

    const existing = db.prepare("SELECT id, created FROM memories WHERE id = ?").get(id) as { id: string; created: string } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE memories SET content = ?, tags = ?, type = ?, updated = ?, embedding = NULL
        WHERE id = ?
      `).run(content, tagsJson, type, now, id);
    } else {
      db.prepare(`
        INSERT INTO memories (id, title, content, tags, project, type, created, updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, title, content, tagsJson, projectName, type, now, now);
    }

    return true;
  } catch (err) {
    console.warn(`[compaction-checkpoint] DB error: ${(err as Error).message}`);
    return false;
  } finally {
    if (db) db.close();
  }
}

// ─── Message Extraction ──────────────────────────────────

interface ExtractedInfo {
  userRequests: string[];
  previousSummary: string | null;
  fileOps: { read: string[]; modified: string[] };
}

function extractFromMessages(messages: any[]): ExtractedInfo {
  const userRequests: string[] = [];
  let previousSummary: string | null = null;
  const readFileOps = new Set<string>();
  const modifiedFileOps = new Set<string>();

  for (const msg of messages) {
    // Extract user messages
    if (msg.role === "user") {
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text || "")
          .join("\n");
      }
      if (text.trim()) {
        userRequests.push(text.trim().slice(0, MAX_USER_MSG_LENGTH));
      }
    }

    // Extract compaction summaries (preserve the last one)
    if (msg.role === "compactionSummary" && msg.summary) {
      previousSummary = msg.summary;
    }

    // Extract file operations from tool calls
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "toolCall" && block.arguments) {
          const args = block.arguments;
          const p = typeof args.path === "string" ? args.path : undefined;
          if (!p) continue;
          switch (block.name) {
            case "read": readFileOps.add(p); break;
            case "write": modifiedFileOps.add(p); break;
            case "edit": modifiedFileOps.add(p); break;
          }
        }
      }
    }
  }

  return {
    userRequests: userRequests.slice(-MAX_USER_MESSAGES),
    previousSummary,
    fileOps: {
      read: [...readFileOps].sort(),
      modified: [...modifiedFileOps].sort(),
    },
  };
}

// ─── Extension ──────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ─── BEFORE compaction: extract key info from messages about to be lost ───
  // We don't block compaction — just extract what we can programmatically
  // and inject a prompt for the LLM to save memories after compaction.

  pi.on("session_compact", async (event, ctx) => {
    const { compactionEntry } = event;
    if (!compactionEntry?.summary) return;

    const projectName = getProjectName(ctx.cwd);
    const tokensBefore = compactionEntry.tokensBefore?.toLocaleString() ?? "unknown";

    // ─── 1. Store the full compaction summary as a safety net ───
    let summaryContent = `## Compaction checkpoint (${tokensBefore} tokens)\n\n`;
    summaryContent += `*This checkpoint preserves the full compaction summary before it gets re-compressed by a future compaction.*\n\n`;
    summaryContent += "---\n\n";
    summaryContent += compactionEntry.summary;

    // Append file operations
    const details = compactionEntry.details as { readFiles?: string[]; modifiedFiles?: string[] } | undefined;
    if (details?.modifiedFiles?.length || details?.readFiles?.length) {
      summaryContent += "\n\n---\n\n## File operations\n";
      if (details.modifiedFiles?.length) {
        summaryContent += `\n**Modified:**\n${details.modifiedFiles.map((f: string) => `- \`${f}\``).join("\n")}`;
      }
      if (details.readFiles?.length) {
        summaryContent += `\n**Read:**\n${details.readFiles.map((f: string) => `- \`${f}\``).join("\n")}`;
      }
    }

    storeMemory(
      projectName,
      `Compaction checkpoint: ${projectName}`,
      summaryContent,
      "summary",
      ["compaction-checkpoint", "auto", projectName]
    );

    // ─── 2. Ask the LLM to save important things from the compacted context ───
    // The compaction summary is fresh in context — this is the perfect time
    // for the LLM to review it and extract individual memories.
    pi.sendMessage(
      {
        customType: "compaction-checkpoint-save-memories",
        content: [
          "🔄 **Context was just compacted** (" + tokensBefore + " tokens → summary).",
          "",
          "A compaction summary has been generated. You can see it above in the conversation.",
          "",
          "**Please review the summary and save any important information to memory:**",
          "- User preferences you discovered (coding style, language, workflow)",
          "- Project decisions made (architecture, libraries, naming)",
          "- Errors encountered and their solutions",
          "- Important patterns or conventions",
          "",
          "Use `memory_store` for each important item. Update existing memories if they already exist.",
          "Don't save the compaction summary itself — it's already saved automatically.",
          "Focus on the specific, actionable details that would be useful in future sessions.",
        ].join("\n"),
        display: false,
      },
      {
        deliverAs: "nextTurn",
      }
    );
  });
}