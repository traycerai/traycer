import type { MergedNotificationSource } from "@/stores/notifications/merged-notifications";

export type NotificationCategory = "task" | "collaboration" | "system";

export const ALL_NOTIFICATION_CATEGORIES: ReadonlySet<NotificationCategory> =
  new Set(["task", "collaboration", "system"]);

const CATEGORY_BY_SOURCE: Readonly<
  Record<MergedNotificationSource, NotificationCategory>
> = {
  host: "task",
  "app-local": "system",
  global: "collaboration",
};

/** Maps the internal source seam to the product vocabulary at the
 * projection boundary - callers outside the store never branch on `source`
 * directly. */
export function categoryForNotificationSource(
  source: MergedNotificationSource,
): NotificationCategory {
  return CATEGORY_BY_SOURCE[source];
}
