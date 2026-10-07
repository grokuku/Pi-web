// Déclarations TypeScript pour la brique HolafToast (holaf-lib v0.8.0).
// Copie pinnée dans vendor/holaf — le fichier .js est du JS pur (sans types),
// on déclare ici l'API publique pour que tsc --noEmit passe sans `any` implicite.
// API calquée sur js/holaf-toast.js (version 0.8.0) : show + helpers,
// update/hide (id métier ou contrôleur), setTheme/clearTheme, configure() et
// le registre de thèmes (themes.register/get/list/update). Ajouts additifs
// depuis 0.5.0 : setStyleNonce()/getCss() (CSP strict / CSS externe) et les
// options d'appel `nonce`/`injectStyles` (2ᵉ argument de show(), helpers
// inclus) — aucune signature existante n'a changé.

export type HolafToastType = "info" | "success" | "warning" | "error";

export type HolafToastPosition =
  | "top-right"
  | "top-left"
  | "bottom-right"
  | "bottom-left"
  | "top-center"
  | "bottom-center";

export type HolafToastCloseReason = "timeout" | "click" | "manual" | "replaced";

/** Variables de thème `--ht-*` (clés préfixées par `--`, valeurs stringifiées). */
export type HolafThemeVars = Record<string, string | number>;

/** Spécification de thème acceptée par `show({ theme })` et `setTheme()`. */
export type HolafThemeSpec =
  | string
  | HolafThemeVars
  | { preset?: string; vars?: HolafThemeVars };

/** Action cliquable affichée dans un toast. `close` vaut true par défaut. */
export interface HolafToastAction {
  label: string;
  onClick?: (ctrl: HolafToastController) => void;
  close?: boolean;
}

export interface HolafToastOptions {
  /** Contenu du message (textContent par défaut, innerHTML si `html: true`). */
  message?: string | number;
  /** Titre optionnel affiché au-dessus du message. */
  title?: string | number;
  /** Type (défaut `info`). */
  type?: HolafToastType;
  /** Durée en ms avant fermeture auto (défaut 4000 ; 0 = persistant). */
  duration?: number;
  /** Position du conteneur (défaut `top-right`). */
  position?: HolafToastPosition;
  /** Thème de CE toast : nom, variables `--ht-*` ou `{ preset, vars }`. */
  theme?: HolafThemeSpec;
  /** Ferme le toast au clic sur celui-ci (défaut false). */
  closeOnClick?: boolean;
  /** Id métier : un toast vivant portant cet id est mis à jour au lieu d'être recréé. */
  id?: string;
  /** Message interprété comme innerHTML (contenu de confiance). */
  html?: boolean;
  /** `"manual"` : barre de progression pilotée par `update({ progress })`, sans timer. */
  progress?: "manual";
  /** Actions cliquables affichées sous le message. */
  actions?: HolafToastAction[];
  /**
   * Nonce CSP appliqué au `<style>` injecté (v0.5.1). Équivalent au champ de
   * même nom du 2ᵉ argument de `show()` ; prime sur `setStyleNonce()`.
   */
  nonce?: string | null;
  /**
   * `false` : n'injecte AUCUN `<style>` (l'hôte sert `getCss()` comme fichier
   * .css statique) — v0.5.2. Prime sur le réglage global `configure()`.
   */
  injectStyles?: boolean;
  onShow?: (ctrl: HolafToastController) => void;
  onClose?: (reason: HolafToastCloseReason) => void;
}

/** 2ᵉ argument optionnel de `show()` — prime sur les champs de `options`. */
export interface HolafToastCallOptions {
  nonce?: string | null;
  injectStyles?: boolean;
}

/** Patch accepté par `ctrl.update()` / `HolafToast.update()`. */
export interface HolafToastPatch {
  message?: string | number;
  /** `null` ou `""` retire le titre. */
  title?: string | number | null;
  type?: HolafToastType;
  html?: boolean;
  /** Largeur de la barre (0-100), en mode `progress: "manual"`. */
  progress?: number;
}

export interface HolafToastController {
  el: HTMLElement;
  close(): void;
  update(patch: HolafToastPatch): void;
}

export interface HolafToastConfigureOptions {
  position?: HolafToastPosition;
  duration?: number;
  theme?: HolafThemeSpec;
  newestFirst?: boolean;
  /** `false` : désactive globalement l'injection du `<style>` (v0.5.2). */
  injectStyles?: boolean;
}

export interface HolafToastApi {
  version: string;
  show(options: HolafToastOptions, callOptions?: HolafToastCallOptions): HolafToastController;
  success(
    message: string | number,
    options?: HolafToastOptions,
    callOptions?: HolafToastCallOptions
  ): HolafToastController;
  error(
    message: string | number,
    options?: HolafToastOptions,
    callOptions?: HolafToastCallOptions
  ): HolafToastController;
  warning(
    message: string | number,
    options?: HolafToastOptions,
    callOptions?: HolafToastCallOptions
  ): HolafToastController;
  info(
    message: string | number,
    options?: HolafToastOptions,
    callOptions?: HolafToastCallOptions
  ): HolafToastController;
  update(
    idOrCtrl: string | HolafToastController,
    options?: HolafToastPatch
  ): HolafToastController | null;
  hide(idOrCtrl: string | HolafToastController): boolean;
  setTheme(spec: HolafThemeSpec | null): void;
  clearTheme(): void;
  /** Nonce CSP global (v0.5.1) ; `null` le réinitialise. */
  setStyleNonce(nonce: string | null): void;
  /** CSS complet de la brique (v0.5.2) — pour le mode CSS externe. */
  getCss(): string;
  configure(options: HolafToastConfigureOptions): void;
  themes: {
    register(name: string, vars: HolafThemeVars): HolafThemeVars | null;
    get(name: string): HolafThemeVars | null;
    list(): string[];
    update(name: string, vars: HolafThemeVars): HolafThemeVars | null;
  };
}

export const HolafToast: HolafToastApi;

declare global {
  interface Window {
    /** La brique s'expose elle-même sur window au chargement (dual ESM + global). */
    HolafToast?: HolafToastApi;
  }
}
