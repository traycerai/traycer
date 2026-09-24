import {
  NotificationDeliveryReceipts,
  projectNotificationFeedDisplay,
  type NotificationFeedDisplay,
  type NotificationFeedOccurrence,
} from "@traycer-clients/shared/notifications/feed-delivery";
import { useAuthStore } from "@/stores/auth/auth-store";
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

// A renderer keeps its receipts across stream reconnects and serving-host
// changes. Account + origin identity prevents unrelated feeds colliding.
const feedDisplayReceipts = new NotificationDeliveryReceipts(5_000);
const pendingFeedOccurrences = new Map<string, Promise<void>>();

export function resetNotificationFeedDisplayReceiptsForTests(): void {
  feedDisplayReceipts.clear();
  pendingFeedOccurrences.clear();
}

function feedOccurrenceKey(
  originHostId: string | null,
  coalesceKey: string,
  entry: HostNotificationEntryV22,
): string {
  return JSON.stringify([
    "feed-occurrence-v1",
    useAuthStore.getState().contextMetadata?.userId ?? null,
    originHostId,
    coalesceKey,
    entry.updatedAt,
    entry.sourceRef,
  ]);
}

function claimFeedOccurrence(key: string): boolean {
  if (feedDisplayReceipts.has(key)) return false;
  feedDisplayReceipts.record(key);
  return true;
}

/**
 * Structured feed relays are authorized by the shell's occurrence ledger.
 * Legacy relays remain a fallback while the receiving feed is unavailable.
 */
export function displayForwardedForegroundNotification(
  display: NotificationForegroundDisplay,
  target: {
    readonly playChime: (eventType: NotificationChimeEventType) => void;
    readonly onToastClick: (payload: unknown) => void;
  },
): void {
  const eligible = eligibleForegroundDisplay(display);
  if (eligible === null) return;
  const parsed =
    eligible.payload === null
      ? null
      : parseNotificationActivationPayload(eligible.payload);
  const actionable = eligible.payload !== null;
  const title = actionable
    ? createElement(
        "button",
        {
          type: "button",
          "aria-label": `${eligible.title} ${eligible.body}`,
          "data-notification-toast-action": "",
          className: "min-w-0 text-left",
          onClick: () => target.onToastClick(eligible.payload),
        },
        createElement(
          "span",
          { className: "block font-medium leading-normal" },
          eligible.title,
        ),
        createElement(
          "span",
          {
            className:
              "mt-0.5 block text-sm leading-snug text-muted-foreground",
          },
          eligible.body,
        ),
      )
    : eligible.title;
  toast(title, {
    description: actionable ? undefined : eligible.body,
    id: eligible.replaceKey ?? undefined,
  });
  target.playChime(
    notificationChimeEventTypeForSeverities(
      eligible.feedOccurrences?.map(
        (occurrence) => occurrence.chimeEventType,
      ) ?? [],
    ) ?? (parsed?.kind === "v1" ? parsed.envelope.chimeEventType : "done"),
  );
}

function eligibleForegroundDisplay(
  display: NotificationForegroundDisplay,
): NotificationForegroundDisplay | null {
  const parsed =
    display.payload === null
      ? null
      : parseNotificationActivationPayload(display.payload);
  if (!isFeedRelay(display, parsed)) return display;
  if (display.feedOccurrences === undefined) {
    if (ownFeedIsDelivering(relayedFeedSource(display, parsed))) return null;
    return suppressedByFocusedEntity(parsed) ? null : display;
  }
  const fresh = display.feedOccurrences.filter((occurrence) => {
    if (!feedOccurrenceMatchesAccount(occurrence)) return false;
    if (feedDisplayReceipts.has(occurrence.key)) return false;
    if (feedOccurrenceIsFocused(occurrence)) return false;
    return claimFeedOccurrence(occurrence.key);
  });
  const projection = projectNotificationFeedDisplay(fresh);
  return projection === null ? null : { ...display, ...projection };
}

function feedOccurrenceMatchesAccount(
  occurrence: NotificationFeedOccurrence,
): boolean {
  return (
    occurrence.userId ===
    (useAuthStore.getState().contextMetadata?.userId ?? null)
  );
}

