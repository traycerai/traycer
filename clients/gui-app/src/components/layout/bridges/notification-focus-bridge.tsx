import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  parseNotificationPayload,
  routeNotification,
} from "@/lib/notifications";
import { useNotificationActivation } from "@/hooks/notifications/use-notification-activation";
import { useNotificationEventsStore } from "@/stores/notifications/notification-events-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";

/**
 * Mounted consumer of `useNotificationEventsStore.notificationEvent`.
 *
 * Post-T6 cutover: navigation carries route search params (`focusArtifactId`,
 * `focusThreadId`) so the Epic route - backed by the live `EpicSessionProvider`
 * - can apply the focus target after its snapshot lands. The bridge no longer
 * seeds any mock data into the canvas store; it is pure routing.
 *
 * Feed-backed OS-toast clicks open the notifications popover first:
 *
 *   - `epic`    → then navigate to `/epics/$epicId/$tabId`
 *   - `artifact`→ then navigate to `/epics/$epicId/$tabId` with `focusArtifactId`
 *                 (and `focusThreadId` when present) when `payload.epicId`
 *                 is known
 *   - `session` / `approval` / artifact-without-epic → open only
 *
 * `chat` (local turn-completion toast) is not a feed entry, so it routes
 * straight to the chat's epic without opening the popover.
 *
 * `receivedAt` is forwarded as `focusedAt` so repeat clicks of the same
 * notification still produce a distinct navigation.
 */
export function NotificationFocusBridge(): null {
  const notificationEvent = useNotificationEventsStore(
    (state) => state.notificationEvent,
  );
  const navigate = useNavigate();
  const { activate } = useNotificationActivation();

  useEffect(() => {
    if (notificationEvent === null) {
      return;
    }

    const parsed = parseNotificationPayload(notificationEvent.payload);

    // Local turn-completion toasts route to the chat's epic and must not pop
    // the in-app notifications feed (they are not feed entries).
    if (parsed?.kind === "chat") {
      routeNotification(navigate, parsed, notificationEvent.receivedAt);
      return;
    }

    useNotificationsPopoverStore.getState().setOpen(true);

    if (parsed === null) {
      return;
    }

    if (parsed.kind === "epic") {
      activate({
        payload: parsed,
        receivedAt: notificationEvent.receivedAt,
        onActivated: null,
      });
      return;
    }

    if (parsed.kind === "artifact" && parsed.epicId !== undefined) {
      activate({
        payload: parsed,
        receivedAt: notificationEvent.receivedAt,
        onActivated: null,
      });
    }
  }, [notificationEvent, navigate, activate]);

  return null;
}
