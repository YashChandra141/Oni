// A JournalStore that loads the Prisma-backed store on first use, with a dynamic import, so no
// other module imports the generated client (it exists only after `prisma generate`) and tests
// that never touch Postgres never load it.

import type { Config } from "../config.ts";
import type { JournalStore } from "./store.ts";

export function createLazyPrismaStore(
  config: Pick<Config, "databaseUrl" | "dbAdapter">,
  log: { warn(line: string): void; error(line: string): void },
  redact: (text: string) => string,
): JournalStore {
  let pending: Promise<JournalStore> | null = null;
  const load = (): Promise<JournalStore> => {
    pending ??= import("./prisma.ts")
      .then((m) => m.createPrismaJournalStore(config, log, redact))
      .catch((err: unknown) => {
        pending = null; // retry the import on the next call
        throw err;
      });
    return pending;
  };
  return {
    insertBatch: async (records) => (await load()).insertBatch(records),
    listOrders: async (q) => (await load()).listOrders(q),
    listJournal: async (q) => (await load()).listJournal(q),
    ping: async () => (await load()).ping(),
    close: async () => {
      if (pending === null) return;
      const store = await pending.catch(() => null);
      await store?.close();
    },
  };
}
