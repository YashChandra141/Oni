// Docker smoke test (Req 41.3, 41.6), run by the `docker-smoke` CI job against the running
// Server_Image: wait for /health db "up" (Migrations applied by the Start_Script), open /ws,
// place a paper order on the guest account through CommandText -> Preview -> Confirm, receive a
// Fill, and poll /journal for the order and fill rows.
//
// Usage: bun server/scripts/smoke.ts            (env: SMOKE_BASE_URL, SMOKE_ORIGIN)
// Exits 0 on success, 1 with a clear message on failure. Paper only; talks to localhost.

import { z } from "zod";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:10000";
const ORIGIN = process.env.SMOKE_ORIGIN ?? "http://localhost:3000";
const WS_URL = `${BASE.replace(/^http/, "ws")}/ws`;
const ORDER_TEXT = "BUY BTC 0.001";
const HEALTH_TIMEOUT_MS = 120_000;
const ORDER_ATTEMPTS = 6;
const FILL_WAIT_MS = 10_000;
const JOURNAL_TIMEOUT_MS = 30_000;

const HealthSchema = z.object({ ok: z.literal(true), engine: z.string(), db: z.string() });
const WsMessageSchema = z
  .object({ type: z.string() })
  .passthrough();
const PreviewMessageSchema = z.object({
  type: z.literal("preview"),
  request_id: z.string(),
  preview: z.object({ preview_id: z.string() }),
});
const EventMessageSchema = z.object({
  type: z.literal("event"),
  event: z.object({ type: z.string(), order_id: z.string().optional(), account_id: z.string().optional(), reason: z.string().optional() }).passthrough(),
});
const JournalRowsSchema = z.array(
  z.object({ type: z.string(), order_id: z.string(), account_id: z.string() }).passthrough(),
);

class SmokeError extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const step = (msg: string) => console.log(`[smoke] ${msg}`);

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3_000) });
      const parsed = HealthSchema.safeParse(await res.json());
      if (!parsed.success) {
        last = "unexpected /health body";
      } else if (parsed.data.db === "up" && parsed.data.engine === "running") {
        step(`/health ok: engine ${parsed.data.engine}, db ${parsed.data.db}`);
        return;
      } else {
        last = `engine=${parsed.data.engine} db=${parsed.data.db}`;
      }
    } catch (err) {
      last = err instanceof Error ? err.name : "fetch failed";
    }
    await sleep(1_000);
  }
  throw new SmokeError(`/health did not report engine running and db "up" within ${HEALTH_TIMEOUT_MS} ms (last: ${last})`);
}

interface Inbox {
  readonly ws: WebSocket;
  next(match: (msg: Record<string, unknown>) => boolean, timeoutMs: number, what: string): Promise<Record<string, unknown>>;
}

async function openSocket(): Promise<Inbox> {
  // Bun's WebSocket accepts a headers option, used here to send an allowed Origin (Req 17.2).
  const ws = new WebSocket(WS_URL, { headers: { Origin: ORIGIN } } as unknown as string[]);
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (ev) => {
    try {
      const parsed = WsMessageSchema.safeParse(JSON.parse(String(ev.data)));
      if (parsed.success) queue.push(parsed.data);
    } catch {
      // Ignore non-JSON frames; the checks below time out with a clear message if needed.
    }
    for (const w of waiters.splice(0)) w();
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SmokeError("WebSocket did not open within 10 s")), 10_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new SmokeError(`WebSocket connection to ${WS_URL} failed (Origin ${ORIGIN})`));
    });
  });
  return {
    ws,
    async next(match, timeoutMs, what) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const i = queue.findIndex(match);
        if (i >= 0) return queue.splice(i, 1)[0] as Record<string, unknown>;
        const left = deadline - Date.now();
        if (left <= 0) throw new SmokeError(`timed out after ${timeoutMs} ms waiting for ${what}`);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, left);
          waiters.push(() => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    },
  };
}

const send = (ws: WebSocket, msg: unknown) => ws.send(JSON.stringify(msg));

async function placeUntilFill(inbox: Inbox): Promise<string> {
  for (let attempt = 1; attempt <= ORDER_ATTEMPTS; attempt++) {
    const requestId = `smoke-${attempt}`;
    send(inbox.ws, { type: "command_text", request_id: requestId, text: ORDER_TEXT });
    const raw = await inbox.next(
      (m) => (m.type === "preview" || m.type === "parse_error") && m.request_id === requestId,
      10_000,
      `a Preview for "${ORDER_TEXT}"`,
    );
    const preview = PreviewMessageSchema.safeParse(raw);
    if (!preview.success) throw new SmokeError(`"${ORDER_TEXT}" was not previewed: ${JSON.stringify(raw)}`);
    step(`preview ${preview.data.preview.preview_id}; confirming`);
    send(inbox.ws, { type: "confirm", request_id: `${requestId}-c`, preview_id: preview.data.preview.preview_id });

    try {
      const raw = await inbox.next(
        (m) => {
          const e = EventMessageSchema.safeParse(m);
          return e.success && (e.data.event.type === "fill" || e.data.event.type === "order_rejected");
        },
        FILL_WAIT_MS,
        "a Fill",
      );
      const ev = EventMessageSchema.parse(raw).event;
      if (ev.type === "fill") {
        if (ev.account_id !== "guest") throw new SmokeError(`Fill carried account ${String(ev.account_id)}, expected guest`);
        step(`fill received for order ${String(ev.order_id)}`);
        return String(ev.order_id);
      }
      // The replay may not have a book yet; try again.
      step(`order rejected (${String(ev.reason)}); retrying`);
    } catch (err) {
      if (!(err instanceof SmokeError)) throw err;
      step(`no fill yet (attempt ${attempt}/${ORDER_ATTEMPTS})`);
    }
    await sleep(2_000);
  }
  throw new SmokeError(`no Fill after ${ORDER_ATTEMPTS} order attempts`);
}

async function waitForJournal(orderId: string): Promise<void> {
  const deadline = Date.now() + JOURNAL_TIMEOUT_MS;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/journal`, { headers: { Origin: ORIGIN }, signal: AbortSignal.timeout(5_000) });
      if (res.status !== 200) {
        last = `HTTP ${res.status}`;
      } else {
        const rows = JournalRowsSchema.parse(await res.json());
        const mine = rows.filter((r) => r.order_id === orderId && r.account_id === "guest");
        const hasOrder = mine.some((r) => r.type === "order");
        const hasFill = mine.some((r) => r.type === "fill");
        if (hasOrder && hasFill) {
          step(`/journal holds the order and fill rows for ${orderId}`);
          return;
        }
        last = `order row: ${hasOrder}, fill row: ${hasFill}, rows: ${rows.length}`;
      }
    } catch (err) {
      last = err instanceof Error ? err.name : "request failed";
    }
    await sleep(1_000);
  }
  throw new SmokeError(`/journal lacked the order and fill rows for ${orderId} within ${JOURNAL_TIMEOUT_MS} ms (last: ${last})`);
}

async function main(): Promise<void> {
  await waitForHealth();
  const inbox = await openSocket();
  try {
    await inbox.next((m) => m.type === "hello", 10_000, "the Hello message");
    step("connected to /ws");
    send(inbox.ws, { type: "subscribe", symbol: "BTC-USD", timeframe: "1m" });
    const orderId = await placeUntilFill(inbox);
    await waitForJournal(orderId);
  } finally {
    inbox.ws.close();
  }
  step("PASS");
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`[smoke] FAIL: ${err instanceof Error ? err.message : "unknown error"}`);
    process.exit(1);
  },
);
