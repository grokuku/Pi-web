import { useState, useRef, useEffect, useCallback, memo } from "react";
import { Paperclip, X, Image, FileText, File, AlertTriangle, Download } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PiEvent, ToolCallInfo, Attachment, DisplayMessage } from "../../types";
import { PiLogo } from "../common/PiLogo";
import { ModalDialog } from "../common/ModalDialog";
import { ThinkingBlock } from "./ThinkingBlock";
import { useTranslation } from "../../i18n";
import type { Project } from "../../types";
import { useChatHistory } from "../../hooks/useChatHistory";

// ── Memoized ReactMarkdown ──
const MemoizedReactMarkdown = memo(function MemoizedReactMarkdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>;
});

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── File helpers (unchanged) ──
const TEXT_MIME_TYPES = new Set([
  "text/plain", "text/csv", "text/markdown", "text/html", "text/css",
  "text/xml", "text/yaml", "text/x-yaml", "application/json",
  "application/xml", "application/yaml", "application/x-yaml",
  "application/javascript", "application/typescript", "application/x-shellscript",
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
  return "binary";
}
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function getFileExtensionIcon(category: Attachment["category"], fileName: string) {
  switch (category) { case "image": return <Image size={14} />; case "text": return <FileText size={14} />; case "audio": return <AlertTriangle size={14} />; case "binary": return <File size={14} />; }
}

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

  // ── State ──
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [thinkDefaultExpanded, setThinkDefaultExpanded] = useState(() => {
    const saved = localStorage.getItem("pi-web-thinking-expand");
    return saved === null ? true : saved === "true";
  });
  const [autoReviewStreaming, setAutoReviewStreaming] = useState(false);
  const [yoloStreaming, setYoloStreaming] = useState(false);
  const [yoloStatus, setYoloStatus] = useState<{ phase: string; globalCycle: number; localCycle: number; agent?: string; model?: string } | null>(null);
  const [viewerFile, setViewerFile] = useState<{ type: "image"; src: string; name?: string } | { type: "text"; content: string; name?: string; language?: string } | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState<string | null>(null);
  const [thinkingToast, setThinkingToast] = useState("");
  const [error, setError] = useState("");
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const currentAssistantIdRef = useRef<string | null>(null);
  const messagesRef = useRef<DisplayMessage[]>([]);
  const chatHistory = useChatHistory(projectId);
  const prevProjectIdRef = useRef(projectId);

  // ── Project switching ──
  useEffect(() => {
    const prevId = prevProjectIdRef.current;
    if (prevId && prevId !== projectId) {
      chatHistory.saveMessagesFor(messagesRef.current, prevId);
    }
    prevProjectIdRef.current = projectId;
    const stored = chatHistory.getMessages();
    if (stored.length > 0) {
      setMessages(stored);
    } else {
      try {
        const raw = localStorage.getItem(`pi-web-chat-${projectId}`);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            chatHistory.saveMessages(parsed);
            setMessages(parsed);
            return;
          }
        }
      } catch {}
      setMessages([]);
    }
    setYoloStreaming(false); setYoloStatus(null); setAutoReviewStreaming(false);
    setError(""); currentAssistantIdRef.current = null;
  }, [projectId]);

  useEffect(() => { chatHistory.saveMessages(messages); try { localStorage.setItem(`pi-web-chat-${projectId}`, JSON.stringify(messages)); } catch {} messagesRef.current = messages; }, [messages, projectId]);

  // ── History restoration ──
  useEffect(() => {
    const unsub = on("pi_history", (msg: any) => {
      if (msg.projectId && msg.projectId !== projectId) return;
      if (msg.messages && Array.isArray(msg.messages) && msg.messages.length > 0) {
        const restored = chatHistory.handleHistory(msg.messages);
        try {
          const raw = localStorage.getItem(`pi-web-chat-${projectId}`);
          if (raw) {
            const local: DisplayMessage[] = JSON.parse(raw);
            const ids = new Set(restored.map((m: DisplayMessage) => m.id));
            for (const m of local) { if (!ids.has(m.id)) restored.push(m); }
          }
        } catch {}
        setMessages(restored);
      }
    });
    return () => unsub();
  }, [on, projectId]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey; const shift = e.shiftKey;
      const tag = (e.target as HTMLElement).tagName;
      const inInput = tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT";
      if (mod && e.key === "t" && !shift) { e.preventDefault(); setThinkDefaultExpanded(p => { localStorage.setItem("pi-web-thinking-expand", String(!p)); return !p; }); return; }
      if (shift && e.key === "Tab" && !mod && !inInput) {
        e.preventDefault();
        fetch("/api/settings/thinking").then(r => r.json()).then(data => {
          const levels = ["off","minimal","low","medium","high"];
          const idx = levels.indexOf(data.level||"medium");
          const next = levels[(idx+1)%levels.length];
          setThinkingLevel(next); setThinkingToast(`THINKING: ${next.toUpperCase()}`);
          setTimeout(() => setThinkingToast(""), 1500);
          fetch("/api/settings/thinking", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({level:next}) });
        }).catch(()=>{});
        return;
      }
      if (e.key === "Escape") { setViewerFile(null); return; }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // ── Scroll ──
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => { chatEndRef.current?.scrollIntoView({ behavior }); }, []);
  const handleScroll = useCallback(() => {
    const el = chatEndRef.current?.parentElement; if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    isAtBottomRef.current = atBottom; setShowScrollBtn(!atBottom); if (atBottom) setUnreadCount(0);
  }, []);
  const prevMsgCountRef = useRef(messages.length);
  useEffect(() => { if (!isAtBottomRef.current && messages.length > prevMsgCountRef.current) setUnreadCount(p => p + messages.length - prevMsgCountRef.current); prevMsgCountRef.current = messages.length; }, [messages.length]);
  useEffect(() => { if (isAtBottomRef.current) scrollToBottom(messages.length > 0 && messages[messages.length-1]._streaming ? "auto" : "smooth"); }, [messages, scrollToBottom]);

  // ── Pi event handling ──
  useEffect(() => {
    const unsub = on("pi_event", (msg: any) => {
      if (msg.projectId && msg.projectId !== projectId) return;
      const evt: PiEvent = msg.event;

      if (evt._autoReview && (evt.type === "message_start" || evt.type === "message_update" || evt.type === "message_end")) {
        if (evt.type === "message_start" && evt.message?.role === "assistant") setAutoReviewStreaming(true);
        if (evt.type === "message_end" && evt.message?.role === "assistant") setAutoReviewStreaming(false);
      }
      if (evt._yolo) {
        if (evt.type === "agent_start") { setYoloStreaming(true); setYoloStatus({ phase: evt._yoloPhase, globalCycle: (evt._yoloGlobalCycle||0)+1, localCycle: (evt._yoloLocalCycle||0)+1, agent: evt._yoloAgent, model: evt._yoloModel }); }
        else if (evt.type === "agent_end") { setYoloStreaming(false); setYoloStatus(null); }
        else if (evt.type === "yolo_status") {
          if (evt.phase === "done") { setYoloStreaming(false); setYoloStatus(null); }
          else { setYoloStreaming(true); setYoloStatus({ phase: evt.phase, globalCycle: (evt.globalCycle||0)+1, localCycle: evt.localCycle||0 }); }
        }
      }

      // Helper: find and update the current streaming message in-place
      const updateLastMsg = (fn: (last: DisplayMessage) => DisplayMessage) => {
        setMessages(prev => {
          const idx = prev.length - 1;
          if (idx < 0 || prev[idx].role !== "assistant" || prev[idx].id !== currentAssistantIdRef.current) return prev;
          const next = [...prev]; next[idx] = fn(next[idx]); return next;
        });
      };

      switch (evt.type) {
        case "message_start": {
          if (evt.message?.role === "assistant") {
            currentAssistantIdRef.current = evt.message.id || `s-${Date.now()}`;
            setMessages(prev => [...prev, { id: currentAssistantIdRef.current!, role:"assistant", content:"", thinking:"", toolCalls:[], timestamp:Date.now(), _streaming:true }]);
          }
          break;
        }
        case "message_update": {
          const d = evt.assistantMessageEvent;
          if (d.type === "text_delta") updateLastMsg(last => ({ ...last, content: last.content + d.delta }));
          if (d.type === "thinking_delta") updateLastMsg(last => ({ ...last, thinking: last.thinking + d.delta }));
          if (d.type === "toolcall_start") {
            const a = d.args?.arguments ?? d.args?.input ?? d.args ?? {};
            updateLastMsg(last => {
              if (last.toolCalls.some(tc => tc.id === d.toolCallId)) return last;
              return { ...last, toolCalls: [...last.toolCalls, { id:d.toolCallId, name:d.toolName, args:a, output:"", isError:false, isStreaming:true }] };
            });
          }
          if (d.type === "toolcall_delta") {
            const da = d.argsDelta?.arguments ?? d.argsDelta?.input ?? d.argsDelta ?? {};
            updateLastMsg(last => ({ ...last, toolCalls: last.toolCalls.map(tc => tc.id===d.toolCallId ? {...tc, args:{...tc.args,...da}} : tc) }));
          }
          if (d.type === "toolcall_end") {
            const ea = d.toolCall?.arguments ?? d.toolCall?.input ?? d.toolCall ?? {};
            updateLastMsg(last => ({ ...last, toolCalls: last.toolCalls.map(tc => tc.id===d.toolCallId ? {...tc, args:ea, isStreaming:false} : tc) }));
          }
          break;
        }
        case "tool_execution_start":
          updateLastMsg(last => ({ ...last, toolCalls: last.toolCalls.map(tc => tc.id===evt.toolCallId ? {...tc, isStreaming:true, startTime:tc.startTime||Date.now()} : tc) }));
          break;
        case "tool_execution_update": {
          const pt = evt.partialResult?.content?.map((c:any)=>c.text||"").join("")||"";
          updateLastMsg(last => ({ ...last, toolCalls: last.toolCalls.map(tc => tc.id===evt.toolCallId ? {...tc, output:pt, isStreaming:true} : tc) }));
          break;
        }
        case "tool_execution_end": {
          const rt = evt.result?.content?.map((c:any)=>c.text||"").join("")||"";
          updateLastMsg(last => ({ ...last, toolCalls: last.toolCalls.map(tc => tc.id===evt.toolCallId ? {...tc, output:rt, isError:evt.isError, isStreaming:false} : tc) }));
          break;
        }
        case "message_end": {
          if (evt.message?.role === "assistant") {
            const msgId = currentAssistantIdRef.current;
            if (!msgId) break;
            const fc = evt.message.content?.filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("")||"";
            const ft = evt.message.content?.filter((c:any)=>c.type==="thinking").map((c:any)=>c.thinking).join("")||"";
            const mu = evt.message?.usage;
            setMessages(prev => {
              const idx = prev.findIndex(m => m.id === msgId);
              if (idx === -1) return prev;
              const next = [...prev];
              const ex = next[idx];
              next[idx] = {
                ...ex, _streaming: false,
                content: ex.content || fc, thinking: ex.thinking || ft,
                toolCalls: ex.toolCalls.map(tc => ({...tc, isStreaming:false})),
                usage: mu ? { input:mu.input||0, output:mu.output||0, cost:{total:mu.cost?.total||0} } : ex.usage,
              };
              return next;
            });
            currentAssistantIdRef.current = null;
          }
          break;
        }
      }
    });
    return () => unsub();
  }, [on, projectId]);

  // ── Custom messages ──
  useEffect(() => {
    const unsub = on("pi_event", (msg: any) => {
      if (msg.projectId && msg.projectId !== projectId) return;
      const evt = msg.event;
      if (evt?.type === "message_start" && evt?.message?.role === "custom" && evt?.message?.display) {
        const cm = evt.message;
        setMessages(prev => [...prev, { id:cm.id||`c-${Date.now()}`, role:"user", content:cm.content||"", thinking:"", toolCalls:[], timestamp:cm.timestamp||Date.now(), customType:cm.customType, display:cm.display }]);
      }
    });
    return () => unsub();
  }, [on, projectId]);

  // ── Session reload ──
  useEffect(() => {
    const unsub = on("pi_event", (msg: any) => {
      if (msg.projectId && msg.projectId !== projectId) return;
      if (msg.event?.type === "session_reloaded") {
        setMessages(prev => prev.filter(m => !m._streaming));
        currentAssistantIdRef.current = null;
      }
    });
    return () => unsub();
  }, [on, projectId]);

  // ── Commands ──
  useEffect(() => {
    const unsub = on("pi_command_result", (msg: any) => {
      if (msg.projectId && msg.projectId !== projectId) return;
      if (msg.result) setMessages(prev => [...prev, { id:`cmd-${Date.now()}`, role:"user", content:msg.result, thinking:"", toolCalls:[], timestamp:Date.now(), customType:"pi_command", display:true }]);
      if (msg.command === "clear" || msg.command === "new") setMessages([]);
      if (msg.command === "quit") onQuit?.();
    });
    return () => unsub();
  }, [on, projectId, onQuit]);

  // ── Send ──
  const handleSend = useCallback((text: string, attachments: Attachment[]) => {
    if (activeMode === "yolo") {
      setMessages(prev => [...prev, { id:`msg-${Date.now()}`, role:"user", content:text, thinking:"", toolCalls:[], timestamp:Date.now() }]);
      fetch("/api/pi/yolo", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({projectId, prompt:text}) }).catch(()=>{});
      return;
    }
    const uploadErrors = attachments.filter(a => a.uploadStatus === "error");
    if (uploadErrors.length > 0) { setError(`Upload failed: ${uploadErrors.map(a => a.name).join(", ")}`); return; }
    const uploading = attachments.filter(a => a.uploadStatus === "uploading");
    if (uploading.length > 0) { setError(`Waiting for ${uploading.length} file(s)...`); return; }

    const done = attachments.filter(a => a.attachmentId && a.uploadStatus === "done");
    const imageAttachments = done.filter(a => a.category === "image").map(a => ({ attachmentId: a.attachmentId!, name: a.name, mimeType: a.mimeType }));
    const attachmentRefs = done.map(a => ({ id: a.attachmentId!, name: a.name, category: a.category, size: a.size }));

    let fullMessage = text;
    if (attachmentRefs.length > 0) {
      const refBlock = attachmentRefs.map(a => {
        const icon = a.category==="image"?"🖼️":a.category==="pdf"?"📄":a.category==="audio"?"🎵":a.category==="video"?"🎬":"📎";
        return `${icon} **${a.name}** (id: ${a.id}, ${formatFileSize(a.size)})`;
      }).join("\n");
      fullMessage = text.trim() ? `${refBlock}\n\n${text}` : refBlock;
    }
    if (!fullMessage) return;
    if (!text.trim() && attachmentRefs.length === 0) return;
    setError("");

    const isSlash = fullMessage.trim().startsWith("/");
    if (!isSlash) {
      const display = text || (attachmentRefs.length > 0 ? attachmentRefs.map(a => `📎 ${a.name}`).join(", ") : "");
      setMessages(prev => [...prev, { id:Date.now().toString(), role:"user", content:display, thinking:"", toolCalls:[], timestamp:Date.now(), images:imageAttachments.length>0?imageAttachments:undefined, attachmentRefs:attachmentRefs.length>0?attachmentRefs:undefined }]);
    }
    send({ type:"pi_prompt", projectId, message:fullMessage });
  }, [send, projectId, activeMode]);

  if (!activeProject) {
    return <div className="h-full flex items-center justify-center text-hacker-text-dim"><div className="text-center"><div className="text-hacker-accent mb-4 glitch"><PiLogo className="w-16 h-16" /></div><p className="text-lg mb-2">PI CODING AGENT</p><p className="text-sm">Select or create a project to begin...</p></div></div>;
  }

  const hasContent = messages.length > 0;

  return (
    <div className="h-full flex flex-col">
      {hasContent ? (
        <div className="flex-1 overflow-y-auto p-4 chat-messages relative" onScroll={handleScroll}>
          {error && <div className="text-hacker-error text-xs border border-hacker-error/30 p-2 mb-2">{error}</div>}
          {thinkingToast && <div className="text-hacker-accent text-xs border border-hacker-accent/30 p-2 mb-2 bg-hacker-accent/5"><PiLogo className="w-3.5 h-3.5 inline" /> {thinkingToast}</div>}

          {/* Messages */}
          <GroupedMessages messages={messages} thinkDefaultExpanded={thinkDefaultExpanded} onFileClick={setViewerFile} />
          <div ref={chatEndRef} />

          {showScrollBtn && (
            <div className="sticky bottom-4 flex justify-end z-20">
              <button onClick={() => { scrollToBottom("smooth"); isAtBottomRef.current=true; setShowScrollBtn(false); setUnreadCount(0); }}
                className="scroll-to-bottom-btn flex items-center gap-2 px-3 py-1.5 rounded-full border border-hacker-accent/30 bg-hacker-surface/95 backdrop-blur-sm text-hacker-accent text-xs font-medium shadow-lg shadow-hacker-accent/5 hover:bg-hacker-accent/10 hover:border-hacker-accent/50 transition-all animate-fade-in-up">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4" /></svg>
                {unreadCount > 0 && <span className="bg-hacker-accent/20 text-hacker-accent text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none min-w-[18px] text-center">{unreadCount}</span>}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-hacker-accent mb-4 flex justify-center"><PiLogo className="w-[25vmin] h-[25vmin]" /></div>
            <p className="text-hacker-text-dim text-sm">Session active — type a message below to start</p>
            <p className="text-hacker-text-dim text-xs mt-2">{activeProject?.git?.branch && `git:${activeProject.git.branch} · `}{session?.model?.name || "No model selected"}</p>
          </div>
        </div>
      )}

      <ChatInputArea onSend={handleSend} onAbort={() => send({ type:"pi_abort", projectId })} isStreaming={isStreaming} autoReviewStreaming={autoReviewStreaming} yoloStreaming={yoloStreaming} yoloStatus={yoloStatus} gitBranch={activeProject?.git?.branch} setError={setError} />

      {viewerFile && (
        <ModalDialog id="file-viewer" onClose={() => setViewerFile(null)}>
          <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-4 py-2 border-b border-hacker-border shrink-0">
              <span className="text-sm text-hacker-text-bright truncate flex-1">{viewerFile.name || "Attachment"}</span>
              <button onClick={() => setViewerFile(null)} className="text-hacker-text-dim hover:text-hacker-error ml-2 shrink-0"><X size={16} /></button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {viewerFile.type === "image" ? <img src={viewerFile.src} alt={viewerFile.name||"Image"} className="max-w-full max-h-full object-contain mx-auto" /> : <pre className="text-xs text-hacker-text-bright font-mono whitespace-pre-wrap">{viewerFile.content}</pre>}
            </div>
          </div>
        </ModalDialog>
      )}
    </div>
  );
}

// ── Grouped Messages ──
interface AssistantMsg { id:string; content:string; thinking:string; toolCalls:ToolCallInfo[]; timestamp:number; usage?:{input:number;output:number;cost:{total:number}}; _streaming?:boolean; }

const GroupedMessages = memo(function GroupedMessages({ messages, thinkDefaultExpanded, onFileClick }: { messages: DisplayMessage[]; thinkDefaultExpanded: boolean; onFileClick: (f: { type:"image"; src:string; name?:string } | { type:"text"; content:string; name?:string; language?:string }) => void }) {
  const groups: DisplayMessage[][] = [];
  for (const msg of messages) {
    if (msg.role === "user" || groups.length===0 || groups[groups.length-1][0].role==="user") groups.push([msg]);
    else groups[groups.length-1].push(msg);
  }
  return <>{groups.map((group) => {
    const first = group[0];
    if (first.role === "user") return <UserBubble key={first.id} message={first} onFileClick={onFileClick} />;
    return <AssistantGroup key={first.id} messages={group as AssistantMsg[]} thinkDefaultExpanded={thinkDefaultExpanded} />;
  })}</>;
});

// ── User Bubble (unchanged) ──
const UserBubble = memo(function UserBubble({ message, onFileClick }: { message: DisplayMessage; onFileClick: (f: { type:"image"; src:string; name?:string } | { type:"text"; content:string; name?:string; language?:string }) => void }) {
  if (message.customType === "pi_command") return <div className="flex justify-center mb-3"><div className="max-w-[90%] bg-hacker-surface/80 border border-hacker-border rounded-lg px-4 py-2 text-xs text-hacker-text-dim text-left whitespace-pre-wrap font-mono">{message.content}</div></div>;
  if (message.customType === "git_notification") return <div className="flex justify-center mb-3"><div className="max-w-[90%] bg-hacker-surface/80 border border-hacker-border rounded-lg px-4 py-2 text-xs text-hacker-text-dim text-center whitespace-pre-wrap">{message.content}</div></div>;
  return (
    <div className="flex justify-end mb-3">
      <div className="max-w-[85%] bg-hacker-accent/10 border border-hacker-accent/30 rounded-l-lg rounded-br-lg px-3 py-2">
        {message.timestamp ? <div className="text-[9px] text-hacker-text-dim text-right mb-0.5">{formatTime(message.timestamp)}</div> : null}
        {message.content && <span className="text-hacker-text-bright whitespace-pre-wrap text-sm">{message.content}</span>}
        {message.images && message.images.length > 0 && <div className="flex flex-wrap gap-2 mt-2">{message.images.map((img,i) => <div key={i} className="relative group"><img src={`/api/attachments/${img.attachmentId}/file`} alt={img.name} className="max-w-[200px] max-h-[200px] object-contain rounded border border-hacker-border cursor-pointer hover:border-hacker-accent transition-colors" onClick={() => onFileClick({type:"image",src:`/api/attachments/${img.attachmentId}/file`,name:img.name})} /><a href={`/api/attachments/${img.attachmentId}/file`} download={img.name} className="absolute top-1 right-1 p-1 bg-hacker-bg/80 border border-hacker-border rounded text-hacker-text-dim hover:text-hacker-accent opacity-0 group-hover:opacity-100 transition-opacity" title="Download"><Download size={12} /></a></div>)}</div>}
        {message.attachmentRefs && message.attachmentRefs.length > 0 && <div className="flex flex-wrap gap-1.5 mt-2">{message.attachmentRefs.map((ref,i) => { const icon = ref.category==="image"?"🖼️":ref.category==="pdf"?"📄":ref.category==="audio"?"🎵":ref.category==="video"?"🎬":ref.category==="text"?"📝":"📎"; const fu = `/api/attachments/${ref.id}/file`; return <div key={i} className="relative group"><button className="flex items-center gap-1.5 text-xs bg-hacker-bg/40 border border-hacker-border px-2 py-1 rounded hover:border-hacker-accent transition-colors text-hacker-text-bright" onClick={() => { if(ref.category==="image") onFileClick({type:"image",src:fu,name:ref.name}); else if(ref.category==="pdf") window.open(fu,"_blank"); }}><span>{icon}</span><span>{ref.name}</span><span className="text-hacker-text-dim">{formatFileSize(ref.size)}</span></button><a href={fu} download={ref.name} className="absolute -top-1 -right-1 p-0.5 bg-hacker-bg/80 border border-hacker-border rounded text-hacker-text-dim hover:text-hacker-accent opacity-0 group-hover:opacity-100 transition-opacity" title="Download"><Download size={10} /></a></div>; })}</div>}
        {message.attachments && message.attachments.length > 0 && <div className="flex flex-wrap gap-2 mt-2">{message.attachments.map((att,i) => <div key={i} className="relative group"><button className="flex items-center gap-1.5 text-xs bg-hacker-bg/40 border border-hacker-border px-2 py-1 rounded hover:border-hacker-accent transition-colors text-hacker-text-bright" onClick={() => onFileClick({type:"text",content:att.content,name:att.name})}><FileText size={12} />{att.name}</button><a href={`data:text/plain;charset=utf-8,${encodeURIComponent(att.content)}`} download={att.name} className="absolute -top-1 -right-1 p-0.5 bg-hacker-bg/80 border border-hacker-border rounded text-hacker-text-dim hover:text-hacker-accent opacity-0 group-hover:opacity-100 transition-opacity" title="Download"><Download size={10} /></a></div>)}</div>}
        {message.usage && <span className="text-[9px] text-hacker-text-dim shrink-0">{message.usage.input + message.usage.output}t</span>}
      </div>
    </div>
  );
});

// ── Assistant Group (redesigned) ──
const AssistantGroup = memo(function AssistantGroup({ messages, thinkDefaultExpanded }: { messages: AssistantMsg[]; thinkDefaultExpanded: boolean }) {
  const [thinkExpanded, setThinkExpanded] = useState(thinkDefaultExpanded);

  const allThinking: string[] = []; const allTools: ToolCallInfo[] = [];
  let finalText = ""; let totalUsage: {input:number;output:number;cost:{total:number}} | undefined; let isStreaming = false;
  for (const msg of messages) {
    if (msg.thinking) allThinking.push(msg.thinking);
    allTools.push(...msg.toolCalls);
    if (msg.content) finalText = msg.content;
    if (msg.usage) totalUsage = totalUsage ? {input:totalUsage.input+msg.usage.input,output:totalUsage.output+msg.usage.output,cost:{total:totalUsage.cost.total+msg.usage.cost.total}} : msg.usage;
    if (msg._streaming) isStreaming = true;
  }
  const mergedThinking = allThinking.join("\n\n---\n\n");
  const hasThinking = allThinking.length > 0;
  const hasTools = allTools.length > 0;
  const toolName = (tc:ToolCallInfo) => { const s = (tc.name||'?').replace(/^(analyze_|git_|firecrawl_|memory_)/,""); return s.length>16?s.slice(0,14)+"…":s; };

  return (
    <div className="flex justify-start mb-3">
      <div className={`max-w-[95%] bg-hacker-surface border rounded-r-lg rounded-bl-lg overflow-hidden ${isStreaming ? "border-hacker-accent/50 shadow-[0_0_8px_rgba(var(--accent-rgb),0.15)]" : "border-hacker-border"}`}>
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-hacker-border/50 bg-hacker-bg/30">
          <span className="text-[0.625rem] text-hacker-accent font-bold tracking-wider">{isStreaming?"⚡ STREAMING":"🤖 RESPONSE"}</span>
          {messages[0]?.timestamp && <span className="text-[0.625rem] text-hacker-text-dim">{formatTime(messages[0].timestamp)}</span>}
          {totalUsage && <span className="text-[0.625rem] text-hacker-text-dim">{totalUsage.input+totalUsage.output} tok</span>}
          <div className="flex-1" />
          {hasThinking && <button onClick={() => setThinkExpanded(!thinkExpanded)} className="text-[0.625rem] text-hacker-text-dim hover:text-hacker-warn transition-colors" title="Toggle thinking">{thinkExpanded?"🧠▼":"🧠▶"}</button>}
          {isStreaming && <span className="w-2 h-2 rounded-full bg-hacker-accent animate-pulse" />}
        </div>

        {/* Thinking */}
        {hasThinking && (
          <div className="border-b border-hacker-border/30">
            {thinkExpanded ? (
              <div className="px-3 py-2"><ThinkingBlock thinking={mergedThinking} defaultExpanded={true} /></div>
            ) : (
              <div className="px-3 py-2"><button onClick={() => setThinkExpanded(true)} className="text-[0.625rem] text-hacker-text-dim hover:text-hacker-warn hover:underline">💭 Thinking ({allThinking.length} block{allThinking.length>1?"s":""}) — click to expand</button></div>
            )}
          </div>
        )}

        {/* Tools — compact single line */}
        {hasTools && (
          <div className="px-3 py-1.5 border-b border-hacker-border/30 flex items-center gap-1.5 flex-wrap">
            {allTools.map((tc, i) => (
              <span key={tc.id} className={`inline-flex items-center gap-1 text-[0.5625rem] font-mono ${
                tc.isStreaming ? "text-hacker-accent animate-pulse"
                : tc.isError ? "text-red-400"
                : "text-hacker-text-dim/60"
              }`}>
                {tc.isStreaming ? "⏳" : tc.isError ? "❌" : "📝"}
                {toolName(tc)}{i < allTools.length-1 ? "," : ""}
              </span>
            ))}
          </div>
        )}

        {/* Response text */}
        <div className="px-3 py-2 prose-hacker">
          {finalText ? <MemoizedReactMarkdown>{finalText}</MemoizedReactMarkdown> : isStreaming && !hasTools ? <span className="text-hacker-text-dim italic text-sm">Thinking…</span> : null}
          {isStreaming && finalText && <span className="cursor-blink" />}
        </div>
      </div>
    </div>
  );
});

// ── ChatInputArea (unchanged) ──
const ChatInputArea = memo(function ChatInputArea({ onSend, onAbort, isStreaming, autoReviewStreaming, yoloStreaming, yoloStatus, gitBranch, setError }: {
  onSend: (text:string, attachments:Attachment[]) => void; onAbort: () => void; isStreaming: boolean; autoReviewStreaming: boolean;
  yoloStreaming: boolean; yoloStatus: { phase:string; globalCycle:number; localCycle:number; agent?:string; model?:string } | null;
  gitBranch?: string; setError: (e:string) => void;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState(""); const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false); const inputRef = useRef<HTMLTextAreaElement>(null); const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback(async (file: File) => {
    if (attachments.length >= 10) { setError("Maximum 10 files per message"); return; }
    const category = categorizeFile(file.type||"application/octet-stream", file.name);
    if (file.size > 100*1024*1024) { setError(`File too large: ${formatFileSize(file.size)}`); return; }
    const uid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const localPreview = category==="image" ? URL.createObjectURL(file) : undefined;
    setAttachments(prev => [...prev, { id:uid, name:file.name, mimeType:file.type||"application/octet-stream", size:file.size, category, data:"", preview:localPreview, uploadStatus:"uploading" }]);
    try {
      const fd = new FormData(); fd.append("files", file);
      const r = await fetch("/api/attachments/upload", { method:"POST", body:fd });
      if (!r.ok) { const ed = await r.json().catch(()=>({error:"Upload failed"})); throw new Error(ed.error||`Upload failed: ${r.status}`); }
      const data = await r.json(); const uploaded = data.attachments?.[0];
      if (!uploaded) throw new Error("No attachment data returned");
      setAttachments(prev => prev.map(a => a.id===uid ? {...a, attachmentId:uploaded.id, uploadStatus:"done", preview:a.preview||URL.createObjectURL(file)} : a));
    } catch (err: any) {
      setAttachments(prev => prev.map(a => a.id===uid ? {...a, uploadStatus:"error", uploadError:err.message} : a));
      setError(`Upload failed: ${err.message}`);
    }
  }, [attachments.length, setError]);

  const handleSendClick = useCallback(() => { const txt = input.trim(); if (!txt && attachments.length===0) return; onSend(input, attachments); setInput(""); setAttachments([]); if (inputRef.current) inputRef.current.style.height='auto'; }, [input, attachments, onSend]);
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => { if (e.key==="Enter" && !e.shiftKey) { e.preventDefault(); handleSendClick(); } }, [handleSendClick]);
  const handleDrop = useCallback((e: React.DragEvent) => { e.preventDefault(); setIsDragOver(false); for (const f of Array.from(e.dataTransfer.files)) processFile(f); }, [processFile]);
  const handlePaste = useCallback((e: React.ClipboardEvent) => { for (const item of e.clipboardData.items) { if (item.type.startsWith("image/")) { const b = item.getAsFile(); if (b) processFile(b); } } }, [processFile]);
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => { if (e.target.files) for (const f of Array.from(e.target.files)) processFile(f); }, [processFile]);

  return (
    <div className="border-t border-hacker-border-bright bg-hacker-surface p-3" onDrop={handleDrop} onDragOver={e=>{e.preventDefault();setIsDragOver(true)}} onDragLeave={()=>setIsDragOver(false)} onPaste={handlePaste}>
      {isDragOver && <div className="absolute inset-0 flex items-center justify-center bg-hacker-bg/80 z-20"><div className="text-hacker-accent text-2xl glitch">DROP FILES HERE</div></div>}
      {attachments.length > 0 && <div className="flex gap-2 mb-2 flex-wrap">{attachments.map(att => <div key={att.id} className={`flex items-center gap-1.5 text-xs border px-2 py-1.5 rounded group ${att.uploadStatus==="error"?"bg-red-500/10 border-red-500/50":att.uploadStatus==="uploading"?"bg-hacker-accent/10 border-hacker-accent/30 animate-pulse":"bg-hacker-border/40 border-hacker-border"}`}>{att.uploadStatus==="uploading"?<span className="text-hacker-accent animate-spin">⏳</span>:att.uploadStatus==="error"?<span className="text-red-400">⚠️</span>:att.category==="image"&&att.preview?<img src={att.preview} alt={att.name} className="w-8 h-8 object-cover rounded" />:<span className="text-hacker-accent">{getFileExtensionIcon(att.category,att.name)}</span>}<span className="truncate max-w-[120px]">{att.name}</span><span className="text-hacker-text-dim">{formatFileSize(att.size)}</span>{att.uploadStatus==="done"&&<span className="text-green-400 text-[9px]">✓</span>}{att.uploadStatus==="error"&&att.uploadError&&<span className="text-red-400 text-[9px] truncate max-w-[100px]" title={att.uploadError}>❌</span>}<button onClick={()=>setAttachments(prev=>prev.filter(a=>a.id!==att.id))} className="text-hacker-text-dim hover:text-hacker-error ml-1"><X size={12}/></button></div>)}</div>}
      <div className="text-hacker-text-dim text-[0.625rem] mb-1 flex justify-between"><span>{t('chat.keyboardHints')}</span><span className="flex items-center gap-2">{gitBranch&&<span>git:{gitBranch}</span>}{autoReviewStreaming&&<span className="text-hacker-warn flex items-center gap-1"><span className="pulse-dot w-1.5 h-1.5 bg-hacker-warn"/> {t('autoReview.inProgress')}</span>}{yoloStreaming&&yoloStatus&&<span className="text-hacker-accent flex items-center gap-1"><span className="pulse-dot w-1.5 h-1.5"/>YOLO {yoloStatus.phase.toUpperCase()}{yoloStatus.agent?` (${yoloStatus.agent}${yoloStatus.model?`: ${yoloStatus.model}`:""})`:""} — G{yoloStatus.globalCycle}{yoloStatus.localCycle>0?`·${yoloStatus.localCycle}`:""}</span>}{isStreaming&&!autoReviewStreaming&&!yoloStreaming&&<span className="text-hacker-accent flex items-center gap-1"><span className="pulse-dot w-1.5 h-1.5"/> {t('common.loading')}</span>}</span></div>
      <div className="flex gap-2">
        <textarea ref={inputRef} value={input} onChange={e=>{setInput(e.target.value);const t=e.target;t.style.height='auto';const lh=parseInt(getComputedStyle(t).lineHeight)||20;t.style.height=Math.min(t.scrollHeight,lh*8)+'px'}} onKeyDown={handleKeyDown} placeholder={isStreaming?t('chat.queueMessage'):t('chat.typeMessage')} className="input-hacker flex-1 resize-none overflow-y-auto" rows={2} style={{minHeight:'3rem',maxHeight:'10rem'}}/>
        <div className="flex flex-col gap-1">
          <button onClick={handleSendClick} className="btn-hacker flex-1 px-4" disabled={!input.trim()&&attachments.length===0}>{t('chat.send')}</button>
          <div className="flex gap-1"><button onClick={()=>fileInputRef.current?.click()} className="btn-hacker px-2 text-xs" title={t('common.add')}><Paperclip size={14}/></button>{isStreaming&&<button onClick={onAbort} className="btn-hacker danger px-4 text-xs">ABORT</button>}</div>
        </div>
      </div>
      <input ref={fileInputRef} type="file" multiple accept="image/*,text/*,application/json,application/xml,application/javascript,application/x-shellscript,.js,.ts,.tsx,.jsx,.py,.rb,.rs,.go,.java,.kt,.swift,.c,.cpp,.h,.hpp,.cs,.php,.sh,.bash,.sql,.yaml,.yml,.toml,.ini,.cfg,.env,.md,.txt,.log,.css,.scss,.less,.html,.svg" onChange={handleFileSelect} className="hidden"/>
    </div>
  );
});
