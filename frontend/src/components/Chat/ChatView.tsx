import { useState, useRef, useEffect, useCallback, memo } from "react";
import { Paperclip, X, Image, FileText, File, AlertTriangle, Eye, EyeOff, Download } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PiEvent, ToolCallInfo, Attachment, DisplayMessage } from "../../types";
import { PiLogo } from "../common/PiLogo";
import { ModalDialog } from "../common/ModalDialog";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolTimeline } from "./ToolTimeline";
import { useTranslation } from "../../i18n";

// ── Memoized ReactMarkdown to avoid re-parsing on every render ──
const MemoizedReactMarkdown = memo(function MemoizedReactMarkdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>;
});

// ── Time formatting ──
function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

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
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf" || fileName.toLowerCase().endsWith(".pdf")) return "pdf";

  if (mimeType.startsWith("text/") || TEXT_MIME_TYPES.has(mimeType)) return "text";

  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  if (CODE_EXTENSIONS[ext]) return "text";

  // Default: try to read as text
  return "binary";
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
  activeMode?: string;
  onQuit?: () => void;
}

export function ChatView({ send, on, activeProject, isStreaming, session, projectId, activeMode, onQuit }: Props) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [currentToolCalls, setCurrentToolCalls] = useState<ToolCallInfo[]>([]);
  const [expandTools, setExpandTools] = useState(true);
  const [showAllThinking, setShowAllThinking] = useState(false);
  const [thinkDefaultExpanded, setThinkDefaultExpanded] = useState(() => {
    const saved = localStorage.getItem("pi-web-thinking-expand");
    return saved === null ? true : saved === "true";
  });
  const [autoReviewStreaming, setAutoReviewStreaming] = useState(false);
  const [yoloStreaming, setYoloStreaming] = useState(false);
  const [yoloStatus, setYoloStatus] = useState<{ phase: string; globalCycle: number; localCycle: number; agent?: string } | null>(null);

  // File viewer overlay state
  const [viewerFile, setViewerFile] = useState<{ type: "image"; src: string; name?: string } | { type: "text"; content: string; name?: string; language?: string } | null>(null);
  const toggleAllThinking = () => setShowAllThinking((t) => !t);
  const [thinkingLevel, setThinkingLevel] = useState<string | null>(null);
  const [thinkingToast, setThinkingToast] = useState("");
  const [error, setError] = useState("");

  const chatEndRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const currentAssistantIdRef = useRef<string | null>(null);

  // Refs to avoid stale closures in WS handler
  const streamingContentRef = useRef("");
  const streamingThinkingRef = useRef("");
  const currentToolCallsRef = useRef<ToolCallInfo[]>([]);
  const messagesRef = useRef<DisplayMessage[]>([]);

  // ── Per-project chat history (persists across project switches) ──
  const chatHistory = useChatHistory(projectId);

  // Ref to track previous projectId for saving on switch
  const prevProjectIdRef = useRef(projectId);

  // ── When switching projects: save old project's messages, then load new ──
  useEffect(() => {
    // Save messages for the project we're LEAVING
    const prevId = prevProjectIdRef.current;
    if (prevId && prevId !== projectId) {
      // Persist current messages under the previous project before loading new ones
      chatHistory.saveMessagesFor(messagesRef.current, prevId);
    }
    prevProjectIdRef.current = projectId;

    // Load messages for the new project
    const stored = chatHistory.getMessages();
    if (stored.length > 0) {
      setMessages(stored);
    } else {
      // Try localStorage (catches YOLO and other non-session messages)
      try {
        const raw = localStorage.getItem(`pi-web-chat-${projectId}`);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            chatHistory.saveMessages(parsed);
            setMessages(parsed);
            console.log(`[ChatView] Restored ${parsed.length} messages from localStorage for ${projectId}`);
            return;
          }
        }
      } catch {}
      setMessages([]);
    }
    // Reset streaming state (project-specific, not transferable)
    setStreamingContent("");
    setStreamingThinking("");
    setCurrentToolCalls([]);
    setError("");
    currentAssistantIdRef.current = null;
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync messages to per-project store whenever they change ──
  useEffect(() => {
    chatHistory.saveMessages(messages);
    // Also persist to localStorage (catches YOLO messages not in Pi session)
    try {
      localStorage.setItem(`pi-web-chat-${projectId}`, JSON.stringify(messages));
    } catch {}
    messagesRef.current = messages;
  }, [messages, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

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
        // Merge with localStorage messages (YOLO / background sessions)
        try {
          const raw = localStorage.getItem(`pi-web-chat-${projectId}`);
          if (raw) {
            const localMessages: DisplayMessage[] = JSON.parse(raw);
            const restoredIds = new Set(restored.map((m: DisplayMessage) => m.id));
            const extraMessages = localMessages.filter((m: DisplayMessage) => !restoredIds.has(m.id));
            if (extraMessages.length > 0) {
              console.log(`[ChatView] Merged ${extraMessages.length} localStorage messages into session history`);
              restored.push(...extraMessages);
            }
          }
        } catch {}
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

      // Ctrl+T → toggle all thinking blocks
      if (mod && e.key === "t" && !shift) {
        e.preventDefault();
        toggleAllThinking();
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

      // Escape → close file viewer
      if (e.key === "Escape") {
        setViewerFile(null);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Smart auto-scroll: only scroll to bottom if user is already at the bottom
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    chatEndRef.current?.scrollIntoView({ behavior });
  }, []);

  // Track whether user is at the bottom of the scrollable container
  const handleScroll = useCallback(() => {
    const el = chatEndRef.current?.parentElement;
    if (!el) return;
    const threshold = 30; // px from bottom
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    isAtBottomRef.current = atBottom;
    setShowScrollBtn(!atBottom);
    if (atBottom) setUnreadCount(0);
  }, []);

  // Track unread count: new messages while scrolled up
  const prevMsgCountRef = useRef(messages.length);
  useEffect(() => {
    if (!isAtBottomRef.current && messages.length > prevMsgCountRef.current) {
      setUnreadCount((prev) => prev + (messages.length - prevMsgCountRef.current));
    }
    prevMsgCountRef.current = messages.length;
  }, [messages.length]);

  // Auto scroll only when user is at the bottom
  useEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom(streamingContent ? "auto" : "smooth");
    }
  }, [messages, streamingContent, scrollToBottom]);

  // ── Pi event handling (filtered by projectId) ──
  useEffect(() => {
    const unsub = on("pi_event", (msg: any) => {
      // Only process events for this project's chat
      if (msg.projectId && msg.projectId !== projectId) return;

      const evt: PiEvent = msg.event;

      // Stream auto-review text messages to the chat instead of ignoring them
      if (evt._autoReview && (evt.type === "message_start" || evt.type === "message_update" || evt.type === "message_end")) {
        if (evt.type === "message_start" && evt.message?.role === "assistant") {
          setAutoReviewStreaming(true);
        }
        if (evt.type === "message_end" && evt.message?.role === "assistant") {
          setAutoReviewStreaming(false);
        }
        // Fall through to normal message handling below
      }

      // YOLO mode events
      if (evt._yolo) {
        if (evt.type === "agent_start") {
          setYoloStreaming(true);
          setYoloStatus({
            phase: evt._yoloPhase,
            globalCycle: (evt._yoloGlobalCycle || 0) + 1,
            localCycle: (evt._yoloLocalCycle || 0) + 1,
            agent: evt._yoloAgent,
          });
        } else if (evt.type === "agent_end") {
          setYoloStreaming(false);
          setYoloStatus(null);
        } else if (evt.type === "yolo_status") {
          if (evt.phase === "done") {
            setYoloStreaming(false);
            setYoloStatus(null);
          } else {
            setYoloStreaming(true);
            setYoloStatus({
              phase: evt.phase,
              globalCycle: (evt.globalCycle || 0) + 1,
              localCycle: evt.localCycle || 0,
            });
          }
        }
      }

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
            const startArgs = delta.args?.arguments ?? delta.args?.input ?? delta.args ?? {};
            setCurrentToolCalls((prev) => {
              if (prev.some((tc) => tc.id === delta.toolCallId)) return prev;
              return [...prev, {
                id: delta.toolCallId, name: delta.toolName,
                args: startArgs, output: "", isError: false, isStreaming: true,
              }];
            });
          }
          if (delta.type === "toolcall_delta") {
            const deltaArgs = delta.argsDelta?.arguments ?? delta.argsDelta?.input ?? delta.argsDelta ?? {};
            setCurrentToolCalls((prev) => prev.map((tc) =>
              tc.id === delta.toolCallId
                ? { ...tc, args: { ...tc.args, ...deltaArgs } } : tc));
          }
          if (delta.type === "toolcall_end") {
            const endArgs = delta.toolCall?.arguments ?? delta.toolCall?.input ?? delta.toolCall ?? {};
            setCurrentToolCalls((prev) => prev.map((tc) =>
              tc.id === delta.toolCallId
                ? { ...tc, args: endArgs, isStreaming: false } : tc));
          }
          break;
        }

        case "tool_execution_start": {
          setCurrentToolCalls((prev) => prev.map((tc) =>
            tc.id === evt.toolCallId ? { ...tc, isStreaming: true, startTime: tc.startTime || Date.now() } : tc));
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
                toolCalls: [...ct].map(tc => ({ ...tc, isStreaming: false })),
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

  // ── Pi custom message handling (git notifications, etc.) ──
  useEffect(() => {
    const unsub = on("pi_event", (msg: any) => {
      if (msg.projectId && msg.projectId !== projectId) return;
      const evt = msg.event;
      // Handle custom messages (git_notification, etc.)
      if (evt?.type === "message_start" && evt?.message?.role === "custom" && evt?.message?.display) {
        const customMsg = evt.message;
        setMessages((prev) => [...prev, {
          id: customMsg.id || `custom-${Date.now()}`,
          role: "user" as const,
          content: customMsg.content || "",
          thinking: "",
          toolCalls: [],
          timestamp: customMsg.timestamp || Date.now(),
          customType: customMsg.customType,
          display: customMsg.display,
        }]);
      }
    });
    return () => unsub();
  }, [on, projectId]);

  // ── Handle session reload notification ──
  useEffect(() => {
    const unsub = on("pi_event", (msg: any) => {
      if (msg.projectId && msg.projectId !== projectId) return;
      if (msg.event?.type === "session_reloaded") {
        // Reset streaming state and clear current assistant message
        setStreamingContent("");
        setStreamingThinking("");
        setCurrentToolCalls([]);
      }
    });
    return () => unsub();
  }, [on, projectId]);

  // ── Pi command results (/new, /compact, /model, etc.) ──
  useEffect(() => {
    const unsub = on("pi_command_result", (msg: any) => {
      if (msg.projectId && msg.projectId !== projectId) return;
      if (msg.result) {
        setMessages((prev) => [...prev, {
          id: `cmd-${Date.now()}`,
          role: "user" as const,
          content: msg.result,
          thinking: "",
          toolCalls: [],
          timestamp: Date.now(),
          customType: "pi_command",
          display: true,
        }]);
      }
      // For /clear, just clear messages
      if (msg.command === "clear") {
        setMessages([]);
      }
      // For /new, clear messages (new session)
      if (msg.command === "new") {
        setMessages([]);
      }
      // For /quit, return to home screen
      if (msg.command === "quit") {
        onQuit?.();
      }
    });
    return () => unsub();
  }, [on, projectId]);

  // ── File processing ──────────────────────────────────

  // ── Send messagelength]);

  // ── Send message (called by ChatInputArea) ──
  const handleSend = useCallback((text: string, attachments: Attachment[]) => {
    // ── YOLO mode: launch multi-agent session ──
    if (activeMode === "yolo") {
      console.log("[ChatView] YOLO mode detected, launching session...");
      const displayContent = text;
      // Add user message to chat immediately
      setMessages(prev => [...prev, {
        id: `msg-${Date.now()}`,
        role: "user",
        content: displayContent,
        thinking: "",
        toolCalls: [],
        timestamp: Date.now(),
      }]);
      // Launch YOLO session
      fetch("/api/pi/yolo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          prompt: text,
        }),
      }).then(r => r.json()).catch(e => console.error("YOLO launch error:", e));
      return;
    }

    // Check for upload errors
    const uploadErrors = attachments.filter((a) => a.uploadStatus === "error");
    if (uploadErrors.length > 0) {
      setError(`Some files failed to upload: ${uploadErrors.map((a) => a.name).join(", ")}`);
      return;
    }

    // Check for still-uploading files
    const uploading = attachments.filter((a) => a.uploadStatus === "uploading");
    if (uploading.length > 0) {
      setError(`Waiting for ${uploading.length} file(s) to finish uploading...`);
      return;
    }

    // Separate uploaded attachments by category
    const uploadedAttachments = attachments.filter((a) => a.attachmentId && a.uploadStatus === "done");
    const imageAttachments = uploadedAttachments
      .filter((a) => a.category === "image")
      .map((a) => ({ attachmentId: a.attachmentId!, name: a.name, mimeType: a.mimeType }));
    const attachmentRefs = uploadedAttachments.map((a) => ({
      id: a.attachmentId!,
      name: a.name,
      category: a.category,
      size: a.size,
    }));

    // Build message with file references
    let fullMessage = text;
    if (attachmentRefs.length > 0) {
      const refBlock = attachmentRefs.map((a) => {
        const icon = a.category === "image" ? "🖼️" : a.category === "pdf" ? "📄" : a.category === "audio" ? "🎵" : a.category === "video" ? "🎬" : "📎";
        return `${icon} **${a.name}** (id: ${a.id}, ${formatFileSize(a.size)})`;
      }).join("\n");
      if (text.trim()) {
        fullMessage = `${refBlock}\n\n${text}`;
      } else {
        fullMessage = refBlock;
      }
    }

    if (!fullMessage) return;
    if (!text.trim() && attachmentRefs.length === 0) return;
    setError("");

    // If it's a slash command, don't add as user message
    const isSlashCommand = fullMessage.trim().startsWith("/");

    if (!isSlashCommand) {
      const displayContent = text || (attachmentRefs.length > 0 ? attachmentRefs.map((a) => `📎 ${a.name}`).join(", ") : "");
      setMessages((prev) => [...prev, {
        id: Date.now().toString(),
        role: "user",
        content: displayContent,
        thinking: "",
        toolCalls: [],
        timestamp: Date.now(),
        images: imageAttachments.length > 0 ? imageAttachments : undefined,
        attachmentRefs: attachmentRefs.length > 0 ? attachmentRefs : undefined,
      }]);
    }

    send({
      type: "pi_prompt",
      projectId,
      message: fullMessage,
      // Images are no longer sent as base64 — the LLM uses analyze_file to access them
    });
  }, [send, projectId, activeMode]);

  // ── Drag & drop ──

  if (!activeProject) {
    return (
      <div className="h-full flex items-center justify-center text-hacker-text-dim">
        <div className="text-center">
          <div className="text-hacker-accent mb-4 glitch"><PiLogo className="w-16 h-16" /></div>
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
    >
      {/* Messages */}
      {hasContent ? (
        <div className={`flex-1 overflow-y-auto p-4 chat-messages relative`} onScroll={handleScroll}>


        {error && (
          <div className="text-hacker-error text-xs border border-hacker-error/30 p-2 mb-2">{error}</div>
        )}

        {thinkingToast && (
          <div className="text-hacker-accent text-xs border border-hacker-accent/30 p-2 mb-2 bg-hacker-accent/5"><PiLogo className="w-3.5 h-3.5 inline" /> {thinkingToast}</div>
        )}

        {/* Global thinking toggle */}
        {messages.some((m) => m.thinking) && (
          <div className="flex justify-end mb-2">
            <button onClick={toggleAllThinking}
              className="flex items-center gap-1 text-[10px] text-hacker-text-dim hover:text-hacker-text border border-hacker-border px-2 py-0.5"
            >
              {showAllThinking ? <EyeOff size={10} /> : <Eye size={10} />}
              {showAllThinking ? t('chat.hideThinking') : t('chat.showThinking')}
            </button>
          </div>
        )}

        {/* Messages — grouped */}
        <GroupedMessages messages={messages} showAllThinking={showAllThinking} thinkDefaultExpanded={thinkDefaultExpanded}
          expandTools={expandTools} onFileClick={setViewerFile} onToggleThinking={toggleAllThinking} />

        {/* Streaming block */}
        {(streamingContent || streamingThinking || currentToolCalls.length > 0) && (
          <StreamingBlock content={streamingContent} thinking={streamingThinking} thinkDefaultExpanded={thinkDefaultExpanded}
            toolCalls={currentToolCalls} showAllThinking={showAllThinking}
            expandTools={expandTools} onToggleThinking={toggleAllThinking} />
        )}

        <div ref={chatEndRef} />

        {/* Scroll to bottom button — sticky so it stays at visible bottom */}
        {showScrollBtn && (
          <div className="sticky bottom-4 flex justify-end z-20">
          <button
            onClick={() => {
              scrollToBottom("smooth");
              isAtBottomRef.current = true;
              setShowScrollBtn(false);
              setUnreadCount(0);
            }}
            className="scroll-to-bottom-btn flex items-center gap-2 px-3 py-1.5 rounded-full border border-hacker-accent/30 bg-hacker-surface/95 backdrop-blur-sm text-hacker-accent text-xs font-medium shadow-lg shadow-hacker-accent/5 hover:bg-hacker-accent/10 hover:border-hacker-accent/50 transition-all animate-fade-in-up"
            title="Retour aux derniers messages"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6l4 4 4-4" />
            </svg>
            {unreadCount > 0 && (
              <span className="bg-hacker-accent/20 text-hacker-accent text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none min-w-[18px] text-center">
                {unreadCount}
              </span>
            )}
          </button>
          </div>
        )}
      </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-hacker-accent mb-4 flex justify-center"><PiLogo className="w-[25vmin] h-[25vmin]" /></div>
            <p className="text-hacker-text-dim text-sm">Session active — type a message below to start</p>
            <p className="text-hacker-text-dim text-xs mt-2">
              {activeProject?.git?.branch && `git:${activeProject.git.branch} · `}
              {session?.model?.name || "No model selected"}
            </p>
          </div>
        </div>
      )}

      {/* Input area — isolated component to prevent re-renders on keystroke */}
      <ChatInputArea
        onSend={handleSend}
        onAbort={() => send({ type: "pi_abort", projectId })}
        isStreaming={isStreaming}
        autoReviewStreaming={autoReviewStreaming}
        yoloStreaming={yoloStreaming}
        yoloStatus={yoloStatus}
        gitBranch={activeProject?.git?.branch}
        setError={setError}
      />

      {/* File viewer overlay */}
      {viewerFile && (
        <ModalDialog id="file-viewer" onClose={() => setViewerFile(null)}>
          <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-hacker-border shrink-0">
              <span className="text-sm text-hacker-text-bright truncate flex-1">{viewerFile.name || "Attachment"}</span>
              <button onClick={() => setViewerFile(null)} className="text-hacker-text-dim hover:text-hacker-error ml-2 shrink-0">
                <X size={16} />
              </button>
            </div>
            {/* Content */}
            <div className="flex-1 overflow-auto p-4">
              {viewerFile.type === "image" ? (
                <img
                  src={viewerFile.src}
                  alt={viewerFile.name || "Image"}
                  className="max-w-full max-h-full object-contain mx-auto"
                />
              ) : (
                <pre className="text-xs text-hacker-text-bright font-mono whitespace-pre-wrap">{viewerFile.content}</pre>
              )}
            </div>
          </div>
        </ModalDialog>
      )}
    </div>
  );
}

