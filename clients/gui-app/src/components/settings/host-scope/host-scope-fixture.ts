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
    planRestricted: false,
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

/**
 * NOTE ON THE DEFAULT SHAPE: `status: "following"` with `client: null` is not a
 * state production can reach — `following` means the ambient client IS the
 * scoped host's, so it is never null there. It is the default here because
 * panel suites mock their own host hooks and never read `scope.client`, so
 * supplying a real `HostClient` would be ceremony with no assertion behind it.
 *
 * The consequence is that NO panel suite proves the status/client pairing.
 * That pairing is the safety contract, so it is covered where it is actually
 * derived — see `__tests__/use-host-scope-status.test.ts` — rather than being
 * implied by a fixture that cannot fail.
 */
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
    // The default status FOLLOWS the host rather than being pinned. Pinning it
    // to "following" meant `host: null` produced a scope claiming to follow a
    // host that does not exist — a state production cannot reach — and panels
    // tested against it took branches they never take in the app.
    status: host === null ? "unreachable" : "following",
    client: null,
    setHostId: () => undefined,
    makeActive: () => undefined,
    isLoading: false,
    listsFailed: false,
    retryLists: () => undefined,
    nowMs: 0,
    ...overrides,
  };
}
