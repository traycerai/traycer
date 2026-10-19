import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import {
  authenticatedHostStreamKey,
  authenticatedOwnerIdentityKey,
} from "@/hooks/host/use-host-stream-client-for";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import {
  acquireSimulatorSessionsCoordinator,
  hasSimulatorSessionsCoordinator,
  SIMULATORS_UNSUPPORTED_MESSAGE,
  simulatorSessionsCoordinatorKey,
  simulatorSessionsCoordinatorState,
  subscribeToSimulatorSessionsCoordinator,
  type SimulatorSessionsState,
} from "@/lib/simulator-view/simulator-sessions-coordinator";

/**
 * The simulator inventory of one host for one epic, shared with every other
 * surface in this window reading the same host (see the coordinator).
 *
 * A host KNOWN to lack `simulator.list` (a completed handshake without it)
 * reads `unsupported` with no stream opened at all: it predates the domain
 * and negotiated the whole family away. A host whose handshake has not
 * answered yet is still asked: the stream's own compatibility check closes
 * with `INCOMPATIBLE` for `simulator.sessions` when it cannot serve it, and
 * that close reads `unsupported` the same way - so a surface with no unary
 * traffic of its own (the Browsers panel) still learns the answer.
 */
export function useSimulatorSessionsForHost(args: {
  readonly hostId: string | null;
  readonly epicId: string;
}): SimulatorSessionsState {
  const { hostId, epicId } = args;
  const hostClient = useHostClientForHostId(hostId);
  const hostEntry = useHostDirectoryEntry(hostId ?? UNKNOWN_HOST_PLACEHOLDER);
  const methodSupport = useHostMethodSupport(hostId, "simulator.list");
  const transportReady =
    hostClient !== null &&
    authenticatedHostStreamKey(hostClient, hostEntry) !== null;
  const identityKey =
    hostClient === null
      ? null
      : authenticatedOwnerIdentityKey(hostClient, hostEntry);
  const openTransport = useDurableStreamTransportFactory();
  const ownerKey =
    hostId === null || identityKey === null
      ? null
      : simulatorSessionsCoordinatorKey({ hostId, epicId, identityKey });
  const coordinatorKey =
    ownerKey !== null &&
    methodSupport !== false &&
    (transportReady || hasSimulatorSessionsCoordinator(ownerKey))
      ? ownerKey
      : null;
  const [consumerId] = useState(() => Symbol("simulator-sessions-consumer"));
  const acquire = useEffectEvent((key: string, acquiredHostId: string) =>
    acquireSimulatorSessionsCoordinator({
      key,
      consumerId,
      hostId: acquiredHostId,
      epicId,
      openTransport,
    }),
  );

  useEffect(() => {
    if (coordinatorKey === null || hostId === null) return;
    return acquire(coordinatorKey, hostId);
  }, [coordinatorKey, hostId]);

  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeToSimulatorSessionsCoordinator(coordinatorKey, listener),
    [coordinatorKey],
  );
  const getSnapshot = useCallback(
    () => simulatorSessionsCoordinatorState(coordinatorKey),
    [coordinatorKey],
  );
  const live = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const placeholder = useMemo(
    () => placeholderState(hostId, methodSupport),
    [hostId, methodSupport],
  );
  return live ?? placeholder;
}

function placeholderState(
  hostId: string | null,
  methodSupport: boolean | null,
): SimulatorSessionsState {
  return {
    hostId,
    lifecycle: methodSupport === false ? "unsupported" : "connecting",
    state: null,
    errorMessage:
      methodSupport === false ? SIMULATORS_UNSUPPORTED_MESSAGE : null,
    refresh: () => undefined,
    retry: () => undefined,
  };
}
