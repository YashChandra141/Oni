// Test helpers for the MCP client and tools (Task 14.1): a fake WebSocket with a scripted
// server side, and a fake fetch. No network. Not imported by production code.

import { INSTRUMENTS } from "../instruments.ts";
import type { ClientMessage, ServerMessage } from "../protocol.ts";
import type { FetchLike, WebSocketLike } from "./client.ts";

export const HELLO: ServerMessage = {
  type: "hello",
  protocol_version: 2,
  data_mode: "replay",
  venue: null,
  engine_running: true,
  instruments: INSTRUMENTS.map((i) => ({ ...i })),
};

export function session(accountId = "guest", address: string | null = null): ServerMessage {
  return { type: "session", account_id: accountId, address };
}

/** Called for each client message; reply with `ws.receive(...)`. */
export type ServerScript = (ws: FakeSocket, msg: ClientMessage) => void;

export interface FakeSocketOptions {
  /** Send Hello and Session(account) after open. Default true. */
  readonly greet?: boolean;
  /** Account in the greeting Session. Default `guest`. */
  readonly accountId?: string;
}

export class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly url: string;
  readonly sent: ClientMessage[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly #script: ServerScript;

  constructor(url: string, script: ServerScript, options: FakeSocketOptions) {
    this.url = url;
    this.#script = script;
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.({});
      if (options.greet ?? true) {
        this.receive(HELLO);
        this.receive(session(options.accountId ?? "guest"));
      }
    });
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket not open");
    const msg = JSON.parse(data) as ClientMessage;
    this.sent.push(msg);
    // Reply asynchronously, as a real server would.
    queueMicrotask(() => this.#script(this, msg));
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }

  /** Delivers one server message. */
  receive(msg: ServerMessage | Record<string, unknown>): void {
    if (this.readyState !== 1) return;
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** The server closes the connection. */
  serverClose(): void {
    this.close();
  }
}

/** A WebSocket constructor bound to a script; records every socket it creates. */
export function fakeWebSocket(script: ServerScript = () => {}, options: FakeSocketOptions = {}) {
  const sockets: FakeSocket[] = [];
  class Ctor extends FakeSocket {
    constructor(url: string) {
      super(url, script, options);
      sockets.push(this);
    }
  }
  return { WebSocket: Ctor, sockets };
}

export interface FetchCall {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** A fetch that answers from `route(url)` and records each call. */
export function fakeFetch(route: (url: string) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url: input, headers });
    return route(input);
  };
  return { fetch, calls };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A preview reply for a market buy of 0.01 BTC. */
export function previewReply(requestId: string, previewId = "p1"): ServerMessage {
  return {
    type: "preview",
    request_id: requestId,
    preview: {
      preview_id: previewId,
      text: "BUY BTC-USD 0.01",
      action: { type: "place", symbol: "BTC-USD", side: "buy", qty: "1000000", kind: { type: "market" } },
      expires_at: 1_700_000_030_000,
    },
  };
}

export function event(ev: Record<string, unknown>): Record<string, unknown> {
  return { type: "event", event: ev };
}
