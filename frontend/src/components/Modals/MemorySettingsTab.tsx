/**
 * MemorySettingsTab (Lot M3) — onglet « Mémoire » des Settings.
 *
 * Deux sections indépendantes :
 *   - « Mémoire globale »  → store ~/.unipi/memory/_global_/ (profil utilisateur)
 *   - « Mémoire du projet »→ store du projet ACTIF (~/.unipi/memory/<projet>/),
 *     résolu côté backend via ?projectId=<id> (le backend connaît le cwd).
 *
 * Chaque section liste les mémoires (titre, badge de type, extrait, date),
 * avec ajout / édition inline / suppression (confirmation inline en deux temps).
 * Toutes les libellés passent par i18n (namespace memory.*) — aucune chaîne
 * codée en dur.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "../../i18n";

// ── Types ──────────────────────────────────────────────

type MemoryType = "preference" | "decision" | "pattern" | "summary";
type MemoryScope = "global" | "project";
type WritableMemoryType = Exclude<MemoryType, "summary">;

/** Entrée mémoire renvoyée par GET /api/memory/:scope. */
interface MemoryEntry {
  id: string;
  title: string;
  content: string;
  tags: string[];
  type: MemoryType;
  created: string;
  updated: string;
}

/** État du formulaire d'édition inline (une section à la fois). */
interface EditForm {
  /** Id d'origine si édition d'une entrée existante, sinon création. */
  originalId: string | null;
  originalTitle: string;
  title: string;
  content: string;
  type: WritableMemoryType;
  tagsText: string;
}

interface Props {
  activeProjectId?: string;
}

// ── Helpers ────────────────────────────────────────────

/**
 * Slug d'id : réplique fidèle du memory-service. Le backend normalise le
 * titre AVANT le slug (whitespace aplati, trim, max 120 chars) — cette
 * normalisation doit être reproduite ici sans quoi la comparaison
 * ancien/nouveau slug lors d'un renommage pourrait diverger.
 */
function slugifyTitle(title: string): string {
  return (title.replace(/\s+/g, " ").trim().slice(0, 120))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
}

/** Extrait compact d'un contenu pour l'affichage dans la liste. */
function excerpt(content: string, max = 160): string {
  const flat = (content || "").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max) + " […]";
}

/**
 * Garde locale sur la longueur du contenu : la route backend rejette tout
 * contenu > MAX_CONTENT_BYTES (15 * 1024 = 15360 octets). La limite HTML
 * maxLength compte des caractères JS alors qu'un glyphe UTF-8 peut coûter
 * jusqu'à 4 octets → marge sûre à 5000 chars pour rester sous le plafond.
 */
const MAX_CONTENT_CHARS = 5000;

// Couleur de badge par type (thème hacker existant).
const TYPE_BADGE_CLASS: Record<WritableMemoryType, string> = {
  preference: "text-hacker-accent border-hacker-accent/40",
  decision: "text-green-400 border-green-400/40",
  pattern: "text-hacker-warn border-hacker-warn/40",
};

// ── Section mémoire (factorisation global/projet) ──────

