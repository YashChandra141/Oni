"use client";

// /pair: confirm a TUI pairing code (Req 48.4, 48.5). Nothing is sent until the user clicks Confirm.

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { WalletMenu } from "../../components/WalletMenu";
import { loadSession } from "../../lib/auth";
import type { AuthSession } from "../../lib/auth";
import { API_URL } from "../../lib/config";
import { confirmPairing, formatCode, normalizeCode, PAIR_FAILURE_TEXT } from "../../lib/pairing";
import { shortAddress } from "../../lib/status";

// Not exported: Next.js page modules may only export the page and route config.
const PAIR_WARNING = "Only confirm a code shown in your own terminal";
const PAIR_INVALID = "This pairing link is invalid.";
const PAIR_DONE = "Paired. You can return to your terminal.";

type Status = { kind: "idle" } | { kind: "sending" } | { kind: "done" } | { kind: "error"; message: string };

function PairContent() {
  const params = useSearchParams();
  const code = normalizeCode(params.get("code"));
  const [session, setSession] = useState<AuthSession | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Read the stored session after mount so the prerendered page matches the first client render.
  useEffect(() => {
    setSession(loadSession(window.localStorage, Date.now()));
  }, []);

  if (code === null) {
    return <p role="alert" className="text-amber">{PAIR_INVALID}</p>;
  }

  async function onConfirm(valid: string): Promise<void> {
    if (status.kind === "sending" || status.kind === "done") return;
    setStatus({ kind: "sending" });
    const result = await confirmPairing(valid, {
      fetch: (url, init) => fetch(url, init),
      apiUrl: API_URL,
      token: session?.token ?? null,
    });
    if (result.ok) setStatus({ kind: "done" });
    else setStatus({ kind: "error", message: PAIR_FAILURE_TEXT[result.reason] });
  }

  const canConfirm = session !== null && status.kind !== "sending" && status.kind !== "done";

  return (
    <div className="flex flex-col gap-4">
      <p aria-label="Pairing code" className="text-4xl tracking-widest text-phosphor">
        {formatCode(code)}
      </p>
      <p className="text-amber">{PAIR_WARNING}</p>
      {session === null ? (
        <WalletMenu onSignedIn={setSession} />
      ) : (
        <p className="text-phosphor" title={session.address}>
          Signed in as {shortAddress(session.address)}
        </p>
      )}
      <button
        type="button"
        className="w-fit border border-crt-line px-3 py-1 hover:bg-crt-line disabled:opacity-50"
        disabled={!canConfirm}
        onClick={() => void onConfirm(code)}
      >
        Confirm
      </button>
      {status.kind === "done" && (
        <p role="status" className="text-phosphor">
          {PAIR_DONE}
        </p>
      )}
      {status.kind === "error" && (
        <p role="alert" className="text-amber">
          {status.message}
        </p>
      )}
    </div>
  );
}

export default function PairPage() {
  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="mb-4 text-xl text-phosphor">Pair your terminal</h1>
      <Suspense fallback={null}>
        <PairContent />
      </Suspense>
    </main>
  );
}
