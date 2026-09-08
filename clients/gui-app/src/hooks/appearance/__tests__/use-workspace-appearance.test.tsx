import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import type {
  WorkspaceAppearanceRead,
  WorkspaceGetAppearanceResponse,
  WorkspaceSetAppearanceResponse,
} from "@traycer/protocol/host/workspace/appearance-schemas";
import type { WorktreeListBindingsForEpicResponse } from "@traycer/protocol/host";

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
async function loadHooks(): Promise<{
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

function signIn(authStore: AuthModule["useAuthStore"], userId: string): void {
  authStore.setState({
    status: "signed-in",
    contextMetadata: { userId, username: userId },
  });
}

function fullSupport(manifests: ManifestModule, hostId: string): void {
  manifests.recordNegotiatedHostMethods(hostId, [
    "workspace.getAppearance",
    "workspace.setAppearance",
  ]);
}

function readOnlySupport(manifests: ManifestModule, hostId: string): void {
  manifests.recordNegotiatedHostMethods(hostId, ["workspace.getAppearance"]);
}

function makeWrapper(): {
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

function appearanceRead(
  overrides: Partial<WorkspaceAppearanceRead> & {
    readonly workspacePath: string;
  },
): WorkspaceAppearanceRead {
  return {
    canonicalSourceRoot: "/repo/root",
    status: "present",
    revision: "rev-1",
    appearance: { version: 1, color: "#112233" },
    issues: [],
    ...overrides,
  };
}

function getAppearanceResponse(
  reads: readonly WorkspaceAppearanceRead[],
): WorkspaceGetAppearanceResponse {
  return { appearances: [...reads] };
}

function requireSignal(signal: AbortSignal | null): AbortSignal {
  if (signal === null)
    throw new Error("expected an AbortSignal to have been captured by now");
  return signal;
}

function deferred<T>(): {
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
function routeByMethod(client: MockClient): {
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

describe("useWorkspaceAppearance: independent drafts and late results", () => {
  it("keeps two independently-hosted drafts from ever cross-resolving into each other's slot", async () => {
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    fullSupport(manifests, "host-b");
    const routeA = routeByMethod(clientA);
    const routeB = routeByMethod(clientB);
    const { Wrapper } = makeWrapper();
    const draftA = deferred<WorkspaceGetAppearanceResponse>();
    const draftB = deferred<WorkspaceGetAppearanceResponse>();
    routeA.getAppearance.mockReturnValue(draftA.promise);
    routeB.getAppearance.mockReturnValue(draftB.promise);

    const a = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/draft-a",
        }),
      { wrapper: Wrapper },
    );
    const b = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-b",
          workspacePath: "/draft-b",
        }),
      { wrapper: Wrapper },
    );

    // Resolve B first, then A - later arrival must never land in the other's slot.
    act(() => {
      draftB.resolve(
        getAppearanceResponse([
          appearanceRead({
            workspacePath: "/draft-b",
            canonicalSourceRoot: "/repo/b",
          }),
        ]),
      );
    });
    await waitFor(() => expect(b.result.current.query.isSuccess).toBe(true));
    act(() => {
      draftA.resolve(
        getAppearanceResponse([
          appearanceRead({
            workspacePath: "/draft-a",
            canonicalSourceRoot: "/repo/a",
          }),
        ]),
      );
    });
    await waitFor(() => expect(a.result.current.query.isSuccess).toBe(true));

    expect(a.result.current.appearance?.canonicalSourceRoot).toBe("/repo/a");
    expect(b.result.current.appearance?.canonicalSourceRoot).toBe("/repo/b");
  });

  it("discards a late result that resolves after the signed-in account has changed", async () => {
    // `cacheKeyIdentity: [accountId]` makes account switch spin up a
    // genuinely SEPARATE query, not just re-run the same one - so the old and
    // new account's GETs must be two independent, separately controlled
    // responses. Sharing one `mockReturnValue(...)` promise between them
    // would let the new account's own legitimate dispatch "borrow" the old
    // one's resolution, which proves nothing about isolation.
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    const { Wrapper } = makeWrapper();
    const oldReached = deferred<void>();
    const oldPending = deferred<WorkspaceGetAppearanceResponse>();
    route.getAppearance.mockImplementationOnce(() => {
      oldReached.resolve();
      return oldPending.promise;
    });
    route.getAppearance.mockResolvedValue(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          canonicalSourceRoot: "/repo/acct-2",
          appearance: { version: 1, color: "#aaaaaa" },
        }),
      ]),
    );

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );

    // Proof the OLD account's GET genuinely reached dispatch before the
    // account switch, rather than assuming an interleaving.
    await oldReached.promise;
    signIn(authStore, "acct-2");

    // The new account's own query settles independently, from its own
    // separately-mocked response.
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.appearance?.appearance).toEqual({
      version: 1,
      color: "#aaaaaa",
    });

    // The stale (old-account) GET resolves only now, late - it must never
    // retroactively land in the CURRENT (acct-2) slot.
    act(() => {
      oldPending.resolve(
        getAppearanceResponse([
          appearanceRead({
            workspacePath: "/repo",
            canonicalSourceRoot: "/repo/acct-1-stale",
            appearance: { version: 1, color: "#111111" },
          }),
        ]),
      );
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current.appearance?.appearance).toEqual({
      version: 1,
      color: "#aaaaaa",
    });
  });
});

