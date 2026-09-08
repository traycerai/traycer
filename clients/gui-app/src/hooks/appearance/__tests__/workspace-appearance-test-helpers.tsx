import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup } from "@testing-library/react";
import { afterEach, vi, type Mock } from "vitest";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import type {
  WorkspaceAppearanceRead,
  WorkspaceGetAppearanceResponse,
} from "@traycer/protocol/host/workspace/appearance-schemas";

/**
 * A real `HostClient`/`MockHostMessenger` (see `use-host-query.test.tsx`) buys
 * version negotiation this suite doesn't need - `useWorkspaceAppearance`'s own
 * contract is entirely inside `mapResponse`/`onMutate`/`onSuccess`, which only
 * need SOME object shaped like `HostRequester` (a `requestWithSignal` for
 * queries, a `request` for mutations - `useHostMutation` dispatches through
 * `client.request`, never `requestWithSignal`). Mocking
 * `useHostClientForHostId`/`useReactiveHostReadiness` directly (the pattern
 * `use-git-capabilities-query.test.tsx` already uses for a host-pinned hook)
 * gets there with far less fixture weight, while `workspace.getAppearance` /
 * `workspace.setAppearance` capability gating still runs for real against the
 * negotiated-manifest registry (`recordNegotiatedHostMethods`).
 *
 * Two fixed per-host clients (not a dynamic map) so a test needing two
 * independent hosts just uses both literal ids; every single-host test uses
 * "host-a".
 */
type RequestWithSignalMock = Mock<
  (method: string, params: unknown, signal: AbortSignal) => unknown
>;
type RequestMock = Mock<(method: string, params: unknown) => unknown>;
interface MockClient {
  readonly hostId: string;
  readonly requestWithSignal: RequestWithSignalMock;
  readonly request: RequestMock;
}
const clientA = vi.hoisted(() => ({
  hostId: "host-a",
  requestWithSignal:
    vi.fn<(method: string, params: unknown, signal: AbortSignal) => unknown>(),
  request: vi.fn<(method: string, params: unknown) => unknown>(),
}));
const clientB = vi.hoisted(() => ({
  hostId: "host-b",
  requestWithSignal:
    vi.fn<(method: string, params: unknown, signal: AbortSignal) => unknown>(),
  request: vi.fn<(method: string, params: unknown) => unknown>(),
}));
export { clientA, clientB };

function resetClient(client: MockClient): void {
  client.requestWithSignal.mockReset();
  client.request.mockReset();
}

function clientForHostId(hostId: string | null): MockClient | null {
  if (hostId === null) return null;
  if (hostId === "host-b") return clientB;
  return clientA;
}
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => clientForHostId(hostId),
}));
vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: { hostId: string } | null) => ({
    hostId: client?.hostId ?? null,
    isReady: client !== null,
    hasRpcEndpoint: client !== null,
    canExecute: client !== null,
  }),
}));

type HooksModule = typeof import("../use-workspace-appearance");
type AuthModule = typeof import("@/stores/auth/auth-store");
type CacheModule = typeof import("@/lib/appearance/appearance-cache");
type ManifestModule =
  typeof import("@traycer-clients/shared/host-transport/negotiated-manifest-registry");
type PendingSeedsModule =
  typeof import("@/lib/worktree/pending-epic-create-seeds");

/**
 * `appearance-cache.ts` opens its IndexedDB store and subscribes to the auth
 * store once, at import time (see `appearance-cache.test.ts`), and
 * `useWorkspaceAppearance` closes over BOTH via a static import - so every
 * test needs a fresh `indexedDB` and a fresh dynamic import of the whole
 * chain, exactly like `use-appearance-assets.test.tsx`.
 *
 * The negotiated-manifest registry and the pending-epic-create-seed map are
 * ALSO closed over by the hook file via its own top-of-file imports, so a
 * `vi.resetModules()` here gives the freshly re-imported hook module a
 * DIFFERENT instance of both than a statically-imported top-level binding in
 * this test file would see. Import them dynamically too, in this same reset
 * window, and route every test's manifest/pending-seed calls through the
 * returned bindings so they act on the exact instance the hook uses.
 */
