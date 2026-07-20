import "../../../__tests__/test-browser-apis";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { createFakeRunnerHost } from "../../../__tests__/create-fake-runner-host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeProvider } from "@/providers/windows-bridge-provider";
import {
  useWindowsBridge,
  useWindowsBridgeHydrated,
} from "@/providers/windows-bridge-context";
import {
  getDesktopEpicOwnershipBridge,
  setDesktopEpicOwnershipBridge,
} from "@/lib/windows/desktop-epic-ownership";
import {
  DESKTOP_PER_WINDOW_PROJECTION_DEBOUNCE_MS,
  flushActiveDesktopPerWindowProjection,
  setActiveDesktopPerWindowProjectionBridge,
} from "@/lib/windows/per-window-projection-debounce";
import {
  setEpicCanvasDesktopProjectionBridge,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import {
  emptyLandingDraftWorkspaceSnapshot,
  EMPTY_LANDING_DRAFT_CONTENT,
  setLandingDraftDesktopProjectionBridge,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  DesktopAuthSessionSnapshot,
  DesktopJsonValue,
  DesktopOwnershipEntry,
  DesktopPerWindowSnapshot,
  DesktopPerWindowStatePatch,
  DesktopWindowSummary,
  DesktopWindowsBridge,
} from "@/lib/windows/types";

interface FakeWindowsBridgeHandle {
  readonly bridge: DesktopWindowsBridge;
  readonly perWindowUpdates: readonly DesktopPerWindowStatePatch[];
  readonly authSessionSets: readonly DesktopAuthSessionSnapshot[];
}

function createDesktopWindowsBridge(): FakeWindowsBridgeHandle {
  const perWindowUpdates: DesktopPerWindowStatePatch[] = [];
  const authSessionSets: DesktopAuthSessionSnapshot[] = [];
  const windowsHandlers = new Set<
    (windows: readonly DesktopWindowSummary[]) => void
  >();
  const ownershipHandlers = new Set<
    (entries: readonly DesktopOwnershipEntry[]) => void
  >();
  const perWindowHandlers = new Set<
    (snapshot: DesktopPerWindowSnapshot) => void
  >();
  const authSessionHandlers = new Set<
    (snapshot: DesktopAuthSessionSnapshot) => void
  >();

  return {
    bridge: {
      windowId: "window-1",
      list: () => Promise.resolve([]),
      onChange: (handler) => {
        windowsHandlers.add(handler);
        return {
          dispose: () => {
            windowsHandlers.delete(handler);
          },
        };
      },
      requestNew: () => Promise.resolve(),
      requestFocus: () => Promise.resolve(),
      requestClose: () => Promise.resolve(),
      requestOpenEpicInNewWindow: () =>
        Promise.resolve({
          result: "moved" as const,
          windowId: "window-2",
        }),
      ownership: {
        snapshot: () => Promise.resolve([]),
        claim: () => Promise.resolve({ ok: true as const }),
        release: () => Promise.resolve(),
        onChange: (handler) => {
          ownershipHandlers.add(handler);
          return {
            dispose: () => {
              ownershipHandlers.delete(handler);
            },
          };
        },
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
          perWindowUpdates.push(patch);
          return Promise.resolve();
        },
        onChange: (handler) => {
          perWindowHandlers.add(handler);
          return {
            dispose: () => {
              perWindowHandlers.delete(handler);
            },
          };
        },
      },
      authSession: {
        get: () =>
          Promise.resolve({
            status: "signed-out" as const,
            token: null,
            profile: null,
          }),
        set: (snapshot) => {
          authSessionSets.push(snapshot);
          return Promise.resolve();
        },
        onChange: (handler) => {
          authSessionHandlers.add(handler);
          return {
            dispose: () => {
              authSessionHandlers.delete(handler);
            },
          };
        },
      },
    },
    perWindowUpdates,
    authSessionSets,
  };
}

