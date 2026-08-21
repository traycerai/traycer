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

/**
 * GUI-only enrichment of the released host response. Aggregate surfaces read
 * `epics` / `chats` exactly as before; host-bound tabs use the per-origin
 * projection so another host's same-id lineage cannot decorate the tab.
 */
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
    // The host indicator's failure bit is produced by terminal notification
    // chronology. Treat it as terminal status so a newer running turn can own
    // the glyph while the historical failure remains in the feed.
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
 * The cloud-mode counterpart of the host's `indicatorState` RPC, computed from
 * the snapshot the GUI already holds.
 *
 * The cloud feed is the complete VISIBLE set (the relay only ever sends whole
 * snapshots, already filtered for cleared/superseded), and every row carries
 * the entity columns, severity, kind and markers, so it can mirror the host's
 * derivation over rows from EVERY host rather than only the connected one.
 * Unread, unresolved prompt notifications light their respective pending
 * actions. A resolved-but-unread row remains a notification-stream concern,
 * not a false claim that its chat is still waiting for an action. Terminal rows
 * first resolve to the newest terminal outcome for each exact entity within
 * one origin host, whose timestamps share a clock domain. Those
 * per-host winners are then rolled into epic state. This lets a later success
 * replace an earlier failure's GLYPH without comparing clocks across hosts or
 * altering the historical failure row retained in the feed.
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
  rows: Readonly<Partial<Record<string, HostNotificationsCloudFeedRow>>>,
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
  row: HostNotificationsCloudFeedRow,
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
  readonly entry: HostNotificationEntry;
};

type CloudTerminalWinners = Map<string, Map<string, CloudTerminalCandidate>>;

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

function retainLatestTerminal(input: {
  readonly winners: CloudTerminalWinners;
  readonly entityId: string;
  readonly originHostId: string;
  readonly entryId: string;
  readonly candidate: HostNotificationEntry;
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

function isAutomaticRecoveryEntry(entry: HostNotificationEntry): boolean {
  return (
    entry.kind === "agent.stopped" &&
    "automaticRecovery" in entry.payload &&
    entry.payload.automaticRecovery === true
  );
}

function terminalEntriesForEpic(
  winners: CloudTerminalWinners,
): ReadonlyArray<HostNotificationEntry> {
  return [...winners.values()].flatMap(terminalEntriesForOrigins);
}

function terminalEntriesForOrigins(
  winners: Map<string, CloudTerminalCandidate>,
): ReadonlyArray<HostNotificationEntry> {
  return [...winners.values()].map((candidate) => candidate.entry);
}

function mergeTerminalContributions(
  current: HostNotificationsIndicatorState | undefined,
  entries: ReadonlyArray<HostNotificationEntry>,
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

function isTerminalEntry(entry: HostNotificationEntry): boolean {
  return entry.severity === "failure" || entry.severity === "done";
}

function terminalEntryIsNewer(
  candidate: CloudTerminalCandidate,
  current: CloudTerminalCandidate,
): boolean {
  // The origin store clamps every terminal occurrence for one exact entity
  // to a durable causal timestamp. Retain the entry-id tie-breaker for
  // deterministic ordering and compatibility with rows minted by older hosts.
  return (
    candidate.entry.updatedAt > current.entry.updatedAt ||
    (candidate.entry.updatedAt === current.entry.updatedAt &&
      candidate.entryId > current.entryId)
  );
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

/**
 * Two indicator responses folded into one, flag by flag.
 *
 * Used to combine per-HOST reads of one surface: chat ids on a canvas tab strip
 * can belong to different hosts, each answered by its own `indicatorState` call,
 * and the surface below reads a single chatId-keyed map. A spread-merge would
 * make the last answer win for an id two hosts both reported on - `chatId` is
 * host-minted and not unique across hosts, so that is a reachable state - and
 * silently extinguish a real pending flag. The host's own aggregate is
 * `MAX(CASE WHEN ...)`, so OR is the same rule applied one level up.
 */
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
