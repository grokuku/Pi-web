import { useState, useRef, useEffect, useLayoutEffect, useCallback, memo, useMemo, useDeferredValue, type ComponentPropsWithoutRef, type RefObject } from "react";
import { Paperclip, X, Image, FileText, File, AlertTriangle, Download, Copy, Maximize, Minimize, ZoomIn, ZoomOut } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PiEvent, ToolCallInfo, Attachment, DisplayMessage, AssistantBlock } from "../../types";
import { PiLogo } from "../common/PiLogo";
import { ModalDialog } from "../common/ModalDialog";
import { NewChatConfirmModal } from "../Modals/NewChatConfirmModal";
import { ThinkingBlock } from "./ThinkingBlock";
import { CollapsibleBlock, CollapseProvider, useCollapsible } from "./CollapsibleBlock";
import { SubAgentBlock } from "./SubAgentBlock";
import { ParallelSubAgents } from "./ParallelSubAgents";
import { ToolCallTimer } from "./ToolCallTimer";
import { buildToolSummaryFromCall, formatToolDuration } from "../../utils/toolSummaries";
import { readDisplayDetailExpanded, writeDisplayDetailExpanded, subscribeDisplayDetail } from "../../utils/display-detail";
import { useTranslation } from "../../i18n";
import { copyToClipboard } from "../../utils/clipboard";
import { pushOverlay, popOverlay, isTopOverlay } from "../../hooks/useOverlayStack";
import { useIsMobile } from "../../hooks/useMediaQuery";
// Brique HolafViewport (holaf-lib v0.1.3) — copie pinnée dans vendor/holaf.
// Zoom/pan/fit de l'image plein écran (mode content, souris-only).
import { HolafViewport } from "../../vendor/holaf/holaf-viewport.js";
import { toast } from "../../utils/holaf-toast";
import { getPreviewMode, openImagePopup } from "../../utils/preview-mode";
import type { Project } from "../../types";
import { useChatHistory, convertHistoryToDisplayMessages } from "../../hooks/useChatHistory";
import { applyPiEvent, appendMessageDedup, findPendingUserMessages, prependHistoryBatch } from "../../utils/pi-events";
import { routeSubagentEnvelope, resetSubagentRuns, insertDatedRuns, delegateAnchorTimestamp, useDatedDetachedRuns, useConcurrentWallAnchor, type SubagentEnvelope } from "../../stores/subagentRuns";
import { DatedSubAgentBlock } from "./SubAgentBlock";
import { parseChatCacheSnapshot } from "../../utils/chat-cache";
import { resolveScrollAction } from "../../utils/chat-scroll";

