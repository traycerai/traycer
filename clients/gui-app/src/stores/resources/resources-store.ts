import { create, type StoreApi, type UseBoundStore } from "zustand";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  ResourcesProjectionPayload,
  ResourcesScopeSupport,
  ResourcesStreamScope,
  ResourcesStreamCallbacks,
  ResourcesStreamClient,
} from "@traycer-clients/shared/host-transport/resources-stream-client";
import type {
  AppResourceSnapshotWireV15,
  EpicResourceSnapshotWireV15,
  HostTreeResourceSnapshotWireV15,
  OtherResourceSnapshotWireV15,
  ManagedCommandOwnerWire,
  OwnerResourceSnapshotWireV15,
  ResourceProcessSnapshotWireV15,
  ResourceOwnerKindWireV14,
  RestrictedResourceSnapshotWireV15,
  ResourcesSubscribeDemand,
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

export type ResourcesStreamClientHandle = Pick<
  ResourcesStreamClient,
  "close" | "setDemand"
>;

export type ResourcesStreamClientFactory = (
  scope: ResourcesStreamScope,
  callbacks: ResourcesStreamCallbacks,
) => ResourcesStreamClientHandle;

export type OwnerResourceUsage = OwnerResourceSnapshotWireV15;
export type EpicResourceUsage = EpicResourceSnapshotWireV15;
export type AppResourceUsage = AppResourceSnapshotWireV15;
export type HostTreeResourceUsage = HostTreeResourceSnapshotWireV15;
export type OtherResourceUsage = OtherResourceSnapshotWireV15;
export type RestrictedResourceUsage = RestrictedResourceSnapshotWireV15;

/**
 * Stable map key for one owner within an epic's projection.
 * Terminal owners are keyed by `(kind, hostId, ownerId)` so two hosts can
 * report the same terminal id without collapsing. Chat/agent owners stay
 * the historical 2-part key.
 */
export function resourceOwnerKey(
  kind: ResourceOwnerKindWireV14,
  ownerId: string,
  hostId: string | null,
): string {
  if (kind === "terminal") {
    return JSON.stringify([kind, hostId ?? "", ownerId]);
  }
  return `${kind}\x1f${ownerId}`;
}

export function globalResourceOwnerKey(
  epicId: string,
  kind: ResourceOwnerKindWireV14,
  ownerId: string,
  hostId: string | null,
): string {
  if (kind === "terminal") {
    return JSON.stringify([epicId, kind, hostId ?? "", ownerId]);
  }
  return `${epicId}\x1f${kind}\x1f${ownerId}`;
}

export interface ResourcesState {
  readonly key: string;
  readonly connectionStatus: StreamConnectionStatus;
  /**
   * Whether the host this stream negotiated with can serve THIS store's scope -
   * the transport-agnostic half of that question, learned from the session
   * itself rather than from a capability pre-check only a local client can
   * answer. See `ResourcesScopeSupport`.
   *
   * A global-scope store answering `"unsupported"` is the whole reason this
   * exists: it is the only way a REMOTE host too old for a global stream is
   * ever distinguishable from one that is merely quiet.
   */
  readonly scopeSupport: ResourcesScopeSupport;
  /** `null` until the first projection lands. */
  readonly sampledAt: number | null;
  /**
   * Live owner snapshots keyed by `resourceOwnerKey`. An owner absent from this
   * map is "not currently tracked" - callers must treat that as unknown, never
   * as zero use.
   */
  readonly owners: ReadonlyMap<string, OwnerResourceSnapshotWireV15>;
  /** Host-app usage sampled alongside the owner projection. */
  readonly app: AppResourceSnapshotWireV15 | null;
  /** Whole host-process-tree aggregate, available from resources.subscribe@1.2. */
  readonly hostTree: HostTreeResourceSnapshotWireV15 | null;
  /** Unattributed host-tree process roots, available from resources.subscribe@1.2. */
  readonly other: OtherResourceSnapshotWireV15 | null;
  /** Aggregate-only usage hidden by authorization or subscription scope. */
  readonly restricted: RestrictedResourceSnapshotWireV15 | null;
  /** `null` when the epic has no tracked owner roots (a valid quiet state). */
  readonly epic: EpicResourceSnapshotWireV15 | null;
  readonly epics: ReadonlyMap<string, EpicResourceSnapshotWireV15>;
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
  readonly setDemand: (demand: ResourcesSubscribeDemand) => void;
  readonly dispose: () => void;
}

const EMPTY_OWNERS: ReadonlyMap<string, OwnerResourceSnapshotWireV15> =
  new Map();
const EMPTY_EPICS: ReadonlyMap<string, EpicResourceSnapshotWireV15> = new Map();

// Compare only the fields a chip renders. `sampledAt`/`rootPids` move on every
// host tick even when nothing displayable changed, so excluding them lets an
// unchanged owner keep its previous object identity across frames - the whole
// projection is resent each update, but only owners whose metrics actually moved
// get a new reference (and re-render their chip).
function ownerUsageEqual(
  a: OwnerResourceSnapshotWireV15,
  b: OwnerResourceSnapshotWireV15,
): boolean {
  return (
    a.cpuPercent === b.cpuPercent &&
    a.rssBytes === b.rssBytes &&
    a.pssBytes === b.pssBytes &&
    a.privateBytes === b.privateBytes &&
    a.processCount === b.processCount &&
    a.activeProcessName === b.activeProcessName &&
    managedCommandEqual(a.managedCommand, b.managedCommand) &&
    processesEqual(a.processes, b.processes)
  );
}

// Renaming a shell - or muting one - changes what its row reads without moving
// a number, so both have to take part in the identity check that gates
// re-renders.
function managedCommandEqual(
  a: ManagedCommandOwnerWire | null,
  b: ManagedCommandOwnerWire | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.commandId === b.commandId &&
    a.monitoring === b.monitoring &&
    a.description === b.description &&
    a.createdByAgentId === b.createdByAgentId
  );
}