// ── Grouped Messages ───────────────────────────────────
// Consecutive assistant messages are merged into one cohesive block.

interface AssistantMsg {
  id: string;
  content: string;
  thinking: string;
  toolCalls: ToolCallInfo[];
  timestamp: number;
  usage?: { input: number; output: number; cost: { total: number } };
}

const GroupedMessages = memo(function GroupedMessages({ messages, showAllThinking, expandTools, thinkDefaultExpanded, onFileClick, onToggleThinking }: {
  messages: DisplayMessage[];
  showAllThinking: boolean;
  expandTools: boolean;
  thinkDefaultExpanded: boolean;
  onFileClick: (file: { type: "image"; src: string; name?: string } | { type: "text"; content: string; name?: string; language?: string }) => void;
  onToggleThinking: () => void;
}) {
  const groups: DisplayMessage[][] = [];
  for (const msg of messages) {
    if (msg.role === "user" || groups.length === 0 || groups[groups.length - 1][0].role === "user") {
      groups.push([msg]);
    } else {
      groups[groups.length - 1].push(msg);
    }
  }

  return <>
    {groups.map((group) => {
      const first = group[0];
      if (first.role === "user") {
        return <UserBubble key={first.id} message={first} onFileClick={onFileClick} />;
      }
      return <AssistantGroup key={first.id} messages={group as AssistantMsg[]} thinkDefaultExpanded={thinkDefaultExpanded}
        showAllThinking={showAllThinking} expandTools={expandTools} onToggleThinking={onToggleThinking} />;
    })}
  </>;
})

