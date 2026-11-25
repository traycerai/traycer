import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useArtifactVersionHistoryAvailable } from "@/hooks/epic/use-artifact-version-history-available";
import { useHostQuery } from "@/hooks/host/use-host-query";

// Same harness as `use-host-client-for-host-id.test.ts`: the runtime's default
// client is a real `HostClient` whose `findHostById` is the LIVE directory,
// while the directory Query snapshot (`useHostDirectoryList().data`) is
// controlled separately - so a test can hold the snapshot at `undefined`
// (first render, before the query resolves) while the live directory already
// knows the host.
const globalClientRef = vi.hoisted<{
  value: HostClient<HostRpcRegistry> | null;
}>(() => ({ value: null }));
const directoryState = vi.hoisted<{
  data: readonly HostDirectoryEntry[] | undefined;
}>(() => ({ data: undefined }));

function getGlobalClient(): HostClient<HostRpcRegistry> {
  if (globalClientRef.value === null) {
    throw new Error("test global client not configured");
  }
  return globalClientRef.value;
}

/**
 * Mirrors `lib/host/runtime.ts`'s `useHostClient` exactly: the SELECTION
 * LAYER's effective host id, resolved through the spine's uniform requester.
 *
 * Reads the authority store rather than the spine's bound slot. Those agree
 * in production, so a slot-derived mirror passed here for the wrong reason -
 * and would keep passing after the slot is deleted (P4.2), long after the
 * thing it claims to mirror had stopped existing. No case below reads this
 * branch; it is kept faithful so the first one that does gets ∅ and a fixture
 * that must NAME its effective host, rather than a quietly wrong answer.
 */
function getFollowingClient(): HostClient<HostRpcRegistry> {
  return getGlobalClient().createRequesterForHostId(
    useSelectionAuthorityStore.getState().effectiveHostId,
  );
}

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: getFollowingClient,
  useHostBinding: () => ({
    hostClient: getGlobalClient(),
    hostId: null,
  }),
  // `useHostClientForHostId` reads BOTH through the barrel: the spine for
  // the directory lookups, the effective host for the following branch.
  useHostRuntimeClient: getGlobalClient,
}));

// `useHostRuntimeClient` is the SPINE a host id resolves against;
// `useHostClient` is the effective host already resolved through it.
// Every case here passes an explicit tab host id, so the
// following-client mirror keeps the mock's shape honest rather than serving a
// case.
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostRuntimeClient: getGlobalClient,
  useHostClient: getFollowingClient,
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: directoryState.data }),
}));

// `<TabHostProvider>` also mounts the cross-device drafts mirror, whose
// session reaches `useHostDirectory()` / `useAuthService()` and a
// `useHostQuery` - all of which want a real `<HostRuntimeProvider>` and a
// `QueryClientProvider` around a suite that deliberately has neither. Every
// other tile suite dodges it through the mount's own escape hatch (a `null`
// `useHostBinding`, which makes it render nothing), but this one CANNOT: its
// subject, `useHostClientForHostId`, reads that binding to resolve a named
// host, so the mock above has to hand back a real one. Stub the mount
// instead - it renders `null` in both branches and carries only effects,
// none of which this suite is about.
vi.mock("@/hooks/drafts/use-tab-draft-mirror", () => ({
  TabDraftMirrorMount: () => null,
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => ({}),
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: "tab-host-b",
    isReady: true,
    hasRpcEndpoint: true,
    canExecute: true,
    requestContextUserId: "user-test",
  }),
}));

import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";

const TAB_HOST: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "tab-host-b",
  websocketUrl: "ws://127.0.0.1:59999/stream",
};

const APP_SERVING_HOST: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "app-serving-host",
  websocketUrl: "ws://127.0.0.1:58888/stream",
};

function buildGlobalClient(
  listDirectory: () => readonly HostDirectoryEntry[],
  messenger: MockHostMessenger<HostRpcRegistry> | undefined,
): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger:
      messenger ??
      new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-1",
        handlers: {},
      }),
    findHostById: (hostId) =>
      listDirectory().find((entry) => entry.hostId === hostId) ?? null,
  });
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
    }),
  );
  return client;
}

