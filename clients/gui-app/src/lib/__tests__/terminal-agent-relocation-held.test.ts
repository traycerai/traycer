import { describe, expect, it } from "vitest";
import { terminalAgentRelocationHeldReason } from "@/lib/terminal-agent-relocation-held";

describe("terminalAgentRelocationHeldReason", () => {
  it("returns null for a null error or a missing message", () => {
    expect(terminalAgentRelocationHeldReason(null)).toBeNull();
    expect(terminalAgentRelocationHeldReason({})).toBeNull();
  });

  it("returns null for an unrelated message", () => {
    expect(terminalAgentRelocationHeldReason({ message: "boom" })).toBeNull();
    expect(
      terminalAgentRelocationHeldReason({ message: "SOURCE_NOT_READY: x" }),
    ).toBeNull();
  });

  it("returns the trimmed reason after the prefix", () => {
    expect(
      terminalAgentRelocationHeldReason({
        message: "RELOCATION_HELD:   Files moved; cannot resume.  ",
      }),
    ).toBe("Files moved; cannot resume.");
  });

  it("finds the prefix when a transport wrapper precedes it", () => {
    expect(
      terminalAgentRelocationHeldReason({
        message: "E_INVALID_ARGUMENT: RELOCATION_HELD: Files moved.",
      }),
    ).toBe("Files moved.");
  });

  it("returns null when the prefix has an empty reason", () => {
    expect(
      terminalAgentRelocationHeldReason({ message: "RELOCATION_HELD:   " }),
    ).toBeNull();
    expect(
      terminalAgentRelocationHeldReason({ message: "RELOCATION_HELD:" }),
    ).toBeNull();
  });
});
