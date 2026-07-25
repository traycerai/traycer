import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsNotificationSurface,
} from "@/lib/analytics";
import { classifyNotificationLifecycle } from "@/lib/notifications/notification-lifecycle";
import type { NotificationActivationOutcome } from "@/hooks/notifications/use-notification-activation";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";

/**
 * Every activation surface (center, toast, native) must emit the same
 * `notification_activation_completed` / `notification_marked_read` pair from
 * the same terminal `onResult` boundary - this is the one definition all of
 * them share so a surface can't drift out of lockstep with the others.
 * `row` is nullable because a native click's correlated row can be missing
 * (e.g. already pruned) while the activation itself still proceeds.
 */
export function activationResultHandler(input: {
  readonly row: MergedNotificationRow | null;
  readonly feedId: string;
  readonly surface: AnalyticsNotificationSurface;
  readonly markAsRead: (feedId: string) => void;
  readonly onSuccess: (() => void) | null;
}): (outcome: NotificationActivationOutcome) => void {
  return (outcome) => {
    if (input.row !== null) {
      Analytics.getInstance().track(
        AnalyticsEvent.NotificationActivationCompleted,
        {
          category: input.row.category,
          section: classifyNotificationLifecycle(input.row).section,
          surface: input.surface,
          outcome,
        },
      );
    }
    if (outcome !== "success") return;
    if (input.row !== null) {
      Analytics.getInstance().track(AnalyticsEvent.NotificationMarkedRead, {
        category: input.row.category,
        acknowledgment_source: "activation",
      });
    }
    input.markAsRead(input.feedId);
    input.onSuccess?.();
  };
}
