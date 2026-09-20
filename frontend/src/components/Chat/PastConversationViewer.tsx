// ── Visionneuse d'une conversation PASSÉE, en LECTURE SEULE (LOT E1) ────────
// Ouvre l'historique d'une session persistée du SDK dans le MÊME rendu que le
// chat (GroupedMessages : bulles, outils, réflexion, pagination) et avec la
// même pagination serveur que pi_history_page — mais via une route REST
// LECTURE SEULE (`GET /api/projects/:id/sessions/:sessionId/history`).
//
// GARANTIES DU PÉRIMÈTRE E1 :
//  - ne change JAMAIS la session active du projet (aucun pi_start/pi_history) ;
//  - ne permet PAS d'envoyer un message (pas de zone de saisie) ;
//  - AUCUN bouton « Reprendre » ni reprise automatique ;
//  - le chat courant reste monté et intact derrière la modale.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { ModalDialog } from "../common/ModalDialog";
import { GroupedMessages } from "./ChatView";
import { convertHistoryToDisplayMessages } from "../../hooks/useChatHistory";
import { useTranslation } from "../../i18n";
import type { DisplayMessage, PastSession } from "../../types";
import { formatSessionDate } from "../../utils/pastSessions";
import { readDisplayDetailExpanded, subscribeDisplayDetail } from "../../utils/display-detail";
import { getPreviewMode, openImagePopup } from "../../utils/preview-mode";

interface Props {
  projectId: string;
  session: PastSession;
  onClose: () => void;
}

interface PageMeta {
  from: number;
  total: number;
  hasMore: boolean;
}

type ViewerFile =
  | { type: "image"; src: string; name?: string }
  | { type: "text"; content: string; name?: string; language?: string };

