import { useCallback, useSyncExternalStore } from "react";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { subscribeAnyHostRowChanged } from "@traycer-clients/shared/host-client/host-connection-registry";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";

export interface ReactiveHostReadiness {
  readonly hostId: string | null;
  readonly requestContextUserId: string | null;
  readonly isReady: boolean;
  /** Whether the live directory row currently supplies an RPC address. */
  readonly hasRpcEndpoint: boolean;
  /** Identity + authority + the minimum transport input required to dial. */
  readonly canExecute: boolean;
}

const SNAPSHOT_SEPARATOR = "\u0000";

/**
 * ONE SUBSCRIPTION, and it is a fact about HOSTS (redesign P4.2).
 *
 * This hook used to carry a second arm - `client.onChange`, the active slot's
 * change event - which is what told it to look again while a privileged
 * binding existed. P4.2 deleted the slot, and the deletion was a deletion
 * rather than a migration precisely because the arm below was already wired
 * and already carrying the same wake (P4.1 measured that: the probe neutering
 * `bind()`'s emitters was CAUGHT before the registry landed and SURVIVED
 * after).
 *
 * A host's directory row landing (or its lease moving) is a fact about that
 * HOST, not about which host is effective, so the registry reports it whether
 * or not anything re-points. The COARSE signal is the right one here precisely
 * because this hook cannot name its host at subscribe time - it reads the id
 * off whatever client it was handed, and a pinned requester answers `null`
 * until the row exists. Naming the host would mean naming the very thing it is
 * waiting on. The `useSyncExternalStore` snapshot is a string compared by
 * value, so a wake that changes nothing re-renders nothing.
 */
export function useReactiveHostReadiness<Registry extends VersionedRpcRegistry>(
  client: HostRequester<Registry> | null,
): ReactiveHostReadiness {
  const subscribe = useCallback((callback: () => void) => {
    return subscribeAnyHostRowChanged(callback);
  }, []);
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
  // A few integration harnesses provide the original requester shape, before
  // `getActiveHost` was added. Production requesters always implement it; keep
  // those legacy harnesses on the former identity-and-authority contract.
  const activeHost = activeHostForCompatibility(client);
  const hasRpcEndpoint =
    client !== null &&
    (activeHost === undefined ||
      (activeHost !== null && activeHost.websocketUrl !== null));
  return [
    activeHostIdForCompatibility(client) ?? "",
    requestContextUserIdForCompatibility(client) ?? "",
    hasRpcEndpoint ? "1" : "",
  ].join(SNAPSHOT_SEPARATOR);
}

function activeHostForCompatibility<Registry extends VersionedRpcRegistry>(
  client: HostRequester<Registry> | null,
): HostDirectoryEntry | null | undefined {
  const legacyCompatibleClient: {
    readonly getActiveHost?: () => HostDirectoryEntry | null;
  } | null = client;
  return legacyCompatibleClient?.getActiveHost?.();
}

function activeHostIdForCompatibility<Registry extends VersionedRpcRegistry>(
  client: HostRequester<Registry> | null,
): string | null | undefined {
  const legacyCompatibleClient: {
    readonly getActiveHostId?: () => string | null;
  } | null = client;
  return legacyCompatibleClient?.getActiveHostId?.();
}

function requestContextUserIdForCompatibility<
  Registry extends VersionedRpcRegistry,
>(client: HostRequester<Registry> | null): string | null | undefined {
  const legacyCompatibleClient: {
    readonly getRequestContextUserId?: () => string | null;
  } | null = client;
  return legacyCompatibleClient?.getRequestContextUserId?.();
}

function parseHostReadinessSnapshot(snapshot: string): ReactiveHostReadiness {
  const firstSeparatorIndex = snapshot.indexOf(SNAPSHOT_SEPARATOR);
  const secondSeparatorIndex = snapshot.indexOf(
    SNAPSHOT_SEPARATOR,
    firstSeparatorIndex + SNAPSHOT_SEPARATOR.length,
  );
  const hostId = normalizeSnapshotPart(snapshot.slice(0, firstSeparatorIndex));
  const requestContextUserId = normalizeSnapshotPart(
    snapshot.slice(
      firstSeparatorIndex + SNAPSHOT_SEPARATOR.length,
      secondSeparatorIndex,
    ),
  );
  const hasRpcEndpoint =
    snapshot.slice(secondSeparatorIndex + SNAPSHOT_SEPARATOR.length) === "1";
  const isReady = hostId !== null && requestContextUserId !== null;
  return {
    hostId,
    requestContextUserId,
    isReady,
    hasRpcEndpoint,
    canExecute: isReady && hasRpcEndpoint,
  };
}

function normalizeSnapshotPart(value: string): string | null {
  if (value.length === 0) {
    return null;
  }
  return value;
}
