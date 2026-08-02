import { AlertTriangle, MessageSquarePlus } from "lucide-react";
import { ModalDialog } from "../common/ModalDialog";
import { useTranslation } from "../../i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

// ── Modale de confirmation avant une nouvelle conversation (/new) ──
// Évite d'effacer la conversation en cours par accident : l'utilisateur
// doit confirmer explicitement avant que la commande /new soit envoyée.
export function NewChatConfirmModal({ open, onClose, onConfirm }: Props) {
  const { t } = useTranslation();
  if (!open) return null;

  return (
    <ModalDialog id="new-chat-confirm" onClose={onClose}>
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-hacker-warn/10 border border-hacker-warn/30">
          <AlertTriangle size={20} className="text-hacker-warn" />
        </div>
        <div>
          <span className="text-hacker-warn font-bold text-sm tracking-wider">
            {t("newChatConfirm.title")}
          </span>
          <div className="text-hacker-text-dim text-xs">
            {t("header.newChat")}
          </div>
        </div>
      </div>

      {/* Warning text */}
      <div className="text-hacker-text text-xs mb-4 leading-relaxed bg-hacker-bg/30 border border-hacker-border p-3">
        <p>{t("newChatConfirm.description")}</p>
        <p className="text-hacker-warn mt-1">
          {t("newChatConfirm.warning")}
        </p>
      </div>

      {/* Buttons */}
      <div className="flex gap-2 justify-end pt-2">
        <button onClick={onClose} className="btn-hacker text-xs">
          {t("common.cancel")}
        </button>
        <button
          onClick={onConfirm}
          className="btn-hacker danger text-xs flex items-center gap-1.5"
        >
          <MessageSquarePlus size={12} />
          {t("common.confirm")}
        </button>
      </div>
    </ModalDialog>
  );
}
