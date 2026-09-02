/**
 * The executor is a dispatcher, so this suite pins the dispatch table: one
 * plan kind -> one `prepare*FocusTarget`, always wrapped in `navigateNested`
 * (the nested-focus boundary), except `pip`, which leaves the tile tree and
 * therefore commits no route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { convertBrowserTabToPip } from "@/lib/browser-view/pip/pip-store";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import {
  trackOpenedCanvasTile,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import {
  SPEC_A,
  TEST_HOST_ID,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import type { TileOpenPlan } from "../intent";
import { executeTileOpen } from "../execute-tile-open";

vi.mock("@/lib/browser-view/pip/pip-store", () => ({
  convertBrowserTabToPip: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

// The real store, minus the analytics call - `focus-existing` must not count
// as an open (R9), and only a spy can prove a call that did NOT happen.
vi.mock("@/stores/epics/canvas/store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/epics/canvas/store")>();
  return { ...actual, trackOpenedCanvasTile: vi.fn() };
});

const EPIC_ID = "epic-exec";
const TAB_ID = "view-tab-exec";
const SOURCE = "direct_ui" as const;
const FOCUS: NestedFocusTarget = {
  paneId: "pane-new",
  tileInstanceId: "inst-new",
};

const BROWSER_A = makeBrowserSessionTileRef({
  hostId: TEST_HOST_ID,
  sessionId: "session-1",
  tabId: "browser-tab-1",
});

/**
 * Replace exactly the prepare* actions the executor may reach, so a wrong
 * dispatch shows up as "the other spy was called" rather than a canvas diff.
 */
function installPrepareSpies() {
  const spies = {
    setActiveTileTab: vi.fn(() => FOCUS),
    openInTab: vi.fn(() => FOCUS),
    openPreviewInTab: vi.fn(() => FOCUS),
    openInBackgroundTab: vi.fn(() => null),
    openInPane: vi.fn(() => FOCUS),
    splitWithNode: vi.fn((): NestedFocusTarget | null => FOCUS),
    restorePreview: vi.fn(),
    promotePreview: vi.fn(),
  };
  useEpicCanvasStore.setState({
    prepareSetActiveTileTabFocusTarget: spies.setActiveTileTab,
    prepareOpenTileInTabFocusTargetFromSource: spies.openInTab,
    prepareOpenTilePreviewInTabFocusTargetFromSource: spies.openPreviewInTab,
    prepareOpenTileInBackgroundTabFocusTargetFromSource:
      spies.openInBackgroundTab,
    prepareOpenTileInPaneFocusTargetFromSource: spies.openInPane,
    prepareSplitPaneWithNodeFocusTarget: spies.splitWithNode,
    restorePreviewInTab: spies.restorePreview,
    promotePreviewInTab: spies.promotePreview,
  });
  return spies;
}

const navigateNested = vi.fn<NavigateNestedFocus>((_epicId, _tabId, prepare) =>
  prepare(),
);

