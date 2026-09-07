import {
  HOST_NOTIFICATION_PENDING_PROMPT_KINDS,
  type HostNotificationEntryV22,
  type HostNotificationsCloudFeedRowV11,
  type HostNotificationsEntityRef,
  type HostNotificationsIndicatorState,
  type HostNotificationsIndicatorStateResponse,
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
  /** Failure that is not an agent/terminal lifecycle outcome. */
  readonly unreadNonTerminalFailure?: boolean;
  /** GUI-local subtype used to distinguish terminal failures on aggregate
   * task surfaces. When true, `unreadFailure` is also true. */
  readonly unreadTerminalFailure?: boolean;
  readonly pendingFork: boolean;
  readonly pendingApproval: boolean;
  readonly pendingInterview: boolean;
  readonly unreadDone: boolean;
}

/** GUI-only enrichment of the released host response. */
export type SurfaceNotificationIndicators =
  HostNotificationsIndicatorStateResponse & {
    readonly byOriginHostId?: Readonly<
      Record<string, HostNotificationsIndicatorStateResponse>
    >;
  };

export const EMPTY_NOTIFICATION_INDICATOR_STATE: NotificationIndicatorState = {
  unreadFailure: false,
  unreadNonTerminalFailure: false,
  unreadTerminalFailure: false,
  pendingFork: false,
  pendingApproval: false,
  pendingInterview: false,
  unreadDone: false,
};

const EMPTY_HOST_INDICATOR_STATE = EMPTY_NOTIFICATION_INDICATOR_STATE;

export function selectNotificationIndicatorState(
  state: Pick<AppLocalNotificationsState, "byId">,
  entity: HostNotificationsEntityRef,
  originHostId: string | null,
  indicators: SurfaceNotificationIndicators,
): NotificationIndicatorState {
  const hostState = selectHostIndicatorState(indicators, entity, originHostId);
  const {
    terminal: unreadLocalTerminalFailure,
    nonTerminal: unreadLocalNonTerminalFailure,
  } = selectUnreadLocalFailures(state, entity, originHostId);
  const unreadLocalFailure =
    unreadLocalTerminalFailure || unreadLocalNonTerminalFailure;
  const hostFailureIsAggregateAttention =
    entity.chatId === undefined && hostState.unreadFailure;
  if (!unreadLocalFailure && hostState === EMPTY_HOST_INDICATOR_STATE) {
    return EMPTY_NOTIFICATION_INDICATOR_STATE;
  }
  return {
    unreadFailure: unreadLocalFailure || hostState.unreadFailure,
    unreadNonTerminalFailure:
      unreadLocalNonTerminalFailure || hostFailureIsAggregateAttention,
    // The host indicator's failure bit is produced by terminal notification chronology.
    unreadTerminalFailure:
      unreadLocalTerminalFailure ||
      (hostState.unreadFailure && !hostFailureIsAggregateAttention),
    pendingFork: hostState.pendingFork,
    pendingApproval: hostState.pendingApproval,
    pendingInterview: hostState.pendingInterview,
    unreadDone: hostState.unreadDone,
  };
}

function selectUnreadLocalFailures(
  state: Pick<AppLocalNotificationsState, "byId">,
  entity: HostNotificationsEntityRef,
  originHostId: string | null,
): { readonly terminal: boolean; readonly nonTerminal: boolean } {
  let unreadLocalTerminalFailure = false;
  let unreadLocalNonTerminalFailure = false;
  for (const entry of Object.values(state.byId)) {
    const matchesEntity =
      entry.readAt === null &&
      (originHostId === null || entry.originHostId === originHostId) &&
      (entity.chatId === undefined
        ? notificationPayloadBelongsToEpic(entry.payload, entity.epicId)
        : notificationPayloadBelongsToEntity(entry.payload, entity));
    if (!matchesEntity) continue;
    if (entry.kind === "terminal.closed" || entry.kind === "terminal.crashed") {
      unreadLocalTerminalFailure = true;
    } else {
      unreadLocalNonTerminalFailure = true;
    }
  }
  return {
    terminal: unreadLocalTerminalFailure,
    nonTerminal: unreadLocalNonTerminalFailure,
  };
}

export function useNotificationIndicatorState(
  entity: HostNotificationsEntityRef,
  originHostId: string | null,
  indicators: SurfaceNotificationIndicators,
): NotificationIndicatorState {
  const byId = useAppLocalNotificationsStore((state) => state.byId);
  return selectNotificationIndicatorState(
    { byId },
    entity,
    originHostId,
    indicators,
  );
}

