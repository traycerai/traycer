import { describe, expect, it } from "vitest";
import {
  canReceiveA2AMessages,
  canUseA2ATools,
  type A2ACapabilityTarget,
} from "@traycer/protocol/host/agent/shared";

/**
 * Outbound tool access and inbound message delivery are deliberately two
 * separate questions (see the doc comment on `canUseA2ATools`): a terminal
 * harness can hold the shared catalog with no inbox transport (Codex,
 * OpenCode), and every GUI surface gets both regardless of harness. This
 * table pins the full matrix so a future harness addition can't silently
 * regress either arm.
 */
const MATRIX: ReadonlyArray<{
  readonly label: string;
  readonly target: A2ACapabilityTarget;
  readonly useTools: boolean;
  readonly receiveMessages: boolean;
}> = [
  {
    label: "GUI claude",
    target: { surface: "gui", harnessId: "claude" },
    useTools: true,
    receiveMessages: true,
  },
  {
    label: "GUI codex",
    target: { surface: "gui", harnessId: "codex" },
    useTools: true,
    receiveMessages: true,
  },
  {
    label: "GUI opencode",
    target: { surface: "gui", harnessId: "opencode" },
    useTools: true,
    receiveMessages: true,
  },
  {
    label: "GUI cursor",
    target: { surface: "gui", harnessId: "cursor" },
    useTools: true,
    receiveMessages: true,
  },
  {
    label: "TUI claude",
    target: { surface: "tui", harnessId: "claude" },
    useTools: true,
    receiveMessages: true,
  },
  {
    label: "TUI codex",
    target: { surface: "tui", harnessId: "codex" },
    useTools: true,
    receiveMessages: false,
  },
  {
    label: "TUI opencode",
    target: { surface: "tui", harnessId: "opencode" },
    useTools: true,
    receiveMessages: false,
  },
  {
    label: "TUI cursor",
    // Cursor declares no TUI harness adapter at all - reserved id only.
    target: { surface: "tui", harnessId: "cursor" },
    useTools: false,
    receiveMessages: false,
  },
];

describe("A2A capability predicates", () => {
  for (const row of MATRIX) {
    it(`${row.label}: canUseA2ATools=${row.useTools}, canReceiveA2AMessages=${row.receiveMessages}`, () => {
      expect(canUseA2ATools(row.target)).toBe(row.useTools);
      expect(canReceiveA2AMessages(row.target)).toBe(row.receiveMessages);
    });
  }

  it("every harness that can RECEIVE can also USE tools - delivery never outruns catalog access", () => {
    for (const row of MATRIX) {
      if (row.receiveMessages) {
        expect(row.useTools).toBe(true);
      }
    }
  });

  it("a GUI target is always capable regardless of an unrecognized/null harnessId", () => {
    for (const harnessId of [null, "some-future-harness"]) {
      const target: A2ACapabilityTarget = { surface: "gui", harnessId };
      expect(canUseA2ATools(target)).toBe(true);
      expect(canReceiveA2AMessages(target)).toBe(true);
    }
  });

  it("an unrecognized TUI harnessId gets neither capability", () => {
    const target: A2ACapabilityTarget = {
      surface: "tui",
      harnessId: "some-future-harness",
    };
    expect(canUseA2ATools(target)).toBe(false);
    expect(canReceiveA2AMessages(target)).toBe(false);
  });
});
