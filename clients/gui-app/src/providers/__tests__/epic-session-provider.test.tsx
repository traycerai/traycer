import "../../../__tests__/test-browser-apis";
import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type {
  ListTasksResponse,
  TaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";

const hostState = vi.hoisted((): { id: string | null } => ({ id: "host-a" }));
const authServiceStub = vi.hoisted(() => ({
  revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
}));
const navigateMock = vi.hoisted(() => vi.fn());

// The provider now opens its own durable transport via this factory, but every
// test installs an `__setEpicStreamClientFactoryForTests` override that
// short-circuits before `openTransport` is ever called - so a stub factory that
// is never invoked is all the provider needs to render in jsdom. The real hook
// returns a referentially-STABLE opener; the stub mirrors that with a single
// hoisted instance so the acquire effect's `openTransport` dep never churns.
const openTransportStub = vi.hoisted(() => () => {
  throw new Error(
    "openTransport must not be called when the factory is overridden",
  );
});
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => openTransportStub,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => hostState.id,
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useAuthService: () => authServiceStub,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

import { EpicSessionProvider } from "@/providers/epic-session-provider";
import {
  __getOpenEpicRegistryForTests,
  __setEpicStreamClientFactoryForTests,
} from "@/lib/registries/epic-session-registry";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { setDesktopEpicOwnershipBridge } from "@/lib/windows/desktop-epic-ownership";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import type {
  DesktopOwnershipClaimResult,
  DesktopPerWindowStatePatch,
  DesktopWindowsBridge,
} from "@/lib/windows/types";

interface ControlledStream {
  closeCount: number;
}

type DesktopOwnershipClaimForTests =
  | DesktopOwnershipClaimResult
  | ((
      tabId: string,
      epicId: string,
      ownership: Map<string, string>,
    ) => Promise<DesktopOwnershipClaimResult>);

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in",
  email: string | null,
): void {
  if (status === "signed-in" && email !== null) {
    useAuthStore.setState({
      status,
      profile: { userId: email, userName: email, email },
      contextMetadata: { userId: email, username: email },
    });
    return;
  }
  useAuthStore.setState({
    status,
    profile: null,
    contextMetadata: null,
  });
}

function HandleProbe(props: {
  onHandle: (handle: OpenEpicStoreHandle) => void;
}) {
  const { onHandle } = props;
  const handle = useMaybeOpenEpicHandle();
  useEffect(() => {
    if (handle === null) return;
    onHandle(handle);
  }, [handle, onHandle]);
  return (
    <div
      data-testid="handle-probe"
      data-ready={handle === null ? "false" : "true"}
    />
  );
}

function createDesktopWindowsBridgeForTests(
  calls: {
    readonly claims: string[];
    readonly releases: string[];
    readonly focusRequests: string[];
    readonly perWindowUpdates: DesktopPerWindowStatePatch[];
  },
  claimForTests: DesktopOwnershipClaimForTests,
): DesktopWindowsBridge {
  const ownership = new Map<string, string>();
  return {
    windowId: "window-a",
    list: () => Promise.resolve([]),
    onChange: (_handler) => ({ dispose: () => undefined }),
    requestNew: () => Promise.resolve(),
    requestFocus: (windowId) => {
      calls.focusRequests.push(windowId);
      return Promise.resolve();
    },
    requestClose: () => Promise.resolve(),
    requestOpenEpicInNewWindow: () =>
      Promise.resolve({
        result: "moved" as const,
        windowId: "window-b",
      }),
    ownership: {
      snapshot: () =>
        Promise.resolve(
          Array.from(ownership.entries()).map(([tabId, epicId]) => ({
            tabId,
            epicId,
            windowId: "window-a",
          })),
        ),
      claim: (tabId, epicId) => {
        calls.claims.push(`${tabId}:${epicId}`);
        const claim =
          typeof claimForTests === "function"
            ? claimForTests(tabId, epicId, ownership)
            : Promise.resolve(claimForTests);
        return claim.then((result) => {
          if (result.ok) {
            ownership.set(tabId, epicId);
          }
          return result;
        });
      },
      release: (tabId) => {
        ownership.delete(tabId);
        calls.releases.push(tabId);
        return Promise.resolve();
      },
      onChange: (_handler) => ({ dispose: () => undefined }),
    },
    perWindowState: {
      get: () =>
        Promise.resolve({
          epicTabs: [],
          activeTabId: null,
          canvasByTabId: {},
          landingDrafts: [],
          activeLandingDraftId: null,
        }),
      update: (patch) => {
        calls.perWindowUpdates.push(patch);
        return Promise.resolve();
      },
      onChange: (_handler) => ({ dispose: () => undefined }),
    },
    authSession: {
      get: () =>
        Promise.resolve({
          status: "signed-out" as const,
          token: null,
          profile: null,
        }),
      set: () => Promise.resolve(),
      onChange: (_handler) => ({ dispose: () => undefined }),
    },
  };
}

