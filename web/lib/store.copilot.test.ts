import { describe, expect, test } from "bun:test";
import {
  MAX_COPILOT_MESSAGES,
  applyServerMessage,
  initialState,
  withCopilotCanceled,
  withCopilotCleared,
  withCopilotSent,
} from "./store";
import type { ServerMessage } from "../../shared/protocol/index";

const msg = (m: unknown): ServerMessage => m as ServerMessage;

describe("copilot chat transcript", () => {
  test("send adds a user bubble and opens the spinner", () => {
    const s = withCopilotSent(initialState(), "r1", "hello", 1000);
    expect(s.copilotMessages).toHaveLength(1);
    expect(s.copilotMessages[0]?.role).toBe("user");
    expect(s.copilotMessages[0]?.text).toBe("hello");
    expect(s.copilotPending["r1"]?.startedAt).toBe(1000);
  });

  test("ai_chat adds an assistant bubble and clears the spinner", () => {
    const s0 = withCopilotSent(initialState(), "r1", "hi");
    const s = applyServerMessage(s0, msg({ type: "ai_chat", request_id: "r1", text: "hey" }));
    expect(s.copilotMessages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.copilotMessages[1]?.text).toBe("hey");
    expect(s.copilotPending["r1"]).toBeUndefined();
  });

  test("ai_error adds an error bubble and clears the spinner", () => {
    const s0 = withCopilotSent(initialState(), "r2", "hi");
    const s = applyServerMessage(
      s0,
      msg({ type: "ai_error", request_id: "r2", reason: "provider_error", message: "boom" }),
    );
    expect(s.copilotMessages[1]?.role).toBe("error");
    expect(s.copilotMessages[1]?.text).toBe("provider_error: boom");
    expect(Object.keys(s.copilotPending)).toHaveLength(0);
  });

  test("cancel clears the spinner and clear empties the transcript", () => {
    const s0 = withCopilotSent(initialState(), "r3", "hi");
    const s1 = withCopilotCanceled(s0, "r3");
    expect(Object.keys(s1.copilotPending)).toHaveLength(0);
    expect(withCopilotCleared(s1).copilotMessages).toHaveLength(0);
  });

  test("the transcript is bounded to the last 100 entries", () => {
    let s = initialState();
    for (let i = 0; i < MAX_COPILOT_MESSAGES + 25; i += 1) s = withCopilotSent(s, `r${i}`, `m${i}`);
    expect(s.copilotMessages).toHaveLength(MAX_COPILOT_MESSAGES);
    expect(s.copilotMessages[MAX_COPILOT_MESSAGES - 1]?.text).toBe(`m${MAX_COPILOT_MESSAGES + 24}`);
    expect(s.copilotMessages[0]?.text).toBe("m25");
  });
});
