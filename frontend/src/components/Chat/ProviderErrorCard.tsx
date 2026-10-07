// ── Carte d'erreur du fournisseur LLM (C1 + C2) ────────────────────────────
// Remplace l'ancienne bannière rouge de BUG-68 (un pavé identique PAR tentative
// ratée) par UNE carte par tour, qui :
//   - affiche « ❌ Erreur du fournisseur — N tentatives (de HH:MM:SS à HH:MM:SS) »
//     et la DERNIÈRE erreur traduite en phrase compréhensible (modèle,
//     fournisseur, réf., action proposée) ;
//   - propose un bouton « Réessayer » (renvoi du message d'origine via le canal
//     d'envoi existant — aucun nouveau canal) ;
//   - garde le TEXTE BRUT de chaque tentative accessible via le mécanisme de
//     repli commun (CollapsibleBlock → réglage « Déplier le détail d'affichage
//     par défaut » + override par bloc), avec un blockId STABLE.
//
// `RetriedSuccessNote` traite le cas « une reprise a fini par réussir » : les
// tentatives ratées sont rattachées SOUS le message réussi en note repliable
// et discrète — le tour n'est jamais présenté comme un échec.
//
// Le JSON brut n'est jamais supprimé : il est seulement replié.

import { memo } from "react";
import { HolafIcon } from "../icons/HolafIcon";
import { useTranslation } from "../../i18n";
import { CollapsibleBlock } from "./CollapsibleBlock";
import { llmErrorDisplay, type ProviderErrorAttempt, type ProviderErrorRun } from "../../utils/llm-errors";

/** Heure locale HH:MM:SS (les reprises s'enchaînent en secondes). */
function formatTimeSeconds(ts?: number): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ── Détail brut des tentatives (contenu partagé carte / note de réussite) ──
function ProviderErrorAttemptsList({ attempts }: { attempts: ProviderErrorAttempt[] }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      {attempts.map((a, i) => {
        const time = formatTimeSeconds(a.timestamp);
        // Nom lisible du fournisseur (résolu backend) quand il existe ; repli
        // sur la valeur brute pour garder le détail technique diagnostiquable.
        const who = [a.providerName || a.provider, a.model].filter(Boolean).join("/");
        return (
          <div key={a.id} className="bg-black/20 border border-red-500/20 rounded px-1.5 py-1">
            <div className="text-[9px] text-red-300/70">
              {t("chat.providerErrorAttemptLabel", i + 1)}
              {time ? ` · ${time}` : ""}
              {who ? ` · ${who}` : ""}
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-[10px] text-red-200/80 max-h-40 overflow-y-auto mt-0.5">
              {a.errorMessage || t("chat.providerErrorNoDetail")}
            </pre>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Détail brut repliable (C1) : blockId STABLE basé sur l'ancre du run → le
 * réglage global et l'override utilisateur s'appliquent comme partout.
 */
function ProviderErrorDetails({ run }: { run: ProviderErrorRun }) {
  const { t } = useTranslation();
  return (
    <CollapsibleBlock
      blockId={`provider-error-details:${run.anchorId}`}
      className="min-w-0"
      headerClassName="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wide text-left min-w-0 text-red-300/80 hover:text-red-200"
      contentClassName="mt-1"
      header={<span>{t("chat.providerErrorDetails", run.attempts.length)}</span>}
    >
      <ProviderErrorAttemptsList attempts={run.attempts} />
    </CollapsibleBlock>
  );
}

/**
 * Note « N tentatives échouées avant cette réponse » (cas reprise RÉUSSIE) :
 * sobre (pas de rouge), jamais confondue avec un échec du tour ; le détail
 * reste consultable via le repli commun.
 */
export const RetriedSuccessNote = memo(function RetriedSuccessNote({ run }: { run: ProviderErrorRun }) {
  const { t } = useTranslation();
  return (
    <CollapsibleBlock
      blockId={`provider-retry-note:${run.anchorId}`}
      className="min-w-0"
      headerClassName="inline-flex items-center gap-1.5 text-[10px] font-mono text-left min-w-0 text-hacker-text-dim hover:text-hacker-text-bright"
      contentClassName="mt-1"
      header={<span>⚑ {t("chat.providerRetriedOk", run.attempts.length)}</span>}
    >
      <ProviderErrorAttemptsList attempts={run.attempts} />
    </CollapsibleBlock>
  );
});

export interface ProviderErrorCardProps {
  run: ProviderErrorRun;
  /** Renvoi du message d'origine (absent en consultation d'historique passé). */
  onRetry?: () => void;
}

/**
 * Carte unique d'un tour en échec : la DERNIÈRE tentative fournit le message
 * pédagogique (classe d'erreur → phrase non technique), les N tentatives sont
 * résumées dans l'en-tête, le détail brut est repliable.
 */
export const ProviderErrorCard = memo(function ProviderErrorCard({ run, onRetry }: ProviderErrorCardProps) {
  const { t } = useTranslation();
  const last = run.attempts[run.attempts.length - 1];
  const display = llmErrorDisplay({
    errorMessage: last?.errorMessage,
    provider: last?.provider,
    providerName: last?.providerName,
    model: last?.model,
  });
  const count = run.attempts.length;
  const from = count > 1 ? formatTimeSeconds(run.attempts[0]?.timestamp) : "";
  const to = count > 1 ? formatTimeSeconds(last?.timestamp) : "";

  return (
    <div className="flex items-start gap-2 text-xs border border-red-500/40 bg-red-500/10 text-red-400 rounded px-2 py-1.5">
      <HolafIcon name="alert-triangle" size={12} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap">
          <span className="font-bold">{t(display.titleKey)}</span>
          <span className="text-red-300/80">{t("chat.providerErrorAttempts", count, from, to)}</span>
        </div>
        <p className="mt-1 text-red-200/90 break-words">{t(display.messageKey, ...display.args)}</p>
        {onRetry && (
          <div className="mt-1.5">
            <button
              type="button"
              onClick={onRetry}
              title={t("chat.providerErrorRetryTitle")}
              className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wide px-2 py-0.5 rounded border border-red-400/50 text-red-200 hover:bg-red-500/20 hover:border-red-300 transition-colors"
            >
              <HolafIcon name="refresh" size={10} />
              {t("chat.providerErrorRetry")}
            </button>
          </div>
        )}
        <div className="mt-1.5">
          <ProviderErrorDetails run={run} />
        </div>
      </div>
    </div>
  );
});
