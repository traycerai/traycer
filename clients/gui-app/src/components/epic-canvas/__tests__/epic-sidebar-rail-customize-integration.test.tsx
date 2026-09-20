import { useMemo } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomizePopover } from "@/components/customize/customize-popover";
import { EpicLeftPanelStaticRail } from "@/components/epic-canvas/sidebar/epic-sidebar-rail";
import { undo } from "@/lib/customize/history";
import { registerTabsSidebarCustomizeOptions } from "@/lib/customize/options/tabs-sidebar-options";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import {
  DEFAULT_LEFT_PANEL_GROUPS,
  useEpicLeftPanelStore,
  type LeftPanelId,
} from "@/stores/epics/left-panel-store";
import {
  prPresenceScopeKey,
  usePrPresenceStore,
} from "@/stores/epics/pr-presence-store";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";

const track = vi.hoisted(() => vi.fn());
vi.mock("@/components/settings/panels/layout/track-layout-setting", () => ({
  trackLayoutSetting: track,
}));

// Same two host boundaries the existing rail suite fakes; everything else (the
// rail, the popover, the option factories, every store) is real.
const HOST_ID = "rail-customize-host";
vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => HOST_ID,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostDirectoryEntryForHostId: () => ({ label: "Test host" }),
  useHostClientForHostId: () => null,
}));

const EPIC_ID = "rail-customize-epic";
const TAB_ID = "rail-customize-tab";
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 0 } },
});

registerTabsSidebarCustomizeOptions();

function keyFor(panelId: LeftPanelId): string {
  return `sidebar.panel@shell:${panelId}`;
}

/** Overlay stand-in: jsdom has no layout, so hand the real popover a rect for
 *  every registered hotspot exactly as `useHotspotRects` would. */
function Harness() {
  const instances = useCustomizeStore((state) => state.instances);
  const rects = useMemo(
    () =>
      new Map(
        [...instances.keys()].map((key) => [key, new DOMRect(0, 0, 40, 40)]),
      ),
    [instances],
  );
  return (
    <QueryClientProvider client={queryClient}>
      <EpicLeftPanelStaticRail
        epicId={EPIC_ID}
        tabId={TAB_ID}
        orientation="vertical"
      />
      <CustomizePopover rects={rects} />
    </QueryClientProvider>
  );
}

/** Panel ids in the order the rail draws them (real buttons and ghosts). */
function railOrder(): ReadonlyArray<string> {
  const rail = screen.getByTestId("epic-sidebar-rail");
  return [...rail.querySelectorAll<HTMLElement>("[data-testid]")].flatMap(
    (node) => {
      const match = /^epic-rail-(?:ghost-)?(.+)$/.exec(
        node.dataset.testid ?? "",
      );
      return match ? [match[1]] : [];
    },
  );
}

function storedOrder(): ReadonlyArray<string> {
  return useEpicLeftPanelStore
    .getState()
    .panelGroups.flatMap((group) => group.panelIds);
}

function startSession(): void {
  useCustomizeStore.setState({
    session: { scene: "in-place", opener: { kind: "none" }, startedAt: 0 },
    instances: new Map(),
    popoverKey: null,
    activeKey: null,
    history: { past: [], future: [] },
    announcement: "",
  });
}

function history() {
  return useCustomizeStore.getState().history;
}

async function clickMove(panelId: LeftPanelId, name: string): Promise<void> {
  act(() =>
    useCustomizeStore
      .getState()
      .openPopover(keyFor(panelId), keyFor(panelId), null),
  );
  await userEvent.click(await screen.findByRole("button", { name }));
}

beforeEach(() => {
  window.localStorage.clear();
  track.mockClear();
  useSurfaceHostSelectionStore.setState({ selections: {} });
  useEpicLeftPanelStore.setState({
    activePanelIdByTabId: {},
    panelGroups: DEFAULT_LEFT_PANEL_GROUPS,
    mainCollapsedByTabId: {},
    commentsPanelRevealedByTabId: {},
    panelVisibilityOverrideById: {},
  });
  // Give pull-requests presence so only `comments` is a default ghost.
  usePrPresenceStore.setState({
    hasItemsByScopeKey: { [prPresenceScopeKey(HOST_ID, EPIC_ID)]: true },
  });
  startSession();
});
afterEach(() => {
  cleanup();
  usePrPresenceStore.setState({ hasItemsByScopeKey: {} });
  useCustomizeStore.setState({ session: null, instances: new Map() });
});

