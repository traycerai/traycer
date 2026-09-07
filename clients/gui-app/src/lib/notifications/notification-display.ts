import type { NotificationShow } from "@/hooks/notifications/use-notifications";
import type {
  NotificationFeedSource,
  NotificationForegroundAppLocal,
  NotificationForegroundDisplay,
  NotificationShowOutcome,
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
  HostNotificationEntryV22,
  HostNotificationsCloudFeedRowV11,
} from "@traycer/protocol/host/notifications/contracts";
import {
  notificationEntityFromHostEntry,
  notificationEntityFromPayload,
  notificationEntityMatchesPresence,
} from "@/lib/notifications/notification-entity";
import { occurrenceKeyForNotification } from "@/lib/notifications/notification-occurrence";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import { useHostNotificationsStore } from "@/stores/notifications/host-notifications-store";
import {
  isDocumentFocused,
  readFocusedHostNotificationPresence,
} from "@/lib/notifications/notification-presence";
import {
  buildNotificationActivationEnvelope,
  parseNotificationActivationPayload,
  type ParsedNotificationActivationPayload,
} from "@/lib/notifications/notification-activation-envelope";
import type { NotificationPayload } from "@/lib/notifications/payload";
import {
  notificationChimeEventTypeForSeverities,
  playNotificationChimeSound,
  type NotificationChimeEventType,
} from "@/lib/notifications/notification-chime";
import { useSettingsStore } from "@/stores/settings/settings-store";

export interface NotificationDisplayTarget {
  readonly showNotification: NotificationShow;
  readonly playChime: (eventType: NotificationChimeEventType) => void;
  readonly onToastClick: (row: MergedNotificationRow) => void;
}

interface NativeNotificationDisplayOptions {
  readonly deliveryKey: string | null;
  readonly originHostId: string | null;
  readonly foregroundAppLocal: NotificationForegroundAppLocal | null;
}

/** Renders a notification another window's native pass relayed here because this window holds app focus. */
export function displayForwardedForegroundNotification(
  display: NotificationForegroundDisplay,
  target: {
    readonly playChime: (eventType: NotificationChimeEventType) => void;
    readonly onToastClick: (payload: unknown) => void;
  },
): void {
  const parsed =
    display.payload === null
      ? null
      : parseNotificationActivationPayload(display.payload);
  if (isFeedRelay(display, parsed)) {
    if (ownFeedIsDelivering(relayedFeedSource(display, parsed))) return;
    if (suppressedByFocusedEntity(parsed)) return;
  }
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
  target.playChime(
    parsed?.kind === "v1" ? parsed.envelope.chimeEventType : "done",
  );
}

/** Whether a relayed display is a feed row, which every window receives on its own subscription. */
function isFeedRelay(
  display: NotificationForegroundDisplay,
  parsed: ParsedNotificationActivationPayload | null,
): boolean {
  if (display.foregroundAppLocal !== null) return false;
  if (display.feedSource !== null) return display.feedSource !== "app-local";
  if (parsed === null) return true;
  return !(parsed.kind === "v1" && parsed.envelope.feed.source === "app-local");
}

/**
 * The feed that produced a relayed display.
 * The display's own `feedSource` field is authoritative: it is stamped from the row at send time and survives payload degradation, which the activation envelope does not - a row whose payload degraded to null ships a null envelope, and deriving provenance.
 */
function relayedFeedSource(
  display: NotificationForegroundDisplay,
  parsed: ParsedNotificationActivationPayload | null,
): NotificationFeedSource | null {
  if (display.feedSource !== null) return display.feedSource;
  return parsed?.kind === "v1" ? parsed.envelope.feed.source : null;
}

/**
 * Whether this window's own feed subscription can reproduce the relayed row - meaning ignoring the relay loses nothing, because the row is already arriving here directly.
 */
function ownFeedIsDelivering(source: NotificationFeedSource | null): boolean {
  const cloud = useCloudNotificationsStore.getState();
  if (cloud.connectionState === "connected" && cloud.hasSnapshot) return true;
  if (source === "cloud") return false;
  const host = useHostNotificationsStore.getState();
  // Transport `open` is not usability: the host stream reports open before its first snapshot lands, and a baseline snapshot never calls the channel emission.
  // Relays dropped in that window would be the only copy of an occurrence this renderer had.
  return host.connectionStatus === "open" && host.summary !== null;
}

