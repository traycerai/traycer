import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabSwitcherSheet } from "@/components/epic-canvas/mobile/tab-switcher-sheet";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicArtifactRef,
  EpicCanvasTileRef,
  PrDetailTileRef,
  TilePane,
  WorkspaceFileRef,
} from "@/stores/epics/canvas/types";

// Source of the mobile-shell hit-slop CSS the sheet imports (via
// `data-mobile-shell-touch-scope`), read so the root-fix invariant - the slop
// `::after` must never paint - is asserted against the real rule; jsdom can't
// compute a coarse-pointer pseudo-element. Vitest's cwd is the gui-app root.
const touchTargetsCss = readFileSync(
  join(
    process.cwd(),
    "src/components/layout/shell/mobile-shell-touch-targets.css",
  ),
  "utf8",
);

const mobileState = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => mobileState.value,
  isMobileViewport: () => mobileState.value,
}));
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "dark", themePreset: "neutral" }),
}));

// The category bodies pull the epic projection / host queries; this test covers
// the shell + tabs + persistence, so stub the lists to markers.
vi.mock("@/components/epic-canvas/mobile/switcher-agents-list", () => ({
  SwitcherAgentsList: () => <div data-testid="mock-agents-list" />,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-terminals-list", () => ({
  SwitcherTerminalsList: () => <div data-testid="mock-terminals-list" />,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-browsers-list", () => ({
  // Named for what it stands in FOR, not for what the real list renders. A
  // stub that reproduces the real component's own accessible name would let
  // this assertion read as "the browsers list rendered" when all it can ever
  // witness is "the sheet routed this category to its body" - which is the
  // claim this file exists to make.
  SwitcherBrowsersList: () => (
    <div role="note" aria-label="browsers category body" />
  ),
}));
vi.mock("@/components/epic-canvas/mobile/switcher-artifacts-list", () => ({
  SwitcherArtifactsList: () => <div data-testid="mock-artifacts-list" />,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-comments-list", () => ({
  SwitcherCommentsList: () => <div data-testid="mock-comments-list" />,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-panel-embed", () => ({
  SwitcherPanelEmbed: (props: { readonly category: string }) => (
    <div data-testid="mock-panel-embed" data-category={props.category} />
  ),
}));
vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => HOST_ID,
}));

const TAB_ID = "tab-switcher-test";
const EPIC_ID = "epic-1";
const HOST_ID = "host-A";
const CATEGORY_NAMES = [
  "Chats",
  "Artifacts",
  "File Tree",
  "Git Diff",
  "Pull Requests",
  "Terminals",
  "Browsers",
  "Sharing",
  "Comments",
];

function renderSheet(open: boolean, onOpenChange: (open: boolean) => void) {
  return render(
    <TabSwitcherSheet
      epicId={EPIC_ID}
      tabId={TAB_ID}
      open={open}
      onOpenChange={onOpenChange}
    />,
  );
}

