// ── Rendu markdown partagé (chat + explorateur de fichiers) ────────────────
// Centralise la bibliothèque (react-markdown + remark-gfm), la coloration des
// blocs de code (react-syntax-highlighter, Prism + thème adaptatif) et la
// politique de chargement des images. Un seul composant <MarkdownContent> est
// consommé par ChatView et FileExplorer pour garantir un rendu identique.
//
// Coloration : le thème importé est la variante **prism** (`oneDark`/`oneLight`)
// — et non la variante hljs (`atomOneDark`) : le composant rendu est `Prism`,
// dont les classes de jetons (`token keyword`…) ne se résolvent QUE contre un
// style prism. L'ancien import hljs laissait le fond sombre mais aucune
// coloration de jetons. Le thème suit le mode clair/sombre de l'application
// (cf. useMarkdownTheme), en direct.

import {
  createContext,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Copy, ImageOff } from "lucide-react";
import { useTranslation } from "../../i18n";
import { copyToClipboard } from "../../utils/clipboard";

// ── Contexte de streaming ──────────────────────────────────────────────────
// `true` tant que le message assistant est en cours de génération. Les blocs
// de code ne sont alors PAS colorés : on évite de relancer la tokenisation d'un
// code incomplet à chaque rafraîchissement (~45 ms). Ils sont colorés une fois
// le message terminé (voir MarkdownCodeBlock).
const MarkdownStreamingContext = createContext(false);

// ── Thème d'application (clair / sombre) ───────────────────────────────────
// Pi-Web pilote son thème via la classe `light`/`dark` posée sur <html>
// (App.tsx, effet sur l'état `theme`). Le module markdown étant partagé par le
// chat et l'explorateur — qui ne reçoivent PAS le thème en props — on observe
// directement cette classe : la coloration suit les bascules EN DIRECT, sans
// prop drilling. Repli sur localStorage (préférence persistée) tant que le DOM
// n'est pas encore marqué (premier rendu).
export type MarkdownTheme = "dark" | "light";

/** Lit le thème courant depuis la classe de <html>, avec repli localStorage. */
export function readThemeMode(): MarkdownTheme {
  if (typeof document !== "undefined") {
    const classes = document.documentElement.classList;
    if (classes.contains("light")) return "light";
    if (classes.contains("dark")) return "dark";
  }
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("pi-web-theme") === "light") {
      return "light";
    }
  } catch { /* stockage indisponible (mode privé) → défaut sombre */ }
  return "dark";
}

/**
 * Renvoie le thème applicatif et se met à jour à chaque bascule en observant
 * l'attribut `class` de <html> (MutationObserver). Réactif même si le thème
 * change après le montage du bloc de code.
 */
