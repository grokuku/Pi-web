// ── Panneau « Conversations passées » de la sidebar (LOT E1) ───────────────
// Point d'entrée discret et repliable vers les conversations passées d'un
// projet. Affiche pour chacune : date/heure, aperçu du premier message
// utilisateur, nombre de messages et taille du fichier. Un filtre de recherche
// simple (nom / aperçu / id) et un bouton d'actualisation complètent le tout.
//
// PÉRIMÈTRE E1 : LECTURE/NAVIGATION uniquement. Cliquer une conversation
// ouvre la visionneuse en lecture seule (PastConversationViewer) — la session
// active du projet n'est jamais modifiée et il n'existe ni bouton « Reprendre »
// ni reprise automatique.
import { useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { useTranslation } from "../../i18n";
import type { PastSession } from "../../types";
import { filterPastSessions, formatBytes, formatSessionDate, truncatePreview } from "../../utils/pastSessions";

interface Props {
  sessions: PastSession[];
  loading: boolean;
  onOpen: (s: PastSession) => void;
  onRefresh: () => void;
}

export function PastConversations({ sessions, loading, onOpen, onRefresh }: Props) {
  const { t, lang } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => filterPastSessions(sessions, query), [sessions, query]);

  return (
    <div className="mt-2 border-t border-hacker-border-bright pt-1.5">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex-1 min-w-0 flex items-center gap-1 text-left text-hacker-accent text-[10px] tracking-widest hover:text-hacker-accent/80"
          title={t('sidebar.pastConversationsHint')}
        >
          <span className={`inline-block transition-transform ${open ? "rotate-90" : ""}`} aria-hidden>▸</span>
          <span className="truncate">{t('sidebar.pastConversations')}</span>
          {sessions.length > 0 && <span className="text-hacker-text-dim/70">({sessions.length})</span>}
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="p-0.5 text-hacker-text-dim hover:text-hacker-accent disabled:opacity-40 disabled:cursor-wait shrink-0"
          title={t('sidebar.refreshConversations')}
          aria-label={t('sidebar.refreshConversations')}
        >
          <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {open && (
        <div className="mt-1.5">
          {/* Filtre/recherche simple */}
          <div className="relative mb-1">
            <Search size={10} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-hacker-text-dim/60" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('sidebar.searchConversation')}
              aria-label={t('sidebar.searchConversation')}
              className="w-full bg-hacker-bg border border-hacker-border pl-5 pr-1.5 py-1 text-[11px] text-hacker-text placeholder:text-hacker-text-dim/50 focus:outline-none focus:border-hacker-accent/50"
            />
          </div>

          <div role="listbox" aria-label={t('sidebar.pastConversations')} className="max-h-56 overflow-y-auto space-y-px">
            {loading && sessions.length === 0 && (
              <div className="px-2 py-1.5 text-[10px] italic text-hacker-text-dim">{t('sidebar.loadingConversations')}</div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="px-2 py-1.5 text-[10px] italic text-hacker-text-dim">
                {sessions.length === 0 ? t('sidebar.noConversations') : t('sidebar.noConversationMatch')}
              </div>
            )}
            {filtered.map((s) => {
              const title = s.name || truncatePreview(s.firstMessage, 60) || t('sidebar.untitledConversation');
              const meta = [
                formatSessionDate(s.modified || s.created, lang),
                t('sidebar.messageCount', s.messageCount),
                s.sizeBytes !== undefined ? formatBytes(s.sizeBytes) : "",
              ].filter(Boolean).join(" · ");
              return (
                <button
                  key={s.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => onOpen(s)}
                  className="w-full text-left px-1.5 py-1 border border-transparent hover:border-hacker-accent/30 hover:bg-hacker-border/30 transition-colors"
                  title={`${title}\n${meta}`}
                >
                  <div className="truncate text-[11px] text-hacker-text">{title}</div>
                  <div className="truncate text-[9px] text-hacker-text-dim">{meta}</div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
