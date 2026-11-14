// Shared Router test harness (Tasks 11.2 and 11.6). Not a test file: importing it registers no
// tests. The real Risk_Engine, AccountState, and MarketState are used; the engine sender,
// journal, clock, and gateway hooks are small recording fakes.
import type { OrderCommand } from "./engine/supervisor.ts";
import type { Event } from "./protocol.ts";
import { type RiskLimits, defaultLimits } from "./risk/limits.ts";
import {
  type OrderOrigin,
  type OrderRejectedEvent,
  type OrderSource,
  Router,
  type RouterJournalRecord,
  type RouterSession,
  type SubmitOrder,
  createOrderIdGenerator,
  marketPrices,
} from "./router.ts";
import { AccountState } from "./state/account.ts";
import { MarketState } from "./state/market.ts";

export const START_MS = 1_700_000_000_000;

export const GUEST: RouterSession = { accountId: "guest", address: null, jti: null, exp: null };

/** A wallet session valid for one hour after START_MS. */
export function walletSession(address: string, exp: number = START_MS / 1000 + 3600): RouterSession {
  return { accountId: `w_${address}`, address, jti: `jti-${address}`, exp };
}

export function originOf(connectionId: string, session: RouterSession, source: OrderSource = "web"): OrderOrigin {
  return { connectionId, session, source };
}

/** 0.1 BTC limit buy at $64,000.00 (6,400,000 ticks, 10,000,000 lots). */
export function limitBuy(price = 6_400_000n, qty = 10_000_000n): SubmitOrder {
  return { symbol: "BTC-USD", side: "buy", qty, kind: { type: "limit", price } };
}

export interface HarnessOptions {
  readonly running?: boolean;
  readonly killSwitch?: boolean;
  readonly limits?: RiskLimits;
}

export function harness(options: HarnessOptions = {}) {
  const clock = { ms: START_MS };
  const state = { running: options.running ?? true, accept: true };
  const sent: OrderCommand[] = [];
  const sender = {
    send(cmd: OrderCommand): boolean {
      sent.push(cmd);
      return state.accept;
    },
  };
  const records: RouterJournalRecord[] = [];
  const journal = {
    throwOnEnqueue: false,
    enqueue(record: RouterJournalRecord): void {
      if (journal.throwOnEnqueue) throw new Error("journal is down");
      records.push(record);
    },
  };
  const pending = new Map<string, string>();
  const expired: string[] = [];
  const rejected: { connectionId: string; event: OrderRejectedEvent }[] = [];
  const logs: string[] = [];
  const accounts = new AccountState();
  const market = new MarketState();
  const trade = (symbol: string, price: string): Event => ({ type: "trade", symbol, price, qty: "1", side: "buy", ts: 1 });
  market.apply(trade("BTC-USD", "6400000"));
  market.apply(trade("ETH-USD", "320000"));
  market.apply(trade("SOL-USD", "15000"));
  const risk = { limits: options.limits ?? defaultLimits(), killSwitch: options.killSwitch ?? false };

  const router = new Router({
    sender,
    engineRunning: () => state.running,
    risk,
    market: marketPrices(market),
    accounts,
    journal,
    now: () => clock.ms,
    newOrderId: createOrderIdGenerator(() => "abc123"),
    pendingRequests: { set: (orderId, connectionId) => void pending.set(orderId, connectionId) },
    onSessionExpired: (connectionId) => void expired.push(connectionId),
    onRejected: (connectionId, event) => void rejected.push({ connectionId, event }),
    logger: { info: (l) => void logs.push(l), warn: (l) => void logs.push(l), error: (l) => void logs.push(l) },
  });

  const setPosition = (accountId: string, symbol: string, qty: string): void =>
    accounts.apply({ type: "position", account_id: accountId, symbol, qty, avg_entry: "6400000", realized: "0", unrealized: "0" });
  const acceptOrder = (accountId: string, orderId: string): void =>
    accounts.apply({ type: "order_ack", account_id: accountId, order_id: orderId, status: "accepted" });

  return { router, clock, state, sent, sender, records, journal, pending, expired, rejected, logs, accounts, market, risk, setPosition, acceptOrder };
}
