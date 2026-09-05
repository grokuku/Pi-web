import { useState } from "react";
import { AlertTriangle, RefreshCw, Check, ArrowUpCircle, X } from "lucide-react";
import { ModalDialog } from "../common/ModalDialog";
import { useTranslation, type TFunction } from "../../i18n";
import { parseJsonResponse } from "../../utils/api";

interface Props {
  open: boolean;
  onClose: () => void;
  latestVersion: string;
  currentVersion: string;
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
// Rappelle l'avertissement d'audit préalable, puis lance le POST /api/settings/update.
// Le backend persiste le pin (package.json + entrypoint.sh) et redémarre le
// container : le WS se coupera, la reconnexion est gérée par le code existant.
export function UpdateAgentModal({ open, onClose, latestVersion, currentVersion }: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  if (!open) return null;

  const handleUpdate = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/settings/update", { method: "POST" });
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
          <button onClick={handleUpdate} className="btn-hacker danger text-xs flex items-center gap-1.5">
            <ArrowUpCircle size={12} />
            {t("sidebar.updateNow")}
          </button>
        </div>
      )}
    </ModalDialog>
  );
}
