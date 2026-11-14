"use client";

// Shows the latest order rejection or refused request (Task 12.3, Req 30.6). It closes by itself
// after a few seconds and has a dismiss button.

import { useEffect } from "react";
import { rejectionText } from "../lib/orderEntry";
import { useTerminalStore } from "../lib/store";

const AUTO_DISMISS_MS = 10_000;

export function RejectionToast() {
  const rejections = useTerminalStore((state) => state.rejections);
  const dismiss = useTerminalStore((state) => state.dismissRejections);
  const latest = rejections[0];

  useEffect(() => {
    if (latest === undefined) return;
    const timer = setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [rejections, latest, dismiss]);

  if (latest === undefined) return null;
  return (
    <div
      role="alert"
      className="crt-panel fixed bottom-16 right-2 z-40 flex max-w-sm items-start gap-3 px-3 py-2 text-xs text-sell"
    >
      <div>
        <div className="font-bold">REJECTED</div>
        <div>{rejectionText(latest.reason)}</div>
        {latest.orderId !== null && <div className="text-phosphor-faint">order {latest.orderId}</div>}
        {rejections.length > 1 && (
          <div className="text-phosphor-faint">+{rejections.length - 1} earlier</div>
        )}
      </div>
      <button type="button" aria-label="Dismiss rejection" onClick={dismiss} className="text-amber">
        ✕
      </button>
    </div>
  );
}
