import type { NotificationShow } from "@/hooks/notifications/use-notifications";
import type {
  NotificationForegroundAppLocal,
  NotificationForegroundDisplay,
} from "@traycer-clients/shared/platform/runner-host";
import { createElement } from "react";
import { toast } from "sonner";
import {
  rowFromAppLocalEntry,
  rowFromCloudFeedRow,
  rowFromHostEntry,
  type MergedNotificationRow,
} from "@/stores/notifications/merged-notifications";
import type { AppLocalNotificationEntry } from "@/stores/notifications/app-local-notifications-store";
import type {
  HostNotificationEntryV21,
  HostNotificationsCloudFeedRow,
} from "@traycer/protocol/host/notifications/contracts";
import {
  notificationEntityFromHostEntry,
  notificationEntityMatchesPresence,
} from "@/lib/notifications/notification-entity";
import { readFocusedHostNotificationPresenceEntity } from "@/lib/notifications/notification-presence";
import { buildNotificationActivationEnvelope } from "@/lib/notifications/notification-activation-envelope";
import type { NotificationPayload } from "@/lib/notifications/payload";

export interface NotificationDisplayTarget {
  readonly showNotification: NotificationShow;
  readonly playChime: () => void;
  readonly onToastClick: (row: MergedNotificationRow) => void;
}

interface NativeNotificationDisplayOptions {
  readonly deliveryKey: string | null;
  readonly originHostId: string | null;
  readonly foregroundAppLocal: NotificationForegroundAppLocal | null;
}

export function displayForwardedForegroundNotification(
  display: NotificationForegroundDisplay,
  target: {
    readonly playChime: () => void;
    readonly onToastClick: (payload: unknown) => void;
  },
): void {
  const actionable = display.payload !== null;
  const title = actionable
    ? createElement(
        "button",
        {
          type: "button",
          "aria-label": `${display.title} ${display.body}`,
          "data-notification-toast-action": "",
          className: "min-w-0 text-left",
          onClick: () => target.onToastClick(display.payload),
        },
        createElement(
          "span",
          { className: "block font-medium leading-normal" },
          display.title,
        ),
        createElement(
          "span",
          {
            className:
              "mt-0.5 block text-sm leading-snug text-muted-foreground",
          },
          display.body,
        ),
      )
    : display.title;
  toast(title, {
    description: actionable ? undefined : display.body,
    id: display.replaceKey ?? undefined,
  });
  target.playChime();
}

export function displayNotificationRows(
  rows: ReadonlyArray<MergedNotificationRow>,
  target: NotificationDisplayTarget,
  originHostId: string | null,
): void {
  void displayNotificationRowsAwaitNative(rows, target, {
    deliveryKey: null,
    originHostId,
    foregroundAppLocal: null,
  }).catch(() => {
    // The feed remains authoritative; a failed native toast is non-critical.
  });
}

async function displayNotificationRowsAwaitNative(
  rows: ReadonlyArray<MergedNotificationRow>,
  target: NotificationDisplayTarget,
  options: NativeNotificationDisplayOptions,
): Promise<void> {
  if (rows.length === 0) return;
  const content = buildNotificationToastContent(rows);
  const nativePayload =
    content.payload === null
      ? null
      : buildNotificationActivationEnvelope({
          route: content.payload,
          feed: { source: content.row.source, id: content.row.sourceId },
          originHostId: options.originHostId,
        });
  let nativeDisplay: Promise<void>;
  try {
    nativeDisplay = target.showNotification({
      title: content.title,
      body: content.body,
      payload: nativePayload,
      replaceKey: content.replaceKey,
      deliveryKey: options.deliveryKey,
      foregroundAppLocal: options.foregroundAppLocal,
    });
  } catch (error) {
    renderNotificationToast(content, target);
    throw error;
  }
  renderNotificationToast(content, target);
  await nativeDisplay;
}

function renderNotificationToast(
  content: NotificationToastContent,
  target: NotificationDisplayTarget,
): void {
  const isActionable = content.row.payload !== null;
  const toastTitle = isActionable
    ? createElement(
        "button",
        {
          type: "button",
          "aria-label": `${content.title} ${content.body}`,
          "data-notification-toast-action": "",
          className: "min-w-0 text-left",
          onClick: () => target.onToastClick(content.row),
        },
        createElement(
          "span",
          { className: "block font-medium leading-normal" },
          content.title,
        ),
        createElement(
          "span",
          {
            className:
              "mt-0.5 block text-sm leading-snug text-muted-foreground",
          },
          content.body,
        ),
      )
    : content.title;
  toast(toastTitle, {
    description: isActionable ? undefined : content.body,
    id: content.replaceKey,
  });
  target.playChime();
}

