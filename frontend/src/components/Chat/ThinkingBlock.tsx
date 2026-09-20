// ── Bloc de réflexion (LOT 1 refonte chat) ──────────────────────────────────
// Le repli/dépli est piloté par CollapsibleBlock — précédence exacte (cf.
// utils/collapse.ts) : override utilisateur > auto-repli (réflexion consommée)
// > auto-dépli (erreur) > réglage global « détail d'affichage ».
// - AUTO-REPLI rétabli (comportement Lot C perdu) : dès que le texte de la
//   réponse commence à streamer (textStarted, premier delta du message), le
//   bloc se replie automatiquement — SAUF override utilisateur — et l'en-tête
//   continue d'afficher « a réfléchi Xs » (durée figée au premier delta).
//   Condition TRANSITOIRE calculée ici : textStarted && isStreaming — ce n'est
//   PAS un override (rien n'est mémorisé) ; il fonctionne même quand le réglage
//   global est « déplié », et une fois le tour terminé la règle normale reprend
//   (réglage global / erreur), l'override restant décisionnaire.
// - Le réglage global arrive par le contexte → le changer (Ctrl+T / Paramètres)
//   s'applique aux blocs DÉJÀ MONTÉS (correctif du bug d'initialisation unique).

import { memo, useState, useCallback, useRef, useEffect } from "react";
import { Copy, Check } from "lucide-react";
import { useTranslation } from "../../i18n";
import { copyToClipboard } from "../../utils/clipboard";
import { CollapsibleBlock } from "./CollapsibleBlock";

interface Props {
  thinking: string;
  isStreaming?: boolean;
  /** Clé d'override par bloc — REQUIRED (contexte de repli). */
  blockId: string;
  /** Vrai si le turn LLM a échoué (stopReason error / errorMessage) → auto-dépli. */
  isError?: boolean;
  /**
   * Vrai dès que la réponse (text_delta) a commencé à arriver (info consommée).
   * Combiné à isStreaming → auto-repli TRANSITOIRE de la réflexion (pas un
   * override) : replié tant que le texte streame, puis règle normale au tour fini.
   */
  textStarted?: boolean;
  // Lot C : durée de réflexion figée (ms) — affichée dans l'en-tête replié.
  thinkingDurationMs?: number;
}

// Formate une durée en ms → "12s" / "1m 05s" (affichage en-tête replié).
function formatDuration(ms: number): string {
  const totalSecs = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export const ThinkingBlock = memo(function ThinkingBlock({ thinking, isStreaming, blockId, isError = false, textStarted = false, thinkingDurationMs }: Props) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasContent = thinking.length > 0;
  // Auto-repli TRANSITOIRE : réflexion consommée (texte commencé) tant que le
  // tour streame. Prime sur isError et le réglage global, jamais sur l'override
  // utilisateur ; une fois le tour terminé, la règle normale reprend.
  const hasTextStarted = !!textStarted && !!isStreaming;

  // Nettoyage du timer de feedback si le bloc est démonté
  useEffect(() => () => { if (resetTimerRef.current) clearTimeout(resetTimerRef.current); }, []);

  const handleCopy = useCallback(async () => {
    // Helper robuste (navigator.clipboard + fallback execCommand) : nécessaire
    // en http LAN non sécurisé où navigator.clipboard n'existe pas.
    const ok = await copyToClipboard(thinking);
    if (!ok) return;
    setCopied(true);
    // Feedback « Copié ✓ » pendant 2s puis retour à l'icône copier
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [thinking]);

  if (!hasContent) return null;

  return (
    <CollapsibleBlock
      blockId={blockId}
      isError={isError}
      hasTextStarted={hasTextStarted}
      className="thinking-block mb-2"
      headerClassName="thinking-block-header cursor-pointer"
      chevronPosition="left"
      // La durée n'apparaît que dans l'en-tête REPLIÉ (info consommée).
      header={({ expanded }) => (
        <>
          <span className="thinking-block-label">{t('thinkingBlock.thinking')}</span>
          {!expanded && thinkingDurationMs !== undefined && (
            <span className="thinking-block-duration">{t('chat.thoughtFor', formatDuration(thinkingDurationMs))}</span>
          )}
        </>
      )}
      headerActions={
        <button onClick={handleCopy} className="thinking-copy-btn" title={t('thinkingBlock.copy')}>
          {copied ? <Check size={10} /> : <Copy size={10} />}
          {copied ? t('thinkingBlock.copied') : t('thinkingBlock.copy')}
        </button>
      }
    >
      <div className="thinking-content">{thinking}</div>
      {isStreaming && (
        <div className="thinking-progress-bar">
          <div className="thinking-progress-fill" />
        </div>
      )}
    </CollapsibleBlock>
  );
});