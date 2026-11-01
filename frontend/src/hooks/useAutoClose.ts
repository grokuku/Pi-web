import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Phase VISIBLE de l'auto-fermeture :
 *  - `idle`      : rien n'est programmé (au départ, après échéance ou fermeture) ;
 *  - `scheduled` : le compte à rebours tourne, la fenêtre va se fermer ;
 *  - `cancelled` : l'utilisateur a annulé, la fenêtre reste ouverte.
 * L'interface peut ainsi dire la VÉRITÉ (avant, `cancel()` ne touchait qu'une
 * ref : le message « fermeture imminente » restait affiché alors que la
 * fermeture était annulée).
 */
export type AutoClosePhase = "idle" | "scheduled" | "cancelled";

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
 * L'état est OBSERVABLE (`isScheduled`, `cancelled`) pour que l'affichage ne
 * mente jamais : il ne change qu'aux TRANSITIONS (`schedule` / `cancel` /
 * échéance / `closeNow`), jamais à chaque mouvement de souris (les appels
 * répétés à `cancel()` sortent immédiatement, sans `setState`).
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
  /**
   * État RÉACTIF de l'auto-fermeture (miroir de `cancelledRef` + minuterie).
   * Ne change qu'aux transitions : `setPhase` avec la même valeur est ignoré
   * par React (aucun rendu supplémentaire), donc `cancel()` × N ne boucle pas.
   */
  const [phase, setPhase] = useState<AutoClosePhase>("idle");

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** Ferme tout de suite (Échap, clic explicite, bouton « Fermer »). */
  const closeNow = useCallback(() => {
    clearTimer();
    // Plus rien n'est programmé : l'affichage ne doit plus parler de fermeture.
    setPhase("idle");
    onCloseRef.current();
  }, [clearTimer]);

  /**
   * Annule définitivement l'auto-fermeture (survol/souris). Ne ferme rien :
   * la modale reste ouverte et l'utilisateur la ferme lui-même.
   */
  const cancel = useCallback(() => {
    // Sortie IMMÉDIATE si déjà annulé : pas de `setState` en boucle à chaque
    // `mousemove` (l'état n'a pas de raison de changer).
    if (cancelledRef.current) return;
    cancelledRef.current = true;
    clearTimer();
    setPhase("cancelled");
  }, [clearTimer]);

  /**
   * Démarre (ou redémarre) le compte à rebours. Idempotent : un appel répété
   * pendant le délai ne cumule pas les minuteries.
   */
  const schedule = useCallback(() => {
    if (cancelledRef.current) return;
    clearTimer();
    setPhase("scheduled");
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // Échéance : le compte à rebours est terminé (l'affichage cesse alors
      // d'annoncer une fermeture à venir).
      setPhase("idle");
      // Fermeture douce si l'appelant en a fourni une (fondu), sinon directe.
      const begin = beginCloseRef.current;
      if (begin) begin();
      else onCloseRef.current();
    }, delayMs);
  }, [clearTimer, delayMs]);

  /** Version NON réactive (compatibilité) : à n'utiliser que dans un gestionnaire. */
  const isCancelled = useCallback(() => cancelledRef.current, []);

  // Nettoyage : jamais de fermeture après démontage (la modale a pu être
  // fermée par un autre chemin entre-temps). Aucun `setState` ici : pas de
  // mise à jour d'état après démontage.
  useEffect(() => clearTimer, [clearTimer]);

  return {
    schedule,
    cancel,
    closeNow,
    isCancelled,
    /** Vrai tant que le compte à rebours tourne (RÉACTIF). */
    isScheduled: phase === "scheduled",
    /** Vrai si l'utilisateur a annulé la fermeture (RÉACTIF). */
    cancelled: phase === "cancelled",
    /** Phase brute, si l'appelant a besoin de distinguer « rien » de « annulé ». */
    phase,
  };
}
