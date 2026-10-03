import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  SurfaceDemandContext,
  setTopLevelDemand,
  useSurfaceDemandStore,
  type ActiveSurfaceDemand,
} from "@/stores/tabs/surface-demand";
import { useChatPrewarmEligible } from "@/lib/registries/chat-prewarm";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
  type ChatStreamClientFactory,
} from "@/stores/chats/chat-session-store";
import type { SkeletonResumeCacheKey } from "@/stores/chats/skeleton-resume-cache";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  CHAT_A,
  SPEC_A,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import { getProcessMemoryRuntime } from "@/stores/replica-memory/process-memory-accountant";

// Explicit surface demand gates chat acquisition: a cold surface under
// `preview` demand stays a static shell, `settled` acquires at once. Reuses the lighter override-factory seam
// (`__setChatStreamClientFactoryForTests`) rather than
// `chat-session-registry.test.tsx`'s full HostClient/MockHostMessenger rig,
// which exists for owner-identity discrimination this suite never exercises.

// Hoisted: the mock factories below read these before the module's own
// top-level `const`s would otherwise be initialized.
const { EPIC_ID, HOST_ID, USER_ID } = vi.hoisted(() => ({
  EPIC_ID: "epic-1",
  HOST_ID: "host-surface-demand",
  USER_ID: "user-surface-demand",
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => EPIC_ID,
}));

const visibility = vi.hoisted(() => ({
  paneVisible: true,
  tabSelected: true,
}));
vi.mock("@/components/epic-tabs/pane-visibility-context", () => ({
  usePaneVisible: () => visibility.paneVisible,
}));
vi.mock("@/components/epic-canvas/canvas/tab-body-selected-context", () => ({
  useTabBodySelected: () => visibility.tabSelected,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => ({
    hostId: HOST_ID,
    label: "Test host",
    kind: "local" as const,
    websocketUrl: "ws://127.0.0.1:1/rpc",
    version: "1.0.0",
    transportDialability: "dialable" as const,
  }),
}));
vi.mock("@/hooks/host/use-host-lease", () => ({
  useHostLease: () => null,
}));

// Only needs to satisfy the hook's top-level calls: the stream itself is
// driven through `__setChatStreamClientFactoryForTests` below.
vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    request: () => new Promise(() => {}),
    getActiveHostId: () => HOST_ID,
    getActiveHost: () => null,
    getRequestContextUserId: () => USER_ID,
    onChange: () => () => undefined,
  }),
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
}));

// Never called under the override; throwing turns a regression that bypasses
// it into a hard failure instead of a silent real dial under jsdom. A stable
// module-level function: the real hook's factory is referentially stable and
// the acquisition effect depends on it, so a fresh one per render would
// re-run that effect on every render.
function throwIfTransportOpened(): never {
  throw new Error("test: openTransport must not be called under the override");
}
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => throwIfTransportOpened,
}));

// Observes per-session durable skeleton hydration; the real cache otherwise.
const skeletonHydration = vi.hoisted(() => ({
  enabled: false,
  starts: 0,
}));
vi.mock("@/stores/chats/skeleton-resume-cache", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/stores/chats/skeleton-resume-cache")
    >();
  return {
    ...actual,
    shouldLoadDurableSkeletonForResume: (key: SkeletonResumeCacheKey) =>
      skeletonHydration.enabled ||
      actual.shouldLoadDurableSkeletonForResume(key),
    hydrateSkeletonForResume: (key: SkeletonResumeCacheKey) => {
      if (!skeletonHydration.enabled)
        return actual.hydrateSkeletonForResume(key);
      skeletonHydration.starts += 1;
      return new Promise<void>(() => {});
    },
  };
});

import { useChatSessionHandle } from "@/lib/registries/chat-session-registry";
import {
  __getChatSessionRegistryForTests,
  __setChatStreamClientFactoryForTests,
  disposeAllChatSessions,
} from "@/lib/registries/chat-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";

// What the surrounding `TopLevelTabHost` / pane would provide for the mounted
// surface; tests flip it and rerender.
const demandState: { value: ActiveSurfaceDemand } = { value: "settled" };

