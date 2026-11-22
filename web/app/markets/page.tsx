"use client";

import { PageFrame } from "../../components/shell/PageFrame";
import { formatPrice } from "../../lib/format";
import { useTerminalStore } from "../../lib/store";

const SYMBOLS: readonly string[] = [
  "BTC-USD",
  "ETH-USD",
  "SOL-USD",
  "BNB-USD",
  "XRP-USD",
  "DOGE-USD",
  "JUP-USD",
  "WIF-USD",
  "BONK-USD",
  "PEPE-USD",
];

/** Signed percent from basis points, integer math: 125 -> "+1.25%". */
function formatChange(bps: number): string {
  const sign = bps < 0 ? "-" : "+";
  const abs = Math.abs(Math.trunc(bps));
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${Math.floor(abs / 100)}.${frac}%`;
}

export default function MarketsPage() {
  const tickers = useTerminalStore((s) => s.tickers);
  const instruments = useTerminalStore((s) => s.instruments);

  // Keys are `venue|symbol`.
  const bySymbol = new Map<string, { venue: string; last: string; change: number }[]>();
  for (const [key, state] of Object.entries(tickers)) {
    const [venue, symbol] = key.split("|");
    if (venue === undefined || symbol === undefined) continue;
    const list = bySymbol.get(symbol) ?? [];
    list.push({ venue, last: state.ticker.last, change: state.ticker.change_bps });
    bySymbol.set(symbol, list);
  }

  return (
    <PageFrame title="Markets">
      <table className="w-full text-xs">
        <thead className="text-left text-phosphor-dim">
          <tr>
            <th className="px-1">Symbol</th>
            <th className="px-1">Venue</th>
            <th className="px-1 text-right">Price</th>
            <th className="px-1 text-right">24h</th>
            <th className="px-1">Listed on</th>
          </tr>
        </thead>
        <tbody>
          {SYMBOLS.flatMap((symbol) => {
            const entries = bySymbol.get(symbol) ?? [];
            const listed = entries.map((e) => e.venue).join(", ") || "—";
            if (entries.length === 0) {
              return [
                <tr key={symbol} className="border-t border-crt-line">
                  <td className="px-1">{symbol}</td>
                  <td className="px-1 text-phosphor-dim">—</td>
                  <td className="px-1 text-right">—</td>
                  <td className="px-1 text-right">—</td>
                  <td className="px-1 text-phosphor-dim">{listed}</td>
                </tr>,
              ];
            }
            return entries.map((e) => (
              <tr key={`${e.venue}|${symbol}`} className="border-t border-crt-line">
                <td className="px-1">{symbol}</td>
                <td className="px-1">{e.venue}</td>
                <td className="px-1 text-right tabular-nums">
                  {formatPrice(e.last, instruments[symbol]?.price_decimals)}
                </td>
                <td className={`px-1 text-right tabular-nums ${e.change < 0 ? "text-red-400" : "text-green-400"}`}>
                  {formatChange(e.change)}
                </td>
                <td className="px-1 text-phosphor-dim">{listed}</td>
              </tr>
            ));
          })}
        </tbody>
      </table>
    </PageFrame>
  );
}