describe("useWorkspaceAppearance: canEdit (partial vs whole malformed)", () => {
  it("allows editing a 'malformed' read that still carries a salvageable partial appearance", async () => {
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    route.getAppearance.mockResolvedValue(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          status: "malformed",
          appearance: { version: 1, color: "#112233" },
          issues: ["icon"],
        }),
      ]),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.canEdit).toBe(true);
  });

  it("refuses editing a totally malformed read with no salvageable appearance, even though a cached snapshot fills the display", async () => {
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    route.getAppearance.mockResolvedValue(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          status: "malformed",
          appearance: null,
          issues: ["appearance.json is not valid JSON"],
        }),
      ]),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.canEdit).toBe(false);
  });

  it("refuses editing when the host never advertised the write method, regardless of read state", async () => {
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    readOnlySupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    route.getAppearance.mockResolvedValue(
      getAppearanceResponse([appearanceRead({ workspacePath: "/repo" })]),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.canEdit).toBe(false);
  });
});

describe("useWorkspaceAppearance: canonical-null unavailable retains the previous read", () => {
  it("falls back to the previously known canonical root and appearance when a later read goes 'unavailable' with no root of its own", async () => {
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    route.getAppearance.mockResolvedValueOnce(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          canonicalSourceRoot: "/repo/root",
          appearance: { version: 1, color: "#445566" },
        }),
      ]),
    );
    const { Wrapper, queryClient } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );
    await waitFor(() =>
      expect(result.current.appearance?.canonicalSourceRoot).toBe("/repo/root"),
    );

    route.getAppearance.mockResolvedValueOnce(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          canonicalSourceRoot: null,
          status: "unavailable",
          appearance: null,
        }),
      ]),
    );
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["host"] });
    });

    await waitFor(() =>
      expect(result.current.query.data?.status).toBe("unavailable"),
    );
    expect(result.current.appearance?.canonicalSourceRoot).toBe("/repo/root");
    expect(result.current.appearance?.appearance).toEqual({
      version: 1,
      color: "#445566",
    });
  });
});

describe("useWorkspaceAppearance: assetRefreshKey (bytes can change under an unchanged revision)", () => {
  it("advances assetRefreshKey on every successful response, even a byte-for-byte identical refetch", async () => {
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    const identicalRead = appearanceRead({
      workspacePath: "/repo",
      canonicalSourceRoot: "/repo/root",
    });
    route.getAppearance.mockResolvedValue(
      getAppearanceResponse([identicalRead]),
    );
    const { Wrapper, queryClient } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    const firstKey = result.current.assetRefreshKey;

    // Same host config revision, same edited-image path - `worktree.changed`
    // can legitimately trigger this refetch for bytes alone, so the asset
    // consumer must get a fresh re-stat signal even though nothing else in
    // the read differs from last time.
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["host"] });
    });

    await waitFor(() =>
      expect(result.current.assetRefreshKey).not.toBe(firstKey),
    );
    // The read content itself is genuinely unchanged.
    expect(result.current.appearance?.appearance).toEqual(
      identicalRead.appearance,
    );
  });
});

