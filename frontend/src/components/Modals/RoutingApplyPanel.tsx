/**
 * RoutingApplyPanel — « Appliquer ce routage à d'autres projets ».
 *
 * Le routage de Pi-Web est stocké PAR PROJET (`projectModes[<id>].harness.routing`,
 * `.data/model-library.json`) : un projet « lié » (placeholder `storage ===
 * "linked"`) a son propre routage, et chacun de ses sous-projets a le sien —
 * rien n'est hérité. Ce panneau est donc le seul moyen de propager une config
 * « d'un coup », et il est conçu pour une action qui ÉCRASE :
 *
 *  1. PORTÉE EXPLICITE (aucune portée silencieuse) : tous / tous sauf le
 *     courant / le courant + ses sous-projets liés / une sélection cochable ;
 *  2. PRÉVISUALISATION chiffrée, calculée par le BACKEND en `dryRun` (donc
 *     exactement le même calcul que l'application réelle) : projets qui vont
 *     changer, projets inchangés, projets écartés ;
 *  3. AVERTISSEMENT des `modelId` absents de la bibliothèque (la config est
 *     copiée telle quelle et retombe sur le modèle par défaut — on ne casse
 *     rien, mais on le dit) ;
 *  4. CONFIRMATION obligatoire (case à cocher) avant le bouton d'écriture ;
 *  5. message honnête après coup (« N projets mis à jour ») + rafraîchissement.
 *
 * Aucun accès LLM, aucun réseau hors la route dédiée
 * POST /api/model-library/routing/apply.
 */

import { useEffect, useMemo, useState } from "react";
import { HolafIcon } from "../icons/HolafIcon";
import { useTranslation } from "../../i18n";
import { toast } from "../../utils/holaf-toast";
import {
  apiErrorLabels,
  applyRoutingCopy,
  previewRoutingCopy,
  type RoutingCopyPlan,
  type RoutingCopyScope,
  type RoutingCopyWarning,
} from "../../utils/model-library-api";
import type { RoutingConfig } from "../../types";

interface Props {
  /** Projet dont le routage sert de source (toujours défini ici). */
  projectId: string;
  /** Config affichée dans la modale (état courant, pas forcément enregistré). */
  routing: RoutingConfig;
  /** Ferme le panneau (retour à la configuration). */
  onClose: () => void;
  /** Rafraîchissement de l'état côté parent (bibliothèque / routage courant). */
  onApplied?: () => void | Promise<void>;
}

const SCOPES: { id: RoutingCopyScope; labelKey: string }[] = [
  { id: "all-except-current", labelKey: "routingModal.apply.scopeAllExceptCurrent" },
  { id: "all", labelKey: "routingModal.apply.scopeAll" },
  { id: "linked-subprojects", labelKey: "routingModal.apply.scopeLinked" },
  { id: "selected", labelKey: "routingModal.apply.scopeSelected" },
];

