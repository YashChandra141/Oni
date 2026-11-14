import { describe, expect, test } from "bun:test";
import { pickAdapter } from "./adapter.ts";

describe("pickAdapter (Decision J3)", () => {
  test("DB_ADAPTER=pg always picks pg, even for a Neon host", () => {
    expect(pickAdapter("postgresql://u:p@ep-x.us-east-2.aws.neon.tech/db", "pg")).toBe("pg");
  });

  test("a host ending in .neon.tech picks neon", () => {
    expect(pickAdapter("postgresql://u:p@ep-x-pooler.us-east-2.aws.neon.tech/db?sslmode=require", undefined)).toBe("neon");
  });

  test("other hosts pick pg", () => {
    expect(pickAdapter("postgresql://u:p@localhost:5432/db", undefined)).toBe("pg");
    expect(pickAdapter("postgresql://u:p@db.example.com/db", undefined)).toBe("pg");
    expect(pickAdapter("postgresql://u:p@neon.tech.evil.com/db", undefined)).toBe("pg");
  });

  test("an unparsable URL falls back to pg", () => {
    expect(pickAdapter("not a url", undefined)).toBe("pg");
  });
});
