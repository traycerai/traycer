import { useCallback, useSyncExternalStore } from "react";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";

export interface ReactiveHostReadiness {
  readonly hostId: string | null;
  readonly requestContextUserId: string | null;
  readonly isReady: boolean;
}

const SNAPSHOT_SEPARATOR = "\u0000";

export function useReactiveHostReadiness<Registry extends VersionedRpcRegistry>(
  client: HostRequester<Registry> | null,
): ReactiveHostReadiness {
  const subscribe = useCallback(
    (callback: () => void) => {
      if (client === null) {
        return () => undefined;
      }
      const unsubscribe = client.onChange(() => {
        callback();
      });
      return () => {
        unsubscribe();
      };
    },
    [client],
  );
  const getSnapshot = useCallback(
    () => readHostReadinessSnapshot(client),
    [client],
  );
  return parseHostReadinessSnapshot(
    useSyncExternalStore(subscribe, getSnapshot, () =>
      readHostReadinessSnapshot(null),
    ),
  );
}

function readHostReadinessSnapshot<Registry extends VersionedRpcRegistry>(
  client: HostRequester<Registry> | null,
): string {
  return [
    client?.getActiveHostId() ?? "",
    client?.getRequestContextUserId() ?? "",
  ].join(SNAPSHOT_SEPARATOR);
}

function parseHostReadinessSnapshot(snapshot: string): ReactiveHostReadiness {
  const separatorIndex = snapshot.indexOf(SNAPSHOT_SEPARATOR);
  const hostId = normalizeSnapshotPart(snapshot.slice(0, separatorIndex));
  const requestContextUserId = normalizeSnapshotPart(
    snapshot.slice(separatorIndex + SNAPSHOT_SEPARATOR.length),
  );
  return {
    hostId,
    requestContextUserId,
    isReady: hostId !== null && requestContextUserId !== null,
  };
}

function normalizeSnapshotPart(value: string): string | null {
  if (value.length === 0) {
    return null;
  }
  return value;
}