function createBaseRunnerHost(): IRunnerHost {
  return createFakeRunnerHost({
    // The bridge provider hydrates its local-host state off this callback, so
    // (unlike the other renderer/bridge tests sharing this factory) it must
    // fire synchronously with "no local host" rather than staying a no-op.
    onLocalHostChange: (handler) => {
      handler(null);
      return { dispose: () => undefined };
    },
  });
}

function createRunnerHostWithWindows(value: unknown): IRunnerHost {
  return Object.assign(createBaseRunnerHost(), { windows: value });
}

function BridgeProbe(props: {
  readonly onBridge: (bridge: DesktopWindowsBridge | null) => void;
}) {
  const bridge = useWindowsBridge();
  useEffect(() => {
    props.onBridge(bridge);
  }, [bridge, props]);
  return <div data-testid="bridge-state">{bridge?.windowId ?? "none"}</div>;
}

function HydrationProbe() {
  const hasHydrated = useWindowsBridgeHydrated();
  return (
    <div data-testid="hydration-state">
      {hasHydrated ? "hydrated" : "pending"}
    </div>
  );
}

function createDeferred<T>() {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value: T): void => {
      if (resolvePromise === null) {
        throw new Error("Deferred promise was not initialized");
      }
      resolvePromise(value);
    },
  };
}

function emptyPerWindowSnapshot(): DesktopPerWindowSnapshot {
  return {
    epicTabs: [],
    activeTabId: null,
    canvasByTabId: {},
    landingDrafts: [],
    activeLandingDraftId: null,
  };
}