/**
 * Host-side presence suppression is authoritative (fresh presence marks the
 * row read at birth and skips the renderer channel entirely), but it runs on
 * TTL'd presence snapshots — an emission can already be in flight when focus
 * lands on the entity, or presence can go stale mid-hold. This gate re-checks
 * live focus at display time so the tab you are looking at never toasts about
 * its own activity; rows for other entities still display.
 */
export function displayHostChannelEmission(
  entries: ReadonlyArray<HostNotificationEntryV21>,
  target: NotificationDisplayTarget,
  originHostId: string | null,
): void {
  const focusedEntity = readFocusedHostNotificationPresenceEntity();
  const visibleEntries =
    focusedEntity === null
      ? entries
      : entries.filter((entry) => {
          const entity = notificationEntityFromHostEntry(entry);
          return (
            entity === null ||
            !notificationEntityMatchesPresence(entity, focusedEntity)
          );
        });
  displayNotificationRows(
    visibleEntries.map(rowFromHostEntry),
    target,
    originHostId,
  );
}

/** Whole cloud snapshots carry no emission frame, so accepted post-baseline
 * entryId diffs are the arrival edge. Display each row with its own origin:
 * unlike a v1 channel batch, one snapshot can contain entries from several
 * hosts and every native activation envelope must retain the correct one. */
export function displayCloudSnapshotArrivals(
  entries: ReadonlyArray<HostNotificationsCloudFeedRow>,
  target: NotificationDisplayTarget,
): void {
  const focusedEntity = readFocusedHostNotificationPresenceEntity();
  for (const entry of entries) {
    const entity = notificationEntityFromHostEntry(entry.entry);
    if (
      focusedEntity !== null &&
      entity !== null &&
      notificationEntityMatchesPresence(entity, focusedEntity)
    ) {
      continue;
    }
    displayNotificationRows(
      [rowFromCloudFeedRow(entry)],
      target,
      entry.originHostId,
    );
  }
}

export function displayAppLocalNotification(
  entry: AppLocalNotificationEntry,
  target: NotificationDisplayTarget,
  deliveryKey: string,
  userId: string,
): Promise<void> {
  return displayNotificationRowsAwaitNative(
    [rowFromAppLocalEntry(entry)],
    target,
    {
      deliveryKey,
      originHostId: null,
      foregroundAppLocal: { userId, entry },
    },
  );
}

export function playNotificationChime(): void {
  if (typeof window === "undefined") return;
  if (typeof window.AudioContext === "undefined") return;
  try {
    const context = new window.AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.2);
    oscillator.onended = () => {
      void context.close();
    };
  } catch {
    // Autoplay/device restrictions can reject audio setup; the toast/feed still work.
  }
}

interface NotificationToastContent {
  readonly title: string;
  readonly body: string;
  readonly row: MergedNotificationRow;
  readonly payload: NotificationPayload | null;
  readonly replaceKey: string;
}

function buildNotificationToastContent(
  rows: ReadonlyArray<MergedNotificationRow>,
): NotificationToastContent {
  const first = rows[0];
  if (rows.length === 1) {
    return {
      title: first.title,
      body: first.body,
      row: first,
      payload: first.payload,
      replaceKey: notificationReplaceKey(first),
    };
  }
  return {
    title: "Traycer",
    body: `${rows.length} new notifications`,
    row: first,
    payload: first.payload,
    replaceKey: "notification-batch",
  };
}

export function notificationReplaceKey(row: MergedNotificationRow): string {
  if (row.source === "app-local") return row.sourceId;
  return hostEntityReplaceKey(row.payload) ?? `host:id:${row.sourceId}`;
}

function hostEntityReplaceKey(
  payload: MergedNotificationRow["payload"],
): string | null {
  if (payload === null) return null;

  switch (payload.kind) {
    case "approval":
    case "chat":
      return chatOrEpicReplaceKey(payload.chatId, payload.epicId);
    case "interview":
      return `host:chat:${payload.chatId}`;
    case "artifact":
    case "epic":
    case "terminal":
      return epicReplaceKey(payload.epicId);
    // Falls through to the per-row id key. Coalescing by entity is right for
    // repeated activity ON one chat or epic; two finished commands are two
    // separate results, and replacing the first toast with the second would
    // hide a failure behind a later success.
    case "hostSurface":
    case "session":
      return null;
  }
}

function chatOrEpicReplaceKey(
  chatId: string | undefined,
  epicId: string | undefined,
): string | null {
  if (chatId !== undefined) return `host:chat:${chatId}`;
  return epicReplaceKey(epicId);
}

function epicReplaceKey(epicId: string | undefined): string | null {
  return epicId === undefined ? null : `host:epic:${epicId}`;
}
