// Authenticate on connect and token clearing on auth notices (Task 20.1, Req 33.4, 47.6).
import { describe, expect, test } from "bun:test";
import { SESSION_STORAGE_KEY, createTokenSource, saveSession } from "./auth";
import { createTerminalSocket } from "./socket";
import type { SocketEvent } from "./socket";
import { FakeNetwork, ManualScheduler } from "./testing";
import { FAKE_ADDRESS, MemoryStorage } from "./testingWallet";

const NOW_MS = 1_700_000_000_000;
const NOW_S = NOW_MS / 1000;
const URL = "ws://localhost:8080/ws";

const HELLO = JSON.stringify({
  type: "hello",
  protocol_version: 2,
  data_mode: "replay",
  venue: null,
  engine_running: true,
  instruments: [],
});

function setup(exp: number | null) {
  const storage = new MemoryStorage();
  if (exp !== null) {
    saveSession(storage, { token: "secret.token", address: FAKE_ADDRESS, accountId: `w_${FAKE_ADDRESS}`, exp });
  }
  const network = new FakeNetwork();
  const scheduler = new ManualScheduler();
  const events: SocketEvent[] = [];
  const socket = createTerminalSocket(URL, {
    onEvent: (event) => events.push(event),
    createWebSocket: network.create,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    tokens: createTokenSource(storage, () => NOW_MS),
  });
  return { storage, network, scheduler, events, socket };
}

const authMessages = (sent: unknown[]) => sent.filter((m) => (m as { type: string }).type === "authenticate");

describe("authenticate after hello", () => {
  test("is sent after hello on every connect while a valid token is stored", () => {
    const { network, scheduler } = setup(NOW_S + 3600);
    network.last.open();
    expect(authMessages(network.last.sentMessages())).toHaveLength(0); // not before hello
    network.last.receive(HELLO);
    expect(authMessages(network.last.sentMessages())).toEqual([{ type: "authenticate", token: "secret.token" }]);

    network.last.fail();
    scheduler.advance(10_000);
    network.last.open();
    network.last.receive(HELLO);
    expect(authMessages(network.last.sentMessages())).toEqual([{ type: "authenticate", token: "secret.token" }]);
  });

  test("is not sent without a token", () => {
    const { network } = setup(null);
    network.last.open();
    network.last.receive(HELLO);
    expect(authMessages(network.last.sentMessages())).toHaveLength(0);
  });

  test("is not sent for an expired token, which is deleted", () => {
    const { network, storage } = setup(NOW_S - 1);
    network.last.open();
    network.last.receive(HELLO);
    expect(authMessages(network.last.sentMessages())).toHaveLength(0);
    expect(storage.data.has(SESSION_STORAGE_KEY)).toBe(false);
  });

  test("is not sent when the socket has no token source", () => {
    const network = new FakeNetwork();
    const scheduler = new ManualScheduler();
    createTerminalSocket(URL, {
      onEvent: () => {},
      createWebSocket: network.create,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
    });
    network.last.open();
    network.last.receive(HELLO);
    expect(authMessages(network.last.sentMessages())).toHaveLength(0);
  });
});

describe("auth notices", () => {
  const notice = (kind: string) => JSON.stringify({ type: "notice", kind, message: "m" });

  for (const kind of ["auth_failed", "session_expired", "signed_out"]) {
    test(`${kind} deletes the stored token and still reaches the store`, () => {
      const { network, storage, events } = setup(NOW_S + 3600);
      network.last.open();
      network.last.receive(notice(kind));
      expect(storage.data.has(SESSION_STORAGE_KEY)).toBe(false);
      expect(events.some((e) => e.type === "message" && e.message.type === "notice")).toBe(true);
    });
  }

  test("other notices keep the token", () => {
    const { network, storage } = setup(NOW_S + 3600);
    network.last.open();
    network.last.receive(notice("engine_down"));
    network.last.receive(notice("account_reset"));
    expect(storage.data.has(SESSION_STORAGE_KEY)).toBe(true);
  });
});
