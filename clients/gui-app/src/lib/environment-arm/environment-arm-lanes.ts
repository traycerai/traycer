import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import { acquireHostConnection } from "@traycer-clients/shared/host-client/host-connection-registry";
import { isReopenableHostStreamClose } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * One parsed environment-arm frame: the authorization `generation` it was
 * built under, and what it says.
 */
export type EnvironmentArmFrame<Frame> =
  | {
      readonly kind: "frame";
      readonly generation: number;
      readonly frame: Frame;
    }
  | { readonly kind: "pong" };

/**
 * One environment arm stream - one environment's rows in one task - as a
 * lane: what to open, how to read its frames, and how a frame moves the
 * state.
 */
export interface EnvironmentArmLaneSpec<State, Frame> {
  /** Identifies the lane: method, pool, viewer, environment and task. */
  readonly key: string;
  readonly poolHostId: string;
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
  /** What the arm holds before its first frame. */
  readonly initial: State;
  /** What it holds once it has ended (see `endsTheArm`). */
  readonly ended: State;
  /**
   * Opens the stream. A stream that resumes reads where from `readState` on
   * every (re)subscribe, so a transport redial continues from what was
   * applied.
   */
  readonly open: (
    client: IHostStreamClient<HostStreamRpcRegistry>,
    readState: () => State,
  ) => IStreamSession;
  /** `null` for a frame the contract does not declare. */
  readonly parse: (
    envelope: StreamFrameEnvelope,
  ) => EnvironmentArmFrame<Frame> | null;
  readonly reduce: (state: State, frame: Frame) => State;
}

interface Lane<State> {
  refs: number;
  state: State;
  readonly dispose: () => void;
  /** Replaces the arm's stream with a fresh one; the old one's closes stop counting. */
  readonly replaceSession: () => void;
}

/**
 * The closes that END an arm rather than interrupt it: the viewer left the
 * environment, the task is not attached to it, or the pool cannot serve the
 * method. The arm then holds nothing - the member's own rows stand alone -
 * and is not reopened until a consumer acquires it again or something that
 * changes the answer reopens it (`reopen`).
 */
function endsTheArm(reason: StreamCloseReason | null): boolean {
  if (reason === null || reason.kind !== "fatalError") return false;
  return (
    reason.details.code === "FORBIDDEN" || !isReopenableHostStreamClose(reason)
  );
}

function openLane<State, Frame>(
  spec: EnvironmentArmLaneSpec<State, Frame>,
  notify: () => void,
): Lane<State> {
  const connection = acquireHostConnection(spec.poolHostId);
  let disposed = false;
  let session: IStreamSession | null = null;
  // Frames built under an older authorization than one already seen on the
  // SAME server stream are stale: a re-authorization raises the generation
  // while frames read under the previous one may still be queued. The pool
  // numbers each stream from 0, so every (re)subscribe - a redial of this
  // session or a reopened one - starts the comparison over.
  let newestGeneration = -1;
  const reopen = connection.reconnect.openReopenLane(
    () => {
      session?.close();
      session = null;
      openSession();
    },
    (reason) => !endsTheArm(reason),
  );
  const lane: Lane<State> = {
    refs: 0,
    state: spec.initial,
    dispose: () => {
      disposed = true;
      reopen.dispose();
      session?.close();
      session = null;
      connection.release();
    },
    replaceSession: () => {
      if (disposed) return;
      // Cleared before the close, so neither this close nor a refusal the old
      // stream was already carrying can end or reschedule the lane.
      const previous = session;
      session = null;
      previous?.close();
      openSession();
    },
  };
  const publish = (state: State): void => {
    if (state === lane.state) return;
    lane.state = state;
    notify();
  };
  function openSession(): void {
    if (disposed) return;
    const current = spec.open(spec.client, () => lane.state);
    session = current;
    newestGeneration = -1;
    current.onServerFrame((envelope, binaryPayload) => {
      if (session !== current) return;
      const parsed = binaryPayload === null ? spec.parse(envelope) : null;
      if (parsed === null) {
        current.requestReconnect();
        return;
      }
      if (parsed.kind === "pong") return;
      if (parsed.generation < newestGeneration) return;
      newestGeneration = parsed.generation;
      reopen.resetBackoff();
      publish(spec.reduce(lane.state, parsed.frame));
    });
    current.onStatusChange((status, reason) => {
      if (session !== current) return;
      if (status === "open") {
        newestGeneration = -1;
        return;
      }
      if (status !== "closed") return;
      if (endsTheArm(reason)) {
        publish(spec.ended);
        return;
      }
      reopen.scheduleAfterClose(reason);
    });
  }
  openSession();
  return lane;
}

