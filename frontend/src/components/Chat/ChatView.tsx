import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { PiEvent, ToolCallInfo } from "../../types";
import type { Project } from "../../types";

interface Props {
  send: (msg: any) => void;
  on: (type: string, cb: (msg: any) => void) => () => void;
  activeProject: Project | null;
  isStreaming: boolean;
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

export function ChatView({ send, on, activeProject, isStreaming }: Props) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [currentToolCalls, setCurrentToolCalls] = useState<ToolCallInfo[]>([]);
  const [input, setInput] = useState("");
  const [attachedImages, setAttachedImages] = useState<{ data: string; mimeType: string; name: string }[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [showThinking, setShowThinking] = useState(true);
  const [error, setError] = useState("");

  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const currentAssistantIdRef = useRef<string | null>(null);

  // Refs to avoid stale closures in WS handler
  const streamingContentRef = useRef("");
  const streamingThinkingRef = useRef("");
  const currentToolCallsRef = useRef<ToolCallInfo[]>([]);
  const messagesRef = useRef<DisplayMessage[]>([]);

  // Keep refs in sync
  useEffect(() => { streamingContentRef.current = streamingContent; }, [streamingContent]);
  useEffect(() => { streamingThinkingRef.current = streamingThinking; }, [streamingThinking]);
  useEffect(() => { currentToolCallsRef.current = currentToolCalls; }, [currentToolCalls]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Auto scroll
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  // ── Pi event handling (subscribed once, uses refs) ──
  useEffect(() => {
    const unsub = on("pi_event", (msg: any) => {
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
            setCurrentToolCalls((prev) => [...prev, {
              id: delta.toolCallId, name: delta.toolName,
              args: delta.args, output: "", isError: false, isStreaming: true,
            }]);
          }
          if (delta.type === "toolcall_delta") {
            setCurrentToolCalls((prev) => prev.map((tc) =>
              tc.id === delta.toolCallId
                ? { ...tc, args: { ...tc.args, ...delta.argsDelta } } : tc));
          }
          if (delta.type === "toolcall_end") {
            setCurrentToolCalls((prev) => prev.map((tc) =>
              tc.id === delta.toolCallId
                ? { ...tc, args: delta.toolCall, isStreaming: false } : tc));
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
            // Read from refs to get latest values safely
            const sc = streamingContentRef.current;
            const st = streamingThinkingRef.current;
            const ct = currentToolCallsRef.current;

            const finalContent = sc ||
              evt.message.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") || "";
            const finalThinking = st ||
              evt.message.content?.filter((c: any) => c.type === "thinking").map((c: any) => c.thinking).join("") || "";

            if (finalContent || finalThinking || ct.length > 0) {
              const msgUsage = evt.message?.usage;
              setMessages((prev) => [...prev, {
                id: currentAssistantIdRef.current || Date.now().toString(),
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
  }, [on]); // Only re-subscribe if `on` reference changes

  // ── Send message ──
  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text && attachedImages.length === 0 && attachedFiles.length === 0) return;
    setError("");

    let fullMessage = text;
    if (attachedFiles.length > 0) {
      fullMessage = `${attachedFiles.join("\n")}\n\n${text}`;
    }

    setMessages((prev) => [...prev, {
      id: Date.now().toString(),
      role: "user",
      content: text || "[attachments]",
      thinking: "",
      toolCalls: [],
      timestamp: Date.now(),
    }]);

    const images = attachedImages.map((img) => ({ data: img.data, mimeType: img.mimeType }));
    send({
      type: "pi_prompt",
      message: fullMessage,
      images: images.length > 0 ? images : undefined,
    });

    setInput("");
    setAttachedImages([]);
    setAttachedFiles([]);
  }, [input, attachedImages, attachedFiles, send]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // ── File handling ──
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    for (const file of Array.from(e.dataTransfer.files)) {
      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(",")[1];
          setAttachedImages((prev) => [...prev, { data: base64, mimeType: file.type, name: file.name }]);
        };
        reader.readAsDataURL(file);
      } else {
        const reader = new FileReader();
        reader.onload = () => {
          setAttachedFiles((prev) => [...prev, `File: ${file.name}\n\`\`\`\n${reader.result as string}\n\`\`\``]);
        };
        reader.readAsText(file);
      }
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (blob) {
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = (reader.result as string).split(",")[1];
            setAttachedImages((prev) => [...prev, { data: base64, mimeType: blob.type, name: "pasted-image.png" }]);
          };
          reader.readAsDataURL(blob);
        }
      }
    }
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

  return (
    <div
      className="h-full flex flex-col"
      onDrop={handleDrop}
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onPaste={handlePaste}
    >
      {/* Messages */}
      <div className={`flex-1 overflow-y-auto p-4 ${isDragOver ? "drop-zone active" : ""}`}>
        {isDragOver && (
          <div className="absolute inset-0 flex items-center justify-center bg-hacker-bg/80 z-20">
            <div className="text-hacker-accent text-2xl glitch">DROP FILES HERE</div>
          </div>
        )}

        {error && (
          <div className="text-hacker-error text-xs border border-hacker-error/30 p-2 mb-2">{error}</div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} showThinking={showThinking}
            toggleThinking={() => setShowThinking((t) => !t)} />
        ))}

        {(streamingContent || streamingThinking || currentToolCalls.length > 0) && (
          <StreamingBubble content={streamingContent} thinking={streamingThinking}
            toolCalls={currentToolCalls} showThinking={showThinking}
            toggleThinking={() => setShowThinking((t) => !t)} />
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-hacker-border bg-hacker-surface p-3">
        {(attachedImages.length > 0 || attachedFiles.length > 0) && (
          <div className="flex gap-2 mb-2 flex-wrap">
            {attachedImages.map((img, i) => (
              <div key={i} className="flex items-center gap-1 text-xs bg-hacker-border px-2 py-1">
                🖼 {img.name}
                <button onClick={() => setAttachedImages((prev) => prev.filter((_, j) => j !== i))}
                  className="text-hacker-error ml-1">×</button>
              </div>
            ))}
            {attachedFiles.map((f, i) => (
              <div key={i} className="flex items-center gap-1 text-xs bg-hacker-border px-2 py-1">
                📄 {f.slice(6, 50)}...
                <button onClick={() => setAttachedFiles((prev) => prev.filter((_, j) => j !== i))}
                  className="text-hacker-error ml-1">×</button>
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
              disabled={!input.trim() && attachedImages.length === 0 && attachedFiles.length === 0}>SEND</button>
            {isStreaming && (
              <button onClick={() => send({ type: "pi_abort" })} className="btn-hacker danger px-4 text-xs">ABORT</button>
            )}
          </div>
        </div>
        <div className="text-hacker-text-dim text-[10px] mt-1 flex justify-between">
          <span>Drag & drop · Ctrl+V paste images</span>
          <span>{activeProject?.git?.branch && `git:${activeProject.git.branch}`}</span>
        </div>
      </div>
    </div>
  );
}

// ── Message Bubble ─────────────────────────────────────
function MessageBubble({ message, showThinking, toggleThinking }: {
  message: DisplayMessage; showThinking: boolean; toggleThinking: () => void;
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

      {message.toolCalls.map((tc) => <ToolCallCard key={tc.id} toolCall={tc} />)}
    </div>
  );
}

// ── Streaming Bubble ───────────────────────────────────
function StreamingBubble({ content, thinking, toolCalls, showThinking, toggleThinking }: {
  content: string; thinking: string; toolCalls: ToolCallInfo[]; showThinking: boolean; toggleThinking: () => void;
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
      {toolCalls.map((tc) => <ToolCallCard key={tc.id} toolCall={tc} />)}
    </div>
  );
}

// ── Shared Markdown Renderer ───────────────────────────
function MarkdownRenderer({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ node, className, children, ...props }: any) {
          const match = /language-(\w+)/.exec(className || "");
          const codeStr = String(children).replace(/\n$/, "");
          if (!match) {
            return <code className="bg-hacker-border px-1 py-0.5 text-hacker-accent text-xs" {...props}>{children}</code>;
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
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

// ── Tool Call Card ─────────────────────────────────────
function ToolCallCard({ toolCall }: { toolCall: ToolCallInfo }) {
  const [expanded, setExpanded] = useState(true);
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
          {toolCall.args && Object.keys(toolCall.args).length > 0 && (
            <div className="px-3 py-1 text-[10px] text-hacker-text-dim">
              {JSON.stringify(toolCall.args, null, 2)}
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
