import type {
  SimulatorState,
  SimulatorSummary,
} from "@traycer/protocol/host/simulator/schemas";
import type {
  SimulatorSessionsServerFrame,
  SimulatorStatePatch,
} from "@traycer/protocol/host/simulator/stream-contracts";
import {
  isIncompatibleCloseForMethod,
  type StreamCloseReason,
  type StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import { SimulatorSessionsStreamClient } from "@traycer-clients/shared/host-transport/simulator-sessions-stream-client";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { appLogger } from "@/lib/logger";

/**
 * One host's simulator inventory for one epic, shared by every surface that
 * reads it in this window - the tile, the Browsers panel's Mobile simulators group,
 * the open menu - the way `browser-sessions-coordinator.ts` shares the
 * browser inventory. Keyed by {host, epic, authenticated owner} so two epics
 * on one host are two streams (the sessions and boots the host publishes are
 * epic-scoped), and consumers refcount into one coordinator rather than each
 * opening a `simulator.sessions` of their own.
 */

export type SimulatorSessionsLifecycle =
  | "connecting"
  | "live"
  | "reconnecting"
  | "failed"
  | "unsupported"
  | "closed";

export interface SimulatorSessionsState {
  readonly hostId: string | null;
  readonly lifecycle: SimulatorSessionsLifecycle;
  /** The host's last published state; null until the first snapshot. */
  readonly state: SimulatorState | null;
  readonly errorMessage: string | null;
  /** Re-run discovery on the host: the capability probe, the pack, the inventory. */
  readonly refresh: () => void;
  /** Reopen a failed stream. */
  readonly retry: () => void;
}

export const SIMULATORS_UNSUPPORTED_MESSAGE =
  "This host needs an update before it can show simulators.";

/** The host's `simulators`, booted ones first, then by name. */
export function orderSimulators(
  simulators: readonly SimulatorSummary[],
): readonly SimulatorSummary[] {
  return [...simulators].sort((a, b) => {
    if (a.booted !== b.booted) return a.booted ? -1 : 1;
    if (a.platform !== b.platform) return a.platform === "ios" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Whether the task holds a session on `simulatorId` - whoever opened it: a
 * tile in this window, one in another, or an agent's `simulator_open`. The
 * wire does not say which; the sessions list is epic-scoped, so any entry is
 * this task's.
 */
export function simulatorHasSession(
  state: SimulatorState,
  simulatorId: string,
): boolean {
  return state.sessions.some((session) => session.simulatorId === simulatorId);
}

/**
 * Folds a `stateChanged` into the state it patches. Each patch field is
 * present only when it moved, so an absent one keeps the previous value.
 */
export function applySimulatorStatePatch(
  current: SimulatorState,
  revision: number,
  patch: SimulatorStatePatch,
): SimulatorState {
  return {
    revision,
    hostId: current.hostId,
    platforms: patch.platforms ?? current.platforms,
    packState: patch.packState ?? current.packState,
    hubState: patch.hubState ?? current.hubState,
    simulators: patch.simulators ?? current.simulators,
    sessions: patch.sessions ?? current.sessions,
    booting: patch.booting ?? current.booting,
  };
}

function reduceSimulatorSessionsFrame(
  current: SimulatorState | null,
  frame: SimulatorSessionsServerFrame,
): SimulatorState | null {
  if (frame.kind === "snapshot") return frame.state;
  // A patch before any snapshot has nothing to patch; the snapshot that
  // follows a reconnect carries the whole state anyway.
  if (current === null) return null;
  if (frame.revision < current.revision) return current;
  return applySimulatorStatePatch(current, frame.revision, frame.patch);
}

export function simulatorSessionsCoordinatorKey(args: {
  readonly hostId: string;
  readonly epicId: string;
  readonly identityKey: string;
}): string {
  return ["simulator-sessions", args.hostId, args.epicId, args.identityKey]
    .map(encodeURIComponent)
    .join("|");
}

interface CoordinatorEntry {
  readonly key: string;
  readonly hostId: string;
  readonly epicId: string;
  readonly openTransport: (hostId: string) => DurableStreamTransport;
  readonly consumers: Set<symbol>;
  readonly listeners: Set<() => void>;
  transport: DurableStreamTransport | null;
  client: SimulatorSessionsStreamClient | null;
  /**
   * Bumped on every open. Callbacks compare against the value they were
   * created with rather than against `client`: a session that is already
   * open replays its status synchronously INSIDE the client's constructor,
   * before the client exists to be compared with.
   */
  generation: number;
  state: SimulatorSessionsState;
}

const coordinators = new Map<string, CoordinatorEntry>();

function notify(entry: CoordinatorEntry): void {
  for (const listener of entry.listeners) listener();
}

function patchState(
  entry: CoordinatorEntry,
  patch: Partial<SimulatorSessionsState>,
): void {
  entry.state = { ...entry.state, ...patch };
  notify(entry);
}

function closeStream(entry: CoordinatorEntry): void {
  const { client, transport } = entry;
  entry.client = null;
  entry.transport = null;
  client?.close();
  transport?.close();
}

function lifecycleForClose(
  reason: StreamCloseReason | null,
): Pick<SimulatorSessionsState, "lifecycle" | "errorMessage"> {
  if (reason === null || reason.kind === "caller") {
    return { lifecycle: "closed", errorMessage: null };
  }
  if (isIncompatibleCloseForMethod(reason, "simulator.sessions")) {
    return {
      lifecycle: "unsupported",
      errorMessage: SIMULATORS_UNSUPPORTED_MESSAGE,
    };
  }
  return {
    lifecycle: "failed",
    errorMessage: reason.details.reason,
  };
}

function openStream(entry: CoordinatorEntry): void {
  closeStream(entry);
  let transport: DurableStreamTransport;
  try {
    transport = entry.openTransport(entry.hostId);
  } catch (cause) {
    appLogger.warn("[simulator] could not open the sessions transport", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    patchState(entry, {
      lifecycle: "failed",
      errorMessage: "Could not reach this host.",
    });
    return;
  }
  entry.transport = transport;
  entry.generation++;
  const generation = entry.generation;
  patchState(entry, { lifecycle: "connecting", errorMessage: null });
  const client = new SimulatorSessionsStreamClient({
    epicId: entry.epicId,
    wsStreamClient: transport.wsStreamClient,
    callbacks: {
      onServerFrame: (frame) => {
        if (entry.generation !== generation) return;
        const next = reduceSimulatorSessionsFrame(entry.state.state, frame);
        if (next === entry.state.state) return;
        patchState(entry, { state: next });
      },
      onConnectionStatus: (status: StreamConnectionStatus, reason) => {
        if (entry.generation !== generation) return;
        switch (status) {
          case "connecting":
            patchState(entry, { lifecycle: "connecting", errorMessage: null });
            return;
          case "open":
            patchState(entry, { lifecycle: "live", errorMessage: null });
            return;
          case "reconnecting":
            patchState(entry, { lifecycle: "reconnecting" });
            return;
          case "closed":
            patchState(entry, lifecycleForClose(reason));
            return;
        }
      },
    },
  });
  entry.client = client;
}

export function hasSimulatorSessionsCoordinator(key: string): boolean {
  return coordinators.has(key);
}

export function simulatorSessionsCoordinatorState(
  key: string | null,
): SimulatorSessionsState | null {
  if (key === null) return null;
  return coordinators.get(key)?.state ?? null;
}

export function subscribeToSimulatorSessionsCoordinator(
  key: string | null,
  listener: () => void,
): () => void {
  if (key === null) return () => undefined;
  const entry = coordinators.get(key);
  if (entry === undefined) return () => undefined;
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

/**
 * Takes one reference on the coordinator for `key`, creating it (and opening
 * its stream) when this is the first. The returned release drops the
 * reference; the last release closes the stream and forgets the entry.
 */
export function acquireSimulatorSessionsCoordinator(args: {
  readonly key: string;
  readonly consumerId: symbol;
  readonly hostId: string;
  readonly epicId: string;
  readonly openTransport: (hostId: string) => DurableStreamTransport;
}): () => void {
  let entry = coordinators.get(args.key);
  if (entry === undefined) {
    const created: CoordinatorEntry = {
      key: args.key,
      hostId: args.hostId,
      epicId: args.epicId,
      openTransport: args.openTransport,
      consumers: new Set(),
      listeners: new Set(),
      transport: null,
      client: null,
      generation: 0,
      state: {
        hostId: args.hostId,
        lifecycle: "connecting",
        state: null,
        errorMessage: null,
        refresh: () => {
          created.client?.sendClientFrame({
            kind: "refresh",
            hasBinaryPayload: false,
          });
        },
        retry: () => {
          openStream(created);
        },
      },
    };
    coordinators.set(args.key, created);
    entry = created;
    openStream(created);
  }
  const held = entry;
  held.consumers.add(args.consumerId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.consumers.delete(args.consumerId);
    if (held.consumers.size > 0) return;
    closeStream(held);
    coordinators.delete(held.key);
    held.listeners.clear();
  };
}

/** Test seam: drops every coordinator, closing its stream. */
export function resetSimulatorSessionsCoordinatorsForTests(): void {
  for (const entry of coordinators.values()) closeStream(entry);
  coordinators.clear();
}
