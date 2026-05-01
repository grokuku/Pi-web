import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Paperclip, X, Image, FileText, File, AlertTriangle } from "lucide-react";
import type { PiEvent, ToolCallInfo, Attachment } from "../../types";
import type { Project } from "../../types";
import { useChatHistory } from "../../hooks/useChatHistory";

// ── File type helpers ───────────────────────────────────

const TEXT_MIME_TYPES = new Set([
  "text/plain", "text/csv", "text/markdown", "text/html", "text/css",
  "text/xml", "text/yaml", "text/x-yaml", "application/json",
  "application/xml", "application/yaml", "application/x-yaml",
  "application/javascript", "application/typescript",
  "application/x-shellscript",
]);

const CODE_EXTENSIONS: Record<string, string> = {
  js: "javascript", ts: "typescript", tsx: "typescript", jsx: "javascript",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java",
  kt: "kotlin", swift: "swift", c: "c", cpp: "cpp", h: "c",
  hpp: "cpp", cs: "csharp", php: "php", sh: "bash", bash: "bash",
  zsh: "bash", sql: "sql", r: "r", scala: "scala", vim: "vim",
  dockerfile: "dockerfile", yaml: "yaml", yml: "yaml",
  json: "json", xml: "xml", html: "html", css: "css", scss: "scss",
  less: "less", md: "markdown", txt: "text", log: "text",
  env: "text", gitignore: "text", dockerignore: "text",
  toml: "toml", ini: "ini", cfg: "ini", conf: "nginx",
};

function categorizeFile(mimeType: string, fileName: string): Attachment["category"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";

  if (mimeType.startsWith("text/") || TEXT_MIME_TYPES.has(mimeType)) return "text";

  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  if (CODE_EXTENSIONS[ext]) return "text";

  // Common binary formats that should not be read as text
  const binaryExts = new Set([
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "zip", "tar", "gz", "bz2", "7z", "rar",
    "exe", "dll", "so", "dylib", "o", "a",
    "mp4", "avi", "mkv", "mov", "wmv", "flv",
    "mp3", "wav", "flac", "aac", "ogg", "wma", "m4a",
    "sqlite", "db", "iso", "dmg", "deb", "rpm",
  ]);
  if (binaryExts.has(ext)) return "binary";

  // Default: try to read as text
  return "text";
}

function getLanguageTag(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  return CODE_EXTENSIONS[ext] || "text";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileExtensionIcon(category: Attachment["category"], fileName: string) {
  switch (category) {
    case "image": return <Image size={14} />;
    case "text": return <FileText size={14} />;
    case "audio": return <AlertTriangle size={14} />;
    case "binary": return <File size={14} />;
  }
}

// ── Max file sizes ──────────────────────────────────────
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
const MAX_TEXT_SIZE = 2 * 1024 * 1024;    // 2 MB

interface Props {
  send: (msg: any) => void;
  on: (type: string, cb: (msg: any) => void) => () => void;
  activeProject: Project | null;
  isStreaming: boolean;
  session: any;
  projectId: string;
}

interface DisplayMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking: string;
  toolCalls: ToolCallInfo[];
  timestamp: number;
  usage?: { input: number; output: number; cost: { total: number } };
}