function feedOccurrenceIsFocused(
  occurrence: NotificationFeedOccurrence,
): boolean {
  if (occurrence.epicId === null) return false;
  const focused = readFocusedHostNotificationPresence();
  return (
    focused !== null &&
    notificationOriginMatchesFocus(
      occurrence.originHostId,
      focused.originHostId,
    ) &&
    notificationEntityMatchesPresence(
      {
        epicId: occurrence.epicId,
        ...(occurrence.chatId === null ? {} : { chatId: occurrence.chatId }),
      },
      focused.entity,
    )
  );
}

/**
 * Whether a relayed display is a feed row, which every window receives on its
 * own subscription.
 *
 * Only app-local displays are excluded, and they are identified POSITIVELY -
 * by `foregroundAppLocal`, which their path always sets, or by an app-local
 * envelope. Everything else counts as a feed row, deliberately including a
 * display whose activation payload is `null`: `payloadFromHostEntry` degrades
 * an unrecognized payload (a newer host's shape, a cross-kind row) to null
 * while the row's durable `epicId`/`chatId` stay authoritative. Treating
 * those as unattributable would hand precisely the rows the entity gate
 * cannot inspect straight past it - and the receiving window's own feed
 * copy, which IS gated on the durable columns, would be the one suppressed.
 */
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
 * The feed that produced a relayed display. The display's own `feedSource`
 * field is authoritative: it is stamped from the row at send time and
 * survives payload degradation, which the activation envelope does not - a
 * row whose payload degraded to null ships a null envelope, and deriving
 * provenance from it would erase "cloud" exactly on the rows the coverage
 * check below must not hand to the local feed. The envelope is kept as a
 * fallback for a display minted without the field.
 */
function relayedFeedSource(
  display: NotificationForegroundDisplay,
  parsed: ParsedNotificationActivationPayload | null,
): NotificationFeedSource | null {
  if (display.feedSource !== null) return display.feedSource;
  return parsed?.kind === "v1" ? parsed.envelope.feed.source : null;
}

/**
 * Whether this window's own feed subscription can reproduce the relayed row -
 * meaning ignoring the relay loses nothing, because the row is already
 * arriving here directly.
 *
 * A stream can go terminal without the window noticing, and then the relay is
 * the only copy of the row this window will ever see - dropping it as
 * "redundant" would make a broken feed silently swallow notifications too.
 *
 * Reproducibility is directional across the two feeds. The cloud feed carries
 * every host row (each host replicates up), so a delivering cloud feed covers
 * host-source and unattributable relays too. The v1 local feed carries only
 * THIS machine's rows, so it never covers a cloud-source relay: windows can
 * transiently disagree on feed mode (capability negotiation is per-window),
 * and a cloud arrival relayed from a cloud-mode window can name a remote
 * host's occurrence the local feed will never emit - and once this window
 * upgrades, that occurrence lands inside its silent baseline snapshot.
 */
function ownFeedIsDelivering(source: NotificationFeedSource | null): boolean {
  const cloud = useCloudNotificationsStore.getState();
  if (cloud.connectionState === "connected" && cloud.hasSnapshot) return true;
  if (source === "cloud") return false;
  const host = useHostNotificationsStore.getState();
  // Transport `open` is not usability: the host stream reports open before its
  // first snapshot lands, and a baseline snapshot never calls the channel
  // emission. Relays dropped in that window would be the only copy of an
  // occurrence this renderer had. `summary` is the host analogue of the cloud
  // `hasSnapshot` flag - applied with each snapshot and nulled again whenever
  // the transport leaves `open`, so it cannot go stale across a reconnect.
  return host.connectionStatus === "open" && host.summary !== null;
}

export function displayNotificationRows(
  rows: ReadonlyArray<MergedNotificationRow>,
  target: NotificationDisplayTarget,
  originHostId: string | null,
): void {
  displayFeedRows(rows, target, originHostId, feedRowsDeliveryKey(rows));
}

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

