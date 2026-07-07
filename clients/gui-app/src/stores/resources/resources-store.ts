import { create, type StoreApi, type UseBoundStore } from "zustand";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  ResourcesProjectionPayload,
  ResourcesStreamCallbacks,
  ResourcesStreamClient,
} from "@traycer-clients/shared/host-transport/resources-stream-client";
import type {
  AppResourceSnapshotWire,
  EpicResourceSnapshotWire,
  OwnerResourceSnapshotWire,
  ResourceProcessSnapshotWire,
  ResourceOwnerKindWire,
} from "@traycer/protocol/host/resources/subscribe";

/**
 * The renderer side of `resources.subscribe@1.0`: one store per open epic that
 * mirrors the host's live per-owner + epic-aggregate projection. Each server
 * frame carries the FULL projection, so the store replaces its view wholesale -
 * an owner absent from a frame is "not currently tracked" (rendered as unknown),
 * never zero use. See `ResourcesStreamClient` for the wire contract.
 *
 * Owner snapshots are kept in a `Map` keyed by `resourceOwnerKey` so an owner
 * chip can select exactly its own entry (identity-stable across unchanged
 * frames - see `mergeOwners`) and re-render only when its own metrics move.
 */

export type ResourcesStreamClientHandle = Pick<ResourcesStreamClient, "close">;

export type ResourcesStreamClientFactory = (
  epicId: string,
  callbacks: ResourcesStreamCallbacks,
) => ResourcesStreamClientHandle;

export type OwnerResourceUsage = OwnerResourceSnapshotWire;
export type EpicResourceUsage = EpicResourceSnapshotWire;
export type AppResourceUsage = AppResourceSnapshotWire;

export interface TaskResourceSummary {
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly trackedProcessCount: number;
  readonly openTerminalCount: number;
  readonly tuiAgentCount: number;
  readonly guiAgentCount: number;
}

/** Stable map key for one owner within an epic's projection. */
export function resourceOwnerKey(
  kind: ResourceOwnerKindWire,
  ownerId: string,
): string {
  return `${kind}\x1f${ownerId}`;
}

export interface ResourcesState {
  readonly epicId: string;
  readonly connectionStatus: StreamConnectionStatus;
  /** `null` until the first projection lands. */
  readonly sampledAt: number | null;
  /**
   * Live owner snapshots keyed by `resourceOwnerKey`. An owner absent from this
   * map is "not currently tracked" - callers must treat that as unknown, never
   * as zero use.
   */
  readonly owners: ReadonlyMap<string, OwnerResourceSnapshotWire>;
  /** Host-app usage sampled alongside the owner projection. */
  readonly app: AppResourceSnapshotWire | null;
  /** `null` when the epic has no tracked owner roots (a valid quiet state). */
  readonly epic: EpicResourceSnapshotWire | null;
  /**
   * Renderer-derived task-level summary for the live owner projection. `null`
   * means no tracked owner snapshots are present, not zero usage.
   */
  readonly taskSummary: TaskResourceSummary | null;
  readonly dispose: () => void;
}

export interface ResourcesStoreOptions {
  readonly epicId: string;
  readonly streamClientFactory: ResourcesStreamClientFactory;
}

export interface ResourcesStoreHandle {
  readonly epicId: string;
  readonly store: UseBoundStore<StoreApi<ResourcesState>>;
  readonly dispose: () => void;
}

const EMPTY_OWNERS: ReadonlyMap<string, OwnerResourceSnapshotWire> = new Map();

// Compare only the fields a chip renders. `sampledAt`/`rootPids` move on every
// host tick even when nothing displayable changed, so excluding them lets an
// unchanged owner keep its previous object identity across frames - the whole
// projection is resent each update, but only owners whose metrics actually moved
// get a new reference (and re-render their chip).
function ownerUsageEqual(
  a: OwnerResourceSnapshotWire,
  b: OwnerResourceSnapshotWire,
): boolean {
  return (
    a.cpuPercent === b.cpuPercent &&
    a.rssBytes === b.rssBytes &&
    a.processCount === b.processCount &&
    a.activeProcessName === b.activeProcessName &&
    processesEqual(a.processes, b.processes)
  );
}

function processEqual(
  a: ResourceProcessSnapshotWire,
  b: ResourceProcessSnapshotWire,
): boolean {
  return (
    a.pid === b.pid &&
    a.parentPid === b.parentPid &&
    a.rootPid === b.rootPid &&
    a.name === b.name &&
    a.command === b.command &&
    a.cpuPercent === b.cpuPercent &&
    a.rssBytes === b.rssBytes
  );
}

