import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

/**
 * A ready `HostScope` for panel tests.
 *
 * Panels depend on the SCOPE, not on the six hooks it composes, so tests mock
 * at that boundary. Reaching through to `useRegisteredHosts` /
 * `useHostDirectoryList` / `useRunnerHost` in every panel suite would couple
 * each of them to the scope's internals and break them all again the next time
 * the scope grows a data source.
 *
 * Lives outside `__tests__/` so suites in sibling directories can import it
 * without reaching into another folder's test-only tree.
 */
export function hostScopeOptionFixture(
  overrides: Partial<HostScopeOption> & { readonly hostId: string },
): HostScopeOption {
  return {
    name: overrides.hostId,
    isLocalMachine: true,
    isActive: true,
    connectable: true,
    registered: true,
    platform: "darwin-arm64",
    version: "1.4.2",
    health: {
      state: "online",
      label: "Online",
      detail: null,
      tone: "live",
      live: true,
      busy: false,
    },
    updateState: "current",
    busySessionCount: 0,
    entry: null,
    item: null,
    ...overrides,
  };
}

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
    status: "following",
    client: null,
    setHostId: () => undefined,
    makeActive: () => undefined,
    isLoading: false,
    nowMs: 0,
    ...overrides,
  };
}
