import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { createFakeRunnerHost } from "../../../__tests__/create-fake-runner-host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeProvider } from "@/providers/windows-bridge-provider";
import { fileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";
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
import { emptyTabStripLayout } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { getTabSplitCompatibility } from "@/stores/tabs/tab-split-compatibility";
import {
  __resetEpicParkingForTests,
  isEpicParked,
} from "@/lib/epics/epic-parking";
import { __syncEpicParkingOpenTabsForTests } from "@/lib/epics/epic-parking-open-tabs";
import { __resetCrossWindowEpicVisibilityForTests } from "@/lib/epics/cross-window-epic-visibility";
import {
  isDocumentVisible,
  setDesktopWindowOnScreen,
} from "@/lib/dom/document-visibility";
import { RETRY_DELAYS_MS } from "@/lib/epics/bounded-retry";
import { setEpicSurfaceVisibility } from "@/lib/browser-view/tiles/surface-host-opened-tab";
import { PARK_HIDDEN_EPIC_AFTER_MS } from "@/stores/replica-memory/retention-profile";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  DesktopAuthSessionSnapshot,
  DesktopEpicVisibilityEntry,
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
  emitPerWindowSnapshot(snapshot: DesktopPerWindowSnapshot): void;
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
          return Promise.resolve({ outcome: "accepted" as const });
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
    emitPerWindowSnapshot: (snapshot) => {
      perWindowHandlers.forEach((handler) => handler(snapshot));
    },
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

function tabsStorageKey(): string {
  const name = useTabsStore.persist.getOptions().name;
  if (name === undefined)
    throw new Error("tabs persistence storage key missing");
  return name;
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

  it("fails closed when the capability handshake acknowledges an older revision", async () => {
    const fake = createDesktopWindowsBridge();
    const capabilities = {
      schemaVersion: 2,
      features: ["tab-strip-layout-v2", "active-route-v1"],
    } as const;
    const staleHandshakeBridge = {
      ...fake.bridge,
      perWindowState: {
        ...fake.bridge.perWindowState,
        get: () =>
          Promise.resolve({ ...emptyPerWindowSnapshot(), revision: 5 }),
        capabilities: () => Promise.resolve(capabilities),
        update: () => Promise.resolve({ capabilities, revision: 4 }),
      },
    } satisfies DesktopWindowsBridge;

    render(
      <RunnerHostProvider
        runnerHost={createRunnerHostWithWindows(staleHandshakeBridge)}
      >
        <WindowsBridgeProvider>
          <HydrationProbe />
        </WindowsBridgeProvider>
      </RunnerHostProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("hydration-state").textContent).toBe(
        "hydrated",
      );
    });
    expect(getTabSplitCompatibility().supported).toBe(false);
  });

  it("keeps a subscribed newer snapshot when the initial get resolves stale", async () => {
    const fake = createDesktopWindowsBridge();
    const deferredSnapshot = createDeferred<DesktopPerWindowSnapshot>();
    const capabilities = {
      schemaVersion: 2,
      features: ["tab-strip-layout-v2", "active-route-v1"],
    } as const;
    const racedBridge = {
      ...fake.bridge,
      perWindowState: {
        ...fake.bridge.perWindowState,
        get: () => deferredSnapshot.promise,
        capabilities: () => Promise.resolve(capabilities),
        update: () => Promise.resolve({ capabilities, revision: 3 }),
      },
    } satisfies DesktopWindowsBridge;

    render(
      <RunnerHostProvider runnerHost={createRunnerHostWithWindows(racedBridge)}>
        <WindowsBridgeProvider>
          <HydrationProbe />
        </WindowsBridgeProvider>
      </RunnerHostProvider>,
    );

    fake.emitPerWindowSnapshot({
      ...emptyPerWindowSnapshot(),
      revision: 2,
      epicTabs: [{ id: "tab-new", epicId: "epic-new", name: "New" }],
      activeTabId: "tab-new",
    });
    await act(async () => {
      deferredSnapshot.resolve({
        ...emptyPerWindowSnapshot(),
        revision: 1,
        epicTabs: [{ id: "tab-old", epicId: "epic-old", name: "Old" }],
        activeTabId: "tab-old",
      });
      await deferredSnapshot.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("hydration-state").textContent).toBe(
        "hydrated",
      );
    });
    expect(useEpicCanvasStore.getState().tabsById["tab-new"]).toBeDefined();
    expect(useEpicCanvasStore.getState().tabsById["tab-old"]).toBeUndefined();
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

    const storageKey = tabsStorageKey();
    window.localStorage.removeItem(storageKey);
    useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
    useTabsStore
      .getState()
      .setStripOrder([{ kind: "epic", id: "browser-tab" }]);
    expect(getTabSplitCompatibility().supported).toBe(true);
    expect(window.localStorage.getItem(storageKey)).not.toBeNull();
  });

  it("flushes file-edit recovery on pagehide/beforeunload without a desktop bridge (web path)", async () => {
    const flushRecoverySpy = vi
      .spyOn(fileEditRuntimeRegistry, "flushRecovery")
      .mockResolvedValue(undefined);

    render(
      <RunnerHostProvider runnerHost={createBaseRunnerHost()}>
        <WindowsBridgeProvider>
          <BridgeProbe onBridge={() => undefined} />
        </WindowsBridgeProvider>
      </RunnerHostProvider>,
    );

    expect((await screen.findByTestId("bridge-state")).textContent).toBe(
      "none",
    );

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(flushRecoverySpy).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event("beforeunload"));
    });
    expect(flushRecoverySpy).toHaveBeenCalledTimes(2);

    flushRecoverySpy.mockRestore();
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

