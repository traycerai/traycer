import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { HostOptions } from "@/components/settings/host-scope/use-host-options";

/** A helper that defaulted the id would rebuild that blind spot here, one layer down. */
export function hostLeaseFixture(
  hostId: string,
  dead: HostLeaseSnapshot["dead"],
): HostLeaseSnapshot {
  return dead === null
    ? { hostId, status: "ready", dead: null }
    : { hostId, status: "dead", dead };
}

/** Lives outside `__tests__/` so suites in sibling directories can import it without reaching into another
 * folder's test-only tree. */
export function hostScopeOptionFixture(
  overrides: Partial<HostScopeOption> & { readonly hostId: string },
): HostScopeOption {
  return {
    name: overrides.hostId,
    isLocalMachine: true,
    isActive: true,
    connectable: true,
    planRestricted: false,
    settingUp: false,
    registered: true,
    platform: "darwin-arm64",
    version: "1.4.2",
    health: {
      state: "online",
      label: "Online",
      detail: null,
      tone: "live",
      live: true,
    },
    updateState: "current",
    entry: null,
    item: null,
    ...overrides,
  };
}

/** NOTE ON the default shape: `status: "following"` with `client: null` is not a */
export function hostScopeFixture(overrides: Partial<HostScope>): HostScope {
  const host =
    overrides.host === undefined
      ? hostScopeOptionFixture({ hostId: "host-a" })
      : overrides.host;
  return {
    hosts: host === null ? [] : [host],
    host,
    hostId: host?.hostId ?? null,
    hostLabel: host?.name ?? "No host",
    vanishedHostId: null,
    returnToActive: () => undefined,
    activeHostId: host?.hostId ?? null,
    activeHost: host,
    isViewingActive: true,
    // Pinning it to "following" meant `host: null` produced a scope claiming to follow a host that does not exist
    // - a state production cannot reach - and panels tested against it took branches they never take in the app.
    status: host === null ? "unreachable" : "following",
    client: null,
    // False by default for the same reason `client` is null: a suite about the fallback lane must say so
    // explicitly, and every other suite keeps the plain-RPC branches production takes on a current host.
    localMaintenanceFallback: false,
    setHostId: () => undefined,
    makeActive: () => undefined,
    isActivating: false,
    isLoading: false,
    listsFailed: false,
    retryLists: () => undefined,
    nowMs: 0,
    ...overrides,
  };
}

/** A suite whose subject IS the merge belongs in `host-scope-model`'s tests, where the real builder runs. */
export function hostOptionsFixture(
  overrides: Partial<HostOptions>,
): HostOptions {
  const hosts = overrides.hosts ?? [
    hostScopeOptionFixture({ hostId: "host-a" }),
  ];
  return {
    hosts,
    activeHostId: hosts[0]?.hostId ?? null,
    isLoading: false,
    directoryResolved: true,
    directoryFailed: false,
    listsResolved: true,
    listsFailed: false,
    retryLists: () => undefined,
    nowMs: 0,
    ...overrides,
  };
}
