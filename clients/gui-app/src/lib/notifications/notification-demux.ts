import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { EMPTY_CANVAS } from "@/stores/epics/canvas/canvas-state";
import {
  WORKSPACE_FILE_TAB_KIND,
  type EpicCanvasState,
} from "@/stores/epics/canvas/types";
import { findPaneById } from "@/stores/epics/canvas/tile-tree";
import { isDiffTileRef } from "@/stores/epics/canvas/types";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  rowFromAppLocalEntry,
  rowFromGlobalEntry,
  rowFromHostEntry,
  type MergedNotificationRow,
  type MergedNotificationSource,
} from "@/stores/notifications/merged-notifications";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import { useHostNotificationsStore } from "@/stores/notifications/host-notifications-store";
import { useNotificationsStore } from "@/stores/notifications/notifications-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";

export const NOTIFICATION_EMISSION_HOLD_MS = 3_000;

export type NotificationEmissionRow = MergedNotificationRow;

export interface NotificationEmissionChannel {
  readonly id: string;
  readonly accepts: (row: NotificationEmissionRow) => boolean;
  readonly emit: (rows: ReadonlyArray<NotificationEmissionRow>) => void;
}

export interface NotificationEmissionClock {
  readonly now: () => number;
  readonly setTimeout: (handler: () => void, delayMs: number) => number;
  readonly clearTimeout: (timerId: number) => void;
}

export interface NotificationDemux {
  readonly observe: (rows: ReadonlyArray<NotificationEmissionRow>) => void;
  readonly baselineSource: (
    source: MergedNotificationSource,
    rows: ReadonlyArray<NotificationEmissionRow>,
  ) => void;
  readonly dispose: () => void;
}

export interface CreateNotificationDemuxInput {
  readonly holdMs: number;
  readonly clock: NotificationEmissionClock;
  readonly channels: ReadonlyArray<NotificationEmissionChannel>;
  readonly getRows: () => ReadonlyArray<NotificationEmissionRow>;
  readonly shouldSuppressForFocus: (row: NotificationEmissionRow) => boolean;
}

interface SeenNotification {
  readonly source: MergedNotificationSource;
  readonly readAt: number | null;
  readonly createdAt: number;
}

interface PendingNotification {
  readonly feedId: string;
  readonly source: MergedNotificationSource;
  readonly dueAt: number;
}

interface ChannelState {
  readonly channel: NotificationEmissionChannel;
  readonly pendingById: Map<string, PendingNotification>;
  timerId: number | null;
}

export function createNotificationDemux(
  input: CreateNotificationDemuxInput,
): NotificationDemux {
  let initialized = false;
  let previousById = new Map<string, SeenNotification>();
  const channelStates: ChannelState[] = input.channels.map((channel) => ({
    channel,
    pendingById: new Map<string, PendingNotification>(),
    timerId: null,
  }));

  const cancelPending = (feedId: string): void => {
    for (const state of channelStates) {
      if (!state.pendingById.delete(feedId)) continue;
      scheduleChannelFlush(input, state);
    }
  };

  const enqueuePending = (row: NotificationEmissionRow): void => {
    if (input.shouldSuppressForFocus(row)) return;
    for (const state of channelStates) {
      if (!state.channel.accepts(row)) continue;
      state.pendingById.set(row.feedId, {
        feedId: row.feedId,
        source: row.source,
        dueAt: input.clock.now() + input.holdMs,
      });
      scheduleChannelFlush(input, state);
    }
  };

  const observe = (rows: ReadonlyArray<NotificationEmissionRow>): void => {
    const currentById = seenMapFromRows(rows);
    if (!initialized) {
      initialized = true;
      previousById = currentById;
      return;
    }

    for (const feedId of previousById.keys()) {
      if (!currentById.has(feedId)) {
        cancelPending(feedId);
      }
    }

    for (const row of rows) {
      if (row.readAt !== null) {
        cancelPending(row.feedId);
        continue;
      }
      if (isNewUnreadNotification(previousById.get(row.feedId), row)) {
        enqueuePending(row);
      }
    }

    previousById = currentById;
  };

  const baselineSource = (
    source: MergedNotificationSource,
    rows: ReadonlyArray<NotificationEmissionRow>,
  ): void => {
    for (const state of channelStates) {
      for (const pending of state.pendingById.values()) {
        if (pending.source === source) {
          state.pendingById.delete(pending.feedId);
        }
      }
      scheduleChannelFlush(input, state);
    }

    const nextById = new Map(
      Array.from(previousById.entries()).filter(
        ([, seen]) => seen.source !== source,
      ),
    );
    for (const row of rows) {
      if (row.source !== source) continue;
      nextById.set(row.feedId, seenNotificationFromRow(row));
    }
    previousById = nextById;
    initialized = true;
  };

  const dispose = (): void => {
    for (const state of channelStates) {
      if (state.timerId !== null) {
        input.clock.clearTimeout(state.timerId);
        state.timerId = null;
      }
      state.pendingById.clear();
    }
  };

  return { observe, baselineSource, dispose };
}

function seenMapFromRows(
  rows: ReadonlyArray<NotificationEmissionRow>,
): Map<string, SeenNotification> {
  return new Map(rows.map((row) => [row.feedId, seenNotificationFromRow(row)]));
}