/** Generic display callers retain their source-specific delivery identity.
 * Host/cloud entry points instead supply source-independent occurrence keys. */
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
      // Provenance for the receive-side relay gates, independent of the
      // activation payload: the payload degrades to null for unrecognized
      // rows, and a batch's rows share one source (batches only come from
      // the v1 host emission).
      feedSource: content.row.source,
      foregroundAppLocal: options.foregroundAppLocal,
    });
  } catch (error) {
    renderNotificationToast(content, target, "focused");
    throw error;
  }
  const renderChimed = renderNotificationToast(content, target, "focused");
  const outcome = await nativeDisplay;
  // `undeliverable`: the platform cannot present notifications and no window
  // was focused, so nothing was shown or relayed and the burnt delivery key
  // makes it unretryable - this window (the ledger's single winner; every
  // other window heard `duplicate`) owns the only audible cue there will be.
  // The single-voice guard is the RECORDED fact that the render-time chime
  // ran, never a second focus read: focus can flip while the outcome is
  // pending, and a re-read would double-chime on focused-then-blurred and
  // stay silent on blurred-then-focused.
  if (outcome === "undeliverable" && !renderChimed) {
    target.playChime(content.chimeEventType);
  }
}

/** Renders the in-app toast and returns whether the focus-gated chime ran. */
function renderNotificationToast(
  content: NotificationToastContent,
  target: NotificationDisplayTarget,
  chime: "focused" | "always" | "never",
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
  // Only the CHIME is focus-gated, never the toast. The main process treats a
  // focused sender as already-delivered and relays nothing back to it, so a
  // renderer that skipped its own toast on an independent focus read would
  // leave the arrival with no surface at all whenever focus landed between
  // the two checks - and the burnt delivery key makes that unretryable.
  // Rendering unconditionally keeps delivery a single decision (the main
  // process picks banner or relay) and leaves the renderer only this one,
  // which is never the sole delivery: an unseen toast is harmless, while a
  // chime from a window nobody is looking at is not.
  if (chime === "never" || (chime === "focused" && !isDocumentFocused())) {
    return false;
  }
  target.playChime(content.chimeEventType);
  return true;
}

/**
 * Whether a FALLBACK relay - one this window is rendering because its own
 * feed is not delivering - is addressed to the entity currently in focus.
 * Reached only on that path; when our feed is live the relay is ignored
 * outright. A payload that names no entity (degraded or unparseable) cannot
 * be gated and therefore renders: on a broken feed, a redundant toast beats
 * silence.
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

/** Keep host batching while sharing occurrence receipts with cloud arrivals. */
export async function displayHostChannelEmission(
  entries: ReadonlyArray<HostNotificationEntryV22>,
  target: NotificationDisplayTarget,
  originHostId: string | null,
): Promise<void> {
  const focused = readFocusedHostNotificationPresence();
  const rows: MergedNotificationRow[] = [];
  const occurrences: NotificationFeedOccurrence[] = [];
  for (const entry of entries) {
    const key = feedOccurrenceKey(originHostId, entry.id, entry);
    if (feedDisplayReceipts.has(key) || entry.readAt !== null) {
      continue;
    }
    const entity = notificationEntityFromHostEntry(entry);
    if (
      focused !== null &&
      notificationOriginMatchesFocus(originHostId, focused.originHostId) &&
      entity !== null &&
      notificationEntityMatchesPresence(entity, focused.entity)
    ) {
      continue;
    }
    const row = rowFromHostEntry(entry);
    rows.push(row);
    occurrences.push(
      feedOccurrenceDisplay({
        row,
        key,
        originHostId,
        feedSource: "host",
        entry,
      }),
    );
  }
  await displayFeedOccurrences(rows, occurrences, target);
}

/** Cloud copies use the origin's semantic key, never their replica row id. */
export async function displayCloudSnapshotArrivals(
  entries: ReadonlyArray<HostNotificationsCloudFeedRowV11>,
  target: NotificationDisplayTarget,
): Promise<void> {
  const focused = readFocusedHostNotificationPresence();
  const deliveries: Promise<void>[] = [];
  for (const entry of entries) {
    const key = feedOccurrenceKey(
      entry.originHostId,
      entry.coalesceKey,
      entry.entry,
    );
    if (feedDisplayReceipts.has(key) || entry.entry.readAt !== null) {
      continue;
    }
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
    const row = rowFromCloudFeedRow(entry);
    deliveries.push(
      displayFeedOccurrences(
        [row],
        [
          feedOccurrenceDisplay({
            row,
            key,
            originHostId: entry.originHostId,
            feedSource: "cloud",
            entry: entry.entry,
          }),
        ],
        target,
      ),
    );
  }
  await Promise.all(deliveries);
}

