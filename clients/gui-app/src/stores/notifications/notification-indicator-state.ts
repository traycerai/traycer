import {
  HOST_NOTIFICATION_PENDING_PROMPT_KINDS,
  type HostNotificationCloudEntryV26,
  type HostNotificationsCloudFeedRowV16,
  type HostNotificationsEntityRef,
  type HostNotificationsIndicatorState,
  type HostNotificationsIndicatorStateResponse,
} from "@traycer/protocol/host/notifications/contracts";
import {
  notificationPayloadBelongsToEntity,
  notificationPayloadBelongsToEpic,
} from "@/lib/notifications";
import { countsTowardEntityUnread } from "@/lib/notifications/unread-count";
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

/** An answer's per-entity records: the host response less whether it was
 * the whole origin, which only the cloud-mode fold reads. */
export type NotificationIndicatorRecords = Omit<
  HostNotificationsIndicatorStateResponse,
  "complete"
>;

/**
 * GUI-only enrichment of the released host response. Aggregate surfaces read
 * `epics` / `chats` exactly as before; host-bound tabs use the per-origin
 * projection so another host's same-id lineage cannot decorate the tab.
 */
export type SurfaceNotificationIndicators = NotificationIndicatorRecords & {
  readonly byOriginHostId?: Readonly<
    Record<string, NotificationIndicatorRecords>
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

const EMPTY_HOST_INDICATOR_STATE: HostNotificationsIndicatorState = {
  pendingFork: false,
  pendingApproval: false,
  pendingInterview: false,
  unreadFailure: false,
  unreadDone: false,
  unreadCount: 0,
};

/**
 * Two counts of disjoint rows added: `null` (a host that did not count) only
 * when neither side counted, so a known count is never hidden by an unknown
 * one. The flags still light the entity the unknown side holds.
 */
export function addUnreadCounts(
  left: number | null,
  right: number | null,
): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return left + right;
}

/**
 * Whether an entity has anything unread: its unread terminal glyph, or any
 * unread row its count holds.
 */
export function indicatorHasUnread(
  state: HostNotificationsIndicatorState,
): boolean {
  return (
    state.unreadDone || state.unreadFailure || (state.unreadCount ?? 0) > 0
  );
}

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

export const EMPTY_INDICATOR_STATE_RESPONSE: NotificationIndicatorRecords = {
  epics: {},
  chats: {},
};

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
  rows: Readonly<Partial<Record<string, HostNotificationsCloudFeedRowV16>>>,
  epicIds: ReadonlyArray<string>,
  chatIds: ReadonlyArray<string>,
): NotificationIndicatorRecords {
  return selectCloudNotificationIndicatorProjection(rows, epicIds, chatIds)
    .aggregate;
}

export interface CloudNotificationIndicatorProjection {
  readonly aggregate: NotificationIndicatorRecords;
  readonly byOriginHostId: Readonly<
    Record<string, NotificationIndicatorRecords>
  >;
}

export function selectCloudNotificationIndicatorProjection(
  rows: Readonly<Partial<Record<string, HostNotificationsCloudFeedRowV16>>>,
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
  const byOriginHostId: Record<string, NotificationIndicatorRecords> = {};
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
  row: HostNotificationsCloudFeedRowV16,
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
): NotificationIndicatorRecords {
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
  readonly entry: HostNotificationCloudEntryV26;
};

type CloudTerminalWinners = Map<string, Map<string, CloudTerminalCandidate>>;

