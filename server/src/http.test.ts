// GET /health (Req 17.5, 17.8) and unknown routes.
import { describe, expect, test } from "bun:test";
import { createHttpApp } from "./http.ts";

describe("GET /health", () => {
  test("reports a running engine and its session id", async () => {
    const app = createHttpApp({ engine: { running: true, sessionId: "abc" } });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, engine: "running", db: "unknown", session_id: "abc" });
  });

  test("still answers 200 while the engine is down", async () => {
    const app = createHttpApp({ engine: { running: false, sessionId: null } });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, engine: "stopped", db: "unknown", session_id: null });
  });

  test("reads engine state at request time", async () => {
    const engine = { running: false, sessionId: null as string | null };
    const app = createHttpApp({ engine });
    engine.running = true;
    engine.sessionId = "s2";
    expect(await (await app.request("/health")).json()).toMatchObject({ engine: "running", session_id: "s2" });
  });
});

test("unknown routes return 404 JSON", async () => {
  const app = createHttpApp({ engine: { running: true, sessionId: null } });
  const res = await app.request("/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
});