describe("useWorkspaceAppearance: canonical fallback via a fresh disk read", () => {
  it("hydrates from a persisted snapshot under the resolved canonical root the FIRST time this workspacePath is ever seen", async () => {
    // No `writeAppearanceSource` for "/repo" has ever run for this workspace
    // path - the ONLY reason a snapshot for "/repo/root" exists on disk is a
    // different alias (or an earlier session) having written it. There is
    // therefore no in-memory `previousRead`/`fallback.data` to hand
    // `mergeAppearanceRead` - only the new disk read introduced by this fix
    // can find it.
    const { hooks, cache, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    await cache.writeAppearanceSnapshot(
      {
        accountId: "acct-1",
        hostId: "host-a",
        canonicalSourceRoot: "/repo/root",
      },
      appearanceRead({
        workspacePath: "/some-other-alias",
        canonicalSourceRoot: "/repo/root",
        appearance: { version: 1, color: "#334455" },
      }),
    );
    const route = routeByMethod(clientA);
    route.getAppearance.mockResolvedValue(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          canonicalSourceRoot: "/repo/root",
          status: "malformed",
          appearance: null,
          issues: ["appearance.json is not valid JSON"],
        }),
      ]),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.appearance?.appearance).toEqual({
      version: 1,
      color: "#334455",
    });
  });

  it("keeps the disk read scoped to the exact account+host, never bleeding another account's or host's snapshot for the same root string", async () => {
    const { hooks, cache, authStore, manifests } = await loadHooks();
    // Seed the OTHER account's snapshot while THAT account is the one
    // signed in - `writeAppearanceSnapshot` rejects a write for any account
    // other than the currently-signed-in one ("no longer active"), so
    // seeding acct-2's disk state requires being acct-2 at write time. Only
    // then switch to acct-1, the account this test actually renders under.
    signIn(authStore, "acct-2");
    // Same literal canonicalSourceRoot string, but under a DIFFERENT account.
    await cache.writeAppearanceSnapshot(
      {
        accountId: "acct-2",
        hostId: "host-a",
        canonicalSourceRoot: "/repo/root",
      },
      appearanceRead({
        workspacePath: "/other-account-alias",
        canonicalSourceRoot: "/repo/root",
        appearance: { version: 1, color: "#999999" },
      }),
    );
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    route.getAppearance.mockResolvedValue(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          canonicalSourceRoot: "/repo/root",
          status: "unsupported",
          appearance: null,
        }),
      ]),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    // The other account's snapshot must never surface here - nothing was ever
    // written for THIS account+host+root, so the read must come back empty.
    expect(result.current.appearance?.appearance).toBeNull();
  });

  it("discards a canonical disk read that resolves after the query was cancelled - it must never write through", async () => {
    const { hooks, cache, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    route.getAppearance.mockResolvedValue(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          canonicalSourceRoot: "/repo/root",
          status: "malformed",
          appearance: null,
          issues: ["appearance.json is not valid JSON"],
        }),
      ]),
    );
    const diskRead = deferred<WorkspaceAppearanceRead | null>();
    const readSnapshotSpy = vi
      .spyOn(cache, "readAppearanceSnapshot")
      .mockReturnValue(diskRead.promise);
    const writeSnapshotSpy = vi.spyOn(cache, "writeAppearanceSnapshot");
    const { Wrapper, queryClient } = makeWrapper();

    renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(readSnapshotSpy).toHaveBeenCalled());

    await queryClient.cancelQueries({ queryKey: ["host"] });
    act(() => {
      diskRead.resolve(
        appearanceRead({
          workspacePath: "/repo",
          canonicalSourceRoot: "/repo/root",
          appearance: { version: 1, color: "#gotcha0" },
        }),
      );
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(writeSnapshotSpy).not.toHaveBeenCalled();
  });
});

