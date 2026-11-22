// Copilot chat through the gateway with a fake provider (trading-safety rule 4).
import { describe, expect, test } from "bun:test";
import { FakePublisher, FakeSocket, FakeSupervisor, memoryLogger } from "../gateway/testing.ts";
import { type AiDeps, Gateway } from "../gateway/ws.ts";
import type { JsonLlmProvider, JsonRequest } from "../llm/provider.ts";

function harness(complete: (req: JsonRequest) => Promise<unknown>) {
  const provider: JsonLlmProvider = { id: "openai", model: "fake", completeJson: complete };
  const registry = {
    info: () => [],
    defaultId: () => "openai" as const,
    refresh: async () => {},
    get: () => provider,
  } as unknown as AiDeps["registry"];
  const publisher = new FakePublisher();
  const gateway = new Gateway({
    supervisor: new FakeSupervisor(),
    config: { dataMode: "replay", liveVenue: "backpack" },
    logger: memoryLogger(),
    randomUUID: () => "client-1",
  });
  gateway.setPublisher(publisher);
  gateway.setAi({
    registry,
    limiter: { acquire: () => ({ ok: true }) as never, release: () => {}, forget: () => {} },
    accounts: { positions: () => [], balance: () => null } as never,
  });
  const ws = new FakeSocket();
  publisher.sockets.add(ws);
  gateway.open(ws);
  const send = (msg: unknown) => gateway.message(ws, JSON.stringify(msg));
  const chatRequest = (text = "hi", symbol = "BTC-USD") =>
    send({ type: "ai_request", request_id: "c1", action: "chat", text, symbol, timeframe: "1h", venue: "replay" });
  const settle = async (type: string) => {
    for (let i = 0; i < 100; i++) {
      const found = ws.messages().find((m) => m.type === type);
      if (found !== undefined) return found;
      await new Promise((r) => setTimeout(r, 5));
    }
    return undefined;
  };
  return { ws, send, chatRequest, settle };
}

describe("copilot chat", () => {
  test("a chat round trip returns ai_chat with the cleaned reply", async () => {
    const h = harness(async () => ({ reply: "  Hello!\u0007 " }));
    h.chatRequest();
    expect(await h.settle("ai_chat")).toEqual({ type: "ai_chat", request_id: "c1", text: "Hello!" });
  });

  test("chat works with a symbol that is not in the instrument table", async () => {
    const h = harness(async () => ({ reply: "hey" }));
    h.chatRequest("hi", "NOPE-USD");
    expect(await h.settle("ai_chat")).toMatchObject({ type: "ai_chat", text: "hey" });
  });

  test("invalid provider output gives ai_error", async () => {
    const h = harness(async () => ({ nope: 1 }));
    h.chatRequest();
    expect(await h.settle("ai_error")).toMatchObject({ type: "ai_error", request_id: "c1", reason: "validation_error" });
  });

  test("ai_cancel aborts the request", async () => {
    const h = harness(
      (req) =>
        new Promise((_, reject) => {
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    h.chatRequest();
    await new Promise((r) => setTimeout(r, 10));
    h.send({ type: "ai_cancel", request_id: "c1" });
    expect(await h.settle("ai_error")).toMatchObject({ type: "ai_error", request_id: "c1", reason: "canceled" });
  });

  test("a reply that looks like an order produces only ai_chat, no preview or command", async () => {
    const h = harness(async () => ({ reply: "BUY BTC 1" }));
    h.chatRequest();
    await h.settle("ai_chat");
    const types = h.ws.messages().map((m) => m.type);
    expect(types).not.toContain("preview");
    expect(types).not.toContain("analysis");
    expect(h.ws.messages().find((m) => m.type === "ai_chat")).toMatchObject({ text: "BUY BTC 1" });
  });
});