export interface EnvironmentArmLanes<State, Frame> {
  /**
   * Holds the lane `spec` names while the returned release is outstanding,
   * opening it on the first holder and closing it after the last, so every
   * surface that shows one environment's rows in one task shares one stream.
   */
  readonly acquire: (spec: EnvironmentArmLaneSpec<State, Frame>) => () => void;
  /**
   * Opens the lane `key` names on a fresh stream when someone holds it, ended
   * or not. What changes an arm's answer - the task attached to the
   * environment - moves nothing its holders key on, and a refusal the pool
   * decided before that change may still be on its way; the old stream's
   * closes no longer count once it is replaced.
   */
  readonly reopen: (key: string) => void;
  /** The lane's state, or `initial` while no one holds it. */
  readonly read: (key: string, initial: State) => State;
  /**
   * Hears every change of the lane `key` names, including its opening and
   * closing, so a reader may subscribe before the lane exists.
   */
  readonly subscribe: (key: string, listener: () => void) => () => void;
  /** Every lane someone holds, by key: what this client has in hand now. */
  readonly held: () => ReadonlyArray<readonly [string, State]>;
  /**
   * Hears every change of any lane, including its opening and closing: what
   * a reader of {@link held} subscribes to, since it names no one key.
   */
  readonly subscribeHeld: (listener: () => void) => () => void;
}

/** One kind of arm's lanes: chats, plain terminals or graph events. */
export function createEnvironmentArmLanes<State, Frame>(): EnvironmentArmLanes<
  State,
  Frame
> {
  const lanes = new Map<string, Lane<State>>();
  const listenersByKey = new Map<string, Set<() => void>>();
  const heldListeners = new Set<() => void>();
  const notify = (key: string): void => {
    for (const listener of [...(listenersByKey.get(key) ?? [])]) listener();
    for (const listener of [...heldListeners]) listener();
  };
  return {
    acquire: (spec) => {
      let lane = lanes.get(spec.key);
      if (lane === undefined) {
        lane = openLane(spec, () => notify(spec.key));
        lanes.set(spec.key, lane);
        // A stream can end while it opens (a close replayed synchronously),
        // publishing before the lane is in `held()`: told again once it is.
        if (lane.state !== spec.initial) notify(spec.key);
      }
      lane.refs += 1;
      const held = lane;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held.refs -= 1;
        if (held.refs > 0) return;
        if (lanes.get(spec.key) === held) lanes.delete(spec.key);
        held.dispose();
        if (held.state !== spec.initial) notify(spec.key);
      };
    },
    reopen: (key) => {
      lanes.get(key)?.replaceSession();
    },
    read: (key, initial) => lanes.get(key)?.state ?? initial,
    held: () => [...lanes].map(([key, lane]) => [key, lane.state] as const),
    subscribeHeld: (listener) => {
      heldListeners.add(listener);
      return () => {
        heldListeners.delete(listener);
      };
    },
    subscribe: (key, listener) => {
      const listeners = listenersByKey.get(key) ?? new Set<() => void>();
      listeners.add(listener);
      listenersByKey.set(key, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && listenersByKey.get(key) === listeners) {
          listenersByKey.delete(key);
        }
      };
    },
  };
}
