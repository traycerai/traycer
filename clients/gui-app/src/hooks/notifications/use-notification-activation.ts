import { useCallback, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useHostBinding } from "@/lib/host";
import { resolveAppWideHostClient } from "@/lib/host/binding-host-client";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { readEffectiveHostIdSnapshot } from "@/stores/host/selection-authority-store";
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
  /** `"success"` unless the origin-host guard below trips, in which case `"failure"` - the row settles as unread/no-acknowledgment, same as a genuine failure but without an error toast (nothing actually failed). */
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
  // A parked browser session lives on ONE host for life, so a row routed
  // anywhere else opened nothing - same rule as a prompt.
  return (
    payload.kind === "approval" ||
    payload.kind === "interview" ||
    payload.kind === "browserSession"
  );
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

/** Route once per activate; do not move app-wide selection. Claim success only if an origin-required payload reached a target bound to its origin. */
export function useNotificationActivation(): NotificationActivationController {
  return useNotificationActivationWithNavigate(useNavigate());
}

/** The host notification stream intentionally mounts above `RouterProvider`, so its toast callback cannot use TanStack's ambient router context. */
export function useNotificationActivationWithNavigate(
  navigate: NotificationNavigate,
): NotificationActivationController {
  const binding = useHostBinding();
  const effectiveHostId = useEffectiveHostId();
  // APP-WIDE BY INTENT, and it must stay that way if this ever mounts under a host-scoped subtree.
  // `beforeRouteHostId`/`afterRouteHostId` below record which host the WINDOW was addressing across an activation (D7: it must not move) - that is a property of the window, not of whatever surface happens to be on screen, and a scoped panel's host would report a move that never happened.
  const client = useMemo(
    () => resolveAppWideHostClient(binding, effectiveHostId),
    [binding, effectiveHostId],
  );

  const activate = useCallback(
    (input: NotificationActivationInput) => {
      // Compare pointers, not a resolved row. Read live at click: a render-scoped `effectiveHostId` can already be stale before routing starts.
      const beforeRouteHostId =
        client === null ? null : readEffectiveHostIdSnapshot();
      // Origin-required routes may not fall back to a hostless intent. Refuse acknowledgment when origin and effective hosts are both known and differ.
      const requiresOriginHost = notificationPayloadRequiresOriginHost(
        input.payload,
      );
      const originHostId = input.originHostId ?? null;
      const routedToOriginBoundTarget = routeNotificationForHost(
        navigate,
        input.payload,
        input.receivedAt,
        {
          originHostId,
          effectiveHostId: beforeRouteHostId,
        },
      );
      if (
        requiresOriginHost &&
        !routedToOriginBoundTarget &&
        originHostId !== null &&
        effectiveHostId !== null &&
        originHostId !== effectiveHostId
      ) {
        input.onResult?.("failure");
        return;
      }
      if (
        !hostFeedStayedOnOrigin({
          feedId: input.feedId,
          beforeRouteHostId,
          // Read the store live, not the pinned requester or getAppHostClientSnapshot: the pinned client cannot observe an app-wide pointer move.
          afterRouteHostId:
            client === null ? null : readEffectiveHostIdSnapshot(),
        })
      ) {
        input.onResult?.("failure");
        return;
      }
      input.onResult?.("success");
    },
    [client, effectiveHostId, navigate],
  );

  return { activate };
}
