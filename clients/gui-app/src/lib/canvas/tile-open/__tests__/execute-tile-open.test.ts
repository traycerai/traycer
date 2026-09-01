/**
 * The executor is a dispatcher, so this suite pins the dispatch table: one
 * plan kind -> one `prepare*FocusTarget`, always wrapped in `navigateNested`
 * (the nested-focus boundary), except `pip`, which leaves the tile tree and
 * therefore commits no route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { convertBrowserTabToPip } from "@/lib/browser-view/pip/pip-store";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
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
    splitWithNode: vi.fn(() => FOCUS),
    restorePreview: vi.fn(),
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
  });
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  navigateNested.mockClear();
  vi.mocked(convertBrowserTabToPip).mockClear();
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
      }),
    ).toEqual(FOCUS);
    expect(spies.setActiveTileTab).toHaveBeenCalledWith(
      TAB_ID,
      "pane-1",
      "inst-1",
    );
    expect(navigateNested).toHaveBeenCalledWith(
      EPIC_ID,
      TAB_ID,
      expect.any(Function),
    );
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
      }),
    ).toEqual(FOCUS);
    expect(spies.openInPane).toHaveBeenCalledTimes(1);
    expect(navigateNested).not.toHaveBeenCalled();
  });
});
