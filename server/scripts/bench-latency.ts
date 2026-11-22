// Latency bench (oni-terminal-v2 Task 13.5, Req 33.6, 33.7).
//
// Spawns the server with the real replay engine on a free loopback port, opens N WebSocket
// clients with an allowed Origin, subscribes all ten symbols on `replay`, and sends
// command_text + confirm on the guest account. Prints p50/p95 per stage and exits non-zero
// when a p95 exceeds its target (times CI_LATENCY_FACTOR, default 2, with --check).
//
// Usage: bun server/scripts/bench-latency.ts [--check]
// Env: ENGINE_PATH (default rust/target/debug/engine[.exe]), BENCH_CLIENTS (8), BENCH_SECONDS (15),
//      BENCH_ORDERS (50), CI_LATENCY_FACTOR (2). Paper only; no real venue is contacted.

import { z } from "zod";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const ORIGIN = "http://localhost:3000";
const SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD", "BNB-USD", "XRP-USD", "DOGE-USD", "JUP-USD", "WIF-USD", "BONK-USD", "PEPE-USD"];
const CHECK = process.argv.includes("--check");

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const CLIENTS = intEnv("BENCH_CLIENTS", 8);
const SECONDS = intEnv("BENCH_SECONDS", 15);
const ORDERS = intEnv("BENCH_ORDERS", 50);
const FACTOR = CHECK ? intEnv("CI_LATENCY_FACTOR", 2) : 1;
const ENGINE_PATH =
  process.env.ENGINE_PATH ?? `${ROOT}rust/target/debug/engine${process.platform === "win32" ? ".exe" : ""}`;

/** Targets in milliseconds (Req 33). */
const TARGETS = {
  emit_to_write: 25,
  command_to_preview: 50,
  confirm_to_ack: 100,
  receipt_to_client: 50,
} as const;
type Stage = keyof typeof TARGETS;

const Summary = z.object({ count: z.number(), p50_us: z.number().nullable(), p95_us: z.number().nullable() });
const HealthSchema = z.object({
  engine: z.string(),
  latency: z.object({
    emit_to_write: Summary,
    command_to_preview: Summary,
    confirm_to_ack: Summary,
    receipt_to_client: Summary,
  }),
});
const Msg = z.object({ type: z.string() }).passthrough();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function pct(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
}

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port;
  void s.stop(true);
  if (port === undefined) throw new Error("could not find a free port");
  return port;
}

async function waitHealthy(base: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
      const h = HealthSchema.safeParse(await res.json());
      if (h.success && h.data.engine === "running") return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error("server did not report the engine running within 30 s");
}

interface Client {
  readonly ws: WebSocket;
  readonly previews: Map<string, (m: Record<string, unknown>) => void>;
  readonly acks: Map<string, (at: number) => void>;
}

async function openClient(wsUrl: string): Promise<Client> {
  const ws = new WebSocket(wsUrl, { headers: { Origin: ORIGIN } } as unknown as string[]);
  const previews = new Map<string, (m: Record<string, unknown>) => void>();
  const acks = new Map<string, (at: number) => void>();
  ws.addEventListener("message", (ev) => {
    const at = performance.now();
    let raw: unknown;
    try {
      raw = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const m = Msg.safeParse(raw);
    if (!m.success) return;
    if (m.data.type === "preview" || m.data.type === "parse_error") {
      const id = String(m.data.request_id);
      previews.get(id)?.(m.data);
      previews.delete(id);
      return;
    }
    const events: unknown[] =
      m.data.type === "event" ? [m.data.event] : m.data.type === "event_batch" && Array.isArray(m.data.events) ? m.data.events : [];
    for (const e of events) {
      const p = z.object({ type: z.string(), order_id: z.string().optional() }).passthrough().safeParse(e);
      if (!p.success) continue;
      const t = p.data.type;
      if (t === "order_ack" || t === "order_rejected") {
        acks.get("*")?.(at);
        acks.delete("*");
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("WebSocket open timed out")), 10_000);
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(t);
      reject(new Error("WebSocket error"));
    });
  });
  for (const symbol of SYMBOLS) ws.send(JSON.stringify({ type: "subscribe", venue: "replay", symbol, timeframe: "1m" }));
  return { ws, previews, acks };
}

const PreviewShape = z.object({ type: z.literal("preview"), preview: z.object({ preview_id: z.string() }) });