describe("useWorkspaceAppearance: authoritative clears", () => {
  it("clears the appearance on 'absent', overriding a previously cached appearance for the same slot", async () => {
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    route.getAppearance.mockResolvedValueOnce(
      getAppearanceResponse([appearanceRead({ workspacePath: "/repo" })]),
    );
    const { Wrapper, queryClient } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );
    // `result.current.appearance` starts `null`, so `?.appearance` starts
    // `undefined` - asserting merely `.not.toBeNull()` is vacuously true
    // before the first GET ever settles. Wait for the exact seeded value
    // instead, so the refetch below only fires once the FIRST response has
    // genuinely landed (otherwise it can consume the wrong queued mock).
    await waitFor(() =>
      expect(result.current.appearance?.appearance).toEqual({
        version: 1,
        color: "#112233",
      }),
    );

    route.getAppearance.mockResolvedValueOnce(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          status: "absent",
          canonicalSourceRoot: null,
          appearance: null,
        }),
      ]),
    );
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["host"] });
    });

    await waitFor(() =>
      expect(result.current.query.data?.status).toBe("absent"),
    );
    expect(result.current.appearance?.appearance).toBeNull();
  });
});

describe("useWorkspaceAppearance: older host fallback", () => {
  it("serves the locally cached snapshot and reports isFallback when the host never advertised getAppearance", async () => {
    const { hooks, cache, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    // No `recordNegotiatedHostMethods` call at all - readSupport stays `null`
    // (unknown), which the host-query's `enabled` still permits, but for this
    // test we force the KNOWN-absent case (an older host that answered and
    // proved it lacks the method).
    manifests.recordNegotiatedHostMethods("host-a", []);
    const cachedSnapshot = appearanceRead({
      workspacePath: "/repo",
      canonicalSourceRoot: "/repo/root",
      appearance: { version: 1, color: "#998877" },
    });
    await cache.writeAppearanceSource(
      "acct-1",
      "host-a",
      "/repo",
      "/repo/root",
    );
    await cache.writeAppearanceSnapshot(
      {
        accountId: "acct-1",
        hostId: "host-a",
        canonicalSourceRoot: "/repo/root",
      },
      cachedSnapshot,
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.appearance).not.toBeNull());
    expect(result.current.isFallback).toBe(true);
    expect(result.current.appearance?.appearance).toEqual({
      version: 1,
      color: "#998877",
    });
    expect(result.current.canEdit).toBe(false);
    expect(clientA.requestWithSignal).not.toHaveBeenCalledWith(
      "workspace.getAppearance",
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("useEpicAppearance: primary binding selection and the optimistic seed gate", () => {
  it("never queries bindings (or appearance) while the epic's create seed is pending", async () => {
    const { hooks, authStore, manifests, pendingSeeds } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    pendingSeeds.markEpicCreateSeedPending("epic-pending");
    const { Wrapper } = makeWrapper();

    renderHook(
      () =>
        hooks.useEpicAppearance({ hostId: "host-a", epicId: "epic-pending" }),
      { wrapper: Wrapper },
    );
    await Promise.resolve();

    expect(route.listBindings).not.toHaveBeenCalled();
    expect(route.getAppearance).not.toHaveBeenCalled();
  });

  it("resolves through the primary binding row's host+workspacePath once bindings settle", async () => {
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    fullSupport(manifests, "host-b");
    const routeA = routeByMethod(clientA);
    const routeB = routeByMethod(clientB);
    const bindingsResponse: WorktreeListBindingsForEpicResponse = {
      rows: [
        {
          hostId: "host-a",
          runningDir: "/secondary",
          workspacePath: "/secondary",
          worktreePath: null,
          mode: "local",
          isGitRepo: true,
          repoIdentifier: null,
          branch: null,
          isPrimary: false,
          isImported: false,
          setupState: "not_required",
          disabledReason: null,
          sources: [],
        },
        {
          hostId: "host-b",
          runningDir: "/primary",
          workspacePath: "/primary",
          worktreePath: null,
          mode: "local",
          isGitRepo: true,
          repoIdentifier: null,
          branch: null,
          isPrimary: true,
          isImported: false,
          setupState: "not_required",
          disabledReason: null,
          sources: [],
        },
      ],
    };
    routeA.listBindings.mockResolvedValue(bindingsResponse);
    routeB.getAppearance.mockResolvedValue(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/primary",
          canonicalSourceRoot: "/primary",
        }),
      ]),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useEpicAppearance({ hostId: "host-a", epicId: "epic-resolved" }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.appearance).not.toBeNull());
    // The appearance RPC went to the PRIMARY row's host ("host-b"), not the
    // caller's own `hostId` arg ("host-a") - `useEpicAppearance` must resolve
    // through the primary row, never default to the caller's host once a
    // primary is known.
    expect(routeB.getAppearance).toHaveBeenCalledWith(
      { workspacePaths: ["/primary"] },
      expect.anything(),
    );
    expect(routeA.getAppearance).not.toHaveBeenCalled();
  });
});

describe("useWorkspaceSetAppearance: cancellation, write-through, invalidation, conflict", () => {
  it("cancels an outstanding read for the same host, honoring the abort signal, before dispatching the write", async () => {
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    let readSignal: AbortSignal | null = null;
    route.getAppearance.mockImplementationOnce(
      (_params: unknown, signal: AbortSignal) => {
        readSignal = signal;
        return new Promise(() => {
          // never resolves on its own - only cancellation settles it.
        });
      },
    );
    // The mutation's own `onSuccess` issues an `invalidateQueries` refetch at
    // the end - a SECOND never-resolving GET here would make that await hang
    // forever. Only the FIRST (captured above) needs to stay pending.
    route.getAppearance.mockResolvedValue(
      getAppearanceResponse([appearanceRead({ workspacePath: "/repo" })]),
    );
    // Checked from INSIDE the write's own dispatch, not after the whole
    // mutation settles - the final state alone would also pass if only
    // `onSuccess`'s (separate, later) cancel fired, proving nothing about
    // `onMutate` cancelling BEFORE the write is dispatched, which is this
    // test's actual claim.
    let abortedBeforeDispatch = false;
    route.setAppearance.mockImplementation(() => {
      abortedBeforeDispatch = requireSignal(readSignal).aborted;
      return Promise.resolve({
        status: "saved",
        appearance: appearanceRead({ workspacePath: "/repo" }),
      } satisfies WorkspaceSetAppearanceResponse);
    });
    const { Wrapper } = makeWrapper();

    renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(readSignal).not.toBeNull());
    expect(requireSignal(readSignal).aborted).toBe(false);

    const mutation = renderHook(
      () => hooks.useWorkspaceSetAppearance({ hostId: "host-a" }),
      { wrapper: Wrapper },
    );
    await act(async () => {
      await mutation.result.current.mutateAsync({
        epicId: "epic-1",
        workspacePath: "/repo",
        expectedRevision: "rev-1",
        patch: { color: "#000000" },
        uploads: [],
      });
    });

    expect(abortedBeforeDispatch).toBe(true);

    expect(requireSignal(readSignal).aborted).toBe(true);
  });

  it("rejects the mutation up front when no account is signed in, without ever dispatching the RPC", async () => {
    const { hooks, manifests } = await loadHooks();
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    const { Wrapper } = makeWrapper();

    const mutation = renderHook(
      () => hooks.useWorkspaceSetAppearance({ hostId: "host-a" }),
      { wrapper: Wrapper },
    );

    await expect(
      mutation.result.current.mutateAsync({
        epicId: "epic-1",
        workspacePath: "/repo",
        expectedRevision: null,
        patch: { color: "#000000" },
        uploads: [],
      }),
    ).rejects.toThrow(/editing session has ended/);
    expect(route.setAppearance).not.toHaveBeenCalled();
  });

  it("writes the authoritative response through to the appearance cache and invalidates the read on success", async () => {
    const { hooks, cache, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    const saved = appearanceRead({
      workspacePath: "/repo",
      canonicalSourceRoot: "/repo/root",
      appearance: { version: 1, color: "#ABCDEF" },
    });
    route.setAppearance.mockResolvedValue({
      status: "saved",
      appearance: saved,
    } satisfies WorkspaceSetAppearanceResponse);
    const writeSnapshotSpy = vi.spyOn(cache, "writeAppearanceSnapshot");
    const writeSourceSpy = vi.spyOn(cache, "writeAppearanceSource");
    const { Wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const mutation = renderHook(
      () => hooks.useWorkspaceSetAppearance({ hostId: "host-a" }),
      { wrapper: Wrapper },
    );
    await act(async () => {
      await mutation.result.current.mutateAsync({
        epicId: "epic-1",
        workspacePath: "/repo",
        expectedRevision: "rev-1",
        patch: { color: "#ABCDEF" },
        uploads: [],
      });
    });

    expect(writeSnapshotSpy).toHaveBeenCalledWith(
      {
        accountId: "acct-1",
        hostId: "host-a",
        canonicalSourceRoot: "/repo/root",
      },
      expect.objectContaining({ appearance: saved.appearance }),
    );
    expect(writeSourceSpy).toHaveBeenCalledWith(
      "acct-1",
      "host-a",
      "/repo",
      "/repo/root",
    );
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it("re-cancels a GET that was launched AFTER onMutate, so its late (stale) delivery can't resurrect data over the save", async () => {
    // A second GET can start after onMutate's own cancel, while the SET is
    // still pending - onSuccess must re-cancel it too before publishing the
    // clear, or its late response could resurrect stale data. Every step is
    // proven by a barrier resolved from inside the mock that reaches it,
    // never by an assumed interleaving; every async act() below is awaited
    // immediately, never left dangling.
    const { hooks, cache, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    route.getAppearance.mockResolvedValueOnce(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          canonicalSourceRoot: "/repo/root",
          appearance: { version: 1, color: "#111111" },
        }),
      ]),
    );
    // The mutation's own `onSuccess` issues an `invalidateQueries` refetch at
    // the end - simulate it landing while offline, so the only way the
    // asserted clear can be real is if it was actually persisted before this
    // point, not merely resurfaced by a convenient successful reconcile.
    route.getAppearance.mockRejectedValue(new Error("host unreachable"));
    const { Wrapper, queryClient } = makeWrapper();

    const query = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );
    await waitFor(() =>
      expect(query.result.current.appearance?.appearance).toEqual({
        version: 1,
        color: "#111111",
      }),
    );

    const reached = deferred<void>();
    const setReached = deferred<WorkspaceSetAppearanceResponse>();
    route.setAppearance.mockImplementationOnce(() => {
      reached.resolve();
      return setReached.promise;
    });
    const staleGet = deferred<WorkspaceGetAppearanceResponse>();
    let staleGetSignal: AbortSignal | null = null;
    route.getAppearance.mockImplementationOnce(
      (_params: unknown, signal: AbortSignal) => {
        staleGetSignal = signal;
        return staleGet.promise;
      },
    );
    const writeReached = deferred<void>();
    const writeRelease = deferred<void>();
    const realWriteAppearanceSnapshot = cache.writeAppearanceSnapshot;
    const writeSnapshotSpy = vi
      .spyOn(cache, "writeAppearanceSnapshot")
      .mockImplementation(async (scope, read) => {
        writeReached.resolve();
        await writeRelease.promise;
        return realWriteAppearanceSnapshot(scope, read);
      });

    const mutation = renderHook(
      () => hooks.useWorkspaceSetAppearance({ hostId: "host-a" }),
      { wrapper: Wrapper },
    );
    let mutatePromise!: Promise<WorkspaceSetAppearanceResponse>;
    // Bounded, immediately-awaited: kicks the mutation off and waits only
    // for the SET's own dispatch to be reached - not the whole mutation.
    await act(async () => {
      mutatePromise = mutation.result.current.mutateAsync({
        epicId: "epic-1",
        workspacePath: "/repo",
        expectedRevision: "rev-1",
        patch: { color: "#000000" },
        uploads: [],
      });
      await reached.promise;
    });

    // Second GET starts AFTER onMutate's own cancel already ran, while the
    // save's RPC is still pending. Fire-and-forget (sync act, no thenable
    // returned): this refetch's own promise won't settle until `staleGet`
    // resolves later, so it must not be awaited here.
    act(() => {
      void queryClient.refetchQueries({ queryKey: ["host"] });
    });
    await waitFor(() => expect(staleGetSignal).not.toBeNull());
    expect(requireSignal(staleGetSignal).aborted).toBe(false);

    // Resolve the save with an authoritative CLEAR, and wait for onSuccess's
    // write-through to actually be reached - bounded and immediately awaited.
    await act(async () => {
      setReached.resolve({
        status: "saved",
        appearance: appearanceRead({
          workspacePath: "/repo",
          canonicalSourceRoot: "/repo/root",
          status: "absent",
          appearance: null,
        }),
      });
      await writeReached.promise;
    });

    expect(requireSignal(staleGetSignal).aborted).toBe(true);
    // `setQueryData` is synchronous, but TanStack's `notifyManager` delivers
    // subscriber updates asynchronously - wait for the exact visible clear
    // rather than reading `result.current` immediately after resolving.
    await waitFor(() =>
      expect(query.result.current.appearance?.appearance).toBeNull(),
    );

    // Deliver the stale GET's old (pre-save) response WHILE the write-through
    // is STILL held open (persistence stays blocked) - it must not resurrect
    // the pre-clear appearance. Bounded, immediately-awaited act.
    await act(async () => {
      staleGet.resolve(
        getAppearanceResponse([
          appearanceRead({
            workspacePath: "/repo",
            canonicalSourceRoot: "/repo/root",
            appearance: { version: 1, color: "#111111" },
          }),
        ]),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(query.result.current.appearance?.appearance).toBeNull();

    // Only now release the write-through - it runs for real against the fake
    // IndexedDB. The mutation's own reconcile refetch (mocked offline above)
    // then fails, so the only way the clear can still be provable afterward
    // is if it was genuinely persisted here, not merely re-served by a
    // convenient successful GET.
    await act(async () => {
      writeRelease.resolve();
      await mutatePromise;
    });

    expect(writeSnapshotSpy).toHaveBeenCalledWith(
      {
        accountId: "acct-1",
        hostId: "host-a",
        canonicalSourceRoot: "/repo/root",
      },
      expect.objectContaining({ appearance: null }),
    );
    const persisted = await cache.readAppearanceSnapshot({
      accountId: "acct-1",
      hostId: "host-a",
      canonicalSourceRoot: "/repo/root",
    });
    expect(persisted?.appearance).toBeNull();
    expect(query.result.current.appearance?.appearance).toBeNull();
  });

  it("still writes the conflicting authoritative state through on a 'conflict' response, but uploads no blobs", async () => {
    const { hooks, cache, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    const authoritative = appearanceRead({
      workspacePath: "/repo",
      canonicalSourceRoot: "/repo/root",
      appearance: { version: 1, color: "#fedcba" },
    });
    route.setAppearance.mockResolvedValue({
      status: "conflict",
      appearance: authoritative,
    } satisfies WorkspaceSetAppearanceResponse);
    const writeSnapshotSpy = vi.spyOn(cache, "writeAppearanceSnapshot");
    const writeBlobSpy = vi.spyOn(cache, "writeAppearanceBlob");
    const { Wrapper } = makeWrapper();

    const mutation = renderHook(
      () => hooks.useWorkspaceSetAppearance({ hostId: "host-a" }),
      { wrapper: Wrapper },
    );
    const response = await act(async () =>
      mutation.result.current.mutateAsync({
        epicId: "epic-1",
        workspacePath: "/repo",
        expectedRevision: "stale-rev",
        patch: { color: "#000000" },
        uploads: [
          { target: "icon", mediaType: "image/png", dataBase64: "AAAA" },
        ],
      }),
    );

    expect(response.status).toBe("conflict");
    expect(writeSnapshotSpy).toHaveBeenCalledWith(
      {
        accountId: "acct-1",
        hostId: "host-a",
        canonicalSourceRoot: "/repo/root",
      },
      expect.objectContaining({ appearance: authoritative.appearance }),
    );
    expect(writeBlobSpy).not.toHaveBeenCalled();
  });
});
