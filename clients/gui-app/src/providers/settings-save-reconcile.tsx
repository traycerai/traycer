import {
  useCallback,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { subscribeHostRowChanged } from "@traycer-clients/shared/host-client/host-connection-registry";
import {
  hasBorrowableRemoteSession,
  subscribeRemoteSessionReadiness,
} from "@traycer-clients/shared/host-transport/remote/index";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { servesOverLocalSocket } from "@/lib/host/host-messenger";
import type { SettingsSaveCoordinator } from "@/lib/environment/settings-save-coordinator";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsSaveMemoryStore } from "@/stores/settings/settings-save-memory-store";

/** Reading it opens nothing. */
function useBorrowableRemoteSession(hostId: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeRemoteSessionReadiness(onStoreChange),
    [],
  );
  const getSnapshot = useCallback(
    () => hasBorrowableRemoteSession(hostId),
    [hostId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Whether the transport serves `hostId` over the local socket, read from the
 * same row it routes by. Reading it opens nothing.
 */
function useServedOverLocalSocket(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string,
): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeHostRowChanged(hostId, onStoreChange),
    [hostId],
  );
  const getSnapshot = useCallback(() => {
    const entry = client === null ? null : client.resolveHostById(hostId);
    return entry !== null && servesOverLocalSocket(entry);
  }, [client, hostId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Nothing here opens or dials a connection: a host the window is not connected to waits. */
function HostReconcile(props: {
  readonly hostId: string;
  readonly coordinator: SettingsSaveCoordinator;
}): null {
  const { hostId, coordinator } = props;
  // A requester and its readiness read the directory row; neither dials.
  const client = useHostClientForHostId(hostId);
  const isLocal = useServedOverLocalSocket(client, hostId);
  const localReady = useReactiveHostReadiness(
    isLocal ? client : null,
  ).canExecute;
  const remoteHeld = useBorrowableRemoteSession(hostId);
  const connected = isLocal ? localReady : remoteHeld;
  // Read again under a new binding, and once a sign-in installs its account's
  // memory: no follow-up is armed while the memory is another account's.
  const binding = useHostBinding();
  const account = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  useEffect(() => {
    if (connected) void coordinator.reconcile(hostId);
  }, [connected, coordinator, hostId, binding, account]);
  return null;
}

export function SettingsSaveReconcile(props: {
  readonly coordinator: SettingsSaveCoordinator;
}): ReactNode {
  const hostIds = useSettingsSaveMemoryStore(
    useShallow((state) =>
      [
        ...new Set(Object.values(state.records).map((record) => record.hostId)),
      ].toSorted(),
    ),
  );
  return hostIds.map((hostId) => (
    <HostReconcile
      key={hostId}
      hostId={hostId}
      coordinator={props.coordinator}
    />
  ));
}