export function displayNotificationRows(
  rows: ReadonlyArray<MergedNotificationRow>,
  target: NotificationDisplayTarget,
  originHostId: string | null,
): void {
  displayFeedRows(rows, target, originHostId, feedRowsDeliveryKey(rows));
}

/**
 * Displays feed rows under an explicit delivery identity.
 * Separate from `displayNotificationRows` because a caller that shows a FOCUS-FILTERED subset must still name the whole arrival: see `displayHostChannelEmission`.
 */
function displayFeedRows(
  rows: ReadonlyArray<MergedNotificationRow>,
  target: NotificationDisplayTarget,
  originHostId: string | null,
  deliveryKey: string | null,
): void {
  void displayNotificationRowsAwaitNative(rows, target, {
    deliveryKey,
    originHostId,
    foregroundAppLocal: null,
  }).catch(() => {
    // The feed remains authoritative; a failed native toast is non-critical.
  });
}

/**
 * Every window subscribed to a feed reports the same arrival to the native pass, so without a delivery key the main process treats N windows as N notifications and shows an OS banner per window.
 */
function feedRowsDeliveryKey(
  rows: ReadonlyArray<MergedNotificationRow>,
): string | null {
  if (rows.length === 0) return null;
  return JSON.stringify(rows.map(occurrenceKeyForNotification));
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
          chimeEventType: content.chimeEventType,
          originHostId: options.originHostId,
        });
  let nativeDisplay: Promise<NotificationShowOutcome>;
  try {
    nativeDisplay = target.showNotification({
      title: content.title,
      body: content.body,
      payload: nativePayload,
      replaceKey: content.replaceKey,
      deliveryKey: options.deliveryKey,
      // Provenance for the receive-side relay gates, independent of the activation payload: the payload degrades to null for unrecognized rows, and a batch's rows share one source (batches only come from the v1 host emission).
      feedSource: content.row.source,
      foregroundAppLocal: options.foregroundAppLocal,
    });
  } catch (error) {
    renderNotificationToast(content, target);
    throw error;
  }
  const renderChimed = renderNotificationToast(content, target);
  const outcome = await nativeDisplay;
  // `undeliverable`: the platform cannot present notifications and no window was focused, so nothing was shown or relayed and the burnt delivery key makes it unretryable - this window (the ledger's single winner; every other window heard `duplicate`) owns the.
  if (outcome === "undeliverable" && !renderChimed) {
    target.playChime(content.chimeEventType);
  }
}

/** Renders the in-app toast and returns whether the focus-gated chime ran. */
function renderNotificationToast(
  content: NotificationToastContent,
  target: NotificationDisplayTarget,
): boolean {
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
  // Only the CHIME is focus-gated, never the toast.
  // The main process treats a focused sender as already-delivered and relays nothing back to it, so a renderer that skipped its own toast on an independent focus read would leave the arrival with no surface at all whenever focus landed between the two checks -.
  if (!isDocumentFocused()) return false;
  target.playChime(content.chimeEventType);
  return true;
}

/**
 * Whether a FALLBACK relay - one this window is rendering because its own feed is not delivering - is addressed to the entity currently in focus.
 * Reached only on that path; when our feed is live the relay is ignored outright.
 */
function suppressedByFocusedEntity(
  parsed: ParsedNotificationActivationPayload | null,
): boolean {
  if (parsed === null) return false;
  const route = activationRoute(parsed);
  if (route === null) return false;
  const entity = notificationEntityFromPayload(route);
  if (entity === null) return false;
  const focused = readFocusedHostNotificationPresence();
  return (
    focused !== null &&
    notificationOriginMatchesFocus(
      activationOriginHostId(parsed),
      focused.originHostId,
    ) &&
    notificationEntityMatchesPresence(entity, focused.entity)
  );
}

function activationOriginHostId(
  parsed: ParsedNotificationActivationPayload,
): string | null {
  return parsed.kind === "v1" ? parsed.envelope.originHostId : null;
}

