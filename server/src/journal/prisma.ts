// PrismaJournalStore (design Decisions J3, J6). Loaded ONLY through a dynamic import in
// journal/lazy.ts, because the generated client (`server/src/generated/prisma/`, gitignored)
// exists only after `bun run db:generate`. This file does not typecheck before that.
//
// Uses only the Prisma Client API and `$queryRaw` tagged templates, never
// `$queryRawUnsafe` / `$executeRawUnsafe` (trading-safety rule 7).

import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Config } from "../config.ts";
import { PrismaClient } from "../generated/prisma/client.ts";
import { pickAdapter } from "./adapter.ts";
import { classifyPrismaError } from "./classify.ts";
import {
  type FillRow,
  type JournalRecord,
  type JournalRow,
  type JournalStore,
  type ListQuery,
  type OrderRow,
  type RejectionRow,
  mergeJournal,
} from "./store.ts";

export { classifyPrismaError };

interface PoolConfig {
  readonly connectionString: string;
  readonly max: number;
  readonly idleTimeoutMillis: number;
  readonly connectionTimeoutMillis: number;
}

export function createPrismaJournalStore(
  config: Pick<Config, "databaseUrl" | "dbAdapter">,
  log: { warn(line: string): void; error(line: string): void },
  redact: (text: string) => string,
): JournalStore {
  const url = config.databaseUrl;
  if (url === undefined) throw new Error("DATABASE_URL is required for the Prisma journal store");
  const pool: PoolConfig = {
    connectionString: url,
    max: 4,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 5_000,
  };
  const adapter = pickAdapter(url, config.dbAdapter) === "neon" ? new PrismaNeon(pool) : new PrismaPg(pool);
  const prisma = new PrismaClient({
    adapter,
    log: [
      { emit: "event", level: "warn" },
      { emit: "event", level: "error" },
    ],
  });
  // Prisma log events may quote connection details: redact before logging (rule 6).
  prisma.$on("warn", (e: { message: string }) => log.warn(`[prisma] ${redact(e.message)}`));
  prisma.$on("error", (e: { message: string }) => log.error(`[prisma] ${redact(e.message)}`));
  return new PrismaJournalStore(prisma);
}

type Client = InstanceType<typeof PrismaClient>;

export class PrismaJournalStore implements JournalStore {
  readonly #prisma: Client;

  constructor(prisma: Client) {
    this.#prisma = prisma;
  }

  /**
   * One `createMany({ skipDuplicates: true })` per run of same-kind records, in queue order,
   * inside one batch transaction, so `seq` follows enqueue order across the tables (P26).
   */
  async insertBatch(records: readonly JournalRecord[]): Promise<void> {
    if (records.length === 0) return;
    const p = this.#prisma;
    const ops = [];
    let i = 0;
    while (i < records.length) {
      const first = records[i];
      if (first === undefined) break;
      let j = i;
      while (j < records.length && records[j]?.type === first.type) j += 1;
      const run = records.slice(i, j);
      i = j;
      switch (first.type) {
        case "order":
          ops.push(
            p.journalOrder.createMany({
              data: run.flatMap((r) => (r.type === "order" ? [orderData(r)] : [])),
              skipDuplicates: true,
            }),
          );
          break;
        case "fill":
          ops.push(
            p.journalFill.createMany({
              data: run.flatMap((r) => (r.type === "fill" ? [fillData(r)] : [])),
              skipDuplicates: true,
            }),
          );
          break;
        case "rejection":
          ops.push(
            p.journalRejection.createMany({
              data: run.flatMap((r) => (r.type === "rejection" ? [rejectionData(r)] : [])),
              skipDuplicates: true,
            }),
          );
          break;
      }
    }
    await p.$transaction(ops);
  }

  async listOrders(q: ListQuery): Promise<OrderRow[]> {
    return mergeJournal([await this.#orders(q)], q.limit);
  }

  async listJournal(q: ListQuery): Promise<JournalRow[]> {
    const [orders, fills, rejections] = await Promise.all([this.#orders(q), this.#fills(q), this.#rejections(q)]);
    return mergeJournal<JournalRow>([orders, fills, rejections], q.limit);
  }

  async #orders(q: ListQuery): Promise<OrderRow[]> {
    const rows = await this.#prisma.journalOrder.findMany({
      where: where(q),
      orderBy: [{ ts: "desc" }, { seq: "desc" }],
      take: q.limit,
    });
    return rows.map(
      (r): OrderRow => ({
        type: "order",
        seq: r.seq,
        record_id: r.record_id,
        session_id: r.session_id,
        account_id: r.account_id,
        ts: r.ts,
        order_id: r.order_id,
        source: r.source as OrderRow["source"],
        symbol: r.symbol,
        side: r.side,
        kind: r.kind,
        qty: r.qty,
        price: r.price,
      }),
    );
  }

  async #fills(q: ListQuery): Promise<FillRow[]> {
    const rows = await this.#prisma.journalFill.findMany({
      where: where(q),
      orderBy: [{ ts: "desc" }, { seq: "desc" }],
      take: q.limit,
    });
    return rows.map(
      (r): FillRow => ({
        type: "fill",
        seq: r.seq,
        record_id: r.record_id,
        session_id: r.session_id,
        account_id: r.account_id,
        ts: r.ts,
        market_ts: r.market_ts,
        order_id: r.order_id,
        symbol: r.symbol,
        side: r.side,
        price: r.price,
        qty: r.qty,
        fee: r.fee,
        remaining: r.remaining,
      }),
    );
  }

  async #rejections(q: ListQuery): Promise<RejectionRow[]> {
    const rows = await this.#prisma.journalRejection.findMany({
      where: where(q),
      orderBy: [{ ts: "desc" }, { seq: "desc" }],
      take: q.limit,
    });
    return rows.map(
      (r): RejectionRow => ({
        type: "rejection",
        seq: r.seq,
        record_id: r.record_id,
        session_id: r.session_id,
        account_id: r.account_id,
        ts: r.ts,
        order_id: r.order_id,
        source: r.source as RejectionRow["source"],
        reason: r.reason,
        detail: r.detail,
      }),
    );
  }

  async ping(): Promise<void> {
    await this.#prisma.$queryRaw`SELECT 1`;
  }

  async close(): Promise<void> {
    await this.#prisma.$disconnect();
  }
}

function where(q: ListQuery): { account_id: string; session_id?: string } {
  return q.session === "all" ? { account_id: q.account } : { account_id: q.account, session_id: q.session };
}

function orderData(r: Extract<JournalRecord, { type: "order" }>) {
  return {
    record_id: r.record_id,
    session_id: r.session_id,
    account_id: r.account_id,
    ts: r.ts,
    order_id: r.order_id,
    source: r.source,
    symbol: r.symbol,
    side: r.side,
    kind: r.kind,
    qty: r.qty,
    price: r.price,
  };
}

function fillData(r: Extract<JournalRecord, { type: "fill" }>) {
  return {
    record_id: r.record_id,
    session_id: r.session_id,
    account_id: r.account_id,
    ts: r.ts,
    market_ts: r.market_ts,
    order_id: r.order_id,
    symbol: r.symbol,
    side: r.side,
    price: r.price,
    qty: r.qty,
    fee: r.fee,
    remaining: r.remaining,
  };
}

function rejectionData(r: Extract<JournalRecord, { type: "rejection" }>) {
  return {
    record_id: r.record_id,
    session_id: r.session_id,
    account_id: r.account_id,
    ts: r.ts,
    order_id: r.order_id,
    source: r.source,
    reason: r.reason,
    detail: r.detail,
  };
}