function landingTextContent(text: string): JsonContent {
  if (text.length === 0) return EMPTY_LANDING_DRAFT_CONTENT;
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

// The desktop projection carries `content` as opaque `DesktopJsonValue`; this
// mirrors `landingTextContent` in that shape so round-trip assertions can
// compare the projected content by value.
function landingDesktopContent(text: string): DesktopJsonValue {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

describe("<WindowsBridgeProvider />", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    cleanup();
    resetStores();
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it("resolves a desktop bridge only when ownership claim/release are exposed", async () => {
    const fake = createDesktopWindowsBridge();
    const observed: Array<DesktopWindowsBridge | null> = [];

    render(
      <RunnerHostProvider runnerHost={createRunnerHostWithWindows(fake.bridge)}>
        <WindowsBridgeProvider>
          <BridgeProbe
            onBridge={(bridge) => {
              observed.push(bridge);
            }}
          />
        </WindowsBridgeProvider>
      </RunnerHostProvider>,
    );

    expect((await screen.findByTestId("bridge-state")).textContent).toBe(
      "window-1",
    );
    await waitFor(() => {
      expect(observed.at(-1)).toBe(fake.bridge);
      expect(getDesktopEpicOwnershipBridge()).toBe(fake.bridge);
    });
  });

  it("does not replay legacy localStorage migration from renderer bootstrap", async () => {
    const fake = createDesktopWindowsBridge();
    window.localStorage.setItem(
      "traycer-gui-app:epic-canvas:anon",
      JSON.stringify({
        state: {
          openEpicTabs: [{ id: "epic-a", name: "Alpha" }],
          activeEpicId: "epic-a",
        },
      }),
    );
    window.localStorage.setItem(
      "traycer-gui-app:draft",
      JSON.stringify({
        state: {
          draft: { id: "draft-a", prompt: "Continue the plan" },
        },
      }),
    );

    render(
      <RunnerHostProvider runnerHost={createRunnerHostWithWindows(fake.bridge)}>
        <WindowsBridgeProvider>
          <BridgeProbe onBridge={() => undefined} />
        </WindowsBridgeProvider>
      </RunnerHostProvider>,
    );

    expect((await screen.findByTestId("bridge-state")).textContent).toBe(
      "window-1",
    );
    expect(fake.perWindowUpdates).toEqual([]);
    expect(
      window.localStorage.getItem("traycer-gui-app:epic-canvas:anon"),
    ).not.toBeNull();
    expect(window.localStorage.getItem("traycer-gui-app:draft")).not.toBeNull();
  });

  it("keeps desktop hydration pending until the per-window snapshot is applied", async () => {
    const fake = createDesktopWindowsBridge();
    const deferredSnapshot = createDeferred<DesktopPerWindowSnapshot>();
    const delayedBridge = {
      ...fake.bridge,
      perWindowState: {
        ...fake.bridge.perWindowState,
        get: () => deferredSnapshot.promise,
      },
    } satisfies DesktopWindowsBridge;

    render(
      <RunnerHostProvider
        runnerHost={createRunnerHostWithWindows(delayedBridge)}
      >
        <WindowsBridgeProvider>
          <HydrationProbe />
        </WindowsBridgeProvider>
      </RunnerHostProvider>,
    );

    expect(screen.getByTestId("hydration-state").textContent).toBe("pending");

    await act(async () => {
      deferredSnapshot.resolve(emptyPerWindowSnapshot());
      await deferredSnapshot.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("hydration-state").textContent).toBe(
        "hydrated",
      );
    });
  });

  it("still marks hydration complete when the per-window snapshot fetch rejects", async () => {
    const fake = createDesktopWindowsBridge();
    const failingBridge = {
      ...fake.bridge,
      perWindowState: {
        ...fake.bridge.perWindowState,
        get: () => Promise.reject(new Error("perWindowState.get failed")),
      },
    } satisfies DesktopWindowsBridge;

    render(
      <RunnerHostProvider
        runnerHost={createRunnerHostWithWindows(failingBridge)}
      >
        <WindowsBridgeProvider>
          <HydrationProbe />
        </WindowsBridgeProvider>
      </RunnerHostProvider>,
    );

    expect(screen.getByTestId("hydration-state").textContent).toBe("pending");

    await waitFor(() => {
      expect(screen.getByTestId("hydration-state").textContent).toBe(
        "hydrated",
      );
    });
    expect(fake.perWindowUpdates).toEqual([]);
  });

  it("does not write the restored per-window snapshot back during first hydration", async () => {
    vi.useFakeTimers();
    const fake = createDesktopWindowsBridge();
    const restoredSnapshot = {
      epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
      activeTabId: "tab-a",
      canvasByTabId: { "tab-a": { layout: "restored" } },
      landingDrafts: [
        {
          id: "draft-a",
          content: landingDesktopContent("Continue restored work"),
          selection: null,
          lastTouchedAt: 1,
          settings: null,
          composerMode: null,
          workspace: null,
        },
      ],
      activeLandingDraftId: "draft-a",
    } satisfies DesktopPerWindowSnapshot;
    const restoredBridge = {
      ...fake.bridge,
      perWindowState: {
        ...fake.bridge.perWindowState,
        get: () => Promise.resolve(restoredSnapshot),
      },
    } satisfies DesktopWindowsBridge;

    render(
      <RunnerHostProvider
        runnerHost={createRunnerHostWithWindows(restoredBridge)}
      >
        <WindowsBridgeProvider>
          <HydrationProbe />
        </WindowsBridgeProvider>
      </RunnerHostProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("hydration-state").textContent).toBe("hydrated");
    expect(fake.perWindowUpdates).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        DESKTOP_PER_WINDOW_PROJECTION_DEBOUNCE_MS,
      );
    });

    expect(fake.perWindowUpdates).toEqual([]);
  });

  it("keeps the non-desktop fallback when ownership claim/release are missing", async () => {
    const fake = createDesktopWindowsBridge();
    const incompleteBridge = {
      windowId: fake.bridge.windowId,
      list: () => fake.bridge.list(),
      onChange: (handler: Parameters<typeof fake.bridge.onChange>[0]) =>
        fake.bridge.onChange(handler),
      requestNew: (route: string) => fake.bridge.requestNew(route),
      requestFocus: (windowId: string) => fake.bridge.requestFocus(windowId),
      requestClose: (windowId: string) => fake.bridge.requestClose(windowId),
      requestOpenEpicInNewWindow: (
        epicId: string,
        title: string,
        tabId: string,
      ) => fake.bridge.requestOpenEpicInNewWindow(epicId, title, tabId),
      ownership: {
        snapshot: () => fake.bridge.ownership.snapshot(),
        onChange: (
          handler: Parameters<typeof fake.bridge.ownership.onChange>[0],
        ) => fake.bridge.ownership.onChange(handler),
      },
      perWindowState: fake.bridge.perWindowState,
      authSession: fake.bridge.authSession,
    };
    const observed: Array<DesktopWindowsBridge | null> = [];

    render(
      <RunnerHostProvider
        runnerHost={createRunnerHostWithWindows(incompleteBridge)}
      >
        <WindowsBridgeProvider>
          <BridgeProbe
            onBridge={(bridge) => {
              observed.push(bridge);
            }}
          />
        </WindowsBridgeProvider>
      </RunnerHostProvider>,
    );

    expect((await screen.findByTestId("bridge-state")).textContent).toBe(
      "none",
    );
    expect(observed.at(-1)).toBeNull();
    expect(getDesktopEpicOwnershipBridge()).toBeNull();
  });

  it("coalesces bursty desktop per-window projections into one bridge write", async () => {
    const fake = createDesktopWindowsBridge();
    render(
      <RunnerHostProvider runnerHost={createRunnerHostWithWindows(fake.bridge)}>
        <WindowsBridgeProvider>
          <BridgeProbe onBridge={() => undefined} />
        </WindowsBridgeProvider>
      </RunnerHostProvider>,
    );
    expect((await screen.findByTestId("bridge-state")).textContent).toBe(
      "window-1",
    );

    vi.useFakeTimers();
    let draftId = "";
    let tabId = "";
    act(() => {
      tabId = useEpicCanvasStore.getState().openEpicTab("epic-a", "A");
      useEpicCanvasStore.getState().renameTab(tabId, "A Prime");
      draftId = useLandingDraftStore.getState().createDraft(null);
      useLandingDraftStore
        .getState()
        .setDraftContent(draftId, landingTextContent("first prompt"), null);
    });

    expect(fake.perWindowUpdates).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        DESKTOP_PER_WINDOW_PROJECTION_DEBOUNCE_MS,
      );
    });

    expect(fake.perWindowUpdates).toHaveLength(1);
    const firstUpdate = fake.perWindowUpdates[0];
    expect(firstUpdate.epicTabs).toEqual([
      { id: tabId, epicId: "epic-a", name: "A Prime" },
    ]);
    expect(firstUpdate.activeTabId).toBe(tabId);
    expect(firstUpdate.landingDrafts?.map((draft) => draft.content)).toEqual([
      landingDesktopContent("first prompt"),
    ]);
  });

  it("keeps the latest state when multiple projections land in one debounce window", async () => {
    const fake = createDesktopWindowsBridge();
    render(
      <RunnerHostProvider runnerHost={createRunnerHostWithWindows(fake.bridge)}>
        <WindowsBridgeProvider>
          <BridgeProbe onBridge={() => undefined} />
        </WindowsBridgeProvider>
      </RunnerHostProvider>,
    );
    expect((await screen.findByTestId("bridge-state")).textContent).toBe(
      "window-1",
    );

    vi.useFakeTimers();
    let draftId = "";
    let tabA = "";
    let tabB = "";
    act(() => {
      tabA = useEpicCanvasStore.getState().openEpicTab("epic-a", "A");
      tabB = useEpicCanvasStore.getState().openEpicTab("epic-b", "B");
      draftId = useLandingDraftStore.getState().createDraft(null);
      useLandingDraftStore
        .getState()
        .setDraftContent(draftId, landingTextContent("old prompt"), null);
      useLandingDraftStore
        .getState()
        .setDraftContent(draftId, landingTextContent("new prompt"), null);
      expect(draftId.length).toBeGreaterThan(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        DESKTOP_PER_WINDOW_PROJECTION_DEBOUNCE_MS,
      );
    });

    expect(fake.perWindowUpdates).toHaveLength(1);
    const latestUpdate = fake.perWindowUpdates[0];
    expect(latestUpdate.epicTabs).toEqual([
      { id: tabA, epicId: "epic-a", name: "A" },
      { id: tabB, epicId: "epic-b", name: "B" },
    ]);
    expect(latestUpdate.activeTabId).toBe(tabB);
    // `lastTouchedAt` is a live `Date.now()` stamp; substitute the actual value
    // so `toEqual` stays strict on the deterministic fields without an
    // `expect.any` `any`-typed literal (repo lint forbids the unsafe assignment).
    const latestDrafts = latestUpdate.landingDrafts;
    expect(latestDrafts).toEqual([
      {
        id: draftId,
        content: landingDesktopContent("new prompt"),
        selection: null,
        lastTouchedAt: latestDrafts?.[0].lastTouchedAt,
        settings: null,
        composerMode: "chat",
        workspace: emptyLandingDraftWorkspaceSnapshot(),
      },
    ]);
    expect(typeof latestDrafts?.[0].lastTouchedAt).toBe("number");
    expect(latestUpdate.activeLandingDraftId).toBeDefined();
  });

  it("flushes the final debounced projection before teardown-sensitive boundaries", async () => {
    const fake = createDesktopWindowsBridge();
    render(
      <RunnerHostProvider runnerHost={createRunnerHostWithWindows(fake.bridge)}>
        <WindowsBridgeProvider>
          <BridgeProbe onBridge={() => undefined} />
        </WindowsBridgeProvider>
      </RunnerHostProvider>,
    );
    expect((await screen.findByTestId("bridge-state")).textContent).toBe(
      "window-1",
    );

    vi.useFakeTimers();
    let draftId = "";
    let tabA = "";
    let tabB = "";
    act(() => {
      tabA = useEpicCanvasStore.getState().openEpicTab("epic-a", "A");
      tabB = useEpicCanvasStore.getState().openEpicTab("epic-b", "B");
      draftId = useLandingDraftStore.getState().createDraft(null);
      useLandingDraftStore
        .getState()
        .setDraftContent(draftId, landingTextContent("final prompt"), null);
    });

    await act(async () => {
      await flushActiveDesktopPerWindowProjection();
    });

    expect(fake.perWindowUpdates).toHaveLength(1);
    const flushedUpdate = fake.perWindowUpdates[0];
    expect(flushedUpdate.epicTabs).toEqual([
      { id: tabA, epicId: "epic-a", name: "A" },
      { id: tabB, epicId: "epic-b", name: "B" },
    ]);
    expect(flushedUpdate.activeTabId).toBe(tabB);
    const flushedDrafts = flushedUpdate.landingDrafts;
    expect(flushedDrafts).toEqual([
      {
        id: draftId,
        content: landingDesktopContent("final prompt"),
        selection: null,
        lastTouchedAt: flushedDrafts?.[0].lastTouchedAt,
        settings: null,
        composerMode: "chat",
        workspace: emptyLandingDraftWorkspaceSnapshot(),
      },
    ]);
    expect(typeof flushedDrafts?.[0].lastTouchedAt).toBe("number");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        DESKTOP_PER_WINDOW_PROJECTION_DEBOUNCE_MS,
      );
    });
    expect(fake.perWindowUpdates).toHaveLength(1);
  });
});

function resetStores(): void {
  setEpicCanvasDesktopProjectionBridge(null);
  setLandingDraftDesktopProjectionBridge(null);
  setActiveDesktopPerWindowProjectionBridge(null);
  setDesktopEpicOwnershipBridge(null);
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
}