// ── Renderer parking's cross-window channel, as the PROVIDER installs it ────
//
// `installCrossWindowEpicVisibility` is itself well pinned in
// `lib/epics/__tests__/epic-parking.test.ts` - which calls it DIRECTLY. That
// left the one line that ever calls it in production
// (`installDesktopWindowsBridge`) unpinned, and the gap is not cosmetic:
// deleting that call leaves every one of those tests green while the whole
// cross-window arm goes inert, so window A parks an Epic that is on screen in
// window B and nothing in the suite notices. Measured before these pins
// existed: the call replaced by a no-op teardown, 37/37 still passing.
//
// So these render the REAL provider and observe the channel from the far side
// of the bridge - the outbound report main receives, an inbound map deciding a
// real park, and the teardown - rather than asserting that some installer was
// called.

interface FakeEpicVisibilityChannel {
  readonly channel: NonNullable<DesktopWindowsBridge["epicVisibility"]>;
  /** Every roll-up this window pushed to main, in order. */
  readonly reports: ReadonlyArray<readonly string[]>;
  /** How many `onChange` subscriptions this channel has torn down. */
  readonly disposals: { count: number };
  /** Fan a per-window map back, as main does when any window's set changes. */
  emit(entries: readonly DesktopEpicVisibilityEntry[]): void;
}

function createEpicVisibilityChannel(
  snapshotEntries: readonly DesktopEpicVisibilityEntry[],
): FakeEpicVisibilityChannel {
  let handler:
    | ((entries: readonly DesktopEpicVisibilityEntry[]) => void)
    | null = null;
  const reports: Array<readonly string[]> = [];
  const disposals = { count: 0 };
  return {
    reports,
    disposals,
    channel: {
      report: (epicIds) => {
        reports.push([...epicIds]);
        return Promise.resolve();
      },
      snapshot: () => Promise.resolve(snapshotEntries),
      onChange: (nextHandler) => {
        handler = nextHandler;
        return {
          dispose: () => {
            disposals.count += 1;
            handler = null;
          },
        };
      },
    },
    emit: (entries) => handler?.(entries),
  };
}

/**
 * The shared fake bridge plus an `epicVisibility` channel. A separate composer
 * rather than a field on `createDesktopWindowsBridge`, so the rest of this file
 * keeps exercising the capability-PROBED shape (a preload built before the
 * channel existed has no such key) instead of silently gaining one.
 */
