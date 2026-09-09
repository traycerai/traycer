/**
 * Integrated regression for the creation-seed -> stamped-host handoff.
 * `useHeaderTabAppearance`'s epic source, `useEpicAppearanceSource`'s real
 * binding-cache lookup, and `useWorkspaceAppearance`'s real RPC/cache layer
 * all run for real - only the host transport (2 clients) is faked, the same
 * harness `use-workspace-appearance.test.tsx` uses. Every participating
 * store/registry/hook is imported dynamically AFTER `vi.resetModules()` and
 * reused for the whole test (render + cleanup), so nothing here can silently
 * read a pre-reset module instance the SUT doesn't see.
 *
 * The seed window is the ACTUAL create boundary
 * (`markEpicCreateSeedPending`/`pending-epic-create-seeds.ts`), not a
 * generic binding fetch: while an epic's create is pending, its binding
 * query is disabled outright and only ever serves the landing flow's own
 * optimistic seed already sitting in the query cache - it must never reach
 * the network. Repointing to a real session clears that pending flag (as
 * the real create flow does once the session lands) before the real host's
 * binding fetch is allowed to run.
 */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import { hostQueryKeys } from "@/lib/query-keys";
import type { WorkspaceGetAppearanceResponse } from "@traycer/protocol/host/workspace/appearance-schemas";
import type { WorktreeListBindingsForEpicResponse } from "@traycer/protocol/host";
import type { HeaderTab } from "@/stores/tabs/types";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import type { OpenedStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";

// Type-only, so `vi.resetModules()` cannot make this stale - erased at
// compile time, never touches the runtime module registry. The factory
// itself is inert (no closures over resettable module state), so sharing one
// instance across dynamically-reloaded participants is safe.
const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

interface MockClient {
  readonly hostId: string;
  readonly requestWithSignal: Mock<
    (method: string, params: unknown, signal: AbortSignal) => unknown
  >;
  readonly request: Mock<(method: string, params: unknown) => unknown>;
}
const clientSeed = vi.hoisted(() => ({
  hostId: "host-seed",
  requestWithSignal:
    vi.fn<(method: string, params: unknown, signal: AbortSignal) => unknown>(),
  request: vi.fn<(method: string, params: unknown) => unknown>(),
}));
const clientReal = vi.hoisted(() => ({
  hostId: "host-real",
  requestWithSignal:
    vi.fn<(method: string, params: unknown, signal: AbortSignal) => unknown>(),
  request: vi.fn<(method: string, params: unknown) => unknown>(),
}));
function clientForHostId(hostId: string | null): MockClient | null {
  if (hostId === "host-seed") return clientSeed;
  if (hostId === "host-real") return clientReal;
  return null;
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
vi.mock("@/hooks/appearance/use-landing-draft-appearance", () => ({
  useLandingDraftAppearanceSource: () => ({
    hostId: null,
    folders: [],
    primaryPath: null,
  }),
}));

/** `hostId` only exists on the "epic" member of the `HeaderTab` union. */
function readEpicHost(tab: HeaderTab | null): string | null {
  if (tab === null || tab.kind !== "epic") {
    throw new Error("expected an epic tab");
  }
  return tab.hostId;
}

/** `repositoryIdentity` only exists on the "epic"/"draft" members of the `HeaderTab` union. */
function readRepositoryColor(tab: HeaderTab | null | undefined): string | null {
  if (
    tab === null ||
    tab === undefined ||
    (tab.kind !== "epic" && tab.kind !== "draft")
  ) {
    return null;
  }
  return tab.repositoryIdentity?.color ?? null;
}

function resetClient(client: MockClient): void {
  client.requestWithSignal.mockReset();
  client.request.mockReset();
}

function routeByMethod(client: MockClient) {
  const getAppearance =
    vi.fn<(params: unknown, signal: AbortSignal) => unknown>();
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
  return { getAppearance, listBindings };
}

function bindingsResponse(
  hostId: string,
  workspacePath: string,
): WorktreeListBindingsForEpicResponse {
  return {
    rows: [
      {
        hostId,
        runningDir: workspacePath,
        workspacePath,
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
}

function appearanceResponse(
  workspacePath: string,
  color: string,
): WorkspaceGetAppearanceResponse {
  return {
    appearance: {
      workspacePath,
      canonicalSourceRoot: workspacePath,
      status: "present",
      appearance: { version: 1, color },
      invalidFields: [],
      messages: [],
    },
  };
}

function makeWrapper(
  queryClient: QueryClient,
): (props: { children: ReactNode }) => ReactNode {
  return (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

/**
 * Every module that participates in the render (stores, registry, the test
 * runtime-worker harness, and the hooks under test) is loaded fresh, right
 * after `vi.resetModules()`, and returned as one bundle - the test and its
 * own cleanup both operate on these same instances, never a pre-reset
 * static binding.
 */
interface Participants {
  readonly sessionCreated: typeof import("@/lib/epics/session-created-epics");
  readonly createSeeds: typeof import("@/lib/worktree/pending-epic-create-seeds");
  readonly registry: typeof import("@/lib/registries/epic-session-registry");
  readonly canvas: typeof import("@/stores/epics/canvas/store");
  readonly tabsStore: typeof import("@/stores/tabs/store");
  readonly landingDraftStore: typeof import("@/stores/home/landing-draft-store");
  readonly openStoreForTestModule: typeof import("@/stores/epics/open-epic/test-support/open-store-for-test");
  readonly headerTabs: typeof import("@/stores/tabs/use-header-tabs");
  readonly appearanceHook: typeof import("../use-header-tab-appearance");
}

async function loadParticipants(): Promise<Participants> {
  vi.resetModules();
  installFreshIndexedDb();
  resetClient(clientSeed);
  resetClient(clientReal);
  const { useAuthStore } = await import("@/stores/auth/auth-store");
  const manifests =
    await import("@traycer-clients/shared/host-transport/negotiated-manifest-registry");
  manifests.resetNegotiatedManifests();
  manifests.recordNegotiatedHostMethods("host-seed", [
    "workspace.getAppearance",
    "worktree.listBindingsForEpic",
  ]);
  manifests.recordNegotiatedHostMethods("host-real", [
    "workspace.getAppearance",
    "worktree.listBindingsForEpic",
  ]);
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "acct-1", username: "acct-1" },
  });
  const sessionCreated = await import("@/lib/epics/session-created-epics");
  const createSeeds = await import("@/lib/worktree/pending-epic-create-seeds");
  const registry = await import("@/lib/registries/epic-session-registry");
  const canvas = await import("@/stores/epics/canvas/store");
  const tabsStore = await import("@/stores/tabs/store");
  const landingDraftStore = await import("@/stores/home/landing-draft-store");
  const openStoreForTestModule =
    await import("@/stores/epics/open-epic/test-support/open-store-for-test");
  const headerTabs = await import("@/stores/tabs/use-header-tabs");
  const appearanceHook = await import("../use-header-tab-appearance");
  return {
    sessionCreated,
    createSeeds,
    registry,
    canvas,
    tabsStore,
    landingDraftStore,
    openStoreForTestModule,
    headerTabs,
    appearanceHook,
  };
}

function resetStores(p: Participants): void {
  p.tabsStore.useTabsStore.setState(
    p.tabsStore.useTabsStore.getInitialState(),
    true,
  );
  p.canvas.useEpicCanvasStore.setState(
    p.canvas.useEpicCanvasStore.getInitialState(),
    true,
  );
  p.landingDraftStore.useLandingDraftStore.setState(
    p.landingDraftStore.useLandingDraftStore.getInitialState(),
    true,
  );
  p.registry.getOpenEpicRegistry().disposeAll();
}

function buildHandle(p: Participants, epicId: string): OpenedStoreForTest {
  return p.openStoreForTestModule.openStoreForTest({
    epicId,
    userId: null,
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
}

let live: Participants | null = null;

afterEach(() => {
  cleanup();
  if (live !== null) resetStores(live);
  live = null;
  vi.clearAllMocks();
});

describe("useHeaderTabAppearance + useHeaderTabForRef: creation seed to session-stamped host, real chain", () => {
  it("serves only the landing flow's own optimistic binding seed (no network) while create is pending, then switches to the repointed host's own real binding+appearance once the seed is cleared", async () => {
    const p = await loadParticipants();
    live = p;
    const epicId = "epic-continuity";
    const tabId = p.canvas.useEpicCanvasStore
      .getState()
      .openEpicTab(epicId, "Continuity");
    p.sessionCreated.markEpicCreatedThisSession(epicId, "host-seed");
    p.createSeeds.markEpicCreateSeedPending(epicId);

    const seedRoute = routeByMethod(clientSeed);
    seedRoute.getAppearance.mockResolvedValue(
      appearanceResponse("/repo-seed", "#111111"),
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    // The landing flow's own optimistic seed, pre-populated before this
    // component ever mounts - the exact cache slot `useHostQuery` reads for
    // {hostId: "host-seed", method: "worktree.listBindingsForEpic", params: {epicId}}.
    queryClient.setQueryData(
      hostQueryKeys.method("host-seed", "worktree.listBindingsForEpic", {
        epicId,
      }),
      bindingsResponse("host-seed", "/repo-seed"),
    );

    const { result, rerender } = renderHook(
      () => {
        const tab = p.headerTabs.useHeaderTabForRef({
          kind: "epic",
          id: tabId,
        });
        return p.appearanceHook.useHeaderTabAppearance(tab);
      },
      { wrapper: makeWrapper(queryClient) },
    );

    expect(readEpicHost(result.current)).toBeNull();
    await waitFor(() =>
      expect(readRepositoryColor(result.current)).toBe("#111111"),
    );
    // The binding query served the pre-seeded cache entry alone - it is
    // DISABLED while create-seed pending, so it must never hit the network,
    // even though a resolved color came out the other side.
    expect(seedRoute.listBindings).not.toHaveBeenCalled();

    const handle = buildHandle(p, epicId);
    p.registry.handleHostIds.set(handle, "host-real");
    const realRoute = routeByMethod(clientReal);
    realRoute.listBindings.mockResolvedValue(
      bindingsResponse("host-real", "/repo-real"),
    );
    realRoute.getAppearance.mockResolvedValue(
      appearanceResponse("/repo-real", "#222222"),
    );
    act(() => {
      // Mirrors the real create flow: the session landing on a real host is
      // what retires the optimistic-seed window.
      p.createSeeds.clearEpicCreateSeedPending(epicId);
      p.registry.getOpenEpicRegistry().acquireMounted(epicId, () => handle);
    });
    rerender();

    expect(readEpicHost(result.current)).toBe("host-real");
    await waitFor(() =>
      expect(readRepositoryColor(result.current)).toBe("#222222"),
    );
    expect(realRoute.listBindings).toHaveBeenCalledWith(
      { epicId },
      expect.anything(),
    );
    // The seed host's own client is never asked over the network at any point.
    expect(seedRoute.listBindings).not.toHaveBeenCalled();
  });
});
