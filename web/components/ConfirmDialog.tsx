"use client";

// Yes/no dialog for F (flatten all) and X (cancel all), Task 12.3, Req 30.4 and 30.5. Nothing is
// sent until the user confirms (Enter or Y); Escape or N closes it and sends nothing. The keys are
// handled by OrderHotkeys through the shared keymap's `dialog` context.

import { useEffect } from "react";
import { useTerminalStore, type ConfirmAction } from "../lib/store";
import { useOrderActions } from "../lib/useOrderActions";
import { blurEditableFocus } from "./PreviewDialog";

const TEXT: Readonly<Record<ConfirmAction, string>> = {
  flatten_all: "Flatten every position?",
  cancel_all: "Cancel every open order?",
};

function ConfirmBody({ action }: { readonly action: ConfirmAction }) {
  const actions = useOrderActions();

  useEffect(() => {
    blurEditableFocus();
  }, []);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={TEXT[action]}
        className="crt-panel w-[24rem] max-w-[90vw] p-4 text-sm"
      >
        <h2 className="crt-title mb-3">{TEXT[action]}</h2>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => {
              actions.confirmPending();
            }}
            className="crt-panel px-3 py-1 text-buy"
          >
            Confirm [Enter/Y]
          </button>
          <button
            type="button"
            onClick={() => {
              actions.cancelPending();
            }}
            className="crt-panel px-3 py-1 text-sell"
          >
            Cancel [Esc/N]
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmDialog() {
  const action = useTerminalStore((state) => state.confirmAction);
  if (action === null) return null;
  return <ConfirmBody action={action} />;
}