function once<T>(register: (cb: (v: T) => void) => void, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    register((v) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}

async function main(): Promise<boolean> {
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = Bun.spawn(["bun", "server/scripts/start.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_MODE: "replay",
      REPLAY_SPEED: "50",
      ENGINE_PATH,
      ALLOWED_ORIGINS: ORIGIN,
      WEB_URL: ORIGIN,
      KILL_SWITCH: "false",
      NODE_ENV: "development",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const clients: Client[] = [];
  const previewMs: number[] = [];
  const ackMs: number[] = [];
  try {
    await waitHealthy(base);
    for (let i = 0; i < CLIENTS; i++) clients.push(await openClient(`ws://127.0.0.1:${port}/ws`));
    console.log(`[bench] ${CLIENTS} clients, ${SYMBOLS.length} symbols, ${SECONDS}s, ${ORDERS} orders`);
    await sleep(2_000);

    const driver = clients[0];
    if (driver === undefined) throw new Error("no client");
    const started = Date.now();
    const gap = Math.max(20, Math.floor((SECONDS * 1000) / ORDERS));
    for (let i = 0; i < ORDERS; i++) {
      const id = `bench-${i}`;
      const t0 = performance.now();
      driver.ws.send(JSON.stringify({ type: "command_text", request_id: id, text: "BUY BTC 0.001", venue: "replay" }));
      const reply = await once<Record<string, unknown>>((cb) => driver.previews.set(id, cb), 5_000);
      const t1 = performance.now();
      const pv = PreviewShape.safeParse(reply);
      if (pv.success) {
        previewMs.push(t1 - t0);
        // The order id is server-assigned; any ack for this account after confirm marks the ack.
        const ackId = pv.data.preview.preview_id;
        driver.ws.send(JSON.stringify({ type: "confirm", request_id: `${id}-c`, preview_id: ackId }));
        const tc = performance.now();
        const at = await once<number>((cb) => driver.acks.set("*", cb), 3_000);
        driver.acks.delete("*");
        if (at !== null) ackMs.push(at - tc);
      }
      await sleep(gap);
      if (Date.now() - started > SECONDS * 1000 + 10_000) break;
    }
    await sleep(500);

    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) });
    const health = HealthSchema.parse(await res.json());

    const measured: Record<Stage, { n: number; p50: number | null; p95: number | null }> = {
      emit_to_write: toMs(health.latency.emit_to_write),
      command_to_preview: toMs(health.latency.command_to_preview),
      confirm_to_ack: toMs(health.latency.confirm_to_ack),
      receipt_to_client: toMs(health.latency.receipt_to_client),
    };
    const sp = [...previewMs].sort((a, b) => a - b);
    const sa = [...ackMs].sort((a, b) => a - b);
    console.log(`[bench] client round trip: preview n=${sp.length} p50=${fmt(pct(sp, 50))} p95=${fmt(pct(sp, 95))}; ack n=${sa.length} p50=${fmt(pct(sa, 50))} p95=${fmt(pct(sa, 95))}`);

    let ok = true;
    for (const stage of Object.keys(TARGETS) as Stage[]) {
      const m = measured[stage];
      const limit = TARGETS[stage] * FACTOR;
      const pass = m.n > 0 && m.p95 !== null && m.p95 <= limit;
      if (!pass) ok = false;
      console.log(`[bench] ${stage.padEnd(18)} n=${m.n} p50=${fmt(m.p50)} p95=${fmt(m.p95)} target<=${limit} ms ${pass ? "ok" : "FAIL"}`);
    }
    const clientPreviewP95 = pct(sp, 95);
    if (clientPreviewP95 === null || clientPreviewP95 > TARGETS.command_to_preview * FACTOR) {
      ok = false;
      console.log(`[bench] client preview round trip p95 ${fmt(clientPreviewP95)} over ${TARGETS.command_to_preview * FACTOR} ms FAIL`);
    }
    return ok;
  } finally {
    for (const c of clients) {
      try {
        c.ws.close();
      } catch {
        // ignore
      }
    }
    server.kill();
    await Promise.race([server.exited, sleep(3_000)]);
    if (server.exitCode === null) server.kill(9);
  }
}

function toMs(s: z.infer<typeof Summary>): { n: number; p50: number | null; p95: number | null } {
  return { n: s.count, p50: s.p50_us === null ? null : s.p50_us / 1000, p95: s.p95_us === null ? null : s.p95_us / 1000 };
}
const fmt = (v: number | null): string => (v === null ? "n/a" : `${v.toFixed(2)}ms`);

const watchdog = setTimeout(() => {
  console.error("[bench] overall timeout");
  process.exit(1);
}, (SECONDS + 90) * 1000);

main().then(
  (ok) => {
    clearTimeout(watchdog);
    process.exit(ok ? 0 : 1);
  },
  (err: unknown) => {
    console.error(`[bench] FAIL: ${err instanceof Error ? err.message : "unknown error"}`);
    process.exit(1);
  },
);
