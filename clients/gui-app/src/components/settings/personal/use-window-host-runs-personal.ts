import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { hostRunsPersonal } from "@/components/settings/environment/environment-picker-model";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useHostLease } from "@/hooks/host/use-host-lease";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { isLocalHostBootingEntry } from "@/lib/host/transport-key";

export type WindowHostPersonalAnswer =
  | { readonly runs: boolean }
  | { readonly runs: null; readonly retryStatus: (() => void) | null };

const UNKNOWN = { runs: null, retryStatus: null } as const;
const CLOUD = { runs: false } as const;

function hostRoutePending(
  scope: HostScope,
  lease: HostLeaseSnapshot | null,
): boolean {
  return (
    lease?.status === "restarting-expected" ||
    isLocalHostBootingEntry(scope.host?.entry ?? null) ||
    scope.unresolvedDirectoryRoute === "pending" ||
    scope.unresolvedDirectoryRoute === "failed"
  );
}

/**
 * The window's host decides whether it runs Personal. Wait for its route and
 * first status answer before opening an editor. A host known to be away, or
 * whose handshake lacks the method, uses Personal in the cloud.
 */
export function useWindowHostRunsPersonal(
  scope: HostScope,
): WindowHostPersonalAnswer {
  const status = useEnvironmentStatusRead(scope.client, scope.hostId, true);
  const version = useHostNegotiatedMethodVersion(
    scope.client,
    "environment.status",
  );
  const lease = useHostLease(scope.hostId);
  if (scope.hostId === null) {
    // A list that has not answered can still supply the window's host.
    return scope.isLoading || scope.status === "connecting" || scope.listsFailed
      ? UNKNOWN
      : CLOUD;
  }
  // The registry's Offline label can outlast the return of a dialable route.
  // Only the selection authority can confirm that a dialable host is away.
  if (lease?.status === "dead" && lease.dead.reason === "offline") {
    return CLOUD;
  }
  if (hostRoutePending(scope, lease)) return UNKNOWN;
  if (
    scope.status === "unreachable" ||
    scope.status === "vanished" ||
    version === false
  ) {
    return CLOUD;
  }
  if (version === null) return UNKNOWN;
  if (status.data === null) {
    return status.isError ? { runs: null, retryStatus: status.retry } : UNKNOWN;
  }
  return {
    runs: hostRunsPersonal(
      { hostId: scope.hostId, name: scope.hostLabel },
      status.data,
      version,
    ),
  };
}
