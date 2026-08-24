import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabSwitcherSheet } from "@/components/epic-canvas/mobile/tab-switcher-sheet";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  prPresenceScopeKey,
  usePrPresenceStore,
} from "@/stores/epics/pr-presence-store";
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
vi.mock("@/components/epic-canvas/mobile/switcher-artifacts-list", () => ({
  SwitcherArtifactsList: () => <div data-testid="mock-artifacts-list" />,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-panel-embed", () => ({
  SwitcherPanelEmbed: (props: { readonly category: string }) => (
    <div data-testid="mock-panel-embed" data-category={props.category} />
  ),
}));
vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => HOST_ID,
}));

// Method support is client-wide handshake evidence; drive it directly so the
// sheet's "presence AND not known-unsupported" rule is testable without a
// transport. Only this one export is displaced - `StreamRuntimeContext` itself
// stays real for anything else in the tree that reads it.
const streamState = vi.hoisted((): { prSupport: string | null } => ({
  prSupport: "supported",
}));
vi.mock("@/lib/host/stream-runtime-context", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/host/stream-runtime-context")
  >()),
  useStreamMethodSupport: () => streamState.prSupport,
}));

// The presence probe is a live PR subscription; stand in for it with a fake
// that reports whatever this test wants the host to have answered, so the
// bootstrap path (probe -> presence -> tab) stays observable without a
// transport.
const probeState = vi.hoisted(() => ({
  mounts: 0,
  reports: null as boolean | null,
}));
vi.mock(
  "@/components/epic-canvas/mobile/switcher-pr-presence-probe",
  async () => {
    const { useEffect } = await import("react");
    const { usePrPresenceStore } =
      await import("@/stores/epics/pr-presence-store");
    return {
      SwitcherPrPresenceProbe: (props: {
        readonly epicId: string;
        readonly hostId: string | null;
      }) => {
        const record = usePrPresenceStore((s) => s.recordPrPresence);
        useEffect(() => {
          probeState.mounts += 1;
          const reports = probeState.reports;
          if (reports === null || props.hostId === null) return;
          record(props.hostId, props.epicId, reports);
        }, [props.epicId, props.hostId, record]);
        return null;
      },
    };
  },
);

const TAB_ID = "tab-switcher-test";
const EPIC_ID = "epic-1";
const HOST_ID = "host-A";
const CATEGORY_NAMES = [
  "Chats",
  "Artifacts",
  "File Tree",
  "Git Diff",
  "Terminals",
];

/**
 * The Pull requests category is presence-gated exactly as the desktop rail
 * icon is, and the presence store is the only signal for it.
 */
function setPullRequestPresence(hasPullRequests: boolean): void {
  usePrPresenceStore.setState({
    hasItemsByScopeKey: hasPullRequests
      ? { [prPresenceScopeKey(HOST_ID, EPIC_ID)]: true }
      : {},
  });
}

