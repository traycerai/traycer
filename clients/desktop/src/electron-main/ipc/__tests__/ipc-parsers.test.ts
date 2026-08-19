import { describe, expect, it, vi } from "vitest";
import { parseQuitDecision } from "../ipc-parsers";

vi.mock("../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

// F6: `parseQuitDecision` used to accept its known members through an `if`
// chain and fall back to "proceed" - i.e. quit - for everything else. Adding
// `userCancelled` to the `QuitDecision` union left that chain compiling, so a
// renderer answering "do not quit" would have been parsed as "quit". This
// pins the new member is actually recognized, not just added to the type.
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
