// ── i18n — Internationalization ───────────────────────
// Zero-dependency React Context for translations.
// Supports: fr, en (fallback)
// Detection: navigator.language → two-letter code → localStorage override

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { fr } from "./fr";
import { en } from "./en";

// ── Types ──────────────────────────────────────────────

export type Language = "fr" | "en";

type TranslationValue = string | ((...args: any[]) => string) | Record<string, any>;
type TranslationTree = Record<string, TranslationValue>;

const TRANSLATIONS: Record<Language, TranslationTree> = { fr, en };

// ── Language detection ─────────────────────────────────

const STORAGE_KEY = "pi-web-language";

function detectLanguage(): Language {
  // 1. Check localStorage override
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "fr" || stored === "en") return stored;

  // 2. Check system language
  try {
    const lang = navigator.language?.slice(0, 2);
    if (lang === "fr") return "fr";
  } catch {}

  // 3. Fallback
  return "en";
}

// ── Translation function ───────────────────────────────

function resolvePath(obj: any, path: string): any {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

export type TFunction = {
  (key: string): string;
  (key: string, ...args: any[]): string;
};

function createT(lang: Language): TFunction {
  const translations = TRANSLATIONS[lang] || TRANSLATIONS.en;

  const t = (key: string, ...args: any[]): string => {
    const value = resolvePath(translations, key);
    if (value === undefined) {
      // Try fallback
      const fallback = resolvePath(TRANSLATIONS.en, key);
      if (fallback === undefined) {
      if (typeof window !== 'undefined' && (window as any).__DEV__) {
          console.warn(`[i18n] Missing translation key: "${key}" for lang "${lang}"`);
        }
        return key;
      }
      return typeof fallback === "function" ? fallback(...args) : fallback;
    }
    if (typeof value === "function") return value(...args);
    if (typeof value === "string") return value;
    return key;
  };

  return t;
}

// ── Context ────────────────────────────────────────────

interface I18nContextValue {
  lang: Language;
  t: TFunction;
  setLang: (lang: Language) => void;
  supportedLanguages: Language[];
}

const I18nContext = createContext<I18nContextValue | null>(null);

// ── Provider ───────────────────────────────────────────

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(detectLanguage);

  const setLang = useCallback((newLang: Language) => {
    setLangState(newLang);
    localStorage.setItem(STORAGE_KEY, newLang);
    // Update <html> lang attribute
    document.documentElement.lang = newLang;
  }, []);

  const t = createT(lang);

  // Set initial lang attribute
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const value: I18nContextValue = {
    lang,
    t,
    setLang,
    supportedLanguages: ["fr", "en"],
  };

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
}

// ── Hook ───────────────────────────────────────────────

export function useTranslation(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useTranslation() must be used inside <I18nProvider>");
  }
  return ctx;
}

// ── Direct t() for non-React usage ────────────────────

export function getT(lang?: Language): TFunction {
  return createT(lang || detectLanguage());
}
