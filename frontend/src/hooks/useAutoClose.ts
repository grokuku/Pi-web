import { useCallback, useEffect, useRef } from "react";

/**
 * Fermeture « naturelle » d'une modale après un succès.
 *
 * Problème résolu : la fenêtre de commit/push se fermait BRUTALEMENT, 1,2 s
 * après le push (setTimeout fixe dans GitPanel), sans que l'on ait le temps de
 * lire la confirmation.
 *
 * Comportement ici :
 *  - `onClose` est appelé après `delayMs` (défaut 2 s), le message de succès
 *    restant affiché pendant tout le compte à rebours ;
 *  - le compte à rebours est ANNULÉ si l'utilisateur interagit avec la fenêtre
 *    (survol, déplacement de la souris) — on ne ferme pas sous les yeux de
 *    quelqu'un qui s'en sert ;
 *  - il est aussi annulé si l'onglet est masqué (l'utilisateur ne voit plus la
 *    fenêtre : mieux vaut attendre son retour que fermer dans son dos) ;
 *  - `closeNow()` ferme immédiatement (Échap, clic, bouton « Fermer »).
 *
 * Aucune fermeture n'a lieu tant que `cancel()` n'a pas été appelé et que le
 * délai n'est pas écoulé : rien n'est déclenché avant `delayMs`.
 *
 * @param onClose   Fermeture effective de la modale (récupérée via un ref : la
 *                  stabilité de la fonction de l'appelant n'est pas requise).
 *                  ⚠️ Si l'appelant fournit `options.beginClose`, c'est ELLE qui
 *                  est appelée au terme du délai (pour jouer un fondu) ; `onClose`
 *                  reste la fermeture immédiate (`closeNow`).
 * @param delayMs   Délai avant fermeture automatique, en millisecondes.
 * @param options.beginClose Fermeture « douce » au terme du délai (fondu, puis
 *                  `onClose`). Par défaut : `onClose` directement.
 */
export function useAutoClose(
  onClose: () => void,
  delayMs = 2000,
  options: { beginClose?: () => void } = {}
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const beginCloseRef = useRef(options.beginClose);
  beginCloseRef.current = options.beginClose;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** true dès que l'utilisateur (ou un changement d'état) a annulé l'auto-fermeture. */
  const cancelledRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** Ferme tout de suite (Échap, clic explicite, bouton « Fermer »). */
  const closeNow = useCallback(() => {
    clearTimer();
    onCloseRef.current();
  }, [clearTimer]);

  /**
   * Annule définitivement l'auto-fermeture (survol/souris). Ne ferme rien :
   * la modale reste ouverte et l'utilisateur la ferme lui-même.
   */
  const cancel = useCallback(() => {
    if (cancelledRef.current) return;
    cancelledRef.current = true;
    clearTimer();
  }, [clearTimer]);

  /**
   * Démarre (ou redémarre) le compte à rebours. Idempotent : un appel répété
   * pendant le délai ne cumule pas les minuteries.
   */
  const schedule = useCallback(() => {
    if (cancelledRef.current) return;
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // Fermeture douce si l'appelant en a fourni une (fondu), sinon directe.
      const begin = beginCloseRef.current;
      if (begin) begin();
      else onCloseRef.current();
    }, delayMs);
  }, [clearTimer, delayMs]);

  const isCancelled = useCallback(() => cancelledRef.current, []);

  // Nettoyage : jamais de fermeture après démontage (la modale a pu être
  // fermée par un autre chemin entre-temps).
  useEffect(() => clearTimer, [clearTimer]);

  return { schedule, cancel, closeNow, isCancelled };
}
