// Property P27 — validates Req 20.23, 20.30
//
// The same JournalStore contract runs against MemoryJournalStore always, and against the Prisma
// store (through @prisma/adapter-pg, DB_ADAPTER=pg) only when TEST_DATABASE_URL is set. The
// Postgres suite expects the Migrations already applied with `prisma migrate deploy`, and
// refuses to run when TEST_DATABASE_URL equals DATABASE_URL or DIRECT_URL.
import { afterAll, beforeAll, describe } from "bun:test";
import { MemoryJournalStore } from "./memory.ts";
import { type PgHarness, openPgHarness, pgEnabled } from "./pg.testing.ts";
import { runJournalContract } from "./store.contract.ts";

runJournalContract("MemoryJournalStore", () => ({
  store: new MemoryJournalStore(),
  dispose: async () => {},
}));

describe.skipIf(!pgEnabled)("PrismaJournalStore (Postgres, TEST_DATABASE_URL)", () => {
  let pg: PgHarness | undefined;

  beforeAll(async () => {
    pg = await openPgHarness(); // throws when the URL equals DATABASE_URL or DIRECT_URL
  });

  afterAll(async () => {
    await pg?.close();
  });

  runJournalContract(
    "PrismaJournalStore",
    async () => {
      if (pg === undefined) throw new Error("Postgres harness is not open");
      await pg.clear();
      return { store: pg.store, dispose: async () => {} };
    },
    { numRuns: 25, timeoutMs: 300_000 },
  );
});
