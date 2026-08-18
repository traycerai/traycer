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
 * Activation does NOT move the app-wide selection (redesign P1.2, D7): the
 * routed surface resolves against the effective host or its own tab binding,
 * and a notification click is not the user answering "which host do you work
 * on" - that gesture exists only in Settings ▸ Activate. The origin-host
 * SELECTION that used to happen here is gone; the caller (the notification
 * center / focus bridge) is what decides a foreign-origin row is not
 * routable at all.
 *
 * What activation still owns is whether it may CLAIM the prompt was opened.
 * An origin-required payload (approval / interview) that did not reach a
 * target bound to its origin completes as `"failure"`, so the row stays
 * unread instead of being credited to a host that never showed it.
 *
 * The origin-host guard still applies to the acknowledgment: a host-scoped
 * feed id (`isHostFeedId`) only completes as `"success"` while the client's
 * CURRENT bound host still matches the host captured just before routing -
 * routing can still re-point the window through the authority (an epic that
 * lives on a different host), so this settles the row as unread/
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
  const effectiveHostId = useEffectiveHostId();
  // APP-WIDE BY INTENT, and it must stay that way if this ever mounts under a
  // host-scoped subtree. `beforeRouteHostId`/`afterRouteHostId` below record
  // which host the WINDOW was addressing across an activation (D7: it must not
  // move) - that is a property of the window, not of whatever surface happens
  // to be on screen, and a scoped panel's host would report a move that never
  // happened. Reading it off the spine stopped meaning anything when P4.2
  // deleted the active slot, so it resolves the effective host id instead.
  const client = useMemo(
    () => resolveAppWideHostClient(binding, effectiveHostId),
    [binding, effectiveHostId],
  );

  const activate = useCallback(
    (input: NotificationActivationInput) => {
      // BOTH sides of the comparison are the POINTER, not a resolved row.
      // Mixing the two terms would fire this guard whenever the effective
      // host's directory row had not landed yet (`getActiveHostId()` answers
      // `null` there while the pointer names a host) - a routing failure
      // reported for a window that never moved. `null` when there is no host
      // runtime at all, which keeps the no-runtime case reporting success.
      //
      // READ LIVE, same as the "after" read below: `effectiveHostId` is the
      // render-scoped value, and a host move that lands between the render
      // that produced this callback and the click that invokes it would
      // otherwise be attributed to the activation itself (the "before" snapshot
      // would already be stale before routing even starts).
      const beforeRouteHostId =
        client === null ? null : readEffectiveHostIdSnapshot();
      // ORIGIN-REQUIRED routes may not fall back to the hostless intent.
      //
      // `ensureOriginHostSelected` used to carry two rules at once: it SELECTED
      // the origin host (which D7 forbids - a notification click is not the
      // app-wide selection's writer, and P1.2 removed it), and it REFUSED an
      // activation it could not route to that host. Deleting the function took
      // the refusal with the switch. An approval or interview raised on host B
      // with host A effective and no B-bound tile open then routed anyway: the
      // fallback builds a hostless epic-tab intent, so it resolved through A,
      // and for cloud rows the activation still reported success - closing the
      // popover and marking a prompt read that was never opened on its host.
      //
      // The refusal comes back WITHOUT the selection write, and it refuses the
      // ACKNOWLEDGMENT rather than the navigation: opening the epic is useful
      // either way, while marking the row read is the part that was wrong.
      //
      // Narrow on purpose. It fires only on POSITIVE evidence that the route
      // landed somewhere else - an origin host that is known, an effective host
      // that is known, and the two differing - because the alternative reads a
      // missing effective pointer as "wrong host" and strands ordinary
      // same-host prompts whose authority has simply not attached yet.
      const requiresOriginHost = notificationPayloadRequiresOriginHost(
        input.payload,
      );
      const originHostId = input.originHostId ?? null;
      const routedToOriginBoundTarget = routeNotificationForHost(
        navigate,
        input.payload,
        input.receivedAt,
        originHostId,
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
          // READ LIVE, and that is the whole point of this line.
          //
          // The guard asks "did the app-wide pointer move while we were
          // routing" (D7: a notification activation must not switch the
          // window's host). It used to ask the client twice, which worked
          // only because `bind()` mutated one shared object between the two
          // reads. `client` above is an id-pinned requester and CANNOT
          // observe movement - both reads would return the id it was pinned
          // to, so the comparison would be true by construction and this
          // guard could never fire again on a user-visible failure mode.
          //
          // Read from the STORE, not through `getAppHostClientSnapshot()`,
          // and the reason is FIXTURE REACHABILITY rather than layering. The
          // one-blessed-read-path argument for the accessor is real; it loses
          // here because the accessor lives in a module the activation suites
          // do not mock, so every suite that exercises this guard would have
          // to stub the accessor - and then the guard's second read comes
          // from the stub, and no activation test could ever again catch a
          // real pointer move. Seeding the store keeps this read REAL in
          // every test: the fixture seeds what the guard asks about instead
          // of stubbing what reads it.
          //
          // The same argument applies to `beforeRouteHostId` above: it also
          // reads the store live rather than the render-scoped
          // `effectiveHostId`, or a move landing between render and click
          // would be invisible to this guard entirely.
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
