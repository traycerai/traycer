import { describe, expect, it } from "vitest";
import {
  terminalTabUsesLegacyReads,
  type TerminalTabControl,
} from "@/components/epic-canvas/canvas/use-terminal-tab-control";

function controlIn(mode: TerminalTabControl["mode"]): TerminalTabControl {
  return {
    mode,
    displayTitle: "Title",
    canMutate: false,
    rename: () => undefined,
  };
}

describe("terminalTabUsesLegacyReads", () => {
  it("is true only with no authority control or on a legacy host", () => {
    expect(terminalTabUsesLegacyReads(null)).toBe(true);
    expect(terminalTabUsesLegacyReads(controlIn("legacy"))).toBe(true);
  });

  it("is false on a capable host and while the capability is undecided, so no terminal.list is sent", () => {
    expect(terminalTabUsesLegacyReads(controlIn("capable"))).toBe(false);
    expect(terminalTabUsesLegacyReads(controlIn("unknown"))).toBe(false);
  });
});
