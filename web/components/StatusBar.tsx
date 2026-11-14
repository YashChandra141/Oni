"use client";

import { WS_URL } from "../lib/config";
import { accountLabel, connectionLabel, modeLabel } from "../lib/status";
import { useTerminalStore } from "../lib/store";
import { WalletMenu } from "./WalletMenu";

/**
 * Connection state, data mode, and account. While there is no open connection it shows the
 * "waking server" status (Req 33.1); once connected it shows the protocol version, REPLAY or
 * LIVE with the venue (Req 44.7), and the account.
 */
export function StatusBar() {
  const connection = useTerminalStore((state) => state.connection);
  const hello = useTerminalStore((state) => state.hello);
  const session = useTerminalStore((state) => state.session);
  const connected = connection.kind === "connected";

  return (
    <header
      aria-label="Status bar"
      className="crt-panel col-span-3 flex items-center gap-4 px-2 py-1 text-xs"
    >
      <span className="font-bold tracking-widest">HAUNTED TERMINAL</span>
      {connected ? (
        <>
          {hello !== null && (
            <>
              <span className="text-phosphor-dim">PROTOCOL v{hello.protocolVersion}</span>
              <span className="text-amber">{modeLabel(hello)}</span>
            </>
          )}
          <span className="text-phosphor-dim">{accountLabel(session)}</span>
        </>
      ) : (
        <span role="status" aria-live="polite" className="text-amber">
          {connectionLabel(connection)}
        </span>
      )}
      <span className="text-phosphor-dim">PAPER ONLY</span>
      <span className="ml-auto text-phosphor-faint" title="Server WebSocket URL">
        {WS_URL}
      </span>
      <WalletMenu />
    </header>
  );
}
