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
  notificationEntityFromPayload,
  notificationEntityMatchesPresence,
} from "@/lib/notifications/notification-entity";
import { occurrenceKeyForNotification } from "@/lib/notifications/notification-occurrence";
import {
  isDocumentFocused,
  readFocusedHostNotificationPresenceEntity,
} from "@/lib/notifications/notification-presence";
import {
  buildNotificationActivationEnvelope,
  parseNotificationActivationPayload,
  type ParsedNotificationActivationPayload,
} from "@/lib/notifications/notification-activation-envelope";
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

/**
 * Renders a notification another window's native pass relayed here because
 * this window holds app focus. The relay is entity-blind: the sending window
 * gates on ITS OWN focused entity (null while it is unfocused, which is
 * exactly when it relays), so the entity check for the entity THIS window is
 * looking at can only happen here, at receive time. Without it, a background
 * window's display of a row for the focused chat lands as a toast over that
 * very chat.
 */
export function displayForwardedForegroundNotification(
  display: NotificationForegroundDisplay,
  target: {
    readonly playChime: () => void;
    readonly onToastClick: (payload: unknown) => void;
  },
): void {
  if (suppressedByFocusedEntity(display)) return;
  if (wasDeliveryKeyDisplayed(display.deliveryKey)) return;
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
  rememberDisplayedDeliveryKey(display.deliveryKey);
  target.playChime();
}

export function displayNotificationRows(
  rows: ReadonlyArray<MergedNotificationRow>,
  target: NotificationDisplayTarget,
  originHostId: string | null,
): void {
  displayFeedRows(rows, target, originHostId, feedRowsDeliveryKey(rows));
}

/**
 * Displays feed rows under an explicit delivery identity. Separate from
 * `displayNotificationRows` because a caller that shows a FOCUS-FILTERED
 * subset must still name the whole arrival: see `displayHostChannelEmission`.
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
 * Every window subscribed to a feed displays the same arrival, so without a
 * delivery key the main process treats N windows as N notifications: N-1
 * foreground relays into the focused window (N-1 extra chimes), or a native
 * banner per window. The key collapses that fan-out to one delivery per
 * occurrence app-wide, whichever window reports it first.
 *
 * Identity is the feed's own `occurrenceKeyForNotification` - never a
 * hand-rolled one. A host row reuses its semantic id across occurrences, so
 * `(feedId, createdAt)` alone would let a prompt reopened inside one
 * `Date.now()` tick collide with the prompt it superseded and be suppressed;
 * `sourceRef` is what separates them. The JSON encoding is delimiter-safe,
 * which is also why a batch nests the keys instead of joining them.
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
    renderNotificationToast(content, target, options.deliveryKey);
    throw error;
  }
  renderNotificationToast(content, target, options.deliveryKey);
  await nativeDisplay;
}

function renderNotificationToast(
  content: NotificationToastContent,
  target: NotificationDisplayTarget,
  deliveryKey: string | null,
): void {
  // A focused window can receive the same occurrence twice - its own feed
  // display racing another window's foreground relay. Whichever rendered
  // first wins; the sonner id already coalesces the visual, this collapses
  // the chime too.
  if (wasDeliveryKeyDisplayed(deliveryKey)) return;
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
  rememberDisplayedDeliveryKey(deliveryKey);
  // Only the CHIME is focus-gated, never the toast. The main process treats a
  // focused sender as already-delivered and relays nothing back to it, so a
  // renderer that skipped its own toast on an independent focus read would
  // leave the arrival with no surface at all whenever focus landed between
  // the two checks - and the burnt delivery key makes that unretryable.
  // Rendering unconditionally keeps delivery a single decision (the main
  // process picks banner or relay) and leaves the renderer only this one,
  // which is never the sole delivery: an unseen toast is harmless, while a
  // chime from a window nobody is looking at is not.
  if (!isDocumentFocused()) return;
  target.playChime();
}

const MAX_DISPLAYED_DELIVERY_KEYS = 500;
const displayedDeliveryKeys = new Set<string>();

export function clearDisplayedDeliveryKeysForTests(): void {
  displayedDeliveryKeys.clear();
}

function wasDeliveryKeyDisplayed(deliveryKey: string | null): boolean {
  return deliveryKey !== null && displayedDeliveryKeys.has(deliveryKey);
}

function rememberDisplayedDeliveryKey(deliveryKey: string | null): void {
  if (deliveryKey === null || displayedDeliveryKeys.has(deliveryKey)) return;
  while (displayedDeliveryKeys.size >= MAX_DISPLAYED_DELIVERY_KEYS) {
    const oldest = displayedDeliveryKeys.values().next();
    if (oldest.done) return;
    displayedDeliveryKeys.delete(oldest.value);
  }
  displayedDeliveryKeys.add(deliveryKey);
}

/**
 * Whether a relayed display is a host-feed row addressed to the entity this
 * window is looking at.
 *
 * Deliberately scoped to host/cloud FEED rows. App-local rows (terminal
 * closed/crashed, stream transport errors, routed host errors) carry
 * entity-bearing payloads too, but their own display path is never
 * entity-suppressed - and the emission controller records their display
 * receipt BEFORE handing the display here, so a drop is permanent rather
 * than retried. Gating them would silently swallow exactly the failures a
 * user must see. Anything we cannot positively identify as a host-feed
 * relay - a legacy payload with no feed identity, an unparseable one -
 * displays: a redundant toast is a nuisance, a swallowed error is data loss.
 */
