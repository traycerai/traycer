import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrLightItem } from "@traycer/protocol/host/pr-schemas";
import { SwitcherPanelEmbed } from "@/components/epic-canvas/mobile/switcher-panel-embed";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import { usePrPresenceStore } from "@/stores/epics/pr-presence-store";

const EPIC_ID = "epic-pr-embed";
const TAB_ID = "tab-pr-embed";
const HOST_ID = "host-A";

// The sibling embed categories drag the whole epic-sidebar / git-diff module
// graph in; this suite is about the PR body, so stub them at the boundary the
// way `switcher-panel-embed.test.tsx` does. `PrPanelBody` itself stays REAL -
// its subscription gate and row wiring are what is under test.
vi.mock("@/components/epic-canvas/sidebar/epic-sidebar", () => ({
  FileTreePanelBody: () => <div data-testid="file-tree-body" />,
}));
vi.mock("@/components/epic-canvas/git-diff/git-diff-panel-body-live", () => ({
  GitDiffPanelBodyLive: () => <div data-testid="git-diff-body" />,
}));

const viewportState = vi.hoisted(() => ({ isMobile: true }));
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => viewportState.isMobile,
  isMobileViewport: () => viewportState.isMobile,
}));

vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => HOST_ID,
}));

const tileNavigationMocks = vi.hoisted(() => ({
  // Typed so assertions can read the recorded call without `any` leaking
  // through `mock.calls`.
  openTileInEpic: vi.fn<(epicId: string, tile: unknown) => void>(),
  openTileInTab: vi.fn(),
  openTilePreviewInEpic: vi.fn(),
  openTilePreviewInTab: vi.fn(),
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => tileNavigationMocks,
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useStreamMethodSupport: () => "supported",
}));

// The WS transport is the external boundary here: fake it so the body's own
// gate (`enabled`) and its list projection stay observable.
const subscriptionState = vi.hoisted(() => ({
  items: [] as readonly PrLightItem[],
  lastEnabled: null as boolean | null,
}));
vi.mock("@/hooks/pr/use-pr-list-subscription", () => ({
  usePrListSubscription: (args: { readonly enabled: boolean }) => {
    subscriptionState.lastEnabled = args.enabled;
    return {
      data: {
        sourceStatus: "ok",
        notice: null,
        items: subscriptionState.items,
      },
      error: null,
      isPending: false,
      sendRefresh: () => undefined,
    };
  },
}));

// `PrRow` pulls the per-epic Y.doc-backed owner-label chain, which has nothing
// to do with the embed wiring; stub it to a button that still fires the REAL
// `onOpen` the panel built.
vi.mock("@/components/epic-canvas/pr/pr-row", () => ({
  PrRow: (props: {
    readonly entry: {
      readonly item: PrLightItem;
      readonly onOpen: (() => void) | null;
    };
  }) => (
    <button
      type="button"
      data-testid="pr-row"
      onClick={() => props.entry.onOpen?.()}
    >
      {props.entry.item.title}
    </button>
  ),
}));

function buildPrItem(overrides: Partial<PrLightItem>): PrLightItem {
  return {
    githubHost: "github.com",
    base: { owner: "acme", repo: "widgets", prNumber: 7 },
    prUrl: null,
    state: "open",
    liveness: "live",
    observedAt: null,
    isDraft: false,
    title: "Add the mobile switcher",
    baseRefName: "main",
    headRefName: "feature/switcher",
    additions: 10,
    deletions: 2,
    checksRollup: null,
    reviewDecision: null,
    commentCount: 0,
    updatedAt: 1_000,
    repoIdentifier: { owner: "acme", repo: "widgets" },
    repoRole: "superproject",
    linkGroupKey: null,
    owners: [],
    ...overrides,
  };
}

function renderEmbed() {
  return render(
    <SwitcherPanelEmbed
      category="pull-requests"
      epicId={EPIC_ID}
      tabId={TAB_ID}
    />,
  );
}

describe("<SwitcherPanelEmbed /> pull-requests category", () => {
  beforeEach(() => {
    viewportState.isMobile = true;
    subscriptionState.items = [];
    subscriptionState.lastEnabled = null;
    tileNavigationMocks.openTileInEpic.mockClear();
    useLeftPanelStore.setState({
      mainCollapsedByTabId: {},
      panelSectionCollapsedByPanelId: {},
    });
    usePrPresenceStore.setState({ hasItemsByScopeKey: {} });
  });
  afterEach(cleanup);

  it("renders a row per PR, grouped under its repo header", () => {
    subscriptionState.items = [
      buildPrItem({ title: "Add the mobile switcher" }),
      buildPrItem({
        title: "Fix the rail order",
        base: { owner: "acme", repo: "widgets", prNumber: 8 },
      }),
    ];
    renderEmbed();
    expect(screen.getAllByTestId("pr-row")).toHaveLength(2);
    expect(screen.getByText("Add the mobile switcher")).toBeTruthy();
    expect(screen.getByTestId("pr-repo-group-header").textContent).toContain(
      "acme/widgets",
    );
  });

  it("opens the PR's detail tile through the desktop navigation path", async () => {
    const user = userEvent.setup();
    subscriptionState.items = [buildPrItem({})];
    renderEmbed();
    await user.click(screen.getByTestId("pr-row"));
    expect(tileNavigationMocks.openTileInEpic).toHaveBeenCalledTimes(1);
    const call = tileNavigationMocks.openTileInEpic.mock.calls.at(0);
    if (call === undefined) throw new Error("expected a tile-open call");
    const [epicId, tile] = call;
    expect(epicId).toBe(EPIC_ID);
    expect(tile).toMatchObject({
      type: "pr-detail",
      hostId: HOST_ID,
      owner: "acme",
      repo: "widgets",
      prNumber: 7,
    });
  });

  it("subscribes on a phone even while the desktop sidebar is persisted collapsed", () => {
    // The collapse flags describe the sidebar column, which is not rendered at
    // mobile width - so they must not gate the sheet's copy of the body.
    useLeftPanelStore.setState({
      mainCollapsedByTabId: { [TAB_ID]: true },
      panelSectionCollapsedByPanelId: { "pull-requests": true },
    });
    subscriptionState.items = [buildPrItem({})];
    renderEmbed();
    expect(subscriptionState.lastEnabled).toBe(true);
    expect(screen.getByTestId("pr-row")).toBeTruthy();
  });

  it("still honours the collapse gates on a desktop viewport", () => {
    viewportState.isMobile = false;
    useLeftPanelStore.setState({ mainCollapsedByTabId: { [TAB_ID]: true } });
    renderEmbed();
    expect(subscriptionState.lastEnabled).toBe(false);
  });

  it("shows the panel's own empty state when the epic has no PRs", () => {
    renderEmbed();
    expect(screen.getByTestId("pr-panel-empty")).toBeTruthy();
    expect(screen.queryByTestId("pr-row")).toBeNull();
  });
});