function processEqual(
  a: ResourceProcessSnapshotWireV15,
  b: ResourceProcessSnapshotWireV15,
): boolean {
  return (
    a.pid === b.pid &&
    a.parentPid === b.parentPid &&
    a.rootPid === b.rootPid &&
    a.name === b.name &&
    a.command === b.command &&
    a.cpuPercent === b.cpuPercent &&
    a.rssBytes === b.rssBytes &&
    a.pssBytes === b.pssBytes &&
    a.privateBytes === b.privateBytes &&
    processDescriptorEqual(a.descriptor, b.descriptor)
  );
}

function processDescriptorEqual(
  a: ResourceProcessSnapshotWireV15["descriptor"],
  b: ResourceProcessSnapshotWireV15["descriptor"],
): boolean {
  if (a === null || b === null) return a === b;
  return a.family === b.family && a.runtime === b.runtime && a.role === b.role;
}

function processesEqual(
  a: readonly ResourceProcessSnapshotWireV15[],
  b: readonly ResourceProcessSnapshotWireV15[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((process, index) => processEqual(process, b[index]));
}

function epicUsageEqual(
  a: EpicResourceSnapshotWireV15,
  b: EpicResourceSnapshotWireV15,
): boolean {
  return (
    a.cpuPercent === b.cpuPercent &&
    a.rssBytes === b.rssBytes &&
    a.pssBytes === b.pssBytes &&
    a.privateBytes === b.privateBytes &&
    a.processCount === b.processCount &&
    a.ownerCount === b.ownerCount
  );
}

function appUsageEqual(
  a: AppResourceSnapshotWireV15,
  b: AppResourceSnapshotWireV15,
): boolean {
  if (
    a.hostTotalMemoryBytes !== b.hostTotalMemoryBytes ||
    a.processCount !== b.processCount ||
    a.cpuPercent !== b.cpuPercent ||
    a.rssBytes !== b.rssBytes ||
    a.pssBytes !== b.pssBytes ||
    a.privateBytes !== b.privateBytes
  ) {
    return false;
  }
  if (a.process === null || b.process === null) return a.process === b.process;
  return processEqual(a.process, b.process);
}

function hostTreeUsageEqual(
  a: HostTreeResourceSnapshotWireV15,
  b: HostTreeResourceSnapshotWireV15,
): boolean {
  return (
    a.processCount === b.processCount &&
    a.cpuPercent === b.cpuPercent &&
    a.rssBytes === b.rssBytes &&
    a.pssBytes === b.pssBytes &&
    a.privateBytes === b.privateBytes
  );
}

function otherUsageEqual(
  a: OtherResourceSnapshotWireV15,
  b: OtherResourceSnapshotWireV15,
): boolean {
  return (
    a.processCount === b.processCount &&
    a.cpuPercent === b.cpuPercent &&
    a.rssBytes === b.rssBytes &&
    a.pssBytes === b.pssBytes &&
    a.privateBytes === b.privateBytes &&
    processesEqual(a.processes, b.processes)
  );
}

function restrictedUsageEqual(
  a: RestrictedResourceSnapshotWireV15,
  b: RestrictedResourceSnapshotWireV15,
): boolean {
  return (
    a.processCount === b.processCount &&
    a.cpuPercent === b.cpuPercent &&
    a.rssBytes === b.rssBytes &&
    a.pssBytes === b.pssBytes &&
    a.privateBytes === b.privateBytes
  );
}

function mergeOwners(
  previous: ReadonlyMap<string, OwnerResourceSnapshotWireV15>,
  payload: ResourcesProjectionPayload,
  scope: ResourcesStreamScope,
): ReadonlyMap<string, OwnerResourceSnapshotWireV15> {
  if (payload.owners.length === 0) return EMPTY_OWNERS;
  const next = new Map<string, OwnerResourceSnapshotWireV15>();
  for (const owner of payload.owners) {
    const key =
      scope.kind === "global"
        ? globalResourceOwnerKey(
            owner.owner.epicId,
            owner.owner.kind,
            owner.owner.ownerId,
            owner.owner.hostId,
          )
        : resourceOwnerKey(
            owner.owner.kind,
            owner.owner.ownerId,
            owner.owner.hostId,
          );
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
  previous: EpicResourceSnapshotWireV15 | null,
  next: EpicResourceSnapshotWireV15 | null,
): EpicResourceSnapshotWireV15 | null {
  if (next === null) return null;
  if (previous !== null && epicUsageEqual(previous, next)) return previous;
  return next;
}

function mergeEpics(
  previous: ReadonlyMap<string, EpicResourceSnapshotWireV15>,
  payload: ResourcesProjectionPayload,
): ReadonlyMap<string, EpicResourceSnapshotWireV15> {
  if (payload.epics.length === 0) {
    if (payload.epic === null) return EMPTY_EPICS;
    return new Map([[payload.epic.epicId, payload.epic]]);
  }
  const next = new Map<string, EpicResourceSnapshotWireV15>();
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
  previous: AppResourceSnapshotWireV15 | null,
  next: AppResourceSnapshotWireV15 | null,
): AppResourceSnapshotWireV15 | null {
  if (next === null) return null;
  if (previous !== null && appUsageEqual(previous, next)) return previous;
  return next;
}

function mergeHostTree(
  previous: HostTreeResourceSnapshotWireV15 | null,
  next: HostTreeResourceSnapshotWireV15 | null | undefined,
): HostTreeResourceSnapshotWireV15 | null {
  if (next === null || next === undefined) return null;
  if (previous !== null && hostTreeUsageEqual(previous, next)) return previous;
  return next;
}

function mergeOther(
  previous: OtherResourceSnapshotWireV15 | null,
  next: OtherResourceSnapshotWireV15 | null | undefined,
): OtherResourceSnapshotWireV15 | null {
  if (next === null || next === undefined) return null;
  if (previous !== null && otherUsageEqual(previous, next)) return previous;
  return next;
}

function mergeRestricted(
  previous: RestrictedResourceSnapshotWireV15 | null,
  next: RestrictedResourceSnapshotWireV15 | null | undefined,
): RestrictedResourceSnapshotWireV15 | null {
  if (next === null || next === undefined) return null;
  if (previous !== null && restrictedUsageEqual(previous, next)) {
    return previous;
  }
  return next;
}

export function createResourcesStore(
  options: ResourcesStoreOptions,
): ResourcesStoreHandle {
  let disposed = false;
  let streamClient: ResourcesStreamClientHandle | null = null;
  const key =
    options.scope.kind === "global" ? "__global__" : options.scope.epicId;

  const store = create<ResourcesState>()(() => ({
    key,
    connectionStatus: "connecting",
    scopeSupport: "unknown",
    sampledAt: null,
    owners: EMPTY_OWNERS,
    app: null,
    hostTree: null,
    other: null,
    restricted: null,
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
  }));

  const applyProjection = (payload: ResourcesProjectionPayload): void => {
    if (disposed) return;
    store.setState((state) => ({
      sampledAt: payload.sampledAt,
      owners: mergeOwners(state.owners, payload, options.scope),
      app: mergeApp(state.app, payload.app),
      hostTree: mergeHostTree(state.hostTree, payload.hostTree),
      other: mergeOther(state.other, payload.other),
      restricted: mergeRestricted(state.restricted, payload.restricted),
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
      store.setState({ connectionStatus: status });
    },
    onScopeSupport: (support: ResourcesScopeSupport) => {
      if (disposed) return;
      store.setState({ scopeSupport: support });
    },
  };

  // Opened only AFTER the initial state is installed, never from inside the
  // zustand initializer. A stream can publish before its factory returns: a
  // remote session that is already ready but does not advertise the method
  // rejects the subscribe synchronously, and `LogicalStream.onStatusChange`
  // replays that terminal close the instant the typed wrapper's constructor
  // installs a handler. Built inside the initializer, those writes land on a
  // state object the initializer's own `return` then overwrites - and a
  // terminal close has nothing following it to republish the verdict, so the
  // surface waits forever on a host that already answered.
  streamClient = options.streamClientFactory(options.scope, callbacks);

  return {
    key,
    scope: options.scope,
    store,
    // The client already ignores a demand it is holding, so there is nothing
    // to dedupe here.
    setDemand: (demand) => {
      streamClient?.setDemand(demand);
    },
    dispose: () => {
      store.getState().dispose();
    },
  };
}