function bridgeWithEpicVisibility(
  handle: FakeWindowsBridgeHandle,
  visibility: FakeEpicVisibilityChannel,
): DesktopWindowsBridge {
  return { ...handle.bridge, epicVisibility: visibility.channel };
}

function openEpicTabForParking(tabId: string, epicId: string): void {
  useEpicCanvasStore.getState().openEpicTabWithId(tabId, epicId, epicId);
  __syncEpicParkingOpenTabsForTests();
}

describe("<WindowsBridgeProvider /> - renderer parking's cross-window channel", () => {
  const OWN_WINDOW_ID = "window-1";
  const OTHER_WINDOW_ID = "window-2";

  beforeEach(() => {
    resetStores();
    __resetEpicParkingForTests();
    __resetCrossWindowEpicVisibilityForTests();
  });

  afterEach(() => {
    cleanup();
    __resetEpicParkingForTests();
    __resetCrossWindowEpicVisibilityForTests();
    resetStores();
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it("pushes this window's own visible-Epic roll-up to the bridge at install", () => {
    const EPIC = "epic-provider-report";
    const VIEW = "view-provider-report";
    const fake = createDesktopWindowsBridge();
    const visibility = createEpicVisibilityChannel([]);
    // Showing BEFORE the provider mounts - a restored window mounts its
    // surfaces first, so this set arrives on no visibility edge and the
    // install-time push is the only thing that can carry it.
    setEpicSurfaceVisibility(EPIC, VIEW, true);

    try {
      render(
        <RunnerHostProvider
          runnerHost={createRunnerHostWithWindows(
            bridgeWithEpicVisibility(fake, visibility),
          )}
        >
          <WindowsBridgeProvider>
            <BridgeProbe onBridge={() => undefined} />
          </WindowsBridgeProvider>
        </RunnerHostProvider>,
      );

      // Synchronous: the install is a layout effect and `report()` is called
      // from it directly, so `render` returning is already past it. Not behind
      // an await, so a report that only ever happened on some later edge would
      // fail here rather than pass on a flush.
      expect(visibility.reports).toHaveLength(1);
      expect(visibility.reports[0]).toContain(EPIC);

      // And a later local edge is reported too, which is what keeps main's row
      // for this window from going stale while a pane is simply left open.
      act(() => {
        setEpicSurfaceVisibility(EPIC, VIEW, false);
      });
      expect(visibility.reports).toHaveLength(2);
      expect(visibility.reports[1]).not.toContain(EPIC);
    } finally {
      setEpicSurfaceVisibility(EPIC, VIEW, false);
    }
  });

  it("lets the inbound map decide a real park, in both directions", async () => {
    const FOREIGN_EPIC = "epic-provider-foreign-visible";
    const LOCAL_EPIC = "epic-provider-hidden-everywhere";
    const fake = createDesktopWindowsBridge();
    // The STARTUP read: main replayed its map on the preload's sync `windowId`
    // read, long before this effect subscribed, so `snapshot()` is the only
    // route by which "window-2 is showing FOREIGN_EPIC" can reach this window.
    const visibility = createEpicVisibilityChannel([
      { windowId: OTHER_WINDOW_ID, epicIds: [FOREIGN_EPIC] },
    ]);
    vi.useFakeTimers();

    render(
      <RunnerHostProvider
        runnerHost={createRunnerHostWithWindows(
          bridgeWithEpicVisibility(fake, visibility),
        )}
      >
        <WindowsBridgeProvider>
          <BridgeProbe onBridge={() => undefined} />
        </WindowsBridgeProvider>
      </RunnerHostProvider>,
    );
    // Flush the provider's own hydration AND the snapshot leg's `.then`. The
    // tabs are opened afterwards on purpose: hydration projects an empty
    // per-window snapshot onto the canvas store, which would close them.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Both hidden from birth, so both arm a park window immediately. The only
    // thing that differs between them is the cross-window map.
    act(() => {
      openEpicTabForParking("tab-provider-foreign", FOREIGN_EPIC);
      openEpicTabForParking("tab-provider-local", LOCAL_EPIC);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
    });

    // Both arms in ONE instance: same clock, same window, same code path -
    // the map is the whole difference.
    expect(isEpicParked(FOREIGN_EPIC)).toBe(false);
    expect(isEpicParked(LOCAL_EPIC)).toBe(true);

    // Now the live `onChange` leg, which is a second subscription and could be
    // dead while `snapshot()` works. Window 2 switches to the other Epic, and
    // THIS window's own row picks up the one it dropped - which must count for
    // nothing, since it is an echo of a fact this renderer knows first-hand.
    // The provider is the only thing that decides which id "own" means (it
    // hands `installCrossWindowEpicVisibility` the whole bridge, whose
    // `windowId` the install reads), so a provider passing the wrong window
    // would show up here as an Epic that never parks again.
    expect(fake.bridge.windowId).toBe(OWN_WINDOW_ID);
    act(() => {
      visibility.emit([
        { windowId: OWN_WINDOW_ID, epicIds: [FOREIGN_EPIC] },
        { windowId: OTHER_WINDOW_ID, epicIds: [LOCAL_EPIC] },
      ]);
    });

    // Synchronous, right after the fan-out: an Epic another window has just
    // put on screen is UNparked at once, not one window later.
    expect(isEpicParked(LOCAL_EPIC)).toBe(false);
    // And the Epic window 2 dropped is not parked yet either - it has only
    // just started its window, which is the other half of "the map decides".
    // (Its only remaining claimant is this window's OWN row, which is excluded
    // by `foreignVisibleEpics` - so what follows is a real park, not a
    // suppressed one.)
    expect(isEpicParked(FOREIGN_EPIC)).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
    });
    expect(isEpicParked(FOREIGN_EPIC)).toBe(true);
    expect(isEpicParked(LOCAL_EPIC)).toBe(false);
  });

  it("tears the channel down when the provider unmounts", async () => {
    const EPIC = "epic-provider-teardown";
    const fake = createDesktopWindowsBridge();
    const visibility = createEpicVisibilityChannel([
      { windowId: OTHER_WINDOW_ID, epicIds: [EPIC] },
    ]);
    vi.useFakeTimers();

    const view = render(
      <RunnerHostProvider
        runnerHost={createRunnerHostWithWindows(
          bridgeWithEpicVisibility(fake, visibility),
        )}
      >
        <WindowsBridgeProvider>
          <BridgeProbe onBridge={() => undefined} />
        </WindowsBridgeProvider>
      </RunnerHostProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      openEpicTabForParking("tab-provider-teardown", EPIC);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
    });
    expect(visibility.disposals.count).toBe(0);
    expect(isEpicParked(EPIC)).toBe(false);

    act(() => {
      view.unmount();
    });

    // The subscription is gone - a renderer with no channel must not keep
    // receiving fan-outs into module state nothing owns any more.
    expect(visibility.disposals.count).toBe(1);
    // And the ANSWER is gone with it, which is the part a dispose count cannot
    // see: the teardown publishes an empty map, so the Epic window 2 was
    // showing stops being a reason not to park and starts its own window.
    expect(isEpicParked(EPIC)).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
    });
    expect(isEpicParked(EPIC)).toBe(true);
  });
});

