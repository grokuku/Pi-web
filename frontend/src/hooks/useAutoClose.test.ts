// @vitest-environment jsdom
/**
 * Garanties du hook `useAutoClose` (fermeture « naturelle » des modales).
 *
 * Ces tests verrouillent les points sensibles relevés lors de l'audit :
 *  - la minuterie est ANNULÉE au démontage : aucun `onClose` ne doit être
 *    appelé après coup (état fantôme / `setState` sur composant démonté) ;
 *  - `schedule()` est IDEMPOTENT : deux appels pendant le délai ne cumulent pas
 *    deux minuteries (une seule fermeture) ;
 *  - `cancel()` (survol, Échap, bouton) désarme définitivement ;
 *  - `closeNow()` ferme tout de suite, une seule fois ;
 *  - avec `beginClose` (fondu), c'est LUI qui est appelé au terme du délai —
 *    jamais `onClose` directement : le fondu ne peut donc pas re-programmer de
 *    compte à rebours.
 *
 * Aucun réseau, aucune horloge réelle : `vi.useFakeTimers()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useAutoClose } from "./useAutoClose";

const DELAY = 2000;
const FADE = 160;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useAutoClose", () => {
  it("ferme après le délai, une seule fois", () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useAutoClose(onClose, DELAY));

    act(() => result.current.schedule());
    act(() => {
      vi.advanceTimersByTime(DELAY - 1);
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // Rien d'autre ensuite : la minuterie a bien été désarmée.
    act(() => {
      vi.advanceTimersByTime(DELAY * 3);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("DÉMONTAGE pendant le délai : `onClose` n'est JAMAIS appelé (pas de fuite de minuterie)", () => {
    const onClose = vi.fn();
    const { result, unmount } = renderHook(() => useAutoClose(onClose, DELAY));

    act(() => result.current.schedule());
    act(() => {
      vi.advanceTimersByTime(DELAY / 2);
    });
    expect(onClose).not.toHaveBeenCalled();

    unmount();

    // Bien après l'échéance : la minuterie a été annulée au démontage.
    act(() => {
      vi.advanceTimersByTime(DELAY * 5);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("`schedule()` appelé deux fois ne crée PAS deux minuteries concurrentes", () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useAutoClose(onClose, DELAY));

    act(() => {
      result.current.schedule();
      result.current.schedule();
    });

    act(() => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(DELAY * 3);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("`schedule()` deux fois pendant le délai redémarre le compte à rebours (une seule fermeture)", () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useAutoClose(onClose, DELAY));

    act(() => result.current.schedule());
    act(() => {
      vi.advanceTimersByTime(DELAY - 100); // presque à l'échéance
    });
    act(() => result.current.schedule()); // redémarre

    act(() => {
      vi.advanceTimersByTime(99); // l'ancien délai serait échu ici
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("`cancel()` (survol / Échap) désarme définitivement : même un `schedule()` ultérieur ne ferme pas", () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useAutoClose(onClose, DELAY));

    act(() => result.current.schedule());
    act(() => result.current.cancel());
    expect(result.current.isCancelled()).toBe(true);

    act(() => result.current.schedule()); // ignoré (déjà annulé)
    act(() => {
      vi.advanceTimersByTime(DELAY * 3);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("`closeNow()` ferme immédiatement, une seule fois, et désarme la minuterie", () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useAutoClose(onClose, DELAY));

    act(() => result.current.schedule());
    act(() => result.current.closeNow());
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(DELAY * 3);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("avec `beginClose` (fondu), le hook n'appelle JAMAIS `onClose` lui-même", () => {
    const onClose = vi.fn();
    const beginClose = vi.fn();
    const { result } = renderHook(() => useAutoClose(onClose, DELAY, { beginClose }));

    act(() => result.current.schedule());
    act(() => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(beginClose).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    // Le fondu ne re-programme rien : pas de second appel.
    act(() => {
      vi.advanceTimersByTime(FADE + DELAY * 3);
    });
    expect(beginClose).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("un changement d'identité de `onClose` ne reprogramme pas la fermeture", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(
      ({ onClose }) => useAutoClose(onClose, DELAY),
      { initialProps: { onClose: first } }
    );

    act(() => result.current.schedule());
    rerender({ onClose: second });
    act(() => {
      vi.advanceTimersByTime(DELAY);
    });
    // Une seule fermeture, avec la dernière référence fournie.
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

/**
 * État RÉACTIF de l'auto-fermeture.
 *
 * Défaut corrigé : `cancel()` ne touchait qu'une ref, donc l'interface
 * continuait d'afficher « fermeture imminente » alors que la fermeture était
 * annulée. `isScheduled` / `cancelled` sont désormais des états observables,
 * mis à jour UNIQUEMENT aux transitions (pas à chaque mouvement de souris).
 */