function seenNotificationFromRow(
  row: NotificationEmissionRow,
): SeenNotification {
  return {
    source: row.source,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

function isNewUnreadNotification(
  previous: SeenNotification | undefined,
  row: NotificationEmissionRow,
): boolean {
  return (
    previous === undefined ||
    previous.readAt !== null ||
    previous.createdAt !== row.createdAt
  );
}

function scheduleChannelFlush(
  input: CreateNotificationDemuxInput,
  state: ChannelState,
): void {
  if (state.timerId !== null) {
    input.clock.clearTimeout(state.timerId);
    state.timerId = null;
  }
  const latestDueAt = Math.max(
    ...Array.from(state.pendingById.values()).map((pending) => pending.dueAt),
    0,
  );
  if (latestDueAt === 0) return;
  const delayMs = Math.max(0, latestDueAt - input.clock.now());
  state.timerId = input.clock.setTimeout(() => {
    state.timerId = null;
    flushChannel(input, state);
  }, delayMs);
}

function flushChannel(
  input: CreateNotificationDemuxInput,
  state: ChannelState,
): void {
  const rowsById = new Map(input.getRows().map((row) => [row.feedId, row]));
  const pendingIds = Array.from(state.pendingById.keys());
  state.pendingById.clear();
  const survivors = pendingIds
    .map((feedId) => rowsById.get(feedId))
    .filter((row): row is NotificationEmissionRow => row !== undefined)
    .filter((row) => row.readAt === null)
    .filter((row) => state.channel.accepts(row))
    .filter((row) => !input.shouldSuppressForFocus(row));
  if (survivors.length === 0) return;
  state.channel.emit(survivors);
}

export function readNotificationEmissionRows(): ReadonlyArray<NotificationEmissionRow> {
  const hostState = useHostNotificationsStore.getState();
  const hostRows = hostState.orderedIds
    .map((id) => hostState.byId[id])
    .map(rowFromHostEntry);

  const appLocalState = useAppLocalNotificationsStore.getState();
  const appLocalRows = appLocalState.orderedIds
    .map((id) => appLocalState.byId[id])
    .map(rowFromAppLocalEntry);

  const globalRows = useNotificationsStore
    .getState()
    .entries.map(rowFromGlobalEntry);

  return [...hostRows, ...appLocalRows, ...globalRows];
}

export function subscribeNotificationEmissionSources(
  demux: Pick<NotificationDemux, "observe" | "baselineSource">,
): () => void {
  demux.observe(readNotificationEmissionRows());
  const unsubscribers = [
    useHostNotificationsStore.subscribe((state, prevState) => {
      const rows = readNotificationEmissionRows();
      if (state.snapshotEpoch !== prevState.snapshotEpoch) {
        demux.baselineSource("host", rows);
        return;
      }
      demux.observe(rows);
    }),
    useAppLocalNotificationsStore.subscribe(() => {
      demux.observe(readNotificationEmissionRows());
    }),
    useNotificationsStore.subscribe(() => {
      demux.observe(readNotificationEmissionRows());
    }),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

export function defaultNotificationChannelAccepts(
  row: NotificationEmissionRow,
): boolean {
  return row.appLocalKind !== null || isDefaultHostEmissionKind(row);
}

function isDefaultHostEmissionKind(row: NotificationEmissionRow): boolean {
  return (
    row.hostKind === "agent.stopped" ||
    row.hostKind === "approval.requested" ||
    row.hostKind === "interview.requested"
  );
}

export function shouldSuppressNotificationEmissionForFocus(
  row: NotificationEmissionRow,
): boolean {
  if (
    row.hostKind === "agent.stopped" &&
    !useSettingsStore.getState().notifyOnChatTurnComplete
  ) {
    return true;
  }
  if (!isAppFocused()) return false;
  if (useNotificationsPopoverStore.getState().open) return true;
  return isNotificationEntityInView(row);
}

function isAppFocused(): boolean {
  return typeof document !== "undefined" && document.hasFocus();
}

function isNotificationEntityInView(row: NotificationEmissionRow): boolean {
  const payload = row.payload;
  if (payload === null) return false;
  switch (payload.kind) {
    case "epic":
      return isEpicActive(payload.epicId);
    case "chat":
      return isEpicArtifactActive(payload.epicId, payload.chatId);
    case "approval":
      if (payload.epicId === undefined) return false;
      return isEpicArtifactActive(payload.epicId, payload.chatId);
    case "interview":
      return isEpicArtifactActive(payload.epicId, payload.chatId);
    case "artifact":
      if (payload.epicId === undefined) return false;
      return isEpicArtifactActive(payload.epicId, payload.artifactId);
    case "session":
      return false;
  }
}

function isEpicActive(epicId: string): boolean {
  const state = useEpicCanvasStore.getState();
  const activeTab =
    state.activeTabId === null ? null : state.tabsById[state.activeTabId];
  return activeTab?.epicId === epicId;
}

function isEpicArtifactActive(
  epicId: string,
  artifactId: string | undefined,
): boolean {
  const state = useEpicCanvasStore.getState();
  const activeTab =
    state.activeTabId === null ? null : state.tabsById[state.activeTabId];
  if (activeTab?.epicId !== epicId) return false;
  if (artifactId === undefined) return true;
  return (
    activeArtifactId(state.canvasByTabId[activeTab.tabId] ?? EMPTY_CANVAS) ===
    artifactId
  );
}

function activeArtifactId(canvas: EpicCanvasState): string | null {
  if (canvas.activePaneId === null) return null;
  const pane = findPaneById(canvas.root, canvas.activePaneId);
  if (pane === null || pane.activeTabId === null) return null;
  const active = canvas.tilesByInstanceId[pane.activeTabId];
  if (active === undefined) return null;
  if (active.type === WORKSPACE_FILE_TAB_KIND) return null;
  if (isDiffTileRef(active)) return null;
  return active.id;
}
