import { useEffect, useMemo, useRef } from "react";
import { isNotificationPayloadRoutable } from "@/lib/notifications";
import {
  feedIdFromEnvelopeFeed,
  parseNotificationActivationPayload,
} from "@/lib/notifications/notification-activation-envelope";
import { useNotificationActivation } from "@/hooks/notifications/use-notification-activation";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
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
 *   never route, switch hosts, or acknowledge - open the center once in the
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

  // `activate`'s identity changes across a preflight's pending -> settled
  // transition (it closes over the activation hook's own mutation state),
  // and `notificationEvent` stays resident in the store rather than being
  // cleared after dispatch - so this effect legitimately reruns on a
  // dependency change alone, with the SAME stored click still present. Track
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
      activate({
        payload: parsed.payload,
        receivedAt: notificationEvent.receivedAt,
        feedId: null,
        onResult: null,
      });
      return;
    }

    const { envelope } = parsed;
    if (!isNotificationPayloadRoutable(envelope.route)) {
      useNotificationsPopoverStore.getState().setOpen(true);
      return;
    }
    if (
      envelope.originHostId !== null &&
      envelope.originHostId !== activeHostId
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
  ]);

  return null;
}
