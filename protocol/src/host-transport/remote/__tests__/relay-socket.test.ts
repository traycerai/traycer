import { describe, expect, it } from "vitest";
import { relayPrevQueryValue } from "../relay-socket";

describe("relayPrevQueryValue", () => {
  it.each([
    [1012, "host superseded", "1012:host-superseded"],
    [1012, "session reset by host", "1012:session-reset-by-host"],
    [1008, "reauth_timeout", "1008:reauth-timeout"],
    [1006, "", "1006:"],
    [4004, "  Relay -- No Pong!! ", "4004:relay-no-pong"],
  ])("(%i, %j) gives %s", (code, reason, expected) => {
    expect(relayPrevQueryValue(code, reason)).toBe(expected);
  });

  it("truncates a 200-character reason to a value of at most 64 characters ending in [a-z0-9]", () => {
    const value = relayPrevQueryValue(4004, "word ".repeat(40));
    expect(value.length).toBeLessThanOrEqual(64);
    expect(value).toMatch(/^[0-9]{1,4}:[a-z0-9-]*$/);
    expect(value).toMatch(/[a-z0-9]$/);
    expect(value.startsWith("4004:word-word")).toBe(true);
  });

  it("trims a dash the cut leaves at the end", () => {
    // The slug is 58 x's, a dash, then "yz"; the cut at 59 characters of
    // reason lands right after the dash.
    expect(relayPrevQueryValue(4004, `${"x".repeat(58)} yz`)).toBe(
      `4004:${"x".repeat(58)}`,
    );
  });
});