function resetProbe(): void {
  probeState.mounts = 0;
  probeState.reports = null;
  streamState.prSupport = "supported";
}

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
    setPullRequestPresence(false);
    resetProbe();
  });
  afterEach(cleanup);

  it("renders exactly the five always-on category tabs when open on mobile", () => {
    renderSheet(true, () => {});
    for (const name of CATEGORY_NAMES) {
      expect(screen.getByRole("tab", { name })).toBeTruthy();
    }
    expect(screen.getAllByRole("tab")).toHaveLength(5);
  });

  it("labels the chats category 'Chats' and renders the active tab as an underline, not a box", () => {
    renderSheet(true, () => {});
    const active = screen.getByRole("tab", { name: "Chats" });
    expect(active.getAttribute("data-state")).toBe("active");
    // The base `data-active:bg-*` fill is neutralised, so the active line tab
    // never paints a solid fill behind the label.
    expect(active.className).toContain("data-active:bg-transparent");
    // The visible active indicator is a collision-free `::before` underline. The
    // trigger's single `::after` is claimed by the mobile touch hit-slop, so
    // ui/tabs' `after:bg-foreground` indicator legitimately stays in the class
    // list (the shared touch CSS neutralises its paint) and is NOT re-overridden
    // here - re-adding `after:bg-transparent` would be a redundant second
    // mechanism.
    expect(active.className).toContain("after:bg-foreground");
    expect(active.className).toContain("before:bg-foreground");
    expect(active.className).toContain("data-active:before:opacity-100");
  });

  it("forces the mobile touch hit-slop ::after transparent so a merged indicator can't box the tab", () => {
    // Root fix (mobile-shell-touch-targets.css): the hit-slop shares each
    // trigger's single `::after`; without a transparent background it merges with
    // ui/tabs' `after:bg-foreground` active indicator and paints a full-cover,
    // near-white box over the label on touch (coarse-pointer) devices.
    expect(touchTargetsCss).toMatch(
      /tabs-trigger"\]\)::after\s*\{[^}]*background:\s*transparent/,
    );
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

  it("omits the Pull Requests tab while the epic has no PRs", () => {
    renderSheet(true, () => {});
    expect(screen.queryByRole("tab", { name: "Pull Requests" })).toBeNull();
    expect(
      screen.queryByTestId("mobile-switcher-tab-pull-requests"),
    ).toBeNull();
  });

  it("adds the Pull Requests tab once the epic has PRs, right after Git Diff", () => {
    setPullRequestPresence(true);
    renderSheet(true, () => {});
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(6);
    expect(tabs.map((tab) => tab.getAttribute("data-testid"))).toEqual([
      "mobile-switcher-tab-chats",
      "mobile-switcher-tab-artifacts",
      "mobile-switcher-tab-file-tree",
      "mobile-switcher-tab-git-diff",
      "mobile-switcher-tab-pull-requests",
      "mobile-switcher-tab-terminals",
    ]);
  });

  it("shows the embedded desktop PR panel body when the category is selected", async () => {
    setPullRequestPresence(true);
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

  it("keeps a persisted pull-requests selection while the epic still has PRs", () => {
    setPullRequestPresence(true);
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

  it("clamps a persisted pull-requests selection to Chats when the epic has no PRs", () => {
    useLeftPanelStore.setState({
      activePanelIdByTabId: { [TAB_ID]: "pull-requests" },
    });
    renderSheet(true, () => {});
    // The tab is gone, so the sheet must fall back rather than strand itself
    // on a category with no trigger and no body.
    expect(
      screen.getByRole("tab", { name: "Chats" }).getAttribute("data-state"),
    ).toBe("active");
    expect(screen.getByTestId("mock-agents-list")).toBeTruthy();
  });

  it("omits the tab against a host that does not advertise the PR stream, however stale the recorded presence", () => {
    // Presence is persisted per (host, epic) and outlives the host build that
    // recorded it. Showing the tab here would land the panel's visible "Update
    // required" surface; on a phone the category is simply absent instead.
    setPullRequestPresence(true);
    streamState.prSupport = "unsupported";
    renderSheet(true, () => {});
    expect(screen.queryByRole("tab", { name: "Pull Requests" })).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(5);
  });

  it("clamps a persisted pull-requests selection when the host lost stream support", () => {
    setPullRequestPresence(true);
    streamState.prSupport = "unsupported";
    useLeftPanelStore.setState({
      activePanelIdByTabId: { [TAB_ID]: "pull-requests" },
    });
    renderSheet(true, () => {});
    expect(
      screen.getByRole("tab", { name: "Chats" }).getAttribute("data-state"),
    ).toBe("active");
    expect(screen.getByTestId("mock-agents-list")).toBeTruthy();
  });

  it("holds the tab while support is merely unknown, so a reconnect can't blink it out", () => {
    // Support is cleared on every reconnect and re-learned from the next
    // handshake manifest. Only a definite `unsupported` hides the category.
    setPullRequestPresence(true);
    streamState.prSupport = "unknown";
    renderSheet(true, () => {});
    expect(screen.getByRole("tab", { name: "Pull Requests" })).toBeTruthy();
  });

  it("holds the tab while no stream client exists yet", () => {
    setPullRequestPresence(true);
    streamState.prSupport = null;
    renderSheet(true, () => {});
    expect(screen.getByRole("tab", { name: "Pull Requests" })).toBeTruthy();
  });

  it("reveals the tab on a device with no recorded presence once the probe reports PRs", () => {
    // The bootstrap case: nothing in the presence store, so without the probe
    // the tab could never appear and the body that writes presence could never
    // mount. The probe answers first, and the bar picks it up live.
    probeState.reports = true;
    renderSheet(true, () => {});
    expect(screen.getByRole("tab", { name: "Pull Requests" })).toBeTruthy();
  });

  it("leaves the tab off when the probe reports the epic has no PRs", () => {
    probeState.reports = false;
    renderSheet(true, () => {});
    expect(screen.queryByRole("tab", { name: "Pull Requests" })).toBeNull();
  });

  it("renders nothing when closed (controlled open prop)", () => {
    renderSheet(false, () => {});
    expect(screen.queryByTestId("mobile-tab-switcher-sheet")).toBeNull();
  });

  it("does not run the presence probe while the sheet is closed", () => {
    renderSheet(false, () => {});
    expect(probeState.mounts).toBe(0);
  });

  it("runs the presence probe while the sheet is open", () => {
    renderSheet(true, () => {});
    expect(probeState.mounts).toBe(1);
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
    setPullRequestPresence(false);
    resetProbe();
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
    setPullRequestPresence(true);
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
    setPullRequestPresence(true);
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