describe("useAutoClose — état réactif (isScheduled / cancelled)", () => {
  it("`isScheduled` suit les transitions : désarmé → armé → annulé", () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useAutoClose(onClose, DELAY));

    expect(result.current.isScheduled).toBe(false);
    expect(result.current.cancelled).toBe(false);

    act(() => result.current.schedule());
    expect(result.current.isScheduled).toBe(true);
    expect(result.current.cancelled).toBe(false);

    act(() => result.current.cancel());
    expect(result.current.isScheduled).toBe(false);
    expect(result.current.cancelled).toBe(true);
  });

  it("après annulation, la modale reste OUVERTE : aucun `onClose`, même longtemps après", () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useAutoClose(onClose, DELAY));

    act(() => result.current.schedule());
    act(() => result.current.cancel());
    act(() => {
      vi.advanceTimersByTime(DELAY * 5);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(result.current.cancelled).toBe(true);
  });

  it("`isScheduled` repasse à false à l'échéance et le compte à rebours peut être RÉARMÉ", () => {
    const onClose = vi.fn();
    const beginClose = vi.fn();
    const { result } = renderHook(() => useAutoClose(onClose, DELAY, { beginClose }));

    act(() => result.current.schedule());
    expect(result.current.isScheduled).toBe(true);

    act(() => {
      vi.advanceTimersByTime(DELAY);
    });
    // Échéance : le fondu démarre, plus rien n'est « programmé ».
    expect(beginClose).toHaveBeenCalledTimes(1);
    expect(result.current.isScheduled).toBe(false);

    // Un nouveau compte à rebours réaffiche l'état « programmé ».
    act(() => result.current.schedule());
    expect(result.current.isScheduled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(beginClose).toHaveBeenCalledTimes(2);
  });

  it("`closeNow()` nettoie l'état : plus rien n'est « programmé » ni « annulé »", () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useAutoClose(onClose, DELAY));

    act(() => result.current.schedule());
    act(() => result.current.closeNow());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(result.current.isScheduled).toBe(false);
    expect(result.current.cancelled).toBe(false);
  });

  it("`cancel()` appelé N fois ne provoque AUCUN rendu supplémentaire (pas de boucle)", () => {
    const onClose = vi.fn();
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useAutoClose(onClose, DELAY);
    });

    act(() => result.current.schedule()); // rendu 2 (armé)
    const afterSchedule = renders;
    act(() => result.current.cancel()); // rendu 3 (annulé)
    const afterCancel = renders;

    // 20 annulations de plus : l'état est déjà « annulé », React ne rend plus.
    act(() => {
      for (let i = 0; i < 20; i += 1) result.current.cancel();
    });
    expect(renders).toBe(afterCancel);
    expect(afterSchedule).toBeGreaterThan(1);
    expect(afterCancel).toBeGreaterThan(afterSchedule);
    expect(result.current.cancelled).toBe(true);
    expect(result.current.isScheduled).toBe(false);
  });

  it("DÉMONTAGE pendant le délai : état nettoyé, aucun `onClose` (non-régression)", () => {
    const onClose = vi.fn();
    const { result, unmount } = renderHook(() => useAutoClose(onClose, DELAY));

    act(() => result.current.schedule());
    expect(result.current.isScheduled).toBe(true);
    unmount();
    act(() => {
      vi.advanceTimersByTime(DELAY * 5);
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
