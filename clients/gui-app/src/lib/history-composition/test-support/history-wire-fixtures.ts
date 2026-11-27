import type {
  BatchDeleteResponse,
  CollaboratorEntry,
  GetTaskContextsResponse,
  ListEpicCollaboratorsResponse,
  ListTaskLight,
  ListTaskLightPre14,
  ListTaskLightPre16,
  ListTaskLightPre18,
  ListTasksCompletenessPre16,
  ListTasksFacets,
  ListTasksResponse,
  ListTasksResponsePre16,
  ListTasksResponsePre18,
  PermissionDto,
  SetEpicPinnedResponse,
  TaskContextUnknownReason,
  WirePermissionRole,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { LocalHistoryReadResponse } from "@traycer/protocol/host/epic/local-history";
import type {
  WorktreeHostEntryV16,
  WorktreeListAllForHostResponseV17,
} from "@traycer/protocol/host/worktree-schemas";

export type PagePosition =
  | { readonly hasMore: false; readonly nextCursor: undefined }
  | { readonly hasMore: true; readonly nextCursor: string };

export type ComputerLocalHomeHistoryRow = ListTaskLight & {
  readonly home: "local";
  readonly recentAt: number;
};

export type PreservedCloudHistoryRow = ListTaskLight & {
  readonly home: "cloud";
  readonly preservation: "orphaned-local-edits";
  readonly pinned: false;
  readonly recentAt: number;
};

type ComputerLocalHomeListRowAt16 = ListTaskLightPre16 & {
  readonly home: "local";
};

// Both the pool page reader and the host cloud reader project this settled
// server-only state at epic.listTasks@1.6.
const settledCompleteness: ListTasksCompletenessPre16 = {
  cloudPage: "settled",
  facets: "server",
  localRows: "none",
  sort: "server",
};

function facetsForRows(
  rows: readonly ListTaskLight[],
  additionalRows: number,
  callerUserId: string,
): ListTasksFacets {
  const firstCreator = rows[0]?.epic?.light?.createdBy ?? callerUserId;
  const mineCount = rows.filter(
    (row) => row.epic?.light?.createdBy === callerUserId,
  ).length;
  const sharedCount = rows.length - mineCount;
  const additionalMineCount =
    firstCreator === callerUserId ? additionalRows : 0;
  return {
    repos: [],
    workspaces: [],
    ownershipScopes: [
      { value: "mine", count: mineCount + additionalMineCount },
      {
        value: "shared",
        count: sharedCount + additionalRows - additionalMineCount,
      },
    ],
    chatHosts: [],
  };
}

function permission(
  role: WirePermissionRole,
  accessType: PermissionDto["accessType"],
  grantor: string,
  organizationId: string | undefined,
): PermissionDto {
  return {
    role,
    accessType,
    ...(accessType === "direct" ? { userId: grantor } : {}),
    ...(organizationId === undefined ? {} : { organizationId }),
    grantedBy: grantor,
    grantedAt: 1,
  };
}

export function directHistoryGrant(
  role: WirePermissionRole,
  userId: string,
): PermissionDto {
  return permission(role, "direct", userId, undefined);
}

/** Pool and host list/context DTO projections preserve the effective grant. */
export function organizationHistoryGrant(
  role: WirePermissionRole,
  organizationId: string,
  grantedBy: string,
): PermissionDto {
  return permission(role, "organization", grantedBy, organizationId);
}

interface CloudListRow {
  readonly id: string;
  readonly title: string;
  readonly grant: PermissionDto | null;
  readonly pinned: boolean;
  readonly updatedAt: number;
}

type PoolListedEpicAt16 = ListTaskLightPre16 & {
  readonly epic: NonNullable<ListTaskLightPre16["epic"]>;
};

/**
 * Pool DTO rows come from pool-service/src/readers/epic-list-tasks.ts:28–46
 * and traycer-server/src/services/cloud-persistence/base-task-service.ts:4604–4628,7041–7085.
 * The room locator and effective grant are projected; durability home is not.
 */
export function poolListedTaskAt16({
  id,
  title,
  grant,
  pinned,
  updatedAt,
}: CloudListRow): PoolListedEpicAt16 {
  return {
    epic: {
      light: {
        id,
        title,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "active",
        createdAt: 1,
        updatedAt,
        createdBy:
          grant?.userId ?? grant?.grantedBy ?? "history-wire-fixture-user",
        version: "1",
      },
      permission: grant,
      repos: [],
      workspaces: [],
      roomInfo: {
        roomId: `history-room-${id}`,
        webSocketUrl: "wss://collab.traycer.invalid",
        token: {
          token: `history-token-${id}`,
          expiresAtMs: 9_999_999_999_999,
        },
      },
    },
    phase: null,
    pinned,
    chatHostIds: [],
  };
}

/**
 * Pool list rows at `epic.listTasks@1.9` carry environment ownership from
 * `traycer-server/src/services/cloud-persistence/base-task-service.ts:4604–4624,7054–7060`.
 * The creator and the viewer's effective grant are independent fields.
 */
export function poolEnvironmentOwnedTaskAt19(
  row: CloudListRow & {
    readonly createdBy: string;
    readonly ownerEnvironmentId: string;
  },
): ListTaskLight {
  const listed = poolListedTaskAt16(row);
  const epic = listed.epic;
  if (epic.light === null) {
    throw new Error("An environment-owned list fixture needs epic light data.");
  }
  return {
    ...listed,
    epic: {
      ...epic,
      light: { ...epic.light, createdBy: row.createdBy },
    },
    ownerEnvironmentId: row.ownerEnvironmentId,
  };
}

/**
 * Pool DTO at listTasks @1.7 adds caller activity; its producer remains
 * pool-service/src/readers/epic-list-tasks.ts:28–46 and the DTO projection at
 * traycer-server/src/services/cloud-persistence/base-task-service.ts:7000–7085.
 */
export function poolListedTaskAt17(
  row: CloudListRow & { readonly recentAt: number | undefined },
): PoolListedEpicAt16 & Pick<ListTaskLightPre18, "recentAt"> {
  return { ...poolListedTaskAt16(row), recentAt: row.recentAt };
}

/**
 * A preserved cloud orphan returned by the host local-history reader, not by
 * the pool list: epic-local-history-read-resolver.ts:81–104 and
 * epic-list-tasks-resolver.ts:601–618. It has no cloud room or grant.
 */
export function preservedCloudLocalHistoryRow(
  id: string,
  title: string,
  recentAt: number,
  updatedAt: number,
): PreservedCloudHistoryRow {
  const listed = poolListedTaskAt17({
    id,
    title,
    grant: null,
    pinned: false,
    recentAt,
    updatedAt,
  });
  return {
    epic: {
      ...listed.epic,
      roomInfo: null,
    },
    phase: listed.phase,
    pinned: false,
    home: "cloud",
    recentAt,
    preservation: "orphaned-local-edits",
  };
}

/**
 * A real pool first page at listTasks @1.6. The pool reader returns a settled
 * server page with canonical completeness and first-page facets. Cursor
 * responses use `settledPoolTailPageAt16` and omit facets.
 */
export function settledPoolPageAt16(
  tasks: readonly ListTaskLightPre16[],
  position: PagePosition,
  callerUserId: string,
): ListTasksResponsePre16 {
  return {
    tasks: [...tasks],
    hasMore: position.hasMore,
    ...(position.nextCursor === undefined
      ? {}
      : { nextCursor: position.nextCursor }),
    completeness: settledCompleteness,
    facets: facetsForRows(tasks, position.hasMore ? 1 : 0, callerUserId),
  };
}

/**
 * A computer's first page after a completed cloud leg and empty local read.
 * The host resolver keeps the pool page completeness contract here; local
 * rows are merged from local history only on its first page. Cursor responses
 * use `settledComputerCloudTailPageAt16`.
 */
export function settledComputerCloudPageAt16(
  cloudRows: readonly ListTaskLightPre16[],
  position: PagePosition,
  callerUserId: string,
): ListTasksResponsePre16 {
  return {
    tasks: [...cloudRows],
    hasMore: position.hasMore,
    ...(position.nextCursor === undefined
      ? {}
      : { nextCursor: position.nextCursor }),
    completeness: settledCompleteness,
    facets: facetsForRows(cloudRows, position.hasMore ? 1 : 0, callerUserId),
  };
}

/**
 * A negotiated @1.5 computer list reply. The host producer still returns its
 * completed pre-local-first completeness statement at
 * `traycer-host/src/transport/rpc/resolvers/epic/epic-list-tasks-resolver.ts:199–225`.
 */
export function legacyComputerPageAt15(
  cloudRows: readonly ListTaskLightPre16[],
  position: PagePosition,
  callerUserId: string,
): ListTasksResponsePre16 {
  return {
    tasks: [...cloudRows],
    hasMore: position.hasMore,
    ...(position.nextCursor === undefined
      ? {}
      : { nextCursor: position.nextCursor }),
    completeness: settledCompleteness,
    facets: facetsForRows(cloudRows, position.hasMore ? 1 : 0, callerUserId),
  };
}

/** Host cursor replies reuse the cloud reader's completeness and omit facets. */
export function settledComputerCloudTailPageAt16(
  cloudRows: readonly ListTaskLightPre16[],
  position: PagePosition,
): ListTasksResponsePre16 {
  return {
    tasks: [...cloudRows],
    hasMore: position.hasMore,
    ...(position.nextCursor === undefined
      ? {}
      : { nextCursor: position.nextCursor }),
    completeness: settledCompleteness,
  };
}

/** A malformed host reply for the bulk walk's nonadvancing-cursor guard. */
export function injectedComputerTailCursorFaultAt16(
  rows: readonly ListTaskLightPre16[],
  fault: "repeated cursor" | "missing cursor",
  requestCursor: string,
): ListTasksResponsePre16 {
  const terminal = settledComputerCloudTailPageAt16(rows, {
    hasMore: false,
    nextCursor: undefined,
  });
  return {
    ...terminal,
    hasMore: true,
    ...(fault === "repeated cursor" ? { nextCursor: requestCursor } : {}),
  };
}

/** Cursor pages from the pool omit first-page facets but keep completeness. */
export function settledPoolTailPageAt16(
  tasks: readonly ListTaskLightPre16[],
  position: PagePosition,
): ListTasksResponsePre16 {
  return {
    tasks: [...tasks],
    hasMore: position.hasMore,
    ...(position.nextCursor === undefined
      ? {}
      : { nextCursor: position.nextCursor }),
    completeness: settledCompleteness,
  };
}

/** A current pool-reader page with row activity, as listTasks @1.7 emits it. */
export function settledPoolPageAt17(
  tasks: readonly ListTaskLightPre18[],
  position: PagePosition,
  callerUserId: string,
): ListTasksResponsePre18 {
  return {
    tasks: [...tasks],
    hasMore: position.hasMore,
    ...(position.nextCursor === undefined
      ? {}
      : { nextCursor: position.nextCursor }),
    completeness: settledCompleteness,
    facets: facetsForRows(tasks, position.hasMore ? 1 : 0, callerUserId),
  };
}

/**
 * Computer local-history rows are synthesized by
 * traycer-host/src/transport/rpc/resolvers/epic/epic-list-tasks-resolver.ts:741–775,828–839,1041–1084.
 * They have a direct local owner grant, null room, local home, numeric activity
 * and a pin bit. `recentAt` is carried by the separate local-history schema.
 */
export function computerLocalHomeRow({
  id,
  title,
  recentAt,
  pinned,
  userId,
  createdAt,
  updatedAt,
}: {
  readonly id: string;
  readonly title: string;
  readonly recentAt: number;
  readonly pinned: boolean;
  readonly userId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}): ComputerLocalHomeHistoryRow {
  return {
    epic: {
      light: {
        id,
        title,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "active",
        createdAt,
        updatedAt,
        createdBy: userId,
        version: "1",
      },
      permission: permission("owner", "direct", userId, undefined),
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    phase: null,
    pinned,
    home: "local",
    recentAt,
  };
}

function computerLocalHomeListRowAt16(
  row: ComputerLocalHomeHistoryRow,
): ComputerLocalHomeListRowAt16 {
  return {
    epic: row.epic,
    phase: row.phase,
    pinned: row.pinned,
    home: "local",
  };
}

/**
 * Host-authored context rows use the frozen nested @1.4 row contract from
 * traycer-host/src/transport/rpc/resolvers/epic/epic-get-task-contexts-resolver.ts:174–195,255–270.
 * A local context is synthesized with a direct owner and null room; home and
 * recent activity live in response siblings, not in the nested row.
 */
function localContextTaskAt14(
  id: string,
  title: string,
  userId: string,
  pinned: boolean,
): ListTaskLightPre14 {
  return {
    epic: {
      light: {
        id,
        title,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "unknown",
        createdAt: 1,
        updatedAt: 1,
        createdBy: userId,
        version: "1",
      },
      permission: permission("owner", "direct", userId, undefined),
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    phase: null,
    pinned,
  };
}

/**
 * The server's found cloud-context arm is produced by
 * traycer-server/src/services/cloud-persistence/base-task-service.ts:6068–6125.
 * It is an owner-scoped DTO with room metadata and no task-list home marker.
 */
function cloudContextTaskAt14(
  id: string,
  title: string,
  grant: PermissionDto,
  pinned: boolean,
): ListTaskLightPre14 {
  return {
    epic: {
      light: {
        id,
        title,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "active",
        createdAt: 1,
        updatedAt: 1,
        createdBy: grant.userId ?? grant.grantedBy,
        version: "1",
      },
      permission: grant,
      repos: [],
      workspaces: [],
      roomInfo: {
        roomId: `history-room-${id}`,
        webSocketUrl: "wss://collab.traycer.invalid",
        token: {
          token: `history-token-${id}`,
          expiresAtMs: 9_999_999_999_999,
        },
      },
    },
    phase: null,
    pinned,
  };
}

export type TaskContextScenarioAt14 =
  | {
      readonly kind: "cloud-found";
      readonly taskId: string;
      readonly title: string;
      readonly grant: PermissionDto;
      readonly recentAt: number | undefined;
      readonly pinned: boolean;
    }
  | {
      readonly kind: "local-home-found";
      readonly taskId: string;
      readonly title: string;
      readonly userId: string;
      readonly recentAt: number;
      readonly pinned: boolean;
    }
  | { readonly kind: "confirmed-absent"; readonly taskId: string }
  | {
      readonly kind: "unknown";
      readonly taskId: string;
      readonly reason: TaskContextUnknownReason;
    }
  | { readonly kind: "indeterminate"; readonly taskId: string };

/**
 * A host's `epic.getTaskContexts@1.4` answer from
 * traycer-host/src/transport/rpc/resolvers/epic/epic-get-task-contexts-resolver.ts:109–127,174–195,255–270.
 * Each requested id has one resolution; local-home markers and recency are
 * derived from the found scenario instead of supplied as unrelated siblings.
 */
export function taskContextsAt14(
  requestedTaskIds: readonly string[],
  scenarios: readonly TaskContextScenarioAt14[],
): GetTaskContextsResponse {
  const requestedIds = new Set(requestedTaskIds);
  const scenarioIds = new Set(scenarios.map((scenario) => scenario.taskId));
  if (
    requestedIds.size !== requestedTaskIds.length ||
    scenarioIds.size !== scenarios.length ||
    requestedIds.size !== scenarioIds.size ||
    [...requestedIds].some((taskId) => !scenarioIds.has(taskId))
  ) {
    throw new Error("Each requested task context needs one scenario.");
  }

  const tasks: GetTaskContextsResponse["tasks"] = {};
  const localHomedTaskIds: string[] = [];
  const recentAtByTaskId: Record<string, number> = {};
  for (const scenario of scenarios) {
    switch (scenario.kind) {
      case "cloud-found":
        tasks[scenario.taskId] = {
          status: "found",
          task: cloudContextTaskAt14(
            scenario.taskId,
            scenario.title,
            scenario.grant,
            scenario.pinned,
          ),
        };
        if (scenario.recentAt !== undefined) {
          recentAtByTaskId[scenario.taskId] = scenario.recentAt;
        }
        break;
      case "local-home-found":
        tasks[scenario.taskId] = {
          status: "found",
          task: localContextTaskAt14(
            scenario.taskId,
            scenario.title,
            scenario.userId,
            scenario.pinned,
          ),
        };
        localHomedTaskIds.push(scenario.taskId);
        recentAtByTaskId[scenario.taskId] = scenario.recentAt;
        break;
      case "confirmed-absent":
        tasks[scenario.taskId] = { status: "confirmed-absent" };
        break;
      case "unknown":
        tasks[scenario.taskId] = {
          status: "unknown",
          reason: scenario.reason,
        };
        break;
      case "indeterminate":
        break;
    }
  }
  return {
    tasks,
    localHomedTaskIds,
    recentAtByTaskId,
  };
}

/**
 * A complete local-history read from
 * traycer-host/src/transport/rpc/resolvers/epic/epic-local-history-read-resolver.ts:81–104.
 * The localRows discriminant follows the actual positive row array.
 */
export function completeLocalHistoryRead(
  localHomeRows: readonly ComputerLocalHomeHistoryRow[],
  preservedRows: readonly PreservedCloudHistoryRow[],
  tombstonedEpicIds: readonly string[],
): LocalHistoryReadResponse {
  return {
    complete: true,
    willComplete: true,
    localHomeRows: [...localHomeRows],
    preservedRows: [...preservedRows],
    tombstonedEpicIds: [...tombstonedEpicIds],
    localRows:
      localHomeRows.length > 0 || preservedRows.length > 0 ? "present" : "none",
  };
}

/**
 * An unreadable/booting local store follows the resolver's truncated arm at
 * epic-local-history-read-resolver.ts:81–104.
 */
export function incompleteLocalHistoryRead(
  willComplete: boolean,
): LocalHistoryReadResponse {
  return {
    complete: false,
    willComplete,
    localHomeRows: [],
    preservedRows: [],
    tombstonedEpicIds: [],
    localRows: "truncated",
  };
}

/**
 * First page with a real local contribution is produced by
 * traycer-host/src/transport/rpc/resolvers/epic/epic-list-tasks-resolver.ts:741–775.
 * Local rows change facets and ordering to partial / loaded-union.
 */
export function computerPageWithLocalRowsAt16(
  cloudRows: readonly ListTaskLightPre16[],
  localHistoryRows: readonly ComputerLocalHomeHistoryRow[],
  position: PagePosition,
  callerUserId: string,
): ListTasksResponsePre16 {
  const localRows = localHistoryRows.map(computerLocalHomeListRowAt16);
  const localIds = new Set(
    localRows.flatMap((row) => {
      const id = row.epic?.light?.id;
      return id === undefined ? [] : [id];
    }),
  );
  const survivingCloudRows = cloudRows.filter(
    (row) =>
      row.epic?.light?.id === undefined || !localIds.has(row.epic.light.id),
  );
  return {
    tasks: [...localRows, ...survivingCloudRows],
    hasMore: position.hasMore,
    ...(position.nextCursor === undefined
      ? {}
      : { nextCursor: position.nextCursor }),
    completeness:
      localRows.length > 0
        ? {
            cloudPage: "settled",
            facets: "partial",
            localRows: "present",
            sort: "loaded-union",
          }
        : settledCompleteness,
    facets: facetsForRows(cloudRows, position.hasMore ? 1 : 0, callerUserId),
  };
}

/**
 * A cursor response after the host applied a caller-owned tombstone. The
 * resolver removes matching cloud rows and marks the server facets partial;
 * cursor pages never inject positive local rows.
 */
export function computerTombstonedCloudTailPageAt16(
  incomingCloudRows: readonly ListTaskLightPre16[],
  tombstonedEpicIds: readonly string[],
  position: PagePosition,
): ListTasksResponsePre16 {
  const tombstones = new Set(tombstonedEpicIds);
  const tasks = incomingCloudRows.filter(
    (row) => !tombstones.has(row.epic?.light?.id ?? ""),
  );
  const removedAnyCloudRow = tasks.length !== incomingCloudRows.length;
  if (!removedAnyCloudRow) {
    throw new Error("A tombstoned cursor fixture must remove a cloud row");
  }
  return {
    tasks,
    hasMore: position.hasMore,
    ...(position.nextCursor === undefined
      ? {}
      : { nextCursor: position.nextCursor }),
    completeness: {
      cloudPage: "settled",
      facets: "partial",
      localRows: "none",
      sort: "server",
    },
  };
}

/**
 * App cache state created when an unavailable first page is reopened for a
 * bounded local-first revalidation. This is never an RPC response: the host
 * list resolver emits settled or unavailable, and the hook writes pending
 * while the follow-up request is in flight.
 */
export function pendingLocalFirstCachePage(
  localRows: readonly ListTaskLight[],
): ListTasksResponse {
  return {
    tasks: [...localRows],
    hasMore: false,
    completeness: {
      cloudPage: "pending",
      facets: "partial",
      localRows: localRows.length > 0 ? "present" : "none",
      sort: localRows.length > 0 ? "loaded-union" : "server",
    },
  };
}

/**
 * The same host resolver reports a failed cloud leg without a cursor; a
 * local-only fallback is not a paged cloud result.
 */
export function unavailableComputerPageAt16(
  localHistoryRows: readonly [
    ComputerLocalHomeHistoryRow,
    ...ComputerLocalHomeHistoryRow[],
  ],
): ListTasksResponsePre16 {
  const localRows = localHistoryRows.map(computerLocalHomeListRowAt16);
  return {
    tasks: [...localRows],
    hasMore: false,
    completeness: {
      cloudPage: "unavailable",
      facets: "partial",
      localRows: localRows.length > 0 ? "present" : "none",
      sort: "loaded-union",
    },
  };
}

/**
 * Fault fixture for the cached-page merge only: this represents an old-schema
 * retained tail whose completeness key is absent, not a negotiated live page.
 */
export function injectedOldSchemaCachedTail(
  tasks: readonly ListTaskLightPre16[],
): ListTasksResponsePre16 {
  return { tasks: [...tasks], hasMore: false };
}

/** Pool `epic.setPinned@1.1` returns the cloud home (pool-service/src/readers/task/task-resolvers.ts:714–730). */
export function poolPinAcknowledgementAt11(
  pinned: boolean,
): SetEpicPinnedResponse {
  return { pinned, home: "cloud" };
}

/** Host `epic.setPinned@1.1` reports the committed durability home (traycer-host/src/transport/rpc/resolvers/epic/epic-set-pinned-resolver.ts:139–169). */
export function computerPinAcknowledgementAt11(
  pinned: boolean,
  home: "local" | "cloud",
): SetEpicPinnedResponse {
  return { pinned, home };
}

/** Owner-denial wording from traycer-server/src/services/cloud-persistence/base-task-service.ts:4252–4259. */
export function poolOwnerRefusal(taskId: string): string {
  return `Caller does not have required permission (owner) for task ${taskId}`;
}

/**
 * Successful per-id pool deletes carry cloud home at
 * pool-service/src/readers/task/task-resolvers.ts:731–771,
 * epic.batchDelete@1.1.
 */
export function poolDeleteSuccess(
  taskIds: readonly string[],
): BatchDeleteResponse {
  return {
    results: taskIds.map((taskId) => ({
      taskId,
      success: true,
      home: "cloud",
    })),
  };
}

/** The pool owner gate returns this failed cloud-home item per id at task-resolvers.ts:731–771. */
function poolDeleteOwnerRefusal(
  taskIds: readonly string[],
): BatchDeleteResponse {
  return {
    results: taskIds.map((taskId) => ({
      taskId,
      success: false,
      home: "cloud",
      errorMessage: poolOwnerRefusal(taskId),
    })),
  };
}

/** One pool response can contain owner-refused and completed rows. */
export function poolDeleteOutcomes(
  taskIds: readonly string[],
  refusedTaskIds: readonly string[],
): BatchDeleteResponse {
  return {
    results: taskIds.flatMap((taskId) =>
      refusedTaskIds.includes(taskId)
        ? poolDeleteOwnerRefusal([taskId]).results
        : poolDeleteSuccess([taskId]).results,
    ),
  };
}

/**
 * The host delete resolver stamps a committed local home at
 * traycer-host/src/transport/rpc/resolvers/epic/epic-batch-delete-resolver.ts:420–432,
 * epic.batchDelete@1.1.
 */
export function computerLocalDeleteSuccess(
  taskIds: readonly string[],
): BatchDeleteResponse {
  return {
    results: taskIds.map((taskId) => ({
      taskId,
      success: true,
      home: "local",
    })),
  };
}

/**
 * The host delete resolver stamps cloud-owned outcomes at
 * traycer-host/src/transport/rpc/resolvers/epic/epic-batch-delete-resolver.ts:420–432,
 * epic.batchDelete@1.1.
 */
export function computerCloudDeleteSuccess(
  taskIds: readonly string[],
): BatchDeleteResponse {
  return {
    results: taskIds.map((taskId) => ({
      taskId,
      success: true,
      home: "cloud",
    })),
  };
}

/** The computer resolver may send cloud-owned rows to the cloud delete path. */
export function computerDeleteOutcomes(
  taskIds: readonly string[],
  localTaskIds: readonly string[],
): BatchDeleteResponse {
  return {
    results: taskIds.flatMap((taskId) =>
      localTaskIds.includes(taskId)
        ? computerLocalDeleteSuccess([taskId]).results
        : computerCloudDeleteSuccess([taskId]).results,
    ),
  };
}

/**
 * Collaborator DTOs are projected by
 * pool-service/src/readers/task/task-resolvers.ts:113–120,381–408,825–838,869–913.
 */
export function poolCollaborator(
  userId: string,
  displayName: string,
  role: "owner" | "editor",
  grantedBy: string,
): CollaboratorEntry {
  return {
    role,
    accessType: "direct",
    environmentId: null,
    grantedAt: 1,
    grantedBy,
    user: {
      userId,
      profile: {
        displayName,
        handle: userId,
        email: "",
        avatarUrl: "",
      },
    },
  };
}

/** Exact pool list/mutation envelope at task-resolvers.ts:381–408,825–838. */
export function poolCollaboratorsResponse(
  collaborators: readonly CollaboratorEntry[],
  collaboratorsAvailable: boolean,
): ListEpicCollaboratorsResponse {
  return { collaborators: [...collaborators], collaboratorsAvailable };
}

/**
 * Host worktree pages are projected by
 * traycer-host/src/transport/rpc/resolvers/worktree/worktree-resolvers.ts:955–1000.
 * This terminal page shape matches a fully scanned empty or populated result.
 */
export function computerWorktreePageAt17(
  worktrees: readonly WorktreeHostEntryV16[],
): WorktreeListAllForHostResponseV17 {
  return { worktrees: [...worktrees], nextCursor: null };
}

/**
 * A visible host worktree row from
 * traycer-host/src/transport/rpc/resolvers/worktree/worktree-resolvers.ts:955–1000.
 */
export function computerWorktreeEntryAt16(
  epicId: string,
  branch: string,
): WorktreeHostEntryV16 {
  return {
    worktreePath: `/tmp/history-${epicId}`,
    repoLabel: "acme/app",
    repoIdentifier: { owner: "acme", repo: "app" },
    branch,
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    lastActivityAt: null,
    owners: [
      {
        epicId,
        ownerKind: "chat",
        ownerId: epicId,
        updatedAt: 1,
      },
    ],
    branchStatus: null,
    createdAt: null,
    prState: null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
    resolvedAt: 1,
    presence: "present",
    gitUnreadable: false,
  };
}
