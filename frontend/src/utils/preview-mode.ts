// ── Mode d'ouverture des previews et des images (persisté + live) ─────────
// Centralise une préférence utilisateur unique, partagée entre :
//   - la toolbar de la fenêtre de preview (bouton 🪟),
//   - le réglage « Images et previews » des paramètres (SettingsModal),
//   - App.tsx (routage de l'ouverture).
//
// Modes :
//   - 'internal' : previews web dans la fenêtre flottante interne, images dans
//     la visionneuse modale (HolafViewport).
//   - 'popup'    : previews web dans une popup navigateur UNIQUE réutilisée
//     (« pi-web-preview »), images dans une popup PAR image
//     (« pi-web-img-<hash-court> ») — la même image réutilise sa fenêtre.
//
// Source de vérité : localStorage (clé pi-web.preview-mode). Chaque changement
// est diffusé via un CustomEvent synchrone « pi-web-preview-mode » pour propager
// le réglage en LIVE (sans reload) à tous les composants abonnés.

export type PreviewMode = "internal" | "popup";

const STORAGE_KEY = "pi-web.preview-mode";
const EVENT_NAME = "pi-web-preview-mode";

// Lit le mode courant (défaut : interne).
export function getPreviewMode(): PreviewMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === "popup" ? "popup" : "internal";
  } catch {
    return "internal";
  }
}

// Écrit le mode et notifie tous les abonnés. Le stockage peut échouer (mode
// privé / quota) : on émet quand même l'évènement pour garder l'UI cohérente.
export function setPreviewMode(mode: PreviewMode): void {
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent<PreviewMode>(EVENT_NAME, { detail: mode }));
}

// S'abonne aux changements de mode. Retourne la fonction de désabonnement.
export function onPreviewModeChange(cb: (mode: PreviewMode) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<PreviewMode>).detail;
    cb(detail === "popup" || detail === "internal" ? detail : getPreviewMode());
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}

// ── Popups d'images ──────────────────────────────────────────────────────
// hashCourt : FNV-1a 32 bits (base36) — stable pour une même source, court,
// sans dépendance. Sert à nommer la fenêtre de popup d'une image.
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Nom de fenêtre d'une popup image : la même image ré-cliquée réutilise sa
// fenêtre, deux images différentes ouvrent deux popups distinctes.
export function imagePopupName(src: string): string {
  return `pi-web-img-${shortHash(src)}`;
}

// Cache des blob URL construites depuis les data: URL (légué base64). Évite de
// recréer une URL à chaque clic (stabilité du nom de fenêtre + pas de fuite).
const blobUrlCache = new Map<string, string>();

// Convertit une data: URL en blob URL, de façon SYNCHRONE (atob + Blob).
// Synchrone = on reste dans le geste utilisateur du clic, ce qui évite le
// blocage par le popup blocker du navigateur. Retourne null si non convertible.
function dataUrlToBlobUrl(dataUrl: string): string | null {
  try {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return null;
    // En-tête : data:[<mime>][;base64]
    const meta = dataUrl.slice(5, comma);
    const isBase64 = /;base64$/i.test(meta);
    const mime = meta.replace(/;base64$/i, "") || "application/octet-stream";
    const payload = dataUrl.slice(comma + 1);
    let blob: Blob;
    if (isBase64) {
      const bin = atob(payload);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      blob = new Blob([bytes], { type: mime });
    } else {
      blob = new Blob([decodeURIComponent(payload)], { type: mime });
    }
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

// Ouvre une image dans sa popup dédiée (mode popup). Retourne true si la popup
// a été ouverte, false si la source n'est pas navigable → l'appelant garde le
// viewer modal interne comme repli (repli documenté).
//
// Couvert : chemins/URLs HTTP(S) relatifs ou absolus (/api/files/read,
// /api/attachments/<id>/file) et data: URL (converties en blob URL synchrone).
// Non couvert : autres schémas (ex. custom protocol) → repli modal.
export function openImagePopup(src: string): boolean {
  if (!src) return false;
  const winName = imagePopupName(src);

  // 1) URL navigable directement (même origine ou absolue).
  if (/^(https?:|blob:)/i.test(src) || src.startsWith("/")) {
    window.open(src, winName);
    return true;
  }

  // 2) data: URL → blob URL (mise en cache pour stabiliser le nom).
  if (/^data:/i.test(src)) {
    let blobUrl = blobUrlCache.get(src);
    if (!blobUrl) {
      const built = dataUrlToBlobUrl(src);
      if (!built) return false;
      blobUrl = built;
      blobUrlCache.set(src, blobUrl);
    }
    window.open(blobUrl, winName);
    return true;
  }

  // 3) Source non navigable : on laisse l'appelant retomber sur la modale.
  return false;
}
