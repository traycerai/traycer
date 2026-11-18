import { useBotLifetime } from "@/lib/bots/bot-lifetime";
import { openBotNotification } from "@/lib/notifications/bot-notification-opening";
import { useCallback, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useHostBinding } from "@/lib/host";
import { resolveAppWideHostClient } from "@/lib/host/binding-host-client";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { readEffectiveHostIdSnapshot } from "@/stores/host/selection-authority-store";
import { toast } from "sonner";
import { NO_DEVICE_AVAILABLE } from "@/lib/composer/landing-placement";
import {
  isBotChatWithoutDevice,
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
  /** Bot messages complete after their exact destination lands; other routes
   * retain their dispatch result. Failed or cancelled openings do not acknowledge. */
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
    payload.kind === "feedbackDraft" ||
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

/** Opens notifications without changing the window's selected host.
 * Bot destinations validate and settle through their request owner; other
 * routes retain the origin-host guard around dispatch. */
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
  const lifetime = useBotLifetime();
  const binding = useHostBinding();
  const effectiveHostId = useEffectiveHostId();
  // APP-WIDE BY INTENT, and it must stay that way if this ever mounts under a
  // host-scoped subtree. `beforeRouteHostId`/`afterRouteHostId` below record
  // which host the WINDOW was addressing across an activation (it must not
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
      // A bot's chat opens only as the bot's tab, which needs a device. With
      // none, routing would open nothing: say so, and leave the row unread so
      // it can be opened once a device is up.
      if (isBotChatWithoutDevice(input.payload, beforeRouteHostId)) {
        toast.error(NO_DEVICE_AVAILABLE);
        input.onResult?.("failure");
        return;
      }
      if (
        openBotNotification({
          client,
          navigate,
          payload: input.payload,
          onResult: input.onResult,
          lifetime,
          hostId: effectiveHostId,
        })
      )
        return;
      // ORIGIN-REQUIRED routes may not fall back to the hostless intent.
      //
      // `ensureOriginHostSelected` used to carry two rules at once: it SELECTED
      // the origin host (which is forbidden - a notification click is not the
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
        {
          originHostId,
          effectiveHostId: beforeRouteHostId,
        },
      );
      if (
        requiresOriginHost &&
        !routedToOriginBoundTarget &&
        originHostId !== null &&
        beforeRouteHostId !== null &&
        originHostId !== beforeRouteHostId
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
          // routing" (a notification activation must not switch the
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
    [client, navigate, lifetime, effectiveHostId],
  );

  return { activate };
}