export function ChatView({ send, on, activeProject, isStreaming, session, projectId }: Props) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [currentToolCalls, setCurrentToolCalls] = useState<ToolCallInfo[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [showThinking, setShowThinking] = useState(true);
  const [expandTools, setExpandTools] = useState(true);
  const [thinkingLevel, setThinkingLevel] = useState<string | null>(null);
  const [thinkingToast, setThinkingToast] = useState("");
  const [error, setError] = useState("");

  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentAssistantIdRef = useRef<string | null>(null);

  // Refs to avoid stale closures in WS handler
  const streamingContentRef = useRef("");
  const streamingThinkingRef = useRef("");
  const currentToolCallsRef = useRef<ToolCallInfo[]>([]);
  const messagesRef = useRef<DisplayMessage[]>([]);

  // ── Per-project chat history (persists across project switches) ──
  const chatHistory = useChatHistory(projectId);

  // ── Restore / reset messages when projectId changes ──
  useEffect(() => {
    // Load previously stored messages for this project
    const stored = chatHistory.getMessages();
    if (stored.length > 0) {
      setMessages(stored);
    } else {
      setMessages([]);
    }
    setStreamingContent("");
    setStreamingThinking("");
    setCurrentToolCalls([]);
    setError("");
    currentAssistantIdRef.current = null;
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync messages to per-project store whenever they change ──
  useEffect(() => {
    chatHistory.saveMessages(messages);
    messagesRef.current = messages;
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep refs in sync
  useEffect(() => { streamingContentRef.current = streamingContent; }, [streamingContent]);
  useEffect(() => { streamingThinkingRef.current = streamingThinking; }, [streamingThinking]);
  useEffect(() => { currentToolCallsRef.current = currentToolCalls; }, [currentToolCalls]);

  // ── Handle pi_history (session restoration) ──
  useEffect(() => {
    const unsub = on("pi_history", (msg: any) => {
      // Only process history for this project's chat
      if (msg.projectId && msg.projectId !== projectId) return;

      if (msg.messages && Array.isArray(msg.messages) && msg.messages.length > 0) {
        console.log(`[ChatView] Restored ${msg.messages.length} messages from session history for project ${projectId}`);
        const restored = chatHistory.handleHistory(msg.messages);
        setMessages(restored);
      }
    });
    return () => unsub();
  }, [on, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Keyboard shortcuts (Pi CLI compatible) ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const tag = (e.target as HTMLElement).tagName;
      const inInput = tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT";

      // Ctrl+T → app.thinking.toggle (collapse/expand thinking blocks)
      if (mod && e.key === "t" && !shift) {
        e.preventDefault();
        setShowThinking((prev) => !prev);
        return;
      }

      // Ctrl+O → app.tools.expand (collapse/expand all tool outputs)
      if (mod && e.key === "o" && !shift) {
        e.preventDefault();
        setExpandTools((prev) => !prev);
        return;
      }

      // Shift+Tab → app.thinking.cycle (only outside input fields)
      if (shift && e.key === "Tab" && !mod && !inInput) {
        e.preventDefault();
        const levels = ["off", "minimal", "low", "medium", "high"];
        fetch("/api/settings/thinking")
          .then((r) => r.json())
          .then((data) => {
            const current = data.level || "medium";
            const idx = levels.indexOf(current);
            const next = levels[(idx + 1) % levels.length];
            setThinkingLevel(next);
            setThinkingToast(`THINKING: ${next.toUpperCase()}`);
            setTimeout(() => setThinkingToast(""), 1500);
            return fetch("/api/settings/thinking", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ level: next }),
            });
          })
          .catch(() => {});
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Auto scroll
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  // ── Pi event handling (filtered by projectId) ──
  useEffect(() => {
    const unsub = on("pi_event", (msg: any) => {
      // Only process events for this project's chat
      if (msg.projectId && msg.projectId !== projectId) return;

      const evt: PiEvent = msg.event;

      switch (evt.type) {
        case "message_start": {
          if (evt.message?.role === "assistant") {
            currentAssistantIdRef.current = evt.message.id || Date.now().toString();
            setStreamingContent("");
            setStreamingThinking("");
            setCurrentToolCalls([]);
          }
          break;
        }

        case "message_update": {
          const delta = evt.assistantMessageEvent;
          if (delta.type === "text_delta") {
            setStreamingContent((prev) => prev + delta.delta);
          }
          if (delta.type === "thinking_delta") {
            setStreamingThinking((prev) => prev + delta.delta);
          }
          if (delta.type === "toolcall_start") {
            const startArgs = extractToolArgs(delta.args);
            setCurrentToolCalls((prev) => {
              if (prev.some((tc) => tc.id === delta.toolCallId)) return prev;
              return [...prev, {
                id: delta.toolCallId, name: delta.toolName,
                args: startArgs, output: "", isError: false, isStreaming: true,
              }];
            });
          }
          if (delta.type === "toolcall_delta") {
            setCurrentToolCalls((prev) => prev.map((tc) =>
              tc.id === delta.toolCallId
                ? { ...tc, args: { ...tc.args, ...extractToolArgs(delta.argsDelta) } } : tc));
          }
          if (delta.type === "toolcall_end") {
            const endArgs = extractToolArgs(delta.toolCall);
            setCurrentToolCalls((prev) => prev.map((tc) =>
              tc.id === delta.toolCallId
                ? { ...tc, args: endArgs, isStreaming: false } : tc));
          }
          break;
        }

        case "tool_execution_start": {
          setCurrentToolCalls((prev) => prev.map((tc) =>
            tc.id === evt.toolCallId ? { ...tc, isStreaming: true } : tc));
          break;
        }

        case "tool_execution_update": {
          const partialText = evt.partialResult?.content?.map((c: any) => c.text || "").join("") || "";
          setCurrentToolCalls((prev) => prev.map((tc) =>
            tc.id === evt.toolCallId ? { ...tc, output: partialText, isStreaming: true } : tc));
          break;
        }

        case "tool_execution_end": {
          const resultText = evt.result?.content?.map((c: any) => c.text || "").join("") || "";
          setCurrentToolCalls((prev) => prev.map((tc) =>
            tc.id === evt.toolCallId
              ? { ...tc, output: resultText, isError: evt.isError, isStreaming: false } : tc));
          break;
        }

        case "message_end": {
          if (evt.message?.role === "assistant") {
            const sc = streamingContentRef.current;
            const st = streamingThinkingRef.current;
            const ct = currentToolCallsRef.current;
            const msgId = currentAssistantIdRef.current || Date.now().toString();

            // Dedup: don't add if a message with this ID already exists
            if (messagesRef.current.some((m) => m.id === msgId)) {
              setStreamingContent("");
              setStreamingThinking("");
              setCurrentToolCalls([]);
              currentAssistantIdRef.current = null;
              break;
            }

            const finalContent = sc ||
              evt.message.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") || "";
            const finalThinking = st ||
              evt.message.content?.filter((c: any) => c.type === "thinking").map((c: any) => c.thinking).join("") || "";

            if (finalContent || finalThinking || ct.length > 0) {
              const msgUsage = evt.message?.usage;
              setMessages((prev) => [...prev, {
                id: msgId,
                role: "assistant",
                content: finalContent,
                thinking: finalThinking,
                toolCalls: [...ct],
                timestamp: Date.now(),
                usage: msgUsage ? {
                  input: msgUsage.input || 0,
                  output: msgUsage.output || 0,
                  cost: { total: msgUsage.cost?.total || 0 },
                } : undefined,
              }]);
            }
            setStreamingContent("");
            setStreamingThinking("");
            setCurrentToolCalls([]);
            currentAssistantIdRef.current = null;
          }
          break;
        }
      }
    });

    return () => unsub();
  }, [on, projectId]);

  // ── File processing ──────────────────────────────────

  const processFile = useCallback((file: File) => {
    if (attachments.length >= 10) {
      setError("Maximum 10 files per message");
      return;
    }

    const category = categorizeFile(file.type || "application/octet-stream", file.name);

    // Size limits
    if (category === "image" && file.size > MAX_IMAGE_SIZE) {
      setError(`Image too large: ${formatFileSize(file.size)}. Max ${formatFileSize(MAX_IMAGE_SIZE)}.`);
      return;
    }
    if (category === "text" && file.size > MAX_TEXT_SIZE) {
      setError(`Text file too large: ${formatFileSize(file.size)}. Max ${formatFileSize(MAX_TEXT_SIZE)}.`);
      return;
    }
    if (category === "binary") {
      setError(`Cannot attach binary file: ${file.name}. Only images, text, and code files are supported.`);
      return;
    }

    const reader = new FileReader();

    if (category === "image") {
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        const attachment: Attachment = {
          id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: file.name,
          mimeType: file.type,
          size: file.size,
          category,
          data: base64,
          preview: reader.result as string, // data URL for thumbnail
        };
        setAttachments((prev) => [...prev, attachment]);
      };
      reader.readAsDataURL(file);
    } else if (category === "audio") {
      // Read as base64 but warn user
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        const attachment: Attachment = {
          id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: file.name,
          mimeType: file.type,
          size: file.size,
          category,
          data: base64,
        };
        setAttachments((prev) => [...prev, attachment]);
      };
      reader.readAsDataURL(file);
    } else {
      // Text / code file — read as text
      reader.onload = () => {
        const text = reader.result as string;
        const lang = getLanguageTag(file.name);
        // Build a formatted snippet for the preview
        const previewLines = text.split("\n").slice(0, 3).join("\n");
        const attachment: Attachment = {
          id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: file.name,
          mimeType: file.type || "text/plain",
          size: file.size,
          category,
          data: `\n\n📄 **${file.name}**\n\`\`\`${lang}\n${text}\n\`\`\`\n`,
          preview: previewLines.length > 200 ? previewLines.slice(0, 200) + "..." : previewLines,
        };
        setAttachments((prev) => [...prev, attachment]);
      };
      reader.readAsText(file);
    }
  }, [attachments.length]);

  // ── Send message ──
  const handleSend = useCallback(() => {
    const text = input.trim();

    // Collect image attachments for the SDK
    const imageAttachments = attachments
      .filter((a) => a.category === "image")
      .map((a) => ({ data: a.data, mimeType: a.mimeType }));

    // Audio attachments — warn but still send text
    const audioAttachments = attachments.filter((a) => a.category === "audio");
    if (audioAttachments.length > 0) {
      setError(`Audio files are not supported by most AI models. They will be skipped.`);
      // Remove audio attachments
      setAttachments((prev) => prev.filter((a) => a.category !== "audio"));
      return;
    }

    // Build final message: user text + text/code file contents
    let fullMessage = text;
    const textAttachments = attachments.filter((a) => a.category === "text");
    if (textAttachments.length > 0) {
      // Append text file contents to the message
      const filesContent = textAttachments.map((a) => a.data).join("");
      if (text.trim()) {
        fullMessage = `${filesContent}\n\n${text}`;
      } else {
        fullMessage = filesContent;
      }
    }

    if (!fullMessage && imageAttachments.length === 0) return;
    setError("");

    // Add user message to chat (show image thumbnails and file names)
    const displayContent = text || (textAttachments.length > 0 ? textAttachments.map((a) => `📄 ${a.name}`).join(", ") : "[images]");
    setMessages((prev) => [...prev, {
      id: Date.now().toString(),
      role: "user",
      content: displayContent,
      thinking: "",
      toolCalls: [],
      timestamp: Date.now(),
      // Store image previews for rendering
    }]);

    send({
      type: "pi_prompt",
      message: fullMessage,
      images: imageAttachments.length > 0 ? imageAttachments : undefined,
    });

    setInput("");
    setAttachments([]);
  }, [input, attachments, send]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // ── Drag & drop ──
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    for (const file of Array.from(e.dataTransfer.files)) {
      processFile(file);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (blob) processFile(blob);
      }
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      for (const file of Array.from(e.target.files)) {
        processFile(file);
      }
    }
    // Reset the input so the same file can be selected again
    e.target.value = "";
  };

  if (!activeProject) {
    return (
      <div className="h-full flex items-center justify-center text-hacker-text-dim">
        <div className="text-center">
          <div className="text-hacker-accent text-5xl mb-4 glitch">⚡</div>
          <p className="text-lg mb-2">PI CODING AGENT</p>
          <p className="text-sm">Select or create a project to begin...</p>
        </div>
      </div>
    );
  }

  const hasContent = messages.length > 0 || streamingContent || streamingThinking || currentToolCalls.length > 0;

  return (
    <div
      className="h-full flex flex-col"
      onDrop={handleDrop}
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onPaste={handlePaste}
    >
      {/* Messages */}
      {hasContent ? (
        <div className={`flex-1 overflow-y-auto p-4 chat-messages ${isDragOver ? "drop-zone active" : ""}`}>
        {isDragOver && (
          <div className="absolute inset-0 flex items-center justify-center bg-hacker-bg/80 z-20">
            <div className="text-hacker-accent text-2xl glitch">DROP FILES HERE</div>
          </div>
        )}

        {error && (
          <div className="text-hacker-error text-xs border border-hacker-error/30 p-2 mb-2">{error}</div>
        )}

        {thinkingToast && (
          <div className="text-hacker-accent text-xs border border-hacker-accent/30 p-2 mb-2 bg-hacker-accent/5">⚡ {thinkingToast}</div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} showThinking={showThinking}
            toggleThinking={() => setShowThinking((t) => !t)} expandTools={expandTools} />
        ))}

        {(streamingContent || streamingThinking || currentToolCalls.length > 0) && (
          <StreamingBubble content={streamingContent} thinking={streamingThinking}
            toolCalls={currentToolCalls} showThinking={showThinking}
            toggleThinking={() => setShowThinking((t) => !t)} expandTools={expandTools} />
        )}

        <div ref={chatEndRef} />
      </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-hacker-accent text-6xl mb-4 glitch">⚡</div>
            <p className="text-hacker-text-dim text-sm">Session active — type a message below to start</p>
            <p className="text-hacker-text-dim text-xs mt-2">
              {activeProject?.git?.branch && `git:${activeProject.git.branch} · `}
              {session?.model?.name || "No model selected"}
            </p>
          </div>
        </div>
      )}

      {/* Input area */}
      <div className="border-t border-hacker-border-bright bg-hacker-surface p-3">
        {/* Attachment previews */}
        {attachments.length > 0 && (
          <div className="flex gap-2 mb-2 flex-wrap">
            {attachments.map((att) => (
              <div key={att.id} className="flex items-center gap-1.5 text-xs bg-hacker-border/40 border border-hacker-border px-2 py-1.5 rounded group">
                {att.category === "image" && att.preview ? (
                  <img src={att.preview} alt={att.name} className="w-8 h-8 object-cover rounded" />
                ) : (
                  <span className="text-hacker-accent">{getFileExtensionIcon(att.category, att.name)}</span>
                )}
                <span className="truncate max-w-[120px]">{att.name}</span>
                <span className="text-hacker-text-dim">{formatFileSize(att.size)}</span>
                <button onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                  className="text-hacker-text-dim hover:text-hacker-error ml-1">
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isStreaming ? "Queue message (steer)..." : "Type your message... (Shift+Enter for newline)"}
            className="input-hacker flex-1 resize-none" rows={2} />

          <div className="flex flex-col gap-1">
            <button onClick={handleSend} className="btn-hacker flex-1 px-4"
              disabled={!input.trim() && attachments.length === 0}>SEND</button>
            <div className="flex gap-1">
              <button onClick={() => fileInputRef.current?.click()}
                className="btn-hacker px-2 text-xs" title="Attach file">
                <Paperclip size={14} />
              </button>
              {isStreaming && (
                <button onClick={() => send({ type: "pi_abort" })} className="btn-hacker danger px-4 text-xs">ABORT</button>
              )}
            </div>
          </div>
        </div>
        <div className="text-hacker-text-dim text-[10px] mt-1 flex justify-between">
          <span>📎 Files · Esc abort · Ctrl+L model · Ctrl+T think · Ctrl+O tools · Shift+Tab think±</span>
          <span>{activeProject?.git?.branch && `git:${activeProject.git.branch}`}</span>
        </div>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,text/*,application/json,application/xml,application/javascript,application/x-shellscript,.js,.ts,.tsx,.jsx,.py,.rb,.rs,.go,.java,.kt,.swift,.c,.cpp,.h,.hpp,.cs,.php,.sh,.bash,.sql,.yaml,.yml,.toml,.ini,.cfg,.env,.md,.txt,.log,.css,.scss,.less,.html,.svg"
        onChange={handleFileSelect}
        className="hidden"
      />
    </div>
  );
}

// ── Message Bubble ─────────────────────────────────────
function MessageBubble({ message, showThinking, toggleThinking, expandTools }: {
  message: DisplayMessage; expandTools: boolean; showThinking: boolean; toggleThinking: () => void;
}) {
  const isUser = message.role === "user";
  return (
    <div className={`mb-4 ${isUser ? "ml-8" : "mr-8"}`}>
      <div className={`text-xs mb-1 px-1 ${isUser ? "text-hacker-info text-right" : "text-hacker-accent"}`}>
        {isUser ? "▸ YOU" : "▹ ASSISTANT"}
        {message.usage && (
          <span className="text-hacker-text-dim ml-2">
            [{message.usage.input + message.usage.output} tok · ${message.usage.cost.total.toFixed(4)}]
          </span>
        )}
      </div>

      {message.thinking && (
        <div className="mb-2">
          <button onClick={toggleThinking} className="text-xs text-hacker-warn mb-1 hover:underline">
            {showThinking ? "▼" : "▶"} THINKING
          </button>
          {showThinking && (
            <div className="text-hacker-text-dim text-xs bg-hacker-bg/50 border border-hacker-border p-2 italic whitespace-pre-wrap max-h-40 overflow-y-auto">
              {message.thinking}
            </div>
          )}
        </div>
      )}

      {message.content && (
        <div className="text-sm leading-relaxed">
          {isUser ? (
            <span className="text-hacker-text-bright whitespace-pre-wrap">{message.content}</span>
          ) : (
            <MarkdownRenderer content={message.content} />
          )}
        </div>
      )}

      {message.toolCalls.map((tc) => <ToolCallCard key={tc.id} toolCall={tc} defaultExpanded={expandTools} />)}
    </div>
  );
}

// ── Streaming Bubble ───────────────────────────────────
function StreamingBubble({ content, thinking, toolCalls, showThinking, toggleThinking, expandTools }: {
  content: string; thinking: string; toolCalls: ToolCallInfo[]; showThinking: boolean; toggleThinking: () => void; expandTools: boolean;
}) {
  return (
    <div className="mb-4 mr-8">
      <div className="text-xs mb-1 px-1 text-hacker-accent">
        <span className="animate-blink">▹</span> ASSISTANT <span className="cursor-blink" />
      </div>
      {thinking && (
        <div className="mb-2">
          <button onClick={toggleThinking} className="text-xs text-hacker-warn mb-1 hover:underline">
            {showThinking ? "▼" : "▶"} THINKING
          </button>
          {showThinking && (
            <div className="text-hacker-text-dim text-xs bg-hacker-bg/50 border border-hacker-border p-2 italic whitespace-pre-wrap max-h-40 overflow-y-auto">
              {thinking}
            </div>
          )}
        </div>
      )}
      {content && (
        <div className="text-sm leading-relaxed"><MarkdownRenderer content={content} /></div>
      )}
      {toolCalls.map((tc) => <ToolCallCard key={tc.id} toolCall={tc} defaultExpanded={expandTools} />)}
    </div>
  );
}

// ── Shared Markdown Renderer ───────────────────────────
// All assistant message content uses monospace font for proper
// alignment of code, diffs, tool output, tables, etc.
function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="markdown-chat font-mono whitespace-pre-wrap break-words text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // ── Paragraphs: no extra margin, keep monospace ──
          p({ children, ...props }: any) {
            return <p className="mb-2 last:mb-0" {...props}>{children}</p>;
          },
          // ── Inline code: monospace already, just style it ──
          code({ node, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || "");
            const codeStr = String(children).replace(/\n$/, "");
            if (!match) {
              return <code className="bg-hacker-border px-1 py-0.5 text-hacker-accent text-xs rounded-sm" {...props}>{children}</code>;
            }
            return (
              <div className="chat-code-block my-2">
                <div className="flex items-center justify-between text-[10px] text-hacker-text-dim px-3 pt-2">
                  <span>{match[1]}</span>
                  <button onClick={() => navigator.clipboard.writeText(codeStr)}
                    className="hover:text-hacker-accent">📋 copy</button>
                </div>
                <SyntaxHighlighter style={vscDarkPlus} language={match[1]} PreTag="div"
                  customStyle={{ margin: 0, background: "transparent", fontSize: "0.8rem" }}>
                  {codeStr}
                </SyntaxHighlighter>
              </div>
            );
          },
          // ── Tables: monospace, compact, aligned columns ──
          table({ children, ...props }: any) {
            return (
              <div className="overflow-x-auto my-2">
                <table className="text-xs border-collapse border border-hacker-border" {...props}>{children}</table>
              </div>
            );
          },
          th({ children, ...props }: any) {
            return <th className="border border-hacker-border px-2 py-1 text-left text-hacker-accent bg-hacker-surface" {...props}>{children}</th>;
          },
          td({ children, ...props }: any) {
            return <td className="border border-hacker-border px-2 py-1" {...props}>{children}</td>;
          },
          // ── Lists: compact ──
          ul({ children, ...props }: any) {
            return <ul className="ml-4 list-disc mb-2" {...props}>{children}</ul>;
          },
          ol({ children, ...props }: any) {
            return <ol className="ml-4 list-decimal mb-2" {...props}>{children}</ol>;
          },
          li({ children, ...props }: any) {
            return <li className="mb-0.5" {...props}>{children}</li>;
          },
          // ── Headings: monospace, styled ──
          h1({ children, ...props }: any) {
            return <h1 className="text-hacker-accent text-base font-bold mt-3 mb-1" {...props}>{children}</h1>;
          },
          h2({ children, ...props }: any) {
            return <h2 className="text-hacker-accent text-sm font-bold mt-2 mb-1" {...props}>{children}</h2>;
          },
          h3({ children, ...props }: any) {
            return <h3 className="text-hacker-accent text-xs font-bold mt-2 mb-1" {...props}>{children}</h3>;
          },
          // ── Blockquotes ──
          blockquote({ children, ...props }: any) {
            return <blockquote className="border-l-2 border-hacker-accent-dim pl-3 my-2 text-hacker-text-dim italic" {...props}>{children}</blockquote>;
          },
          // ── Horizontal rules ──
          hr({ ...props }: any) {
            return <hr className="divider-glow my-3" {...props} />;
          },
          // ── Links ──
          a({ href, children, ...props }: any) {
            return <a href={href} className="text-hacker-info hover:text-hacker-accent underline" target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// ── Tool Call Card ─────────────────────────────────────
function ToolCallCard({ toolCall, defaultExpanded = true }: { toolCall: ToolCallInfo; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Sync with global toggle
  useEffect(() => { setExpanded(defaultExpanded); }, [defaultExpanded]);
  const displayArgs = extractToolArgs(toolCall.args);

  return (
    <div className="mt-2 border border-hacker-border bg-hacker-bg/50 overflow-hidden">
      <button onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-hacker-info hover:bg-hacker-border/50">
        <span>{expanded ? "▼" : "▶"}</span>
        <span className="font-bold">{toolCall.name}</span>
        {toolCall.isStreaming && <span className="text-hacker-accent animate-pulse">▶ running...</span>}
        {toolCall.isError && <span className="text-hacker-error">✕ error</span>}
        {!toolCall.isStreaming && !toolCall.isError && toolCall.output && <span className="text-hacker-text-dim">✓ done</span>}
      </button>
      {expanded && (
        <div>
          {displayArgs && typeof displayArgs === "object" && Object.keys(displayArgs).length > 0 && (
            <div className="px-3 py-1 text-[10px] text-hacker-text-dim">
              {JSON.stringify(displayArgs, null, 2)}
            </div>
          )}
          {toolCall.output && (
            <div className={`tool-output ${toolCall.isError ? "text-hacker-error" : ""}`}>{toolCall.output}</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Extract the actual arguments from a potentially-wrapped tool call object. */
function extractToolArgs(args: any): any {
  if (!args || typeof args !== "object") return args;
  if ("arguments" in args && typeof args.arguments === "object") return args.arguments;
  if ("input" in args && typeof args.input === "object") return args.input;
  const { type, id, name, ...rest } = args;
  if (Object.keys(rest).length > 0) return rest;
  return args;
}