export function useMarkdownTheme(): MarkdownTheme {
  const [theme, setTheme] = useState<MarkdownTheme>(readThemeMode);
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setTheme(readThemeMode());
    sync(); // resynchronise si le thème a changé entre l'init et cet effet
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

// ── Utilitaires ────────────────────────────────────────────────────────────

/** Concatène le texte brut d'un arbre de nœuds React (contenu d'un <code>). */
export function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) {
    return extractText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

// Extrait le langage d'un className `language-xxx` (posé par remark/react-markdown).
function languageFromClassName(className?: string): string | undefined {
  return /language-([\w-]+)/.exec(className || "")?.[1];
}

/**
 * Une image est « externe » si son URL pointe vers un hôte différent de celui
 * de l'application. Servies par Pi-Web : chemins relatifs (`/api/...`, pièces
 * jointes, `./`, `../`) et schémas embarqués (`data:`, `blob:`). Toute URL
 * absolue http(s) (ou protocole-relatif `//hôte/...`) dont l'hôte diffère est
 * externe → chargement différé (anti-fuite d'IP / pixel de suivi).
 */
export function isExternalImageSrc(src?: string): boolean {
  const value = (src || "").trim();
  if (!value) return false;
  // Schémas embarqués : jamais de requête réseau.
  if (/^(data|blob):/i.test(value)) return false;
  // Protocole-relatif `//hôte/...` : on compare l'hôte.
  if (value.startsWith("//")) {
    if (typeof window === "undefined") return false;
    try {
      return new URL(`http:${value}`).host !== window.location.host;
    } catch {
      return true;
    }
  }
  // Chemins relatifs / locaux servis par l'application.
  if (/^(\/|\.\/|\.\.\/|#)/.test(value)) return false;
  if (typeof window === "undefined") return false;
  try {
    const url = new URL(value, window.location.origin);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.host !== window.location.host;
    }
    // Autre protocole absolu (file:, ftp:…) : traité comme externe par sûreté.
    return true;
  } catch {
    return false;
  }
}

// ── Bloc de code markdown ──────────────────────────────────────────────────
// Remplace le <pre> par défaut de react-markdown (fenced ``` → <pre><code>).
// - Le code INLINE (une seule ligne dans une phrase) n'est pas concerné : il
//   n'est pas encapsulé dans <pre> et garde le rendu <code> par défaut.
// - Coloration via SyntaxHighlighter (PreTag="div" → aucun <pre> imbriqué).
// - Coloration UNIQUEMENT hors streaming (cf. MarkdownStreamingContext).
// - Conserve le bouton « copier » (texte pur, overlay au survol) et ajoute un
//   badge discret du langage détecté.
const MarkdownCodeBlock = memo(function MarkdownCodeBlock({
  node: _node, // hast node passé par react-markdown — ignoré, ne doit pas fuir vers le DOM
  children,
  ...rest
}: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  const { t } = useTranslation();
  const streaming = useContext(MarkdownStreamingContext);
  // Thème adaptatif : oneLight en mode clair, oneDark sinon (réactif).
  const theme = useMarkdownTheme();
  const [copied, setCopied] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Nettoyage du timer de feedback si le bloc est démonté.
  useEffect(() => () => { if (resetTimerRef.current) clearTimeout(resetTimerRef.current); }, []);

  const className = isValidElement(children)
    ? (children.props as { className?: string }).className
    : undefined;
  const language = languageFromClassName(className);
  const raw = extractText(children).replace(/\n$/, "");
  // Pendant le streaming on ne colore pas (code incomplet, re-parse fréquent).
  const highlight = !streaming && !!language;

  const handleCopy = useCallback(async () => {
    const text = contentRef.current?.textContent ?? "";
    if (!text) return;
    const ok = await copyToClipboard(text);
    if (!ok) return;
    setCopied(true);
    // Feedback « Copié ✓ » pendant 2s puis retour à l'icône copier.
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setCopied(false), 2000);
  }, []);

  return (
    <div className="relative group/code">
      {/* Contenu copié : textContent du seul code (le bouton/badge sont hors de
          ce conteneur pour ne pas polluer le presse-papier). */}
      <div ref={contentRef}>
        {highlight ? (
          <SyntaxHighlighter
            language={language}
            style={theme === "light" ? oneLight : oneDark}
            PreTag="div"
            className="markdown-code-highlight !text-xs !my-2"
            customStyle={{ borderRadius: "4px" }}
          >
            {raw}
          </SyntaxHighlighter>
        ) : (
          <pre {...rest}>{children}</pre>
        )}
      </div>
      <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1">
        {language ? (
          <span className="rounded bg-hacker-surface/80 px-1 py-0.5 text-[10px] leading-none font-mono text-hacker-text-dim select-none">
            {language}
          </span>
        ) : null}
        <button
          type="button"
          onClick={handleCopy}
          title={copied ? t('chat.copied') : t('chat.copyCode')}
          aria-label={copied ? t('chat.copied') : t('chat.copyCode')}
          className="flex items-center justify-center rounded border border-hacker-border bg-hacker-bg/80 px-1.5 py-1 text-hacker-text-dim hover:text-hacker-accent opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100 transition-opacity duration-150 cursor-pointer"
        >
          {copied ? <span className="text-[10px] leading-none font-mono">{t('chat.copied')}</span> : <Copy size={12} />}
        </button>
      </div>
    </div>
  );
});

// ── Image markdown ─────────────────────────────────────────────────────────
// Les images dont l'hôte diffère de celui de l'application ne sont PAS chargées
// automatiquement : un substitut cliquable (« cliquer pour charger ») évite la
// fuite d'IP / le pixel de suivi. Au clic, l'image réelle est affichée ; en cas
// d'échec, on retombe sur un lien cliquable. Les images servies par Pi-Web
// (pièces jointes `/api/...`) ou locales (data:/blob:/relatif) restent directes.
const MarkdownImage = memo(function MarkdownImage({
  node: _node,
  src,
  alt,
  ...rest
}: ComponentPropsWithoutRef<"img"> & ExtraProps) {
  const { t } = useTranslation();
  const external = isExternalImageSrc(typeof src === "string" ? src : undefined);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  // Image locale / servie par l'application : rendu direct, inchangé.
  if (!external) {
    return <img src={src} alt={alt} {...rest} />;
  }

  // Après clic : image réelle, avec repli « lien » si le chargement échoue.
  if (loaded) {
    if (failed) {
      return (
        <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noreferrer noopener" title={t('markdown.imageLoadFailed')}>
          <span className="inline-flex items-center gap-1 text-xs text-hacker-text-dim underline">
            <ImageOff size={12} /> {alt || t('markdown.imageLoadFailed')}
          </span>
        </a>
      );
    }
    return <img src={src} alt={alt} onError={() => setFailed(true)} {...rest} />;
  }

  // Avant clic : aucun élément <img> → aucune requête réseau déclenchée.
  return (
    <button
      type="button"
      onClick={() => setLoaded(true)}
      title={alt ? `${t('markdown.loadExternalImage')} — ${alt}` : t('markdown.loadExternalImage')}
      className="inline-flex items-center gap-1.5 rounded border border-hacker-border bg-hacker-bg/60 px-2 py-1 text-xs text-hacker-text-dim hover:text-hacker-accent hover:border-hacker-accent/60 transition-colors cursor-pointer"
    >
      <ImageOff size={12} />
      <span>{t('markdown.loadExternalImage')}</span>
      {alt ? <span className="opacity-60">({alt})</span> : null}
    </button>
  );
});

// ── Composants markdown exposés (identité stable → memoïsation efficace) ────
export const markdownComponents = {
  pre: MarkdownCodeBlock,
  img: MarkdownImage,
};

// ── Composant de rendu principal ───────────────────────────────────────────
export const MarkdownContent = memo(function MarkdownContent({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}) {
  return (
    <MarkdownStreamingContext.Provider value={streaming}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </MarkdownStreamingContext.Provider>
  );
});

// Réexports utiles (tests / consommateurs avancés).
export { MarkdownCodeBlock, MarkdownImage };
