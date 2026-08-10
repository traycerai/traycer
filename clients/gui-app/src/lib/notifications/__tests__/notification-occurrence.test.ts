import { describe, expect, it } from "vitest";
import { occurrenceKeyForNotification } from "@/lib/notifications/notification-occurrence";

describe("occurrenceKeyForNotification", () => {
  it("is stable for the same feedId + createdAt + sourceRef", () => {
    const first = occurrenceKeyForNotification({
      feedId: "host:approval-1",
      createdAt: 1_700_000_000_000,
      sourceRef: "approval-1",
    });
    const second = occurrenceKeyForNotification({
      feedId: "host:approval-1",
      createdAt: 1_700_000_000_000,
      sourceRef: "approval-1",
    });
    expect(first).toBe(second);
  });

  it("mints a new key when the same feed id arrives with a new createdAt", () => {
    const first = occurrenceKeyForNotification({
      feedId: "host:n-1",
      createdAt: 100,
      sourceRef: "n-1",
    });
    const second = occurrenceKeyForNotification({
      feedId: "host:n-1",
      createdAt: 200,
      sourceRef: "n-1",
    });
    expect(first).not.toBe(second);
  });

  it("keeps the same key for a content-only retitle at the same createdAt and sourceRef", () => {
    // Title/body are intentionally not part of the key: a retitle of the same
    // arrival must not look like a new occurrence to live-arrival detection.
    const original = occurrenceKeyForNotification({
      feedId: "app-local:setup-failed",
      createdAt: 50,
      sourceRef: "setup-failed",
    });
    const retitled = occurrenceKeyForNotification({
      feedId: "app-local:setup-failed",
      createdAt: 50,
      sourceRef: "setup-failed",
    });
    expect(original).toBe(retitled);
  });

  it("mints a new key when sourceRef changes at the same feedId and createdAt", () => {
    // Same-millisecond prompt supersede: stable row id reopens under a fresh
    // approval/interview id without bumping createdAt.
    const prior = occurrenceKeyForNotification({
      feedId: "host:approval.requested:chat-1",
      createdAt: 100,
      sourceRef: "refA",
    });
    const reopened = occurrenceKeyForNotification({
      feedId: "host:approval.requested:chat-1",
      createdAt: 100,
      sourceRef: "refB",
    });
    expect(prior).not.toBe(reopened);
  });

  it("distinguishes different feed ids even at the same timestamp and sourceRef", () => {
    expect(
      occurrenceKeyForNotification({
        feedId: "host:a",
        createdAt: 10,
        sourceRef: "shared",
      }),
    ).not.toBe(
      occurrenceKeyForNotification({
        feedId: "host:b",
        createdAt: 10,
        sourceRef: "shared",
      }),
    );
  });

  it("treats null sourceRef as distinct from empty string and from a real ref", () => {
    const withNull = occurrenceKeyForNotification({
      feedId: "host:n",
      createdAt: 1,
      sourceRef: null,
    });
    const withEmpty = occurrenceKeyForNotification({
      feedId: "host:n",
      createdAt: 1,
      sourceRef: "",
    });
    const withRef = occurrenceKeyForNotification({
      feedId: "host:n",
      createdAt: 1,
      sourceRef: "ref",
    });
    expect(withNull).not.toBe(withEmpty);
    expect(withNull).not.toBe(withRef);
    expect(withEmpty).not.toBe(withRef);
  });
});
