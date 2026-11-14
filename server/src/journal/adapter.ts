// Driver adapter choice (design Decision J3). Pure.
//
// `@prisma/adapter-neon` reaches Neon's proxy and does not work against a plain Postgres
// server (CI container, local Docker), so the choice depends on the DATABASE_URL host.

export type AdapterKind = "pg" | "neon";

export function pickAdapter(databaseUrl: string, dbAdapter: "pg" | undefined): AdapterKind {
  if (dbAdapter === "pg") return "pg";
  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    return "pg";
  }
  return hostname.endsWith(".neon.tech") ? "neon" : "pg";
}