const UserBubble = memo(function UserBubble({ message, onFileClick }: { message: DisplayMessage; onFileClick: (file: { type: "image"; src: string; name?: string } | { type: "text"; content: string; name?: string; language?: string }) => void }) {
  // Pi command result: system info
  if (message.customType === "pi_command") {
    return (
      <div className="flex justify-center mb-3">
        <div className="max-w-[90%] bg-hacker-surface/80 border border-hacker-border rounded-lg px-4 py-2 text-xs text-hacker-text-dim text-left whitespace-pre-wrap font-mono">
          {message.content}
        </div>
      </div>
    );
  }
  // Git notification: system-level info bubble
  if (message.customType === "git_notification") {
    return (
      <div className="flex justify-center mb-3">
        <div className="max-w-[90%] bg-hacker-surface/80 border border-hacker-border rounded-lg px-4 py-2 text-xs text-hacker-text-dim text-center whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-end mb-3">
      <div className="max-w-[85%] bg-hacker-accent/10 border border-hacker-accent/30 rounded-l-lg rounded-br-lg px-3 py-2">
        {message.timestamp ? (
          <div className="text-[9px] text-hacker-text-dim text-right mb-0.5">
            {formatTime(message.timestamp)}
          </div>
        ) : null}
        {message.content && (
          <span className="text-hacker-text-bright whitespace-pre-wrap text-sm">{message.content}</span>
        )}
        {message.images && message.images.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {message.images.map((img, i) => (
              <div key={i} className="relative group">
                <img
                  src={`/api/attachments/${img.attachmentId}/file`}
                  alt={img.name}
                  className="max-w-[200px] max-h-[200px] object-contain rounded border border-hacker-border cursor-pointer hover:border-hacker-accent transition-colors"
                  onClick={() => onFileClick({ type: "image", src: `/api/attachments/${img.attachmentId}/file`, name: img.name })}
                />
                <a
                  href={`/api/attachments/${img.attachmentId}/file`}
                  download={img.name}
                  className="absolute top-1 right-1 p-1 bg-hacker-bg/80 border border-hacker-border rounded text-hacker-text-dim hover:text-hacker-accent opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Download"
                >
                  <Download size={12} />
                </a>
              </div>
            ))}
          </div>
        )}
        {message.attachmentRefs && message.attachmentRefs.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {message.attachmentRefs.map((ref, i) => {
              const icon = ref.category === "image" ? "🖼️" : ref.category === "pdf" ? "📄" : ref.category === "audio" ? "🎵" : ref.category === "video" ? "🎬" : ref.category === "text" ? "📝" : "📎";
              const fileUrl = `/api/attachments/${ref.id}/file`;
              return (
                <div key={i} className="relative group">
                  <button
                    className="flex items-center gap-1.5 text-xs bg-hacker-bg/40 border border-hacker-border px-2 py-1 rounded hover:border-hacker-accent transition-colors text-hacker-text-bright"
                    onClick={() => {
                      if (ref.category === "image") {
                        onFileClick({ type: "image", src: fileUrl, name: ref.name });
                      } else if (ref.category === "pdf") {
                        window.open(fileUrl, "_blank");
                      }
                    }}
                  >
                    <span>{icon}</span>
                    <span>{ref.name}</span>
                    <span className="text-hacker-text-dim">{formatFileSize(ref.size)}</span>
                  </button>
                  <a
                    href={fileUrl}
                    download={ref.name}
                    className="absolute -top-1 -right-1 p-0.5 bg-hacker-bg/80 border border-hacker-border rounded text-hacker-text-dim hover:text-hacker-accent opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Download"
                  >
                    <Download size={10} />
                  </a>
                </div>
              );
            })}
          </div>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {message.attachments.map((att, i) => (
              <div key={i} className="relative group">
                <button
                  className="flex items-center gap-1.5 text-xs bg-hacker-bg/40 border border-hacker-border px-2 py-1 rounded hover:border-hacker-accent transition-colors text-hacker-text-bright"
                  onClick={() => onFileClick({ type: "text", content: att.content, name: att.name })}
                >
                  <FileText size={12} />
                  {att.name}
                </button>
                <a
                  href={`data:text/plain;charset=utf-8,${encodeURIComponent(att.content)}`}
                  download={att.name}
                  className="absolute -top-1 -right-1 p-0.5 bg-hacker-bg/80 border border-hacker-border rounded text-hacker-text-dim hover:text-hacker-accent opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Download"
                >
                  <Download size={10} />
                </a>
              </div>
            ))}
          </div>
        )}
        {message.usage && (
          <span className="text-[9px] text-hacker-text-dim shrink-0">
            {message.usage.input + message.usage.output}t
          </span>
        )}
      </div>
    </div>
  );
})