// The hidden-prewarm queue pauses on any outstanding preview, wherever it is.
const PREWARM_INTERVAL_MS = 150;
function setPreviewDemand(active: boolean): void {
  setTopLevelDemand(["epic:test"], active ? "preview" : "settled");
}

function QueryWrapper(props: { readonly children: ReactNode }): ReactNode {
  // Stable across this component instance's rerenders, matching the real
  // app's provider: a fresh client every render would also destabilize
  // `useQueryClient()`, another of the acquisition effect's dependencies.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      }),
  );
  return (
    <SurfaceDemandContext.Provider value={demandState.value}>
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    </SurfaceDemandContext.Provider>
  );
}

function StrictWrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <StrictMode>
      <QueryWrapper {...props} />
    </StrictMode>
  );
}

describe("useChatSessionHandle surface demand", () => {
  let streamFactorySpy: Mock<ChatStreamClientFactory>;

  beforeEach(() => {
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: USER_ID,
        userName: USER_ID,
        email: `${USER_ID}@example.com`,
      },
    });
    visibility.paneVisible = true;
    visibility.tabSelected = true;
    demandState.value = "settled";
    useSurfaceDemandStore.setState(
      useSurfaceDemandStore.getInitialState(),
      true,
    );
    setPreviewDemand(false);
    streamFactorySpy = vi.fn<ChatStreamClientFactory>(() => ({
      sendAction: () => undefined,
      close: () => undefined,
      sameTurnSteeringProtocolSupported: () => true,
      draftBlobBridgeSupported: () => true,
      requestTranscriptRange: () => undefined,
      requestResnapshot: () => undefined,
    }));
    __setChatStreamClientFactoryForTests(streamFactorySpy);
  });

  afterEach(() => {
    cleanup();
    useSurfaceDemandStore.setState(
      useSurfaceDemandStore.getInitialState(),
      true,
    );
    skeletonHydration.enabled = false;
    skeletonHydration.starts = 0;
    __setChatStreamClientFactoryForTests(null);
    disposeAllChatSessions();
    useAuthStore.setState({ profile: null, status: "signed-out" });
  });

  it("hydrates a settled cold open from the durable skeleton, never a held preview", () => {
    skeletonHydration.enabled = true;
    demandState.value = "preview";
    const held = renderHook(
      () => useChatSessionHandle("chat-held", HOST_ID, true, "surface"),
      { wrapper: QueryWrapper },
    );
    // A preview neither opens a stream nor touches storage.
    expect(held.result.current).toBeNull();
    expect(streamFactorySpy).not.toHaveBeenCalled();
    expect(skeletonHydration.starts).toBe(0);
    held.unmount();

    demandState.value = "settled";
    renderHook(
      () => useChatSessionHandle("chat-settled", HOST_ID, true, "surface"),
      { wrapper: QueryWrapper },
    );

    expect(skeletonHydration.starts).toBe(1);
    expect(streamFactorySpy).toHaveBeenCalledTimes(1);
    expect(streamFactorySpy).toHaveBeenLastCalledWith(
      EPIC_ID,
      "chat-settled",
      expect.anything(),
    );
  });

  it("a cold surface under preview demand opens no stream however the target changes, and settling acquires exactly the final target", () => {
    vi.useFakeTimers();
    try {
      demandState.value = "preview";
      const { result, rerender } = renderHook(
        ({ chatId }: { chatId: string }) =>
          useChatSessionHandle(chatId, HOST_ID, true, "surface"),
        { wrapper: QueryWrapper, initialProps: { chatId: "chat-0" } },
      );
      for (let index = 1; index <= 9; index += 1) {
        act(() => {
          rerender({ chatId: `chat-${index}` });
        });
      }
      // No timer may admit a preview target: only settling does.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(result.current).toBeNull();
      expect(streamFactorySpy).not.toHaveBeenCalled();

      demandState.value = "settled";
      act(() => {
        rerender({ chatId: "chat-9" });
      });
      expect(streamFactorySpy).toHaveBeenCalledTimes(1);
      expect(streamFactorySpy).toHaveBeenCalledWith(
        EPIC_ID,
        "chat-9",
        expect.anything(),
      );
      expect(result.current).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("acquires immediately on a single settled open", () => {
    renderHook(
      () => useChatSessionHandle("chat-solo", HOST_ID, true, "surface"),
      { wrapper: QueryWrapper },
    );

    expect(streamFactorySpy).toHaveBeenCalledTimes(1);
    expect(streamFactorySpy).toHaveBeenCalledWith(
      EPIC_ID,
      "chat-solo",
      expect.anything(),
    );
  });

  it("acquires the final target once when its settle lands in the same update, never a stale intermediate target", () => {
    demandState.value = "preview";
    const { rerender } = renderHook(
      ({ chatId }: { chatId: string }) =>
        useChatSessionHandle(chatId, HOST_ID, true, "surface"),
      { wrapper: QueryWrapper, initialProps: { chatId: "chat-a" } },
    );

    act(() => {
      rerender({ chatId: "chat-b" });
    });
    expect(streamFactorySpy).not.toHaveBeenCalled();

    // Keyup: final target and settled demand land in one React update.
    demandState.value = "settled";
    act(() => {
      rerender({ chatId: "chat-final" });
    });

    expect(streamFactorySpy).toHaveBeenCalledTimes(1);
    expect(streamFactorySpy).toHaveBeenCalledWith(
      EPIC_ID,
      "chat-final",
      expect.anything(),
    );
  });

  it("keeps a warm, already-presented chat mounted through a preview without rebuilding its transport", () => {
    const first = renderHook(
      () => useChatSessionHandle("chat-warm", HOST_ID, true, "surface"),
      { wrapper: QueryWrapper },
    );
    const handle = first.result.current;
    if (handle === null) throw new Error("expected a handle");
    act(() => {
      handle.store.setState({ snapshotLoaded: true });
    });
    expect(streamFactorySpy).toHaveBeenCalledTimes(1);

    // Not transient anymore, so closing the tab parks it warm.
    first.unmount();
    expect(
      __getChatSessionRegistryForTests().peek(EPIC_ID, "chat-warm", HOST_ID),
    ).toBe(handle);

    // Previewing a warm chat shows its retained body; only a cold one stays a
    // shell.
    demandState.value = "preview";
    const previewed = renderHook(
      () => useChatSessionHandle("chat-warm", HOST_ID, true, "surface"),
      { wrapper: QueryWrapper },
    );
    expect(previewed.result.current).toBe(handle);
    expect(streamFactorySpy).toHaveBeenCalledTimes(1);
  });

  it("clears a stale handle the instant the target changes under preview, and reacquires nothing until settled", () => {
    const { result, rerender } = renderHook(
      ({ chatId }: { chatId: string }) =>
        useChatSessionHandle(chatId, HOST_ID, true, "surface"),
      { wrapper: QueryWrapper, initialProps: { chatId: "chat-x" } },
    );
    expect(result.current).not.toBeNull();
    const handleX = result.current;
    expect(streamFactorySpy).toHaveBeenCalledTimes(1);

    demandState.value = "preview";
    act(() => {
      rerender({ chatId: "chat-y" });
    });

    expect(result.current).toBeNull();
    expect(result.current).not.toBe(handleX);
    expect(streamFactorySpy).toHaveBeenCalledTimes(1);
  });

  it("under StrictMode double-invoked effects, acquires exactly once", async () => {
    setPreviewDemand(false);
    const { result } = renderHook(
      () => useChatSessionHandle("chat-strict", HOST_ID, true, "surface"),
      { wrapper: StrictWrapper },
    );

    // The queued microtask decrement lets the surviving setup pass join.
    await act(async () => {
      await Promise.resolve();
    });

    expect(streamFactorySpy).toHaveBeenCalledTimes(1);
    expect(result.current).not.toBeNull();
  });

  it("a startup prewarm and a tile mounting the same chat/host key open exactly one stream, one registry entry, and one byte-accounting entry", () => {
    // `registry.acquire`'s scope-key dedup must hold ACROSS demand kinds, not
    // just between two "surface" mounts (already covered in
    // chat-session-registry.test.tsx).
    setPreviewDemand(false);
    const chatWindows = getProcessMemoryRuntime().chatWindows;
    const sessionCountBefore = chatWindows.sessionCount();
    const startup = renderHook(
      () =>
        useChatSessionHandle("chat-startup-and-tile", HOST_ID, true, "startup"),
      { wrapper: QueryWrapper },
    );
    expect(streamFactorySpy).toHaveBeenCalledTimes(1);
    const startupHandle = startup.result.current;
    if (startupHandle === null) throw new Error("expected a handle");

    const tile = renderHook(
      () =>
        useChatSessionHandle("chat-startup-and-tile", HOST_ID, true, "surface"),
      { wrapper: QueryWrapper },
    );

    // One stream, one registry entry, one new chatWindows accounting entry.
    expect(streamFactorySpy).toHaveBeenCalledTimes(1);
    expect(tile.result.current).toBe(startupHandle);
    expect(__getChatSessionRegistryForTests().size()).toBe(1);
    expect(
      __getChatSessionRegistryForTests().peek(
        EPIC_ID,
        "chat-startup-and-tile",
        HOST_ID,
      ),
    ).toBe(startupHandle);
    expect(chatWindows.sessionCount() - sessionCountBefore).toBe(1);
  });

  it("marks a settled, loaded surface presented at once, with no timer", () => {
    const { result } = renderHook(
      () =>
        useChatSessionHandle("chat-earns-presented", HOST_ID, true, "surface"),
      { wrapper: QueryWrapper },
    );
    const handle = result.current;
    if (handle === null) throw new Error("expected a handle");
    const registry = __getChatSessionRegistryForTests();
    expect(registry.isTransient(handle)).toBe(true);

    act(() => {
      handle.store.setState({ snapshotLoaded: true });
    });
    expect(registry.isTransient(handle)).toBe(false);
  });

  describe("retained-hidden prewarm queue (W4 R-A)", () => {
    it("acquires a cold retained-hidden body after the settle window, non-transient", () => {
      vi.useFakeTimers();
      try {
        visibility.paneVisible = true;
        visibility.tabSelected = false; // retained sibling, not the pane's front tab
        const { result } = renderHook(
          () =>
            useChatSessionHandle("chat-hidden-cold", HOST_ID, true, "surface"),
          { wrapper: QueryWrapper },
        );

        expect(result.current).toBeNull();
        expect(streamFactorySpy).not.toHaveBeenCalled();

        act(() => {
          vi.advanceTimersByTime(PREWARM_INTERVAL_MS - 1);
        });
        expect(streamFactorySpy).not.toHaveBeenCalled();

        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);
        expect(streamFactorySpy).toHaveBeenCalledWith(
          EPIC_ID,
          "chat-hidden-cold",
          expect.anything(),
        );
        expect(result.current).not.toBeNull();
        const handle = result.current;
        if (handle === null) throw new Error("expected a handle");
        expect(__getChatSessionRegistryForTests().isTransient(handle)).toBe(
          false,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("acquires a visible foreground chat immediately while a hidden retained neighbour only queues", () => {
      vi.useFakeTimers();
      try {
        visibility.paneVisible = true;
        visibility.tabSelected = true;
        const foreground = renderHook(
          () =>
            useChatSessionHandle("chat-foreground", HOST_ID, true, "surface"),
          { wrapper: QueryWrapper },
        );
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);
        expect(streamFactorySpy).toHaveBeenCalledWith(
          EPIC_ID,
          "chat-foreground",
          expect.anything(),
        );
        expect(foreground.result.current).not.toBeNull();

        // A retained sibling in the same, visible pane - merely queued.
        visibility.tabSelected = false;
        renderHook(
          () =>
            useChatSessionHandle("chat-neighbour", HOST_ID, true, "surface"),
          {
            wrapper: QueryWrapper,
          },
        );
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);

        act(() => {
          vi.advanceTimersByTime(PREWARM_INTERVAL_MS);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(2);
        expect(streamFactorySpy).toHaveBeenLastCalledWith(
          EPIC_ID,
          "chat-neighbour",
          expect.anything(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("blocks hidden acquisition while a preview is outstanding, cancels an in-flight timer the instant one starts, and restarts the full interval once settled", () => {
      vi.useFakeTimers();
      try {
        setPreviewDemand(false);
        visibility.paneVisible = true;
        visibility.tabSelected = false;
        renderHook(
          () => useChatSessionHandle("chat-repeat-a", HOST_ID, true, "surface"),
          {
            wrapper: QueryWrapper,
          },
        );

        // A preview starting mid-interval cancels the pending timer synchronously.
        act(() => {
          vi.advanceTimersByTime(80);
        });
        act(() => {
          setPreviewDemand(true);
        });
        act(() => {
          vi.advanceTimersByTime(1_000);
        });
        expect(streamFactorySpy).not.toHaveBeenCalled();

        // A second retained body queues while still repeating - no timer starts.
        renderHook(
          () => useChatSessionHandle("chat-repeat-b", HOST_ID, true, "surface"),
          {
            wrapper: QueryWrapper,
          },
        );
        act(() => {
          vi.advanceTimersByTime(500);
        });
        expect(streamFactorySpy).not.toHaveBeenCalled();

        // Keyup restarts the settle window from a full 150ms, not from
        // wherever the cancelled timer left off.
        act(() => {
          setPreviewDemand(false);
        });
        act(() => {
          vi.advanceTimersByTime(PREWARM_INTERVAL_MS - 1);
        });
        expect(streamFactorySpy).not.toHaveBeenCalled();

        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("paces multiple queued hidden acquisitions one per settle interval, same-pane siblings before hidden top-level pane bodies", () => {
      vi.useFakeTimers();
      try {
        setPreviewDemand(false);

        // A hidden TOP-LEVEL pane body, queued first.
        visibility.paneVisible = false;
        visibility.tabSelected = true;
        renderHook(
          () =>
            useChatSessionHandle("chat-other-pane", HOST_ID, true, "surface"),
          { wrapper: QueryWrapper },
        );

        // Same-pane retained siblings, queued after.
        visibility.paneVisible = true;
        visibility.tabSelected = false;
        renderHook(
          () =>
            useChatSessionHandle("chat-sibling-1", HOST_ID, true, "surface"),
          {
            wrapper: QueryWrapper,
          },
        );
        renderHook(
          () =>
            useChatSessionHandle("chat-sibling-2", HOST_ID, true, "surface"),
          {
            wrapper: QueryWrapper,
          },
        );

        expect(streamFactorySpy).not.toHaveBeenCalled();

        act(() => {
          vi.advanceTimersByTime(PREWARM_INTERVAL_MS);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);
        expect(streamFactorySpy).toHaveBeenNthCalledWith(
          1,
          EPIC_ID,
          "chat-sibling-1",
          expect.anything(),
        );

        act(() => {
          vi.advanceTimersByTime(PREWARM_INTERVAL_MS);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(2);
        expect(streamFactorySpy).toHaveBeenNthCalledWith(
          2,
          EPIC_ID,
          "chat-sibling-2",
          expect.anything(),
        );

        act(() => {
          vi.advanceTimersByTime(PREWARM_INTERVAL_MS);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(3);
        expect(streamFactorySpy).toHaveBeenNthCalledWith(
          3,
          EPIC_ID,
          "chat-other-pane",
          expect.anything(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels a queued hidden prewarm on unmount before it settles", () => {
      vi.useFakeTimers();
      try {
        visibility.paneVisible = true;
        visibility.tabSelected = false;
        const hidden = renderHook(
          () =>
            useChatSessionHandle("chat-cancel-me", HOST_ID, true, "surface"),
          { wrapper: QueryWrapper },
        );

        act(() => {
          vi.advanceTimersByTime(80);
        });
        hidden.unmount();

        act(() => {
          vi.advanceTimersByTime(1_000);
        });
        expect(streamFactorySpy).not.toHaveBeenCalled();
        expect(
          __getChatSessionRegistryForTests().peek(
            EPIC_ID,
            "chat-cancel-me",
            HOST_ID,
          ),
        ).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels every queued hidden prewarm on session-wide disposal, so a stale timer cannot recreate a session after logout", () => {
      vi.useFakeTimers();
      try {
        visibility.paneVisible = true;
        visibility.tabSelected = false;
        renderHook(
          () =>
            useChatSessionHandle("chat-logout-race", HOST_ID, true, "surface"),
          { wrapper: QueryWrapper },
        );

        act(() => {
          vi.advanceTimersByTime(80);
        });
        act(() => {
          disposeAllChatSessions();
        });

        act(() => {
          vi.advanceTimersByTime(1_000);
        });
        expect(streamFactorySpy).not.toHaveBeenCalled();
        expect(
          __getChatSessionRegistryForTests().peek(
            EPIC_ID,
            "chat-logout-race",
            HOST_ID,
          ),
        ).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("reuses an already-prewarmed hidden session when it becomes visible, without rebuilding its transport", () => {
      vi.useFakeTimers();
      try {
        visibility.paneVisible = true;
        visibility.tabSelected = false;
        const { result, rerender } = renderHook(
          () => useChatSessionHandle("chat-reuse", HOST_ID, true, "surface"),
          { wrapper: QueryWrapper },
        );

        act(() => {
          vi.advanceTimersByTime(PREWARM_INTERVAL_MS);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);
        const prewarmedHandle = result.current;
        if (prewarmedHandle === null) throw new Error("expected a handle");
        expect(
          __getChatSessionRegistryForTests().isTransient(prewarmedHandle),
        ).toBe(false);

        // A repeat starting while still hidden must not re-queue this
        // already-mounted retained handle behind the hidden prewarm pacer.
        visibility.tabSelected = false;
        act(() => {
          setPreviewDemand(true);
          rerender();
        });
        expect(result.current).toBe(prewarmedHandle);
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);

        act(() => {
          vi.advanceTimersByTime(PREWARM_INTERVAL_MS);
        });
        expect(result.current).toBe(prewarmedHandle);
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);

        // The tab becomes the pane's front tab, still mid-repeat.
        visibility.tabSelected = true;
        act(() => {
          rerender();
        });

        expect(result.current).toBe(prewarmedHandle);
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears a hidden neighbour's retained handle when the registry evicts it under byte pressure, and only requeues on the next repeat-settle edge, not immediately", () => {
      vi.useFakeTimers();
      try {
        visibility.paneVisible = true;
        visibility.tabSelected = false;
        const { result, rerender } = renderHook(
          () =>
            useChatSessionHandle(
              "chat-neighbour-evict",
              HOST_ID,
              true,
              "surface",
            ),
          { wrapper: QueryWrapper },
        );

        act(() => {
          vi.advanceTimersByTime(PREWARM_INTERVAL_MS);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);
        const prewarmedHandle = result.current;
        if (prewarmedHandle === null) throw new Error("expected a handle");

        // Hidden acquires are marked presented and released immediately, so
        // this is a lease-free warm entry - evictable like any other.
        const registry = __getChatSessionRegistryForTests();
        expect(registry.isTransient(prewarmedHandle)).toBe(false);

        act(() => {
          expect(registry.evictOldestEligibleForByteBudget()).toBe(true);
        });
        expect(
          registry.peek(EPIC_ID, "chat-neighbour-evict", HOST_ID),
        ).toBeNull();
        expect(result.current).toBeNull();

        // Not immediate: nothing re-queues until an effect dependency changes.
        act(() => {
          vi.advanceTimersByTime(5_000);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);

        // A repeat-settle edge re-runs the effect and requeues it.
        act(() => {
          setPreviewDemand(true);
          rerender();
        });
        act(() => {
          setPreviewDemand(false);
          rerender();
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);

        act(() => {
          vi.advanceTimersByTime(PREWARM_INTERVAL_MS);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(2);
        expect(streamFactorySpy).toHaveBeenLastCalledWith(
          EPIC_ID,
          "chat-neighbour-evict",
          expect.anything(),
        );
        expect(result.current).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("useChatPrewarmEligible (W4 R-A nearest-neighbour + preview)", () => {
    const VIEW_TAB_ID = "view-tab-prewarm";
    const PANE_ID = "pane-prewarm";
    const ACTIVE_INSTANCE_ID = "inst-active-nonchat";
    const NEAR_CHAT_INSTANCE_ID = "inst-chat-near";
    const FAR_CHAT_INSTANCE_ID = "inst-chat-far";

    let ownedHandles: ChatSessionStoreHandle[] = [];

    function makeHandle(chatId: string): ChatSessionStoreHandle {
      const handle = createChatSessionStore({
        environment: CHAT_STORE_TEST_ENVIRONMENT,
        hostId: HOST_ID,
        epicId: EPIC_ID,
        chatId,
        userId: null,
        onAuthError: null,
        onProviderAuthError: null,
        wakeTransport: null,
        streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
        streamClientFactory: () => ({
          sendAction: () => undefined,
          sameTurnSteeringProtocolSupported: () => true,
          draftBlobBridgeSupported: () => true,
          requestTranscriptRange: () => undefined,
          requestResnapshot: () => undefined,
          close: () => undefined,
        }),
      });
      ownedHandles.push(handle);
      return handle;
    }

    beforeEach(() => {
      // One pane: a non-chat active tab in front, a chat visited most
      // recently before it (the nearest hidden neighbour), and an older
      // retained chat further back in the MRU history.
      useEpicCanvasStore.setState({
        canvasByTabId: {
          [VIEW_TAB_ID]: {
            root: {
              kind: "pane",
              id: PANE_ID,
              tabInstanceIds: [
                ACTIVE_INSTANCE_ID,
                NEAR_CHAT_INSTANCE_ID,
                FAR_CHAT_INSTANCE_ID,
              ],
              activeTabId: ACTIVE_INSTANCE_ID,
              previewTabId: null,
              activationHistory: [
                ACTIVE_INSTANCE_ID,
                NEAR_CHAT_INSTANCE_ID,
                FAR_CHAT_INSTANCE_ID,
              ],
            },
            activePaneId: PANE_ID,
            tilesByInstanceId: {
              [ACTIVE_INSTANCE_ID]: {
                ...SPEC_A,
                instanceId: ACTIVE_INSTANCE_ID,
              },
              [NEAR_CHAT_INSTANCE_ID]: {
                ...CHAT_A,
                instanceId: NEAR_CHAT_INSTANCE_ID,
              },
              [FAR_CHAT_INSTANCE_ID]: {
                ...CHAT_A,
                instanceId: FAR_CHAT_INSTANCE_ID,
              },
            },
            sizesByGroupId: {},
          },
        },
      });
    });

    afterEach(() => {
      useEpicCanvasStore.setState({ canvasByTabId: {} });
      for (const handle of ownedHandles) handle.dispose();
      ownedHandles = [];
    });

    it("prepares a fresh, already-nearest handle only after its own settle window - a warm handle is not exempt", () => {
      vi.useFakeTimers();
      try {
        const nearHandle = makeHandle("chat-near");
        visibility.paneVisible = true;
        setPreviewDemand(false);

        const { result } = renderHook(() =>
          useChatPrewarmEligible(
            VIEW_TAB_ID,
            NEAR_CHAT_INSTANCE_ID,
            nearHandle,
          ),
        );
        expect(result.current).toBe(false);

        act(() => {
          vi.advanceTimersByTime(PREWARM_INTERVAL_MS - 1);
        });
        expect(result.current).toBe(false);

        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(result.current).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("only the nearest hidden chat ever prepares; an older retained sibling never does", () => {
      vi.useFakeTimers();
      try {
        const nearHandle = makeHandle("chat-near");
        const farHandle = makeHandle("chat-far");
        visibility.paneVisible = true;
        setPreviewDemand(false);

        const near = renderHook(() =>
          useChatPrewarmEligible(
            VIEW_TAB_ID,
            NEAR_CHAT_INSTANCE_ID,
            nearHandle,
          ),
        );
        const far = renderHook(() =>
          useChatPrewarmEligible(VIEW_TAB_ID, FAR_CHAT_INSTANCE_ID, farHandle),
        );

        act(() => {
          vi.advanceTimersByTime(PREWARM_INTERVAL_MS);
        });
        expect(near.result.current).toBe(true);
        expect(far.result.current).toBe(false);

        act(() => {
          vi.advanceTimersByTime(1_000);
        });
        expect(far.result.current).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels a not-yet-settled preparation the instant a preview starts, then - once already prepared - pauses and instantly resumes across a later preview, all on the same mounted hook", () => {
      vi.useFakeTimers();
      try {
        const nearHandle = makeHandle("chat-near");
        visibility.paneVisible = true;
        setPreviewDemand(false);

        const { result } = renderHook(() =>
          useChatPrewarmEligible(
            VIEW_TAB_ID,
            NEAR_CHAT_INSTANCE_ID,
            nearHandle,
          ),
        );
        expect(result.current).toBe(false);

        // A preview starting mid-interval cancels the pending preparation.
        act(() => {
          vi.advanceTimersByTime(80);
        });
        act(() => {
          setPreviewDemand(true);
        });
        expect(result.current).toBe(false);
        act(() => {
          vi.advanceTimersByTime(1_000);
        });
        expect(result.current).toBe(false);

        // Keyup: never having prepared, it needs a full fresh settle.
        act(() => {
          setPreviewDemand(false);
        });
        expect(result.current).toBe(false);
        act(() => {
          vi.advanceTimersByTime(PREWARM_INTERVAL_MS - 1);
        });
        expect(result.current).toBe(false);
        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(result.current).toBe(true);

        // Now genuinely prepared. A later repeat merely PAUSES it - no
        // pending timer to cancel, no re-settle needed on the way back.
        act(() => {
          setPreviewDemand(true);
        });
        expect(result.current).toBe(false);

        act(() => {
          setPreviewDemand(false);
        });
        expect(result.current).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a warm session moved from a visible tile to a hidden remount reuses its transport with no second factory call, and its row preparation still needs its own settle", () => {
      vi.useFakeTimers();
      try {
        visibility.paneVisible = true;
        visibility.tabSelected = true;
        const visibleMount = renderHook(
          () =>
            useChatSessionHandle("chat-warm-remount", HOST_ID, true, "surface"),
          { wrapper: QueryWrapper },
        );
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);
        const warmHandle = visibleMount.result.current;
        if (warmHandle === null) throw new Error("expected a handle");

        // Earn non-transient ("presented") status while still visible, so
        // the unmount below releases synchronously instead of deferring to
        // a microtask.
        act(() => {
          warmHandle.store.setState({ snapshotLoaded: true });
        });
        expect(__getChatSessionRegistryForTests().isTransient(warmHandle)).toBe(
          false,
        );

        visibleMount.unmount();
        expect(
          __getChatSessionRegistryForTests().peek(
            EPIC_ID,
            "chat-warm-remount",
            HOST_ID,
          ),
        ).toBe(warmHandle);

        // Hidden remount of the SAME warm chat: this new mount does not own
        // the handle yet, so its BODY acquisition is still paced through the
        // hidden prewarm queue - reusing the warm store costs a settle
        // window, even though it needs no second transport.
        visibility.tabSelected = false;
        const hiddenMount = renderHook(
          () =>
            useChatSessionHandle("chat-warm-remount", HOST_ID, true, "surface"),
          { wrapper: QueryWrapper },
        );
        expect(hiddenMount.result.current).toBeNull();
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);

        act(() => {
          vi.advanceTimersByTime(PREWARM_INTERVAL_MS);
        });
        expect(hiddenMount.result.current).toBe(warmHandle);
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);

        // The BODY still has to earn its own preparation - warmth on the
        // session plane buys it nothing on the row-rendering plane.
        setPreviewDemand(false);
        const eligible = renderHook(() =>
          useChatPrewarmEligible(
            VIEW_TAB_ID,
            NEAR_CHAT_INSTANCE_ID,
            warmHandle,
          ),
        );
        expect(eligible.result.current).toBe(false);

        act(() => {
          vi.advanceTimersByTime(PREWARM_INTERVAL_MS - 1);
        });
        expect(eligible.result.current).toBe(false);

        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(eligible.result.current).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
