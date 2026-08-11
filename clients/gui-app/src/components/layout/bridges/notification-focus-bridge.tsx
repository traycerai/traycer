import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  isNotificationPayloadRoutable,
  type NotificationPayload,
} from "@/lib/notifications";
import {
  feedIdFromEnvelopeFeed,
  parseNotificationActivationPayload,
  type NotificationActivationEnvelopeFeedSource,
} from "@/lib/notifications/notification-activation-envelope";
import {
  notificationPayloadRequiresOriginHost,
  useNotificationActivation,
} from "@/hooks/notifications/use-notification-activation";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import {
  useHostBinding,
  type HostDirectoryService,
  type HostRpcRegistry,
} from "@/lib/host";
import { dialableHostEndpoint } from "@/lib/host/transport-key";
import {
  useMergedNotificationRow,
  useMergedNotificationsActions,
} from "@/stores/notifications/merged-notifications";
import {
  useNotificationEventsStore,
  type NotificationClickEvent,
} from "@/stores/notifications/notification-events-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { activationResultHandler } from "@/lib/notifications/notification-activation-result";

/**
 * Mounted consumer of `useNotificationEventsStore.notificationEvent` - the
 * native-notification click sink surfaced by `IRunnerHost`.
 *
 * A click payload is parsed as, in order: the versioned V1 activation
 * envelope (route + feed correlation + nullable origin host), a legacy raw
 * route payload (no feed identity), or unknown.
 *
 * - V1 with a non-null `originHostId` that no longer matches the active host:
 *   a `hostSurface` route may switch to a reachable origin first (see
 *   `switchToOriginHost`) and then route/acknowledge against it; every other
 *   route kind, and any origin that cannot be switched to, never routes,
 *   switches, or acknowledges - the center opens once in the
 *   origin-unavailable state instead.
 * - V1 (origin-valid or host-less) or legacy, and the route actually goes
 *   somewhere (`isNotificationPayloadRoutable`): activate directly through
 *   the shared success-only path and leave the center closed. A V1 click
 *   acknowledges its correlated row on success; a legacy click has no feed
 *   identity to acknowledge.
 * - Anything left (unknown payload, or a known payload with nowhere to
 *   route) opens the center so the user can inspect it there instead.
 */
export function NotificationFocusBridge(): null {
  const notificationEvent = useNotificationEventsStore(
    (state) => state.notificationEvent,
  );
  const activeHostId = useReactiveActiveHostId();
  const binding = useHostBinding();
  // Only consulted on the origin-mismatch branch below, but unwrapped here so
  // the effect depends on the two things it actually uses rather than on the
  // whole binding.
  const hostDirectory = binding?.directory ?? null;
  const hostClient = binding?.hostClient ?? null;
  const { activate } = useNotificationActivation();
  const actions = useMergedNotificationsActions();

  const parsed = useMemo(
    () =>
      notificationEvent === null
        ? null
        : parseNotificationActivationPayload(notificationEvent.payload),
    [notificationEvent],
  );
  // Read unconditionally at the top level (Rules of Hooks) even though it is
  // only consulted on the origin-mismatch branch below.
  const candidateOriginHostId =
    parsed?.kind === "v1" ? parsed.envelope.originHostId : null;
  const originHostEntry = useHostDirectoryEntry(candidateOriginHostId ?? "");
  // Same top-level-read pattern as `originHostEntry` above, for the
  // activation-completed analytics call in the V1 branch below - a legacy
  // click carries no feed identity and is intentionally left unanalyzed.
  const candidateFeedId =
    parsed?.kind === "v1" ? feedIdFromEnvelopeFeed(parsed.envelope.feed) : null;
  const candidateRow = useMergedNotificationRow(candidateFeedId ?? "");

  // `activate`'s identity is not guaranteed stable across renders (it closes
  // over the host client/navigate function), and `notificationEvent` stays
  // resident in the store rather than being cleared after dispatch - so this
  // effect legitimately reruns on a dependency change alone, with the SAME
  // stored click still present. Track
  // which event object this bridge has already dispatched so a rerun can
  // never redispatch it; only a genuinely new `recordClick()` produces a new
  // `notificationEvent` reference and clears this guard.
  const processedEventRef = useRef<NotificationClickEvent | null>(null);

  useEffect(() => {
    if (notificationEvent === null || parsed === null) return;
    if (processedEventRef.current === notificationEvent) return;
    processedEventRef.current = notificationEvent;

    if (parsed.kind === "unknown") {
      useNotificationsPopoverStore.getState().setOpen(true);
      return;
    }

    if (parsed.kind === "legacy") {
      if (!isNotificationPayloadRoutable(parsed.payload)) {
        useNotificationsPopoverStore.getState().setOpen(true);
        return;
      }
      if (notificationPayloadRequiresOriginHost(parsed.payload)) {
        useNotificationsPopoverStore.getState().setOpen(true);
        return;
      }
      activate({
        payload: parsed.payload,
        receivedAt: notificationEvent.receivedAt,
        feedId: null,
        originHostId: null,
        onResult: null,
      });
      return;
    }

    const { envelope } = parsed;
    if (!isNotificationPayloadRoutable(envelope.route)) {
      useNotificationsPopoverStore.getState().setOpen(true);
      return;
    }
    const requiresOriginHost = notificationPayloadRequiresOriginHost(
      envelope.route,
    );
    if (
      isOriginUnavailable({
        route: envelope.route,
        feedSource: envelope.feed.source,
        originHostId: envelope.originHostId,
        originHostAvailable: originHostEntry?.status === "available",
        activeHostId,
        requiresOriginHost,
        directory: hostDirectory,
        client: hostClient,
      })
    ) {
      useNotificationsPopoverStore
        .getState()
        .openWithOriginUnavailable(originHostEntry?.label ?? null);
      return;
    }
    const feedId = feedIdFromEnvelopeFeed(envelope.feed);
    activate({
      payload: envelope.route,
      receivedAt: notificationEvent.receivedAt,
      feedId,
      originHostId: envelope.originHostId,
      onResult: activationResultHandler({
        row: candidateRow,
        feedId,
        surface: "native",
        markAsRead: actions.markAsRead,
        onSuccess: null,
      }),
    });
  }, [
    notificationEvent,
    parsed,
    activeHostId,
    originHostEntry,
    candidateRow,
    activate,
    actions,
    hostDirectory,
    hostClient,
  ]);

  return null;
}