const AssistantGroup = memo(function AssistantGroup({ messages, showAllThinking, expandTools, thinkDefaultExpanded, onToggleThinking }: {
  messages: AssistantMsg[];
  showAllThinking: boolean;
  expandTools: boolean;
  thinkDefaultExpanded: boolean;
  onToggleThinking: () => void;
}) {
  const { t } = useTranslation();
  const [localToolsExpanded, setLocalToolsExpanded] = useState(false);

  // Collect all thinking, all tool calls, and the last meaningful text content
  const allThinking: string[] = [];
  const allTools: ToolCallInfo[] = [];
  let finalText = "";
  let totalUsage: { input: number; output: number; cost: { total: number } } | undefined;

  for (const msg of messages) {
    if (msg.thinking) allThinking.push(msg.thinking);
    allTools.push(...msg.toolCalls);
    if (msg.content) finalText = msg.content;
    if (msg.usage) {
      totalUsage = totalUsage
        ? { input: totalUsage.input + msg.usage.input, output: totalUsage.output + msg.usage.output,
            cost: { total: totalUsage.cost.total + msg.usage.cost.total } }
        : msg.usage;
    }
  }

  const mergedThinking = allThinking.join("\n\n---\n\n");
  const hasThinking = allThinking.length > 0;
  const hasTools = allTools.length > 0;

  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[95%] bg-hacker-surface border border-hacker-border rounded-r-lg rounded-bl-lg">
        {/* Thinking — show/hide based on global toggle */}
        {hasThinking && showAllThinking && (
          <div className="px-3 pt-2">
            <ThinkingBlock thinking={mergedThinking} defaultExpanded={thinkDefaultExpanded} />
          </div>
        )}
        {hasThinking && !showAllThinking && (
          <div className="px-3 pt-1">
            <button onClick={onToggleThinking} className="text-[10px] text-hacker-text-dim italic hover:text-hacker-warn hover:underline" title="Show thinking (Ctrl+T)">
              {t('chat.thinkingHidden')} ({t('chat.nBlocks', allThinking.length)})
            </button>
          </div>
        )}

        {/* Tools — compact badges or expanded timeline */}
        {hasTools && (
          <div className="px-3 pt-1 pb-1">
            <div className="flex items-center gap-2 mb-1">
              <button onClick={() => setLocalToolsExpanded(!localToolsExpanded)}
                className="text-[10px] text-hacker-warn hover:underline">
                {localToolsExpanded ? "▼" : "▶"} {t('chat.tools')} ({allTools.length})
              </button>
            </div>
            {localToolsExpanded ? (
              <ToolTimeline tools={allTools} />
            ) : (
              <ToolTimeline tools={allTools} compact onExpand={() => setLocalToolsExpanded(true)} />
            )}
          </div>
        )}

        {/* Final text */}
        {finalText && (
          <div className="px-3 py-2 prose-hacker">
            <MemoizedReactMarkdown>{finalText}</MemoizedReactMarkdown>
          </div>
        )}

        {/* Usage footer */}
        {(totalUsage || messages[0]?.timestamp) && (
          <div className="px-3 pb-2 text-[9px] text-hacker-text-dim border-t border-hacker-border pt-1.5 flex justify-between items-center">
            <span>{messages[0]?.timestamp ? formatTime(messages[0].timestamp) : ""}</span>
            {totalUsage && <span>{totalUsage.input + totalUsage.output} tok</span>}
          </div>
        )}
      </div>
    </div>
  );
})

