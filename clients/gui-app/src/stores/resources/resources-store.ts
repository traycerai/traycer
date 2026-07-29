import { create, type StoreApi, type UseBoundStore } from "zustand";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  ResourcesProjectionPayload,
  ResourcesStreamScope,
  ResourcesStreamCallbacks,
  ResourcesStreamClient,
} from "@traycer-clients/shared/host-transport/resources-stream-client";
import type {
  AppResourceSnapshotWire,
  EpicResourceSnapshotWire,
  HostTreeResourceSnapshotWire,
  OtherResourceSnapshotWire,
  OwnerResourceSnapshotWireV13,
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
  scope: ResourcesStreamScope,
  callbacks: ResourcesStreamCallbacks,
) => ResourcesStreamClientHandle;

export type OwnerResourceUsage = OwnerResourceSnapshotWireV13;
export type EpicResourceUsage = EpicResourceSnapshotWire;
export type AppResourceUsage = AppResourceSnapshotWire;
export type HostTreeResourceUsage = HostTreeResourceSnapshotWire;
export type OtherResourceUsage = OtherResourceSnapshotWire;

export interface TaskResourceSummary {
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly trackedProcessCount: number;
}

/** Stable map key for one owner within an epic's projection. */
export function resourceOwnerKey(
  kind: ResourceOwnerKindWire,
  ownerId: string,
): string {
  return `${kind}\x1f${ownerId}`;
}

export function globalResourceOwnerKey(
  epicId: string,
  kind: ResourceOwnerKindWire,
  ownerId: string,
): string {
  return `${epicId}\x1f${kind}\x1f${ownerId}`;
}

export interface ResourcesState {
  readonly key: string;
  readonly connectionStatus: StreamConnectionStatus;
  /** `null` until the first projection lands. */
  readonly sampledAt: number | null;
  /**
   * Live owner snapshots keyed by `resourceOwnerKey`. An owner absent from this
   * map is "not currently tracked" - callers must treat that as unknown, never
   * as zero use.
   */
  readonly owners: ReadonlyMap<string, OwnerResourceSnapshotWireV13>;
  /** Host-app usage sampled alongside the owner projection. */
  readonly app: AppResourceSnapshotWire | null;
  /** Whole host-process-tree aggregate, available from resources.subscribe@1.2. */
  readonly hostTree: HostTreeResourceSnapshotWire | null;
  /** Unattributed host-tree process roots, available from resources.subscribe@1.2. */
  readonly other: OtherResourceSnapshotWire | null;
  /** `null` when the epic has no tracked owner roots (a valid quiet state). */
  readonly epic: EpicResourceSnapshotWire | null;
  readonly epics: ReadonlyMap<string, EpicResourceSnapshotWire>;
  readonly dispose: () => void;
}

export interface ResourcesStoreOptions {
  readonly scope: ResourcesStreamScope;
  readonly streamClientFactory: ResourcesStreamClientFactory;
}

export interface ResourcesStoreHandle {
  readonly key: string;
  readonly scope: ResourcesStreamScope;
  readonly store: UseBoundStore<StoreApi<ResourcesState>>;
  readonly dispose: () => void;
}

const EMPTY_OWNERS: ReadonlyMap<string, OwnerResourceSnapshotWireV13> =
  new Map();
const EMPTY_EPICS: ReadonlyMap<string, EpicResourceSnapshotWire> = new Map();

