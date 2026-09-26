import { describe, expect, it, vi } from "vitest";
import { parseHostQuitDecision } from "../host-quit-ipc";

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  describeLogError: (cause: unknown) => String(cause),
}));

// The handlers themselves are exercised through the real bridge in
// `host-quit-bridge.test.ts`; this file pins the decision parser.
describe("parseHostQuitDecision", () => {
  it("accepts exactly the three decision shapes", () => {
    expect(parseHostQuitDecision({ kind: "keep", remember: true })).toEqual({
      kind: "keep",
      remember: true,
    });
    expect(
      parseHostQuitDecision({ kind: "stop", force: false, remember: true }),
    ).toEqual({ kind: "stop", force: false, remember: true });
    expect(parseHostQuitDecision({ kind: "cancel" })).toEqual({
      kind: "cancel",
    });
  });

  it("drops extra fields rather than passing them through", () => {
    expect(
      parseHostQuitDecision({ kind: "keep", remember: false, extra: 1 }),
    ).toEqual({ kind: "keep", remember: false });
    expect(parseHostQuitDecision({ kind: "cancel", remember: true })).toEqual({
      kind: "cancel",
    });
  });

  it("rejects anything else", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "stop",
      7,
      [],
      {},
      { kind: "keep" },
      { kind: "keep", remember: "true" },
      { kind: "stop", remember: true },
      { kind: "stop", force: 1, remember: true },
      { kind: "stop", force: true },
      { kind: "quit" },
    ];
    for (const value of bad) {
      expect(parseHostQuitDecision(value)).toBeNull();
    }
  });
});