function processesEqual(
  a: readonly ResourceProcessSnapshotWire[],
  b: readonly ResourceProcessSnapshotWire[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((process, index) => processEqual(process, b[index]));
}

function epicUsageEqual(
  a: EpicResourceSnapshotWire,
  b: EpicResourceSnapshotWire,
): boolean {
  return (
    a.cpuPercent === b.cpuPercent &&
    a.rssBytes === b.rssBytes &&
    a.processCount === b.processCount &&
    a.ownerCount === b.ownerCount
  );
}

function taskSummaryEqual(
  a: TaskResourceSummary,
  b: TaskResourceSummary,
): boolean {
  return (
    a.cpuPercent === b.cpuPercent &&
    a.rssBytes === b.rssBytes &&
    a.trackedProcessCount === b.trackedProcessCount &&
    a.openTerminalCount === b.openTerminalCount &&
    a.tuiAgentCount === b.tuiAgentCount &&
    a.guiAgentCount === b.guiAgentCount
  );
}

function appUsageEqual(
  a: AppResourceSnapshotWire,
  b: AppResourceSnapshotWire,
): boolean {
  if (
    a.hostTotalMemoryBytes !== b.hostTotalMemoryBytes ||
    a.processCount !== b.processCount ||
    a.cpuPercent !== b.cpuPercent ||
    a.rssBytes !== b.rssBytes
  ) {
    return false;
  }
  if (a.process === null || b.process === null) return a.process === b.process;
  return processEqual(a.process, b.process);
}

function mergeOwners(
  previous: ReadonlyMap<string, OwnerResourceSnapshotWire>,
  payload: ResourcesProjectionPayload,
): ReadonlyMap<string, OwnerResourceSnapshotWire> {
  if (payload.owners.length === 0) return EMPTY_OWNERS;
  const next = new Map<string, OwnerResourceSnapshotWire>();
  for (const owner of payload.owners) {
    const key = resourceOwnerKey(owner.owner.kind, owner.owner.ownerId);
    const existing = previous.get(key);
    next.set(
      key,
      existing !== undefined && ownerUsageEqual(existing, owner)
        ? existing
        : owner,
    );
  }
  return next;
}

export function deriveTaskResourceSummary(
  app: AppResourceSnapshotWire | null,
  owners: readonly OwnerResourceSnapshotWire[],
): TaskResourceSummary | null {
  if (app === null && owners.length === 0) return null;

  let cpuPercent = app?.cpuPercent ?? 0;
  let rssBytes = app?.rssBytes ?? 0;
  let trackedProcessCount = app?.processCount ?? 0;
  let openTerminalCount = 0;
  let tuiAgentCount = 0;
  let guiAgentCount = 0;

  for (const snapshot of owners) {
    cpuPercent += snapshot.cpuPercent;
    rssBytes += snapshot.rssBytes;
    trackedProcessCount += snapshot.processCount;

    switch (snapshot.owner.kind) {
      case "terminal":
        openTerminalCount += 1;
        break;
      case "terminal-agent":
        tuiAgentCount += 1;
        break;
      case "chat":
        guiAgentCount += 1;
        break;
    }
  }

  return {
    cpuPercent,
    rssBytes,
    trackedProcessCount,
    openTerminalCount,
    tuiAgentCount,
    guiAgentCount,
  };
}

function mergeEpic(
  previous: EpicResourceSnapshotWire | null,
  next: EpicResourceSnapshotWire | null,
): EpicResourceSnapshotWire | null {
  if (next === null) return null;
  if (previous !== null && epicUsageEqual(previous, next)) return previous;
  return next;
}

function mergeApp(
  previous: AppResourceSnapshotWire | null,
  next: AppResourceSnapshotWire | null,
): AppResourceSnapshotWire | null {
  if (next === null) return null;
  if (previous !== null && appUsageEqual(previous, next)) return previous;
  return next;
}

function mergeTaskSummary(
  previous: TaskResourceSummary | null,
  payload: ResourcesProjectionPayload,
): TaskResourceSummary | null {
  const next = deriveTaskResourceSummary(payload.app, payload.owners);
  if (next === null) return null;
  if (previous !== null && taskSummaryEqual(previous, next)) return previous;
  return next;
}

export function createResourcesStore(
  options: ResourcesStoreOptions,
): ResourcesStoreHandle {
  let disposed = false;
  let streamClient: ResourcesStreamClientHandle | null = null;

  const store = create<ResourcesState>()((set) => {
    const applyProjection = (payload: ResourcesProjectionPayload): void => {
      if (disposed) return;
      set((state) => ({
        sampledAt: payload.sampledAt,
        owners: mergeOwners(state.owners, payload),
        app: mergeApp(state.app, payload.app),
        epic: mergeEpic(state.epic, payload.epic),
        taskSummary: mergeTaskSummary(state.taskSummary, payload),
      }));
    };

    const callbacks: ResourcesStreamCallbacks = {
      onSnapshot: applyProjection,
      onUpdate: applyProjection,
      onConnectionStatus: (
        status: StreamConnectionStatus,
        _reason: StreamCloseReason | null,
      ) => {
        if (disposed) return;
        set({ connectionStatus: status });
      },
    };

    streamClient = options.streamClientFactory(options.epicId, callbacks);

    return {
      epicId: options.epicId,
      connectionStatus: "connecting",
      sampledAt: null,
      owners: EMPTY_OWNERS,
      app: null,
      epic: null,
      taskSummary: null,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (streamClient === null) return;
        const client = streamClient;
        streamClient = null;
        client.close();
      },
    };
  });

  return {
    epicId: options.epicId,
    store,
    dispose: () => {
      store.getState().dispose();
    },
  };
}