describe("<TabSwitcherSheet />", () => {
  beforeEach(() => {
    mobileState.value = true;
    // Reset the shared left-panel store so category selection never leaks.
    useLeftPanelStore.setState({ activePanelIdByTabId: {} });
  });
  afterEach(cleanup);

  it("renders every curated category, including Pull Requests, when open on mobile", () => {
    renderSheet(true, () => {});
    for (const name of CATEGORY_NAMES) {
      expect(screen.getByRole("tab", { name })).toBeTruthy();
    }
    expect(screen.getAllByRole("tab")).toHaveLength(9);
  });

  it("keeps the Comments tab on the bar with no artifact tile open", () => {
    // Desktop hides Comments until an artifact tile reveals it; the phone sheet
    // is the only route to a thread list, so a tab that came and went with the
    // shown tile would leave an anchor tap with nowhere to land. The category's
    // own body says what it is waiting for when no artifact is open - the
    // canvas here holds no tiles at all.
    renderSheet(true, () => {});
    expect(screen.getByRole("tab", { name: "Comments" })).toBeTruthy();
  });

  it("labels the chats category 'Chats' and renders the active tab as an underline, not a box", () => {
    renderSheet(true, () => {});
    const active = screen.getByRole("tab", { name: "Chats" });
    expect(active.getAttribute("data-state")).toBe("active");
    // The visible active indicator is a collision-free `::before` underline. The
    // trigger's single `::after` is claimed by the mobile touch hit-slop, so
    // ui/tabs' `after:bg-foreground` indicator legitimately stays in the class
    // list (the shared touch CSS neutralises its paint) and is NOT re-overridden
    // here - re-adding `after:bg-transparent` would be a redundant second
    // mechanism.
    expect(active.className).toContain("after:bg-foreground");
    expect(active.className).toContain("before:bg-foreground");
    // That the underline actually fires, and that the base fill is neutralised
    // rather than merely competed with, both hang on the bar spelling its
    // active-state modifier the way ui/tabs spells its own. Restating that
    // spelling here would only re-assert what the bar's own source says, so
    // `switcher-category-tabs.test.tsx` derives it from the primitive instead.
  });

  it("forces the mobile touch hit-slop ::after transparent so a merged indicator can't box the tab", () => {
    // Root fix (mobile-shell-touch-targets.css): the hit-slop shares each
    // trigger's single `::after`; without a transparent background it merges with
    // ui/tabs' `after:bg-foreground` active indicator and paints a full-cover,
    // near-white box over the label on touch (coarse-pointer) devices.
    expect(touchTargetsCss).toMatch(
      /tabs-trigger"\][^)]*\)::after\s*\{[^}]*background:\s*transparent/,
    );
  });

  it("gives every slop slot a positioned box of its own", () => {
    // The contract is set equality, not membership: the two rules must address
    // the SAME slots, whatever those slots are. One establishes the containing
    // block, the other places the `::after` against it, so a slot in the second
    // list only anchors its hit area to whatever ancestor happens to be
    // positioned - invisible until a tap lands somewhere else. Stated this way
    // it holds for every slot added later without being restated.
    const slotLists = [...touchTargetsCss.matchAll(/:is\(([^)]*)\)/g)].map(
      (match) =>
        [...match[1].matchAll(/data-slot="([^"]+)"/g)]
          .map((slot) => slot[1])
          .sort(),
    );
    expect(slotLists).toHaveLength(2);
    // Positive control: an empty parse would satisfy the equality vacuously.
    expect(slotLists[0].length).toBeGreaterThan(0);
    expect(slotLists[0]).toEqual(slotLists[1]);
  });

  it("defaults to the Agents category and shows its body", () => {
    renderSheet(true, () => {});
    expect(screen.getByTestId("mock-agents-list")).toBeTruthy();
  });

  it("carries no visible 'Switch tab' heading - the DrawerTitle is screen-reader only", () => {
    renderSheet(true, () => {});
    const heading = screen.getByText("Switch tab");
    expect(heading.className).toContain("sr-only");
  });

  it("persists a category selection to the left-panel store and swaps the body", async () => {
    const user = userEvent.setup();
    renderSheet(true, () => {});
    await user.click(screen.getByRole("tab", { name: "Artifacts" }));
    expect(useLeftPanelStore.getState().getActivePanelId(TAB_ID)).toBe(
      "artifacts",
    );
    expect(screen.getByTestId("mock-artifacts-list")).toBeTruthy();
  });

  it("keeps Pull Requests reachable before its panel has reported presence", () => {
    renderSheet(true, () => {});
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(9);
    expect(tabs.map((tab) => tab.getAttribute("data-testid"))).toEqual([
      "mobile-switcher-tab-chats",
      "mobile-switcher-tab-artifacts",
      "mobile-switcher-tab-file-tree",
      "mobile-switcher-tab-git-diff",
      "mobile-switcher-tab-pull-requests",
      "mobile-switcher-tab-terminals",
      "mobile-switcher-tab-browsers",
      "mobile-switcher-tab-sharing",
      "mobile-switcher-tab-comments",
    ]);
  });

  it("carries a Browsers tab, so an agent's browser tab is reachable", () => {
    renderSheet(true, () => {});
    expect(screen.getByRole("tab", { name: "Browsers" })).toBeTruthy();
  });

  it("shows the browsers list when the category is selected", async () => {
    const user = userEvent.setup();
    renderSheet(true, () => {});
    await user.click(screen.getByRole("tab", { name: "Browsers" }));
    expect(useLeftPanelStore.getState().getActivePanelId(TAB_ID)).toBe(
      "browsers",
    );
    expect(
      screen.getByRole("note", { name: "browsers category body" }),
    ).toBeTruthy();
  });

  it("opens straight onto a browsers selection the desktop rail persisted", () => {
    // Selection is shared with the rail through this one store; clamping it
    // away would strand a phone user on Agents after choosing Browsers on the
    // desktop.
    useLeftPanelStore.setState({
      activePanelIdByTabId: { [TAB_ID]: "browsers" },
    });
    renderSheet(true, () => {});
    expect(
      screen.getByRole("tab", { name: "Browsers" }).getAttribute("data-state"),
    ).toBe("active");
    expect(
      screen.getByRole("note", { name: "browsers category body" }),
    ).toBeTruthy();
  });

  it("shows the comments panel when the category is selected", async () => {
    const user = userEvent.setup();
    renderSheet(true, () => {});
    await user.click(screen.getByRole("tab", { name: "Comments" }));
    expect(useLeftPanelStore.getState().getActivePanelId(TAB_ID)).toBe(
      "comments",
    );
    expect(screen.getByTestId("mock-comments-list")).toBeTruthy();
  });

  it("opens straight onto a comments selection written by an anchor tap", () => {
    // The tap path selects the category in this same store and opens the sheet;
    // the thread is only reachable if the sheet lands on that category with no
    // further click.
    useLeftPanelStore.setState({
      activePanelIdByTabId: { [TAB_ID]: "comments" },
    });
    renderSheet(true, () => {});
    expect(
      screen.getByRole("tab", { name: "Comments" }).getAttribute("data-state"),
    ).toBe("active");
    expect(screen.getByTestId("mock-comments-list")).toBeTruthy();
  });

  it("shows the embedded desktop sharing panel body when the category is selected", async () => {
    const user = userEvent.setup();
    renderSheet(true, () => {});
    await user.click(screen.getByRole("tab", { name: "Sharing" }));
    expect(useLeftPanelStore.getState().getActivePanelId(TAB_ID)).toBe(
      "sharing",
    );
    const embed = await screen.findByTestId("mock-panel-embed");
    expect(embed.dataset.category).toBe("sharing");
  });

  it("opens straight onto a persisted sharing selection instead of clamping it away", async () => {
    // `sharing` is shared with the desktop rail through this one store, so a
    // selection made on a desktop lands here on the phone. While the category
    // was uncurated `clampToSwitcherCategory` sent it back to Chats, which is
    // the regression this guards: the tab must be the active one on first
    // paint, with no click to get there.
    useLeftPanelStore.setState({
      activePanelIdByTabId: { [TAB_ID]: "sharing" },
    });
    renderSheet(true, () => {});
    expect(
      screen.getByRole("tab", { name: "Sharing" }).getAttribute("data-state"),
    ).toBe("active");
    expect(screen.queryByTestId("mock-agents-list")).toBeNull();
    const embed = await screen.findByTestId("mock-panel-embed");
    expect(embed.dataset.category).toBe("sharing");
  });

  it("shows the embedded desktop PR panel body when the category is selected", async () => {
    const user = userEvent.setup();
    renderSheet(true, () => {});
    await user.click(screen.getByRole("tab", { name: "Pull Requests" }));
    expect(useLeftPanelStore.getState().getActivePanelId(TAB_ID)).toBe(
      "pull-requests",
    );
    // The embed is lazy-mounted behind Suspense, so wait for the chunk.
    const embed = await screen.findByTestId("mock-panel-embed");
    expect(embed.dataset.category).toBe("pull-requests");
  });

  it("keeps a persisted pull-requests selection with no presence cache", () => {
    useLeftPanelStore.setState({
      activePanelIdByTabId: { [TAB_ID]: "pull-requests" },
    });
    renderSheet(true, () => {});
    expect(
      screen
        .getByRole("tab", { name: "Pull Requests" })
        .getAttribute("data-state"),
    ).toBe("active");
  });

  it("keeps a persisted pull-requests selection when stream support is unknown", () => {
    useLeftPanelStore.setState({
      activePanelIdByTabId: { [TAB_ID]: "pull-requests" },
    });
    renderSheet(true, () => {});
    expect(screen.getByRole("tab", { name: "Pull Requests" })).toBeTruthy();
  });

  it("renders nothing when closed (controlled open prop)", () => {
    renderSheet(false, () => {});
    expect(screen.queryByTestId("mobile-tab-switcher-sheet")).toBeNull();
  });

  it("renders nothing on desktop even when asked to open", () => {
    mobileState.value = false;
    renderSheet(true, () => {});
    expect(screen.queryByTestId("mobile-tab-switcher-sheet")).toBeNull();
  });
});