function run(plan: TileOpenPlan): NestedFocusTarget | null {
  return executeTileOpen({
    plan,
    node: plan.kind === "pip" ? BROWSER_A : SPEC_A,
    source: SOURCE,
    store: useEpicCanvasStore.getState(),
    navigateNested,
    epicId: EPIC_ID,
    pipOrigin: "manual",
  });
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  navigateNested.mockClear();
  vi.mocked(convertBrowserTabToPip).mockClear();
  vi.mocked(trackOpenedCanvasTile).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe("executeTileOpen", () => {
  it("focuses an existing tile through the active-tab preparer", () => {
    const spies = installPrepareSpies();

    expect(
      run({
        kind: "focus-existing",
        tabId: TAB_ID,
        paneId: "pane-1",
        instanceId: "inst-1",
        promote: false,
      }),
    ).toEqual(FOCUS);
    expect(spies.setActiveTileTab).toHaveBeenCalledWith(
      TAB_ID,
      "pane-1",
      "inst-1",
    );
    expect(spies.promotePreview).not.toHaveBeenCalled();
    // R9: focusing an open tile is not an open.
    expect(trackOpenedCanvasTile).not.toHaveBeenCalled();
    expect(navigateNested).toHaveBeenCalledWith(
      EPIC_ID,
      TAB_ID,
      expect.any(Function),
    );
  });

  // R1: a permanent re-open of the pane's preview pins it.
  it("clears the pane's preview slot for a promoting focus", () => {
    const spies = installPrepareSpies();

    expect(
      run({
        kind: "focus-existing",
        tabId: TAB_ID,
        paneId: "pane-1",
        instanceId: "inst-1",
        promote: true,
      }),
    ).toEqual(FOCUS);
    expect(spies.promotePreview).toHaveBeenCalledWith(TAB_ID, "pane-1");
    expect(trackOpenedCanvasTile).not.toHaveBeenCalled();
  });

  // C1: a background open of an already-open tile touches nothing.
  it("does nothing at all for a noop plan", () => {
    const spies = installPrepareSpies();

    expect(run({ kind: "noop" })).toBeNull();
    expect(spies.setActiveTileTab).not.toHaveBeenCalled();
    expect(spies.openInPane).not.toHaveBeenCalled();
    expect(navigateNested).not.toHaveBeenCalled();
    expect(trackOpenedCanvasTile).not.toHaveBeenCalled();
  });

  it("opens into an explicit pane with the plan's mode and index", () => {
    const spies = installPrepareSpies();

    expect(
      run({
        kind: "open-in-pane",
        tabId: TAB_ID,
        paneId: "pane-2",
        mode: "preview",
        index: 3,
      }),
    ).toEqual(FOCUS);
    expect(spies.openInPane).toHaveBeenCalledWith(TAB_ID, "pane-2", SPEC_A, {
      mode: "preview",
      index: 3,
      source: SOURCE,
    });
    expect(spies.openPreviewInTab).not.toHaveBeenCalled();
    expect(navigateNested).toHaveBeenCalledTimes(1);
  });

  it("falls back to the whole-canvas openers when no pane resolved", () => {
    const spies = installPrepareSpies();

    run({
      kind: "open-in-pane",
      tabId: TAB_ID,
      paneId: null,
      mode: "permanent",
      index: null,
    });
    run({
      kind: "open-in-pane",
      tabId: TAB_ID,
      paneId: null,
      mode: "preview",
      index: null,
    });
    expect(
      run({
        kind: "open-in-pane",
        tabId: TAB_ID,
        paneId: null,
        mode: "background",
        index: null,
      }),
    ).toBeNull();

    expect(spies.openInTab).toHaveBeenCalledWith(TAB_ID, SPEC_A, SOURCE);
    expect(spies.openPreviewInTab).toHaveBeenCalledWith(TAB_ID, SPEC_A, SOURCE);
    expect(spies.openInBackgroundTab).toHaveBeenCalledWith(
      TAB_ID,
      SPEC_A,
      SOURCE,
    );
    expect(spies.openInPane).not.toHaveBeenCalled();
    expect(navigateNested).toHaveBeenCalledTimes(3);
  });

  it("splits, and claims the new pane's preview slot for a preview split", () => {
    const spies = installPrepareSpies();

    run({
      kind: "split",
      tabId: TAB_ID,
      paneId: "pane-3",
      edge: "right",
      mode: "permanent",
    });
    expect(spies.splitWithNode).toHaveBeenCalledWith(
      TAB_ID,
      "pane-3",
      "right",
      SPEC_A,
    );
    expect(spies.restorePreview).not.toHaveBeenCalled();

    run({
      kind: "split",
      tabId: TAB_ID,
      paneId: "pane-3",
      edge: "right",
      mode: "preview",
    });
    expect(spies.restorePreview).toHaveBeenCalledWith(
      TAB_ID,
      FOCUS.paneId,
      FOCUS.tileInstanceId,
    );
  });

  // C3: `insertPaneAtEdge` refuses past MAX_TREE_DEPTH and the prepare returns
  // null; the tile still has to land somewhere.
  it("falls back to a tab in the anchor pane when the split is refused", () => {
    const spies = installPrepareSpies();
    spies.splitWithNode.mockReturnValue(null);

    expect(
      run({
        kind: "split",
        tabId: TAB_ID,
        paneId: "pane-3",
        edge: "right",
        mode: "preview",
      }),
    ).toEqual(FOCUS);
    expect(spies.openInPane).toHaveBeenCalledWith(TAB_ID, "pane-3", SPEC_A, {
      mode: "preview",
      index: null,
      source: SOURCE,
    });
    expect(spies.restorePreview).not.toHaveBeenCalled();
  });

  it("converts to PiP without touching the canvas or the route", () => {
    const spies = installPrepareSpies();

    expect(run({ kind: "pip", tabId: TAB_ID })).toBeNull();
    expect(convertBrowserTabToPip).toHaveBeenCalledWith(
      expect.objectContaining({
        epicId: EPIC_ID,
        hostId: TEST_HOST_ID,
        sessionId: "session-1",
        tabId: "browser-tab-1",
        origin: "manual",
      }),
    );
    expect(navigateNested).not.toHaveBeenCalled();
    expect(spies.openInPane).not.toHaveBeenCalled();
  });

  it("toasts a manual PiP failure and stays silent for an agent push", () => {
    installPrepareSpies();

    run({ kind: "pip", tabId: TAB_ID });
    // Asserted rather than optional-chained: a PiP that stopped being
    // requested at all must not read as "stayed silent".
    expect(convertBrowserTabToPip).toHaveBeenCalledOnce();
    vi.mocked(convertBrowserTabToPip).mock.calls[0][0].onError("boom");
    expect(toast.error).toHaveBeenCalledWith("boom");

    vi.mocked(toast.error).mockClear();
    executeTileOpen({
      plan: { kind: "pip", tabId: TAB_ID },
      node: BROWSER_A,
      source: SOURCE,
      store: useEpicCanvasStore.getState(),
      navigateNested,
      epicId: EPIC_ID,
      // A failed auto-PiP leaves the tab reachable in the sidebar; toasting
      // about background automation is the regression this pins (L4).
      pipOrigin: "agent",
    });
    expect(convertBrowserTabToPip).toHaveBeenCalledTimes(2);
    vi.mocked(convertBrowserTabToPip).mock.calls[1][0].onError("boom");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("ignores a PiP plan for a node that is not a browser tab", () => {
    installPrepareSpies();

    expect(
      executeTileOpen({
        plan: { kind: "pip", tabId: TAB_ID },
        node: SPEC_A,
        source: SOURCE,
        store: useEpicCanvasStore.getState(),
        navigateNested,
        epicId: EPIC_ID,
        pipOrigin: "manual",
      }),
    ).toBeNull();
    expect(convertBrowserTabToPip).not.toHaveBeenCalled();
  });

  it("opens without a route commit when the tab has no epic", () => {
    const spies = installPrepareSpies();

    expect(
      executeTileOpen({
        plan: {
          kind: "open-in-pane",
          tabId: TAB_ID,
          paneId: "pane-4",
          mode: "permanent",
          index: null,
        },
        node: SPEC_A,
        source: SOURCE,
        store: useEpicCanvasStore.getState(),
        navigateNested,
        epicId: null,
        pipOrigin: "manual",
      }),
    ).toEqual(FOCUS);
    expect(spies.openInPane).toHaveBeenCalledTimes(1);
    expect(navigateNested).not.toHaveBeenCalled();
  });
});
