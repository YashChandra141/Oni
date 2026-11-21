// GET /health (oni-terminal-v2 Req 1.9) and unknown routes.
import { describe, expect, test } from "bun:test";
import { configuredVenueHealth, createHttpApp } from "./http.ts";

const NO_LATENCY = { p50_ms: null, p95_ms: null };

describe("GET /health", () => {
  test("reports a running engine, its session id, venues, and latency, with no db field", async () => {
    const engine = { running: true, sessionId: "abc" };
    const app = createHttpApp({
      engine,
      venues: () => [configuredVenueHealth({ dataMode: "replay", liveVenue: "backpack" }, engine)],
    });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      ok: true,
      engine: "running",
      session_id: "abc",
      venues: [{ venue: "replay", status: "connected" }],
      latency: NO_LATENCY,
    });
    expect("db" in body).toBe(false);
  });

  test("still answers 200 while the engine is down", async () => {
    const engine = { running: false, sessionId: null };
    const app = createHttpApp({
      engine,
      venues: () => [configuredVenueHealth({ dataMode: "live", liveVenue: "coinbase" }, engine)],
    });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      engine: "stopped",
      session_id: null,
      venues: [{ venue: "coinbase", status: "down" }],
      latency: NO_LATENCY,
    });
  });

  test("reads engine state at request time", async () => {
    const engine = { running: false, sessionId: null as string | null };
    const app = createHttpApp({ engine });
    engine.running = true;
    engine.sessionId = "s2";
    expect(await (await app.request("/health")).json()).toMatchObject({ engine: "running", session_id: "s2", venues: [] });
  });
});

test("configuredVenueHealth: a running live venue is connecting until VenueStatus events exist", () => {
  expect(configuredVenueHealth({ dataMode: "live", liveVenue: "backpack" }, { running: true, sessionId: "s" })).toEqual({
    venue: "backpack",
    status: "connecting",
  });
});

test("unknown routes return 404 JSON", async () => {
  const app = createHttpApp({ engine: { running: true, sessionId: null } });
  const res = await app.request("/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
});
