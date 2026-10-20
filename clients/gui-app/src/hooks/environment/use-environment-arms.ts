import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { readProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type {
  HostCommunicationGraphCloudFeedCursor,
  HostCommunicationGraphCloudFeedEvent,
} from "@traycer/protocol/host/epic/communication-graph";
import {
  environmentChatsSubscribeServerFrameSchema,
  environmentCommunicationGraphSubscribeServerFrameSchema,
  environmentPlainTerminalsSubscribeServerFrameSchema,
} from "@traycer/protocol/host/environment/arm-streams";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { PlainTerminalRecord } from "@traycer/protocol/host/terminal/plain-schemas";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { usePoolTierStreamClient } from "@/hooks/host/use-pool-tier";
import {
  createEnvironmentArmLanes,
  type EnvironmentArmLaneSpec,
  type EnvironmentArmLanes,
} from "@/lib/environment-arm/environment-arm-lanes";
import { useHostClient } from "@/lib/host";
import { useStreamMethodSupportFor } from "@/lib/host/stream-runtime-context";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

type EnvironmentArmMethod =
  | "environment.chats.subscribe"
  | "environment.plainTerminals.subscribe"
  | "environment.communicationGraph.subscribe";

interface EnvironmentArmScope {
  readonly poolHostId: string;
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
  readonly viewerId: string;
  /** The viewer's team environments: the only ones with an arm. */
  readonly environmentIds: readonly string[];
}

/**
 * Where `method`'s arms are read, or `null` when there are none to read: a
 * build without a server pool, a session the cloud has not authorized, a
 * pool that does not serve the method, or a viewer in no team. The task's
 * attachment is not known here - an environment the task is not attached to
 * ends its arm with `FORBIDDEN`, which reads as no rows.
 */
function useEnvironmentArmScope(
  method: EnvironmentArmMethod,
): EnvironmentArmScope | null {
  const pool = readProcessHostRpcTierPlan().pool;
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const viewerId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const client = usePoolTierStreamClient(null, viewerId);
  const support = useStreamMethodSupportFor(client, method);
  const environments = useEnvironmentListQuery(
    useHostClient(),
    pool !== null && authorized,
  );
  const environmentData = environments.data;
  return useMemo(() => {
    const environmentIds = (environmentData?.environments ?? [])
      .filter((environment) => environment.ownerKind === "organization")
      .map((environment) => environment.environmentId);
    if (
      pool === null ||
      !authorized ||
      viewerId === null ||
      client === null ||
      support !== "supported" ||
      environmentIds.length === 0
    ) {
      return null;
    }
    return { poolHostId: pool.hostId, client, viewerId, environmentIds };
  }, [authorized, client, environmentData, pool, support, viewerId]);
}

/**
 * Holds every lane in `specs` while mounted and reads their states, one per
 * spec, as a stable array: the same array until some lane's state moves.
 * `specs` is memoized by its caller, so its identity moves only when the
 * lanes it names do.
 */
function useEnvironmentArmStates<State, Frame>(
  lanes: EnvironmentArmLanes<State, Frame>,
  specs: readonly EnvironmentArmLaneSpec<State, Frame>[],
  initial: State,
): readonly State[] {
  useEffect(() => {
    const releases = specs.map((spec) => lanes.acquire(spec));
    return () => {
      for (const release of releases) release();
    };
  }, [lanes, specs]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribes = specs.map((spec) =>
        lanes.subscribe(spec.key, listener),
      );
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    [lanes, specs],
  );
  const snapshotRef = useRef<readonly State[]>([]);
  const getSnapshot = useCallback((): readonly State[] => {
    const next = specs.map((spec) => lanes.read(spec.key, initial));
    const previous = snapshotRef.current;
    if (
      previous.length === next.length &&
      previous.every((state, index) => state === next[index])
    ) {
      return previous;
    }
    snapshotRef.current = next;
    return next;
  }, [initial, lanes, specs]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function laneKey(
  method: EnvironmentArmMethod,
  scope: EnvironmentArmScope,
  environmentId: string,
  scopeId: string,
): string {
  return JSON.stringify([
    method,
    scope.poolHostId,
    scope.viewerId,
    environmentId,
    scopeId,
  ]);
}

// ---- chats ---------------------------------------------------------------- //

type ChatsFrame = readonly CloudChatSummary[];
interface ChatsState {
  /** The arm has answered: a snapshot arrived, or the arm ended. */
  readonly settled: boolean;
  readonly chats: readonly CloudChatSummary[];
}
const NO_CHATS: ChatsState = Object.freeze({
  settled: false,
  chats: Object.freeze([]),
});
const ENDED_CHATS: ChatsState = Object.freeze({
  settled: true,
  chats: Object.freeze([]),
});
const chatLanes = createEnvironmentArmLanes<ChatsState, ChatsFrame>();

/**
 * The task's chats that its team environments own, as the pool's
 * environment arm serves them to a member - private ones included. Each
 * row's `identity.ownerUserId` is its environment.
 */
export function useEnvironmentArmChats(
  taskId: string,
): readonly CloudChatSummary[] {
  const scope = useEnvironmentArmScope("environment.chats.subscribe");
  const specs = useMemo(
    () =>
      scope === null || taskId.length === 0
        ? []
        : scope.environmentIds.map(
            (
              environmentId,
            ): EnvironmentArmLaneSpec<ChatsState, ChatsFrame> => ({
              key: laneKey(
                "environment.chats.subscribe",
                scope,
                environmentId,
                taskId,
              ),
              poolHostId: scope.poolHostId,
              client: scope.client,
              initial: NO_CHATS,
              ended: ENDED_CHATS,
              open: (client) =>
                client.subscribe("environment.chats.subscribe", {
                  environmentId,
                  taskId,
                }),
              parse: (envelope) => {
                const parsed =
                  environmentChatsSubscribeServerFrameSchema.safeParse(
                    envelope,
                  );
                if (!parsed.success) return null;
                return parsed.data.kind === "pong"
                  ? { kind: "pong" }
                  : {
                      kind: "frame",
                      generation: parsed.data.generation,
                      frame: parsed.data.chats,
                    };
              },
              reduce: (_state, chats) => ({ settled: true, chats }),
            }),
          ),
    [scope, taskId],
  );
  const states = useEnvironmentArmStates(chatLanes, specs, NO_CHATS);
  return useMemo(() => states.flatMap((state) => state.chats), [states]);
}

/**
 * The arm chats this client already holds for `taskId` under `viewerId`,
 * read without opening anything. Only lanes a mounted surface holds are
 * here, so an empty answer is not evidence that the task has none.
 */
export function heldEnvironmentArmChats(
  viewerId: string,
  taskId: string,
): {
  /** Environments whose arm for this task has answered. */
  readonly settledEnvironmentIds: ReadonlySet<string>;
  readonly chats: readonly CloudChatSummary[];
} {
  const settledEnvironmentIds = new Set<string>();
  const chats: CloudChatSummary[] = [];
  for (const [key, state] of chatLanes.held()) {
    const parts: unknown = JSON.parse(key);
    if (!Array.isArray(parts) || parts[2] !== viewerId || parts[4] !== taskId) {
      continue;
    }
    if (!state.settled || typeof parts[3] !== "string") continue;
    settledEnvironmentIds.add(parts[3]);
    chats.push(...state.chats);
  }
  return { settledEnvironmentIds, chats };
}

// ---- plain terminals ------------------------------------------------------ //

interface TerminalsState {
  readonly catalogVersion: number;
  readonly terminals: readonly PlainTerminalRecord[];
}
const NO_TERMINALS: TerminalsState = Object.freeze({
  catalogVersion: -1,
  terminals: Object.freeze([]),
});
const terminalLanes = createEnvironmentArmLanes<
  TerminalsState,
  TerminalsState
>();

/**
 * The task's plain-terminal catalog rows its team environments own, as the
 * pool's environment arm serves them: records only, with no live runtime.
 */
export function useEnvironmentArmTerminals(
  epicId: string,
): readonly PlainTerminalRecord[] {
  const scope = useEnvironmentArmScope("environment.plainTerminals.subscribe");
  const specs = useMemo(
    () =>
      scope === null || epicId.length === 0
        ? []
        : scope.environmentIds.map(
            (
              environmentId,
            ): EnvironmentArmLaneSpec<TerminalsState, TerminalsState> => ({
              key: laneKey(
                "environment.plainTerminals.subscribe",
                scope,
                environmentId,
                epicId,
              ),
              poolHostId: scope.poolHostId,
              client: scope.client,
              initial: NO_TERMINALS,
              ended: NO_TERMINALS,
              open: (client) =>
                client.subscribe("environment.plainTerminals.subscribe", {
                  environmentId,
                  epicId,
                }),
              parse: (envelope) => {
                const parsed =
                  environmentPlainTerminalsSubscribeServerFrameSchema.safeParse(
                    envelope,
                  );
                if (!parsed.success) return null;
                return parsed.data.kind === "pong"
                  ? { kind: "pong" }
                  : {
                      kind: "frame",
                      generation: parsed.data.generation,
                      frame: {
                        catalogVersion: parsed.data.catalogVersion,
                        terminals: parsed.data.terminals,
                      },
                    };
              },
              // A snapshot of an older catalog than the one held is a late
              // frame, not a rollback.
              reduce: (state, next) =>
                next.catalogVersion < state.catalogVersion ? state : next,
            }),
          ),
    [scope, epicId],
  );
  const states = useEnvironmentArmStates(terminalLanes, specs, NO_TERMINALS);
  return useMemo(() => states.flatMap((state) => state.terminals), [states]);
}

// ---- communication graph -------------------------------------------------- //

interface GraphState {
  readonly events: readonly HostCommunicationGraphCloudFeedEvent[];
  readonly cursor: HostCommunicationGraphCloudFeedCursor | null;
}
interface GraphFrame {
  readonly events: readonly HostCommunicationGraphCloudFeedEvent[];
  readonly cursor: HostCommunicationGraphCloudFeedCursor | null;
}
const NO_GRAPH: GraphState = Object.freeze({
  events: Object.freeze([]),
  cursor: null,
});
const graphLanes = createEnvironmentArmLanes<GraphState, GraphFrame>();

/**
 * The task's communication-graph events its team environments recorded, as
 * the pool's environment arm serves them, each exactly once: a stream that
 * redials continues after the last applied cursor.
 */
export function useEnvironmentArmGraphEvents(
  epicId: string,
): readonly HostCommunicationGraphCloudFeedEvent[] {
  const scope = useEnvironmentArmScope(
    "environment.communicationGraph.subscribe",
  );
  const specs = useMemo(
    () =>
      scope === null || epicId.length === 0
        ? []
        : scope.environmentIds.map(
            (
              environmentId,
            ): EnvironmentArmLaneSpec<GraphState, GraphFrame> => ({
              key: laneKey(
                "environment.communicationGraph.subscribe",
                scope,
                environmentId,
                epicId,
              ),
              poolHostId: scope.poolHostId,
              client: scope.client,
              initial: NO_GRAPH,
              ended: NO_GRAPH,
              open: (client, readState) =>
                client.subscribeWithParamsProvider(
                  "environment.communicationGraph.subscribe",
                  () => ({
                    environmentId,
                    epicId,
                    sinceCursor: readState().cursor,
                  }),
                ),
              parse: (envelope) => {
                const parsed =
                  environmentCommunicationGraphSubscribeServerFrameSchema.safeParse(
                    envelope,
                  );
                if (!parsed.success) return null;
                return parsed.data.kind === "pong"
                  ? { kind: "pong" }
                  : {
                      kind: "frame",
                      generation: parsed.data.generation,
                      frame: {
                        events: parsed.data.events,
                        cursor: parsed.data.cursor,
                      },
                    };
              },
              reduce: (state, frame) => {
                const seen = new Set(
                  state.events.map((event) => event.eventId),
                );
                const fresh = frame.events.filter(
                  (event) => !seen.has(event.eventId),
                );
                const cursor = frame.cursor ?? state.cursor;
                if (fresh.length === 0 && cursor === state.cursor) return state;
                return { events: [...state.events, ...fresh], cursor };
              },
            }),
          ),
    [scope, epicId],
  );
  const states = useEnvironmentArmStates(graphLanes, specs, NO_GRAPH);
  return useMemo(() => states.flatMap((state) => state.events), [states]);
}