// ── Renderer parking's WINDOW-level input (fixup 5) ──────────────────────────
//
// The Page Visibility API is inert in the desktop app: every window runs with
// `backgroundThrottling: false`, which keeps `document.visibilityState` at
// "visible" through minimise and hide. So main pushes "is this window on
// screen" over `windows.windowVisibility`, and the provider is the one place
// that installs it. These pins render the REAL provider and drive the fake
// channel the way main does - a snapshot at install and `onChange` edges - and
// observe the two things the signal exists for: the park clock and the
// cross-window claim. Manually overwriting `document.visibilityState` (the
// other parking pins) cannot see this configuration mismatch, which is how the
// first cut of fixup 5 shipped inert on the desktop.

interface FakeWindowVisibilityChannel {
  readonly channel: NonNullable<DesktopWindowsBridge["windowVisibility"]>;
  readonly disposals: { count: number };
  readonly snapshotCalls: { count: number };
  emit(onScreen: boolean): void;
  /** Leave the NEXT snapshot unsettled until `settlePendingSnapshot`. */
  setSnapshotPending(): void;
  /** Reject the next `n` snapshots, then resolve with the configured value. */
  rejectNextSnapshots(n: number): void;
  settlePendingSnapshot(outcome: "resolve" | "reject", onScreen: boolean): void;
}

