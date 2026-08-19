import { useEffect, useMemo, useRef } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
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
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
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
 * - V1 with a non-null `originHostId` that no longer matches the EFFECTIVE
 *   host: never routes or acknowledges - the center opens once in the
 *   origin-unavailable state instead. It does not move the app either
 *   (redesign P1.2): a notification click is not the user answering "which
 *   host do you work on", and this bridge has no write path to the selection
 *   authority at all.
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
  const effectiveHostId = useEffectiveHostId();
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
        originHostRoutable: isOriginHostRoutable(originHostEntry),
        effectiveHostId,
        requiresOriginHost,
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
    effectiveHostId,
    originHostEntry,
    candidateRow,
    activate,
    actions,
  ]);

  return null;
}

/**
 * DERIVATION, not the coarse bit. A `true` here reroutes a click that was
 * already made into the "originating host is unavailable" centre instead of
 * opening what the person asked for, so it must not fire on the cloud merely
 * failing to read liveness — that turned a healthy approval prompt into a dead
 * end for as long as one degraded Redis read persisted.
 *
 * Routable therefore means "the transport would attempt this", which is exactly
 * `dialableHostEndpoint`: `indeterminate` dials, a CONFIRMED refusal
 * (`offline` / `plan-restricted`) does not, and a directory-absent host has
 * nothing to dial at all.
 */
function isOriginHostRoutable(entry: HostDirectoryEntry | null): boolean {
  return dialableHostEndpoint(entry) !== null;
}

function isOriginUnavailable(input: {
  readonly route: NotificationPayload;
  readonly feedSource: NotificationActivationEnvelopeFeedSource;
  readonly originHostId: string | null;
  readonly originHostRoutable: boolean;
  readonly effectiveHostId: string | null;
  readonly requiresOriginHost: boolean;
}): boolean {
  if (input.requiresOriginHost) {
    return input.originHostId === null || !input.originHostRoutable;
  }
  if (input.feedSource === "cloud" && input.route.kind !== "hostSurface") {
    return false;
  }
  if (
    input.originHostId === null ||
    input.originHostId === input.effectiveHostId
  ) {
    return false;
  }
  // A foreign-origin route lands on the origin-unavailable center rather
  // than moving the app (redesign P1.2, D7's second limb). The app-wide
  // selection has exactly one writer - Settings ▸ Activate, through the
  // authority - and a notification click is not it. What used to happen here
  // was a "transient" switch whose only way back was the restore machinery
  // this phase deletes, so keeping it would have made the move PERMANENT.
  return true;
}