export function RoutingApplyPanel({ projectId, routing, onClose, onApplied }: Props) {
  const { t } = useTranslation();
  // Défaut volontairement le plus PRUDENT (tous sauf le courant) : la portée la
  // plus large n'est jamais présélectionnée.
  const [scope, setScope] = useState<RoutingCopyScope>("all-except-current");
  const [selected, setSelected] = useState<string[]>([]);
  const [plan, setPlan] = useState<RoutingCopyPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ count: number; warnings: RoutingCopyWarning[] } | null>(null);

  const selectedKey = selected.join("|");
  // Seuls les IDS DE MODÈLES influencent les avertissements : les seuils et les
  // niveaux de réflexion ne doivent pas relancer une prévisualisation.
  const modelKey = useMemo(
    () =>
      JSON.stringify([
        routing.trivial.modelId,
        routing.standard.modelId,
        routing.complex.modelId,
        routing.review.modelId,
        routing.classifierModelId,
        routing.systemOneModelId,
      ]),
    [
      routing.trivial.modelId,
      routing.standard.modelId,
      routing.complex.modelId,
      routing.review.modelId,
      routing.classifierModelId,
      routing.systemOneModelId,
    ],
  );

  // Prévisualisation (dryRun) : recalculée quand la portée, la sélection ou les
  // modèles changent. Le résultat est JETÉ si le panneau est fermé entre-temps.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    previewRoutingCopy(
      {
        sourceProjectId: projectId,
        scope,
        routing,
        ...(scope === "selected" ? { selectedProjectIds: selected } : {}),
      },
      apiErrorLabels(t),
    )
      .then((p) => {
        if (!cancelled) setPlan(p);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setPlan(null);
        setError(e?.message || t("routingModal.apply.error"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `routing` est volontairement absent : seule `modelKey` (les ids) compte,
    // sinon chaque mouvement de curseur relancerait la prévisualisation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, scope, selectedKey, modelKey]);

  const targetCount = plan?.targets.length ?? 0;
  const canApply = !!plan && targetCount > 0 && confirmed && !loading && !applying && !done;

  const toggleScope = (next: RoutingCopyScope) => {
    setScope(next);
    // Changer de portée invalide la confirmation déjà donnée : on re-confirme.
    setConfirmed(false);
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    setConfirmed(false);
  };

  const handleApply = async () => {
    if (!canApply) return;
    setApplying(true);
    setError("");
    try {
      const res = await applyRoutingCopy(
        {
          sourceProjectId: projectId,
          scope,
          routing,
          ...(scope === "selected" ? { selectedProjectIds: selected } : {}),
        },
        apiErrorLabels(t),
      );
      setDone({ count: res.applied.length, warnings: res.warnings });
      toast(t("routingModal.apply.success", res.applied.length), "success");
      // Rafraîchissement : les configs des autres projets ont changé sur disque.
      await onApplied?.();
    } catch (e: any) {
      setError(e?.message || t("routingModal.apply.error"));
    } finally {
      setApplying(false);
    }
  };

  const fieldLabel = (field: string): string => t(`routingModal.apply.fields.${field}`);

  return (
    <div className="border border-hacker-warn/40 bg-hacker-warn/5 rounded p-3 space-y-3">
      {/* En-tête du panneau : action large → libellé explicite + fermeture */}
      <div className="flex items-start gap-2">
        <span className="text-sm leading-none mt-0.5">🌐</span>
        <span className="text-[11px] font-bold text-hacker-warn tracking-wider">
          {t("routingModal.apply.title")}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("routingModal.apply.cancel")}
          className="ml-auto text-hacker-text-dim hover:text-hacker-error"
        >
          <HolafIcon name="x" size={12} />
        </button>
      </div>

      <p className="text-[10px] text-hacker-text-dim leading-relaxed">{t("routingModal.apply.intro")}</p>

      {/* ── 1. PORTÉE : choix explicite, jamais silencieux ── */}
      <fieldset className="space-y-1">
        <legend className="text-[11px] text-hacker-text-dim mb-1">{t("routingModal.apply.scopeLabel")}</legend>
        {SCOPES.map((s) => (
          <label
            key={s.id}
            className="flex items-center gap-2 text-[11px] text-hacker-text cursor-pointer hover:text-hacker-text-bright"
          >
            <input
              type="radio"
              name="routing-copy-scope"
              value={s.id}
              checked={scope === s.id}
              onChange={() => toggleScope(s.id)}
              className="accent-hacker-accent"
            />
            <span>{t(s.labelKey)}</span>
          </label>
        ))}
        {scope === "linked-subprojects" && plan && !plan.sourceIsLinked && (
          <p className="text-[10px] text-hacker-warn pl-6">{t("routingModal.apply.notLinked")}</p>
        )}
      </fieldset>

      {/* ── Sélection cochable (portée « selected ») ── */}
      {scope === "selected" && plan && plan.candidates.length > 0 && (
        <div className="pl-1 max-h-40 overflow-y-auto border border-hacker-border/40 rounded p-2 space-y-1">
          {plan.candidates.map((c) => (
            <label
              key={c.id}
              className="flex items-center gap-2 text-[11px] text-hacker-text cursor-pointer hover:text-hacker-text-bright"
            >
              <input
                type="checkbox"
                checked={selected.includes(c.id)}
                onChange={() => toggleSelected(c.id)}
                aria-label={c.name}
                className="accent-hacker-accent"
              />
              <span className="truncate">{c.name}</span>
              {c.isSource && (
                <span className="text-[9px] text-hacker-accent font-mono ml-auto shrink-0">courant</span>
              )}
            </label>
          ))}
        </div>
      )}

      {/* ── 2. PRÉVISUALISATION : ce qui change / ce qui ne change pas ── */}
      <div className="border-t border-hacker-border/30 pt-2 space-y-1.5" aria-live="polite">
        {loading ? (
          <p className="text-[10px] text-hacker-text-dim italic">{t("routingModal.apply.previewLoading")}</p>
        ) : plan ? (
          <>
            <p className="text-[11px] font-bold text-hacker-text-bright">
              {t("routingModal.apply.targetsTitle", targetCount)}
            </p>
            {targetCount > 0 ? (
              <ul className="text-[10px] text-hacker-text-dim space-y-0.5 max-h-32 overflow-y-auto">
                {plan.targets.map((p) => (
                  <li key={p.id} className="truncate">
                    • {p.name}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[10px] text-hacker-warn">{t("routingModal.apply.noTargets")}</p>
            )}
            <p className="text-[10px] text-hacker-text-dim">
              {t("routingModal.apply.unchangedCount", Math.max(0, plan.totalProjects - targetCount))}
            </p>
            {plan.skipped.length > 0 && (
              <ul className="text-[10px] text-hacker-text-dim opacity-70 space-y-0.5">
                {plan.skipped.map((s) => (
                  <li key={s.id} className="truncate">
                    – {t("routingModal.apply.skippedLine", s.name)}
                  </li>
                ))}
              </ul>
            )}

            {/* ── 3. AVERTISSEMENT : modèles absents de la bibliothèque ── */}
            {plan.warnings.length > 0 && (
              <div className="border border-hacker-warn/40 bg-hacker-warn/5 rounded p-2 space-y-1">
                <p className="text-[10px] font-bold text-hacker-warn">
                  ⚠ {t("routingModal.apply.warningsTitle")}
                </p>
                <ul className="text-[10px] text-hacker-text-dim space-y-0.5">
                  {plan.warnings.map((w) => (
                    <li key={`${w.field}:${w.modelId}`}>
                      {t("routingModal.apply.warningLine", w.modelId, fieldLabel(w.field))}
                      <span className="opacity-70"> ({w.projectNames.join(", ")})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : null}
      </div>

      {/* ── 4. CONFIRMATION obligatoire avant écriture ── */}
      {!done && targetCount > 0 && (
        <label className="flex items-start gap-2 text-[11px] text-hacker-text cursor-pointer select-none">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-0.5 accent-hacker-warn"
          />
          <span>{t("routingModal.apply.confirmLabel", targetCount)}</span>
        </label>
      )}

      {error && (
        <div className="px-3 py-2 bg-hacker-error/10 text-hacker-error text-[11px] border border-hacker-error/30 rounded">
          {error}
        </div>
      )}

      {/* ── 5. Résultat honnête ── */}
      {done && (
        <div className="px-3 py-2 bg-hacker-ok/10 text-hacker-ok text-[11px] border border-hacker-ok/30 rounded space-y-1">
          <p className="font-bold">✓ {t("routingModal.apply.success", done.count)}</p>
          {done.warnings.length > 0 && (
            <ul className="text-[10px] text-hacker-text-dim space-y-0.5">
              {done.warnings.map((w) => (
                <li key={`${w.field}:${w.modelId}`}>
                  ⚠ {t("routingModal.apply.warningLine", w.modelId, fieldLabel(w.field))}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button type="button" onClick={onClose} className="btn-hacker text-[11px] px-3 py-1">
          {done ? t("routingModal.apply.close") : t("routingModal.apply.cancel")}
        </button>
        {!done && (
          <button
            type="button"
            onClick={handleApply}
            disabled={!canApply}
            className="btn-hacker text-[11px] px-3 py-1 text-hacker-warn border-hacker-warn disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {applying ? t("routingModal.apply.applying") : t("routingModal.apply.applyButton", targetCount)}
          </button>
        )}
      </div>
    </div>
  );
}
