import { describe, expect, it } from "vitest";
import { classifyReachability } from "../shared/reachability";

describe("classifyReachability", () => {
  it("maps ok to reachable", () => {
    expect(classifyReachability({ kind: "ok" })).toEqual({
      kind: "reachable",
    });
  });

  it("maps refused to unreachable(refused)", () => {
    expect(classifyReachability({ kind: "refused" })).toEqual({
      kind: "unreachable",
      reason: "refused",
    });
  });

  it("maps timeout to unreachable(timeout)", () => {
    expect(classifyReachability({ kind: "timeout" })).toEqual({
      kind: "unreachable",
      reason: "timeout",
    });
  });

  it("maps handshake-failed to unreachable(handshake-failed)", () => {
    expect(classifyReachability({ kind: "handshake-failed" })).toEqual({
      kind: "unreachable",
      reason: "handshake-failed",
    });
  });

  it("maps probe-error to indeterminate — never to unreachable", () => {
    expect(classifyReachability({ kind: "probe-error" })).toEqual({
      kind: "indeterminate",
      cause: "probe-error",
    });
  });
});