function feedOccurrenceDisplay({
  row,
  key,
  originHostId,
  feedSource,
  entry,
}: {
  readonly row: MergedNotificationRow;
  readonly key: string;
  readonly originHostId: string | null;
  readonly feedSource: "host" | "cloud";
  readonly entry: HostNotificationEntryV22;
}): NotificationFeedOccurrence {
  const content = buildNotificationToastContent([row]);
  return {
    key,
    userId: useAuthStore.getState().contextMetadata?.userId ?? null,
    chimeEventType: content.chimeEventType,
    title: content.title,
    body: content.body,
    replaceKey: content.replaceKey,
    payload:
      content.payload === null
        ? null
        : buildNotificationActivationEnvelope({
            route: content.payload,
            feed: { source: row.source, id: row.sourceId },
            chimeEventType: content.chimeEventType,
            originHostId,
          }),
    feedSource,
    originHostId,
    epicId: entry.epicId,
    chatId: entry.chatId,
  };
}

async function displayFeedOccurrences(
  rows: ReadonlyArray<MergedNotificationRow>,
  occurrences: ReadonlyArray<NotificationFeedOccurrence>,
  target: NotificationDisplayTarget,
): Promise<void> {
  // Keep a concurrent copy available to retry if the first submission fails.
  // Waiting also prevents host/cloud races from claiming the same local toast.
  for (;;) {
    const pending = occurrences.flatMap((occurrence) => {
      const delivery = pendingFeedOccurrences.get(occurrence.key);
      return delivery === undefined ? [] : [delivery];
    });
    if (pending.length === 0) break;
    await Promise.all(pending);
  }
  const seen = new Set<string>();
  const ready = occurrences.filter((occurrence) => {
    if (
      feedDisplayReceipts.has(occurrence.key) ||
      !feedOccurrenceMatchesAccount(occurrence) ||
      seen.has(occurrence.key) ||
      feedOccurrenceIsFocused(occurrence)
    ) {
      return false;
    }
    seen.add(occurrence.key);
    return true;
  });
  const display = projectNotificationFeedDisplay(ready);
  if (display === null) return;
  let release = (): void => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const occurrence of ready) {
    pendingFeedOccurrences.set(occurrence.key, pending);
  }
  try {
    const result = await submitFeedDisplay(display, target);
    if (result === "duplicate") return;
    const accepted =
      typeof result === "string"
        ? ready
        : (result.display?.feedOccurrences ?? []);
    const freshKeys = new Set(
      accepted
        .filter(
          (occurrence) =>
            feedOccurrenceMatchesAccount(occurrence) &&
            !feedOccurrenceIsFocused(occurrence) &&
            claimFeedOccurrence(occurrence.key),
        )
        .map((occurrence) => occurrence.key),
    );
    const freshRows = rows.filter((_row, index) =>
      freshKeys.delete(occurrences[index].key),
    );
    if (freshRows.length === 0) return;
    const outcome = typeof result === "string" ? result : result.outcome;
    // A native banner owns its sound. Only an unsupported platform grants
    // this caller the fallback chime; foreground delivery uses the relay.
    let chime: "always" | "focused" | "never" =
      typeof result === "string" ? "focused" : "never";
    if (outcome === "undeliverable") chime = "always";
    renderNotificationToast(
      buildNotificationToastContent(freshRows),
      target,
      chime,
    );
  } finally {
    for (const occurrence of ready) {
      pendingFeedOccurrences.delete(occurrence.key);
    }
    release();
  }
}

async function submitFeedDisplay(
  display: NotificationFeedDisplay,
  target: NotificationDisplayTarget,
): Promise<NotificationShowOutcome | "local-fallback"> {
  try {
    return await target.showNotification({
      ...display,
      foregroundAppLocal: null,
    });
  } catch {
    // A host-only or remote-only arrival may never have another feed copy.
    // Retry once, fencing account/focus changes during the failed request.
    const retry = projectNotificationFeedDisplay(
      display.feedOccurrences.filter(
        (occurrence) =>
          feedOccurrenceMatchesAccount(occurrence) &&
          !feedDisplayReceipts.has(occurrence.key) &&
          !feedOccurrenceIsFocused(occurrence),
      ),
    );
    if (retry === null) return "duplicate";
    try {
      return await target.showNotification({
        ...retry,
        foregroundAppLocal: null,
      });
    } catch {
      // No shell-elected winner: only a focused renderer may sound its local
      // fallback, otherwise several failing windows would all chime.
      return "local-fallback";
    }
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