export const EMPTY_INDICATOR_STATE_RESPONSE: HostNotificationsIndicatorStateResponse =
  { epics: {}, chats: {} };

function selectHostIndicatorState(
  indicators: SurfaceNotificationIndicators,
  entity: HostNotificationsEntityRef,
  originHostId: string | null,
): HostNotificationsIndicatorState {
  const byOriginHostId = indicators.byOriginHostId;
  const response =
    originHostId === null || byOriginHostId === undefined
      ? indicators
      : (byOriginHostId[originHostId] ?? EMPTY_INDICATOR_STATE_RESPONSE);
  return entity.chatId === undefined
    ? (response.epics[entity.epicId] ?? EMPTY_HOST_INDICATOR_STATE)
    : (response.chats[entity.chatId] ?? EMPTY_HOST_INDICATOR_STATE);
}

/**
 * The cloud-mode counterpart of the host's `indicatorState` RPC, computed from the snapshot the
 * GUI already holds.
 */
export function selectCloudNotificationIndicators(
  rows: Readonly<Partial<Record<string, HostNotificationsCloudFeedRowV11>>>,
  epicIds: ReadonlyArray<string>,
  chatIds: ReadonlyArray<string>,
): HostNotificationsIndicatorStateResponse {
  return selectCloudNotificationIndicatorProjection(rows, epicIds, chatIds)
    .aggregate;
}

export interface CloudNotificationIndicatorProjection {
  readonly aggregate: HostNotificationsIndicatorStateResponse;
  readonly byOriginHostId: Readonly<
    Record<string, HostNotificationsIndicatorStateResponse>
  >;
}

export function selectCloudNotificationIndicatorProjection(
  rows: Readonly<Partial<Record<string, HostNotificationsCloudFeedRowV11>>>,
  epicIds: ReadonlyArray<string>,
  chatIds: ReadonlyArray<string>,
): CloudNotificationIndicatorProjection {
  const wantedEpicIds = new Set(epicIds);
  const wantedChatIds = new Set(chatIds);
  if (wantedEpicIds.size === 0 && wantedChatIds.size === 0) {
    return {
      aggregate: EMPTY_INDICATOR_STATE_RESPONSE,
      byOriginHostId: {},
    };
  }
  const accumulator = createCloudIndicatorAccumulator(
    wantedEpicIds,
    wantedChatIds,
  );
  const originAccumulators = new Map<string, CloudIndicatorAccumulator>();
  for (const row of Object.values(rows)) {
    if (
      row === undefined ||
      !cloudIndicatorEntryIsWanted(row, wantedEpicIds, wantedChatIds)
    ) {
      continue;
    }
    collectCloudIndicatorEntry(accumulator, row);
    const originAccumulator =
      originAccumulators.get(row.originHostId) ??
      createCloudIndicatorAccumulator(wantedEpicIds, wantedChatIds);
    if (!originAccumulators.has(row.originHostId)) {
      originAccumulators.set(row.originHostId, originAccumulator);
    }
    collectCloudIndicatorEntry(originAccumulator, row);
  }
  const byOriginHostId: Record<
    string,
    HostNotificationsIndicatorStateResponse
  > = {};
  for (const [originHostId, originAccumulator] of originAccumulators) {
    byOriginHostId[originHostId] =
      finalizeCloudIndicatorAccumulator(originAccumulator);
  }
  return {
    aggregate: finalizeCloudIndicatorAccumulator(accumulator),
    byOriginHostId,
  };
}

function cloudIndicatorEntryIsWanted(
  row: HostNotificationsCloudFeedRowV11,
  wantedEpicIds: ReadonlySet<string>,
  wantedChatIds: ReadonlySet<string>,
): boolean {
  const { epicId, chatId } = row.entry;
  return (
    (epicId !== null && wantedEpicIds.has(epicId)) ||
    (chatId !== null && wantedChatIds.has(chatId))
  );
}

function createCloudIndicatorAccumulator(
  wantedEpicIds: ReadonlySet<string>,
  wantedChatIds: ReadonlySet<string>,
): CloudIndicatorAccumulator {
  return {
    wantedEpicIds,
    wantedChatIds,
    epics: {},
    chats: {},
    epicTerminalWinners: new Map(),
    chatTerminalWinners: new Map(),
  };
}

