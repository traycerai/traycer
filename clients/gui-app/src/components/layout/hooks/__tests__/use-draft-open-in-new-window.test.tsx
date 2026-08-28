/**
 * `useDraftOpenInNewWindowFlow` - the draft-move sibling of
 * `use-epic-open-in-new-window-t10-adapter.test.tsx`, driven the same way
 * (a real `useTabsStore`/`useLandingDraftStore`, a controllable
 * `DesktopWindowsBridge`, the real hook rendered via `RouterProvider`), but
 * without the epic flow's ownership/split-adapter machinery - a draft has no
 * ownership registry and no unsynced-edits gate. `landing-image-move.ts` is
 * mocked (`vi.mock`) so this suite never touches IndexedDB; that module's
 * own contract is covered separately in
 * `src/lib/composer/__tests__/landing-image-move.test.ts`.
 */
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  useDraftOpenInNewWindowFlow,
  type DraftNewWindowFlow,
} from "@/components/layout/hooks/use-draft-open-in-new-window";
import { draftPathname } from "@/lib/routes";
import type {
  DesktopOpenDraftInNewWindowResult,
  DesktopOwnershipClaimResult,
  DesktopPerWindowSnapshot,
  DesktopWindowsBridge,
} from "@/lib/windows/types";
import {
  discardDraftImageHandoff,
  draftHasIngestingImages,
  stageDraftImageHandoff,
} from "@/lib/composer/landing-image-move";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

vi.mock("@/lib/composer/landing-image-move", () => ({
  draftImageHashes: vi.fn(() => []),
  draftHasIngestingImages: vi.fn(() => false),
  stageDraftImageHandoff: vi.fn(() => Promise.resolve()),
  discardDraftImageHandoff: vi.fn(() => Promise.resolve()),
  adoptDraftImageHandoff: vi.fn(() => Promise.resolve()),
}));

function emptySnapshot(): DesktopPerWindowSnapshot {
  return {
    epicTabs: [],
    activeTabId: null,
    canvasByTabId: {},
    landingDrafts: [],
    activeLandingDraftId: null,
    tabStripLayout: null,
    activeRoute: null,
  };
}

/** Base bridge surface the draft flow never reads (ownership/perWindowState/
 * authSession/requestOpenEpicInNewWindow) - present only to satisfy the
 * `DesktopWindowsBridge` type. */
function baseBridgeFields(): Omit<
  DesktopWindowsBridge,
  "windowId" | "requestOpenDraftInNewWindow"
