import { ReactNode } from "react";

type Props = {
  title: string;
  message: string;
  open: boolean;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
};

export const ConfirmDialog = ({ title, message, open, confirmLabel = "Confirm", onConfirm, onCancel, children }: Props) => {
  if (!open) return null;
  return (
    <div className="dialog-overlay" role="dialog" aria-modal>
      <div className="dialog-card">
        <h3>{title}</h3>
        <p>{message}</p>
        {children}
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
