import { describe, expect, it } from "vitest";
import { officeFlagKind } from "@/components/epic-canvas/comm-graph/office/office-flag-kind";
import { attentionTone } from "@/components/notifications/notification-indicator-tones";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";

function state(
  overrides: Partial<NotificationIndicatorState>,
): NotificationIndicatorState {
  return {
    unreadFailure: false,
    unreadNonTerminalFailure: false,
    unreadTerminalFailure: false,
    pendingFork: false,
    pendingApproval: false,
    pendingInterview: false,
    unreadDone: false,
    ...overrides,
  };
}

/**
 * The office splits one notification signal into two pictures - a crashed
 * screen and a "!" bubble - and the split has to agree with `attentionTone`,
 * which is what decides an agent is flagged at all. Each case below asserts
 * BOTH: that the tone still fires, and which picture it resolves to.
 */
describe("officeFlagKind", () => {
  it("reads a non-terminal failure as a crash", () => {
    const failing = state({
      unreadFailure: true,
      unreadNonTerminalFailure: true,
    });
    expect(attentionTone(failing)).not.toBeNull();
    expect(officeFlagKind(failing)).toBe("failure");
  });

  it("derives the crash from the older two-flag shape as well", () => {
    // `unreadNonTerminalFailure` is optional on rows written before it existed;
    // the fallback is the same one `attentionTone` applies.
    const legacy = state({
      unreadFailure: true,
      unreadNonTerminalFailure: undefined,
      unreadTerminalFailure: false,
    });
    expect(officeFlagKind(legacy)).toBe("failure");
  });

  it("does NOT crash a desk for a terminal agent's historical failure", () => {
    // That failure stays in the feed, but a newer running turn is allowed to
    // own the desk - so it must not paint a cracked screen.
    const terminal = state({
      unreadFailure: true,
      unreadNonTerminalFailure: false,
      unreadTerminalFailure: true,
    });
    expect(officeFlagKind(terminal)).toBe("attention");
  });

  it("reads a pending interview as someone waiting on a person", () => {
    const interview = state({ pendingInterview: true });
    expect(attentionTone(interview)).not.toBeNull();
    expect(officeFlagKind(interview)).toBe("attention");
  });

  it("reads a pending approval and a paused fork the same way", () => {
    expect(officeFlagKind(state({ pendingApproval: true }))).toBe("attention");
    expect(officeFlagKind(state({ pendingFork: true }))).toBe("attention");
  });
});
