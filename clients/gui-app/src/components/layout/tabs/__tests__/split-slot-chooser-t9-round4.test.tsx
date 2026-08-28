import type { HistoryItem } from "@/components/home/data/home-page.data";

const chooserHistoryItem = vi.hoisted<HistoryItem>(() => ({
  id: "history-epic",
  epicId: "history-epic",
  taskType: "epic",
  title: "History Epic",
  initialUserPrompt: "",
  updatedAtMs: 1,
  updatedLabel: "now",
  updatedBucket: "today",
  linkedRepos: [],
  linkedWorkspaces: [],
  chatHostIds: null,
  pullRequestNumbers: [],
  worktreeBranches: [],
  worktreePaths: [],
  ownership: "mine",
  permissionRole: "owner",
  isPinned: false,
}));

vi.mock("@/components/epics/epics-list-panel", () => ({
  EpicsListPanel: (props: {
    readonly onOpenItem: ((item: HistoryItem) => void) | null;
  }) => (
    <div data-testid="embedded-history-panel">
      <button
        type="button"
        onClick={() => props.onOpenItem?.(chooserHistoryItem)}
      >
        History Epic
      </button>
    </div>
  ),
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  SplitSlotChooserContent,
  type SplitSlotChooserProps,
} from "@/components/layout/tabs/split-slot-chooser";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import { resetTabStructuralLockForTesting } from "@/stores/tabs/tab-structural-lock";
import { setTabSplitCompatibility } from "@/stores/tabs/tab-split-compatibility";
import type { TabRef } from "@/stores/tabs/types";

const PARTNER: TabRef = { kind: "epic", id: "partner" };
const REUSABLE: TabRef = { kind: "epic", id: "reusable" };
const SPLIT_START_PAGE: TabRef = { kind: "draft", id: "split-start-page" };
const OPEN_START_PAGE_A: TabRef = { kind: "draft", id: "open-start-page-a" };
const OPEN_START_PAGE_B: TabRef = { kind: "draft", id: "open-start-page-b" };

async function renderChooser(
  props: SplitSlotChooserProps & { readonly historyAvailable: boolean },
): Promise<void> {
  const rootRoute = createRootRoute({
    component: () => <SplitSlotChooserContent {...props} />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
  await screen.findByLabelText(
    `${props.slot.kind === "unavailable" ? "Unavailable" : "Empty"} split view`,
  );
}

function seedSplitLayout(includeReusable: boolean) {
  useEpicCanvasStore
    .getState()
    .openEpicTabWithId(PARTNER.id, "partner-epic", "Partner");
  if (includeReusable) {
    useEpicCanvasStore
      .getState()
      .openEpicTabWithId(REUSABLE.id, "reusable-epic", "Reusable Epic");
  }
  useTabsStore.setState({
    version: 2,
    items: [
      {
        kind: "split",
        id: "split-a",
        left: { kind: "empty" },
        right: { kind: "tab", ref: PARTNER },
        focusedSide: "right",
        routeBackingSide: "right",
        leftRatio: 0.5,
      },
      ...(includeReusable
        ? [{ kind: "tab" as const, id: "tab:epic:reusable", ref: REUSABLE }]
        : []),
    ],
    activeItemId: "split-a",
    stripOrder: includeReusable ? [PARTNER, REUSABLE] : [PARTNER],
    systemTabs: { history: null, settings: null },
  });
}

function seedStartPageLayoutWithStaleLegacyOrder() {
  [SPLIT_START_PAGE, OPEN_START_PAGE_A, OPEN_START_PAGE_B].forEach((ref) => {
    useLandingDraftStore.getState().createDraftWithId(ref.id, null);
  });
  useTabsStore.setState({
    version: 2,
    items: [
      {
        kind: "tab",
        id: "tab:draft:open-start-page-a",
        ref: OPEN_START_PAGE_A,
      },
      {
        kind: "split",
        id: "split-a",
        left: { kind: "empty" },
        right: { kind: "tab", ref: SPLIT_START_PAGE },
        focusedSide: "right",
        routeBackingSide: "right",
        leftRatio: 0.5,
      },
      {
        kind: "tab",
        id: "tab:draft:open-start-page-b",
        ref: OPEN_START_PAGE_B,
      },
    ],
    activeItemId: "split-a",
    // Reproduces the live regression: the grouped header is authoritative and
    // visible while the legacy flattened projection has not caught up.
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
}

afterEach(() => {
  cleanup();
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  resetTabStructuralLockForTesting();
  setTabSplitCompatibility(true);
});

describe("SplitSlotChooserContent grouped destinations", () => {
  it("groups reusable tabs above New Task and the embedded landing History panel", async () => {
    seedSplitLayout(true);

    await renderChooser({
      splitId: "split-a",
      side: "left",
      slot: { kind: "empty" },
      dropActive: false,
      historyAvailable: true,
    });

    expect(screen.getByRole("heading", { name: "Open Tabs" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Create" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "History" })).toBeDefined();
    expect(screen.getByTestId("embedded-history-panel")).toBeDefined();
    expect(
      within(screen.getByTestId("split-open-tabs")).getByRole("button", {
        name: "Reusable Epic",
      }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "New Task" })).toBeDefined();
    [
      "split-open-tabs-card",
      "split-create-actions-card",
      "split-history-card",
    ].forEach((testId) => {
      const cardClassName = screen.getByTestId(testId).className;
      expect(cardClassName).not.toContain("rounded-lg");
      expect(cardClassName).not.toContain("border");
      expect(cardClassName).not.toContain("bg-card/40");
    });
    expect(screen.queryByText("Settings")).toBeNull();
    expect(screen.queryByLabelText("Search tabs and destinations")).toBeNull();
    expect(screen.getByTestId("split-slot-chooser-left").className).toContain(
      "overflow-hidden",
    );
    expect(screen.getByTestId("split-history").className).toContain("flex-1");
    expect(screen.getByTestId("split-create-actions").className).toContain(
      "border-t",
    );
    expect(screen.getByTestId("split-history").className).toContain("border-t");
    expect(screen.getByTestId("split-history-card").className).toContain(
      "overflow-y-auto",
    );
  });

  it("moves a reusable open tab into the empty split side", async () => {
    seedSplitLayout(true);
    await renderChooser({
      splitId: "split-a",
      side: "left",
      slot: { kind: "empty" },
      dropActive: false,
      historyAvailable: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Reusable Epic" }));

    expect(useTabsStore.getState().items[0]).toMatchObject({
      kind: "split",
      left: { kind: "tab", ref: REUSABLE },
      right: { kind: "tab", ref: PARTNER },
    });
  });

  it("detects visible Start Page tabs from authoritative grouped items", async () => {
    seedStartPageLayoutWithStaleLegacyOrder();
    await renderChooser({
      splitId: "split-a",
      side: "left",
      slot: { kind: "empty" },
      dropActive: false,
      historyAvailable: true,
    });

    const startPageButtons = within(
      screen.getByTestId("split-open-tabs"),
    ).getAllByRole("button", { name: "Start Page" });
    expect(startPageButtons).toHaveLength(2);
    expect(screen.getByRole("button", { name: "New Task" })).toBeDefined();

    fireEvent.click(startPageButtons[0]);
    expect(useTabsStore.getState().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "split",
          id: "split-a",
          left: { kind: "tab", ref: OPEN_START_PAGE_A },
        }),
      ]),
    );
  });

  it("creates a draft in the empty side from New Task", async () => {
    seedStartPageLayoutWithStaleLegacyOrder();
    await renderChooser({
      splitId: "split-a",
      side: "left",
      slot: { kind: "empty" },
      dropActive: false,
      historyAvailable: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "New Task" }));

    expect(useTabsStore.getState().items[0]).toMatchObject({
      kind: "tab",
    });
    const split = useTabsStore
      .getState()
      .items.find((item) => item.kind === "split" && item.id === "split-a");
    expect(split).toMatchObject({
      kind: "split",
      id: "split-a",
      left: { kind: "tab", ref: { kind: "draft" } },
    });
  });

  it("creates a draft from a right-side chooser beside Start Page", async () => {
    useLandingDraftStore
      .getState()
      .createDraftWithId(SPLIT_START_PAGE.id, null);
    useTabsStore.setState({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-a",
          left: { kind: "tab", ref: SPLIT_START_PAGE },
          right: { kind: "empty" },
          focusedSide: "right",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
      ],
      activeItemId: "split-a",
      stripOrder: [SPLIT_START_PAGE],
      systemTabs: { history: null, settings: null },
    });
    setTabSplitCompatibility(false);
    await renderChooser({
      splitId: "split-a",
      side: "right",
      slot: { kind: "empty" },
      dropActive: false,
      historyAvailable: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "New Task" }));

    expect(useTabsStore.getState().items[0]).toMatchObject({
      kind: "split",
      left: { kind: "tab", ref: SPLIT_START_PAGE },
      right: { kind: "tab", ref: { kind: "draft" } },
      focusedSide: "right",
      routeBackingSide: "right",
    });
  });

  it("fills the split from a row in the reused History panel", async () => {
    seedSplitLayout(false);
    await renderChooser({
      splitId: "split-a",
      side: "left",
      slot: { kind: "empty" },
      dropActive: false,
      historyAvailable: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "History Epic" }));

    expect(useTabsStore.getState().items[0]).toMatchObject({
      kind: "split",
      left: { kind: "tab", ref: { kind: "epic" } },
    });
    expect(
      Object.values(useEpicCanvasStore.getState().tabsById).some(
        (tab) => tab?.epicId === chooserHistoryItem.epicId,
      ),
    ).toBe(true);
  });

  it("keeps unavailable metadata visible while offering the same groups", async () => {
    seedSplitLayout(false);
    await renderChooser({
      splitId: "split-a",
      side: "left",
      slot: {
        kind: "unavailable",
        previousRef: { kind: "epic", id: "lost" },
        label: "Lost task unavailable",
      },
      dropActive: false,
      historyAvailable: false,
    });

    expect(screen.getByText("Lost task unavailable")).toBeDefined();
    expect(
      screen.getByText(
        "History is unavailable while the host is disconnected.",
      ),
    ).toBeDefined();
  });
});
