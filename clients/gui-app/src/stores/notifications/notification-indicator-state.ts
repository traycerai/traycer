import type {
  HostNotificationEntry,
  HostNotificationsCloudFeedRow,
  HostNotificationsEntityRef,
  HostNotificationsIndicatorState,
  HostNotificationsIndicatorStateResponse,
} from "@traycer/protocol/host/notifications/contracts";
import {
  notificationPayloadBelongsToEntity,
  notificationPayloadBelongsToEpic,
} from "@/lib/notifications";
import {
  useAppLocalNotificationsStore,
  type AppLocalNotificationsState,
} from "@/stores/notifications/app-local-notifications-store";

export interface NotificationIndicatorState {
  readonly unreadFailure: boolean;
  readonly pendingFork: boolean;
  readonly pendingApproval: boolean;
  readonly pendingInterview: boolean;
  readonly unreadDone: boolean;
}

export const EMPTY_NOTIFICATION_INDICATOR_STATE: NotificationIndicatorState = {
  unreadFailure: false,
  pendingFork: false,
  pendingApproval: false,
  pendingInterview: false,
  unreadDone: false,
};

const EMPTY_HOST_INDICATOR_STATE = EMPTY_NOTIFICATION_INDICATOR_STATE;

export function selectNotificationIndicatorState(
  state: Pick<AppLocalNotificationsState, "byId">,
  entity: HostNotificationsEntityRef,
  indicators: HostNotificationsIndicatorStateResponse,
): NotificationIndicatorState {
  const hostState =
    entity.chatId === undefined
      ? (indicators.epics[entity.epicId] ?? EMPTY_HOST_INDICATOR_STATE)
      : (indicators.chats[entity.chatId] ?? EMPTY_HOST_INDICATOR_STATE);
  const unreadLocalFailure = Object.values(state.byId).some(
    (entry) =>
      entry.readAt === null &&
      (entity.chatId === undefined
        ? notificationPayloadBelongsToEpic(entry.payload, entity.epicId)
        : notificationPayloadBelongsToEntity(entry.payload, entity)),
  );
  if (!unreadLocalFailure && hostState === EMPTY_HOST_INDICATOR_STATE) {
    return EMPTY_NOTIFICATION_INDICATOR_STATE;
  }
  return {
    unreadFailure: unreadLocalFailure || hostState.unreadFailure,
    pendingFork: hostState.pendingFork,
    pendingApproval: hostState.pendingApproval,
    pendingInterview: hostState.pendingInterview,
    unreadDone: hostState.unreadDone,
  };
}

export function useNotificationIndicatorState(
  entity: HostNotificationsEntityRef,
  indicators: HostNotificationsIndicatorStateResponse,
): NotificationIndicatorState {
  const byId = useAppLocalNotificationsStore((state) => state.byId);
  return selectNotificationIndicatorState({ byId }, entity, indicators);
}

export const EMPTY_INDICATOR_STATE_RESPONSE: HostNotificationsIndicatorStateResponse =
  { epics: {}, chats: {} };

/**
 * The cloud-mode counterpart of the host's `indicatorState` RPC, computed from
 * the snapshot the GUI already holds.
 *
 * The cloud feed is the complete VISIBLE set (the relay only ever sends whole
 * snapshots, already filtered for cleared/superseded), and every row carries
 * the entity columns, severity, kind and markers, so it can mirror the host's
 * derivation over rows from EVERY host rather than only the connected one.
 * Pending prompts are ORed normally. Terminal rows first resolve to the newest
 * outcome for each exact entity within one origin host, whose timestamps share
 * a clock domain. Those per-host winners are then rolled into epic state. This
 * lets a later success replace an earlier failure from one host without
 * comparing clocks across hosts or allowing another host/entity's success to
 * hide a real failure.
 * `pendingFork` is always false here: fork truth is host-local and is merged
 * from the host response after this feed-row derivation, never inferred from a
 * retained cloud row.
 *
 * Sparse on purpose: an entity with nothing lit is omitted, which
 * `selectNotificationIndicatorState`'s `?? EMPTY` lookup reads identically to
 * the host's all-false row while keeping the empty result referentially
 * stable.
 */