function resetCanvasStore(): void {
  useEpicCanvasStore.setState({
    tabsById: {},
    openTabOrder: [],
    activeTabId: null,
    mostRecentTabIdByEpicId: {},
    artifactTreeByEpicId: {},
  });
}

function makeHistoryTask(
  id: string,
  title: string,
  createdBy: string,
): TaskLight {
  return {
    epic: {
      light: {
        id,
        title,
        initialUserPrompt: "Investigate the title update bug",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "draft",
        createdAt: 1,
        updatedAt: 1,
        createdBy,
        version: "1",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
  };
}

describe("<EpicSessionProvider />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    hostState.id = "host-a";
    navigateMock.mockClear();
    resetCanvasStore();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
    setDesktopEpicOwnershipBridge(null);
    resetAuth("signed-in", "alice@example.com");
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
    setDesktopEpicOwnershipBridge(null);
    resetCanvasStore();
    resetAuth("signed-out", null);
  });

  it("reacquires a fresh handle when the signed-in identity changes", async () => {
    const streams: ControlledStream[] = [];
    const seenHandles: OpenEpicStoreHandle[] = [];
    __setEpicStreamClientFactoryForTests((_epicId, _callbacks) => {
      const stream: ControlledStream = { closeCount: 0 };
      streams.push(stream);
      return {
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => {
          stream.closeCount += 1;
        },
      };
    });

    render(
      <EpicSessionProvider epicId="epic-session-test" tabId="epic-session-test">
        <HandleProbe
          onHandle={(handle) => {
            seenHandles.push(handle);
          }}
        />
      </EpicSessionProvider>,
    );

    await waitFor(() => {
      expect(seenHandles.at(-1)?.userId).toBe("alice@example.com");
    });

    const firstHandle = seenHandles.at(-1);
    if (firstHandle === undefined) {
      throw new Error("expected initial handle");
    }

    act(() => {
      resetAuth("signed-in", "bob@example.com");
    });

    await waitFor(() => {
      expect(seenHandles.at(-1)?.userId).toBe("bob@example.com");
    });

    const secondHandle = seenHandles.at(-1);
    if (secondHandle === undefined) {
      throw new Error("expected second handle");
    }

    expect(secondHandle).not.toBe(firstHandle);
    expect(streams).toHaveLength(2);
    expect(streams[0].closeCount).toBe(1);
    expect(__getOpenEpicRegistryForTests().size()).toBe(1);
  });

  it("reacquires a fresh handle when the active host changes", async () => {
    const streams: ControlledStream[] = [];
    const seenHandles: OpenEpicStoreHandle[] = [];
    __setEpicStreamClientFactoryForTests((_epicId, _callbacks) => {
      const stream: ControlledStream = { closeCount: 0 };
      streams.push(stream);
      return {
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => {
          stream.closeCount += 1;
        },
      };
    });

    const view = render(
      <EpicSessionProvider epicId="epic-session-test" tabId="epic-session-test">
        <HandleProbe
          onHandle={(handle) => {
            seenHandles.push(handle);
          }}
        />
      </EpicSessionProvider>,
    );

    await waitFor(() => {
      expect(seenHandles).toHaveLength(1);
    });

    const firstHandle = seenHandles.at(-1);
    if (firstHandle === undefined) {
      throw new Error("expected initial handle");
    }

    act(() => {
      hostState.id = "host-b";
      view.rerender(
        <EpicSessionProvider
          epicId="epic-session-test"
          tabId="epic-session-test"
        >
          <HandleProbe
            onHandle={(handle) => {
              seenHandles.push(handle);
            }}
          />
        </EpicSessionProvider>,
      );
    });

    await waitFor(() => {
      expect(seenHandles.at(-1)).not.toBe(firstHandle);
    });

    expect(streams).toHaveLength(2);
    expect(streams[0].closeCount).toBe(1);
    expect(__getOpenEpicRegistryForTests().size()).toBe(1);
  });

  it("defers acquisition without crashing while the active host is null, then acquires when it binds", async () => {
    const streams: ControlledStream[] = [];
    const seenHandles: OpenEpicStoreHandle[] = [];
    __setEpicStreamClientFactoryForTests((_epicId, _callbacks) => {
      const stream: ControlledStream = { closeCount: 0 };
      streams.push(stream);
      return {
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => {
          stream.closeCount += 1;
        },
      };
    });

    // The directory has not bound a default host yet: the factory would throw
    // "without an active host id" - escaping the acquire effect to the root
    // error boundary - if the effect did not gate on a non-null host. Mounting
    // must NOT crash and must NOT create a session.
    hostState.id = null;
    const view = render(
      <EpicSessionProvider epicId="epic-session-test" tabId="epic-session-test">
        <HandleProbe
          onHandle={(handle) => {
            seenHandles.push(handle);
          }}
        />
      </EpicSessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("handle-probe").dataset.ready).toBe("false");
    });
    expect(seenHandles).toEqual([]);
    expect(streams).toHaveLength(0);
    expect(__getOpenEpicRegistryForTests().size()).toBe(0);

    // The host binds: the effect re-runs (activeHostId is a dependency) and the
    // real session is acquired - no provider-driven retry needed.
    act(() => {
      hostState.id = "host-a";
      view.rerender(
        <EpicSessionProvider
          epicId="epic-session-test"
          tabId="epic-session-test"
        >
          <HandleProbe
            onHandle={(handle) => {
              seenHandles.push(handle);
            }}
          />
        </EpicSessionProvider>,
      );
    });

    await waitFor(() => {
      expect(seenHandles).toHaveLength(1);
    });
    expect(streams).toHaveLength(1);
    expect(__getOpenEpicRegistryForTests().size()).toBe(1);
  });

  it("patches cached history titles when a generated epic title lands", async () => {
    const queryClient = new QueryClient();
    const sessionUserId = "alice@example.com";
    const cloudTasksUserId = "cloud-user-1";
    useAuthStore.setState({
      contextMetadata: { userId: cloudTasksUserId, username: sessionUserId },
    });
    const queryKey = cloudEpicTasksQueryKey(
      "host-a",
      cloudTasksUserId,
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData<ListTasksResponse>(queryKey, {
      tasks: [makeHistoryTask("epic-session-test", "", cloudTasksUserId)],
      hasMore: false,
    });
    const seenHandles: OpenEpicStoreHandle[] = [];
    __setEpicStreamClientFactoryForTests((_epicId, _callbacks) => ({
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <EpicSessionProvider
          epicId="epic-session-test"
          tabId="epic-session-test"
        >
          <HandleProbe
            onHandle={(handle) => {
              seenHandles.push(handle);
            }}
          />
        </EpicSessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(seenHandles).toHaveLength(1);
    });
    expect(seenHandles[0].userId).toBe(sessionUserId);

    act(() => {
      seenHandles[0].store.getState().setEpicTitle("Generated history title");
    });

    await waitFor(() => {
      expect(
        queryClient.getQueryData<ListTasksResponse>(queryKey)?.tasks[0]?.epic
          ?.light?.title,
      ).toBe("Generated history title");
    });
  });

  it("claims desktop epic ownership before acquiring a renderer session", async () => {
    const streams: ControlledStream[] = [];
    const calls = {
      claims: [] as string[],
      releases: [] as string[],
      focusRequests: [] as string[],
      perWindowUpdates: [] as DesktopPerWindowStatePatch[],
    };
    const seenHandles: OpenEpicStoreHandle[] = [];
    let resolveClaim: (result: DesktopOwnershipClaimResult) => void = () =>
      undefined;
    const claim = new Promise<DesktopOwnershipClaimResult>((resolve) => {
      resolveClaim = resolve;
    });
    setDesktopEpicOwnershipBridge(
      createDesktopWindowsBridgeForTests(calls, () => claim),
    );
    __setEpicStreamClientFactoryForTests((_epicId, _callbacks) => {
      const stream: ControlledStream = { closeCount: 0 };
      streams.push(stream);
      return {
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => {
          stream.closeCount += 1;
        },
      };
    });

    render(
      <EpicSessionProvider epicId="epic-session-test" tabId="epic-session-test">
        <HandleProbe
          onHandle={(handle) => {
            seenHandles.push(handle);
          }}
        />
      </EpicSessionProvider>,
    );

    await waitFor(() => {
      expect(calls.claims).toEqual(["epic-session-test:epic-session-test"]);
    });

    expect(screen.getByTestId("handle-probe").dataset.ready).toBe("false");
    expect(seenHandles).toEqual([]);
    expect(streams).toHaveLength(0);

    await act(async () => {
      resolveClaim({ ok: true });
      await claim;
    });

    await waitFor(() => {
      expect(seenHandles).toHaveLength(1);
    });
    expect(streams).toHaveLength(1);

    act(() => {
      __getOpenEpicRegistryForTests().release("epic-session-test");
    });
    await waitFor(() => {
      expect(calls.releases).toEqual(["epic-session-test"]);
    });
  });

  it("releases desktop epic ownership when the provider unmounts", async () => {
    const calls: {
      readonly claims: string[];
      readonly releases: string[];
      readonly focusRequests: string[];
      readonly perWindowUpdates: DesktopPerWindowStatePatch[];
    } = {
      claims: [],
      releases: [],
      focusRequests: [],
      perWindowUpdates: [],
    };
    const seenHandles: OpenEpicStoreHandle[] = [];
    setDesktopEpicOwnershipBridge(
      createDesktopWindowsBridgeForTests(calls, { ok: true }),
    );
    __setEpicStreamClientFactoryForTests((_epicId, _callbacks) => ({
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    }));

    const view = render(
      <EpicSessionProvider epicId="epic-session-test" tabId="tab-cleanup">
        <HandleProbe
          onHandle={(handle) => {
            seenHandles.push(handle);
          }}
        />
      </EpicSessionProvider>,
    );

    await waitFor(() => {
      expect(seenHandles).toHaveLength(1);
    });
    expect(calls.claims).toEqual(["tab-cleanup:epic-session-test"]);

    view.unmount();

    await waitFor(() => {
      expect(calls.releases).toEqual(["tab-cleanup"]);
    });
  });

  it("cleans up optimistic desktop tab state when ownership is rejected", async () => {
    const calls = {
      claims: [] as string[],
      releases: [] as string[],
      focusRequests: [] as string[],
      perWindowUpdates: [] as DesktopPerWindowStatePatch[],
    };
    const seenHandles: OpenEpicStoreHandle[] = [];
    setDesktopEpicOwnershipBridge(
      createDesktopWindowsBridgeForTests(calls, {
        ok: false,
        currentOwner: "window-owner",
      }),
    );
    useEpicCanvasStore.getState().openEpicTab("epic-owned", "Owned");
    const conflictTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-conflict", "Conflict");
    useEpicCanvasStore.getState().openTileInTab(conflictTabId, {
      id: "chat-conflict",
      instanceId: "inst-chat-conflict",
      type: "chat",
      name: "Conflict Chat",
      hostId: "test-host",
    });

    render(
      <EpicSessionProvider epicId="epic-conflict" tabId={conflictTabId}>
        <HandleProbe
          onHandle={(handle) => {
            seenHandles.push(handle);
          }}
        />
      </EpicSessionProvider>,
    );

    await waitFor(() => {
      expect(calls.focusRequests).toEqual(["window-owner"]);
    });

    const state = useEpicCanvasStore.getState();
    expect(calls.claims).toEqual([`${conflictTabId}:epic-conflict`]);
    expect(calls.perWindowUpdates).toHaveLength(1);
    const cleanupPatch = calls.perWindowUpdates[0];
    expect(Array.isArray(cleanupPatch.epicTabs)).toBe(true);
    expect(typeof cleanupPatch.activeTabId).toBe("string");
    expect(cleanupPatch.canvasByTabId).toEqual({ [conflictTabId]: null });
    expect(state.openTabOrder).toHaveLength(1);
    expect(state.activeTabId).not.toBeNull();
    expect(state.artifactTreeByEpicId["epic-conflict"]).toEqual([]);
    expect(seenHandles).toEqual([]);
    expect(__getOpenEpicRegistryForTests().size()).toBe(0);
    expect(navigateMock).toHaveBeenCalledWith({ to: "/epics", replace: true });
  });
});