function MemorySection({ scope, projectId }: { scope: MemoryScope; projectId?: string }) {
  const { t } = useTranslation();

  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  // Feedback temporaire (succès sauvegarde/suppression), auto-effacé.
  const [feedback, setFeedback] = useState("");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);
  // Id de l'entrée en attente de confirmation de suppression (2e clic = confirme).
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  // Timer du feedback : nettoyé au démontage / avant réarmement.
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showFeedback = useCallback((msg: string) => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    setFeedback(msg);
    feedbackTimer.current = setTimeout(() => setFeedback(""), 2500);
  }, []);

  useEffect(() => () => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
  }, []);

  // URL de base de la section (query projectId pour le scope projet).
  const scopeUrl = scope === "project" && projectId ? `/api/memory/project?projectId=${encodeURIComponent(projectId)}` : `/api/memory/${scope}`;

  // URL de suppression d'une entrée (le scope projet requiert projectId en query).
  const entryUrl = (id: string) =>
    scope === "project" && projectId
      ? `/api/memory/project/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}`
      : `/api/memory/${scope}/${encodeURIComponent(id)}`;

  // Compteur de génération : chaque appel incrémente ; une réponse (ou une
  // erreur) dont la séquence n'est plus la dernière est obsolète et doit
  // être ignorée (course entre rechargements concurrents).
  const loadSeq = useRef(0);

  const loadEntries = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch(scopeUrl);
      if (seq !== loadSeq.current) return; // réponse obsolète → ignorée
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (seq !== loadSeq.current) return; // réponse obsolète → ignorée
      setEntries(Array.isArray(data.memories) ? data.memories : []);
    } catch (e: any) {
      if (seq !== loadSeq.current) return; // erreur obsolète → ignorée
      // Message BRUT stocké : le libellé traduit est composé à l'affichage,
      // sans quoi un fallback t("memory.loadError") doublerait le libellé.
      setLoadError(typeof e?.message === "string" ? e.message : "");
    } finally {
      // Un chargement plus récent est en cours : ne pas écraser son état.
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [scopeUrl]);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  const startCreate = () => {
    setActionError("");
    setConfirmingDelete(null);
    setForm({ originalId: null, originalTitle: "", title: "", content: "", type: "pattern", tagsText: "" });
  };

  const startEdit = (entry: MemoryEntry) => {
    // Les summaries ne sont jamais listés (includeSummaries:false) — garde défensive.
    if (entry.type === "summary") return;
    setActionError("");
    setConfirmingDelete(null);
    setForm({
      originalId: entry.id,
      originalTitle: entry.title,
      title: entry.title,
      content: entry.content,
      type: entry.type as WritableMemoryType,
      tagsText: entry.tags.join(", "),
    });
  };

  /**
   * Sauvegarde (création ou mise à jour via PUT upsert par slug de titre).
   * Cas particulier du RENOMMAGE : le slug changeant, l'upsert créerait un
   * doublon. Ordre volontaire : upsert du NOUVEAU titre D'ABORD, puis
   * suppression de l'ANCIENNE entrée — l'ordre inverse (DELETE puis PUT)
   * ouvrirait une fenêtre de perte de données si le PUT échouait après le
   * DELETE réussi. Un échec de la purge finale laisse un doublon
   * récupérable : erreur non bloquante, aucune donnée perdue.
   */
  const handleSave = async () => {
    if (!form || saving) return;
    const title = form.title.trim();
    const content = form.content;
    if (!title) { setActionError(t("memory.errTitleRequired")); return; }
    if (!content.trim()) { setActionError(t("memory.errContentRequired")); return; }

    // Tags : champ texte séparé par virgules → tableau propre ET dédupliqué
    // (Set) : des tags identiques créeraient des clés React dupliquées.
    const tags = Array.from(new Set(
      form.tagsText.split(",").map((s) => s.trim()).filter(Boolean)
    ));

    setSaving(true);
    setActionError("");
    try {
      const res = await fetch(scopeUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content, type: form.type, tags }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || t("memory.errSave"));
      }

      // Renommage effectif → purge de l'ancienne entrée APRÈS l'upsert
      // réussi (404 tolérée : déjà supprimée ou jamais existée).
      let renameCleanupFailed = false;
      if (form.originalId && slugifyTitle(form.originalTitle) !== slugifyTitle(title)) {
        const delRes = await fetch(entryUrl(form.originalId), { method: "DELETE" });
        if (!delRes.ok && delRes.status !== 404) {
          renameCleanupFailed = true;
        }
      }

      setForm(null);
      if (renameCleanupFailed) {
        // Non bloquant : la nouvelle entrée est enregistrée ; l'ancienne
        // subsiste en doublon (supprimable manuellement) — rien n'est perdu.
        setActionError(t("memory.warnRenameDuplicate"));
      } else {
        showFeedback(t("memory.feedbackSaved"));
      }
      await loadEntries();
    } catch (e: any) {
      setActionError(e.message || t("memory.errSave"));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (entry: MemoryEntry) => {
    // Confirmation inline en deux temps : premier clic → demande, second → exécute.
    if (confirmingDelete !== entry.id) {
      setConfirmingDelete(entry.id);
      return;
    }
    setConfirmingDelete(null);
    setActionError("");
    try {
      const res = await fetch(entryUrl(entry.id), { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        // Checkpoint de compaction → message localisé dédié.
        throw new Error(res.status === 403 ? t("memory.errSummaryProtected") : (d.error || t("memory.errDelete")));
      }
      showFeedback(t("memory.feedbackDeleted"));
      await loadEntries();
    } catch (e: any) {
      setActionError(e.message || t("memory.errDelete"));
    }
  };

  const typeLabel = (type: MemoryType): string =>
    type === "preference" ? t("memory.typePreference")
      : type === "decision" ? t("memory.typeDecision")
      : t("memory.typePattern");

  return (
    <div className="border border-hacker-border bg-hacker-surface/50">
      {/* En-tête de section */}
      <div className="px-3 py-2 border-b border-hacker-border bg-hacker-bg/50 flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-bold text-hacker-accent tracking-wider">
            🧠 {scope === "global" ? t("memory.globalSectionTitle") : t("memory.projectSectionTitle")}
          </div>
          <div className="text-[10px] text-hacker-text-dim mt-0.5">
            {scope === "global" ? t("memory.globalSectionDesc") : t("memory.projectSectionDesc")}
          </div>
        </div>
        <button
          onClick={startCreate}
          disabled={!!form}
          className="btn-hacker text-xs px-3 py-1.5 flex items-center gap-1 shrink-0 disabled:opacity-30"
        >
          <Plus size={12} /> {t("memory.add")}
        </button>
      </div>

      <div className="p-3 space-y-3">
        {/* Feedback succès temporaire */}
        {feedback && (
          <div className="px-3 py-1.5 text-hacker-accent text-xs border border-hacker-accent/30 bg-hacker-accent/5">
            {feedback}
          </div>
        )}

        {/* Erreur d'action (save/delete), affichée et fermable */}
        {actionError && (
          <div className="text-hacker-error text-[11px] border border-hacker-error/30 p-2">
            {actionError}
            <button onClick={() => setActionError("")} className="ml-2 text-hacker-text-dim hover:text-hacker-error">✕</button>
          </div>
        )}

        {/* Formulaire d'édition inline */}
        {form && (
          <div className="border border-hacker-accent/30 bg-hacker-bg/40 p-3 space-y-2 rounded">
            <div className="text-xs font-bold text-hacker-accent tracking-wider mb-1">
              {form.originalId ? t("memory.formEditTitle") : t("memory.formNewTitle")}
            </div>

            <div>
              <label className="text-hacker-text-dim text-xs block mb-1">{t("memory.titleLabel")}</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder={t("memory.placeholderTitle")}
                className="input-hacker w-full text-xs py-1.5 px-2"
              />
            </div>

            <div>
              <label className="text-hacker-text-dim text-xs block mb-1">{t("memory.contentLabel")}</label>
              <textarea
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                placeholder={t("memory.placeholderContent")}
                rows={5}
                maxLength={MAX_CONTENT_CHARS}
                className="input-hacker w-full text-xs py-1.5 px-2 resize-y font-mono"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-hacker-text-dim text-xs block mb-1">{t("memory.typeLabel")}</label>
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value as WritableMemoryType })}
                  className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-3 py-1.5 rounded focus:border-hacker-accent outline-none"
                >
                  <option value="preference">{t("memory.typePreference")}</option>
                  <option value="decision">{t("memory.typeDecision")}</option>
                  <option value="pattern">{t("memory.typePattern")}</option>
                </select>
              </div>
              <div>
                <label className="text-hacker-text-dim text-xs block mb-1">
                  {t("memory.tagsLabel")} <span className="text-[10px] opacity-70">({t("memory.tagsHint")})</span>
                </label>
                <input
                  type="text"
                  value={form.tagsText}
                  onChange={(e) => setForm({ ...form, tagsText: e.target.value })}
                  placeholder={t("memory.placeholderTags")}
                  className="input-hacker w-full text-xs py-1.5 px-2"
                />
              </div>
            </div>

            <div className="flex gap-2 pt-1">
              <button onClick={handleSave} disabled={saving} className="btn-hacker text-xs px-4 py-1.5 disabled:opacity-30">
                {saving ? t("memory.saving") : t("memory.save")}
              </button>
              <button
                onClick={() => { setForm(null); setActionError(""); }}
                disabled={saving}
                className="btn-hacker text-xs px-4 py-1.5 disabled:opacity-30"
              >
                {t("memory.cancel")}
              </button>
            </div>
          </div>
        )}

        {/* Contenu de la liste */}
        {loading ? (
          <div className="text-xs text-hacker-text-dim py-2">{t("memory.loading")}</div>
        ) : loadError ? (
          <div className="text-xs text-hacker-error py-2">
            {/* Détail brut optionnel : évite de doubler le libellé traduit si
                loadError ne contient que le message du fallback. */}
            {t("memory.loadError")}{loadError ? ` — ${loadError}` : ""}
            <button onClick={loadEntries} className="ml-2 underline hover:text-hacker-accent">↻</button>
          </div>
        ) : entries.length === 0 ? (
          !form && (
            <div className="text-hacker-text-dim text-xs italic py-4 text-center border border-hacker-border border-dashed">
              {t("memory.empty")}
            </div>
          )
        ) : (
          <>
            <div className="text-[10px] text-hacker-text-dim">{t("memory.entriesCount", entries.length)}</div>
            <div className="space-y-1.5">
              {entries.map((entry) => (
                <div key={entry.id} className="border border-hacker-border bg-hacker-bg/30 px-3 py-2 group">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      {/* Badge de type */}
                      <span className={`shrink-0 text-[10px] uppercase tracking-wide border px-1.5 py-0.5 rounded ${TYPE_BADGE_CLASS[entry.type as WritableMemoryType] ?? "text-hacker-text-dim border-hacker-border"}`}>
                        {typeLabel(entry.type)}
                      </span>
                      <span className="text-xs font-bold text-hacker-text-bright truncate">{entry.title}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => startEdit(entry)}
                        className="text-hacker-text-dim hover:text-hacker-accent"
                        title={t("memory.edit")}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={() => handleDelete(entry)}
                        className={`text-xs ${confirmingDelete === entry.id ? "text-hacker-error font-bold animate-pulse" : "text-hacker-text-dim hover:text-hacker-error"}`}
                        title={t("memory.delete")}
                      >
                        {confirmingDelete === entry.id ? "?" : <Trash2 size={13} />}
                      </button>
                    </div>
                  </div>

                  {/* Confirmation inline de suppression */}
                  {confirmingDelete === entry.id ? (
                    <div className="flex items-center gap-2 text-[11px] py-1">
                      <span className="text-hacker-error">{t("memory.confirmDelete", entry.title)}</span>
                      <button onClick={() => handleDelete(entry)} className="btn-hacker text-[10px] px-2 py-0.5 !border-hacker-error/50 !text-hacker-error">
                        {t("memory.confirmYes")}
                      </button>
                      <button onClick={() => setConfirmingDelete(null)} className="btn-hacker text-[10px] px-2 py-0.5">
                        {t("memory.cancel")}
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="text-[11px] text-hacker-text-dim leading-snug">{excerpt(entry.content)}</div>
                      {(entry.tags.length > 0 || entry.updated) && (
                        <div className="flex flex-wrap items-center gap-x-2 mt-1 text-[10px] text-hacker-text-dim/70">
                          {/* Key par index : les données stockées peuvent
                              contenir des tags dupliqués (héritage). */}
                          {entry.tags.map((tag, tagIdx) => (
                            <span key={tagIdx} className="border border-hacker-border px-1 rounded">#{tag}</span>
                          ))}
                          {entry.updated && !isNaN(new Date(entry.updated).getTime()) && (
                            <span>{t("memory.updatedLabel")} : {new Date(entry.updated).toLocaleString()}</span>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Onglet principal ───────────────────────────────────

export function MemorySettingsTab({ activeProjectId }: Props) {
  const { t } = useTranslation();

  return (
    <div className="p-3 space-y-4">
      {/* Mémoire globale — profil utilisateur transverse */}
      <MemorySection scope="global" />

      {/* Mémoire du projet actif — indisponible sans projet sélectionné */}
      {activeProjectId ? (
        <MemorySection scope="project" projectId={activeProjectId} />
      ) : (
        <div className="border border-hacker-border bg-hacker-surface/50 p-3">
          <div className="text-xs font-bold text-hacker-accent tracking-wider mb-1">
            🧠 {t("memory.projectSectionTitle")}
          </div>
          <div className="text-[11px] text-hacker-text-dim italic">{t("memory.noActiveProject")}</div>
        </div>
      )}
    </div>
  );
}
