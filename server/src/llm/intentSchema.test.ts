// Tests for the intent schemas (Req 23.2, Task 13.1): the JSON Schema sent to OpenAI and the
// Zod schema used to validate the answer must describe the same fields.
import { describe, expect, test } from "bun:test";
import {
  AmountSchema,
  INTENT_ACTIONS,
  INTENT_JSON_SCHEMA,
  INTENT_ORDER_TYPES,
  INTENT_SIDES,
  IntentSchema,
  PriceSchema,
} from "./intentSchema.ts";

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

/** Every object node must be strict-mode safe: all properties required, no extras allowed. */
function checkStrict(node: unknown, path: string, problems: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => checkStrict(child, `${path}[${i}]`, problems));
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const obj = node as Record<string, unknown>;
  if (obj["type"] === "object") {
    const props = Object.keys((obj["properties"] as Record<string, unknown> | undefined) ?? {});
    const required = (obj["required"] as string[] | undefined) ?? [];
    if (obj["additionalProperties"] !== false) problems.push(`${path}: additionalProperties is not false`);
    if (sorted(props).join() !== sorted(required).join()) problems.push(`${path}: required does not list every property`);
  }
  for (const [key, child] of Object.entries(obj)) checkStrict(child, `${path}.${key}`, problems);
}

describe("intent JSON Schema (OpenAI strict mode)", () => {
  test("every object lists all properties as required and forbids extras", () => {
    const problems: string[] = [];
    checkStrict(INTENT_JSON_SCHEMA, "$", problems);
    expect(problems).toEqual([]);
  });

  test("the root is a plain object, not anyOf", () => {
    expect(INTENT_JSON_SCHEMA.type).toBe("object");
    expect("anyOf" in INTENT_JSON_SCHEMA).toBe(false);
  });
});

describe("JSON Schema and Zod schema agree", () => {
  test("same top-level fields", () => {
    expect(sorted(Object.keys(INTENT_JSON_SCHEMA.properties))).toEqual(sorted(Object.keys(IntentSchema.shape)));
    expect(sorted(INTENT_JSON_SCHEMA.required)).toEqual(sorted(Object.keys(IntentSchema.shape)));
  });

  test("same enum values", () => {
    expect<readonly string[]>(INTENT_JSON_SCHEMA.properties.action.enum).toEqual([...IntentSchema.shape.action.options]);
    expect(IntentSchema.shape.action.options).toEqual([...INTENT_ACTIONS]);
    expect(INTENT_JSON_SCHEMA.properties.side.enum).toEqual([...INTENT_SIDES, null]);
    expect(INTENT_JSON_SCHEMA.properties.order_type.enum).toEqual([...INTENT_ORDER_TYPES, null]);
    expect([...IntentSchema.shape.side.unwrap().options]).toEqual([...INTENT_SIDES]);
    expect([...IntentSchema.shape.order_type.unwrap().options]).toEqual([...INTENT_ORDER_TYPES]);
  });

  test("same nested amount and price fields, plus null", () => {
    const jsonKeys = (branches: readonly unknown[]): string[][] =>
      branches
        .filter((b): b is { properties: Record<string, unknown> } => typeof b === "object" && b !== null && "properties" in b)
        .map((b) => Object.keys(b.properties));

    expect(jsonKeys(INTENT_JSON_SCHEMA.properties.amount.anyOf)).toEqual(AmountSchema.options.map((o) => Object.keys(o.shape)));
    expect(jsonKeys(INTENT_JSON_SCHEMA.properties.price.anyOf)).toEqual(PriceSchema.options.map((o) => Object.keys(o.shape)));
    expect(INTENT_JSON_SCHEMA.properties.amount.anyOf.at(-1)).toEqual({ type: "null" });
    expect(INTENT_JSON_SCHEMA.properties.price.anyOf.at(-1)).toEqual({ type: "null" });
    expect(IntentSchema.safeParse({ ...unclear, amount: null, price: null }).success).toBe(true);
  });

  test("the decimal pattern in the JSON Schema is the one Zod enforces", () => {
    const pattern = new RegExp(INTENT_JSON_SCHEMA.properties.amount.anyOf[0].properties.absolute.pattern);
    for (const [value, ok] of [["0.1", true], ["64000", true], ["-1", false], ["1e3", false], ["1.", false], [" 1", false]] as const) {
      expect(pattern.test(value)).toBe(ok);
      expect(AmountSchema.safeParse({ absolute: value }).success).toBe(ok);
    }
  });
});

const unclear = { action: "unclear", side: null, symbol: null, amount: null, order_type: null, price: null };

describe("IntentSchema", () => {
  test("accepts an unclear intent and a full limit order", () => {
    expect(IntentSchema.safeParse(unclear).success).toBe(true);
    const order = {
      action: "place",
      side: "buy",
      symbol: "BTC-USD",
      amount: { absolute: "0.1" },
      order_type: "limit",
      price: { relative_to_last_pct: -1 },
    } as const;
    expect(IntentSchema.parse(order)).toEqual(order);
  });

  test("accepts a percent-of-position amount and an absolute price", () => {
    const order = {
      action: "place",
      side: "sell",
      symbol: "ETH-USD",
      amount: { percent_of_position: 50 },
      order_type: "stop",
      price: { absolute: "3000.50" },
    };
    expect(IntentSchema.safeParse(order).success).toBe(true);
  });

  test("rejects extra fields, missing fields, bad enums, and bad numbers", () => {
    expect(IntentSchema.safeParse({ ...unclear, extra: 1 }).success).toBe(false);
    const { price: _price, ...missing } = unclear;
    expect(IntentSchema.safeParse(missing).success).toBe(false);
    expect(IntentSchema.safeParse({ ...unclear, action: "buy_now" }).success).toBe(false);
    expect(IntentSchema.safeParse({ ...unclear, amount: { percent_of_position: 150 } }).success).toBe(false);
    expect(IntentSchema.safeParse({ ...unclear, amount: { absolute: "1", percent_of_position: 5 } }).success).toBe(false);
    expect(IntentSchema.safeParse({ ...unclear, price: { relative_to_last_pct: Number.POSITIVE_INFINITY } }).success).toBe(false);
  });
});
