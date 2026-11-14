// Test support for the Postgres-gated journal tests (Task 11.5). Not a test file.
//
// The URL comes from TEST_DATABASE_URL only. It must name a database that is NOT the application
// database: `pgTestUrl()` throws when it equals DATABASE_URL or DIRECT_URL. The schema must
// already exist (`prisma migrate deploy` against the test database). The generated client and
// `prisma.ts` load through dynamic imports, so a suite that skips never needs `prisma generate`.
//
// The test database URL is never logged, printed, or put in an error message.

import type { JournalStore } from "./store.ts";

type PrismaModule = typeof import("../generated/prisma/client.ts");
/** A plain Prisma client for raw SQL in tests (the store keeps its own client private). */
export type RawClient = InstanceType<PrismaModule["PrismaClient"]>;

export interface PgHarness {
  /** The real PrismaJournalStore, built the way production builds it, with DB_ADAPTER=pg. */
  readonly store: JournalStore;
  readonly raw: RawClient;
  /** Empties the three tables with a `$executeRaw` tagged template. The sequence keeps counting. */
  clear(): Promise<void>;
  close(): Promise<void>;
}

/** True when the Postgres-gated suites should run. */
export const pgEnabled: boolean = (process.env.TEST_DATABASE_URL ?? "") !== "";

/** TEST_DATABASE_URL, or a throw when it is unset or equals DATABASE_URL or DIRECT_URL. */
export function pgTestUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const url = env.TEST_DATABASE_URL;
  if (url === undefined || url === "") throw new Error("TEST_DATABASE_URL is not set");
  for (const name of ["DATABASE_URL", "DIRECT_URL"] as const) {
    const other = env[name];
    if (other !== undefined && other !== "" && other.trim() === url.trim()) {
      throw new Error(`refusing to run: TEST_DATABASE_URL equals ${name}`);
    }
  }
  return url;
}

const quietLog = { warn: (_line: string): void => {}, error: (_line: string): void => {} };

export async function openPgHarness(): Promise<PgHarness> {
  const url = pgTestUrl();
  const { createPrismaJournalStore } = await import("./prisma.ts");
  const { PrismaClient } = await import("../generated/prisma/client.ts");
  const { PrismaPg } = await import("@prisma/adapter-pg");

  const store = createPrismaJournalStore({ databaseUrl: url, dbAdapter: "pg" }, quietLog, (text) => text);
  const raw = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url, max: 2, connectionTimeoutMillis: 5_000 }),
  });
  return {
    store,
    raw,
    clear: async () => {
      await raw.$executeRaw`TRUNCATE TABLE orders, fills, rejections`;
    },
    close: async () => {
      await store.close();
      await raw.$disconnect();
    },
  };
}
