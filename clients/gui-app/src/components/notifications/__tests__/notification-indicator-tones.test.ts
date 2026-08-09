import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_STATUS_TONES,
  notificationFeedTone,
} from "@/components/notifications/notification-indicator-tones";

describe("notification status tone registry", () => {
  it.each([
    ["approval.requested", null, "approval"],
    ["interview.requested", null, "interview"],
    ["approval.requested", 10, "approval-resolved"],
    ["interview.requested", 10, "interview-resolved"],
  ] as const)(
    "maps %s resolved at %s to the shared %s presentation",
    (hostKind, resolvedAt, status) => {
      expect(
        notificationFeedTone({
          severity: "needs_action",
          hostKind,
          resolvedAt,
        }),
      ).toBe(NOTIFICATION_STATUS_TONES[status]);
    },
  );

  it.each([
    ["approval", "approval-resolved"],
    ["interview", "interview-resolved"],
  ] as const)(
    "preserves the %s glyph when its notification is resolved",
    (pendingKind, resolvedKind) => {
      expect(NOTIFICATION_STATUS_TONES[resolvedKind].Icon).toBe(
        NOTIFICATION_STATUS_TONES[pendingKind].Icon,
      );
      expect(NOTIFICATION_STATUS_TONES[resolvedKind].className).toBe(
        NOTIFICATION_STATUS_TONES[pendingKind].className,
      );
      expect(NOTIFICATION_STATUS_TONES[resolvedKind].Icon).not.toBe(
        NOTIFICATION_STATUS_TONES.done.Icon,
      );
    },
  );

  it("maps terminal outcomes through the same done and failure presentations", () => {
    expect(
      notificationFeedTone({
        severity: "done",
        hostKind: "agent.stopped",
        resolvedAt: null,
      }),
    ).toBe(NOTIFICATION_STATUS_TONES.done);
    expect(
      notificationFeedTone({
        severity: "failure",
        hostKind: "agent.stalled",
        resolvedAt: null,
      }),
    ).toBe(NOTIFICATION_STATUS_TONES.failure);
  });

  it("leaves informational events to their surface-specific neutral icon", () => {
    expect(
      notificationFeedTone({
        severity: "info",
        hostKind: "host.operation.finished",
        resolvedAt: null,
      }),
    ).toBeNull();
  });
});
