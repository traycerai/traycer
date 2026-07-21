import { describe, expect, it } from "vitest";
import {
  ALL_NOTIFICATION_CATEGORIES,
  categoryForNotificationSource,
  type NotificationCategory,
} from "@/lib/notifications/notification-category";
import type { MergedNotificationSource } from "@/stores/notifications/merged-notifications";

describe("categoryForNotificationSource", () => {
  it("maps every internal source seam to product vocabulary", () => {
    const mapping: ReadonlyArray<
      readonly [MergedNotificationSource, NotificationCategory]
    > = [
      ["host", "task"],
      ["app-local", "system"],
      ["global", "collaboration"],
    ];

    for (const [source, category] of mapping) {
      expect(categoryForNotificationSource(source)).toBe(category);
    }
  });

  it("exposes an exhaustive category set of the three product labels", () => {
    expect([...ALL_NOTIFICATION_CATEGORIES].sort()).toEqual([
      "collaboration",
      "system",
      "task",
    ]);
    expect(ALL_NOTIFICATION_CATEGORIES.size).toBe(3);
  });

  it("covers every category returned by the source map", () => {
    const sources: ReadonlyArray<MergedNotificationSource> = [
      "host",
      "app-local",
      "global",
    ];
    for (const source of sources) {
      expect(
        ALL_NOTIFICATION_CATEGORIES.has(categoryForNotificationSource(source)),
      ).toBe(true);
    }
  });
});
