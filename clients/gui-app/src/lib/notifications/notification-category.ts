import type { HostNotificationKind } from "@traycer/protocol/host/notifications/contracts";
import type { MergedNotificationSource } from "@/stores/notifications/merged-notifications";

export type NotificationCategory = "task" | "collaboration" | "system";

export const ALL_NOTIFICATION_CATEGORIES: ReadonlySet<NotificationCategory> =
  new Set(["task", "collaboration", "system"]);

const CATEGORY_BY_SOURCE: Readonly<
  Record<MergedNotificationSource, NotificationCategory>
> = {
  host: "task",
  cloud: "task",
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

/**
 * The kinds whose subject answers for them instead of their lane. A host or
 * cloud row is one host's agent state, which is why its source answers; a
 * member's role change is membership news told to the person it happened to,
 * the twin of the task-sharing role change that reaches them as a `global`
 * row. It is filed where that twin is filed, so narrowing the center to
 * Collaboration keeps it and Task activity does not claim it.
 */
const CATEGORY_BY_HOST_KIND: Readonly<
  Partial<Record<HostNotificationKind, NotificationCategory>>
> = {
  "team.role.changed": "collaboration",
};

/**
 * The category of a host or cloud row: its kind, where that kind names its own
 * category, and otherwise its source.
 */
export function categoryForHostNotification(
  source: "host" | "cloud",
  kind: HostNotificationKind,
): NotificationCategory {
  return CATEGORY_BY_HOST_KIND[kind] ?? categoryForNotificationSource(source);
}
