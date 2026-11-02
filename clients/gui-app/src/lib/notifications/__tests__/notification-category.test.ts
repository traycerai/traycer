import { describe, expect, it } from "vitest";
import {
  ALL_NOTIFICATION_CATEGORIES,
  categoryForHostNotification,
  categoryForNotificationSource,
  type NotificationCategory,
} from "@/lib/notifications/notification-category";
import type { MergedNotificationSource } from "@/stores/notifications/merged-notifications";

describe("notification category", () => {
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

  it("files a role change under Collaboration on both of its lanes", () => {
    // The task-sharing role change it mirrors is a `global` row, so it is a
    // Collaboration row; this one arrives as a host or cloud row, whose source
    // alone would file membership news under Task activity.
    expect(categoryForHostNotification("host", "team.role.changed")).toBe(
      "collaboration",
    );
    expect(categoryForHostNotification("cloud", "team.role.changed")).toBe(
      "collaboration",
    );
  });

  it("leaves every other host and cloud row to its source", () => {
    for (const source of ["host", "cloud"] as const) {
      expect(categoryForHostNotification(source, "approval.requested")).toBe(
        "task",
      );
      expect(
        categoryForHostNotification(source, "host.operation.finished"),
      ).toBe("task");
    }
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
