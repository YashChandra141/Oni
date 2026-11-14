"use client";

// Order_Preview dialog (Task 12.3, Req 22.1-22.3): shows the server's canonical text and a
// countdown. Confirm (Enter or Y) sends `confirm`; Discard (Escape or N) sends `discard`. The keys
// are handled by OrderHotkeys through the shared keymap's `dialog` context. The dialog closes by
// itself when the preview expires.

import { useEffect, useMemo, useState } from "react";
import type { OrderPreview } from "../../shared/protocol/index";
import { previewActionLabel, previewDeadline, previewSecondsLeft } from "../lib/orderEntry";
import { useTerminalStore } from "../lib/store";
import { useOrderActions } from "../lib/useOrderActions";

/** Moves focus out of a text input so the dialog keys are not typed into it. */
export function blurEditableFocus(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
    active.blur();
  }
}

function PreviewBody({ preview }: { readonly preview: OrderPreview }) {
  const actions = useOrderActions();
  const clearPreview = useTerminalStore((state) => state.clearPreview);
  const [firstSeen] = useState(() => Date.now());
  const deadline = useMemo(() => previewDeadline(preview.expires_at, firstSeen), [preview.expires_at, firstSeen]);
  const [now, setNow] = useState(firstSeen);

  useEffect(() => {
    blurEditableFocus();
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 250);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const expired = now >= deadline;
  useEffect(() => {
    if (expired) clearPreview();
  }, [expired, clearPreview]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Order preview"
        className="crt-panel w-[28rem] max-w-[90vw] p-4 text-sm"
      >
        <h2 className="crt-title mb-2">{previewActionLabel(preview.action)}</h2>
        <p className="mb-2 break-words text-lg text-amber" data-testid="preview-text">
          {preview.text}
        </p>
        <p className="mb-3 text-xs text-phosphor-dim">
          expires in {previewSecondsLeft(deadline, now)}s
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => {
              actions.confirmPreview();
            }}
            className="crt-panel px-3 py-1 text-buy"
          >
            Confirm [Enter/Y]
          </button>
          <button
            type="button"
            onClick={() => {
              actions.discardPreview();
            }}
            className="crt-panel px-3 py-1 text-sell"
          >
            Discard [Esc/N]
          </button>
        </div>
      </div>
    </div>
  );
}

export function PreviewDialog() {
  const preview = useTerminalStore((state) => state.preview);
  const confirmOpen = useTerminalStore((state) => state.confirmAction !== null);
  // The yes/no dialog has priority (OrderHotkeys applies the same order).
  if (preview === null || confirmOpen) return null;
  return <PreviewBody key={preview.preview.preview_id} preview={preview.preview} />;
}
