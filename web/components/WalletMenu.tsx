"use client";

import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { browserAuthDeps, signIn, signOut } from "../lib/auth";
import type { AuthSession, SignInErrorCode } from "../lib/auth";
import { useTerminalStore } from "../lib/store";
import { useSocketHandle } from "../lib/terminalContext";
import { menuState, runSignIn, walletDisplayName } from "../lib/walletMenu";
import { browserWalletList } from "../lib/wallets";
import type { Wallet } from "../lib/walletStandard";

const BUTTON_CLASS =
  "flex items-center gap-1 border border-crt-line px-2 py-0.5 text-xs hover:bg-crt-line disabled:opacity-50";

function WalletIcon({ wallet }: { wallet: Wallet }) {
  // The icon is a data URI supplied by the wallet; only data: URIs are rendered.
  if (typeof wallet.icon !== "string" || !wallet.icon.startsWith("data:image/")) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={wallet.icon} alt={`${walletDisplayName(wallet)} logo`} width={14} height={14} />;
}

/**
 * Sign-in buttons per detected wallet, or the shortened address with Sign out (Req 47.4, 47.5),
 * or the no-wallet message (Req 47.7). The wallet signs only the sign-in message.
 */
export function WalletMenu({ onSignedIn }: { onSignedIn?: (session: AuthSession) => void } = {}) {
  const list = useMemo(() => browserWalletList(), []);
  const wallets = useSyncExternalStore(list.subscribe, list.getSnapshot, list.getServerSnapshot);
  const session = useTerminalStore((state) => state.session);
  const socket = useSocketHandle();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<SignInErrorCode | null>(null);
  const activeWallet = useRef<Wallet | null>(null);

  const view = menuState(wallets, session, pending, error);

  async function onSignIn(wallet: Wallet): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    const outcome = await runSignIn(wallet, browserAuthDeps(), signIn);
    if (outcome.kind === "signed_in") {
      activeWallet.current = wallet;
      // The socket is already open, so it does not authenticate by itself (Req 47.1).
      socket.send({ type: "authenticate", token: outcome.session.token });
      onSignedIn?.(outcome.session);
    } else {
      setError(outcome.code);
    }
    setPending(false);
  }

  async function onSignOut(address: string): Promise<void> {
    if (pending) return;
    setPending(true);
    const wallet =
      activeWallet.current ?? wallets.find((w) => w.accounts.some((account) => account.address === address));
    activeWallet.current = null;
    // The server's `signed_out` notice downgrades the connection to the guest account.
    await signOut(browserAuthDeps(), wallet);
    setError(null);
    setPending(false);
  }

  return (
    <div aria-label="Wallet" className="flex items-center gap-2">
      {view.kind === "pending" && (
        <span role="status" aria-live="polite" className="text-amber">
          {view.message}
        </span>
      )}
      {view.kind === "signed_in" && (
        <>
          <span className="text-phosphor" title={view.address}>
            {view.shortAddress}
          </span>
          <button type="button" className={BUTTON_CLASS} onClick={() => void onSignOut(view.address)}>
            {view.signOutLabel}
          </button>
        </>
      )}
      {view.kind === "guest" &&
        view.buttons.map((button) => {
          const wallet = wallets[button.walletIndex];
          if (wallet === undefined) return null;
          return (
            <button
              key={`${wallet.name}-${button.walletIndex}`}
              type="button"
              className={BUTTON_CLASS}
              disabled={pending}
              onClick={() => void onSignIn(wallet)}
            >
              <WalletIcon wallet={wallet} />
              {button.label}
            </button>
          );
        })}
      {view.kind === "no_wallet" && <span className="text-phosphor-faint">{view.message}</span>}
      {view.error !== null && (
        <span role="alert" className="text-amber">
          {view.error}
        </span>
      )}
    </div>
  );
}
