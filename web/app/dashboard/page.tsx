"use client";

import { PageFrame, StatRow } from "../../components/shell/PageFrame";
import { formatMoney } from "../../lib/orderEntry";
import { accountLabel, connectionLabel } from "../../lib/status";
import { useTerminalStore } from "../../lib/store";

export default function DashboardPage() {
  const connection = useTerminalStore((s) => s.connection);
  const session = useTerminalStore((s) => s.session);
  const hello = useTerminalStore((s) => s.hello);
  const balance = useTerminalStore((s) => {
    const id = s.session?.accountId ?? s.dataAccountId;
    return id === null ? undefined : s.balances[id];
  });
  const openOrders = useTerminalStore((s) => Object.keys(s.openOrders).length);
  const positions = useTerminalStore((s) => Object.keys(s.positions).length);
  const venueStatus = useTerminalStore((s) => s.venueStatus);

  const statuses = Object.entries(venueStatus);

  return (
    <PageFrame title="Dashboard">
      <dl aria-label="Account summary" className="mb-4 max-w-sm">
        <StatRow label="Connection" value={connectionLabel(connection)} />
        <StatRow label="Account" value={accountLabel(session)} />
        <StatRow label="Data mode" value={hello?.dataMode ?? "—"} />
        <StatRow label="Equity" value={`$${formatMoney(balance?.equity)}`} />
        <StatRow label="Open orders" value={String(openOrders)} />
        <StatRow label="Open positions" value={String(positions)} />
      </dl>
      <h2 className="crt-title mb-1 text-xs">Venues</h2>
      <ul aria-label="Venue statuses" className="max-w-sm text-xs">
        {statuses.length === 0 ? (
          <li className="px-1 text-phosphor-dim">No venue status yet.</li>
        ) : (
          statuses.map(([venue, status]) => (
            <li key={venue} className="flex justify-between px-1 py-0.5">
              <span className="text-phosphor-dim">{venue}</span>
              <span>{status}</span>
            </li>
          ))
        )}
      </ul>
    </PageFrame>
  );
}
