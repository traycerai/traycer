/**
 * `ownChatStatusKind` (F8): the ladder `chatDescendantKind` already pins,
 * plus the `unknown` arm - only reached when the ladder itself falls through
 * to idle AND the coverage argument says the plane excluded this chat's host
 * (`AgentActivityCoverage` `"unserved"`). `"covered"` and `"indeterminate"`
 * must keep today's idle (`null`) reading, and any ladder result above idle
 * (attention, a live tier, done) must outrank `unknown` regardless of
 * coverage - the whole point is that unknown is the LAST rung, not a new
 * precedence.
 */
import { describe, expect, it } from "vitest";
import { ownChatStatusKind } from "@/components/epic-canvas/sidebar/use-chat-archive-hidden-ids";
import { EMPTY_NOTIFICATION_INDICATOR_STATE } from "@/stores/notifications/notification-indicator-state";

const IDLE = EMPTY_NOTIFICATION_INDICATOR_STATE;
const APPROVAL = { ...IDLE, pendingApproval: true };
const DONE = { ...IDLE, unreadDone: true };

describe("ownChatStatusKind", () => {
  it("reads unknown only for an idle chat under unserved coverage", () => {
    expect(ownChatStatusKind(IDLE, undefined, "unserved")).toBe("unknown");
  });

  it("keeps the plain idle (null) reading under covered coverage", () => {
    expect(ownChatStatusKind(IDLE, undefined, "covered")).toBeNull();
  });

  it("keeps the plain idle (null) reading under indeterminate coverage", () => {
    expect(ownChatStatusKind(IDLE, undefined, "indeterminate")).toBeNull();
  });

  it("lets background work outrank unknown even under unserved coverage", () => {
    expect(ownChatStatusKind(IDLE, "background", "unserved")).toBe(
      "background",
    );
  });

  it("lets an attention tone outrank unknown even under unserved coverage", () => {
    expect(ownChatStatusKind(APPROVAL, undefined, "unserved")).toBe("approval");
  });

  it("lets unread-done outrank unknown even under unserved coverage", () => {
    expect(ownChatStatusKind(DONE, undefined, "unserved")).toBe("done");
  });

  it("is unaffected by coverage once a live tier is present, for every coverage value", () => {
    for (const coverage of ["covered", "unserved", "indeterminate"] as const) {
      expect(ownChatStatusKind(IDLE, "turn", coverage)).toBe("running");
    }
  });
});