function artifactRef(id: string, instanceId: string): EpicArtifactRef {
  return { id, instanceId, type: "spec", name: id, hostId: "host-A" };
}

function workspaceFileRef(id: string, instanceId: string): WorkspaceFileRef {
  return {
    id,
    instanceId,
    type: "workspace-file",
    name: id,
    hostId: "host-A",
    workspacePath: "/ws",
    filePath: id,
  };
}

function prDetailRef(id: string, instanceId: string): PrDetailTileRef {
  return {
    id,
    instanceId,
    type: "pr-detail",
    name: "acme/widgets#7",
    hostId: HOST_ID,
    githubHost: "github.com",
    owner: "acme",
    repo: "widgets",
    prNumber: 7,
  };
}

/** A live pane holding no tiles - what the user sees after closing the last tab. */
function seedCanvasWithNoTiles(): void {
  const root: TilePane = {
    kind: "pane",
    id: "pane-A",
    tabInstanceIds: [],
    activeTabId: null,
    previewTabId: null,
    activationHistory: [],
  };
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic 1" } },
    canvasByTabId: {
      [TAB_ID]: {
        root,
        activePaneId: "pane-A",
        tilesByInstanceId: {},
        sizesByGroupId: {},
      },
    },
  });
}

function seedCanvas(
  tilesByInstanceId: Record<string, EpicCanvasTileRef>,
  activeTabId: string,
): void {
  const root: TilePane = {
    kind: "pane",
    id: "pane-A",
    tabInstanceIds: Object.keys(tilesByInstanceId),
    activeTabId,
    previewTabId: null,
    activationHistory: [activeTabId],
  };
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: "epic-1", name: "Epic 1" } },
    canvasByTabId: {
      [TAB_ID]: {
        root,
        activePaneId: "pane-A",
        tilesByInstanceId,
        sizesByGroupId: {},
      },
    },
  });
}

