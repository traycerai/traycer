import { describe, expect, it } from "vitest";
import {
  terminalAgentRelocationHeldReason,
  terminalAgentRelocationHoldIsHostWide,
} from "@/lib/terminal-agent-relocation-held";

describe("terminalAgentRelocationHoldIsHostWide", () => {
  it("is host-wide for the marker message, and the reason is still read after the ordinary prefix", () => {
    const error = {
      message:
        "RELOCATION_HELD_HOST_WIDE RELOCATION_HELD: Files moved; every agent is held.",
    };
    expect(terminalAgentRelocationHoldIsHostWide(error)).toBe(true);
    expect(terminalAgentRelocationHeldReason(error)).toBe(
      "Files moved; every agent is held.",
    );
  });

  it("is host-wide when a transport wrapper precedes the marker", () => {
    const error = {
      message:
        "E_INVALID_ARGUMENT: RELOCATION_HELD_HOST_WIDE RELOCATION_HELD: x",
    };
    expect(terminalAgentRelocationHoldIsHostWide(error)).toBe(true);
    expect(terminalAgentRelocationHeldReason(error)).toBe("x");
  });

  it("is not host-wide for a plain relocation hold, which still has a reason", () => {
    const error = { message: "RELOCATION_HELD: x" };
    expect(terminalAgentRelocationHoldIsHostWide(error)).toBe(false);
    expect(terminalAgentRelocationHeldReason(error)).toBe("x");
  });

  it("is not host-wide for null, a missing message or an unrelated error", () => {
    expect(terminalAgentRelocationHoldIsHostWide(null)).toBe(false);
    expect(terminalAgentRelocationHoldIsHostWide({})).toBe(false);
    expect(terminalAgentRelocationHoldIsHostWide({ message: "boom" })).toBe(
      false,
    );
    expect(
      terminalAgentRelocationHoldIsHostWide({ message: "SOURCE_NOT_READY: x" }),
    ).toBe(false);
  });
});
