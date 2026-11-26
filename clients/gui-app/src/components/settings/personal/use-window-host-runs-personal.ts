import { useState } from "react";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { hostRunsPersonal } from "@/components/settings/environment/environment-picker-model";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useHostLease } from "@/hooks/host/use-host-lease";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { isLocalHostBootingEntry } from "@/lib/host/transport-key";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

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
 * A list that has not answered can still supply the window's host, and cannot
 * yet show that a host is gone. With no window host, `connecting` is the
 * scope's "no first answer from the lists yet".
 */
function listsUnsettled(scope: HostScope): boolean {
  return scope.isLoading || scope.status === "connecting" || scope.listsFailed;
}

interface FactHostReading {
  readonly held: string | null;
  readonly factHostId: string | null;
  readonly factHost: HostScopeOption | null;
  readonly lease: HostLeaseSnapshot | null;
  readonly listsSettled: boolean;
}

/**
 * The host that is declared dead with no dialable route since, or null. A
 * connectable route for it or its absence from the settled list outranks a
 * dead lease the authority still holds for it.
 */
function declaredDeadWithNoRoute(reading: FactHostReading): string | null {
  const { held, factHostId, factHost, lease, listsSettled } = reading;
  if (factHostId === null) return null;
  if (factHost?.connectable === true) return null;
  if (factHost === null && listsSettled) return null;
  if (lease?.status === "dead" && lease.dead.reason === "offline") {
    return factHostId;
  }
  if (held !== factHostId || lease?.status === "ready") return null;
  return held;
}

interface WindowHostLeaseRead {
  readonly lease: HostLeaseSnapshot | null;
  readonly heldOnCloud: boolean;
}

/**
 * The window's host lease, and whether that host is held on the cloud since
 * its dead verdict. A dead verdict on the only computer empties the effective
 * host and keeps the target, so with no window host the facts read are the
 * target's own; with one, they are the window host's.
 */
function useWindowHostLease(scope: HostScope): WindowHostLeaseRead {
  const [held, setHeld] = useState<string | null>(null);
  const targetHostId = useSelectionAuthorityStore(
    (state) => state.targetHostId,
  );
  const factHostId = scope.hostId ?? scope.activeHostId ?? targetHostId ?? held;
  const lease = useHostLease(factHostId);
  const declaredDeadHostId = declaredDeadWithNoRoute({
    held,
    factHostId,
    factHost:
      scope.hostId === null
        ? (scope.hosts.find((host) => host.hostId === factHostId) ?? null)
        : scope.host,
    lease,
    listsSettled: !listsUnsettled(scope),
  });
  if (declaredDeadHostId !== held) setHeld(declaredDeadHostId);
  return { lease, heldOnCloud: declaredDeadHostId !== null };
}

/**
 * The window's host decides whether it runs Personal. Wait for its route and
 * first status answer before opening an editor. A host known to be away, or
 * whose handshake lacks the method, uses Personal in the cloud.
 *
 * Once the selection authority declares the window's host dead and offline,
 * that host stays on the cloud until it has a connectable route, the
 * authority's lease for it reads `ready`, the window's host becomes a
 * different host, or the settled host list no longer has it. The authority's
 * next ensure reads as `connecting` again, and without this the page would
 * leave the cloud for that attempt and return to it when the attempt failed.
 * A dead verdict can also leave the window with no host until that ensure
 * names it again, and no host is not a different host.
 */
export function useWindowHostRunsPersonal(
  scope: HostScope,
): WindowHostPersonalAnswer {
  const status = useEnvironmentStatusRead(scope.client, scope.hostId, true);
  const version = useHostNegotiatedMethodVersion(
    scope.client,
    "environment.status",
  );
  const { lease, heldOnCloud } = useWindowHostLease(scope);
  if (heldOnCloud) return CLOUD;
  if (scope.hostId === null) {
    return listsUnsettled(scope) ? UNKNOWN : CLOUD;
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