function finalizeCloudIndicatorAccumulator(
  accumulator: CloudIndicatorAccumulator,
): HostNotificationsIndicatorStateResponse {
  const { epics, chats, epicTerminalWinners, chatTerminalWinners } =
    accumulator;
  for (const [epicId, terminalWinners] of epicTerminalWinners) {
    const merged = mergeTerminalContributions(
      epics[epicId],
      terminalEntriesForEpic(terminalWinners),
    );
    if (merged !== undefined) epics[epicId] = merged;
  }
  for (const [chatId, originWinners] of chatTerminalWinners) {
    const merged = mergeTerminalContributions(
      chats[chatId],
      terminalEntriesForOrigins(originWinners),
    );
    if (merged !== undefined) chats[chatId] = merged;
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

/** Exact entity -> origin host -> latest terminal entry in causal write order. */
type CloudTerminalCandidate = {
  readonly entryId: string;
  readonly entry: HostNotificationEntryV22;
};

type CloudTerminalWinners = Map<string, Map<string, CloudTerminalCandidate>>;

function collectCloudIndicatorEntry(
  accumulator: CloudIndicatorAccumulator,
  row: HostNotificationsCloudFeedRowV11,
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
    retainLatestTerminal({
      winners: terminalWinnersForEpic(accumulator.epicTerminalWinners, epicId),
      entityId: chatId === null ? "epic" : `chat:${chatId}`,
      originHostId,
      entryId: row.entryId,
      candidate: entry,
    });
  }
  if (chatId !== null && accumulator.wantedChatIds.has(chatId)) {
    if (contribution !== null) {
      accumulator.chats[chatId] = mergeIndicatorFlags(
        accumulator.chats[chatId],
        contribution,
      );
    }
    retainLatestTerminal({
      winners: accumulator.chatTerminalWinners,
      entityId: chatId,
      originHostId,
      entryId: row.entryId,
      candidate: entry,
    });
  }
}

/** `null` when the entry lights nothing, so an entity with only quiet rows is
 * never allocated an all-false record. */
/**
 * `pendingApproval` is the wire's generic "needs a person" flag: every pending-prompt kind but
 * `interview.requested` lights it, driven off the shared `HOST_NOTIFICATION_PENDING_PROMPT_KINDS`
 */
function indicatorContribution(
  entry: HostNotificationEntryV22,
): HostNotificationsIndicatorState | null {
  if (
    !("resolvedAt" in entry) ||
    entry.resolvedAt !== null ||
    !HOST_NOTIFICATION_PENDING_PROMPT_KINDS.includes(entry.kind)
  ) {
    return null;
  }
  const pendingInterview = entry.kind === "interview.requested";
  return {
    pendingApproval: !pendingInterview,
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

function retainLatestTerminal(input: {
  readonly winners: CloudTerminalWinners;
  readonly entityId: string;
  readonly originHostId: string;
  readonly entryId: string;
  readonly candidate: HostNotificationEntryV22;
}): void {
  if (!isTerminalEntry(input.candidate)) return;
  const originWinners = terminalWinnersForEntity(input.winners, input.entityId);
  const current = originWinners.get(input.originHostId);
  const candidate = { entryId: input.entryId, entry: input.candidate };
  if (
    current === undefined ||
    terminalCandidateSupersedes(candidate, current)
  ) {
    originWinners.set(input.originHostId, candidate);
  }
}

function terminalCandidateSupersedes(
  candidate: CloudTerminalCandidate,
  current: CloudTerminalCandidate,
): boolean {
  const candidateIsRecovery = isAutomaticRecoveryEntry(candidate.entry);
  const currentIsRecovery = isAutomaticRecoveryEntry(current.entry);
  if (candidateIsRecovery && !currentIsRecovery) {
    return (
      current.entry.severity === "failure" &&
      terminalEntryIsNewer(candidate, current)
    );
  }
  if (!candidateIsRecovery && currentIsRecovery) {
    return (
      candidate.entry.severity === "done" ||
      terminalEntryIsNewer(candidate, current)
    );
  }
  return terminalEntryIsNewer(candidate, current);
}

function isAutomaticRecoveryEntry(entry: HostNotificationEntryV22): boolean {
  return (
    entry.kind === "agent.stopped" &&
    "automaticRecovery" in entry.payload &&
    entry.payload.automaticRecovery === true
  );
}

function terminalEntriesForEpic(
  winners: CloudTerminalWinners,
): ReadonlyArray<HostNotificationEntryV22> {
  return [...winners.values()].flatMap(terminalEntriesForOrigins);
}

function terminalEntriesForOrigins(
  winners: Map<string, CloudTerminalCandidate>,
): ReadonlyArray<HostNotificationEntryV22> {
  return [...winners.values()].map((candidate) => candidate.entry);
}

function mergeTerminalContributions(
  current: HostNotificationsIndicatorState | undefined,
  entries: ReadonlyArray<HostNotificationEntryV22>,
): HostNotificationsIndicatorState | undefined {
  return entries.reduce<HostNotificationsIndicatorState | undefined>(
    (merged, entry) => {
      const contribution = terminalIndicatorContribution(entry);
      return contribution === null
        ? merged
        : mergeIndicatorFlags(merged, contribution);
    },
    current,
  );
}

function terminalWinnersForEntity(
  winners: CloudTerminalWinners,
  entityId: string,
): Map<string, CloudTerminalCandidate> {
  const existing = winners.get(entityId);
  if (existing !== undefined) return existing;
  const created = new Map<string, CloudTerminalCandidate>();
  winners.set(entityId, created);
  return created;
}

function isTerminalEntry(entry: HostNotificationEntryV22): boolean {
  return entry.severity === "failure" || entry.severity === "done";
}

function terminalEntryIsNewer(
  candidate: CloudTerminalCandidate,
  current: CloudTerminalCandidate,
): boolean {
  // The origin store clamps every terminal occurrence for one exact entity to a durable causal
  // timestamp.
  return (
    candidate.entry.updatedAt > current.entry.updatedAt ||
    (candidate.entry.updatedAt === current.entry.updatedAt &&
      candidate.entryId > current.entryId)
  );
}

function terminalIndicatorContribution(
  entry: HostNotificationEntryV22,
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
 * Cloud mode has two deliberately separate authorities: feed rows own the read/unread and
 * approval/interview flags across hosts, while the connected host's fork notice board owns
 */
export function mergeHostPendingForkIntoCloudIndicators(
  cloud: SurfaceNotificationIndicators,
  host: HostNotificationsIndicatorStateResponse,
  originHostId: string | null,
): SurfaceNotificationIndicators {
  const pendingChats = Object.entries(host.chats).filter(
    ([, state]) => state.pendingFork,
  );
  if (pendingChats.length === 0) return cloud;
  const aggregate = mergePendingForkChats(cloud, pendingChats);
  if (originHostId === null || cloud.byOriginHostId === undefined) {
    return { ...aggregate, byOriginHostId: cloud.byOriginHostId };
  }
  const scoped =
    cloud.byOriginHostId[originHostId] ?? EMPTY_INDICATOR_STATE_RESPONSE;
  return {
    ...aggregate,
    byOriginHostId: {
      ...cloud.byOriginHostId,
      [originHostId]: mergePendingForkChats(scoped, pendingChats),
    },
  };
}

function mergePendingForkChats(
  response: HostNotificationsIndicatorStateResponse,
  pendingChats: ReadonlyArray<
    readonly [string, HostNotificationsIndicatorState]
  >,
): HostNotificationsIndicatorStateResponse {
  const chats = { ...response.chats };
  for (const [chatId] of pendingChats) {
    chats[chatId] = {
      ...(chats[chatId] ?? EMPTY_NOTIFICATION_INDICATOR_STATE),
      pendingFork: true,
    };
  }
  return { epics: response.epics, chats };
}

/** Two indicator responses folded into one, flag by flag. */
export function mergeIndicatorStateResponses(
  base: HostNotificationsIndicatorStateResponse,
  next: HostNotificationsIndicatorStateResponse,
): HostNotificationsIndicatorStateResponse {
  return {
    epics: mergeIndicatorRecords(base.epics, next.epics),
    chats: mergeIndicatorRecords(base.chats, next.chats),
  };
}

function mergeIndicatorRecords(
  base: Readonly<Record<string, HostNotificationsIndicatorState>>,
  next: Readonly<Record<string, HostNotificationsIndicatorState>>,
): Record<string, HostNotificationsIndicatorState> {
  const merged: Record<string, HostNotificationsIndicatorState> = { ...base };
  for (const [id, state] of Object.entries(next)) {
    merged[id] = mergeIndicatorFlags(merged[id], state);
  }
  return merged;
}