function suppressedByFocusedEntity(
  display: NotificationForegroundDisplay,
): boolean {
  if (display.foregroundAppLocal !== null) return false;
  if (display.payload === null) return false;
  const parsed = parseNotificationActivationPayload(display.payload);
  if (!isHostFeedRelay(parsed)) return false;
  const entity = notificationEntityFromPayload(parsed.envelope.route);
  if (entity === null) return false;
  const focusedEntity = readFocusedHostNotificationPresenceEntity();
  return (
    focusedEntity !== null &&
    notificationEntityMatchesPresence(entity, focusedEntity)
  );
}

function isHostFeedRelay(
  parsed: ParsedNotificationActivationPayload,
): parsed is Extract<
  ParsedNotificationActivationPayload,
  { readonly kind: "v1" }
> {
  return (
    parsed.kind === "v1" &&
    (parsed.envelope.feed.source === "host" ||
      parsed.envelope.feed.source === "cloud")
  );
}

/**
 * Host-side presence suppression is authoritative (fresh presence marks the
 * row read at birth and skips the renderer channel entirely), but it runs on
 * TTL'd presence snapshots — an emission can already be in flight when focus
 * lands on the entity, or presence can go stale mid-hold. This gate re-checks
 * live focus at display time so the tab you are looking at never toasts about
 * its own activity; rows for other entities still display.
 *
 * The delivery key names the WHOLE emission, never this window's visible
 * subset. An emission is one batched display, and each window filters it by
 * its own focus - so a subset-derived key would differ between a window that
 * dropped the focused row and one that kept it, the two would fail to
 * deduplicate, and the focused window would show its own filtered toast plus
 * the relayed full batch, chiming twice. Delivery identity has to survive
 * focus filtering to collapse the fan-out it exists to collapse.
 */
export function displayHostChannelEmission(
  entries: ReadonlyArray<HostNotificationEntryV21>,
  target: NotificationDisplayTarget,
  originHostId: string | null,
): void {
  const rows = entries.map(rowFromHostEntry);
  const emissionDeliveryKey = feedRowsDeliveryKey(rows);
  const focusedEntity = readFocusedHostNotificationPresenceEntity();
  const visibleRows =
    focusedEntity === null
      ? rows
      : rows.filter((_row, index) => {
          const entity = notificationEntityFromHostEntry(entries[index]);
          return (
            entity === null ||
            !notificationEntityMatchesPresence(entity, focusedEntity)
          );
        });
  displayFeedRows(visibleRows, target, originHostId, emissionDeliveryKey);
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
