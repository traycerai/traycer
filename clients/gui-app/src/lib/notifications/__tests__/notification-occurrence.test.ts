import { describe, expect, it } from "vitest";
import { occurrenceKeyForNotification } from "@/lib/notifications/notification-occurrence";

describe("occurrenceKeyForNotification", () => {
  it("formats as feedId@createdAt", () => {
    expect(
      occurrenceKeyForNotification({
        feedId: "host:approval-1",
        createdAt: 1_700_000_000_000,
      }),
    ).toBe("host:approval-1@1700000000000");
  });

  it("mints a new key when the same feed id arrives with a new createdAt", () => {
    const first = occurrenceKeyForNotification({
      feedId: "host:n-1",
      createdAt: 100,
    });
    const second = occurrenceKeyForNotification({
      feedId: "host:n-1",
      createdAt: 200,
    });
    expect(first).toBe("host:n-1@100");
    expect(second).toBe("host:n-1@200");
    expect(first).not.toBe(second);
  });

  it("keeps the same key for a content-only retitle at the same createdAt", () => {
    // Title/body are intentionally not part of the key: a retitle of the same
    // arrival must not look like a new occurrence to live-arrival detection.
    const original = occurrenceKeyForNotification({
      feedId: "app-local:setup-failed",
      createdAt: 50,
    });
    const retitled = occurrenceKeyForNotification({
      feedId: "app-local:setup-failed",
      createdAt: 50,
    });
    expect(original).toBe(retitled);
    expect(original).toBe("app-local:setup-failed@50");
  });

  it("distinguishes different feed ids even at the same timestamp", () => {
    expect(
      occurrenceKeyForNotification({ feedId: "host:a", createdAt: 10 }),
    ).not.toBe(
      occurrenceKeyForNotification({ feedId: "host:b", createdAt: 10 }),
    );
  });
});