// ── (perf) Throttle de valeur (re-parse markdown) ────────────────────────
// Retarde la propagation d'une valeur qui change très souvent (contenu
// markdown du message en streaming) : le re-parse ReactMarkdown n'a lieu qu'au
// plus toutes les `delay` ms. setTimeout + cleanup (pas de fuite de timer).
function useThrottledValue<T>(value: T, delay = 45): T {
  const [throttled, setThrottled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setThrottled(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return throttled;
}

// ── Bloc de code markdown avec bouton « copier » ──────────────────────────
// Remplace le <pre> par défaut de react-markdown (blocs ``` → <pre><code>) :
// enveloppe le <pre> dans un conteneur relative et ajoute un bouton overlay
// top-right, visible au survol du bloc, qui copie le contenu TEXTUEL du code
// (textContent du <pre>, pas le HTML) via le helper clipboard robuste
// (fallback execCommand pour le http LAN non sécurisé).
// - State « copied » local par bloc : un composant dédié évite les states
//   dans le map des messages ; le state survit au re-render de streaming
//   (même position dans l'arbre).
// - Le <pre> garde son overflow-x (CSS .prose-hacker) : le bouton est posé
//   sur le conteneur, il ne participe pas au scroll horizontal du code.
const CodeBlockWithCopy = memo(function CodeBlockWithCopy({
  node: _node, // hast node passé par react-markdown — ignoré, ne doit pas fuir vers le DOM
  children,
  ...rest
}: ComponentPropsWithoutRef<"pre"> & { node?: unknown }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Nettoyage du timer de feedback si le bloc est démonté
  useEffect(() => () => { if (resetTimerRef.current) clearTimeout(resetTimerRef.current); }, []);

  const handleCopy = useCallback(async () => {
    const text = preRef.current?.textContent ?? "";
    if (!text) return;
    const ok = await copyToClipboard(text);
    if (!ok) return;
    setCopied(true);
    // Feedback « Copié ✓ » pendant 2s puis retour à l'icône copier
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setCopied(false), 2000);
  }, []);

  return (
    <div className="relative group/code">
      <pre ref={preRef} {...rest}>{children}</pre>
      <button
        type="button"
        onClick={handleCopy}
        title={copied ? t('chat.copied') : t('chat.copyCode')}
        aria-label={copied ? t('chat.copied') : t('chat.copyCode')}
        className="absolute top-1.5 right-1.5 z-10 flex items-center justify-center rounded border border-hacker-border bg-hacker-bg/80 px-1.5 py-1 text-hacker-text-dim hover:text-hacker-accent opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100 transition-opacity duration-150 cursor-pointer"
      >
        {copied ? <span className="text-[10px] leading-none font-mono">{t('chat.copied')}</span> : <Copy size={12} />}
      </button>
    </div>
  );
});

// ── Memoized ReactMarkdown ──
const MemoizedReactMarkdown = memo(function MemoizedReactMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Blocs ``` → <pre><code> : le <pre> est remplacé par CodeBlockWithCopy
        // (conteneur relative + bouton « copier » en overlay).
        pre: CodeBlockWithCopy,
      }}
    >
      {children}
    </ReactMarkdown>
  );
});

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Construit la source d'une image utilisateur : URL serveur si attachmentId,
// sinon data URL à partir du base64 legacy.
function getImageSrc(img: NonNullable<DisplayMessage["images"]>[number]): string {
  if (img.attachmentId) return `/api/attachments/${img.attachmentId}/file`;
  if (img.data) {
    return img.data.startsWith("data:")
      ? img.data
      : `data:${img.mimeType || "image/png"};base64,${img.data}`;
  }
  return "";
}

// Convertit un Blob en base64 brut (sans préfixe `data:...;base64,`).
// Utilisé pour envoyer l'image directement au modèle courant (vision dans le
// contexte) au lieu de passer par une transcription via analyze_file.
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] || "");
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
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
  // Lot B : retourne true si le message a été envoyé, false s'il a été mis en
  // file d'attente (hors connexion) ou refusé — voir hooks/useWebSocket.ts.
  send: (msg: any) => boolean;
  on: (type: string, cb: (msg: any) => void) => () => void;
  activeProject: Project | null;
  isStreaming: boolean;
  streamingStalled?: boolean;
  session: any;
  projectId: string;
  activeMode?: string;
  // Lot B : état connexion WS + taille de la file d'attente d'envoi,
  // pour la bannière « connexion perdue » en haut des messages.
  connected: boolean;
  pendingMessages: number;
  onQuit?: () => void;
}

// ── (perf) Events de finalisation ─────────────────────────────────────
// Seuls ces events déclenchent une écriture immédiate du store chatHistory
// dans le handler pi_event : pendant le streaming (message_start, *_delta,
// toolcall_*, tool_execution_*), on n'écrit plus le store à chaque chunk.
// Les remplacements pi_history sont écrits par l'effet pi_history dédié.
const FINALIZE_EVENT_TYPES = new Set<string>(["message_end", "session_reloaded"]);

// ── Bannière « connexion perdue » (Lot B — visibilité déconnexion WS) ──────
// Discrète et persistante : affichée en haut de la zone de messages tant que
// le WebSocket est déconnecté (reconnexion automatique en arrière-plan).
// Style calqué sur la bannière d'erreur existante mais en ton warning/info.
// Mentionne le nombre de messages en attente dans la file d'envoi le cas échéant.
const WsOfflineBanner = memo(function WsOfflineBanner({ pendingMessages }: { pendingMessages: number }) {
  const { t } = useTranslation();
  return (
    <div className="sticky top-0 z-20 flex items-center gap-2 px-4 py-1.5 mb-2 text-xs text-hacker-warn bg-hacker-bg/95 backdrop-blur-sm border border-hacker-warn/30 rounded-sm">
      <span className="w-1.5 h-1.5 rounded-full bg-hacker-warn animate-pulse shrink-0" />
      <span className="truncate">
        {t('chat.wsOffline')}
        {pendingMessages > 0 && (
          <span className="text-hacker-text-dim"> · {t('chat.wsPendingMessages', pendingMessages)}</span>
        )}
      </span>
    </div>
  );
});

// ── Bannière « affichage depuis un cache local » (filet de secours 6210d1c) ─
// Le fallback localStorage peut fournir un contenu qui n'est PAS la vérité
// backend (snapshot tronqué à 200 messages, figé à la dernière session). Tant
// qu'aucun pi_history n'a été appliqué pour le projet, un bandeau discret le
// signale — il disparaît dès la première resync backend.
const LocalCacheBanner = memo(function LocalCacheBanner() {
  const { t } = useTranslation();
  return (
    <div className="sticky top-0 z-20 flex items-center gap-2 px-4 py-1.5 mb-2 text-xs text-hacker-text-dim bg-hacker-bg/95 backdrop-blur-sm border border-hacker-border rounded-sm">
      <span className="w-1.5 h-1.5 rounded-full bg-hacker-text-dim animate-pulse shrink-0" />
      <span className="truncate">{t('chat.localCache')}</span>
    </div>
  );
});

// ── Ajustement 2 : feedback « Historique resynchronisé » ──────────────────
// Après une coupure WS (ou un changement d'état backend), la resync renvoie
// l'historique COMPLET (buildFullUiHistory — cas réel : 2228 messages bruts /
// 644 groupes affichables) qui remplace le chat d'un coup, sans explication :
// l'utilisateur a cru à un bug et a aborté (incident « chat figé puis
// rattrapage massif »). Un pi_history massif arrivant dans la fenêtre qui
// suit une RECONNEXION affiche donc un toast discret. Le chargement initial
// (montage / activation de projet → pi_history_request de activateProject)
// reste silencieux : un historique complet y est NORMAL.
const RESYNC_FEEDBACK_WINDOW_MS = 10_000; // pi_history de resync attendu < 1 s après le _ws_reconnect
const RESYNC_MASSIVE_MIN = 100;           // seuil « massif en soi » : > 100 messages affichables reçus
const RESYNC_MASSIVE_DELTA = 50;          // seuil « rattrapage » : > 50 de plus que l'affiché actuel
const RESYNC_TOAST_DURATION_MS = 4500;

export function ChatView({ send, on, activeProject, isStreaming, streamingStalled, session, projectId, activeMode, connected, pendingMessages, onQuit }: Props) {
  const { t } = useTranslation();

  // ── State ──
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  // ── Réglage « détail d'affichage déplié par défaut » (LOT 1) ──
  // Renommé depuis thinkDefaultExpanded (pi-web-thinking-expand →
  // pi-web-display-detail, migration one-shot dans utils/display-detail).
  // Pilote le repli de TOUS les blocs de détail (réflexion, sorties d'outils,
  // sous-agent) via CollapseProvider — y compris les blocs DÉJÀ MONTÉS.
  const [displayDetailExpanded, setDisplayDetailExpanded] = useState(() => readDisplayDetailExpanded());
  // Synchronisation SettingsModal → chat : le modal écrit via
  // writeDisplayDetailExpanded (localStorage + notification) → on suit ici.
  // (Ctrl+T passe par le même canal : write notifie, setState fait doublon
  // sans effet — React baille si la valeur est identique.)
  useEffect(() => subscribeDisplayDetail(setDisplayDetailExpanded), []);
  const [viewerFile, setViewerFile] = useState<{ type: "image"; src: string; name?: string } | { type: "text"; content: string; name?: string; language?: string } | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [confirmNewChat, setConfirmNewChat] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const messagesWrapperRef = useRef<HTMLDivElement | null>(null);
  const currentAssistantIdRef = useRef<string | null>(null);
  const messagesRef = useRef<DisplayMessage[]>([]);
  // BUG-21 fix: flag pour ignorer le pi_history qui arrive après un /new ou /clear
  const justClearedRef = useRef(false);
  // Horodate du /clear ou /new : le pi_history n'est avalé que s'il arrive
  // dans la fenêtre qui suit la commande. Avant ce fix, le flag restait vrai
  // pour toujours quand aucun pi_history ne suivait la commande (le backend ne
  // en push PAS après /clear//new, et un pi_history vide sortait avant le
  // reset du flag) → la PROCHAINE resync légitime (reconnexion WS, changement
  // de projet) était avalée elle aussi : l'historique affiché restait
  // tronqué/périmé jusqu'à un reload complet (« les récents manquent »).
  const clearedAtRef = useRef(0);
  // Ajustement 2 : horodate de la dernière reconnexion WS (_ws_reconnect — émis
  // par useWebSocket à CHAQUE reconnexion, JAMAIS à la première connexion).
  // Un pi_history arrivant dans RESYNC_FEEDBACK_WINDOW_MS après ce signal est
  // une resync post-coupure → éligible au toast « Historique resynchronisé »
  // s'il est massif. Le chargement initial / l'activation de projet (hors
  // fenêtre) restent silencieux.
  const lastWsReconnectAtRef = useRef(0);
  // Ajustement 2 : anti-doublon du toast de resync (pi_start rejoué de la file
  // + pi_history_request renvoyé par App peuvent provoquer deux pi_history
  // rapprochés dans la même fenêtre de reconnexion).
  const lastResyncToastAtRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatHistory = useChatHistory(projectId);

  // ── Chargement par lots (fix de fond « messages récents manquants ») ──
  // Le backend n'envoie plus l'historique COMPLET dans pi_history (un payload
  // de 10 Mo / 2321 messages faisait flapper le WS → historique perdu en
  // route) mais les N derniers messages + un curseur :
  //   { from: index du 1er message envoyé dans la liste complète,
  //     total, hasMore }
  // serverHistoryMeta suit ce curseur pour que « charger les antérieurs »
  // puisse demander le lot précédent (pi_history_page) au bon endroit.
  // null = historique complet reçu (ancien format sans métadonnées) → pas de
  // pagination serveur nécessaire, comportement legacy inchangé.
  const [serverHistoryMeta, setServerHistoryMeta] = useState<{ from: number; total: number; hasMore: boolean } | null>(null);
  const serverHistoryMetaRef = useRef<{ from: number; total: number; hasMore: boolean } | null>(null);
  // Lot serveur en cours de chargement (anti double-clic + feedback bouton).
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const loadingEarlierRef = useRef(false);
  // Timeout de sécurité : si la réponse ne vient jamais (replay file perdu),
  // le bouton est réarmé pour permettre une nouvelle tentative.
  const loadingEarlierTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Signal d'arrivée d'un lot (séquentiel) + flag « all » du dernier lot :
  // consommé par GroupedMessages pour étendre sa fenêtre visible APRÈS le
  // préfixage (sinon le lot fraîchement chargé resterait masqué au-dessus du
  // viewport). Séquentiel : un remount (changement de projet) part de la seq
  // courante, sans re-déclencher les anciens lots.
  const [serverBatch, setServerBatch] = useState<{ seq: number; all: boolean }>({ seq: 0, all: false });
  const armLoadingTimer = useCallback(() => {
    if (loadingEarlierTimerRef.current) clearTimeout(loadingEarlierTimerRef.current);
    loadingEarlierTimerRef.current = setTimeout(() => {
      loadingEarlierRef.current = false;
      setLoadingEarlier(false);
    }, 15_000);
  }, []);
  // Filet de secours « needsHistory » (régression 6210d1c) : projets pour
  // lesquels un pi_history NON VIDE a été appliqué depuis le chargement de la
  // page. Le premier prompt d'un projet absent de cet ensemble porte le
  // marqueur needsHistory → le backend renvoie l'historique (fenêtre serveur,
  // plafonnée au lot initial). Le cache
  // localStorage NE compte PAS (snapshot tronqué, pas la vérité backend).
  const historyReceivedRef = useRef<Set<string>>(new Set());
  // Bandeau « affichage depuis un cache local » : vrai tant que l'affichage
  // courant vient du fallback localStorage sans confirmation backend.
  const [localCacheOnly, setLocalCacheOnly] = useState(false);

  const hasContent = messages.length > 0;
  const prevProjectIdRef = useRef(projectId);

  // ── Project switching ──
  useEffect(() => {
    const prevId = prevProjectIdRef.current;
    if (prevId && prevId !== projectId) {
      chatHistory.saveMessagesFor(messagesRef.current, prevId);
      // Also persist assistantId for the project we're leaving
      chatHistory.setAssistantIdFor(prevId, currentAssistantIdRef.current);
      // LOT 2b (étanchéité) : on purge les runs TERMINÉS du projet QUITTÉ (les
      // archivés reviendront par la resync pi_history) mais on PRÉSERVE ses runs
      // encore actifs (le projet peut continuer à déléguer en arrière-plan —
      // à son retour, l'utilisateur retrouve son sous-agent en cours). Les runs
      // des autres projets ne sont jamais touchés : le store est scopé par
      // projectId et chaque conversation n'expose que SES sous-agents.
      resetSubagentRuns(prevId);
    }
    prevProjectIdRef.current = projectId;

    // Restore from chatHistory store (now kept up-to-date by pi_event routing)
    const stored = chatHistory.getMessages();
    if (stored.length > 0) {
      setMessages(stored);
      // Contenu tenu à jour par les events/pi_history backend : vérité vivante.
      setLocalCacheOnly(false);
      // Restore the assistantId for in-progress streaming reconciliation
      currentAssistantIdRef.current = chatHistory.getAssistantIdFor(projectId);
    } else {
      // Fallback: localStorage for sessions that predate the routing fix.
      // Garde d'ancienneté : un snapshot de PLUS de 24 h ne doit jamais être
      // présenté comme l'état courant (le backend a pu tourner des heures
      // entre-temps) → chat vide, la resync backend (pi_history) fera foi.
      try {
        const snap = parseChatCacheSnapshot(localStorage.getItem(`pi-web-chat-${projectId}`));
        if (snap && snap.fresh) {
          chatHistory.saveMessages(snap.messages);
          setMessages(snap.messages);
          // Contenu issu du CACHE (pas du backend) : bandeau discret jusqu'à
          // la première resync pi_history.
          setLocalCacheOnly(true);
        } else {
          if (snap) {
            console.log(`[Chat] Cache local de ${projectId} périmé (${snap.ageMs === Infinity ? "sans horodatage" : Math.round(snap.ageMs / 3_600_000) + " h"}) — ignoré, en attente de resync backend`);
          }
          setMessages([]);
          setLocalCacheOnly(false);
        }
      } catch {
        setMessages([]);
        setLocalCacheOnly(false);
      }
      currentAssistantIdRef.current = null;
    }
    setError("");
    // Chargement par lots : le curseur serveur est propre au projet — réinit.
    // La resync pi_history déclenchée à l'activation du projet re-pose un
    // curseur frais, aligné sur la liste rechargée.
    setServerHistoryMeta(null);
    serverHistoryMetaRef.current = null;
    setLoadingEarlier(false);
    loadingEarlierRef.current = false;
  }, [projectId]);

  // Instant ref sync (cheap)
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { serverHistoryMetaRef.current = serverHistoryMeta; }, [serverHistoryMeta]);
  useEffect(() => { loadingEarlierRef.current = loadingEarlier; }, [loadingEarlier]);

  // Debounced persistence (expensive — localStorage + JSON.stringify blocks main thread)
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      if (!projectId) return;
      chatHistory.saveMessages(messagesRef.current);
      // BUG-22 fix: limiter à 200 messages pour éviter QuotaExceededError (5-10MB)
      const maxMessages = 200;
      const toSave = messagesRef.current.length > maxMessages
        ? messagesRef.current.slice(-maxMessages)
        : messagesRef.current;
      try { localStorage.setItem(`pi-web-chat-${projectId}`, JSON.stringify(toSave)); } catch {}
      saveTimerRef.current = null;
    }, 500);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [messages, projectId]);

  // ── Ajustement 2 : toast « Historique resynchronisé : N messages » ───────
  // Appelé aux points où un pi_history est réellement APPLIQUÉ au projet
  // actif (seul cas où le chat visible change). Décision = contexte ET
  // massivité :
  //  1. dans la fenêtre qui suit une reconnexion WS (_ws_reconnect) — c'est
  //     ce qui distingue la resync post-coupure du chargement initial (la
  //     première connexion n'émet pas _ws_reconnect) et du changement de
  //     projet (pi_history_request de activateProject, hors fenêtre) ;
  //  2. massivité : historique reçu > RESYNC_MASSIVE_MIN messages affichables,
  //     OU apporte > RESYNC_MASSIVE_DELTA de plus que l'affiché (store local
  //     vide/tronqué — le « rattrapage massif » de l'incident) ;
  //  3. anti-doublon : un seul toast par fenêtre de resync.
  // Compte affiché = nombre de messages/groupes DisplayMessage (les tool
  // results sont foldés), c'est ce que l'utilisateur voit à l'écran.
  const notifyHistoryResync = useCallback((before: number, after: number) => {
    const now = Date.now();
    if (lastWsReconnectAtRef.current === 0 ||
        now - lastWsReconnectAtRef.current >= RESYNC_FEEDBACK_WINDOW_MS) return;
    if (after <= RESYNC_MASSIVE_MIN && after - before <= RESYNC_MASSIVE_DELTA) return;
    if (now - lastResyncToastAtRef.current < RESYNC_FEEDBACK_WINDOW_MS) return;
    lastResyncToastAtRef.current = now;
    toast(t("chat.historyResynced", after), "info", RESYNC_TOAST_DURATION_MS);
  }, [t]);

  // ── History restoration ──
  // pi_history is the backend's full state sync. Route to the correct
  // project's store, not just the active one, so that switching project
  // shows the latest state even after a session reload.
  //
  // ⚠️  CRITICAL: pi_history does NOT include the in-progress streaming message
  // (Pi SDK commits messages only on message_end). Overwriting the store
  // with pi_history while streaming is active would corrupt the streaming
  // state and break assistantId tracking. Preserve _streaming messages UNLESS
  // the backend has more finalized data (agent finished during disconnect).
  useEffect(() => {
    const unsub = on("pi_history", (msg: any) => {
      const pid = msg.projectId;
      if (!pid || !msg.messages || !Array.isArray(msg.messages) || msg.messages.length === 0) return;
      // BUG-21 fix: ignorer le pi_history qui arrive juste après un /new ou /clear
      // (fenêtre de 10 s : au-delà, c'est une resync légitime — reconnect,
      // changement de projet — qui ne doit PAS être avalée, sinon l'UI reste
      // bloquée sur un état périmé et les derniers messages disparaissent).
      if (justClearedRef.current) {
        if (Date.now() - clearedAtRef.current < 10_000) {
          justClearedRef.current = false;
          clearedAtRef.current = 0;
          return;
        }
        // Resync tardive (> 10 s après le clear) : c'est un vrai état backend,
        // on l'applique et on nettoie le flag.
        justClearedRef.current = false;
        clearedAtRef.current = 0;
      }

      const existing = chatHistory.getMessagesFor(pid);
      const streamingMsgs = existing.filter(m => m._streaming);

      // needsHistory (filet de secours, régression 6210d1c) : un pi_history
      // NON VIDE appliqué (ou au moins reçu non avalé) marque le projet comme
      // « historique reçu » → les prompts suivants ne porteront plus le
      // marqueur : l'historique n'est renvoyé par le backend qu'UNE fois.
      historyReceivedRef.current.add(pid);

      // Chargement par lots : mémoriser le curseur serveur joint au payload
      // (from/total/hasMore). Absent → historique complet (ancien format ou
      // session courte) : pas de pagination serveur nécessaire (null).
      // Posé ICI (pi_history APPLIQUÉ ou au moins reçu non avalé) — la liste
      // locale devient la fenêtre [from, from+messages.length[ de la liste
      // complète backend.
      const applyHistoryWindowMeta = (m: any) => {
        // Réservé au projet AFFICHÉ : la méta est l'état du chat courant (les
        // projets en arrière-plan re-synchroniseront leur curseur à l'activation
        // via pi_history_request).
        if (pid !== projectId) return;
        const meta =
          typeof m.from === "number" && typeof m.total === "number"
            ? { from: m.from, total: m.total, hasMore: !!m.hasMore }
            : null;
        setServerHistoryMeta(meta);
        serverHistoryMetaRef.current = meta;
      };

      if (streamingMsgs.length > 0) {
        // Streaming in progress — but check if agent finished during WS gap.
        // If history has MORE finalized messages than our non-streaming count,
        // the streaming message is orphaned → apply the finalized history.
        const nonStreamingCount = existing.length - streamingMsgs.length;
        const display = convertHistoryToDisplayMessages(msg.messages, pid);
        if (display.length > nonStreamingCount) {
          // Agent likely finished while disconnected — apply finalized history.
          // (fix « récents manquants ») Les messages EN COURS de streaming ne
          // sont pas dans pi_history (commités à message_end uniquement) : au
          // lieu de les JETER (l'id en cours était perdu, les deltas suivants
          // ne trouvaient plus leur message → le tour disparaissait de l'écran
          // jusqu'à la prochaine resync), on les RÉATTACHE à la fin de
          // l'historique finalisé et on garde l'assistantId actif.
          // Attention : si le message_end a été manqué pendant la coupure, le
          // message est DÉJÀ finalisé dans l'historique (avec un autre id —
          // l'id d'entrée ≠ l'id live) → dédup par contenu (le streamé est un
          // préfixe du finalisé) sur les derniers messages.
          const tail = display.slice(-3);
          const isAlreadyCommitted = (s: DisplayMessage): boolean => {
            if (s.role !== "assistant") return false;
            const probe = (s.content || "").trim();
            if (!probe) return false; // vide → pas identifiable, on garde
            return tail.some(d => d.role === "assistant" && (d.content || "").includes(probe));
          };
          const stillStreaming = streamingMsgs.filter(m => !isAlreadyCommitted(m));
          // Préservation des messages user en vol (envoi NON confirmé dans
          // l'historique reçu, quel que soit son âge — correctif « question
          // disparue », incident Yuki) : insérés AVANT le streaming en cours
          // pour garder l'ordre chronologique. windowFrom : l'historique reçu
          // peut être une fenêtre (lots antérieurs via pi_history_page).
          const pending = findPendingUserMessages(existing, display, Date.now(), undefined, {
            windowFrom: typeof msg.from === "number" ? msg.from : 0,
          });
          const merged = pending.length > 0
            ? [...display, ...pending, ...stillStreaming]
            : (stillStreaming.length > 0 ? [...display, ...stillStreaming] : display);
          chatHistory.saveMessagesFor(merged, pid);
          if (pid === projectId) {
            setMessages(merged);
            // La vérité backend est affichée : le bandeau cache local tombe.
            setLocalCacheOnly(false);
            // Ajustement 2 : feedback si cette resync post-coupure est massive.
            notifyHistoryResync(existing.length, merged.length);
            // L'assistant en cours est le dernier message _streaming conservé.
            const lastStreaming = [...stillStreaming].reverse().find(m => m.role === "assistant");
            currentAssistantIdRef.current = lastStreaming ? lastStreaming.id : null;
            chatHistory.setAssistantIdFor(pid, currentAssistantIdRef.current);
          }
          applyHistoryWindowMeta(msg);
        }
        // Otherwise agent still running — preserve live streaming state.
        return;
      }

      const display = convertHistoryToDisplayMessages(msg.messages, pid);
      // Préservation des messages user en vol (envoi NON confirmé dans
      // l'historique reçu, quel que soit l'âge — correctif « question
      // disparue », incident Yuki). windowFrom : l'historique reçu peut être
      // une fenêtre (lots antérieurs via pi_history_page).
      const pending = findPendingUserMessages(existing, display, Date.now(), undefined, {
        windowFrom: typeof msg.from === "number" ? msg.from : 0,
      });
      const mergedDisplay = pending.length > 0 ? [...display, ...pending] : display;
      chatHistory.saveMessagesFor(mergedDisplay, pid);

      if (pid === projectId) {
        setMessages(mergedDisplay);
        // La vérité backend est affichée : le bandeau cache local tombe.
        setLocalCacheOnly(false);
        // Ajustement 2 : feedback si cette resync post-coupure est massive.
        notifyHistoryResync(existing.length, mergedDisplay.length);
      }
      applyHistoryWindowMeta(msg);
    });
    return () => unsub();
  }, [on, projectId, notifyHistoryResync]);

  // ── Chargement par lots : lot antérieur (pi_history_page) ─────────────
  // Réponse à une demande « charger les antérieurs » quand la fenêtre locale
  // est épuisée : le lot est PRÉFIXÉ à la liste (helper pur prependHistoryBatch),
  // le curseur avance (from du lot) et le signal seq déclenche l'extension de
  // la fenêtre visible dans GroupedMessages avec ancrage scroll (sinon le lot
  // fraîchement chargé resterait masqué au-dessus du viewport).
  useEffect(() => {
    const unsub = on("pi_history_page", (msg: any) => {
      const pid = msg.projectId;
      if (!pid || !Array.isArray(msg.messages)) return;
      // Réservé au projet AFFICHÉ (seul lui a pu demander un lot). Une réponse
      // arrivant après un changement de projet est ignorée : appliquer son
      // curseur au nouveau projet affiché mélangerait deux listes distinctes
      // (la resync à l'activation re-pose un curseur frais de toute façon).
      if (pid !== projectId) return;
      // Désarmement du loader + timeout de sécurité.
      if (loadingEarlierTimerRef.current) clearTimeout(loadingEarlierTimerRef.current);
      loadingEarlierRef.current = false;
      setLoadingEarlier(false);
      const batch = convertHistoryToDisplayMessages(msg.messages, pid);
      if (batch.length > 0) {
        setMessages((prev) => prependHistoryBatch(prev, batch));
        // La vérité backend est affichée : le bandeau cache local tombe.
        setLocalCacheOnly(false);
        // Extension de la fenêtre visible pour rendre le lot (avec ancrage).
        setServerBatch((b) => ({ seq: b.seq + 1, all: !!msg.all }));
      }
      // Le curseur avance : le premier message chargé est celui du lot reçu
      // (même sans message actif — un lot vide confirme hasMore=false).
      const meta = {
        from: typeof msg.from === "number" ? msg.from : 0,
        total: typeof msg.total === "number" ? msg.total : 0,
        hasMore: !!msg.hasMore,
      };
      setServerHistoryMeta(meta);
      serverHistoryMetaRef.current = meta;
    });
    return () => {
      unsub();
      // Timeout de sécurité du loader : nettoyé au démontage (pas de fuite).
      if (loadingEarlierTimerRef.current) clearTimeout(loadingEarlierTimerRef.current);
    };
  }, [on, projectId]);

  // ── Chargement par lots : demande du lot antérieur au backend ──────────
  // before = curseur serveur courant (index du 1er message chargé dans la
  // liste complète) ; beforeId = id de ce premier message (résolution robuste
  // côté backend si l'index a glissé). all=true = « Tout afficher » : tout ce
  // qui précède le curseur en un seul lot (payload plus gros, choix explicite).
  const fetchEarlierFromServer = useCallback((all: boolean) => {
    const meta = serverHistoryMetaRef.current;
    if (!meta || !meta.hasMore || !projectId) return;
    if (loadingEarlierRef.current) return; // anti double-clic
    const first = messagesRef.current[0];
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    // NB : send renvoie true SEULEMENT en envoi immédiat ; socket fermée →
    // message mis en file (rejoué à la reconnexion) ou refusé (file pleine),
    // les deux renvoyant false. Le timeout de sécurité (15 s) réarme le
    // bouton dans tous les cas ; une réponse qui arrive plus tard est appliquée
    // normalement (dédup par id).
    send({
      type: "pi_history_page",
      projectId,
      before: meta.from,
      beforeId: first?.id,
      all,
    });
    armLoadingTimer();
  }, [send, projectId, armLoadingTimer]);

  // ── (sécurité #5) Abonnement WS par projet ────────────────────────────
  // Le serveur ne route les events pi_event QUE vers les sockets abonnés au
  // projet concerné (Set<projectId> par socket). On s'abonne donc au projet
  // actif : à l'ouverture (via la file d'attente si la socket n'est pas encore
  // ouverte), à chaque changement de projet, et à chaque reconnexion
  // (_ws_reconnect). On ne se désabonne PAS des projets précédents : le store
  // chatHistory continue de recevoir les events des projets en arrière-plan
  // (fix « stale UI after project switch »).
  useEffect(() => {
    if (!projectId) return;
    send({ type: "subscribe", projectId });
  }, [projectId, send]);

  useEffect(() => {
    const unsub = on("_ws_reconnect", () => {
      // Ajustement 2 : noter la reconnexion — le pi_history de resync qui suit
      // (pi_history_request renvoyé par App) devient alors éligible au toast
      // « Historique resynchronisé » s'il est massif. La première connexion
      // n'émet pas _ws_reconnect : le chargement initial reste silencieux.
      lastWsReconnectAtRef.current = Date.now();
      if (projectId) send({ type: "subscribe", projectId });
    });
    return () => unsub();
  }, [on, projectId, send]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey; const shift = e.shiftKey;
      const tag = (e.target as HTMLElement).tagName;
      const inInput = tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT";
      // LOT 1 : Ctrl+T bascule le réglage « détail d'affichage » (blocs de
      // détail : réflexion, sorties d'outils, sous-agent). NE PAS toucher
      // Shift+Tab (niveau de raisonnement envoyé au LLM, réglage séparé).
      if (mod && e.key === "t" && !shift) { e.preventDefault(); setDisplayDetailExpanded(p => { const next = !p; writeDisplayDetailExpanded(next); return next; }); return; }
      if (shift && e.key === "Tab" && !mod && !inInput) {
        e.preventDefault();
        fetch("/api/settings/thinking").then(r => r.json()).then(data => {
          const levels = ["off","minimal","low","medium","high"];
          const idx = levels.indexOf(data.level||"medium");
          const next = levels[(idx+1)%levels.length];
          setThinkingLevel(next);
          // Retour visuel du changement de niveau : toast GLOBAL (réglage
          // applicatif) plutôt que la bannière inline historique dans le flux
          // du chat — 1500 ms, cohérent avec l'ancien timeout.
          toast(`THINKING: ${next.toUpperCase()}`, "info", 1500);
          fetch("/api/settings/thinking", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({level:next}) });
        }).catch(()=>{});
        return;
      }
      // Lot B : la visionneuse ne réagit à Échap que si elle est au sommet de
      // la pile d'overlays (voir hooks/useOverlayStack.ts) — sinon un autre
      // modal plus récent doit être fermé en priorité.
      if (e.key === "Escape") {
        if (isTopOverlay(viewerTokenRef.current)) setViewerFile(null);
        return;
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  // ── Lot B : la visionneuse de pièces jointes est un overlay à part entière ──
  // Elle s'enregistre dans la pile centralisée pendant son ouverture : le
  // handler global de App.tsx consulte cette pile pour ne PAS envoyer pi_abort
  // tant qu'elle est affichée (priorité au modal).
  const viewerTokenRef = useRef<symbol | null>(null);
  // ── Plein écran natif du viewer d'images ──
  const viewerContainerRef = useRef<HTMLDivElement | null>(null);
  // ── HolafViewport : conteneur + <img> de la visionneuse d'images ──
  const viewerImageWrapRef = useRef<HTMLDivElement | null>(null);
  const viewerImgRef = useRef<HTMLImageElement | null>(null);
  const viewerVpRef = useRef<ReturnType<typeof HolafViewport.create> | null>(null);
  const [viewerZoom, setViewerZoom] = useState(100);
  // Mobile (<768px) : la brique est souris-only (pas de touch/pinch) → on
  // désactive le drag pour ne pas casser le défilement tactile natif.
  const isMobile = useIsMobile();
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else viewerContainerRef.current?.requestFullscreen?.().catch(() => {});
  }, []);
  // Fermeture du viewer : sortir du fullscreen natif si encore actif.
  useEffect(() => {
    if (!viewerFile && document.fullscreenElement === viewerContainerRef.current) document.exitFullscreen().catch(() => {});
  }, [viewerFile]);
  useEffect(() => {
    if (!viewerFile) return;
    const token = pushOverlay();
    viewerTokenRef.current = token;
    return () => {
      popOverlay(token);
      if (viewerTokenRef.current === token) viewerTokenRef.current = null;
    };
  }, [viewerFile]);

  // ── HolafViewport : zoom/pan/fit de l'image plein écran ──
  // Échappatoire React documenté par la brique : useEffect + ref → create()
  // → destroy() au cleanup. Le viewport ne capte PAS Escape (la fermeture Esc
  // reste gérée par useOverlayStack / ModalDialog).
  useEffect(() => {
    if (!viewerFile || viewerFile.type !== "image") return;
    const container = viewerImageWrapRef.current;
    const img = viewerImgRef.current;
    if (!container || !img) return;
    const vp = HolafViewport.create(container, {
      mode: "content",
      content: img,
      wheel: true,
      doubleClickZoom: true,
      drag: !isMobile,
      dragButton: 0,
    });
    viewerVpRef.current = vp;
    // Badge zoom % : abonnement multi-subscription (on/off) — mis à jour à
    // chaque changement de transform (molette, dblclick, drag, boutons).
    const updateZoom = (v: ReturnType<typeof HolafViewport.create>) =>
      setViewerZoom(Math.round(v.getScale() * 100));
    vp.on(updateZoom);
    // Taille naturelle de l'image (si déjà chargée) pour un letterbox correct.
    if (img.complete && img.naturalWidth > 0) {
      vp.setImageSize(img.naturalWidth, img.naturalHeight);
    }
    return () => {
      vp.off(updateZoom);
      viewerVpRef.current = null;
      vp.destroy();
    };
  }, [viewerFile, isMobile]);

  // ── Ouverture d'un fichier depuis le chat (image ou texte) ──
  // En mode popup, les IMAGES s'ouvrent dans une popup PAR image
  // (window.open nommée par hash de la source — la même image réutilise sa
  // fenêtre). Les sources non navigables (data: non convertible) retombent sur
  // la visionneuse modale interne. Le texte garde toujours la modale.
  const handleFileClick = useCallback((f: { type: "image"; src: string; name?: string } | { type: "text"; content: string; name?: string; language?: string }) => {
    if (f.type === "image" && getPreviewMode() === "popup" && openImagePopup(f.src)) return;
    setViewerFile(f);
  }, []);

  // ── Scroll : suivi auto du bas (source de vérité UNIQUE : pinnedToBottomRef) ──
  // La DÉCISION vit dans une fonction pure testable (utils/chat-scroll) ; ce
  // composant ne fait qu'appliquer la décision au DOM (aucune règle métier ici).
  /**
   * Pin SYNCHRONE. `behavior:"instant"` est indispensable : le conteneur porte
   * `.chat-messages { scroll-behavior: smooth }`, et une simple affectation de
   * `scrollTop` hériterait de ce smooth (vérifié : directAssign=0 vs
   * instantBehavior=500 en Chromium headless). L'ancien code croyait l'assignation
   * instantanée — c'était FAUX : l'animation n'atteignait jamais le bas pendant le
   * streaming rapide, d'où le décrochage.
   */
  const scrollToBottomInstant = useCallback(() => {
    const el = chatContainerRef.current;
    if (el) { el.scrollTo({ top: el.scrollHeight, behavior: "instant" }); return; }
    chatEndRef.current?.scrollIntoView(false);
  }, []);
  /** Smooth scroll (user-initiated only) */
  const scrollToBottomSmooth = useCallback(() => {
    const el = chatContainerRef.current;
    if (el) { el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); return; }
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);
  /** Distance courante au bas (px, clampée >= 0). */
  const distanceFromBottom = useCallback((el: HTMLElement) =>
    Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight), []);
  /**
   * Applique la décision de pin sur un ÉVÉNEMENT DE CROISSANCE (hauteur RÉELLE
   * du contenu modifiée, quelle qu'en soit la source) : streaming du texte,
   * blocs d'outils, sous-agents (store isolé + mur de colonnes), dépliages/
   * replis automatiques, images, compactions passent TOUS par une variation de
   * hauteur de la boîte observée.
   */
  const followBottomOnGrowth = useCallback(() => {
    const el = chatContainerRef.current;
    if (!el) return;
    const decision = resolveScrollAction(
      { distanceFromBottom: distanceFromBottom(el), scrollDelta: 0, wasPinned: pinnedToBottomRef.current },
      "growth",
    );
    pinnedToBottomRef.current = decision.pinned;
    if (decision.follow) scrollToBottomInstant();
  }, [distanceFromBottom, scrollToBottomInstant]);
  const handleScroll = useCallback(() => {
    const el = chatContainerRef.current; if (!el) return;
    const decision = resolveScrollAction(
      { distanceFromBottom: distanceFromBottom(el), scrollDelta: lastScrollTopRef.current - el.scrollTop, wasPinned: pinnedToBottomRef.current },
      "scroll",
    );
    pinnedToBottomRef.current = decision.pinned;
    lastScrollTopRef.current = el.scrollTop;
    setShowScrollBtn(prev => prev === decision.showButton ? prev : decision.showButton);
    if (decision.clearUnread) setUnreadCount(prev => prev === 0 ? prev : 0);
  }, [distanceFromBottom]);
  const prevMsgCountRef = useRef(messages.length);
  useEffect(() => { if (!pinnedToBottomRef.current && messages.length > prevMsgCountRef.current) setUnreadCount(p => p + messages.length - prevMsgCountRef.current); prevMsgCountRef.current = messages.length; }, [messages.length]);

  // ── Suivi de croissance : on raisonne sur la BOÎTE RÉELLE, pas sur un event ──
  // métier, pour couvrir uniformément toute source de croissance :
  //  - wrapper  : contenu du fil (messages, murs de sous-agents isolés, images…) ;
  //  - container: redimension fenêtre / bouton sticky / bannière WS.
  // ResizeObserver → pin SYNCHRONE (avant le paint, pas de frame perdue).
  // MutationObserver → filet pour les mutations de texte sans variation de boîte.
  // Re-vérification rAF APRÈS observation → couvre les croissances asynchrones
  // tardives (image décodée, coloration syntaxique, repli/dépli animé).
  useEffect(() => {
    const wrapper = messagesWrapperRef.current;
    const container = chatContainerRef.current;
    if (!wrapper || !container) return;
    let recheckRaf: number | null = null;
    const scheduleRecheck = () => {
      if (recheckRaf !== null) return; // throttle to rAF
      recheckRaf = requestAnimationFrame(() => {
        recheckRaf = null;
        followBottomOnGrowth();
      });
    };
    const ro = new ResizeObserver(() => {
      followBottomOnGrowth(); // synchrone : pin avant le paint
      scheduleRecheck();      // + rAF : croissance tardive après le pin
    });
    ro.observe(wrapper);
    ro.observe(container);
    const mo = new MutationObserver(scheduleRecheck);
    mo.observe(wrapper, { childList: true, subtree: true, characterData: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      if (recheckRaf !== null) cancelAnimationFrame(recheckRaf);
    };
  }, [hasContent, followBottomOnGrowth]);

  // ── Détection d'un geste UTILISATEUR vers le haut ──
  // Les événements `scroll` sont dispatchés dans les « scroll steps », APRÈS les
  // callbacks ResizeObserver : pendant un streaming, un pin de croissance peut
  // s'intercaler avant que le scroll de l'utilisateur ne soit traité et « voler »
  // le défilement. On décroche donc IMMÉDIATEMENT sur l'intention EXPLICITE
  // (molette, geste tactile, clavier), sans attendre l'événement scroll.
  useEffect(() => {
    const el = chatContainerRef.current;
    if (!el) return;
    const unpin = () => { pinnedToBottomRef.current = false; };
    // Molette vers le haut (deltaY < 0).
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) unpin(); };
    // Geste tactile : le contenu suit le doigt, donc descendre le doigt =
    // remonter dans le fil.
    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => { touchStartY = e.touches[0]?.clientY ?? 0; };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? touchStartY;
      if (y - touchStartY > 8) unpin(); // doigt vers le bas → fil vers le haut
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // Uniquement hors champ de saisie (sinon on décrocherait le chat en
      // tapant au clavier dans le composer).
      const tgt = e.target as HTMLElement | null;
      const inField = !!tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable);
      if (!inField && (e.key === "PageUp" || e.key === "Home" || e.key === "ArrowUp")) unpin();
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [hasContent]);

  // ── Pi event handling ──
  // Extracted as a pure function so it can be applied to ANY project's messages,
  // not just the currently visible one. This prevents losing streaming updates
  // when the user switches projects during a long-running LLM task.
  useEffect(() => {
    const unsub = on("pi_event", (msg: any) => {
      const evt: PiEvent = msg.event;
      const pid = msg.projectId;
      if (!pid) return;

      // ── LOT 2b : activité des sous-agents (canal pi_event, enveloppe
      // {type:"subagent", …}). Routée vers le store ISOLÉ (subagentRuns) —
      // JAMAIS appliquée à `messages` (le fil ne doit pas re-rendre à chaque
      // event). Le run est rattaché au toolCall `delegate` (FIFO + fonction).
      if (evt.type === "subagent") {
        const env = evt as unknown as SubagentEnvelope;
        const msgs = pid === projectId ? messagesRef.current : chatHistory.getMessagesFor(pid);
        // ÉTANCHÉITÉ inter-projets : le pid de la frame borne le run — le store
        // ignore les enveloppes incohérentes, marque chaque run de son projet
        // et ne le rattachera qu'aux toolCalls `delegate` du même projet. Un
        // socket abonné à plusieurs projets (arrière-plan) ne peut plus faire
        // apparaître un sous-agent d'un autre projet dans cette conversation.
        routeSubagentEnvelope(env, msgs, Date.now(), pid);
        return;
      }

      // ── Message content updates — route to the correct project's store ──
      if (pid === projectId) {
        // BUG-18 fix: gérer les custom messages ici au lieu d'un listener séparé
        if (evt.type === "message_start" && evt.message?.role === "custom" && evt.message?.display) {
          const cm = evt.message;
          // Miniatures injectées par le backend (ex. web_screenshot) — ref
          // {id,name,category,size} dans details, rendues par UserBubble.
          const injectedRefs = Array.isArray(cm.details?.attachmentRefs) ? cm.details.attachmentRefs : undefined;
          // Les messages customType "screenshot" (injectés via inject-to-chat)
          // sont système : rendus à gauche, pas en bulle utilisateur.
          const injected = cm.customType === "screenshot" || undefined;
          // (dédup) append avec déduplication par id (cf. appendMessageDedup)
          setMessages(prev => appendMessageDedup(prev, { id:cm.id||`c-${Date.now()}`, role:"user", content:cm.content||"", thinking:"", toolCalls:[], timestamp:cm.timestamp||Date.now(), customType:cm.customType, display:cm.display, injected, attachmentRefs: injectedRefs }));
          return;
        }
        // BUG-18 fix: gérer session_reloaded ici au lieu d'un listener séparé
        if (evt.type === "session_reloaded") {
          // (perf) session_reloaded = event de finalisation : on dé-flag le
          // streaming ET on synchronise le store immédiatement (une des seules
          // écritures store restantes dans ce handler, cf. FINALIZE_EVENT_TYPES).
          setMessages(prev => {
            const next = prev.map(m => m._streaming ? { ...m, _streaming: false } : m);
            chatHistory.saveMessagesFor(next, pid);
            return next;
          });
          currentAssistantIdRef.current = null;
          // (cohérence) plus de streaming en cours → assistantId du store reset.
          chatHistory.setAssistantIdFor(pid, null);
          return;
        }

        // Current project → update React state (visible in UI)
        setMessages(prev => {
          const result = applyPiEvent(prev, evt, currentAssistantIdRef.current, t);
          currentAssistantIdRef.current = result.assistantId;
          // (perf) Écriture store UNIQUEMENT sur les events de finalisation
          // (message_end, session_reloaded ; les remplacements pi_history sont
          // écrits par leur effet dédié). Pendant le streaming (message_start,
          // *_delta, toolcall_*, tool_execution_*), plus aucune écriture store
          // à chaque chunk : la persistance continue du projet actif reste
          // assurée par le debounce 500ms, et le save sur message_end maintient
          // la protection anti-pi_history périmé (message_end précède pi_history).
          if (FINALIZE_EVENT_TYPES.has(evt.type)) {
            chatHistory.saveMessagesFor(result.messages, pid);
          }
          chatHistory.setAssistantIdFor(pid, result.assistantId);
          return result.messages;
        });
      } else {
        // Other project → update its store in chatHistory so we never lose
        // streaming progress while the user is on another project.
        const otherMsgs = chatHistory.getMessagesFor(pid);
        const otherAsstId = chatHistory.getAssistantIdFor(pid);
        const result = applyPiEvent(otherMsgs, evt, otherAsstId, t);
        // (perf) même règle de finalisation pour les projets en arrière-plan.
        if (FINALIZE_EVENT_TYPES.has(evt.type)) {
          chatHistory.saveMessagesFor(result.messages, pid);
        }
        chatHistory.setAssistantIdFor(pid, result.assistantId);
      }
    });
    return () => unsub();
  }, [on, projectId]);

  // ── Commands ──
  useEffect(() => {
    const unsub = on("pi_command_result", (msg: any) => {
      if (msg.projectId && msg.projectId !== projectId) return;
      if (msg.result) setMessages(prev => [...prev, { id:`cmd-${Date.now()}`, role:"user", content:msg.result, thinking:"", toolCalls:[], timestamp:Date.now(), customType:"pi_command", display:true }]);
      if (msg.command === "clear" || msg.command === "new") {
        setMessages([]);
        justClearedRef.current = true;
        clearedAtRef.current = Date.now();
      }
      if (msg.command === "quit") onQuit?.();
    });
    return () => unsub();
  }, [on, projectId, onQuit]);

  // ── BUG-68 : afficher les erreurs WS comme messages visibles ──
  // Sans ce handler, une erreur backend ({ type: "error" }) n'était que console.error
  // → l'utilisateur ne voyait rien alors que le process s'était arrêté.
  useEffect(() => {
    const unsub = on("error", (msg: any) => {
      if (msg.projectId && msg.projectId !== projectId) return;
      const text = typeof msg.error === "string" ? msg.error : t('chat.serverError');
      setError(text);
      // (dédup) append avec déduplication par id (cf. appendMessageDedup)
      setMessages(prev => appendMessageDedup(prev, {
        id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role: "user", content: `❌ ${text}`,
        thinking: "", toolCalls: [], timestamp: Date.now(), customType: "pi_command", display: true,
      }));
    });
    return () => unsub();
  }, [on, projectId, t]);

  // ── Lot B : signalement visible quand la file d'attente WS est pleine ──
  // Le hook useWebSocket refuse les messages au-delà de QUEUE_MAX au lieu de
  // les dropper en silence et émet l'évènement interne "_ws_queue_full".
  useEffect(() => {
    const unsub = on("_ws_queue_full", () => setError(t("chat.wsQueueFull")));
    return () => unsub();
  }, [on, t]);

  // ── Stable onAbort callback to avoid breaking ChatInputArea's memo ──
  // pi_abort n'est JAMAIS mis en file (voir QUEUEABLE_TYPES dans useWebSocket) :
  // hors connexion il est simplement ignoré, évitant un abort fantôme.
  const onAbort = useCallback(() => {
    send({ type: "pi_abort", projectId });
  }, [send, projectId]);

  // ── Send ──
  const handleSend = useCallback(async (text: string, attachments: Attachment[]) => {
    const uploadErrors = attachments.filter(a => a.uploadStatus === "error");
    if (uploadErrors.length > 0) { setError(t('upload.failedWith', uploadErrors.map(a => a.name).join(", "))); return; }
    const uploading = attachments.filter(a => a.uploadStatus === "uploading");
    if (uploading.length > 0) { setError(t('upload.waiting', uploading.length)); return; }

    const done = attachments.filter(a => a.attachmentId && a.uploadStatus === "done");
    const imageAttachments = done.filter(a => a.category === "image").map(a => ({ attachmentId: a.attachmentId!, name: a.name, mimeType: a.mimeType, size: a.size }));
    const attachmentRefs = done.map(a => ({ id: a.attachmentId!, name: a.name, category: a.category, size: a.size }));

    // BUG-4 : limite de taille avant conversion base64 (alignée sur le backend
    // analyze, 20 MB). On refuse ici pour éviter d'envoyer une image trop grosse
    // qui ferait échouer l'analyse vision ou saturerait le WebSocket.
    const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
    const oversizedImages = imageAttachments.filter(a => a.size > MAX_IMAGE_SIZE);
    if (oversizedImages.length > 0) {
      setError(t('upload.imageTooLarge', oversizedImages.map(a => a.name).join(", ")));
      return;
    }

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

    // Confirmation avant d'effacer la conversation en cours via la commande /new
    if (fullMessage.trim() === "/new") {
      setConfirmNewChat(true);
      return;
    }

    const isSlash = fullMessage.trim().startsWith("/");
    if (!isSlash) {
      const display = text || (attachmentRefs.length > 0 ? attachmentRefs.map(a => `📎 ${a.name}`).join(", ") : "");
      // (dédup) append avec déduplication par id : évite le doublon message
      // user optimiste / version backend (cf. appendMessageDedup)
      setMessages(prev => appendMessageDedup(prev, { id:Date.now().toString(), role:"user", content:display, thinking:"", toolCalls:[], timestamp:Date.now(), images:imageAttachments.length>0?imageAttachments:undefined, attachmentRefs:attachmentRefs.length>0?attachmentRefs:undefined }));
    }

    // ── Vision dans le contexte (Feature) ──
    // On récupère le contenu binaire (base64) de chaque image attachée pour
    // l'envoyer directement au modèle courant via le paramètre `images` de
    // pi_prompt. sendPrompt (backend) route alors l'image vers le modèle courant
    // s'il supporte la vision (override vision=Oui compris), sinon il retombe sur
    // le modèle vision séparé (transcription). Sans ce fetch, l'image n'était
    // transmise que comme référence texte → le LLM appelait analyze_file qui
    // transcrivait via le modèle vision (pas de vision dans le contexte).
    let imagesData: { data: string; mimeType: string }[] = [];
    if (imageAttachments.length > 0) {
      for (const img of imageAttachments) {
        try {
          const resp = await fetch(`/api/attachments/${img.attachmentId}/file`);
          if (resp.ok) {
            const blob = await resp.blob();
            const data = await blobToBase64(blob);
            if (data) imagesData.push({ data, mimeType: img.mimeType });
          }
        } catch (e) {
          console.error("[Chat] Échec de récupération de l'image pour le contexte:", e);
        }
      }
    }

    // Pendant le streaming, envoyer comme steer au lieu de prompt
    // Le steer est injecté par le Pi SDK entre les appels d'outils
    const msgType = isStreaming ? "pi_steer" : "pi_prompt";
    // ── Filet de secours « needsHistory » (régression 6210d1c) ──
    // Si aucun pi_history n'a été appliqué pour ce projet depuis le chargement
    // (resync perdue dans une coupure WS — l'écran peut afficher le cache
    // localStorage, qui n'est PAS la vérité backend), on marque le prompt : le
    // backend renverra l'historique (la fenêtre serveur plafonnée) avec ce
    // prompt. UNE SEULE FOIS :
    // dès qu'un premier pi_history est appliqué, le marqueur disparaît (pas
    // de renvoi systématique à chaque prompt). Pas de marqueur sur les steers
    // (streaming actif = état live déjà en main) ni sur les slash commands.
    const needsHistory = msgType === "pi_prompt" && !fullMessage.trim().startsWith("/") && !historyReceivedRef.current.has(projectId);
    send({ type:msgType, projectId, message:fullMessage, images: imagesData.length > 0 ? imagesData : undefined, needsHistory: needsHistory || undefined });
    // Force-scroll to bottom after sending (instant — critical for streaming)
    // Uses direct scrollTop assignment which is synchronous with DOM layout,
    // unlike smooth scrolling which conflicts with ResizeObserver.
    requestAnimationFrame(() => {
      pinnedToBottomRef.current = true;
      scrollToBottomInstant();
    });
  }, [send, projectId, activeMode, isStreaming, t]);

  // ── Commande /new confirmée : envoi réel de la commande ──
  const handleConfirmNewChat = useCallback(() => {
    setConfirmNewChat(false);
    send({ type: "pi_prompt", projectId, message: "/new" });
    requestAnimationFrame(() => {
      pinnedToBottomRef.current = true;
      scrollToBottomInstant();
    });
  }, [send, projectId, scrollToBottomInstant]);

  if (!activeProject) {
    return <div className="h-full flex items-center justify-center text-hacker-text-dim"><div className="text-center"><div className="text-hacker-accent mb-4 glitch"><PiLogo className="w-16 h-16" /></div><p className="text-lg mb-2">{t('chat.emptyTitle')}</p><p className="text-sm">{t('chat.emptySubtitle')}</p></div></div>;
  }



  // ── Deferred messages: input stays responsive even during heavy streaming ──
  const deferredMessages = useDeferredValue(messages);
  const isMessagesStale = deferredMessages !== messages;

  // ── Debug overlay ──
  const [showDebug, setShowDebug] = useState(() => new URLSearchParams(window.location.search).has("debug"));
  const perfRef = useRef({ renders: 0, lastRender: 0, msgUpdates: 0, lastMsgUpdate: 0, keystrokeLatency: [] as number[] });
  perfRef.current.renders++;
  perfRef.current.lastRender = performance.now();

  // Toggle debug with Ctrl+Shift+D
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "D") {
        e.preventDefault();
        setShowDebug(p => !p);
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, []);

  // Track message update timing
  const msgUpdateTimingRef = useRef(0);

  return (
    <div className="h-full flex flex-col">
      {/* Debug overlay */}
      {showDebug && (
        <DebugOverlay
          getStats={() => ({
            renderCount: perfRef.current.renders,
            msgUpdates: perfRef.current.msgUpdates,
            msgUpdateInterval: msgUpdateTimingRef.current,
            isMessagesStale,
            messagesCount: messages.length,
            isStreaming,
            keystrokeLatency: perfRef.current.keystrokeLatency,
          })}
        />
      )}
      {hasContent ? (
        <div ref={chatContainerRef} className="flex-1 overflow-y-auto px-4 pt-4 pb-8 chat-messages chat-autoscroll relative" onScroll={handleScroll}>
          {/* Bannière WS déconnecté (Lot B) — sticky : reste visible pendant le scroll */}
          {!connected && <WsOfflineBanner pendingMessages={pendingMessages} />}
          {/* Bannière « cache local » : contenu affiché non confirmé par le backend */}
          {localCacheOnly && <LocalCacheBanner />}

          {/* Messages */}
          <div ref={messagesWrapperRef}>
            <GroupedMessages
              key={projectId}
              messages={deferredMessages}
              displayDetailExpanded={displayDetailExpanded}
              onFileClick={handleFileClick}
              scrollContainerRef={chatContainerRef}
              // ÉTANCHÉITÉ : borné le mur des sous-agents simultanés et les
              // orphelins aux runs du projet affiché (les projets émettant en
              // parallèle sur le même socket restent invisibles ici).
              projectId={projectId}
              // Chargement par lots : le backend n'envoie que les N derniers
              // messages (pi_history) — au-delà, le lot antérieur est demandé
              // via pi_history_page (curseur serverHistoryMeta).
              serverHasMore={!!serverHistoryMeta?.hasMore}
              serverRemaining={serverHistoryMeta ? Math.max(0, serverHistoryMeta.from) : 0}
              loadingEarlier={loadingEarlier}
              onLoadEarlierFromServer={fetchEarlierFromServer}
              serverBatchSeq={serverBatch.seq}
              serverBatchAll={serverBatch.all}
            />
          </div>
          <div ref={chatEndRef} />

          {showScrollBtn && (
            <div className="sticky bottom-4 flex justify-end z-20">
              <button onClick={() => { scrollToBottomSmooth(); pinnedToBottomRef.current=true; setShowScrollBtn(false); setUnreadCount(0); }}
                title={t('chat.scrollToBottom')}
                aria-label={t('chat.scrollToBottom')}
                className="scroll-to-bottom-btn flex items-center gap-2 px-3 py-1.5 rounded-full border border-hacker-accent/30 bg-hacker-surface/95 backdrop-blur-sm text-hacker-accent text-xs font-medium shadow-lg shadow-hacker-accent/5 hover:bg-hacker-accent/10 hover:border-hacker-accent/50 transition-all animate-fade-in-up">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4" /></svg>
                {unreadCount > 0 && <span className="bg-hacker-accent/20 text-hacker-accent text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none min-w-[18px] text-center">{unreadCount}</span>}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex flex-col">
          {/* Bannière WS déconnecté (Lot B) — aussi visible sans messages */}
          {!connected && <WsOfflineBanner pendingMessages={pendingMessages} />}
          {/* Bannière « cache local » : contenu affiché non confirmé par le backend */}
          {localCacheOnly && <LocalCacheBanner />}
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="text-hacker-accent mb-4 flex justify-center"><PiLogo className="w-[25vmin] h-[25vmin]" /></div>
              <p className="text-hacker-text-dim text-sm">{t('chat.sessionActive')}</p>
              <p className="text-hacker-text-dim text-xs mt-2">{activeProject?.git?.branch && `git:${activeProject.git.branch} · `}{session?.model?.name || t('chat.noModelSelected')}</p>
            </div>
          </div>
        </div>
      )}



      {/* Bannière d'erreur — rendue hors du conditionnel hasContent pour rester
          visible même sans messages (échec d'upload, trop de fichiers, etc.) */}
      {error && (
        <div className="shrink-0 mx-4 mb-2 text-hacker-error text-xs border border-hacker-error/30 p-2 pr-1.5 flex items-start gap-2">
          {/* break-words : évite le débordement horizontal sur les longs messages d'erreur */}
          <span className="break-words min-w-0 flex-1">{error}</span>
          <button onClick={() => setError("")} className="shrink-0 hover:text-hacker-text-bright transition-colors" title={t('viewer.close')} aria-label={t('viewer.close')}>
            <X size={12} />
          </button>
        </div>
      )}

      <ChatInputArea
        onSend={handleSend}
        onAbort={onAbort}
        projectId={projectId}
        isStreaming={isStreaming}
        streamingStalled={streamingStalled}
        gitBranch={activeProject?.git?.branch}
        setError={setError}
        onKeystroke={(latency: number) => {
          // DO NOT trigger a ChatView re-render on every keystroke!
          // Writing to perfRef is enough — the DebugOverlay polls it.
          const p = perfRef.current;
          p.keystrokeLatency.push(latency);
          if (p.keystrokeLatency.length > 50) p.keystrokeLatency.shift();
        }}
      />

      {viewerFile && (
        <ModalDialog id="file-viewer" onClose={() => setViewerFile(null)}>
          <div ref={viewerContainerRef} className="flex flex-col h-full bg-hacker-surface">
            <div className="flex items-center justify-between px-4 py-2 border-b border-hacker-border shrink-0">
              <span className="text-sm text-hacker-text-bright truncate flex-1">{viewerFile.name || t('viewer.attachment')}</span>
              {viewerFile.type === "image" && (
                <>
                  {/* Badge zoom % + contrôles HolafViewport (design hacker existant) */}
                  <span className="text-hacker-text-dim text-xs tabular-nums ml-2 shrink-0">{viewerZoom}%</span>
                  <button onClick={() => viewerVpRef.current?.fit()} className="text-hacker-text-dim hover:text-hacker-accent ml-2 shrink-0" title={t('viewer.fit')} aria-label={t('viewer.fit')}>⤢</button>
                  <button onClick={() => viewerVpRef.current?.zoomBy(1.1)} className="text-hacker-text-dim hover:text-hacker-accent ml-2 shrink-0" title={t('viewer.zoomIn')} aria-label={t('viewer.zoomIn')}><ZoomIn size={16} /></button>
                  <button onClick={() => viewerVpRef.current?.zoomBy(1 / 1.1)} className="text-hacker-text-dim hover:text-hacker-accent ml-2 shrink-0" title={t('viewer.zoomOut')} aria-label={t('viewer.zoomOut')}><ZoomOut size={16} /></button>
                  <button onClick={toggleFullscreen} className="text-hacker-text-dim hover:text-hacker-accent ml-2 shrink-0" title={isFullscreen ? t('chat.exitFullscreen') : t('chat.fullscreen')} aria-label={isFullscreen ? t('chat.exitFullscreen') : t('chat.fullscreen')}>
                    {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
                  </button>
                </>
              )}
              <button onClick={() => setViewerFile(null)} className="text-hacker-text-dim hover:text-hacker-error ml-2 shrink-0" aria-label={t('viewer.close')}><X size={16} /></button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {viewerFile.type === "image" ? (
                <div ref={viewerImageWrapRef} className="w-full h-full overflow-hidden relative select-none" style={{ userSelect: "none", WebkitUserSelect: "none" }}>
                  <img ref={viewerImgRef} src={viewerFile.src} alt={viewerFile.name||t('viewer.image')} draggable={false} onLoad={(e) => { const img = e.currentTarget; const vp = viewerVpRef.current; if (vp && img.naturalWidth > 0) vp.setImageSize(img.naturalWidth, img.naturalHeight); }} className="max-w-full max-h-full object-contain mx-auto" style={{ userSelect: "none", WebkitUserSelect: "none" }} />
                </div>
              ) : <pre className="text-xs text-hacker-text-bright font-mono whitespace-pre-wrap">{viewerFile.content}</pre>}
            </div>
          </div>
        </ModalDialog>
      )}

      {/* Confirmation avant nouvelle conversation (/new) */}
      <NewChatConfirmModal
        open={confirmNewChat}
        onClose={() => setConfirmNewChat(false)}
        onConfirm={handleConfirmNewChat}
      />
    </div>
  );
}

// ── Grouped Messages ──
interface AssistantMsg { id:string; content:string; thinking:string; toolCalls:ToolCallInfo[]; blocks?:AssistantBlock[]; timestamp:number; usage?:{input:number;output:number;cost:{total:number}}; _streaming?:boolean; stopReason?:string; errorMessage?:string; thinkingDurationMs?:number; }

// Fenêtre d'affichage paginée des messages : on ne rend que les N derniers
// groupes au départ, puis « charger les messages antérieurs » étend la fenêtre
// vers le haut. Avant, un slice(-200) définitif faisait disparaître pour
// toujours les messages plus anciens (l'indice « faites défiler » mentait :
// ils n'étaient pas dans le DOM). Objectif : tout l'historique reste
// accessible sans créer un DOM géant d'un coup.
const INITIAL_VISIBLE_GROUPS = 200;
const VISIBLE_GROUPS_STEP = 200;

// `hideLiveExtras` : la vue « conversation passée » (LOT E1) réutilise ce
// rendu mais ne doit PAS afficher les murs LIVE de sous-agents (ils
// s'abonnent au store courant, sans rapport avec une session passée).
export const GroupedMessages = memo(function GroupedMessages({ messages, displayDetailExpanded, onFileClick, scrollContainerRef, serverHasMore, serverRemaining, loadingEarlier, onLoadEarlierFromServer, serverBatchSeq, serverBatchAll, hideLiveExtras, projectId }: { messages: DisplayMessage[]; displayDetailExpanded: boolean; onFileClick: (f: { type:"image"; src:string; name?:string } | { type:"text"; content:string; name?:string; language?:string }) => void; scrollContainerRef: RefObject<HTMLDivElement | null>; serverHasMore?: boolean; serverRemaining?: number; loadingEarlier?: boolean; onLoadEarlierFromServer?: (all: boolean) => void; serverBatchSeq?: number; serverBatchAll?: boolean; hideLiveExtras?: boolean; projectId?: string }) {
  const { t } = useTranslation();
  // (perf) Regroupement mémoïsé (useMemo, dépendance = tableau de messages
  // déferé reçu en prop). Avant : tableaux de groupes reconstruits à CHAQUE
  // render → nouvelle identité pour chaque groupe → le memo(AssistantGroup)
  // était inutile, tous les groupes assistant re-rendaient à chaque chunk.
  // En plus, un groupe dont les messages sont exactement les mêmes objets
  // (mêmes références) que le groupe au même index du rendu précédent RÉUTILISE
  // ce dernier : les groupes inchangés gardent une identité stable d'une
  // version de `messages` à l'autre → pendant le streaming, seul le groupe en
  // cours (dernier message assistant) obtient une nouvelle référence et re-rend.
  const prevGroupsRef = useRef<{ src: DisplayMessage[]; groups: DisplayMessage[][] }>({ src: [], groups: [] });
  const groups = useMemo<DisplayMessage[][]>(() => {
    const prev = prevGroupsRef.current;
    // Mêmes références de messages → le cache est renvoyé tel quel (identité stable).
    if (prev.src === messages) return prev.groups;
    const next: DisplayMessage[][] = [];
    // LOT 3 : un bloc de timeline (résultat d'outil orphelin, commande bash,
    // compaction) est TOUJOURS un groupe autonome — il est rendu À SA DATE,
    // jamais fusionné dans le groupe assistant voisin.
    const isStandalone = (m: DisplayMessage) => !!m.kind;
    for (const msg of messages) {
      const last = next[next.length - 1];
      if (msg.role === "user" || isStandalone(msg) || next.length === 0 || last[0].role === "user" || isStandalone(last[0])) next.push([msg]);
      else last.push(msg);
    }
    // Réutilisation d'identité : contenu identique (refs) → même tableau.
    for (let i = 0; i < next.length; i++) {
      const g = next[i];
      const p = prev.groups[i];
      if (p && p.length === g.length && g.every((m, j) => m === p[j])) next[i] = p;
    }
    prevGroupsRef.current = { src: messages, groups: next };
    return next;
  }, [messages]);
  // Nombre de groupes effectivement rendus (fenêtre extensible vers le haut).
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_GROUPS);
  const visibleGroups = groups.length > visibleCount ? groups.slice(-visibleCount) : groups;
  const hiddenCount = groups.length - visibleGroups.length;

  // Insertion de contenu AU-DESSUS du viewport lors d'un « charger plus » :
  // on mémorise la distance vue↔bas avant le rendu puis on la restaure pour
  // éviter que l'écran saute.
  const scrollAnchorRef = useRef<number | null>(null);
  const adjustScrollBeforeRender = useCallback(() => {
    const el = scrollContainerRef.current;
    if (el) scrollAnchorRef.current = el.scrollHeight - el.scrollTop;
  }, [scrollContainerRef]);
  // ── Chargement par lots : deux sources de « messages antérieurs » ──
  //  1. locale : des messages déjà chargés mais masqués par la fenêtre de
  //     rendu (pagination DOM) → étendre la fenêtre localement ;
  //  2. serveur : la fenêtre locale est épuisée (le backend n'envoie plus que
  //     les N derniers dans pi_history — fix de fond du flapping WS) →
  //     demander le lot antérieur via pi_history_page (onLoadEarlierFromServer).
  const handleLoadEarlier = useCallback(() => {
    adjustScrollBeforeRender();
    if (hiddenCount > 0) {
      setVisibleCount((c) => c + VISIBLE_GROUPS_STEP);
    } else if (onLoadEarlierFromServer) {
      // Fenêtre locale épuisée : le lot antérieur doit venir du backend.
      onLoadEarlierFromServer(false);
    }
  }, [adjustScrollBeforeRender, hiddenCount, onLoadEarlierFromServer]);
  const handleLoadAll = useCallback(() => {
    adjustScrollBeforeRender();
    if (hiddenCount > 0) {
      // Tous les groupes locaux rendus de façon permanente : les messages qui
      // arrivent ensuite ne doivent pas re-masquer les plus anciens.
      setVisibleCount(Number.MAX_SAFE_INTEGER);
    } else if (onLoadEarlierFromServer) {
      // « Tout afficher » serveur : tout ce qui précède le curseur en un seul
      // appel (choix explicite de l'utilisateur, payload potentiellement gros
      // — le backend trace un WARN).
      onLoadEarlierFromServer(true);
    }
  }, [adjustScrollBeforeRender, hiddenCount, onLoadEarlierFromServer]);
  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (el && scrollAnchorRef.current !== null) {
      el.scrollTop = el.scrollHeight - scrollAnchorRef.current;
      scrollAnchorRef.current = null;
    }
  }, [visibleCount, scrollContainerRef]);

  // ── Lot serveur reçu (pi_history_page préfixé dans messages) ──
  // La fenêtre visible est étendue POUR rendre le lot fraîchement préfixé
  // (sinon il resterait masqué au-dessus du viewport). L'ancrage scroll est
  // capturé ICI, pas au clic : le lot peut arriver longtemps après (latence
  // réseau, replay de file) et le DOM du clic ne reflète pas ce qui va être
  // préfixé. Séquence : capture (DOM inchangé, le lot est hors fenêtre) →
  // extension de la fenêtre → restauration par le useLayoutEffect [visibleCount]
  // ci-dessus → le viewport reste collé aux mêmes messages, le lot apparaît
  // au-dessus. all=true → tout rendre (l'utilisateur a demandé « Tout
  // afficher » : tout est désormais chargé). La seq est séquentielle et la
  // ref initialisée à la valeur COURANTE : un remount (changement de projet)
  // ne rejoue pas les lots déjà consommés.
  const lastBatchSeqRef = useRef(serverBatchSeq ?? 0);
  useLayoutEffect(() => {
    if ((serverBatchSeq ?? 0) > lastBatchSeqRef.current) {
      lastBatchSeqRef.current = serverBatchSeq ?? 0;
      adjustScrollBeforeRender();
      if (serverBatchAll) setVisibleCount(Number.MAX_SAFE_INTEGER);
      else setVisibleCount((c) => c + VISIBLE_GROUPS_STEP);
    }
  }, [serverBatchSeq, serverBatchAll, adjustScrollBeforeRender]);

  const showServerLoad = hiddenCount === 0 && !!serverHasMore && !!onLoadEarlierFromServer;
  const showServerAll = showServerLoad && (serverRemaining ?? 0) > VISIBLE_GROUPS_STEP;

  // ── (fix chronologie) Runs détachés insérés À LEUR DATE ──
  // Les runs de sous-agents non rattachables à un toolCall `delegate` (orphelins
  // archivés de l'historique, runs bloqués sans `subagent_end`) ne sont plus
  // rendus EN FIN DE FIL (après la réponse finale) : on les réinsère dans le fil
  // selon leur date, sans réordonner les groupes existants.
  // - le hook s'abonne au store avec un snapshot STABLE → aucun re-rendu du fil
  //   sur les events LIVE des sous-agents ;
  // - `hideLiveExtras` (conversation passée) → aucun run live inséré.
  const datedRuns = useDatedDetachedRuns(projectId);
  // Mur des colonnes : ancré à la date du PREMIER appel `delegate` du lot
  // concurrent (et non plus systématiquement en fin de fil). Snapshot STABLE :
  // le fil ne re-rend que si l'appartenance du groupe concurrent change.
  const wallAnchor = useConcurrentWallAnchor(projectId);
  const hasAnchoredWall = !hideLiveExtras && wallAnchor !== null;
  const threadEntries = useMemo(
    () =>
      insertDatedRuns(
        visibleGroups,
        hideLiveExtras ? [] : datedRuns,
        // Date d'un groupe = timestamp de son premier message (0 si absent).
        (group) => (typeof group[0]?.timestamp === "number" ? group[0].timestamp : 0),
        // Mur des sous-agents simultanés, placé À SA DATE.
        hasAnchoredWall && wallAnchor !== null ? [{ ts: wallAnchor, id: "parallel" }] : [],
        // Ancre chaque run à la POSITION DE SON APPEL `delegate` dans le fil
        // (repli sur sa propre date si le toolCall n'est pas résolvable).
        (run) => delegateAnchorTimestamp(run, visibleGroups),
      ),
    [visibleGroups, datedRuns, hideLiveExtras, hasAnchoredWall, wallAnchor],
  );

  // ── CollapseProvider (LOT 1) ──
  // Porte le réglage global « détail d'affichage déplié » et la Map d'overrides
  // par bloc. Monté ICI (remonté par projet via key={projectId} → overrides
  // resettés au changement de projet). Changer le réglage (Ctrl+T, Paramètres)
  // change la valeur de contexte → les blocs DÉJÀ MONTÉS se re-rendent avec la
  // nouvelle règle (correctif du bug « réglage sans effet sur l'affichage »).
  return (
  <CollapseProvider defaultDetailExpanded={displayDetailExpanded}>
    <>
    {hiddenCount > 0 && (
      <div className="flex flex-col items-center gap-2 mb-3">
        <button
          type="button"
          onClick={handleLoadEarlier}
          className="text-xs px-3 py-1.5 rounded border border-hacker-border bg-hacker-surface/50 text-hacker-text-bright hover:border-hacker-accent hover:text-hacker-accent transition-colors"
        >
          ▲ {t('chat.loadEarlier', Math.min(VISIBLE_GROUPS_STEP, hiddenCount))}
        </button>
        {hiddenCount > VISIBLE_GROUPS_STEP && (
          <button
            type="button"
            onClick={handleLoadAll}
            className="text-[11px] px-2 py-1 rounded text-hacker-text-dim hover:text-hacker-accent transition-colors"
          >
            {t('chat.showAll')} ({hiddenCount})
          </button>
        )}
      </div>
    )}
    {showServerLoad && (
      <div className="flex flex-col items-center gap-2 mb-3">
        <button
          type="button"
          onClick={handleLoadEarlier}
          disabled={loadingEarlier}
          className="text-xs px-3 py-1.5 rounded border border-hacker-border bg-hacker-surface/50 text-hacker-text-bright hover:border-hacker-accent hover:text-hacker-accent transition-colors disabled:opacity-50 disabled:cursor-wait"
        >
          ▲ {loadingEarlier ? t('chat.loadingEarlier') : t('chat.loadEarlier', Math.min(VISIBLE_GROUPS_STEP, serverRemaining ?? 0))}
        </button>
        {showServerAll && (
          <button
            type="button"
            onClick={handleLoadAll}
            disabled={loadingEarlier}
            className="text-[11px] px-2 py-1 rounded text-hacker-text-dim hover:text-hacker-accent transition-colors disabled:opacity-50 disabled:cursor-wait"
          >
            {t('chat.showAll')} ({serverRemaining})
          </button>
        )}
      </div>
    )}
    {threadEntries.map((entry) => {
      // Mur des colonnes (runs simultanés) → rendu À SA DATE.
      if (entry.kind === "wall") {
        return <ParallelSubAgents key="parallel-wall" projectId={projectId} />;
      }
      // Run détaché daté (orphelin archivé OU run bloqué) → rendu À SA DATE.
      if (entry.kind === "run") {
        return <DatedSubAgentBlock key={`run-${entry.run.id}`} run={entry.run} />;
      }
      const group = entry.group;
      const first = group[0];
      // LOT 3 : dispatch des blocs de timeline historique à leur place.
      if (first.kind === "toolResult") {
        // `toolResult` `delegate` ORPHELIN (toolCall absent de l'historique —
        // pagination/compaction) : c'est encore une trace de l'appel `delegate`
        // → on y rend le BLOC SOUS-AGENT (ancrage exact, AVANT la réponse finale)
        // plutôt qu'un simple résultat d'outil.
        if (first.toolResult?.name === "delegate") {
          return (
            <SubAgentBlock
              key={first.id}
              toolCall={first.toolResult}
              blockId={`orphan:delegate:${first.toolResult.id}`}
            />
          );
        }
        return <ToolResultRow key={first.id} message={first} />;
      }
      if (first.kind === "bashExecution") return <BashExecutionRow key={first.id} message={first} />;
      if (first.kind === "compaction") return <CompactionRow key={first.id} message={first} />;
      if (first.role === "user") return <UserBubble key={first.id} message={first} onFileClick={onFileClick} />;
      return <AssistantGroup key={first.id} messages={group as AssistantMsg[]} />;
    })}
    {/* LOT 4 : sous-agents simultanés — vue EN COLONNES. Rendue À LA DATE du
        premier `delegate` du lot quand elle est connue (cf. wallAnchor) ; en
        repli seulement (date inconnue), elle reste en fin de fil. Masqué en
        consultation d'une conversation passée (hideLiveExtras). */}
    {!hideLiveExtras && !hasAnchoredWall && <ParallelSubAgents projectId={projectId} />}
    </>
  </CollapseProvider>
  );
});

// ── Vignettes d'attachments (partagé bulle user / messages système injectés) ──
const AttachmentRefsRow = memo(function AttachmentRefsRow({ refs, onFileClick }: { refs: { id: string; name: string; category: string; size: number }[]; onFileClick: (f: { type:"image"; src:string; name?:string } | { type:"text"; content:string; name?:string; language?:string }) => void }) {
  const { t } = useTranslation();
  return <div className="flex flex-wrap gap-1.5 mt-2">{refs.map((ref,i) => { const icon = ref.category==="image"?"🖼️":ref.category==="pdf"?"📄":ref.category==="audio"?"🎵":ref.category==="video"?"🎬":ref.category==="text"?"📝":"📎"; const fu = `/api/attachments/${ref.id}/file`; if(ref.category==="image") return <div key={i} className="relative group"><img src={fu} alt={ref.name} title={ref.name} className="w-28 h-20 object-cover rounded border border-hacker-border cursor-pointer hover:border-hacker-accent transition-colors" onClick={() => onFileClick({type:"image",src:fu,name:ref.name})} /><a href={fu} download={ref.name} className="absolute -top-1 -right-1 p-0.5 bg-hacker-bg/80 border border-hacker-border rounded text-hacker-text-dim hover:text-hacker-accent opacity-0 group-hover:opacity-100 transition-opacity" title={t('common.download')}><Download size={10} /></a></div>; return <div key={i} className="relative group"><button className="flex items-center gap-1.5 text-xs bg-hacker-bg/40 border border-hacker-border px-2 py-1 rounded hover:border-hacker-accent transition-colors text-hacker-text-bright" onClick={() => { if(ref.category==="pdf") window.open(fu,"_blank"); }}><span>{icon}</span><span>{ref.name}</span><span className="text-hacker-text-dim">{formatFileSize(ref.size)}</span></button><a href={fu} download={ref.name} className="absolute -top-1 -right-1 p-0.5 bg-hacker-bg/80 border border-hacker-border rounded text-hacker-text-dim hover:text-hacker-accent opacity-0 group-hover:opacity-100 transition-opacity" title={t('common.download')}><Download size={10} /></a></div>; })}</div>;
});

// ── Message système injecté (ex. screenshot web_screenshot) — rendu à GAUCHE ──
const InjectedMessage = memo(function InjectedMessage({ message, onFileClick }: { message: DisplayMessage; onFileClick: (f: { type:"image"; src:string; name?:string } | { type:"text"; content:string; name?:string; language?:string }) => void }) {
  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[85%] border-l-2 border-hacker-accent bg-hacker-bg/20 rounded-r-lg px-3 py-2">
        {message.timestamp ? <div className="text-[9px] text-hacker-text-dim mb-0.5">{formatTime(message.timestamp)}</div> : null}
        {message.attachmentRefs && message.attachmentRefs.length > 0 && <AttachmentRefsRow refs={message.attachmentRefs} onFileClick={onFileClick} />}
        {message.content && <div className="text-hacker-text-dim italic text-xs mt-1">{message.content}</div>}
      </div>
    </div>
  );
});

// ── User Bubble (unchanged) ──
const UserBubble = memo(function UserBubble({ message, onFileClick }: { message: DisplayMessage; onFileClick: (f: { type:"image"; src:string; name?:string } | { type:"text"; content:string; name?:string; language?:string }) => void }) {
  const { t } = useTranslation();
  // BUG double miniature : quand on colle une image, le message est créé avec
  // l'image à la fois dans `images` (rendue INLINE via getImageSrc) ET dans
  // `attachmentRefs` (rendue en vignette par AttachmentRefsRow). On déduplique :
  // on exclut des refs celles dont l'id correspond à une image déjà rendue inline.
  // Les refs non représentées inline (pdf, audio, images sans inline) restent en vignettes.
  const inlineImageIds = new Set((message.images || []).map(img => img.attachmentId).filter(Boolean));
  const refsToShow = (message.attachmentRefs || []).filter(ref => !inlineImageIds.has(ref.id));
  if (message.injected) return <InjectedMessage message={message} onFileClick={onFileClick} />;
  if (message.customType === "pi_command") return <div className="flex justify-center mb-3"><div className="max-w-[90%] bg-hacker-surface/80 border border-hacker-border rounded-lg px-4 py-2 text-xs text-hacker-text-dim text-left whitespace-pre-wrap font-mono">{message.content}</div></div>;
  if (message.customType === "git_notification") return <div className="flex justify-center mb-3"><div className="max-w-[90%] bg-hacker-surface/80 border border-hacker-border rounded-lg px-4 py-2 text-xs text-hacker-text-dim text-center whitespace-pre-wrap">{message.content}</div></div>;
  return (
    <div className="flex justify-end mb-3">
      <div className="max-w-[85%] bg-hacker-accent/10 border border-hacker-accent/30 rounded-l-lg rounded-br-lg px-3 py-2">
        {message.timestamp ? <div className="text-[9px] text-hacker-text-dim text-right mb-0.5">{formatTime(message.timestamp)}</div> : null}
        {message.content && <span className="text-hacker-text-bright whitespace-pre-wrap text-sm">{message.content}</span>}
        {message.images && message.images.length > 0 && <div className="flex flex-wrap gap-2 mt-2">{message.images.map((img,i) => { const src = getImageSrc(img); if (!src) return null; return <div key={i} className="relative group"><img src={src} alt={img.name} className="max-w-[200px] max-h-[200px] object-contain rounded border border-hacker-border cursor-pointer hover:border-hacker-accent transition-colors" onClick={() => onFileClick({type:"image",src,name:img.name})} /><a href={src} download={img.name} className="absolute top-1 right-1 p-1 bg-hacker-bg/80 border border-hacker-border rounded text-hacker-text-dim hover:text-hacker-accent opacity-0 group-hover:opacity-100 transition-opacity" title={t('common.download')}><Download size={12} /></a></div>; })}</div>}
        {refsToShow.length > 0 && <AttachmentRefsRow refs={refsToShow} onFileClick={onFileClick} />}
        {message.attachments && message.attachments.length > 0 && <div className="flex flex-wrap gap-2 mt-2">{message.attachments.map((att,i) => <div key={i} className="relative group"><button className="flex items-center gap-1.5 text-xs bg-hacker-bg/40 border border-hacker-border px-2 py-1 rounded hover:border-hacker-accent transition-colors text-hacker-text-bright" onClick={() => onFileClick({type:"text",content:att.content,name:att.name})}><FileText size={12} />{att.name}</button><a href={`data:text/plain;charset=utf-8,${encodeURIComponent(att.content)}`} download={att.name} className="absolute -top-1 -right-1 p-0.5 bg-hacker-bg/80 border border-hacker-border rounded text-hacker-text-dim hover:text-hacker-accent opacity-0 group-hover:opacity-100 transition-opacity" title={t('common.download')}><Download size={10} /></a></div>)}</div>}
        {message.usage && <span className="text-[9px] text-hacker-text-dim shrink-0">{message.usage.input + message.usage.output}t</span>}
      </div>
    </div>
  );
});

// ── Assistant Group (redesigned) ──
// Renders each message in chronological order: thinking → tools → content, per message.
// ── Tool descriptions (short) ───────────────────────────────
const TOOL_BASE_NAME: Record<string, string> = {
  "analyze_file": "analyze",
  "git_status": "git",
  "git_log": "git",
  "git_diff": "git",
  "git_commit": "git",
  "git_push": "git",
  "git_pull": "git",
  "firecrawl_scrape": "firecrawl",
  "firecrawl_map": "firecrawl",
  "firecrawl_search": "firecrawl",
  "firecrawl_crawl": "firecrawl",
  "memory_store": "memory",
  "memory_search": "memory",
  "memory_list": "memory",
  "memory_delete": "memory",
};

function shortName(name: string): string {
  const s = (name || "tool").replace(/^(analyze_|git_|firecrawl_|memory_)/, "");
  return s.length > 16 ? s.slice(0, 14) + "…" : s;
}

// ── (LOT 1) L'aperçu d'args de 50 chars (argsPreview) est remplacé par les
// résumés d'outils de utils/toolSummaries.ts (formats par outil, ~100 chars,
// sans LLM). TOOL_BASE_NAME/shortName restent pour le libellé court de l'outil.

const toolName = (tc: ToolCallInfo) => shortName(tc.name || tc.id || "tool");

// Formate un nombre de caractères en taille lisible (ex. 1234 → "1.2k").
function formatChars(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

// ── Ligne compacte d'un tool call + aperçu d'output dépliable ──────────
// LOT 1 : le repli/dépli est piloté par CollapsibleBlock — précédence exacte
// (cf. utils/collapse.ts) : override utilisateur > auto-dépli (outil en cours)
// > auto-repli (réflexion consommée) > auto-dépli (erreur) > réglage global.
// La ligne porte le RÉSUMÉ D'OUTIL (utils/toolSummaries) à la place de l'aperçu
// d'args : read <path> · N lignes, bash <cmd> · exit N · N lignes, etc.
// Memoïsé : ne re-rend que si toolCall / blockId / turnFailed / isLastRunning
// changent.
// - AUTO-DÉPLI rétabli (comportement perdu) : l'outil EN COURS d'exécution (pas
//   encore de endedAt/résultat) et DERNIER ACTIF de son groupe s'affiche DÉPLIÉ
//   pour montrer sa sortie en direct (tail -f). TRANSITOIRE : une fois l'outil
//   terminé, retombe sur la règle normale (réglage global / erreur), sauf
//   override utilisateur.
// - Erreur → auto-dépli forcé (isError, exit≠0 bash, ou turn LLM échoué).
// - Aperçu type tail -f : les 8 DERNIÈRES lignes de l'output, auto-scroll bas.
const ToolCallRow = memo(function ToolCallRow({ toolCall, blockId, turnFailed, isLastRunning = false }: {
  toolCall: ToolCallInfo;
  blockId: string;
  // Vrai si le turn LLM porteur a échoué (stopReason error / errorMessage).
  turnFailed: boolean;
  // Vrai si ce tool call est le DERNIER en cours de son groupe (message).
  isLastRunning?: boolean;
}) {
  const { t } = useTranslation();
  const hasOutput = !!toolCall.output && toolCall.output.trim().length > 0;
  const running = toolCall.isStreaming;
  // Résumé d'outil (pur, sans LLM) : recalculé seulement quand le toolCall change.
  const summary = useMemo(() => buildToolSummaryFromCall(toolCall), [toolCall]);
  const failed = summary.failed;
  const preRef = useRef<HTMLPreElement>(null);

  // AUTO-DÉPLI (rétabli) : outil EN COURS (isStreaming, pas encore de
  // endedAt/résultat) ET dernier actif du groupe ET output présent → déplié
  // (sortie live tail -f). TRANSITOIRE : à la fin de l'outil, retombe sur la
  // règle normale (réglage global / erreur), sauf override utilisateur.
  const autoRunning = running && isLastRunning && hasOutput;

  // Même règle de repli que le bloc (lecture doublée pour l'effet d'auto-scroll).
  const { expanded } = useCollapsible(blockId, failed || turnFailed, autoRunning);

  // Dernières 8 lignes de l'output (les plus récentes).
  const lastLines = useMemo(() => {
    if (!hasOutput) return "";
    const lines = toolCall.output.split("\n");
    return lines.slice(-8).join("\n");
  }, [toolCall.output, hasOutput]);

  // Auto-scroll en bas à chaque update de l'output (comportement tail -f).
  useEffect(() => {
    if (expanded && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [toolCall.output, expanded]);

  const descKey = `tools.${toolCall.name}`;
  const desc = t(descKey);
  const description = desc === descKey ? t('tools.fallback') : desc;

  // Durée : live (chrono qui tick) pendant le streaming, figée ensuite ;
  // absente en historique (pas de startedAt/endedAt sérialisés).
  const finishedDuration = running ? undefined : summary.durationMs;

  return (
    <CollapsibleBlock
      blockId={blockId}
      isError={failed || turnFailed}
      isRunning={autoRunning}
      contentClassName="mt-1.5"
      title={hasOutput ? t('chat.collapseTool') : undefined}
      headerClassName={`inline-flex items-center gap-1 text-[0.6875rem] font-mono leading-tight text-left min-w-0 ${
        running ? "text-hacker-accent animate-pulse"
        : failed ? "text-red-400"
        : "text-hacker-text-dim"
      }`}
      chevronPosition="right"
      header={
        <>
          <span>{running ? "⏳" : failed ? "❌" : "📝"}</span>
          <span className="font-bold">{toolName(toolCall)}</span>
          <span className="text-hacker-text-dim/40" aria-hidden="true">—</span>
          <span className="text-hacker-text-dim">{description}</span>
          {/* Résumé d'outil (100 % frontend, ~100 chars ; title = texte complet) */}
          {summary.text && (
            <>
              <span className="text-hacker-text-dim/40" aria-hidden="true">·</span>
              <span
                className={`${failed ? "text-red-300" : "text-hacker-text-bright/80"} truncate max-w-[380px]`}
                title={summary.text}
              >
                {summary.text}
              </span>
            </>
          )}
          {running && <ToolCallTimer startedAt={toolCall.startedAt} />}
          {finishedDuration !== undefined && (
            <span className="text-hacker-text-dim/60 tabular-nums">{formatToolDuration(finishedDuration)}</span>
          )}
        </>
      }
    >
      {hasOutput ? (
        <>
          <div className="text-[0.625rem] text-hacker-text-dim/60 mb-0.5">
            {t('chat.toolOutput')} · {t('chat.toolOutputChars', formatChars(toolCall.output.length))}
          </div>
          <pre ref={preRef} className="font-mono text-xs max-h-40 overflow-y-auto whitespace-pre-wrap break-words border border-hacker-border/40 rounded bg-hacker-bg/40 p-2 text-hacker-text-bright/90">
            {lastLines}
          </pre>
        </>
      ) : null}
    </CollapsibleBlock>
  );
});

// ── LOT 3 : blocs de timeline de l'historique ────────────────────────────────
// Ces trois composants rendent À LEUR DATE des éléments autrefois mal placés ou
// fusionnés. Ils suivent la même règle de repli que ToolCallRow (lot 1) :
// réglage global + override utilisateur + auto-dépli des erreurs, via
// CollapsibleBlock/useCollapsible.

// Résultat d'outil ORPHELIN (toolCall absent de l'historique, ex. antérieur à
// une compaction). Réutilise les résumés d'outils (lot 1) sur les details
// historiques (isError, diff… ; durées absentes → omises).
const ToolResultRow = memo(function ToolResultRow({ message }: { message: DisplayMessage }) {
  const { t } = useTranslation();
  const tr = message.toolResult!;
  const summary = useMemo(() => buildToolSummaryFromCall(tr), [tr]);
  const hasOutput = !!tr.output && tr.output.trim().length > 0;
  const failed = summary.failed;
  const blockId = `${message.id}:toolresult`;
  const { expanded } = useCollapsible(blockId, failed);
  const preRef = useRef<HTMLPreElement>(null);
  // Aperçu : les 8 dernières lignes (tail -f) ; auto-scroll bas à l'ouverture.
  const lastLines = useMemo(() => {
    if (!hasOutput) return "";
    return tr.output.split("\n").slice(-8).join("\n");
  }, [tr.output, hasOutput]);
  useEffect(() => {
    if (expanded && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [tr.output, expanded]);

  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[95%] border border-dashed border-hacker-border rounded bg-hacker-surface/40 px-3 py-1.5">
        <CollapsibleBlock
          blockId={blockId}
          isError={failed}
          contentClassName="mt-1.5"
          title={hasOutput ? t('chat.collapseTool') : undefined}
          headerClassName={`inline-flex items-center gap-1 text-[0.6875rem] font-mono leading-tight text-left min-w-0 ${failed ? "text-red-400" : "text-hacker-text-dim"}`}
          chevronPosition="right"
          header={
            <>
              <span>{failed ? "❌" : "🧩"}</span>
              <span className="font-bold">{shortName(tr.name)}</span>
              <span className="text-hacker-text-dim/40" aria-hidden="true">—</span>
              <span className="text-hacker-text-dim">{t('chat.toolResultLabel')}</span>
              {summary.text && (
                <>
                  <span className="text-hacker-text-dim/40" aria-hidden="true">·</span>
                  <span className={`${failed ? "text-red-300" : "text-hacker-text-bright/80"} truncate max-w-[380px]`} title={summary.text}>
                    {summary.text}
                  </span>
                </>
              )}
            </>
          }
        >
          {hasOutput ? (
            <pre ref={preRef} className="font-mono text-xs max-h-40 overflow-y-auto whitespace-pre-wrap break-words border border-hacker-border/40 rounded bg-hacker-bg/40 p-2 text-hacker-text-bright/90">
              {lastLines}
            </pre>
          ) : null}
        </CollapsibleBlock>
      </div>
    </div>
  );
});

// Exécution bash (commande, sortie complète repliable, exitCode, cancelled).
const BashExecutionRow = memo(function BashExecutionRow({ message }: { message: DisplayMessage }) {
  const { t } = useTranslation();
  const bash = message.bashExecution!;
  const failed = bash.cancelled === true || (typeof bash.exitCode === "number" && bash.exitCode !== 0);
  const hasOutput = !!bash.output && bash.output.trim().length > 0;
  const blockId = `${message.id}:bash`;
  const { expanded } = useCollapsible(blockId, failed);
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (expanded && preRef.current) preRef.current.scrollTop = 0;
  }, [expanded]);

  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[95%] border border-hacker-border rounded bg-hacker-bg/40 px-3 py-1.5">
        <CollapsibleBlock
          blockId={blockId}
          isError={failed}
          contentClassName="mt-1.5"
          title={hasOutput ? t('chat.collapseTool') : undefined}
          headerClassName={`inline-flex items-center gap-1 text-[0.6875rem] font-mono leading-tight text-left min-w-0 ${failed ? "text-red-400" : "text-hacker-text-dim"}`}
          chevronPosition="right"
          header={
            <>
              <span>{failed ? "❌" : "$ "}</span>
              <span className="text-hacker-text-dim">{t('chat.bashExecutionLabel')}</span>
              <span className="text-hacker-text-dim/40" aria-hidden="true">—</span>
              <span className="text-hacker-text-bright/80 truncate max-w-[420px]" title={bash.command}>{bash.command}</span>
              {bash.cancelled && (
                <span className="text-hacker-warn">· {t('chat.bashCancelled')}</span>
              )}
              {typeof bash.exitCode === "number" && (
                <span className="text-hacker-text-dim/60 tabular-nums">· {t('chat.bashExit', bash.exitCode)}</span>
              )}
            </>
          }
        >
          {hasOutput ? (
            <pre ref={preRef} className="font-mono text-xs max-h-40 overflow-y-auto whitespace-pre-wrap break-words border border-hacker-border/40 rounded bg-hacker-bg/40 p-2 text-hacker-text-bright/90">
              {bash.output}
            </pre>
          ) : null}
        </CollapsibleBlock>
      </div>
    </div>
  );
});

// Compaction de conversation : en-tête lisible (tokens libérés) + résumé dans
// un bloc repliable, À SA DATE (remplace « *Conversation compacted* »).
const CompactionRow = memo(function CompactionRow({ message }: { message: DisplayMessage }) {
  const { t } = useTranslation();
  const comp = message.compaction!;
  const hasSummary = !!comp.summary && comp.summary.trim().length > 0;
  const blockId = `${message.id}:compaction`;

  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[95%] border border-hacker-accent/30 rounded bg-hacker-accent/5 px-3 py-1.5">
        <CollapsibleBlock
          blockId={blockId}
          contentClassName="mt-1.5"
          title={hasSummary ? t('chat.compactionSummaryLabel') : undefined}
          headerClassName="inline-flex items-center gap-1 text-[0.6875rem] font-mono leading-tight text-left min-w-0 text-hacker-accent/90"
          chevronPosition="right"
          header={
            <>
              <span>🗜</span>
              <span className="font-bold">{t('chat.compactionLabel')}</span>
              {typeof comp.tokensBefore === "number" && (
                <>
                  <span className="text-hacker-text-dim/40" aria-hidden="true">—</span>
                  <span className="text-hacker-text-dim">{t('chat.compactionFreed', comp.tokensBefore)}</span>
                </>
              )}
            </>
          }
        >
          {hasSummary ? (
            <div className="text-xs text-hacker-text-bright/90 whitespace-pre-wrap break-words border border-hacker-border/40 rounded bg-hacker-bg/40 p-2">
              {comp.summary}
            </div>
          ) : null}
        </CollapsibleBlock>
      </div>
    </div>
  );
});

// ── Contenu markdown d'un message assistant (perf) ───────────────────────
// Isolé pour pouvoir appeler useThrottledValue (hook) sans violer les règles
// des hooks dans le map de messages. Le contenu du message EN STREAMING est
// throttlé (re-parse markdown limité à ~45ms) ; les messages finis gardent
// leur contenu direct. Le curseur cursor-blink reste rendu indépendamment.
const AssistantContent = memo(function AssistantContent({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  const display = isStreaming ? useThrottledValue(content, 45) : content;
  return <MemoizedReactMarkdown>{display}</MemoizedReactMarkdown>;
});

// ── (chronologie) Segments d'affichage d'un message assistant ─────────────
// Si le message porte `blocks` (ordre réel d'écriture capturé au streaming ou
// reconstruit depuis content[] en historique), on rend DANS CET ORDRE : texte →
// outil → texte → réflexion… C'est LE correctif « fil chronologique » (avant,
// le rendu regroupait par type et affichait un appel d'outil AVANT le texte qui
// l'avait précédé). Repli sur l'ancien regroupement par type si `blocks` est
// absent (messages en cache antérieurs au correctif).
function assistantSegments(msg: AssistantMsg): AssistantBlock[] {
  if (msg.blocks && msg.blocks.length > 0) {
    // Sécurité : tout toolCall non référencé par un bloc est ajouté en fin
    // (on ne perd jamais silencieusement une action).
    const referenced = new Set(
      msg.blocks
        .filter((b): b is Extract<AssistantBlock, { kind: "toolCall" }> => b.kind === "toolCall")
        .map((b) => b.toolCallId),
    );
    const extras: AssistantBlock[] = msg.toolCalls
      .filter((tc) => !referenced.has(tc.id))
      .map((tc) => ({ kind: "toolCall" as const, toolCallId: tc.id }));
    return extras.length > 0 ? [...msg.blocks, ...extras] : msg.blocks;
  }
  const segs: AssistantBlock[] = [];
  if (msg.thinking) segs.push({ kind: "thinking", text: msg.thinking });
  for (const tc of msg.toolCalls) segs.push({ kind: "toolCall", toolCallId: tc.id });
  if (msg.content) segs.push({ kind: "text", text: msg.content });
  return segs;
}

const AssistantGroup = memo(function AssistantGroup({ messages }: { messages: AssistantMsg[] }) {
  const { t } = useTranslation();
  let totalUsage: {input:number;output:number;cost:{total:number}} | undefined; let isStreaming = false;
  for (const msg of messages) {
    if (msg.usage) totalUsage = totalUsage ? {input:totalUsage.input+msg.usage.input,output:totalUsage.output+msg.usage.output,cost:{total:totalUsage.cost.total+msg.usage.cost.total}} : msg.usage;
    if (msg._streaming) isStreaming = true;
  }
  const hasMultiple = messages.length > 1;

  return (
    <div className="flex justify-start mb-3">
      <div className={`max-w-[95%] bg-hacker-surface border rounded-r-lg rounded-bl-lg overflow-hidden ${isStreaming ? "border-hacker-accent/50 shadow-[0_0_8px_rgba(var(--accent-rgb),0.15)]" : "border-hacker-border"}`}>
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-hacker-border/50 bg-hacker-bg/30">
          <span className="text-[0.6875rem] text-hacker-accent font-bold tracking-wider">{isStreaming ? t('chat.streaming') : t('chat.response')}</span>
          {messages[0]?.timestamp && <span className="text-[0.6875rem] text-hacker-text-dim">{formatTime(messages[0].timestamp)}</span>}
          {totalUsage && <span className="text-[0.6875rem] text-hacker-text-dim">{totalUsage.input+totalUsage.output} tok</span>}
          <div className="flex-1" />
          {isStreaming && <span className="w-2 h-2 rounded-full bg-hacker-accent animate-pulse" />}
        </div>

        {/* Messages in chronological order */}
        {messages.map((msg, i) => {
          const isFirst = i === 0;
          const showThinking = !!msg.thinking;
          const showContent = !!msg.content;
          // Only add a visual separator between messages that have substantial content
          // (thinking or response). Tool-only messages flow inline with the previous block.
          const hasSubstantialContent = showThinking || showContent;
          // LOT 1 : turn LLM échoué (BUG-68) → auto-dépli forcé des blocs de
          // détail portés par ce message (réflexion, sorties d'outils).
          const turnFailed = msg.stopReason === "error" || !!msg.errorMessage;
          // Segments DANS L'ORDRE du tableau content[] (chronologie réelle).
          const segs = assistantSegments(msg);
          // Dernier tool call EN COURS du message (celui qui streame) :
          // c'est lui qui est « dernier actif » → aperçu déplié par défaut.
          let lastActiveIdx = -1;
          for (let k = 0; k < msg.toolCalls.length; k++) {
            if (msg.toolCalls[k].isStreaming) lastActiveIdx = k;
          }
          const tcById = new Map(msg.toolCalls.map((tc, idx) => [tc.id, { tc, idx }]));
          const showThinkingPlaceholder = msg._streaming && segs.length === 0;

          return (
            <div key={msg.id} className={hasMultiple && !isFirst && hasSubstantialContent ? "border-t border-hacker-border/30" : ""}>
              {/* BUG-68 : bannière d'erreur visible si le turn LLM a échoué
                  (le SDK renvoie un message assistant vide avec stopReason:"error"). */}
              {(msg.stopReason === "error" || msg.errorMessage) && (
                <div className="px-3 py-2">
                  <div className="flex items-start gap-2 text-xs border border-red-500/40 bg-red-500/10 text-red-400 rounded px-2 py-1.5">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span className="whitespace-pre-wrap">{msg.errorMessage || t('chat.llmError')}</span>
                  </div>
                </div>
              )}
              {/* ── Blocs rendus DANS L'ORDRE CHRONOLOGIQUE du message ──
                  (texte → réflexion → outil → texte…). Un bloc `delegate` est
                  rendu en pseudo bloc sous-agent (LOT 1). AUTO-DÉPLI : le
                  DERNIER outil EN COURS du message streame déplié (tail -f). */}
              {segs.map((seg, si) => {
                if (seg.kind === "thinking") {
                  // Bloc de réflexion vide en historique → rien à montrer.
                  if (!seg.text.trim() && !msg._streaming) return null;
                  // Thinking — repli piloté par CollapseProvider (précédence :
                  // override > auto-repli réflexion consommée > erreur > réglage) ;
                  // textStarted = contenu non vide → auto-repli TRANSITOIRE.
                  return (
                    <div key={`th-${si}`} className="px-3 py-2">
                      <ThinkingBlock
                        thinking={seg.text}
                        blockId={`${msg.id}:thinking:${si}`}
                        isError={turnFailed}
                        isStreaming={!!msg._streaming}
                        textStarted={!!msg.content}
                        thinkingDurationMs={msg.thinkingDurationMs}
                      />
                    </div>
                  );
                }
                if (seg.kind === "text") {
                  if (!seg.text.trim() && !msg._streaming) return null;
                  const isLastSegment = si === segs.length - 1;
                  return (
                    <div key={`tx-${si}`} className="px-3 py-2 prose-hacker">
                      <AssistantContent content={seg.text} isStreaming={!!msg._streaming} />
                      {msg._streaming && isLastSegment && <span className="cursor-blink" />}
                    </div>
                  );
                }
                // toolCall — retrouve le toolCall réel par id (ordre du bloc).
                const entry = tcById.get(seg.toolCallId);
                if (!entry) return null;
                const { tc, idx } = entry;
                return (
                  <div key={`tc-${seg.toolCallId}`} className="px-3 flex flex-col gap-1.5 py-1.5">
                    {tc.name === "delegate" ? (
                      <SubAgentBlock
                        toolCall={tc}
                        blockId={`${msg.id}:delegate:${tc.id}`}
                      />
                    ) : (
                      <ToolCallRow
                        toolCall={tc}
                        blockId={`${msg.id}:tool:${tc.id}`}
                        turnFailed={turnFailed}
                        isLastRunning={idx === lastActiveIdx}
                      />
                    )}
                  </div>
                );
              })}

              {/* Placeholder de streaming tant qu'aucun bloc n'existe. */}
              {showThinkingPlaceholder && (
                <div className="px-3 py-2 prose-hacker">
                  <span className="text-hacker-text-dim italic text-sm">{t('chat.thinking')}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

// ── ChatInputArea (unchanged) ──
const ChatInputArea = memo(function ChatInputArea({ onSend, onAbort, isStreaming, streamingStalled, gitBranch, projectId, setError, onKeystroke }: {
  onSend: (text:string, attachments:Attachment[]) => void; onAbort: () => void; isStreaming: boolean; streamingStalled?: boolean;
  gitBranch?: string; projectId: string; setError: (e:string) => void;
  onKeystroke?: (latency: number) => void;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState(""); const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false); const inputRef = useRef<HTMLTextAreaElement>(null); const fileInputRef = useRef<HTMLInputElement>(null);


  const processFile = useCallback(async (file: File) => {
    if (attachments.length >= 10) { setError(t('upload.maxFiles')); return; }
    const category = categorizeFile(file.type||"application/octet-stream", file.name);
    if (file.size > 100*1024*1024) { setError(t('upload.tooLarge', formatFileSize(file.size))); return; }
    const uid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const localPreview = category==="image" ? URL.createObjectURL(file) : undefined;
    setAttachments(prev => [...prev, { id:uid, name:file.name, mimeType:file.type||"application/octet-stream", size:file.size, category, data:"", preview:localPreview, uploadStatus:"uploading" }]);
    try {
      const fd = new FormData(); fd.append("files", file); fd.append("projectId", projectId);
      const r = await fetch("/api/attachments/upload", { method:"POST", body:fd });
      if (!r.ok) { const ed = await r.json().catch(()=>({error:t('upload.failed')})); throw new Error(ed.error||t('upload.failedWith', r.status)); }
      const data = await r.json(); const uploaded = data.attachments?.[0];
      if (!uploaded) throw new Error(t('upload.noData'));
      setAttachments(prev => prev.map(a => a.id===uid ? {...a, attachmentId:uploaded.id, uploadStatus:"done", preview:a.preview||URL.createObjectURL(file)} : a));
    } catch (err: any) {
      setAttachments(prev => prev.map(a => a.id===uid ? {...a, uploadStatus:"error", uploadError:err.message} : a));
      setError(t('upload.failedWith', err.message));
    }
  }, [attachments.length, setError, projectId, t]);

  const handleSendClick = useCallback(() => {
    const txt = input.trim();
    if (!txt && attachments.length===0) return;
    onSend(input, attachments);
    setInput("");
    setAttachments([]);
    if (inputRef.current) inputRef.current.style.height = 'auto';
  }, [input, attachments, onSend]);


  const handleKeyDown = useCallback((e: React.KeyboardEvent) => { if (e.key==="Enter" && !e.shiftKey) { e.preventDefault(); handleSendClick(); } }, [handleSendClick]);
  const handleDrop = useCallback((e: React.DragEvent) => { e.preventDefault(); setIsDragOver(false); for (const f of Array.from(e.dataTransfer.files)) processFile(f); }, [processFile]);
  const handlePaste = useCallback((e: React.ClipboardEvent) => { for (const item of e.clipboardData.items) { if (item.type.startsWith("image/")) { const b = item.getAsFile(); if (b) processFile(b); } } }, [processFile]);
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => { if (e.target.files) for (const f of Array.from(e.target.files)) processFile(f); }, [processFile]);

  return (
    <div className="border-t border-hacker-border-bright bg-hacker-surface p-3" onDrop={handleDrop} onDragOver={e=>{e.preventDefault();setIsDragOver(true)}} onDragLeave={()=>setIsDragOver(false)} onPaste={handlePaste}>
      {isDragOver && <div className="absolute inset-0 flex items-center justify-center bg-hacker-bg/80 z-20"><div className="text-hacker-accent text-2xl glitch">{t('chat.dropFiles')}</div></div>}
      {attachments.length > 0 && <div className="flex gap-2 mb-2 flex-wrap">{attachments.map(att => <div key={att.id} className={`flex items-center gap-1.5 text-xs border px-2 py-1.5 rounded group ${att.uploadStatus==="error"?"bg-red-500/10 border-red-500/50":att.uploadStatus==="uploading"?"bg-hacker-accent/10 border-hacker-accent/30 animate-pulse":"bg-hacker-border/40 border-hacker-border"}`}>{att.uploadStatus==="uploading"?<span className="text-hacker-accent animate-spin">⏳</span>:att.uploadStatus==="error"?<span className="text-red-400">⚠️</span>:att.category==="image"&&att.preview?<img src={att.preview} alt={att.name} className="w-8 h-8 object-cover rounded" />:<span className="text-hacker-accent">{getFileExtensionIcon(att.category,att.name)}</span>}<span className="truncate max-w-[120px]">{att.name}</span><span className="text-hacker-text-dim">{formatFileSize(att.size)}</span>{att.uploadStatus==="done"&&<span className="text-green-400 text-[9px]">✓</span>}{att.uploadStatus==="error"&&att.uploadError&&<span className="text-red-400 text-[9px] truncate max-w-[100px]" title={att.uploadError}>❌</span>}<button onClick={()=>setAttachments(prev=>prev.filter(a=>a.id!==att.id))} className="text-hacker-text-dim hover:text-hacker-error ml-1" title={t('chat.removeAttachment')} aria-label={t('chat.removeAttachment')}><X size={12}/></button></div>)}</div>}
      <div className="text-hacker-text-dim text-[0.6875rem] mb-1 flex justify-between"><span className="hidden md:block">{t('chat.keyboardHints')}</span><span className="flex items-center gap-2 ml-auto">{gitBranch&&<span>git:{gitBranch}</span>}{isStreaming&&!streamingStalled&&<span className="text-hacker-accent flex items-center gap-1"><span className="pulse-dot w-1.5 h-1.5"/> {t('common.loading')}</span>}{isStreaming&&streamingStalled&&<span className="text-hacker-warn flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-hacker-warn"/> {t('activity.stalled')}</span>}</span></div>
      <div className="flex gap-2">
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => {
            const keystrokeTs = performance.now();
            setInput(e.target.value);
            // Auto-resize the textarea as the user types. We use rAF to defer
            // the height calculation to the next frame so it never blocks the
            // input event. `field-sizing: content` (CSS, modern browsers) would
            // do this for free but isn't supported in Firefox yet.
            const t = e.target;
            if (t) {
              requestAnimationFrame(() => {
                t.style.height = 'auto';
                t.style.height = Math.min(t.scrollHeight, 200) + 'px';
              });
            }
            if (onKeystroke) {
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  onKeystroke(performance.now() - keystrokeTs);
                });
              });
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder={isStreaming ? t('chat.queueMessage') : t('chat.typeMessage')}
          className="input-hacker flex-1 resize-none overflow-y-auto"
          rows={2}
          style={{ minHeight: '3rem', maxHeight: '10rem' }}
        />
        <div className="flex flex-col gap-1">
          <button onClick={handleSendClick} className="btn-hacker flex-1 px-4" disabled={!input.trim()&&attachments.length===0}>{isStreaming ? t('chat.steer') : t('chat.send')}</button>
          <div className="flex gap-1"><button onClick={()=>fileInputRef.current?.click()} className="btn-hacker px-2 text-xs" title={t('chat.attachFiles')} aria-label={t('chat.attachFiles')}><Paperclip size={14}/></button>{isStreaming&&<button onClick={onAbort} className="btn-hacker danger px-4 text-xs">{t('chat.abort')}</button>}</div>
        </div>
      </div>
      <input ref={fileInputRef} type="file" multiple accept="image/*,text/*,application/json,application/xml,application/javascript,application/x-shellscript,.js,.ts,.tsx,.jsx,.py,.rb,.rs,.go,.java,.kt,.swift,.c,.cpp,.h,.hpp,.cs,.php,.sh,.bash,.sql,.yaml,.yml,.toml,.ini,.cfg,.env,.md,.txt,.log,.css,.scss,.less,.html,.svg" onChange={handleFileSelect} className="hidden"/>
    </div>
  );
});

// ── Debug Overlay (Ctrl+Shift+D) ────────────────────────────────
// Polls perf data on its own with setInterval — does NOT cause parent re-renders.
// Uses PerformanceObserver to capture long tasks blocking the main thread.

interface DebugStats {
  renderCount: number;
  msgUpdates: number;
  msgUpdateInterval: number;
  isMessagesStale: boolean;
  messagesCount: number;
  isStreaming: boolean;
  keystrokeLatency: number[];
}

interface LongTaskEntry {
  duration: number;
  name: string;
  startTime: number;
}

interface DebugOverlayProps {
  getStats: () => DebugStats;
}

function DebugOverlay({ getStats }: DebugOverlayProps) {
  const [stats, setStats] = useState<DebugStats>(() => getStats());
  const [longTasks, setLongTasks] = useState<LongTaskEntry[]>([]);
  const [domNodes, setDomNodes] = useState(0);
  const [eventLoopLag, setEventLoopLag] = useState(0);

  // ── PerformanceObserver: capture long tasks (>50ms) that block the main thread ──
  useEffect(() => {
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const newTasks: LongTaskEntry[] = entries.map(e => ({
          duration: Math.round(e.duration),
          name: e.name,
          startTime: Math.round(e.startTime),
        }));
        setLongTasks(prev => [...prev.slice(-19), ...newTasks]);
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch {
      // PerformanceObserver.longtask not supported
    }
    return () => { observer?.disconnect(); };
  }, []);

  // ── Event loop lag detector: one setTimeout(0) measure per second ──
  // Previous version used setTimeout(0) in a tight loop causing ~250 re-renders/sec
  // which flooded Firefox's Cycle Collector.
  useEffect(() => {
    let running = true;
    const measure = () => {
      if (!running) return;
      const start = performance.now();
      setTimeout(() => {
        if (!running) return;
        const lag = Math.round(performance.now() - start);
        setEventLoopLag(lag);
        // Wait 1s before next measure, not 0ms
        setTimeout(() => { if (running) measure(); }, 1000);
      }, 0);
    };
    measure();
    return () => { running = false; };
  }, []);

  // ── Poll stats + DOM node count every 500ms ──
  useEffect(() => {
    const interval = setInterval(() => {
      setStats(getStats());
      setDomNodes(document.querySelectorAll('*').length);
    }, 500);
    return () => clearInterval(interval);
  }, [getStats]);

  const { renderCount, msgUpdates, msgUpdateInterval, isMessagesStale, messagesCount, isStreaming, keystrokeLatency } = stats;
  const msgUpdateRate = msgUpdateInterval > 0 ? Math.round(1000 / msgUpdateInterval) : 0;
  const recentLatency = keystrokeLatency.slice(-5);
  const displayLatency = keystrokeLatency.slice(-20);
  const avgLatency = recentLatency.length > 0
    ? Math.round(recentLatency.reduce((a, b) => a + b, 0) / recentLatency.length)
    : 0;
  const maxLatency = recentLatency.length > 0
    ? Math.round(Math.max(...recentLatency))
    : 0;

  const recentTasks = longTasks.slice(-10);
  const avgTaskDuration = recentTasks.length > 0
    ? Math.round(recentTasks.reduce((a, b) => a + b.duration, 0) / recentTasks.length)
    : 0;
  const maxTaskDuration = recentTasks.length > 0
    ? Math.round(Math.max(...recentTasks.map(t => t.duration)))
    : 0;

  return (
    <div className="fixed bottom-12 left-2 z-[9999] bg-hacker-bg/90 border border-hacker-accent/40 text-[10px] font-mono leading-tight p-2 rounded shadow-lg shadow-hacker-accent/10"
      style={{ width: "280px", backdropFilter: "blur(4px)" }}>
      <div className="text-hacker-accent font-bold mb-1 tracking-wider">⚡ DEBUG</div>
      <div className="space-y-0.5 text-hacker-text-dim">
        <div className="flex justify-between">
          <span>Renders</span>
          <span className="text-hacker-text-bright">{renderCount}</span>
        </div>
        <div className="flex justify-between">
          <span>DOM nodes</span>
          <span className={domNodes > 5000 ? "text-hacker-warn font-bold" : "text-hacker-text-bright"}>{domNodes.toLocaleString()}{domNodes > 5000 ? " ⚠" : ""}</span>
        </div>
        <div className="flex justify-between">
          <span>Msg count (total/visible)</span>
          <span className="text-hacker-text-bright">{messagesCount}</span>
        </div>
        <div className="flex justify-between">
          <span>Msg updates</span>
          <span className="text-hacker-text-bright">{msgUpdates}</span>
        </div>
        <div className="flex justify-between">
          <span>Streaming</span>
          <span className={isStreaming ? "text-hacker-accent" : "text-hacker-text-dim"}>
            {isStreaming ? "●" : "○"}
          </span>
        </div>
        <div className="flex justify-between">
          <span>Deferred stale</span>
          <span className={isMessagesStale ? "text-hacker-warn" : "text-green-400"}>
            {isMessagesStale ? "yes" : "no"}
          </span>
        </div>

        <div className="border-t border-hacker-border/30 my-1" />
        <div className="text-hacker-accent text-[9px]">⌨ Input latency</div>
        <div className="flex justify-between">
          <span>Avg / Max</span>
          <span className={avgLatency > 16 ? "text-hacker-warn font-bold" : "text-hacker-text-bright"}>
            {avgLatency}ms / {maxLatency}ms
          </span>
        </div>
        <div className="flex gap-0.5 mt-0.5" style={{ height: "8px" }}>
          {displayLatency.map((lat, i) => {
            const h = Math.min(8, Math.round(lat / 20 * 8));
            return <div key={i} className="w-1.5 rounded-sm"
              style={{ height: `${h}px`, alignSelf: "flex-end", background: lat > 50 ? "var(--error)" : lat > 16 ? "var(--warn)" : "var(--accent)" }} />;
          })}
        </div>

        <div className="border-t border-hacker-border/30 my-1" />
        <div className="text-hacker-accent text-[9px]">🧵 Event loop lag</div>
        <div className="flex justify-between">
          <span>setTimeout(0) delay</span>
          <span className={eventLoopLag > 50 ? "text-hacker-warn font-bold" : eventLoopLag > 16 ? "text-hacker-warn" : "text-green-400"}>
            {eventLoopLag}ms
          </span>
        </div>

        <div className="border-t border-hacker-border/30 my-1" />
        <div className="text-hacker-accent text-[9px]">{"🚫 Long tasks (>50ms)"}</div>
        <div className="flex justify-between">
          <span>Count / Avg / Max</span>
          <span className={recentTasks.length > 0 ? "text-hacker-warn" : "text-green-400"}>
            {recentTasks.length} / {avgTaskDuration}ms / {maxTaskDuration}ms
          </span>
        </div>
        {recentTasks.length > 0 && (
          <div className="mt-0.5 max-h-[60px] overflow-y-auto" style={{ fontSize: "8px" }}>
            {recentTasks.map((t, i) => (
              <div key={i} className="flex justify-between" style={{ color: t.duration > 100 ? "var(--error)" : "var(--warn)" }}>
                <span>{t.name}</span>
                <span>{t.duration}ms @{t.startTime}</span>
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-hacker-border/30 my-1" />
        <div className="text-[8px] text-hacker-text-dim/50">Ctrl+Shift+D pour fermer</div>
      </div>
    </div>
  );
}