export function selectCloudNotificationIndicators(
  rows: Readonly<Partial<Record<string, HostNotificationsCloudFeedRow>>>,
  epicIds: ReadonlyArray<string>,
  chatIds: ReadonlyArray<string>,
): HostNotificationsIndicatorStateResponse {
  const wantedEpicIds = new Set(epicIds);
  const wantedChatIds = new Set(chatIds);
  if (wantedEpicIds.size === 0 && wantedChatIds.size === 0) {
    return EMPTY_INDICATOR_STATE_RESPONSE;
  }
  const epics: Record<string, HostNotificationsIndicatorState> = {};
  const chats: Record<string, HostNotificationsIndicatorState> = {};
  const epicTerminalWinners = new Map<string, CloudTerminalWinners>();
  const chatTerminalWinners: CloudTerminalWinners = new Map();
  const accumulator: CloudIndicatorAccumulator = {
    wantedEpicIds,
    wantedChatIds,
    epics,
    chats,
    epicTerminalWinners,
    chatTerminalWinners,
  };
  for (const row of Object.values(rows)) {
    if (row === undefined) continue;
    collectCloudIndicatorEntry(accumulator, row);
  }
  for (const [epicId, terminalWinners] of epicTerminalWinners) {
    for (const originWinners of terminalWinners.values()) {
      for (const winner of originWinners.values()) {
        const contribution = terminalIndicatorContribution(winner);
        if (contribution !== null) {
          epics[epicId] = mergeIndicatorFlags(epics[epicId], contribution);
        }
      }
    }
  }
  for (const [chatId, originWinners] of chatTerminalWinners) {
    for (const winner of originWinners.values()) {
      const contribution = terminalIndicatorContribution(winner);
      if (contribution !== null) {
        chats[chatId] = mergeIndicatorFlags(chats[chatId], contribution);
      }
    }
  }
  return { epics, chats };
}

interface CloudIndicatorAccumulator {
  readonly wantedEpicIds: ReadonlySet<string>;
  readonly wantedChatIds: ReadonlySet<string>;
  readonly epics: Record<string, HostNotificationsIndicatorState>;
  readonly chats: Record<string, HostNotificationsIndicatorState>;
  readonly epicTerminalWinners: Map<string, CloudTerminalWinners>;
  readonly chatTerminalWinners: CloudTerminalWinners;
}

/** Exact entity -> origin host -> latest terminal entry in that host's clock. */
type CloudTerminalWinners = Map<string, Map<string, HostNotificationEntry>>;

function collectCloudIndicatorEntry(
  accumulator: CloudIndicatorAccumulator,
  row: HostNotificationsCloudFeedRow,
): void {
  const { entry, originHostId } = row;
  const contribution = indicatorContribution(entry);
  const { epicId, chatId } = entry;
  if (epicId !== null && accumulator.wantedEpicIds.has(epicId)) {
    if (contribution !== null) {
      accumulator.epics[epicId] = mergeIndicatorFlags(
        accumulator.epics[epicId],
        contribution,
      );
    }
    retainLatestTerminal(
      terminalWinnersForEpic(accumulator.epicTerminalWinners, epicId),
      chatId === null ? "epic" : `chat:${chatId}`,
      originHostId,
      entry,
    );
  }
  if (chatId !== null && accumulator.wantedChatIds.has(chatId)) {
    if (contribution !== null) {
      accumulator.chats[chatId] = mergeIndicatorFlags(
        accumulator.chats[chatId],
        contribution,
      );
    }
    retainLatestTerminal(
      accumulator.chatTerminalWinners,
      chatId,
      originHostId,
      entry,
    );
  }
}

/** `null` when the entry lights nothing, so an entity with only quiet rows is
 * never allocated an all-false record. */