function notificationOriginMatchesFocus(
  originHostId: string | null,
  focusedOriginHostId: string | null,
): boolean {
  return (
    focusedOriginHostId === null ||
    (originHostId !== null && originHostId === focusedOriginHostId)
  );
}

function activationRoute(
  parsed: ParsedNotificationActivationPayload | null,
): NotificationPayload | null {
  if (parsed === null) return null;
  switch (parsed.kind) {
    case "v1":
      return parsed.envelope.route;
    case "legacy":
      return parsed.payload;
    case "unknown":
      return null;
  }
}

/**
 * Host-side presence suppression is authoritative (fresh presence marks the row read at birth and skips the renderer channel entirely), but it runs on TTL'd presence snapshots - an emission can already be in flight when focus lands on the entity, or presence.
 */
export function displayHostChannelEmission(
  entries: ReadonlyArray<HostNotificationEntryV22>,
  target: NotificationDisplayTarget,
  originHostId: string | null,
): void {
  const rows = entries.map(rowFromHostEntry);
  const emissionDeliveryKey = feedRowsDeliveryKey(rows);
  const focused = readFocusedHostNotificationPresence();
  const visibleRows =
    focused === null ||
    !notificationOriginMatchesFocus(originHostId, focused.originHostId)
      ? rows
      : rows.filter((_row, index) => {
          const entity = notificationEntityFromHostEntry(entries[index]);
          return (
            entity === null ||
            !notificationEntityMatchesPresence(entity, focused.entity)
          );
        });
  displayFeedRows(visibleRows, target, originHostId, emissionDeliveryKey);
}

/**
 * Whole cloud snapshots carry no emission frame, so accepted post-baseline entryId diffs are the arrival edge.
 * Display each row with its own origin: unlike a v1 channel batch, one snapshot can contain entries from several hosts and every native activation envelope must retain the correct one.
 */
export function displayCloudSnapshotArrivals(
  entries: ReadonlyArray<HostNotificationsCloudFeedRowV11>,
  target: NotificationDisplayTarget,
): void {
  const focused = readFocusedHostNotificationPresence();
  for (const entry of entries) {
    const entity = notificationEntityFromHostEntry(entry.entry);
    if (
      focused !== null &&
      notificationOriginMatchesFocus(
        entry.originHostId,
        focused.originHostId,
      ) &&
      entity !== null &&
      notificationEntityMatchesPresence(entity, focused.entity)
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
      originHostId: entry.originHostId ?? null,
      foregroundAppLocal: { userId, entry },
    },
  );
}

export function playNotificationChime(
  eventType: NotificationChimeEventType,
): void {
  playNotificationChimeSound(
    useSettingsStore.getState().notificationChimeSounds[eventType],
  );
}

interface NotificationToastContent {
  readonly title: string;
  readonly body: string;
  readonly row: MergedNotificationRow;
  readonly payload: NotificationPayload | null;
  readonly replaceKey: string;
  readonly chimeEventType: NotificationChimeEventType;
}

function buildNotificationToastContent(
  rows: ReadonlyArray<MergedNotificationRow>,
): NotificationToastContent {
  const first = rows[0];
  const chimeEventType =
    notificationChimeEventTypeForSeverities(rows.map((row) => row.severity)) ??
    "done";
  if (rows.length === 1) {
    return {
      title: first.title,
      body: first.body,
      row: first,
      payload: first.payload,
      replaceKey: notificationReplaceKey(first),
      chimeEventType,
    };
  }
  return {
    title: "Traycer",
    body: `${rows.length} new notifications`,
    row: first,
    payload: first.payload,
    replaceKey: "notification-batch",
    chimeEventType,
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
    // Per-session, not per-epic: two parked sessions are two separate people-
    // needed steps, and collapsing them would hide one behind the other.
    case "browserSession":
      return `host:browser-session:${payload.sessionId}`;
    // Falls through to the per-row id key.
    // Coalescing by entity is right for repeated activity ON one chat or epic; two finished commands are two separate results, and replacing the first toast with the second would hide a failure behind a later success.
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