// ── Streaming Block ────────────────────────────────────
const StreamingBlock = memo(function StreamingBlock({ content, thinking, toolCalls, showAllThinking, expandTools, thinkDefaultExpanded, onToggleThinking }: {
  content: string;
  thinking: string;
  toolCalls: ToolCallInfo[];
  showAllThinking: boolean;
  expandTools: boolean;
  thinkDefaultExpanded: boolean;
  onToggleThinking: () => void;
}) {
  const { t } = useTranslation();
  const [localToolsExpanded, setLocalToolsExpanded] = useState(true);

  const hasThinking = !!thinking;
  const hasTools = toolCalls.length > 0;

  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[95%] bg-hacker-surface border border-hacker-border rounded-r-lg rounded-bl-lg">
        {/* Thinking — visible if global toggle on + has content */}
        {hasThinking && showAllThinking && (
          <div className="px-3 pt-2">
            <ThinkingBlock thinking={thinking} isStreaming defaultExpanded={thinkDefaultExpanded} />
          </div>
        )}
        {hasThinking && !showAllThinking && (
          <div className="px-3 pt-1">
            <button onClick={onToggleThinking} className="text-[10px] text-hacker-text-dim italic hover:text-hacker-warn hover:underline" title="Show thinking (Ctrl+T)">{t('chat.thinkingHidden')}</button>
          </div>
        )}

        {/* Tools — compact badges or expanded timeline */}
        {hasTools && (
          <div className="px-3 pt-1 pb-1">
            <div className="flex items-center gap-2 mb-1">
              <button onClick={() => setLocalToolsExpanded(!localToolsExpanded)}
                className="text-[10px] text-hacker-warn hover:underline">
                {localToolsExpanded ? "▼" : "▶"} {t('chat.tools')} ({toolCalls.length})
              </button>
            </div>
            {localToolsExpanded ? (
              <ToolTimeline tools={toolCalls} />
            ) : (
              <ToolTimeline tools={toolCalls} compact onExpand={() => setLocalToolsExpanded(true)} />
            )}
          </div>
        )}

        {/* Streaming content with blinking cursor */}
        {content ? (
          <div className="px-3 py-2 prose-hacker">
            <MemoizedReactMarkdown>{content}</MemoizedReactMarkdown>
            <span className="cursor-blink" />
          </div>
        ) : (thinking || toolCalls.length > 0) ? (
          <div className="px-3 pb-2">
            <span className="cursor-blink" />
          </div>
        ) : null}
      </div>
    </div>
  );
})