function collectCloudIndicatorEntry(
  accumulator: CloudIndicatorAccumulator,
  row: HostNotificationsCloudFeedRowV16,
): void {
  const { entry, originHostId } = row;
  const contribution = mergeOptionalIndicatorFlags(
    indicatorContribution(entry),
    countsTowardEntityUnread(entry) ? UNREAD_ROW_CONTRIBUTION : null,
  );
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

/** One unread row's share of its entities' count, and of nothing else. */
const UNREAD_ROW_CONTRIBUTION: HostNotificationsIndicatorState = {
  ...EMPTY_HOST_INDICATOR_STATE,
  unreadCount: 1,
};

function mergeOptionalIndicatorFlags(
  left: HostNotificationsIndicatorState | null,
  right: HostNotificationsIndicatorState | null,
): HostNotificationsIndicatorState | null {
  if (left === null) return right;
  if (right === null) return left;
  return mergeIndicatorFlags(left, right);
}

/**
 * `null` when the entry lights nothing, so an entity with only quiet rows is
 * never allocated an all-false record.
 *
 * `pendingApproval` is the wire's generic "needs a person" flag: every
 * agent pending-prompt kind but `interview.requested` lights it, driven off the
 * shared `HOST_NOTIFICATION_PENDING_PROMPT_KINDS` tuple so a new kind lights
 * this glyph (and the host SQL projection) by joining that tuple. Browser
 * prompts belong to their browser tab and do not decorate the requesting chat.
 */
function indicatorContribution(
  entry: HostNotificationCloudEntryV26,
): HostNotificationsIndicatorState | null {
  if (
    entry.kind === "browser.human.needed" ||
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
    unreadCount: 0,
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
  readonly candidate: HostNotificationCloudEntryV26;
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

function isAutomaticRecoveryEntry(
  entry: HostNotificationCloudEntryV26,
): boolean {
  return (
    entry.kind === "agent.stopped" &&
    "automaticRecovery" in entry.payload &&
    entry.payload.automaticRecovery === true
  );
}

function terminalEntriesForEpic(
  winners: CloudTerminalWinners,
): ReadonlyArray<HostNotificationCloudEntryV26> {
  return [...winners.values()].flatMap(terminalEntriesForOrigins);
}

function terminalEntriesForOrigins(
  winners: Map<string, CloudTerminalCandidate>,
): ReadonlyArray<HostNotificationCloudEntryV26> {
  return [...winners.values()].map((candidate) => candidate.entry);
}

function mergeTerminalContributions(
  current: HostNotificationsIndicatorState | undefined,
  entries: ReadonlyArray<HostNotificationCloudEntryV26>,
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

function isTerminalEntry(entry: HostNotificationCloudEntryV26): boolean {
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
  entry: HostNotificationCloudEntryV26,
): HostNotificationsIndicatorState | null {
  if (entry.readAt !== null || !isTerminalEntry(entry)) return null;
  return {
    pendingApproval: false,
    pendingInterview: false,
    pendingFork: false,
    unreadFailure: entry.severity === "failure",
    unreadDone: entry.severity === "done",
    // The row's own count is its entity's already, from the feed pass.
    unreadCount: 0,
  };
}

/** The host's `MAX(CASE WHEN ...)` aggregate: any contributing row lights the
 * entity's flag; the counts of disjoint rows add. */
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
    unreadCount: addUnreadCounts(current.unreadCount, next.unreadCount),
  };
}

/**
 * Folds the host's `home: "local"` answer into the cloud partition.
 *
 * Flags OR. The host answers either its WHOLE origin or, while its cloud lane
 * carries its rows, an EMPTY partition, and the GUI still holds the cloud
 * rows it last received. An OR of booleans neither drops a lit flag nor
 * invents one either way, which is why this used to be the whole rule.
 *
 * Counts are not booleans: in the whole-origin answer the same notification
 * is in both inputs, and adding them counts it twice. So one plane is
 * authoritative per origin, and the answer itself says which
 * (`complete`): a whole-origin answer replaces the cloud's count for its
 * origin (`originHostId`), every other origin still counting from the cloud
 * rows; an empty partition, or a host that does not say, leaves the cloud's
 * counts standing. The lane decision is the answering host's own, which is
 * why it rides the answer rather than this GUI's view of its own lane.
 *
 * Only the ids the answer was asked about (`requested`) take its counts: an
 * id it was not asked about is absent from it, which is not a zero.
 *
 * `byOriginHostId` gets the same treatment for the answering host's bucket
 * alone: the host's answer belongs to that origin and to no other, so merging
 * it into every bucket would let one host's rows decorate a tab bound to
 * another.
 */
export function mergeLocalPartitionIntoCloudIndicators(
  cloud: SurfaceNotificationIndicators,
  hostLocal: HostNotificationsIndicatorStateResponse,
  originHostId: string | null,
  requested: RequestedIndicatorIds,
): SurfaceNotificationIndicators {
  const scoped =
    originHostId === null || cloud.byOriginHostId === undefined
      ? null
      : (cloud.byOriginHostId[originHostId] ?? EMPTY_INDICATOR_STATE_RESPONSE);
  const hostCounts = hostLocal.complete === true && originHostId !== null;
  const aggregate = mergePartitions(
    cloud,
    hostLocal,
    hostCounts
      ? {
          kind: "host-and-other-origins",
          cloudOwn: scoped ?? EMPTY_INDICATOR_STATE_RESPONSE,
        }
      : CLOUD_COUNTS,
    requested,
  );
  if (originHostId === null || scoped === null) {
    return { ...aggregate, byOriginHostId: cloud.byOriginHostId };
  }
  return {
    ...aggregate,
    byOriginHostId: {
      ...cloud.byOriginHostId,
      [originHostId]: mergePartitions(
        scoped,
        hostLocal,
        hostCounts ? HOST_COUNTS : CLOUD_COUNTS,
        requested,
      ),
    },
  };
}

/** The ids an indicator answer was asked about. */
export interface RequestedIndicatorIds {
  readonly epicIds: ReadonlyArray<string>;
  readonly chatIds: ReadonlyArray<string>;
}

/**
 * Where a merged entity's count comes from: the cloud rows alone; the host's
 * answer alone (a bucket that is this host's origin only); or the host's
 * answer for this host's origin plus the cloud rows of every other origin
 * (the cloud count less `cloudOwn`, the cloud's count for this origin).
 */
type CountAuthority =
  | { readonly kind: "cloud" }
  | { readonly kind: "host" }
  | {
      readonly kind: "host-and-other-origins";
      readonly cloudOwn: NotificationIndicatorRecords;
    };

const CLOUD_COUNTS: CountAuthority = { kind: "cloud" };
const HOST_COUNTS: CountAuthority = { kind: "host" };

function mergePartitions(
  cloud: NotificationIndicatorRecords,
  host: NotificationIndicatorRecords,
  counts: CountAuthority,
  requested: RequestedIndicatorIds,
): NotificationIndicatorRecords {
  return {
    epics: mergePartitionRecords(cloud.epics, host.epics, {
      counts,
      cloudOwn:
        counts.kind === "host-and-other-origins" ? counts.cloudOwn.epics : {},
      requested: new Set(requested.epicIds),
    }),
    chats: mergePartitionRecords(cloud.chats, host.chats, {
      counts,
      cloudOwn:
        counts.kind === "host-and-other-origins" ? counts.cloudOwn.chats : {},
      requested: new Set(requested.chatIds),
    }),
  };
}

function mergePartitionRecords(
  cloud: NotificationIndicatorRecords["epics"],
  host: NotificationIndicatorRecords["epics"],
  authority: {
    readonly counts: CountAuthority;
    /** The cloud's records for the answering origin. */
    readonly cloudOwn: NotificationIndicatorRecords["epics"];
    /** The ids the answer was asked about. */
    readonly requested: ReadonlySet<string>;
  },
): NotificationIndicatorRecords["epics"] {
  const { counts, cloudOwn, requested } = authority;
  const merged: NotificationIndicatorRecords["epics"] = {};
  for (const id of new Set([...Object.keys(cloud), ...Object.keys(host)])) {
    const fromCloud = Object.hasOwn(cloud, id) ? cloud[id] : undefined;
    const fromHost = Object.hasOwn(host, id) ? host[id] : undefined;
    const flags =
      fromHost === undefined
        ? fromCloud
        : mergeIndicatorFlags(fromCloud, fromHost);
    if (flags === undefined) continue;
    merged[id] = {
      ...flags,
      unreadCount: entityUnreadCount(
        requested.has(id) ? counts : CLOUD_COUNTS,
        fromCloud,
        fromHost,
        Object.hasOwn(cloudOwn, id) ? cloudOwn[id] : undefined,
      ),
    };
  }
  return merged;
}

function entityUnreadCount(
  counts: CountAuthority,
  fromCloud: HostNotificationsIndicatorState | undefined,
  fromHost: HostNotificationsIndicatorState | undefined,
  cloudOwn: HostNotificationsIndicatorState | undefined,
): number | null {
  // A whole-origin answer that holds no record for an id it was asked about
  // has no rows for it.
  const hostCount = fromHost === undefined ? 0 : fromHost.unreadCount;
  switch (counts.kind) {
    case "cloud":
      // Only the host answered for the entity: its count, or unknown when it
      // cannot count, never a zero no plane counted.
      return fromCloud === undefined
        ? (fromHost?.unreadCount ?? null)
        : fromCloud.unreadCount;
    case "host":
      return hostCount;
    case "host-and-other-origins": {
      // Every other origin's rows, as the cloud holds them.
      const otherOrigins =
        (fromCloud?.unreadCount ?? 0) - (cloudOwn?.unreadCount ?? 0);
      // A host that cannot count stays unknown unless another origin's rows
      // give the entity a count of their own.
      if (hostCount === null) return otherOrigins > 0 ? otherOrigins : null;
      return otherOrigins + hostCount;
    }
  }
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
  host: NotificationIndicatorRecords,
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
  response: NotificationIndicatorRecords,
  pendingChats: ReadonlyArray<
    readonly [string, HostNotificationsIndicatorState]
  >,
): NotificationIndicatorRecords {
  const chats = { ...response.chats };
  for (const [chatId] of pendingChats) {
    chats[chatId] = {
      ...(chats[chatId] ?? EMPTY_HOST_INDICATOR_STATE),
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
 * `MAX(CASE WHEN ...)`, so OR is the same rule applied one level up; the
 * hosts' rows are their own, so their counts add.
 */
export function mergeIndicatorStateResponses(
  base: NotificationIndicatorRecords,
  next: NotificationIndicatorRecords,
): NotificationIndicatorRecords {
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