function createWindowVisibilityChannel(
  snapshotOnScreen: boolean,
): FakeWindowVisibilityChannel {
  let handler: ((onScreen: boolean) => void) | null = null;
  const disposals = { count: 0 };
  const snapshotCalls = { count: 0 };
  let pending = false;
  let rejectionsLeft = 0;
  let settle:
    | ((outcome: "resolve" | "reject", onScreen: boolean) => void)
    | null = null;
  return {
    disposals,
    snapshotCalls,
    setSnapshotPending: () => {
      pending = true;
    },
    rejectNextSnapshots: (n) => {
      rejectionsLeft = n;
    },
    settlePendingSnapshot: (outcome, onScreen) => {
      const current = settle;
      settle = null;
      current?.(outcome, onScreen);
    },
    channel: {
      snapshot: () => {
        snapshotCalls.count += 1;
        if (pending) {
          pending = false;
          return new Promise<boolean>((resolve, reject) => {
            settle = (outcome, onScreen) => {
              if (outcome === "resolve") resolve(onScreen);
              else reject(new Error("window visibility snapshot failed"));
            };
          });
        }
        if (rejectionsLeft > 0) {
          rejectionsLeft -= 1;
          return Promise.reject(new Error("window visibility snapshot failed"));
        }
        return Promise.resolve(snapshotOnScreen);
      },
      onChange: (nextHandler) => {
        handler = nextHandler;
        return {
          dispose: () => {
            disposals.count += 1;
            // Deliberately keeps `handler`: a late `emit` after dispose must
            // reach the installer, so the teardown pin exercises ITS guard
            // rather than this fake's.
          },
        };
      },
    },
    emit: (onScreen) => handler?.(onScreen),
  };
}