function tabWrapper(hostId: string) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return <TabHostProvider hostId={hostId}>{children}</TabHostProvider>;
  };
}

interface BothClients {
  readonly tab: HostClient<HostRpcRegistry> | null;
  readonly byId: HostClient<HostRpcRegistry> | null;
}

/**
 * The exact pairing a chat tab produces: its toolbar store reads
 * `useTabHostClient()` while the picker beside it is handed the same id as a
 * plain `runTargetHostId` and resolves `useHostClientForHostId(id)`. Both in
 * ONE render, so the assertions below compare what a single paint sees.
 */
function useBothClients(hostId: string): BothClients {
  const tab = useTabHostClient();
  const byId = useHostClientForHostId(hostId);
  return { tab, byId };
}

describe("useTabHostClient", () => {
  afterEach(() => {
    cleanup();
    globalClientRef.value = null;
    directoryState.data = undefined;
    resetNegotiatedManifests();
    useSelectionAuthorityStore.getState().reset();
  });

  it("resolves on the FIRST render from the live directory, in the same paint as useHostClientForHostId, before the directory Query snapshot has data", () => {
    globalClientRef.value = buildGlobalClient(
      () => [mockLocalHostEntry, TAB_HOST],
      undefined,
    );
    // First render: the Query snapshot is still `undefined`.
    directoryState.data = undefined;
    let renders = 0;

    const { result } = renderHook(
      () => {
        renders += 1;
        return useBothClients(TAB_HOST.hostId);
      },
      { wrapper: tabWrapper(TAB_HOST.hostId) },
    );

    // Neither hook has effects, so this IS the first (and only) render.
    expect(renders).toBe(1);
    expect(result.current.tab).not.toBeNull();
    expect(result.current.byId).not.toBeNull();
    expect(result.current.tab?.getActiveHostId()).toBe(TAB_HOST.hostId);
    expect(result.current.byId?.getActiveHostId()).toBe(TAB_HOST.hostId);
  });

  it("agrees with useHostClientForHostId on an unresolved identity requester when the tab's host is nowhere in the directory", () => {
    globalClientRef.value = buildGlobalClient(
      () => [mockLocalHostEntry],
      undefined,
    );
    directoryState.data = [mockLocalHostEntry];
    const { result } = renderHook(() => useBothClients("host-nobody-knows"), {
      wrapper: tabWrapper("host-nobody-knows"),
    });

    expect(result.current.tab).not.toBeNull();
    expect(result.current.byId).not.toBeNull();
    expect(result.current.tab?.getActiveHostId()).toBeNull();
    expect(result.current.byId?.getActiveHostId()).toBeNull();
  });

  it("stays a pinned requester - never the mutable default client - even when the tab's host IS the app-wide default", () => {
    const globalClient = buildGlobalClient(
      () => [mockLocalHostEntry],
      undefined,
    );
    globalClientRef.value = globalClient;
    directoryState.data = undefined;
    const { result } = renderHook(
      () => useBothClients(mockLocalHostEntry.hostId),
      {
        wrapper: tabWrapper(mockLocalHostEntry.hostId),
      },
    );

    expect(result.current.tab).not.toBeNull();
    expect(result.current.tab).not.toBe(globalClient);
    expect(result.current.tab?.getActiveHostId()).toBe(
      mockLocalHostEntry.hostId,
    );
  });

  it("THROWS outside <TabHostProvider> instead of silently following the app-wide host", () => {
    globalClientRef.value = buildGlobalClient(
      () => [mockLocalHostEntry, TAB_HOST],
      undefined,
    );
    directoryState.data = [mockLocalHostEntry, TAB_HOST];

    // The hook's header has always promised this ("Must be called inside
    // <TabHostProvider>"); `useTabHostId` now enforces it, and nothing
    // pinned it. It matters more now: `useHostClientForHostId(null)`
    // now resolves the EFFECTIVE host rather than handing back the raw spine,
    // so an unwrapped tile consumer would no longer fail obviously - it would
    // get a perfectly working client for the wrong host and address it for
    // life. Loud is the whole point.
    expect(() => renderHook(() => useTabHostClient())).toThrow(
      /TabHostProvider/,
    );
  });

  it("keeps identity requesters with no authenticated request context so readiness owns the auth gate", () => {
    const globalClient = buildGlobalClient(
      () => [mockLocalHostEntry, TAB_HOST],
      undefined,
    );
    globalClient.setRequestContext(null);
    globalClientRef.value = globalClient;
    directoryState.data = [mockLocalHostEntry, TAB_HOST];
    const { result } = renderHook(() => useBothClients(TAB_HOST.hostId), {
      wrapper: tabWrapper(TAB_HOST.hostId),
    });

    expect(result.current.tab).not.toBeNull();
    expect(result.current.byId).not.toBeNull();
    expect(result.current.tab?.getActiveHostId()).toBe(TAB_HOST.hostId);
    expect(result.current.byId?.getActiveHostId()).toBe(TAB_HOST.hostId);
  });

  it("uses the task tab's manifest and requester while the app is served by another computer", async () => {
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "artifact-list",
      handlers: {
        "epic.artifactVersions.list": () => ({
          entries: [],
          nextCursor: null,
        }),
      },
    });
    const directoryRows = [mockLocalHostEntry, TAB_HOST, APP_SERVING_HOST];
    const globalClient = buildGlobalClient(() => directoryRows, messenger);
    globalClientRef.value = globalClient;
    directoryState.data = directoryRows;
    globalClient.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-task-peer-test",
      }),
    );
    useSelectionAuthorityStore.getState().applyKernelSnapshot({
      attached: true,
      preferredHostId: APP_SERVING_HOST.hostId,
      targetHostId: APP_SERVING_HOST.hostId,
      effectiveHostId: APP_SERVING_HOST.hostId,
      servingPeer: { kind: "computer", hostId: APP_SERVING_HOST.hostId },
      noPeerPresentation: null,
      leases: [
        { hostId: APP_SERVING_HOST.hostId, status: "ready", dead: null },
        { hostId: TAB_HOST.hostId, status: "ready", dead: null },
      ],
      selectionRevision: 1,
    });
    recordNegotiatedHostMethods(TAB_HOST.hostId, ["epic.getTaskContexts"]);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const { result } = renderHook(
      () => {
        const available = useArtifactVersionHistoryAvailable();
        const query = useHostQuery({
          client: useTabHostClient(),
          method: "epic.artifactVersions.list",
          params: {
            epicId: "epic-task",
            artifactId: "artifact-task",
            cursor: null,
            limit: 200,
          },
          cacheKeyIdentity: undefined,
          options: { enabled: available, staleTime: Infinity },
        });
        return { available, query };
      },
      {
        wrapper: ({ children }: { readonly children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>
            <TabHostProvider hostId={TAB_HOST.hostId}>
              {children}
            </TabHostProvider>
          </QueryClientProvider>
        ),
      },
    );

    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(
      APP_SERVING_HOST.hostId,
    );
    expect(result.current.available).toBe(false);
    expect(messenger.calls).toEqual([]);

    act(() => {
      recordNegotiatedHostMethods(TAB_HOST.hostId, [
        "epic.artifactVersions.list",
        "epic.artifactVersions.getBlob",
      ]);
    });
    await waitFor(() => {
      expect(result.current.query.data).toEqual({
        entries: [],
        nextCursor: null,
      });
    });

    expect(result.current.available).toBe(true);
    expect(
      messenger.calls.map((call) => [
        call.method,
        call.authority.endpoint.hostId,
      ]),
    ).toEqual([["epic.artifactVersions.list", TAB_HOST.hostId]]);
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(
      APP_SERVING_HOST.hostId,
    );
  });
});