// ── ChatInputArea (isolated to prevent re-renders on every keystroke) ──

const ChatInputArea = memo(function ChatInputArea({
  onSend, onAbort, isStreaming, autoReviewStreaming, yoloStreaming, yoloStatus, gitBranch, setError,
}: {
  onSend: (text: string, attachments: Attachment[]) => void;
  onAbort: () => void;
  isStreaming: boolean;
  autoReviewStreaming: boolean;
  yoloStreaming: boolean;
  yoloStatus: { phase: string; globalCycle: number; localCycle: number; agent?: string } | null;
  gitBranch?: string;
  setError: (e: string) => void;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback(async (file: File) => {
    if (attachments.length >= 10) {
      setError("Maximum 10 files per message");
      return;
    }
    const category = categorizeFile(file.type || "application/octet-stream", file.name);

    // All file sizes up to 100MB are now allowed (server has the limit)
    const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
    if (file.size > MAX_FILE_SIZE) {
      setError(`File too large: ${formatFileSize(file.size)}. Max ${formatFileSize(MAX_FILE_SIZE)}.`);
      return;
    }

    const uid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // For images, create a local preview for immediate display
    const localPreview = category === "image"
      ? URL.createObjectURL(file)
      : undefined;

    // Add attachment immediately with "uploading" status
    setAttachments((prev) => [...prev, {
      id: uid, name: file.name, mimeType: file.type || "application/octet-stream",
      size: file.size, category,
      data: "", // Will be filled by server
      preview: localPreview,
      uploadStatus: "uploading" as const,
    }]);

    // Upload to server API
    try {
      const formData = new FormData();
      formData.append("files", file);
      

      const response = await fetch("/api/attachments/upload", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: "Upload failed" }));
        throw new Error(errorData.error || `Upload failed: ${response.status}`);
      }

      const data = await response.json();
      const uploaded = data.attachments?.[0];

      if (!uploaded) throw new Error("No attachment data returned");

      // Update attachment with server data
      setAttachments((prev) => prev.map((a) =>
        a.id === uid ? {
          ...a,
          attachmentId: uploaded.id,
          uploadStatus: "done" as const,
          preview: a.preview || URL.createObjectURL(file),
        } : a
      ));
    } catch (err: any) {
      // Mark as error
      setAttachments((prev) => prev.map((a) =>
        a.id === uid ? {
          ...a,
          uploadStatus: "error" as const,
          uploadError: err.message,
        } : a
      ));
      setError(`Upload failed: ${err.message}`);
    }
  }, [attachments.length, setError]);

  const handleSendClick = useCallback(() => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    onSend(input, attachments);
    setInput("");
    setAttachments([]);
    if (inputRef.current) inputRef.current.style.height = 'auto';
  }, [input, attachments, onSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendClick();
    }
  }, [handleSendClick]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    for (const file of Array.from(e.dataTransfer.files)) processFile(file);
  }, [processFile]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (blob) processFile(blob);
      }
    }
  }, [processFile]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      for (const file of Array.from(e.target.files)) processFile(file);
    }
  }, [processFile]);

  return (
    <div
      className="border-t border-hacker-border-bright bg-hacker-surface p-3"
      onDrop={handleDrop}
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onPaste={handlePaste}
    >
      {isDragOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-hacker-bg/80 z-20">
          <div className="text-hacker-accent text-2xl glitch">DROP FILES HERE</div>
        </div>
      )}

      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {attachments.map((att) => (
            <div key={att.id} className={`flex items-center gap-1.5 text-xs border px-2 py-1.5 rounded group ${att.uploadStatus === "error" ? "bg-red-500/10 border-red-500/50" : att.uploadStatus === "uploading" ? "bg-hacker-accent/10 border-hacker-accent/30 animate-pulse" : "bg-hacker-border/40 border-hacker-border"}`}>
              {att.uploadStatus === "uploading" ? (
                <span className="text-hacker-accent animate-spin">⏳</span>
              ) : att.uploadStatus === "error" ? (
                <span className="text-red-400">⚠️</span>
              ) : att.category === "image" && att.preview ? (
                <img src={att.preview} alt={att.name} className="w-8 h-8 object-cover rounded" />
              ) : (
                <span className="text-hacker-accent">{getFileExtensionIcon(att.category, att.name)}</span>
              )}
              <span className="truncate max-w-[120px]">{att.name}</span>
              <span className="text-hacker-text-dim">{formatFileSize(att.size)}</span>
              {att.uploadStatus === "done" && (
                <span className="text-green-400 text-[9px]">✓</span>
              )}
              {att.uploadStatus === "error" && att.uploadError && (
                <span className="text-red-400 text-[9px] truncate max-w-[100px]" title={att.uploadError}>❌</span>
              )}
              <button onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                className="text-hacker-text-dim hover:text-hacker-error ml-1">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="text-hacker-text-dim text-[10px] mb-1 flex justify-between">
        <span>{t('chat.keyboardHints')}</span>
        <span className="flex items-center gap-2">
          {gitBranch && <span>git:{gitBranch}</span>}
          {autoReviewStreaming && (
            <span className="text-hacker-warn flex items-center gap-1">
              <span className="pulse-dot w-1.5 h-1.5 bg-hacker-warn" /> {t('autoReview.inProgress')}
            </span>
          )}
          {yoloStreaming && yoloStatus && (
            <span className="text-hacker-accent flex items-center gap-1">
              <span className="pulse-dot w-1.5 h-1.5" />
              YOLO {yoloStatus.phase.toUpperCase()} {yoloStatus.agent ? `(${yoloStatus.agent})` : ""} — G{yoloStatus.globalCycle}
              {yoloStatus.localCycle > 0 && `·${yoloStatus.localCycle}`}
            </span>
          )}
          {isStreaming && !autoReviewStreaming && !yoloStreaming && (
            <span className="text-hacker-accent flex items-center gap-1">
              <span className="pulse-dot w-1.5 h-1.5" /> {t('common.loading')}
            </span>
          )}
        </span>
      </div>

      <div className="flex gap-2">
        <textarea ref={inputRef} value={input} onChange={(e) => {
            setInput(e.target.value);
            const target = e.target;
            target.style.height = 'auto';
            const lineHeight = parseInt(getComputedStyle(target).lineHeight) || 20;
            const maxH = lineHeight * 8;
            target.style.height = Math.min(target.scrollHeight, maxH) + 'px';
          }}
          onKeyDown={handleKeyDown}
          placeholder={isStreaming ? t('chat.queueMessage') : t('chat.typeMessage')}
          className="input-hacker flex-1 resize-none overflow-y-auto" rows={2}
          style={{ minHeight: '3rem', maxHeight: '10rem' }}
        />

        <div className="flex flex-col gap-1">
          <button onClick={handleSendClick} className="btn-hacker flex-1 px-4"
            disabled={!input.trim() && attachments.length === 0}>{t('chat.send')}</button>
          <div className="flex gap-1">
            <button onClick={() => fileInputRef.current?.click()}
              className="btn-hacker px-2 text-xs" title={t('common.add')}>
              <Paperclip size={14} />
            </button>
            {isStreaming && (
              <button onClick={onAbort} className="btn-hacker danger px-4 text-xs">ABORT</button>
            )}
          </div>
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
});
