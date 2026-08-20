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
  /** Failure that is not a renderer-local terminal lifecycle failure. Host
   * failures use this arm because the released indicator response does not
   * carry a terminal subtype. */
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
  const unreadLocalFailure =
    unreadLocalTerminalFailure || unreadLocalNonTerminalFailure;
  if (!unreadLocalFailure && hostState === EMPTY_HOST_INDICATOR_STATE) {
    return EMPTY_NOTIFICATION_INDICATOR_STATE;
  }
  return {
    unreadFailure: unreadLocalFailure || hostState.unreadFailure,
    unreadNonTerminalFailure:
      unreadLocalNonTerminalFailure || hostState.unreadFailure,
    unreadTerminalFailure: unreadLocalTerminalFailure,
    pendingFork: hostState.pendingFork,
    pendingApproval: hostState.pendingApproval,
    pendingInterview: hostState.pendingInterview,
    unreadDone: hostState.unreadDone,
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
 * first resolve to the newest outcome for each lifecycle group and exact entity
 * within one origin host, whose timestamps share a clock domain. Those
 * per-host winners are then rolled into epic state. This lets a later success
 * replace an earlier failure from the same lifecycle without comparing clocks
 * across hosts or allowing an independent lifecycle, host, or entity's success
 * to hide a real failure.
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

/** Exact entity -> origin host -> lifecycle group -> latest terminal entry in
 * that host's clock. Independent lifecycle groups must never supersede one
 * another merely because they address the same chat or epic. */
type CloudTerminalWinners = Map<
  string,
  Map<string, Map<string, HostNotificationEntry>>
>;

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
      coalesceKey: row.coalesceKey,
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
      coalesceKey: row.coalesceKey,
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
  readonly coalesceKey: string;
  readonly candidate: HostNotificationEntry;
}): void {
  if (!isTerminalEntry(input.candidate)) return;
  const originWinners = terminalWinnersForEntity(input.winners, input.entityId);
  const groupWinners = terminalWinnersForOrigin(
    originWinners,
    input.originHostId,
  );
  const current = groupWinners.get(input.coalesceKey);
  if (current === undefined || terminalEntryIsNewer(input.candidate, current)) {
    groupWinners.set(input.coalesceKey, input.candidate);
  }
}

function terminalEntriesForEpic(
  winners: CloudTerminalWinners,
): ReadonlyArray<HostNotificationEntry> {
  return [...winners.values()].flatMap(terminalEntriesForOrigins);
}

function terminalEntriesForOrigins(
  winners: Map<string, Map<string, HostNotificationEntry>>,
): ReadonlyArray<HostNotificationEntry> {
  return [...winners.values()].flatMap((group) => [...group.values()]);
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
): Map<string, Map<string, HostNotificationEntry>> {
  const existing = winners.get(entityId);
  if (existing !== undefined) return existing;
  const created = new Map<string, Map<string, HostNotificationEntry>>();
  winners.set(entityId, created);
  return created;
}

function terminalWinnersForOrigin(
  winners: Map<string, Map<string, HostNotificationEntry>>,
  originHostId: string,
): Map<string, HostNotificationEntry> {
  const existing = winners.get(originHostId);
  if (existing !== undefined) return existing;
  const created = new Map<string, HostNotificationEntry>();
  winners.set(originHostId, created);
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
 * ORs the host's EXACT local durable-home partition into the cloud partition.
 *
 * This supersedes the pendingFork-only import below, and the reason is the
 * `home: "local"` request selector rather than a change of mind about
 * authority. That helper was written when the host's `indicatorState` answered
 * over its WHOLE SQLite: rows produced on host B never enter host A's database,
 * so folding host A's answer into a cross-host cloud view could neither light
 * nor clear correctly, and only the host-local `pendingFork` bit was safe to
 * take. With `@1.1`'s selector the host answers for its local-homed partition
 * ONLY, and the cloud snapshot is exactly the complement - so the two are
 * disjoint and a per-flag OR neither drops a row nor double-counts one.
 *
 * `byOriginHostId` gets the same treatment for the ACTIVE host's bucket alone:
 * the local partition belongs to that origin and to no other, so merging it
 * into every bucket would let one host's local rows decorate a tab bound to
 * another.
 */
export function mergeLocalPartitionIntoCloudIndicators(
  cloud: SurfaceNotificationIndicators,
  hostLocal: HostNotificationsIndicatorStateResponse,
  originHostId: string | null,
): SurfaceNotificationIndicators {
  const aggregate = orIndicatorResponses(cloud, hostLocal);
  if (originHostId === null || cloud.byOriginHostId === undefined) {
    return { ...aggregate, byOriginHostId: cloud.byOriginHostId };
  }
  const scoped =
    cloud.byOriginHostId[originHostId] ?? EMPTY_INDICATOR_STATE_RESPONSE;
  return {
    ...aggregate,
    byOriginHostId: {
      ...cloud.byOriginHostId,
      [originHostId]: orIndicatorResponses(scoped, hostLocal),
    },
  };
}

function orIndicatorResponses(
  base: HostNotificationsIndicatorStateResponse,
  overlay: HostNotificationsIndicatorStateResponse,
): HostNotificationsIndicatorStateResponse {
  return {
    epics: orIndicatorRecord(base.epics, overlay.epics),
    chats: orIndicatorRecord(base.chats, overlay.chats),
  };
}

/**
 * `Object.hasOwn` rather than an inline `=== undefined`: the wire type is a
 * `z.record`, which TypeScript widens to a TOTAL `Record<string, T>`, so the
 * inline check reads as dead code to the checker while being the only thing
 * standing between a partition that lacks the id and a `.pendingApproval` on
 * `undefined`.
 */
function orIndicatorRecord(
  base: HostNotificationsIndicatorStateResponse["epics"],
  overlay: HostNotificationsIndicatorStateResponse["epics"],
): HostNotificationsIndicatorStateResponse["epics"] {
  const merged = { ...base };
  for (const [id, state] of Object.entries(overlay)) {
    merged[id] = mergeIndicatorFlags(
      Object.hasOwn(merged, id) ? merged[id] : undefined,
      state,
    );
  }
  return merged;
}

/**
 * Cloud mode has two deliberately separate authorities: feed rows own the
 * read/unread and approval/interview flags across hosts, while the connected
 * host's fork notice board owns `pendingFork`. Merge only that one host-local
 * bit so local SQLite read markers can never override the cloud feed view.
 *
 * Retained for the callers that hold a WHOLE-origin host response rather than
 * a `home: "local"` partition - it is the only safe fold for one of those.
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