function indicatorContribution(
  entry: HostNotificationEntry,
): HostNotificationsIndicatorState | null {
  const pendingApproval =
    entry.kind === "approval.requested" && entry.resolvedAt === null;
  const pendingInterview =
    entry.kind === "interview.requested" && entry.resolvedAt === null;
  if (!pendingApproval && !pendingInterview) {
    return null;
  }
  return {
    pendingApproval,
    pendingInterview,
    pendingFork: false,
    unreadFailure: false,
    unreadDone: false,
  };
}

function terminalWinnersForEpic(
  winners: Map<string, CloudTerminalWinners>,
  epicId: string,
): CloudTerminalWinners {
  const existing = winners.get(epicId);
  if (existing !== undefined) return existing;
  const created: CloudTerminalWinners = new Map();
  winners.set(epicId, created);
  return created;
}

function retainLatestTerminal(
  winners: CloudTerminalWinners,
  entityId: string,
  originHostId: string,
  candidate: HostNotificationEntry,
): void {
  if (!isTerminalEntry(candidate)) return;
  const originWinners = terminalWinnersForEntity(winners, entityId);
  const current = originWinners.get(originHostId);
  if (current === undefined || terminalEntryIsNewer(candidate, current)) {
    originWinners.set(originHostId, candidate);
  }
}

function terminalWinnersForEntity(
  winners: CloudTerminalWinners,
  entityId: string,
): Map<string, HostNotificationEntry> {
  const existing = winners.get(entityId);
  if (existing !== undefined) return existing;
  const created = new Map<string, HostNotificationEntry>();
  winners.set(entityId, created);
  return created;
}

function isTerminalEntry(entry: HostNotificationEntry): boolean {
  return entry.severity === "failure" || entry.severity === "done";
}

function terminalEntryIsNewer(
  candidate: HostNotificationEntry,
  current: HostNotificationEntry,
): boolean {
  if (candidate.updatedAt !== current.updatedAt) {
    return candidate.updatedAt > current.updatedAt;
  }
  if ((candidate.readAt === null) !== (current.readAt === null)) {
    return candidate.readAt === null;
  }
  return candidate.severity === "failure" && current.severity === "done";
}

function terminalIndicatorContribution(
  entry: HostNotificationEntry,
): HostNotificationsIndicatorState | null {
  if (entry.readAt !== null || !isTerminalEntry(entry)) return null;
  return {
    pendingApproval: false,
    pendingInterview: false,
    pendingFork: false,
    unreadFailure: entry.severity === "failure",
    unreadDone: entry.severity === "done",
  };
}

/** The host's `MAX(CASE WHEN ...)` aggregate: any contributing row lights the
 * entity's flag. */
function mergeIndicatorFlags(
  current: HostNotificationsIndicatorState | undefined,
  next: HostNotificationsIndicatorState,
): HostNotificationsIndicatorState {
  if (current === undefined) return next;
  return {
    pendingApproval: current.pendingApproval || next.pendingApproval,
    pendingInterview: current.pendingInterview || next.pendingInterview,
    pendingFork: current.pendingFork || next.pendingFork,
    unreadFailure: current.unreadFailure || next.unreadFailure,
    unreadDone: current.unreadDone || next.unreadDone,
  };
}

/**
 * Cloud mode has two deliberately separate authorities: feed rows own the
 * read/unread and approval/interview flags across hosts, while the connected
 * host's fork notice board owns `pendingFork`. Merge only that one host-local
 * bit so local SQLite read markers can never override the cloud feed view.
 */
export function mergeHostPendingForkIntoCloudIndicators(
  cloud: HostNotificationsIndicatorStateResponse,
  host: HostNotificationsIndicatorStateResponse,
): HostNotificationsIndicatorStateResponse {
  const pendingChats = Object.entries(host.chats).filter(
    ([, state]) => state.pendingFork,
  );
  if (pendingChats.length === 0) return cloud;
  const chats = { ...cloud.chats };
  for (const [chatId] of pendingChats) {
    chats[chatId] = {
      ...(chats[chatId] ?? EMPTY_NOTIFICATION_INDICATOR_STATE),
      pendingFork: true,
    };
  }
  return { epics: cloud.epics, chats };
}
