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

/** V1 with a non-null `originHostId` that no longer matches the effective host: never routes or acknowledges -
 * the center opens once in the origin-unavailable state instead. */
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
  // Same top-level-read pattern as `originHostEntry` above, for the activation-completed analytics call in the
  // V1 branch below - a legacy click carries no feed identity and is intentionally left unanalyzed.
  const candidateFeedId =
    parsed?.kind === "v1" ? feedIdFromEnvelopeFeed(parsed.envelope.feed) : null;
  const candidateRow = useMergedNotificationRow(candidateFeedId ?? "");

  // Track which event object this bridge has already dispatched so a rerun can never redispatch it; only a
  // genuinely new `recordClick` produces a new `notificationEvent` reference and clears this guard.
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

/** Derivation, not the coarse bit. */
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
  // A foreign-origin route lands on the origin-unavailable center rather than moving the app.
  return true;
}