export function PastConversationViewer({ projectId, session, onClose }: Props) {
  const { t, lang } = useTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Messages BRUTS (format pi_history) : convertis avec la MÊME fonction que
  // le chat → rendu identique. `raw` conserve l'ordre chronologique complet.
  const [raw, setRaw] = useState<any[]>([]);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // Garde anti double-fetch (deux clics avant le re-render du bouton désactivé).
  const loadingEarlierRef = useRef(false);
  // Signal séquentiel pour étendre la fenêtre visible de GroupedMessages après
  // le préfixage d'un lot antérieur (même contrat que le chat).
  const [batch, setBatch] = useState<{ seq: number; all: boolean }>({ seq: 0, all: false });

  // Réglage global « détail affiché » (réflexion / sorties d'outils).
  const [displayDetailExpanded, setDisplayDetailExpanded] = useState(() => readDisplayDetailExpanded());
  useEffect(() => subscribeDisplayDetail(setDisplayDetailExpanded), []);

  // Modale de fichier locale (image/texte) — calquée sur ChatView, sans état global.
  const [viewerFile, setViewerFile] = useState<ViewerFile | null>(null);
  const handleFileClick = useCallback((f: ViewerFile) => {
    if (f.type === "image" && getPreviewMode() === "popup" && openImagePopup(f.src)) return;
    setViewerFile(f);
  }, []);

  // ÉTANCHÉITÉ : les runs archivés de cette conversation passée sont marqués du
  // projet consulté (projectId) — ils ne fuient jamais vers un autre projet.
  const displayMessages: DisplayMessage[] = useMemo(
    () => convertHistoryToDisplayMessages(raw, projectId),
    [raw, projectId],
  );

  // ── Chargement initial (dernière page) ──
  // Callback RÉUTILISABLE : le bouton « retry » le rappelle au lieu de
  // recharger toute l'application (window.location.reload) — la modale et le
  // chat sous-jacent restent intacts. Un numéro de requête invalide les
  // réponses obsolètes (retry concurrent / changement de session).
  const loadSeqRef = useRef(0);
  const loadHistory = useCallback(() => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError("");
    setRaw([]);
    setMeta(null);
    setBatch({ seq: 0, all: false });
    fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(session.id)}/history`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (seq !== loadSeqRef.current) return;
        setRaw(Array.isArray(data.messages) ? data.messages : []);
        setMeta({ from: data.from ?? 0, total: data.total ?? 0, hasMore: !!data.hasMore });
      })
      .catch((e: any) => {
        if (seq === loadSeqRef.current) setError(e?.message || String(e));
      })
      .finally(() => {
        if (seq === loadSeqRef.current) setLoading(false);
      });
  }, [projectId, session.id]);

  useEffect(() => {
    loadHistory();
    // Invalide la requête en vol au démontage / changement de session.
    return () => { loadSeqRef.current++; };
  }, [loadHistory]);

  // ── Chargement d'un lot antérieur (pagination serveur) ──
  const fetchEarlier = useCallback(async (all: boolean) => {
    if (loadingEarlierRef.current) return;
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    try {
      const params = new URLSearchParams();
      if (all) {
        params.set("all", "true");
      } else {
        if (meta) params.set("before", String(meta.from));
        const firstId = raw[0]?.id;
        if (firstId) params.set("beforeId", String(firstId));
      }
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(session.id)}/history?${params.toString()}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const incoming: any[] = Array.isArray(data.messages) ? data.messages : [];
      setRaw((prev) => {
        // Curseur exclusif côté backend → pas de recouvrement attendu ; on
        // déduplique quand même par id par sécurité (décalage de fichier).
        const seen = new Set(incoming.map((m) => m?.id));
        const merged = [...incoming, ...prev.filter((m) => !seen.has(m?.id))];
        return merged;
      });
      setMeta({ from: data.from ?? 0, total: data.total ?? 0, hasMore: !!data.hasMore });
      setBatch((b) => ({ seq: b.seq + 1, all }));
      // Maintient le bas du viewport en place après préfixage (le composant
      // GroupedMessages gère l'ancrage fin via serverBatchSeq).
    } catch {
      // Dégradé silencieux : on réarme simplement le bouton.
    } finally {
      loadingEarlierRef.current = false;
      setLoadingEarlier(false);
    }
  }, [meta, raw, projectId, session.id]);

  const bannerMeta = [
    formatSessionDate(session.modified || session.created, lang),
    t('sidebar.messageCount', session.messageCount),
  ].filter(Boolean).join(" · ");

  const content = (
    <div className="flex flex-col h-full min-h-0">
      {/* ── Bandeau « conversation passée » (lecture seule) ── */}
      <div className="shrink-0 flex items-start gap-2 px-3 py-2 mb-2 border border-hacker-warn/40 bg-hacker-warn/5 text-hacker-warn">
        <span className="mt-0.5 shrink-0" aria-hidden>📖</span>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-bold tracking-wide">{t('pastConversation.bannerTitle')}</div>
          <div className="text-[10px] text-hacker-text-dim truncate" title={session.name || session.firstMessage}>
            {t('pastConversation.bannerBody')}
          </div>
          {bannerMeta && <div className="text-[9px] text-hacker-text-dim/70 truncate">{bannerMeta}</div>}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-[10px] px-2 py-0.5 border border-hacker-warn/40 text-hacker-warn hover:bg-hacker-warn/10 whitespace-nowrap"
          title={t('pastConversation.back')}
        >
          {t('pastConversation.back')}
        </button>
      </div>

      {/* ── Historique (même rendu que le chat) ── */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto chat-messages pr-1">
        {loading && (
          <div className="py-8 text-center text-xs text-hacker-text-dim">{t('pastConversation.loading')}</div>
        )}
        {!loading && error && (
          <div className="py-8 text-center text-xs text-hacker-error">
            {t('pastConversation.loadError')}
            <button
              type="button"
              onClick={loadHistory}
              className="ml-2 underline hover:text-hacker-accent"
            >
              {t('pastConversation.retry')}
            </button>
          </div>
        )}
        {!loading && !error && displayMessages.length === 0 && (
          <div className="py-8 text-center text-xs text-hacker-text-dim">{t('pastConversation.empty')}</div>
        )}
        {!loading && !error && displayMessages.length > 0 && (
          <GroupedMessages
            key={session.id}
            messages={displayMessages}
            displayDetailExpanded={displayDetailExpanded}
            onFileClick={handleFileClick}
            scrollContainerRef={scrollRef}
            serverHasMore={!!meta?.hasMore}
            serverRemaining={meta ? Math.max(0, meta.from) : 0}
            loadingEarlier={loadingEarlier}
            onLoadEarlierFromServer={fetchEarlier}
            serverBatchSeq={batch.seq}
            serverBatchAll={batch.all}
            hideLiveExtras
          />
        )}
      </div>

      {/* ── Visionneuse de fichier locale (image/texte) ── */}
      {viewerFile && (
        <ModalDialog id="past-file-viewer" onClose={() => setViewerFile(null)}>
          <div className="flex flex-col h-full bg-hacker-surface">
            <div className="flex items-center justify-between px-3 py-2 border-b border-hacker-border shrink-0">
              <span className="text-sm text-hacker-text-bright truncate flex-1">{viewerFile.name || t('viewer.attachment')}</span>
              <button onClick={() => setViewerFile(null)} className="text-hacker-text-dim hover:text-hacker-error ml-2 shrink-0" aria-label={t('viewer.close')}>
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3">
              {viewerFile.type === "image" ? (
                <img src={viewerFile.src} alt={viewerFile.name || t('viewer.image')} className="max-w-full max-h-full object-contain mx-auto" />
              ) : (
                <pre className="text-xs text-hacker-text-bright font-mono whitespace-pre-wrap">{viewerFile.content}</pre>
              )}
            </div>
          </div>
        </ModalDialog>
      )}
    </div>
  );

  return (
    <ModalDialog
      id="past-conversation"
      onClose={onClose}
      ariaLabel={t('pastConversation.title')}
    >
      {content}
    </ModalDialog>
  );
}
