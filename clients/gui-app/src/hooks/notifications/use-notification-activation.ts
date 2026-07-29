import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useHostBinding } from "@/lib/host";
import {
  routeNotification,
  type NotificationNavigate,
  type NotificationPayload,
} from "@/lib/notifications";

export type NotificationActivationOutcome = "success" | "failure";

export interface NotificationActivationInput {
  readonly payload: NotificationPayload;
  readonly receivedAt: number;
  /** Feed correlation for this activation's acknowledgment. `null` when
   * there is no feed identity to acknowledge (a legacy native payload). */
  readonly feedId: string | null;
  /** Fires exactly once, synchronously, right after routing. `"success"`
   * unless the origin-host guard below trips, in which case `"failure"` -
   * the row settles as unread/no-acknowledgment, same as a genuine failure
   * but without an error toast (nothing actually failed). */
  readonly onResult: ((outcome: NotificationActivationOutcome) => void) | null;
}

export interface NotificationActivationController {
  readonly activate: (input: NotificationActivationInput) => void;
}

/** A durable host feed id is prefixed `host:` by `merged-notifications.ts`'s
 * `hostFeedId`; only those carry a host to guard against a switch. */
function isHostFeedId(feedId: string | null): boolean {
  return feedId !== null && feedId.startsWith("host:");
}

/**
 * Opens feed-backed notifications through the default host scope.
 *
 * Routes synchronously exactly once per `activate()` call, then completes
 * immediately - the destination enforces its own access (an unauthorized
 * user's epic/chat subscribe fails closed at `ensureEpicAccess`/cloud), so
 * this hook no longer runs a host preflight to gate completion. `onResult`
 * fires synchronously right after routing, so a caller closing on success
 * (the notification center) closes on dispatch; any resulting `markRead` is
 * a real background host write - success marks the row read, failure
 * leaves it unread via server truth (no optimistic read-state here for a
 * failed write to reconcile).
 *
 * The origin-host guard still applies to that acknowledgment: a host-scoped
 * feed id (`isHostFeedId`) only completes as `"success"` while the client's
 * CURRENT active host still matches the host captured just before routing -
 * routing itself can switch the app's active host (e.g. opening an epic
 * that lives on a different host), so this settles the row as unread/
 * no-acknowledgment rather than crediting the wrong host's notification.
 */
export function useNotificationActivation(): NotificationActivationController {
  return useNotificationActivationWithNavigate(useNavigate());
}

/**
 * Binds notification activation to an explicitly owned router.
 *
 * The host notification stream intentionally mounts above `RouterProvider`,
 * so its toast callback cannot use TanStack's ambient router context. The app
 * passes the per-window router's navigate function through this seam; routed
 * notification surfaces mounted below `RouterProvider` use the ambient hook
 * above.
 */
export function useNotificationActivationWithNavigate(
  navigate: NotificationNavigate,
): NotificationActivationController {
  const binding = useHostBinding();
  const client = binding?.hostClient ?? null;

  const activate = useCallback(
    (input: NotificationActivationInput) => {
      const originHostId = client?.getActiveHostId() ?? null;
      routeNotification(navigate, input.payload, input.receivedAt);
      if (
        isHostFeedId(input.feedId) &&
        (client?.getActiveHostId() ?? null) !== originHostId
      ) {
        input.onResult?.("failure");
        return;
      }
      input.onResult?.("success");
    },
    [client, navigate],
  );

  return { activate };
}
