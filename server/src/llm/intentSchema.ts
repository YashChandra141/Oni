// Trading intent that the LLM may produce (Req 23.2, design "LLM_Order_Parser").
//
// Two descriptions of the same shape:
//   - INTENT_JSON_SCHEMA is sent to OpenAI (Responses API, `text.format`, strict mode). Strict
//     mode needs every property in `required`, `additionalProperties: false` on every object, and
//     "optional" fields written as a union with null. Source:
//     https://developers.openai.com/api/docs/guides/structured-outputs (Supported schemas).
//   - IntentSchema is the Zod schema the LLM_Order_Parser (Task 13.2) uses to validate the
//     returned value. The model's output is untrusted input (trading-safety rule 4).
// A test keeps the two in step.

import { z } from "zod";

/** Plain unsigned decimal: digits with an optional fractional part. No sign, exponent, or spaces. */
export const DECIMAL_PATTERN = "^[0-9]+(\\.[0-9]+)?$";
const DECIMAL_RE = new RegExp(DECIMAL_PATTERN);

export const INTENT_ACTIONS = ["place", "cancel_all", "flatten", "unclear"] as const;
export const INTENT_SIDES = ["buy", "sell"] as const;
export const INTENT_ORDER_TYPES = ["market", "limit", "stop"] as const;

/** Name of the JSON-schema format sent to OpenAI. */
export const INTENT_SCHEMA_NAME = "trading_intent";

export const INTENT_JSON_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [...INTENT_ACTIONS],
      description: "place = new order, cancel_all = cancel open orders, flatten = close all positions, unclear = not sure",
    },
    side: { type: ["string", "null"], enum: [...INTENT_SIDES, null], description: "buy or sell; null unless action is place" },
    symbol: { type: ["string", "null"], description: "Symbol such as BTC-USD; null unless action is place" },
    amount: {
      anyOf: [
        {
          type: "object",
          properties: { absolute: { type: "string", pattern: DECIMAL_PATTERN, description: "Base-asset quantity as a decimal string" } },
          required: ["absolute"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            percent_of_position: { type: "number", minimum: 0, maximum: 100, description: "Percent of the current position, 0 to 100" },
          },
          required: ["percent_of_position"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
      description: "Order size; null unless action is place",
    },
    order_type: { type: ["string", "null"], enum: [...INTENT_ORDER_TYPES, null], description: "null unless action is place" },
    price: {
      anyOf: [
        {
          type: "object",
          properties: { absolute: { type: "string", pattern: DECIMAL_PATTERN, description: "Price as a decimal string" } },
          required: ["absolute"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            relative_to_last_pct: { type: "number", description: "Percent offset from the last price; negative is below" },
          },
          required: ["relative_to_last_pct"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
      description: "Limit or stop price; null for market orders",
    },
  },
  required: ["action", "side", "symbol", "amount", "order_type", "price"],
  additionalProperties: false,
} as const;

const DecimalString = z.string().regex(DECIMAL_RE);

export const AmountSchema = z.union([
  z.strictObject({ absolute: DecimalString }),
  z.strictObject({ percent_of_position: z.number().min(0).max(100) }),
]);

export const PriceSchema = z.union([
  z.strictObject({ absolute: DecimalString }),
  z.strictObject({ relative_to_last_pct: z.number().finite() }),
]);

/** The intent. Every field is present; fields that do not apply are null. */
export const IntentSchema = z.strictObject({
  action: z.enum(INTENT_ACTIONS),
  side: z.enum(INTENT_SIDES).nullable(),
  symbol: z.string().nullable(),
  amount: AmountSchema.nullable(),
  order_type: z.enum(INTENT_ORDER_TYPES).nullable(),
  price: PriceSchema.nullable(),
});

export type LlmIntent = z.infer<typeof IntentSchema>;
