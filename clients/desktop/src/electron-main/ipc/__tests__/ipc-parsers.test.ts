import { describe, expect, it, vi } from "vitest";
import { parseQuitDecision } from "../ipc-parsers";

vi.mock("../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

// Adding `userCancelled` to the `QuitDecision` union left that chain compiling, so a renderer answering "do not quit" would have been parsed as "quit".
describe("parseQuitDecision", () => {
  it('accepts "userCancelled"', () => {
    expect(parseQuitDecision("userCancelled")).toBe("userCancelled");
  });

  it("still accepts the pre-existing members", () => {
    expect(parseQuitDecision("proceed")).toBe("proceed");
    expect(parseQuitDecision("userConfirmedDiscard")).toBe(
      "userConfirmedDiscard",
    );
  });

  it("falls back to userCancelled for anything it does not recognize", () => {
    expect(parseQuitDecision("something-else")).toBe("userCancelled");
    expect(parseQuitDecision(undefined)).toBe("userCancelled");
    expect(parseQuitDecision(null)).toBe("userCancelled");
    expect(parseQuitDecision(42)).toBe("userCancelled");
  });
});