describe("<WindowsBridgeProvider /> - renderer parking's window visibility input", () => {
  const OWN_WINDOW_ID = "window-1";

  beforeEach(() => {
    resetStores();
    __resetEpicParkingForTests();
    __resetCrossWindowEpicVisibilityForTests();
    setDesktopWindowOnScreen(true);
  });

  afterEach(() => {
    cleanup();
    __resetEpicParkingForTests();
    __resetCrossWindowEpicVisibilityForTests();
    setDesktopWindowOnScreen(true);
    resetStores();
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it("a window minimised at install parks its on-screen epic and withdraws its cross-window claim; restore reverses both", async () => {
    const EPIC = "epic-provider-window-minimised";
    const VIEW = "view-provider-window-minimised";
    const fake = createDesktopWindowsBridge();
    const visibility = createEpicVisibilityChannel([]);
    // Main says this window is NOT on screen at install - the case the
    // snapshot leg exists for (main's replay fired before this effect
    // subscribed).
    const windowVisibility = createWindowVisibilityChannel(false);
    vi.useFakeTimers();
    // A pane placed and in front, as far as the tab host knows. Without the
    // window-level input this is "visible" forever.
    setEpicSurfaceVisibility(EPIC, VIEW, true);

    try {
      render(
        <RunnerHostProvider
          runnerHost={createRunnerHostWithWindows({
            ...bridgeWithEpicVisibility(fake, visibility),
            windowVisibility: windowVisibility.channel,
          })}
        >
          <WindowsBridgeProvider>
            <BridgeProbe onBridge={() => undefined} />
          </WindowsBridgeProvider>
        </RunnerHostProvider>,
      );
      // Before the snapshot resolves the document counts as visible, so the
      // install-time report carries the epic. The snapshot then flips the
      // gate, and the report leg re-runs on that edge with the empty set.
      expect(visibility.reports.at(-1)).toContain(EPIC);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(isDocumentVisible()).toBe(false);
      expect(visibility.reports.at(-1)).toEqual([]);

      act(() => {
        openEpicTabForParking("tab-provider-window-minimised", EPIC);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      });
      expect(fake.bridge.windowId).toBe(OWN_WINDOW_ID);
      expect(isEpicParked(EPIC)).toBe(true);

      // Restore: main pushes `true`; the epic is unparked at once and the
      // claim goes back out.
      act(() => {
        windowVisibility.emit(true);
      });
      expect(isDocumentVisible()).toBe(true);
      expect(isEpicParked(EPIC)).toBe(false);
      expect(visibility.reports.at(-1)).toContain(EPIC);

      // Minimise again: a fresh window, not an instant park.
      act(() => {
        windowVisibility.emit(false);
      });
      expect(isEpicParked(EPIC)).toBe(false);
      expect(visibility.reports.at(-1)).toEqual([]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      });
      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      setEpicSurfaceVisibility(EPIC, VIEW, false);
    }
  });

  it("without the channel (an older preload) the window counts as on screen and a placed pane never parks", async () => {
    const EPIC = "epic-provider-window-no-channel";
    const VIEW = "view-provider-window-no-channel";
    const fake = createDesktopWindowsBridge();
    const visibility = createEpicVisibilityChannel([]);
    vi.useFakeTimers();
    setEpicSurfaceVisibility(EPIC, VIEW, true);
    try {
      render(
        <RunnerHostProvider
          runnerHost={createRunnerHostWithWindows(
            bridgeWithEpicVisibility(fake, visibility),
          )}
        >
          <WindowsBridgeProvider>
            <BridgeProbe onBridge={() => undefined} />
          </WindowsBridgeProvider>
        </RunnerHostProvider>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      act(() => {
        openEpicTabForParking("tab-provider-window-no-channel", EPIC);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      });
      expect(isDocumentVisible()).toBe(true);
      expect(isEpicParked(EPIC)).toBe(false);
    } finally {
      setEpicSurfaceVisibility(EPIC, VIEW, false);
    }
  });

  it("tears the channel down and forgets a stale 'hidden' when the provider unmounts", async () => {
    const fake = createDesktopWindowsBridge();
    const visibility = createEpicVisibilityChannel([]);
    const windowVisibility = createWindowVisibilityChannel(false);
    vi.useFakeTimers();
    const view = render(
      <RunnerHostProvider
        runnerHost={createRunnerHostWithWindows({
          ...bridgeWithEpicVisibility(fake, visibility),
          windowVisibility: windowVisibility.channel,
        })}
      >
        <WindowsBridgeProvider>
          <BridgeProbe onBridge={() => undefined} />
        </WindowsBridgeProvider>
      </RunnerHostProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(isDocumentVisible()).toBe(false);
    expect(windowVisibility.disposals.count).toBe(0);

    act(() => {
      view.unmount();
    });

    expect(windowVisibility.disposals.count).toBe(1);
    // A late edge from the retired channel must not land either.
    windowVisibility.emit(false);
    expect(isDocumentVisible()).toBe(true);
  });

  // ── The startup read is OLDER than any event that lands while it is in
  // flight (Codex re-review of 343f6cc0b9, P1) ───────────────────────────────
  //
  // Main answers the snapshot from what the window looked like when the invoke
  // arrived; an `onChange` that lands before the answer does is newer. Applying
  // the answer afterwards puts the older fact back, in BOTH directions: a late
  // `false` over a restore parks an epic the user is looking at, a late `true`
  // over a minimise un-hides one. The ordinary pins resolve the snapshot
  // immediately and so never exercise this ordering.
  it("a snapshot that resolves AFTER a newer restore event does not re-hide the window", async () => {
    const EPIC = "epic-provider-late-snapshot-false";
    const VIEW = "view-provider-late-snapshot-false";
    const fake = createDesktopWindowsBridge();
    const visibility = createEpicVisibilityChannel([]);
    const windowVisibility = createWindowVisibilityChannel(false);
    windowVisibility.setSnapshotPending();
    vi.useFakeTimers();
    setEpicSurfaceVisibility(EPIC, VIEW, true);
    try {
      render(
        <RunnerHostProvider
          runnerHost={createRunnerHostWithWindows({
            ...bridgeWithEpicVisibility(fake, visibility),
            windowVisibility: windowVisibility.channel,
          })}
        >
          <WindowsBridgeProvider>
            <BridgeProbe onBridge={() => undefined} />
          </WindowsBridgeProvider>
        </RunnerHostProvider>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // The newer fact: the window is on screen.
      act(() => {
        windowVisibility.emit(true);
      });
      // The older fact arrives late.
      await act(async () => {
        windowVisibility.settlePendingSnapshot("resolve", false);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(isDocumentVisible()).toBe(true);
      act(() => {
        openEpicTabForParking("tab-provider-late-snapshot-false", EPIC);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      });
      expect(isEpicParked(EPIC)).toBe(false);
      expect(visibility.reports.at(-1)).toContain(EPIC);
    } finally {
      setEpicSurfaceVisibility(EPIC, VIEW, false);
    }
  });

  it("a snapshot that resolves AFTER a newer minimise event does not un-hide the window", async () => {
    const EPIC = "epic-provider-late-snapshot-true";
    const VIEW = "view-provider-late-snapshot-true";
    const fake = createDesktopWindowsBridge();
    const visibility = createEpicVisibilityChannel([]);
    const windowVisibility = createWindowVisibilityChannel(true);
    windowVisibility.setSnapshotPending();
    vi.useFakeTimers();
    setEpicSurfaceVisibility(EPIC, VIEW, true);
    try {
      render(
        <RunnerHostProvider
          runnerHost={createRunnerHostWithWindows({
            ...bridgeWithEpicVisibility(fake, visibility),
            windowVisibility: windowVisibility.channel,
          })}
        >
          <WindowsBridgeProvider>
            <BridgeProbe onBridge={() => undefined} />
          </WindowsBridgeProvider>
        </RunnerHostProvider>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      act(() => {
        windowVisibility.emit(false);
      });
      await act(async () => {
        windowVisibility.settlePendingSnapshot("resolve", true);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(isDocumentVisible()).toBe(false);
      expect(visibility.reports.at(-1)).toEqual([]);
      act(() => {
        openEpicTabForParking("tab-provider-late-snapshot-true", EPIC);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      });
      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      setEpicSurfaceVisibility(EPIC, VIEW, false);
    }
  });

  // ── A transient snapshot failure is retried, because "the next edge" never
  // comes for a window minimised at startup and left alone (P2) ──────────────
  it("retries a failed startup snapshot and reclaims a quiet minimised window without any further edge", async () => {
    const EPIC = "epic-provider-snapshot-retry";
    const VIEW = "view-provider-snapshot-retry";
    const fake = createDesktopWindowsBridge();
    const visibility = createEpicVisibilityChannel([]);
    const windowVisibility = createWindowVisibilityChannel(false);
    windowVisibility.rejectNextSnapshots(1);
    vi.useFakeTimers();
    setEpicSurfaceVisibility(EPIC, VIEW, true);
    try {
      render(
        <RunnerHostProvider
          runnerHost={createRunnerHostWithWindows({
            ...bridgeWithEpicVisibility(fake, visibility),
            windowVisibility: windowVisibility.channel,
          })}
        >
          <WindowsBridgeProvider>
            <BridgeProbe onBridge={() => undefined} />
          </WindowsBridgeProvider>
        </RunnerHostProvider>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // The first read failed; nothing has moved yet, and nothing ever will
      // from main's side - the window just sits minimised.
      expect(windowVisibility.snapshotCalls.count).toBe(1);
      expect(isDocumentVisible()).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
      });
      expect(windowVisibility.snapshotCalls.count).toBe(2);
      expect(isDocumentVisible()).toBe(false);
      expect(visibility.reports.at(-1)).toEqual([]);
      act(() => {
        openEpicTabForParking("tab-provider-snapshot-retry", EPIC);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      });
      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      setEpicSurfaceVisibility(EPIC, VIEW, false);
    }
  });

  it("an event arriving while the snapshot is being retried stops the retry, and a snapshot still pending at teardown is ignored however it settles", async () => {
    const fake = createDesktopWindowsBridge();
    const visibility = createEpicVisibilityChannel([]);
    const windowVisibility = createWindowVisibilityChannel(false);
    windowVisibility.rejectNextSnapshots(1);
    vi.useFakeTimers();
    render(
      <RunnerHostProvider
        runnerHost={createRunnerHostWithWindows({
          ...bridgeWithEpicVisibility(fake, visibility),
          windowVisibility: windowVisibility.channel,
        })}
      >
        <WindowsBridgeProvider>
          <BridgeProbe onBridge={() => undefined} />
        </WindowsBridgeProvider>
      </RunnerHostProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(windowVisibility.snapshotCalls.count).toBe(1);
    // The fact arrives by the better route while the retry timer is armed.
    act(() => {
      windowVisibility.emit(false);
    });
    expect(isDocumentVisible()).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] * 2);
    });
    // No second read once the fact arrived by the better route. Behavioural
    // coverage, NOT a discriminator for `snapshotLeg.cancel()` in the
    // `onChange` handler: ablating that call leaves this green, because the
    // supersession flag already makes the retried attempt return before it
    // reads. The cancel is kept for the timer it clears.
    expect(windowVisibility.snapshotCalls.count).toBe(1);
    cleanup();
    setDesktopWindowOnScreen(true);
    __resetEpicParkingForTests();
    __resetCrossWindowEpicVisibilityForTests();

    // Second half: a snapshot still in flight when the provider unmounts.
    for (const outcome of ["resolve", "reject"] as const) {
      const late = createWindowVisibilityChannel(false);
      late.setSnapshotPending();
      const view = render(
        <RunnerHostProvider
          runnerHost={createRunnerHostWithWindows({
            ...bridgeWithEpicVisibility(
              createDesktopWindowsBridge(),
              createEpicVisibilityChannel([]),
            ),
            windowVisibility: late.channel,
          })}
        >
          <WindowsBridgeProvider>
            <BridgeProbe onBridge={() => undefined} />
          </WindowsBridgeProvider>
        </RunnerHostProvider>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      act(() => {
        view.unmount();
      });
      const timersAfterUnmount = vi.getTimerCount();
      await act(async () => {
        late.settlePendingSnapshot(outcome, false);
        // Microtasks only: the settle runs the leg's `.then`/`.catch`.
        await vi.advanceTimersByTimeAsync(0);
      });
      // The discriminator for teardown's `snapshotLeg.cancel()` (Codex on
      // 7f3f67441): a rejection after teardown must not ARM a retry timer.
      // Asserted on the timer count before the backoff elapses, because a
      // stray retry that does fire returns at `snapshotSuperseded()` before
      // it reads, leaving `snapshotCalls` unchanged - so the count below is
      // not evidence about the cancel, only this line is.
      expect(vi.getTimerCount(), `late ${outcome} armed a retry`).toBe(
        timersAfterUnmount,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] * 2);
      });
      expect(isDocumentVisible(), `late ${outcome} after teardown`).toBe(true);
      expect(late.snapshotCalls.count, `late ${outcome} retries`).toBe(1);
      cleanup();
      setDesktopWindowOnScreen(true);
      __resetEpicParkingForTests();
      __resetCrossWindowEpicVisibilityForTests();
    }
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