export async function loadHooks(): Promise<{
  readonly hooks: HooksModule;
  readonly authStore: AuthModule["useAuthStore"];
  readonly cache: CacheModule;
  readonly manifests: ManifestModule;
  readonly pendingSeeds: PendingSeedsModule;
}> {
  vi.resetModules();
  installFreshIndexedDb();
  resetClient(clientA);
  resetClient(clientB);
  const { useAuthStore } = await import("@/stores/auth/auth-store");
  const cache = await import("@/lib/appearance/appearance-cache");
  const manifests =
    await import("@traycer-clients/shared/host-transport/negotiated-manifest-registry");
  const pendingSeeds = await import("@/lib/worktree/pending-epic-create-seeds");
  manifests.resetNegotiatedManifests();
  const hooks = await import("../use-workspace-appearance");
  return { hooks, authStore: useAuthStore, cache, manifests, pendingSeeds };
}

export function signIn(
  authStore: AuthModule["useAuthStore"],
  userId: string,
): void {
  authStore.setState({
    status: "signed-in",
    contextMetadata: { userId, username: userId },
  });
}

export function fullSupport(manifests: ManifestModule, hostId: string): void {
  manifests.recordNegotiatedHostMethods(hostId, [
    "workspace.getAppearance",
    "workspace.setAppearance",
  ]);
}

export function readOnlySupport(
  manifests: ManifestModule,
  hostId: string,
): void {
  manifests.recordNegotiatedHostMethods(hostId, ["workspace.getAppearance"]);
}

export function makeWrapper(): {
  readonly Wrapper: (props: { children: ReactNode }) => ReactNode;
  readonly queryClient: QueryClient;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return { Wrapper, queryClient };
}

export function appearanceRead(
  overrides: Partial<WorkspaceAppearanceRead> & {
    readonly workspacePath: string;
  },
): WorkspaceAppearanceRead {
  return {
    canonicalSourceRoot: "/repo/root",
    status: "present",
    appearance: { version: 1, color: "#112233" },
    issues: [],
    ...overrides,
  };
}

export function getAppearanceResponse(
  reads: readonly WorkspaceAppearanceRead[],
): WorkspaceGetAppearanceResponse {
  return { appearances: [...reads] };
}

export function requireSignal(signal: AbortSignal | null): AbortSignal {
  if (signal === null)
    throw new Error("expected an AbortSignal to have been captured by now");
  return signal;
}

export function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Routes `requestWithSignal` (queries) and `request` (mutations) calls by RPC
 * method onto separate controllable queues - matching `useHostMutation`'s
 * real dispatch through `client.request`, never `requestWithSignal`.
 */
export function routeByMethod(client: MockClient): {
  readonly getAppearance: Mock<
    (params: unknown, signal: AbortSignal) => unknown
  >;
  readonly setAppearance: Mock<(params: unknown) => unknown>;
  readonly listBindings: Mock<
    (params: unknown, signal: AbortSignal) => unknown
  >;
} {
  const getAppearance =
    vi.fn<(params: unknown, signal: AbortSignal) => unknown>();
  const setAppearance = vi.fn<(params: unknown) => unknown>();
  const listBindings =
    vi.fn<(params: unknown, signal: AbortSignal) => unknown>();
  client.requestWithSignal.mockImplementation(
    (method: string, params: unknown, signal: AbortSignal) => {
      if (method === "workspace.getAppearance")
        return getAppearance(params, signal);
      if (method === "worktree.listBindingsForEpic")
        return listBindings(params, signal);
      throw new Error(`unexpected method ${method}`);
    },
  );
  client.request.mockImplementation((method: string, params: unknown) => {
    if (method === "workspace.setAppearance") return setAppearance(params);
    throw new Error(`unexpected method ${method}`);
  });
  return { getAppearance, setAppearance, listBindings };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