describe("rail while customizing (real rail + real popover)", () => {
  it("outside a session the default group is still one combined pill", () => {
    useCustomizeStore.setState({ session: null });
    render(<Harness />);
    expect(screen.getByTestId("epic-rail-chats")).not.toBeNull();
    expect(screen.queryByTestId("epic-rail-artifacts")).toBeNull();
    expect(screen.queryByTestId("epic-rail-ghost-comments")).toBeNull();
  });

  it("draws every member of a group as its own target, hidden ghosts inline in stored order", () => {
    render(<Harness />);
    expect(screen.getByTestId("epic-rail-artifacts")).not.toBeNull();
    expect(screen.getByTestId("epic-rail-ghost-comments")).not.toBeNull();
    expect(railOrder()).toEqual(storedOrder());
    // Both members of the default chats + artifacts group can be configured.
    const keys = [...useCustomizeStore.getState().instances.keys()];
    expect(keys).toContain(keyFor("chats"));
    expect(keys).toContain(keyFor("artifacts"));
    expect(keys).toContain(keyFor("comments"));
  });

  it("Group with previous through the popover keeps every member reachable, Undo is one history entry", async () => {
    render(<Harness />);
    await clickMove("terminals", "Group with previous");

    expect(useEpicLeftPanelStore.getState().panelGroups[0]?.panelIds).toEqual([
      "chats",
      "artifacts",
      "terminals",
    ]);
    expect(history().past).toHaveLength(1);
    expect(history().past[0]?.label).toBe("Group with previous");
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("layout.sidebar.panelVisibility");

    // The moved panel (and its new neighbours) keep their own target + button.
    for (const id of ["chats", "artifacts", "terminals"] as const) {
      expect(screen.getByTestId(`epic-rail-${id}`)).not.toBeNull();
      expect(useCustomizeStore.getState().instances.has(keyFor(id))).toBe(true);
    }
    expect(railOrder()).toEqual(storedOrder());

    // ...so its popover still offers Ungroup (enabled) and no second Group.
    act(() =>
      useCustomizeStore
        .getState()
        .openPopover(keyFor("terminals"), keyFor("terminals"), null),
    );
    expect(
      (await screen.findByRole("button", { name: "Ungroup" })).hasAttribute(
        "disabled",
      ),
    ).toBe(false);
    expect(
      screen
        .getByRole("button", { name: "Group with previous" })
        .hasAttribute("disabled"),
    ).toBe(true);

    act(() => undo());
    expect(useEpicLeftPanelStore.getState().panelGroups).toEqual(
      DEFAULT_LEFT_PANEL_GROUPS,
    );
    expect(history().past).toHaveLength(0);
    expect(history().future).toHaveLength(1);
    expect(
      useCustomizeStore.getState().instances.has(keyFor("terminals")),
    ).toBe(true);
  });

  it("Ungroup through the popover splits a member out with one entry and it stays targetable", async () => {
    useEpicLeftPanelStore
      .getState()
      .applyPanelGroups([
        { panelIds: ["chats", "artifacts", "terminals"] },
        ...DEFAULT_LEFT_PANEL_GROUPS.slice(2),
      ]);
    startSession();
    render(<Harness />);
    await clickMove("artifacts", "Ungroup");

    expect(
      useEpicLeftPanelStore
        .getState()
        .panelGroups.some(
          (group) =>
            group.panelIds.length === 1 && group.panelIds[0] === "artifacts",
        ),
    ).toBe(true);
    expect(history().past).toHaveLength(1);
    expect(track).toHaveBeenCalledTimes(1);
    expect(
      useCustomizeStore.getState().instances.has(keyFor("artifacts")),
    ).toBe(true);
    expect(railOrder()).toEqual(storedOrder());
  });

  it("a hidden panel's ghost sits at its stored position and follows a Move", async () => {
    render(<Harness />);
    // comments is a ghost by default; it starts last, after sharing.
    const before = railOrder();
    expect(before.indexOf("comments")).toBeGreaterThan(
      before.indexOf("sharing"),
    );

    await clickMove("comments", "Move up");

    expect(history().past).toHaveLength(1);
    const after = railOrder();
    expect(after).toEqual(storedOrder());
    expect(after).not.toEqual(before);
    expect(after.indexOf("comments")).toBeLessThan(after.indexOf("sharing"));
    expect(screen.getByTestId("epic-rail-ghost-comments")).not.toBeNull();
  });

  it("an explicitly hidden group member keeps its ghost inside the group and Move up reorders it and DOM = stored order", async () => {
    useEpicLeftPanelStore
      .getState()
      .setPanelVisibilityOverride("artifacts", false);
    startSession();
    render(<Harness />);
    expect(screen.getByTestId("epic-rail-ghost-artifacts")).not.toBeNull();
    const before = railOrder();
    expect(before.slice(0, 2)).toEqual(["chats", "artifacts"]);

    await clickMove("artifacts", "Move up");

    expect(history().past).toHaveLength(1);
    const after = railOrder();
    expect(after).toEqual(storedOrder());
    expect(after).not.toEqual(before);
    expect(after.indexOf("artifacts")).toBeLessThan(after.indexOf("chats"));
    expect(screen.getByTestId("epic-rail-ghost-artifacts")).not.toBeNull();
  });
});
