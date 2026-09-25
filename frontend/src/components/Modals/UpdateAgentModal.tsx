import { useState } from "react";
import { AlertTriangle, RefreshCw, Check, ArrowUpCircle, X } from "lucide-react";
import { ModalDialog } from "../common/ModalDialog";
import { useTranslation, type TFunction } from "../../i18n";
import { parseJsonResponse } from "../../utils/api";
import {
  buildUpdateBody,
  updateBlockedWithoutAck,
  type SdkBreakingChange,
} from "../../utils/sdk-update";

interface Props {
  open: boolean;
  onClose: () => void;
  latestVersion: string;
  currentVersion: string;
  /** Ruptures connues applicables au saut (versions intermédiaires). */
  breakingChanges?: SdkBreakingChange[];
  /** Un saut mineur/majeur exige une case de confirmation explicite. */
  requiresAck?: boolean;
}

// ── Libellés i18n pré-traduits pour parseJsonResponse ──
// (le helper utils n'a pas accès au hook useTranslation : on lui passe des
// libellés déjà résolus, cf. git.sessionExpired / git.serverError)
function apiErrorLabels(t: TFunction) {
  return {
    sessionExpired: t("git.sessionExpired"),
    serverError: (status: number) => t("git.serverError", status),
  };
}

// ── Modale de confirmation avant une mise à jour à chaud du SDK pi-agent ──
// Affiche les ruptures connues AVANT l'action ; un saut mineur/majeur exige une
// case de confirmation (sinon le backend répond 409). Le POST envoie la cible
// explicite + `acknowledged`. Le backend persiste le pin (package.json +
// entrypoint.sh) et redémarre le container : le WS se coupera, la reconnexion
// est gérée par le code existant.
export function UpdateAgentModal({
  open,
  onClose,
  latestVersion,
  currentVersion,
  breakingChanges = [],
  requiresAck = false,
}: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [ack, setAck] = useState(false);

  if (!open) return null;

  const blocked = updateBlockedWithoutAck(requiresAck, ack);

  const handleUpdate = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/settings/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildUpdateBody(latestVersion, ack)),
      });
      const data = await parseJsonResponse<any>(res, apiErrorLabels(t));
      if (data.success) {
        setDone(true);
        // Le WS se coupera au redémarrage ; la reconnexion est gérée par le code existant.
      } else {
        setError(data.error || t("sidebar.updateFailed"));
      }
    } catch (err: any) {
      setError(err.message || t("sidebar.updateFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalDialog id="update-agent" onClose={onClose}>
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-hacker-warn/10 border border-hacker-warn/30">
          <AlertTriangle size={20} className="text-hacker-warn" />
        </div>
        <span className="text-hacker-warn font-bold text-sm tracking-wider">
          {t("sidebar.updateConfirmTitle")}
        </span>
        <button onClick={onClose} className="ml-auto text-hacker-text-dim hover:text-hacker-text">
          <X size={16} />
        </button>
      </div>

      {/* Erreur */}
      {error && (
        <div className="text-hacker-error text-xs mb-3 border border-hacker-error/30 p-2 flex items-center gap-1.5">
          <AlertTriangle size={12} />
          {error}
        </div>
      )}

      {/* Succès */}
      {done && (
        <div className="text-hacker-accent text-xs mb-3 border border-hacker-accent/30 p-3 flex items-center gap-2 bg-hacker-accent/5">
          <Check size={14} />
          {t("sidebar.updateSuccess", latestVersion)}
        </div>
      )}

      {/* Corps */}
      {!done && (
        <div className="text-hacker-text text-xs mb-4 leading-relaxed bg-hacker-bg/30 border border-hacker-border p-3">
          <p>{t("sidebar.updateConfirmBody", latestVersion, currentVersion)}</p>
        </div>
      )}

      {/* Ruptures connues — affichées AVANT le bouton de mise à jour */}
      {!done && breakingChanges.length > 0 && (
        <div className="mb-4 border border-hacker-warn/40 bg-hacker-warn/5 p-3">
          <div className="flex items-center gap-2 text-hacker-warn text-xs font-bold mb-2">
            <AlertTriangle size={13} />
            {t("sidebar.updateBreakingTitle")}
          </div>
          <ul className="space-y-2">
            {breakingChanges.map((change) => (
              <li key={change.version} className="text-hacker-text text-xs">
                <span className="text-hacker-warn font-bold">v{change.version}</span>{" "}
                <span className="text-hacker-text-dim">{change.summary}</span>
                {change.details.length > 0 && (
                  <ul className="list-disc list-inside mt-1 text-hacker-text-dim/80 space-y-0.5">
                    {change.details.map((detail, i) => (
                      <li key={i}>{detail}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Case de confirmation explicite pour un saut mineur/majeur */}
      {!done && requiresAck && (
        <label className="flex items-start gap-2 mb-4 text-xs text-hacker-text cursor-pointer border border-hacker-warn/40 p-3 bg-hacker-bg/30">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            className="mt-0.5 accent-hacker-warn"
            data-testid="update-ack-checkbox"
          />
          <span>{t("sidebar.updateBreakingAck")}</span>
        </label>
      )}

      {/* Chargement */}
      {loading && (
        <div className="text-hacker-text-dim text-xs flex items-center gap-2 py-2">
          <RefreshCw size={12} className="animate-spin" />
          {t("sidebar.updatingTo", latestVersion)}
        </div>
      )}

      {/* Boutons */}
      {!done && !loading && (
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="btn-hacker text-xs">
            {t("sidebar.updateAuditFirst")}
          </button>
          <button onClick={onClose} className="btn-hacker text-xs">
            {t("common.cancel")}
          </button>
          <button
            onClick={handleUpdate}
            disabled={blocked}
            className="btn-hacker danger text-xs flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ArrowUpCircle size={12} />
            {t("sidebar.updateNow")}
          </button>
        </div>
      )}
    </ModalDialog>
  );
}
