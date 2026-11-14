import { describe, expect, test } from "bun:test";
import { POLL_CODE_ROUTE, RateLimiter } from "./ratelimit.ts";

function setup() {
  const clock = { ms: 0 };
  return { clock, limiter: new RateLimiter({ now: () => clock.ms }) };
}

describe("RateLimiter", () => {
  test("allows the limit, then blocks with Retry-After, then rolls over", () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < 5; i++) expect(limiter.check("/auth/pair", "1.1.1.1").allowed).toBe(true);
    clock.ms = 20_000;
    expect(limiter.check("/auth/pair", "1.1.1.1")).toEqual({ allowed: false, retryAfterSec: 40 });
    expect(limiter.check("/auth/pair", "2.2.2.2").allowed).toBe(true);
    clock.ms = 60_000;
    expect(limiter.check("/auth/pair", "1.1.1.1").allowed).toBe(true);
  });

  test("poll code rule allows one request per 2 seconds", () => {
    const { limiter, clock } = setup();
    expect(limiter.check(POLL_CODE_ROUTE, "K7QM4XZP").allowed).toBe(true);
    expect(limiter.check(POLL_CODE_ROUTE, "K7QM4XZP").allowed).toBe(false);
    clock.ms = 2_000;
    expect(limiter.check(POLL_CODE_ROUTE, "K7QM4XZP").allowed).toBe(true);
  });

  test("prune drops ended windows and an unknown route throws", () => {
    const { limiter, clock } = setup();
    limiter.check("/auth/nonce", "a");
    clock.ms = 60_000;
    limiter.prune();
    expect(limiter.size).toBe(0);
    expect(() => limiter.check("/nope", "a")).toThrow();
  });
});

describe("RateLimiter windows and routes", () => {
  test("retryAfterSec counts down and is never below 1", () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < 10; i++) expect(limiter.check("/auth/nonce", "ip").allowed).toBe(true);
    expect(limiter.check("/auth/nonce", "ip")).toEqual({ allowed: false, retryAfterSec: 60 });
    clock.ms = 100;
    expect(limiter.check("/auth/nonce", "ip")).toEqual({ allowed: false, retryAfterSec: 60 });
    clock.ms = 30_000;
    expect(limiter.check("/auth/nonce", "ip")).toEqual({ allowed: false, retryAfterSec: 30 });
    clock.ms = 59_999;
    expect(limiter.check("/auth/nonce", "ip")).toEqual({ allowed: false, retryAfterSec: 1 });
  });

  test("the window rolls over exactly at its end and starts a fresh count", () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < 10; i++) limiter.check("/auth/verify", "ip");
    clock.ms = 60_000;
    for (let i = 0; i < 10; i++) expect(limiter.check("/auth/verify", "ip").allowed).toBe(true);
    expect(limiter.check("/auth/verify", "ip").allowed).toBe(false);
  });

  test("blocked requests are not counted against the next window", () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < 20; i++) limiter.check("/auth/pair", "ip");
    clock.ms = 60_000;
    expect(limiter.check("/auth/pair", "ip").allowed).toBe(true);
  });

  test("routes are independent for the same key", () => {
    const { limiter } = setup();
    for (let i = 0; i < 5; i++) limiter.check("/auth/pair", "ip");
    expect(limiter.check("/auth/pair", "ip").allowed).toBe(false);
    expect(limiter.check("/auth/nonce", "ip").allowed).toBe(true);
    expect(limiter.check("/auth/pair/confirm", "ip").allowed).toBe(true);
  });

  test("poll per IP allows 60 per minute", () => {
    const { limiter } = setup();
    for (let i = 0; i < 60; i++) expect(limiter.check("/auth/pair/poll", "ip").allowed).toBe(true);
    expect(limiter.check("/auth/pair/poll", "ip").allowed).toBe(false);
  });

  test("poll code rule reports 2 seconds, then 1 second, and keys are independent", () => {
    const { limiter, clock } = setup();
    expect(limiter.check(POLL_CODE_ROUTE, "AAAAAAAA").allowed).toBe(true);
    expect(limiter.check(POLL_CODE_ROUTE, "AAAAAAAA")).toEqual({ allowed: false, retryAfterSec: 2 });
    clock.ms = 1_500;
    expect(limiter.check(POLL_CODE_ROUTE, "AAAAAAAA")).toEqual({ allowed: false, retryAfterSec: 1 });
    expect(limiter.check(POLL_CODE_ROUTE, "BBBBBBBB").allowed).toBe(true);
  });
});
