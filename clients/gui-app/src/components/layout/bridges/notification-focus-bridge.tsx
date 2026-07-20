import { useEffect } from "react";
import { parseNotificationPayload } from "@/lib/notifications";
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
 *   - `chat` / `approval` / `interview` → then navigate to the owning chat
 *   - `terminal` → then navigate to the exact task tab and terminal tile
 *   - `session` / artifact-without-epic → open only
 *
 * `receivedAt` is forwarded as `focusedAt` so repeat clicks of the same
 * notification still produce a distinct navigation.
 */
export function NotificationFocusBridge(): null {
  const notificationEvent = useNotificationEventsStore(
    (state) => state.notificationEvent,
  );
  const { activate } = useNotificationActivation();

  useEffect(() => {
    if (notificationEvent === null) {
      return;
    }

    const parsed = parseNotificationPayload(notificationEvent.payload);

    if (notificationEvent.openPopover) {
      useNotificationsPopoverStore.getState().setOpen(true);
    }

    if (parsed === null) {
      return;
    }

    if (
      parsed.kind === "epic" ||
      parsed.kind === "chat" ||
      parsed.kind === "terminal" ||
      parsed.kind === "approval" ||
      parsed.kind === "interview"
    ) {
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
  }, [notificationEvent, activate]);

  return null;
}
