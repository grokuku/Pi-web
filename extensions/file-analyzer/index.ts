/**
 * File Analyzer Extension for Pi-Web
 *
 * Provides the `analyze_file` tool so the LLM can read attached files
 * (PDFs, images, text, etc.) on demand instead of loading them all into context.
 *
 * The extension calls the Pi-Web backend API to perform the actual analysis
 * (PDF text extraction, image base64, etc.) and returns the result to the LLM.
 *
 * Uses plain JSON Schema for parameters (zero dependencies).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── Config ──────────────────────────────────────────────
const PI_WEB_URL = process.env.PI_WEB_URL || "http://localhost:3000";

export default function (pi: ExtensionAPI) {
  console.log("[file-analyzer] Extension loaded, registering analyze_file tool...");
  pi.registerTool({
    name: "analyze_file",
    label: "Analyze File",
    description:
      "Analyze an attached file by its ID. Returns extracted text (for PDFs/text), " +
      "or an image description (via the configured vision model). " +
      "Use this when the user references an attached file or asks about file content. " +
      "The file_id comes from attachment references like 📎 filename.pdf (id: abc123).",
    promptSnippet: "Analyze an attached file by ID",
    promptGuidelines: [
      "Always use analyze_file when the user asks about an attached file",
      "For images, the tool calls the configured vision model and returns a description",
      "For PDFs, the tool extracts text content",
      "For text/code files, the tool returns the file content",
    ],
    parameters: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "The ID of the attached file (from the attachment reference in the conversation)",
        },
        query: {
          type: "string",
          description: "What you want to know about the file (e.g., 'summarize this document', 'extract key points')",
        },
        page: {
          type: "number",
          description: "For PDFs, specific page number to extract (1-indexed)",
        },
      },
      required: ["file_id"],
    } as any,
    async execute(_toolCallId: string, params: { file_id: string; query?: string; page?: number }, _signal: AbortSignal, _onUpdate: any, _ctx: any) {
      const { file_id, query, page } = params;

      try {
        // Call the Pi-Web backend API
        const url = new URL(`${PI_WEB_URL}/api/attachments/${encodeURIComponent(file_id)}/analyze`);
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: query || "describe this file", page }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return {
            content: [{
              type: "text" as const,
              text: `Error analyzing file: ${response.status} ${response.statusText}\n${errorText}`,
            }],
          };
        }

        const result = await response.json() as {
          content: string;
          type: string;
          pages?: number;
        };

        // Return the analysis result as text
        return {
          content: [{
            type: "text" as const,
            text: result.content,
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to analyze file ${file_id}: ${err.message}\n\nThe file may not be found on the server, or the Pi-Web backend may not be running.`,
          }],
        };
      }
    },
  });

  // Also register a command for listing attachments
  pi.registerCommand("attachments", {
    description: "List all attached files",
    handler: async (_args: string, ctx: any) => {
      try {
        const projectId = ctx.cwd ? ctx.cwd.split("/").pop() || "" : "";
        const url = new URL(`${PI_WEB_URL}/api/attachments`);
        if (projectId) url.searchParams.set("projectId", projectId);

        const response = await fetch(url);
        if (!response.ok) {
          ctx.ui.notify(`Error listing attachments: ${response.status}`, "error");
          return;
        }

        const data = await response.json() as { attachments: Array<any> };
        const attachments = data.attachments || [];

        if (attachments.length === 0) {
          ctx.ui.notify("No attachments found", "info");
          return;
        }

        const lines = attachments.map((a: any) =>
          `  📎 ${a.name} (${a.category}, ${formatSize(a.size)}) — id: ${a.id}`
        );
        ctx.ui.notify(`Attachments (${attachments.length}):\n${lines.join("\n")}`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Error: ${err.message}`, "error");
      }
    },
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}