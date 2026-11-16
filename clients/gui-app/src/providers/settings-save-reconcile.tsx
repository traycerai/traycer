import {
  useCallback,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import {
  hasBorrowableRemoteSession,
  subscribeRemoteSessionReadiness,
} from "@traycer-clients/shared/host-transport/remote/index";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import type { SettingsSaveCoordinator } from "@/lib/environment/settings-save-coordinator";
import { useSettingsSaveMemoryStore } from "@/stores/settings/settings-save-memory-store";

/**
 * Whether this window already holds a session to a remote `hostId` that is
 * ready and in use by something else. Reading it opens nothing.
 */
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
 * Reconciles one host each time this window is connected to it again for its
 * own reasons. A remote host counts only while another surface holds a ready
 * session to it; this machine's own host while it can be asked. Nothing here
 * opens or dials a connection: a host the window is not connected to waits.
 */
function HostReconcile(props: {
  readonly hostId: string;
  readonly localHostId: string | null;
  readonly coordinator: SettingsSaveCoordinator;
}): null {
  const { hostId, localHostId, coordinator } = props;
  const isLocal = hostId === localHostId;
  // A requester and its readiness read the directory row; neither dials.
  const localReady = useReactiveHostReadiness(
    useHostClientForHostId(isLocal ? hostId : null),
  ).canExecute;
  const remoteHeld = useBorrowableRemoteSession(hostId);
  const connected = isLocal ? localReady : remoteHeld;
  useEffect(() => {
    if (connected) void coordinator.reconcile(hostId);
  }, [connected, coordinator, hostId]);
  return null;
}

/**
 * Applies this account's remembered saves as their hosts connect. Watches
 * only the hosts a remembered save was made on.
 */
export function SettingsSaveReconcile(props: {
  readonly coordinator: SettingsSaveCoordinator;
}): ReactNode {
  const localHostId = useReactiveLocalHostId();
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
      localHostId={localHostId}
      coordinator={props.coordinator}
    />
  ));
}
