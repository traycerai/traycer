import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { IHostDirectoryService } from "@traycer-clients/shared/host-client/host-runtime";
import { useHostBinding } from "@/lib/host";
import { dialableHostEndpoint } from "@/lib/host/transport-key";
import {
  routeNotificationForHost,
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
  /** Cloud rows retain their owning host. Approval/interview navigation must
   * target that host rather than the relay host that delivered the feed. */
  readonly originHostId?: string | null;
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

export function notificationPayloadRequiresOriginHost(
  payload: NotificationPayload,
): boolean {
  return payload.kind === "approval" || payload.kind === "interview";
}

function ensureOriginHostSelected(input: {
  readonly payload: NotificationPayload;
  readonly originHostId: string | null | undefined;
  readonly directory: IHostDirectoryService | null;
}): boolean {
  if (!notificationPayloadRequiresOriginHost(input.payload)) {
    return true;
  }
  if (input.originHostId === undefined || input.originHostId === null) {
    return false;
  }
  if (input.directory === null) return false;
  const origin = input.directory.findById(input.originHostId);
  // Coarse read, through the canonical rule: this decides whether to SELECT the
  // origin host and route to it, which is only worth doing if a client can be
  // built for it — a pure yes/no about a route, with no per-reason copy hanging
  // off it. Asking `dialableHostEndpoint` rather than the bit directly is what
  // makes `indeterminate` route (the dial is attempted and fails recoverably)
  // instead of silently refusing to open an approval the user just clicked.
  if (origin === null || dialableHostEndpoint(origin) === null) return false;
  input.directory.selectById(origin.hostId);
  return true;
}

function hostFeedStayedOnOrigin(input: {
  readonly feedId: string | null;
  readonly beforeRouteHostId: string | null;
  readonly afterRouteHostId: string | null;
}): boolean {
  return (
    !isHostFeedId(input.feedId) ||
    input.afterRouteHostId === input.beforeRouteHostId
  );
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
  const directory = binding?.directory ?? null;

  const activate = useCallback(
    (input: NotificationActivationInput) => {
      if (
        !ensureOriginHostSelected({
          payload: input.payload,
          originHostId: input.originHostId,
          directory,
        })
      ) {
        input.onResult?.("failure");
        return;
      }
      const beforeRouteHostId = client?.getActiveHostId() ?? null;
      routeNotificationForHost(
        navigate,
        input.payload,
        input.receivedAt,
        input.originHostId ?? null,
      );
      if (
        !hostFeedStayedOnOrigin({
          feedId: input.feedId,
          beforeRouteHostId,
          afterRouteHostId: client?.getActiveHostId() ?? null,
        })
      ) {
        input.onResult?.("failure");
        return;
      }
      input.onResult?.("success");
    },
    [client, directory, navigate],
  );

  return { activate };
}
