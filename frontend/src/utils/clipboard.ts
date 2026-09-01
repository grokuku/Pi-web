// ── Presse-papier — copie robuste ───────────────────────────────────────────
// Extrait de SettingsModal.tsx pour être réutilisable partout (chat, viewer…).

/**
 * Copie robuste vers le presse-papier. navigator.clipboard n'existe qu'en
 * contexte sécurisé (https ou localhost) : l'accès LAN en http://10.10.0.5:…
 * n'en a pas, on retombe sur execCommand via un textarea éphémère.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fallback ci-dessous */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}