function isOriginUnavailable(input: {
  readonly route: NotificationPayload;
  readonly feedSource: NotificationActivationEnvelopeFeedSource;
  readonly originHostId: string | null;
  readonly originHostAvailable: boolean;
  readonly activeHostId: string | null;
  readonly requiresOriginHost: boolean;
  readonly directory: HostDirectoryService | null;
  readonly client: HostClient<HostRpcRegistry> | null;
}): boolean {
  if (input.requiresOriginHost) {
    return input.originHostId === null || !input.originHostAvailable;
  }
  if (input.feedSource === "cloud" && input.route.kind !== "hostSurface") {
    return false;
  }
  if (
    input.originHostId === null ||
    input.originHostId === input.activeHostId
  ) {
    return false;
  }
  return !switchToOriginHost({
    route: input.route,
    originHostId: input.originHostId,
    directory: input.directory,
    client: input.client,
  });
}

/**
 * Reachability-gated switch to the host a native notification came from.
 *
 * Returns `true` ONLY when the app-wide active host IS the origin host by the
 * time it returns, so the caller can treat it as the single gate for "route
 * and acknowledge against the origin feed". A `false` return has not bound
 * anything and lands on the existing origin-unavailable center.
 *
 * The gates, in order:
 *
 * 1. `hostSurface` routes only. Switching hosts is a narrow policy for a
 *    host-owned surface (Settings ▸ Worktrees today), NOT a global rule for
 *    every notification: an epic/chat row that names a foreign host keeps its
 *    released behavior, and existing chat/terminal tabs stay bound to their
 *    lifetime `hostId` either way - only the app-wide scope moves.
 * 2. Already on the origin - re-read LIVE from the client. The caller
 *    compares against a React-rendered host id, which can lag a bind that
 *    landed in the same tick; without this the bridge would announce a switch
 *    it never made and emit a selection event for a host it was already on.
 * 3. An authenticated client. Without a usable credential lease the switch
 *    would bind a host we cannot talk to; app-wide authentication handling
 *    owns that recovery, so this declines ONCE (the caller's processed-event
 *    guard means a declined click is never retried) rather than binding and
 *    letting an unauthorized RPC fail.
 * 4. A LIVE, dialable directory entry - re-read here rather than taken from
 *    the render snapshot, and with no `await` in between, so the entry cannot
 *    have gone stale by the time we select it.
 *
 * Binding goes through the directory rather than `HostClient.bind` directly:
 * the directory owns selection, and `HostRuntime` turns one `setSelected`
 * into exactly one synchronous `hostClient.bind(entry)`. Binding the client
 * behind the directory's back would leave the two disagreeing, and the next
 * directory reconcile would snap the app back to the old host.
 *
 * It uses `selectTransientById`, not `selectById`, because a notification
 * click is not the user answering "which host do you work on". The durable
 * explicit-selection intent stays unwritten, so if this origin later leaves
 * the directory the normal default-host promotion still recovers the app.
 *
 * AFTER the bind, this feature is done. `status: "available"` is a claim from
 * the last published snapshot, not proof the dial or the bearer will be
 * accepted, so a switched-to host can still fail on the very next request.
 * That is deliberately owned by existing app-wide host/auth handling: the
 * selection stays put, the user stays on the surface they navigated to, and
 * the click neither retries nor rolls the app back out from under them.
 */
function switchToOriginHost(input: {
  readonly route: NotificationPayload;
  readonly originHostId: string;
  readonly directory: HostDirectoryService | null;
  readonly client: HostClient<HostRpcRegistry> | null;
}): boolean {
  if (input.route.kind !== "hostSurface") return false;
  const { directory, client } = input;
  if (directory === null || client === null) return false;
  if (client.getActiveHostId() === input.originHostId) return true;
  if (client.getRequestContextUserId() === null) return false;

  const entry = directory.findById(input.originHostId);
  if (entry === null || dialableHostEndpoint(entry) === null) return false;

  directory.selectTransientById(entry.hostId, "notification");
  // The bind is synchronous through the selection listener; anything else
  // means the app-wide host did not actually move, and routing now would
  // acknowledge against the wrong feed.
  if (client.getActiveHostId() !== entry.hostId) return false;

  // Binding changes the app-wide host context, which is a bigger consequence
  // than the click asked for - say so before the destination appears.
  toast.success(
    `Switched to ${entry.label.length > 0 ? entry.label : entry.hostId}`,
  );
  return true;
}