describe("<TabSwitcherSheet /> close-on-open", () => {
  beforeEach(() => {
    mobileState.value = true;
    useLeftPanelStore.setState({ activePanelIdByTabId: {} });
  });
  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("closes when a file-tree/git-diff tap lands an embed-originated tile", () => {
    const tiles = {
      "inst-1": artifactRef("a1", "inst-1"),
      "inst-2": workspaceFileRef("f1", "inst-2"),
    };
    seedCanvas(tiles, "inst-1");
    const onOpenChange = vi.fn();
    renderSheet(true, onOpenChange);
    expect(onOpenChange).not.toHaveBeenCalled();
    act(() => seedCanvas(tiles, "inst-2")); // shown tile -> workspace-file
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes when the FIRST tile of an empty pane is a PR detail", () => {
    // The switcher is the way back from an empty pane, so its first observation
    // there is `null` - which must not read as "nothing observed yet" and
    // suppress the close, leaving the drawer over the tile just opened.
    seedCanvasWithNoTiles();
    const onOpenChange = vi.fn();
    renderSheet(true, onOpenChange);
    expect(onOpenChange).not.toHaveBeenCalled();
    act(() =>
      seedCanvas({ "inst-1": prDetailRef("pr-7", "inst-1") }, "inst-1"),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes when the FIRST tile of an empty pane is a file-tree tap", () => {
    seedCanvasWithNoTiles();
    const onOpenChange = vi.fn();
    renderSheet(true, onOpenChange);
    act(() =>
      seedCanvas({ "inst-1": workspaceFileRef("f1", "inst-1") }, "inst-1"),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stays open when an empty pane grows a background chat/artifact tile", () => {
    seedCanvasWithNoTiles();
    const onOpenChange = vi.fn();
    renderSheet(true, onOpenChange);
    act(() => seedCanvas({ "inst-1": artifactRef("a1", "inst-1") }, "inst-1"));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes when a PR row tap lands its detail tile", () => {
    const tiles = {
      "inst-1": artifactRef("a1", "inst-1"),
      "inst-2": prDetailRef("pr-7", "inst-2"),
    };
    seedCanvas(tiles, "inst-1");
    const onOpenChange = vi.fn();
    renderSheet(true, onOpenChange);
    expect(onOpenChange).not.toHaveBeenCalled();
    act(() => seedCanvas(tiles, "inst-2")); // shown tile -> pr-detail
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stays open when a background chat/artifact open changes the shown tile", () => {
    const tiles = {
      "inst-1": artifactRef("a1", "inst-1"),
      "inst-2": artifactRef("a2", "inst-2"),
    };
    seedCanvas(tiles, "inst-1");
    const onOpenChange = vi.fn();
    renderSheet(true, onOpenChange);
    // A background handoff/remote-delete lands a non-embed tile as shown.
    act(() => seedCanvas(tiles, "inst-2"));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("stays open when only the category changes (no tile opened)", async () => {
    const user = userEvent.setup();
    seedCanvas({ "inst-1": artifactRef("a1", "inst-1") }, "inst-1");
    const onOpenChange = vi.fn();
    renderSheet(true, onOpenChange);
    await user.click(screen.getByRole("tab", { name: "Git Diff" }));
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
