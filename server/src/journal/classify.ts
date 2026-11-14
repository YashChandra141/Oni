// Pure classifier for Journal write errors (design Decision J4).
//
// `poison`: a deterministic data or constraint error that no retry can fix. The writer drops
// the offending record. `unreachable`: everything else, including unknown errors, so a record
// is never dropped by mistake (Req 20.10).
//
// Codes (Prisma error reference): P2000 value too long, P2002 unique constraint, P2006 invalid
// value, P2007 data validation, P2011 null constraint, P2020 value out of range.
// TODO(Task 11.5): confirm against a live Postgres through @prisma/adapter-pg which of these
// the adapters raise for int8 overflow and similar (driver adapters may report them as P2010
// or an unmapped DriverAdapterError, which then counts as unreachable).

export type ErrorClass = "poison" | "unreachable";

export const POISON_CODES: ReadonlySet<string> = new Set(["P2000", "P2002", "P2006", "P2007", "P2011", "P2020"]);

export function classifyPrismaError(err: unknown): ErrorClass {
  if (typeof err !== "object" || err === null) return "unreachable";
  const { name, code } = err as { name?: unknown; code?: unknown };
  if (name === "PrismaClientValidationError") return "poison";
  if (name === "PrismaClientKnownRequestError" && typeof code === "string" && POISON_CODES.has(code)) return "poison";
  return "unreachable";
}