> {
  const claimResult: DesktopOwnershipClaimResult = { ok: true };
  return {
    list: () => Promise.resolve([]),
    onChange: () => ({ dispose: () => undefined }),
    requestNew: () => Promise.resolve(),
    requestFocus: () => Promise.resolve(),
    requestClose: () => Promise.resolve(),
    requestOpenEpicInNewWindow: () =>
      Promise.reject(new Error("not used by the draft move flow")),
    ownership: {
      snapshot: () => Promise.resolve([]),
      claim: () => Promise.resolve(claimResult),
      release: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
    perWindowState: {
      get: () => Promise.resolve(emptySnapshot()),
      update: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
    authSession: {
      get: () =>
        Promise.resolve({ status: "signed-out", token: null, profile: null }),
      set: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
  };
}

/** An older-shell double: no `requestOpenDraftInNewWindow` at all, mirroring
 * a preload built before draft moves existed. */
function buildBridgeWithoutDraftMove(): DesktopWindowsBridge {
  return { windowId: "window-a", ...baseBridgeFields() };
}

interface ControllableDraftMoveBridge {
  readonly bridge: DesktopWindowsBridge;
  readonly requestedDraftIds: string[];
  resolve(result: DesktopOpenDraftInNewWindowResult): void;
}

function buildControllableDraftMoveBridge(): ControllableDraftMoveBridge {
  const requestedDraftIds: string[] = [];
  let resolveLatest:
    | ((result: DesktopOpenDraftInNewWindowResult) => void)
    | null = null;
  const bridge: DesktopWindowsBridge = {
    windowId: "window-a",
    ...baseBridgeFields(),
    requestOpenDraftInNewWindow: (draftId: string) => {
      requestedDraftIds.push(draftId);
      return new Promise<DesktopOpenDraftInNewWindowResult>((resolve) => {
        resolveLatest = resolve;
      });
    },
  };
  return {
    bridge,
    requestedDraftIds,
    resolve: (result) => resolveLatest?.(result),
  };
}

/** Seeds a real draft (landing-draft store) that is also present as an
 * ordinary tab-strip item (tabs store) - the tab strip presence is what lets
 * `tabCommandCoordinator.closeRefAfterConfirmed` actually remove it; a ref
 * absent from the strip is a no-op close. */
function seedDraftTab(draftId: string): void {
  useLandingDraftStore.getState().createDraftWithId(draftId, null);
  const ref: TabRef = { kind: "draft", id: draftId };
  useTabsStore.setState({
    version: 2,
    items: [{ kind: "tab", id: `tab:draft:${draftId}`, ref }],
    activeItemId: `tab:draft:${draftId}`,
    stripOrder: [ref],
    systemTabs: { history: null, settings: null },
  });
}

let flowRef: DraftNewWindowFlow | null = null;

function FlowHarness({
  bridge,
}: {
  readonly bridge: DesktopWindowsBridge | null;
}): ReactNode {
  const flow = useDraftOpenInNewWindowFlow(bridge);
  useEffect(() => {
    flowRef = flow;
  });
  return null;
}

// Return type inferred: naming `createRouter`'s concrete RouterCore
// instantiation here would only restate the library's generics.
function renderFlow(bridge: DesktopWindowsBridge | null, initialRoute: string) {
  const rootRoute = createRootRoute({
    component: () => <FlowHarness bridge={bridge} />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [initialRoute] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("useDraftOpenInNewWindowFlow", () => {
  beforeEach(() => {
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    flowRef = null;
    vi.clearAllMocks();
    // `clearAllMocks` clears calls, not implementations - a test that arms the
    // ingest barrier has to be un-armed explicitly or it leaks forward.
    vi.mocked(draftHasIngestingImages).mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  });

  it("no-ops - no IPC call, no image staging, no store mutation - when the bridge lacks requestOpenDraftInNewWindow", async () => {
    seedDraftTab("draft-a");
    const bridge = buildBridgeWithoutDraftMove();
    renderFlow(bridge, draftPathname("draft-a"));
    await flush();

    act(() => {
      flowRef?.requestOpenInNewWindow({ draftId: "draft-a" });
    });
    await flush();

    expect(vi.mocked(stageDraftImageHandoff)).not.toHaveBeenCalled();
    expect(vi.mocked(discardDraftImageHandoff)).not.toHaveBeenCalled();
    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toEqual([
      "draft-a",
    ]);
    expect(useTabsStore.getState().items).toEqual([
      {
        kind: "tab",
        id: "tab:draft:draft-a",
        ref: { kind: "draft", id: "draft-a" },
      },
    ]);
  });

  it("stages the image handoff, calls the move IPC, and on a moved result removes the draft via closeRefAfterConfirmed", async () => {
    seedDraftTab("draft-b");
    const windows = buildControllableDraftMoveBridge();
    const router = renderFlow(windows.bridge, draftPathname("draft-b"));
    await flush();

    act(() => {
      flowRef?.requestOpenInNewWindow({ draftId: "draft-b" });
    });
    await flush();

    expect(windows.requestedDraftIds).toEqual(["draft-b"]);
    expect(vi.mocked(stageDraftImageHandoff)).toHaveBeenCalledWith(
      "draft-b",
      [],
    );

    act(() => {
      windows.resolve({ result: "moved", windowId: "window-b" });
    });
    await flush();

    // Removed from BOTH the source-of-truth draft store and the tab strip -
    // the coordinator's real close path, not a bespoke removal.
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(useTabsStore.getState().items).toEqual([]);
    expect(vi.mocked(discardDraftImageHandoff)).not.toHaveBeenCalled();
    // The moved draft's own route was active - navigates back to landing.
    expect(router.state.location.pathname).toBe("/");
  });

  it("leaves the draft open when the move IPC resolves not-found, and discards the staged handoff", async () => {
    seedDraftTab("draft-c");
    const windows = buildControllableDraftMoveBridge();
    renderFlow(windows.bridge, draftPathname("draft-c"));
    await flush();

    act(() => {
      flowRef?.requestOpenInNewWindow({ draftId: "draft-c" });
    });
    await flush();

    act(() => {
      windows.resolve({ result: "not-found", windowId: "" });
    });
    await flush();

    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toEqual([
      "draft-c",
    ]);
    expect(useTabsStore.getState().items).toEqual([
      {
        kind: "tab",
        id: "tab:draft:draft-c",
        ref: { kind: "draft", id: "draft-c" },
      },
    ]);
    expect(vi.mocked(discardDraftImageHandoff)).toHaveBeenCalledWith("draft-c");
  });

  it("holds the move until a still-ingesting attachment settles - nothing staged, nothing sent, in the meantime", async () => {
    seedDraftTab("draft-d");
    vi.mocked(draftHasIngestingImages).mockReturnValue(true);
    const windows = buildControllableDraftMoveBridge();
    renderFlow(windows.bridge, draftPathname("draft-d"));
    await flush();

    act(() => {
      flowRef?.requestOpenInNewWindow({ draftId: "draft-d" });
    });
    await flush();

    // A pasted image whose `putImage` has not landed yet has no hash to stage
    // and is stripped from the projection, so a move started here would carry
    // the draft over without it and then close the only copy that had it.
    expect(vi.mocked(stageDraftImageHandoff)).not.toHaveBeenCalled();
    expect(windows.requestedDraftIds).toEqual([]);

    // The ingest lands: the node now carries a hash, and the store write that
    // records it is what releases the barrier.
    vi.mocked(draftHasIngestingImages).mockReturnValue(false);
    act(() => {
      useLandingDraftStore.setState((state) => ({ drafts: [...state.drafts] }));
    });
    await flush();

    expect(vi.mocked(stageDraftImageHandoff)).toHaveBeenCalledWith(
      "draft-d",
      [],
    );
    expect(windows.requestedDraftIds).toEqual(["draft-d"]);
  });

  it("discards the staged handoff when the move IPC rejects, so the bytes are not stranded", async () => {
    seedDraftTab("draft-e");
    const bridge: DesktopWindowsBridge = {
      windowId: "window-a",
      ...baseBridgeFields(),
      requestOpenDraftInNewWindow: () =>
        Promise.reject(new Error("destination window failed to load")),
    };
    renderFlow(bridge, draftPathname("draft-e"));
    await flush();

    act(() => {
      flowRef?.requestOpenInNewWindow({ draftId: "draft-e" });
    });
    await flush();

    expect(vi.mocked(stageDraftImageHandoff)).toHaveBeenCalledWith(
      "draft-e",
      [],
    );
    expect(vi.mocked(discardDraftImageHandoff)).toHaveBeenCalledWith("draft-e");
    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toEqual([
      "draft-e",
    ]);
  });
});