// Compare only the fields a chip renders. `sampledAt`/`rootPids` move on every
// host tick even when nothing displayable changed, so excluding them lets an
// unchanged owner keep its previous object identity across frames - the whole
// projection is resent each update, but only owners whose metrics actually moved
// get a new reference (and re-render their chip).
function ownerUsageEqual(
  a: OwnerResourceSnapshotWireV13,
  b: OwnerResourceSnapshotWireV13,
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

function hostTreeUsageEqual(
  a: HostTreeResourceSnapshotWire,
  b: HostTreeResourceSnapshotWire,
): boolean {
  return (
    a.processCount === b.processCount &&
    a.cpuPercent === b.cpuPercent &&
    a.rssBytes === b.rssBytes
  );
}

function otherUsageEqual(
  a: OtherResourceSnapshotWire,
  b: OtherResourceSnapshotWire,
): boolean {
  return (
    a.processCount === b.processCount &&
    a.cpuPercent === b.cpuPercent &&
    a.rssBytes === b.rssBytes &&
    processesEqual(a.processes, b.processes)
  );
}

function mergeOwners(
  previous: ReadonlyMap<string, OwnerResourceSnapshotWireV13>,
  payload: ResourcesProjectionPayload,
  scope: ResourcesStreamScope,
): ReadonlyMap<string, OwnerResourceSnapshotWireV13> {
  if (payload.owners.length === 0) return EMPTY_OWNERS;
  const next = new Map<string, OwnerResourceSnapshotWireV13>();
  for (const owner of payload.owners) {
    const key =
      scope.kind === "global"
        ? globalResourceOwnerKey(
            owner.owner.epicId,
            owner.owner.kind,
            owner.owner.ownerId,
          )
        : resourceOwnerKey(owner.owner.kind, owner.owner.ownerId);
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

function mergeEpic(
  previous: EpicResourceSnapshotWire | null,
  next: EpicResourceSnapshotWire | null,
): EpicResourceSnapshotWire | null {
  if (next === null) return null;
  if (previous !== null && epicUsageEqual(previous, next)) return previous;
  return next;
}

function mergeEpics(
  previous: ReadonlyMap<string, EpicResourceSnapshotWire>,
  payload: ResourcesProjectionPayload,
): ReadonlyMap<string, EpicResourceSnapshotWire> {
  if (payload.epics.length === 0) {
    if (payload.epic === null) return EMPTY_EPICS;
    return new Map([[payload.epic.epicId, payload.epic]]);
  }
  const next = new Map<string, EpicResourceSnapshotWire>();
  for (const epic of payload.epics) {
    const existing = previous.get(epic.epicId);
    next.set(
      epic.epicId,
      existing !== undefined && epicUsageEqual(existing, epic)
        ? existing
        : epic,
    );
  }
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

function mergeHostTree(
  previous: HostTreeResourceSnapshotWire | null,
  next: HostTreeResourceSnapshotWire | null | undefined,
): HostTreeResourceSnapshotWire | null {
  if (next === null || next === undefined) return null;
  if (previous !== null && hostTreeUsageEqual(previous, next)) return previous;
  return next;
}

function mergeOther(
  previous: OtherResourceSnapshotWire | null,
  next: OtherResourceSnapshotWire | null | undefined,
): OtherResourceSnapshotWire | null {
  if (next === null || next === undefined) return null;
  if (previous !== null && otherUsageEqual(previous, next)) return previous;
  return next;
}

export function createResourcesStore(
  options: ResourcesStoreOptions,
): ResourcesStoreHandle {
  let disposed = false;
  let streamClient: ResourcesStreamClientHandle | null = null;
  const key =
    options.scope.kind === "global" ? "__global__" : options.scope.epicId;

  const store = create<ResourcesState>()((set) => {
    const applyProjection = (payload: ResourcesProjectionPayload): void => {
      if (disposed) return;
      set((state) => ({
        sampledAt: payload.sampledAt,
        owners: mergeOwners(state.owners, payload, options.scope),
        app: mergeApp(state.app, payload.app),
        hostTree: mergeHostTree(state.hostTree, payload.hostTree),
        other: mergeOther(state.other, payload.other),
        epic: mergeEpic(state.epic, payload.epic),
        epics: mergeEpics(state.epics, payload),
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

    streamClient = options.streamClientFactory(options.scope, callbacks);

    return {
      key,
      connectionStatus: "connecting",
      sampledAt: null,
      owners: EMPTY_OWNERS,
      app: null,
      hostTree: null,
      other: null,
      epic: null,
      epics: EMPTY_EPICS,
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
    key,
    scope: options.scope,
    store,
    dispose: () => {
      store.getState().dispose();
    },
  };
}
