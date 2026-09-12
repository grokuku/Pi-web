// ── holaf-toast — wrapper React de la brique HolafToast (holaf-lib v0.5.0) ──
// Une SEULE instance (singleton de la brique), créée paresseusement, exposant
// `toast(message, type, duration?)`.
//
// Pattern idempotent : si `window.HolafToast` existe déjà (brique chargée par
// un autre chemin — script global, autre bundle), on l'utilise ; sinon on
// importe le module vendored (dont l'évaluation pose justement
// `window.HolafToast`). Les deux références pointent de toute façon vers le
// même singleton, donc aucun risque de double conteneur.
//
// Thème « pi-web » : le registre --ht-* est mappé sur les tokens
// hacker-theme.css via `var(...)`. Les variables étant posées À LA FOIS en
// valeur dynamique (`var(--surface-raised)`, `var(--accent)`…), le toast suit
// automatiquement le mode sombre/clair ET le preset d'accent (data-accent sur
// <html>) sans rejouer setTheme : les custom properties sont résolues à
// l'affichage contre l'héritage du document.

import {
  HolafToast as VendoredHolafToast,
  type HolafToastApi,
  type HolafToastType,
  type HolafThemeVars,
} from "../vendor/holaf/holaf-toast.js";

export type { HolafToastType } from "../vendor/holaf/holaf-toast.js";

/** Nom du thème enregistré dans le registre de la brique. */
const THEME_NAME = "pi-web";

// Mapping tokens hacker-theme.css → registre --ht-* de la brique.
// On référence les vars CSS du projet (et non des hex figés) pour que le toast
// reste synchro avec le thème sombre/clair et le preset d'accent courant.
// Les teintes par type (--ht-bg-success/warning/error, v0.4.0) ne sont PAS
// définies → fallback sur --ht-bg (fond neutre), la distinction de type passe
// par la bordure gauche + l'icône colorées.
const PI_WEB_THEME_VARS: HolafThemeVars = {
  "--ht-bg": "var(--surface-raised)",
  "--ht-fg": "var(--text-bright)",
  "--ht-border": "var(--border-bright)",
  "--ht-accent-info": "var(--info)",
  "--ht-accent-success": "var(--accent)",
  "--ht-accent-warning": "var(--warn)",
  "--ht-accent-error": "var(--error)",
  "--ht-radius": "4px",
  "--ht-shadow": "0 6px 24px rgba(0, 0, 0, 0.5)",
};

// Résolution de l'instance : window.HolafToast en priorité (idempotence),
// sinon le module vendored importé.
function getApi(): HolafToastApi {
  if (typeof window !== "undefined" && window.HolafToast) return window.HolafToast;
  return VendoredHolafToast;
}

// Initialisation du thème — idempotente (un seul register + setTheme par run).
let themeInitialized = false;

/**
 * Enregistre le thème « pi-web » et le pose comme thème global de la brique.
 * Appelable plusieurs fois sans effet de bord ; sûr même si la brique est
 * absente (fail-safe silencieux). Appelée au boot (App.tsx) et, par sécurité,
 * paresseusement au premier `toast()`.
 */
export function initToastTheme(): void {
  if (themeInitialized) return;
  try {
    const api = getApi();
    api.themes.register(THEME_NAME, PI_WEB_THEME_VARS);
    api.setTheme(THEME_NAME);
    themeInitialized = true;
  } catch (e) {
    // Fail-safe : un toast ne doit jamais faire planter l'application.
    console.warn("[pi-web] holaf-toast : échec d'initialisation du thème", e);
  }
}

/**
 * Affiche un toast pi-web.
 * @param message  texte du message (i18n déjà résolu par l'appelant)
 * @param type     info | success | warning | error (défaut info)
 * @param duration durée en ms ; omise = défaut de la brique (4000 ms),
 *                 0 = persistant
 */
export function toast(
  message: string,
  type: HolafToastType = "info",
  duration?: number
): void {
  try {
    initToastTheme();
    getApi().show({
      message,
      type,
      ...(duration === undefined ? {} : { duration }),
    });
  } catch (e) {
    // Fail-safe : ne jamais casser le flux applicatif à cause d'un toast.
    console.error("[pi-web] holaf-toast : échec d'affichage du toast", e);
  }
}
