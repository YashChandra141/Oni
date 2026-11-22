// TWAP scheduler (Req 17, design D11). Never talks to the engine: every child
// goes through the injected `submit`, which is the Router's submit path.
import { sliceQty, sliceSchedule, TWAP_MAX_SLICES, TWAP_MIN_SLICES } from "./slice";

export const MAX_ACTIVE_TWAPS_PER_ACCOUNT = 3;

export type TwapState = "running" | "completed" | "canceled" | "failed";
export type Side = "buy" | "sell";

export interface TwapPlan {
  symbol: string;
  side: Side;
  venue: string;
  totalQtyLots: bigint;
  slices: number;
  intervalS: number;
}

/** A child order handed to the Router. Always a market order, source "twap". */
export interface TwapChildOrder {
  orderId: string; // t<twapId>-<n>, n from 1
  twapId: string;
  accountId: string;
  symbol: string;
  side: Side;
  venue: string;
  qtyLots: bigint;
  type: "market";
  source: "twap";
}

export type SubmitResult = { ok: true } | { ok: false; reason: string };

export interface TwapStatus {
  id: string;
  accountId: string;
  symbol: string;
  side: Side;
  venue: string;
  slices: number;
  sent: number;
  state: TwapState;
  reason: string | null;
}

export interface TwapClock {
  now(): number;
  /** Returns a cancel function. */
  setTimer(ms: number, fn: () => void): () => void;
}

export interface TwapSchedulerDeps {
  clock: TwapClock;
  submit(order: TwapChildOrder): SubmitResult | Promise<SubmitResult>;
  onStatus(status: TwapStatus): void;
  isKillSwitchOn(): boolean;
  isEngineUp(): boolean;
}

export type StartResult =
  | { ok: true; twapId: string }
  | { ok: false; reason: "max_open_orders" | "kill_switch" | "engine_unavailable" | "invalid_plan" };

export type CancelResult = { ok: true } | { ok: false; reason: "unknown_twap" };

interface Entry {
  status: TwapStatus;
  quantities: bigint[];
  cancelTimers: Array<() => void>;
  /** Connection and session context that confirmed the plan. */
  connectionId: string;
  sessionVersion: number;
}

export class TwapScheduler {
  private readonly entries = new Map<string, Entry>();
  private nextId = 1;

  constructor(private readonly deps: TwapSchedulerDeps) {}

  /** Starts a confirmed plan: child 1 now, the rest at equal intervals. */
  start(accountId: string, connectionId: string, sessionVersion: number, plan: TwapPlan): StartResult {
    if (
      !Number.isInteger(plan.slices) ||
      plan.slices < TWAP_MIN_SLICES ||
      plan.slices > TWAP_MAX_SLICES ||
      plan.totalQtyLots < BigInt(plan.slices)
    ) {
      return { ok: false, reason: "invalid_plan" };
    }
    if (this.deps.isKillSwitchOn()) return { ok: false, reason: "kill_switch" };
    if (!this.deps.isEngineUp()) return { ok: false, reason: "engine_unavailable" };
    if (this.activeCount(accountId) >= MAX_ACTIVE_TWAPS_PER_ACCOUNT) {
      return { ok: false, reason: "max_open_orders" };
    }

    const id = String(this.nextId++);
    const entry: Entry = {
      status: {
        id,
        accountId,
        symbol: plan.symbol,
        side: plan.side,
        venue: plan.venue,
        slices: plan.slices,
        sent: 0,
        state: "running",
        reason: null,
      },
      quantities: sliceQty(plan.totalQtyLots, plan.slices),
      cancelTimers: [],
      connectionId,
      sessionVersion,
    };
    this.entries.set(id, entry);
    this.emit(entry);

    const t0 = this.deps.clock.now();
    const times = sliceSchedule(t0, plan.slices, plan.intervalS);
    for (let i = 1; i < times.length; i++) {
      const at = times[i] as number;
      entry.cancelTimers.push(this.deps.clock.setTimer(Math.max(0, at - t0), () => void this.fire(id, i)));
    }
    void this.fire(id, 0);
    return { ok: true, twapId: id };
  }

  /** User cancel. Only the owning account may cancel. */
  cancel(accountId: string, twapId: string): CancelResult {
    const e = this.entries.get(twapId);
    if (!e || e.status.accountId !== accountId) return { ok: false, reason: "unknown_twap" };
    if (e.status.state === "running") this.finish(e, "canceled", "user_cancel");
    return { ok: true };
  }

  /** The confirming connection closed. */
  onDisconnect(connectionId: string): void {
    this.cancelWhere((e) => e.connectionId === connectionId, "disconnect");
  }

  /** The connection's session changed accounts. */
  onSessionChange(connectionId: string, newSessionVersion: number): void {
    this.cancelWhere(
      (e) => e.connectionId === connectionId && e.sessionVersion !== newSessionVersion,
      "account_change",
    );
  }

  onEngineRestart(): void {
    this.cancelWhere(() => true, "engine_restart");
  }

  onKillSwitch(): void {
    this.cancelWhere(() => true, "kill_switch");
  }

  get(twapId: string): TwapStatus | undefined {
    const e = this.entries.get(twapId);
    return e ? { ...e.status } : undefined;
  }

  list(accountId: string): TwapStatus[] {
    return [...this.entries.values()].filter((e) => e.status.accountId === accountId).map((e) => ({ ...e.status }));
  }

  private activeCount(accountId: string): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.status.accountId === accountId && e.status.state === "running") n++;
    }
    return n;
  }

  private cancelWhere(pred: (e: Entry) => boolean, reason: string): void {
    for (const e of [...this.entries.values()]) {
      if (e.status.state === "running" && pred(e)) this.finish(e, "canceled", reason);
    }
  }

  private async fire(id: string, index: number): Promise<void> {
    const e = this.entries.get(id);
    if (!e || e.status.state !== "running") return;
    // Re-check stop conditions at fire time.
    if (this.deps.isKillSwitchOn()) return this.finish(e, "canceled", "kill_switch");
    if (!this.deps.isEngineUp()) return this.finish(e, "canceled", "engine_unavailable");

    const qty = e.quantities[index];
    if (qty === undefined) return;
    const order: TwapChildOrder = {
      orderId: `t${id}-${index + 1}`,
      twapId: id,
      accountId: e.status.accountId,
      symbol: e.status.symbol,
      side: e.status.side,
      venue: e.status.venue,
      qtyLots: qty,
      type: "market",
      source: "twap",
    };
    let result: SubmitResult;
    try {
      result = await this.deps.submit(order);
    } catch {
      result = { ok: false, reason: "submit_error" };
    }
    // State may have changed while awaiting (cancel, restart).
    if (e.status.state !== "running") return;
    if (!result.ok) return this.finish(e, "failed", result.reason);

    e.status.sent += 1;
    if (e.status.sent >= e.status.slices) this.finish(e, "completed", null);
    else this.emit(e);
  }

  private finish(e: Entry, state: TwapState, reason: string | null): void {
    for (const c of e.cancelTimers) c();
    e.cancelTimers = [];
    e.status.state = state;
    e.status.reason = reason;
    this.emit(e);
  }

  private emit(e: Entry): void {
    this.deps.onStatus({ ...e.status });
  }
}
