import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorShell } from "@/components/layout-editor/inspector/inspector-shell";
import { SurfaceSection } from "@/components/layout-editor/inspector/surface-section";
import {
  DEFAULT_ARRANGEMENT,
  insertRailDivider,
  stackRailPanels,
  unstackRail,
} from "@/lib/layout/layout-arrangement";
import { railStackId, type RailEntry } from "@/lib/layout/rail";
import type { RegionId } from "@/lib/layout/region-id";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutSnapshot,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * The rail's STACK link (L-166, L-167, L-168): a row of its own in the
 * Position list, a Remove of its own, and the button on the panel above it
 * that makes one.
 *
 * Rendered through the same seam the rail's other Position-list rows are
 * covered by (see `inspector/__tests__/sortable-list.test.tsx`): the sidebar
 * area's `SurfaceSection`, docked in `InspectorShell`, so a press lands through
 * `writeArrangement` -> `recordGesture` exactly as it does live. The Position
 * list this draws is the WHOLE rail's, not a slice of it - selecting one rail
 * region still shows every panel and stack link in the rail's own order
 * (L-25), which is why `section("railAgents", ...)` below is enough to reach
 * every row this file asserts on, including Terminals' and Comments'.
 */

/** Rendered live off the store, so a write one press makes is seen by the next. */
function SidebarSection(props: {
  readonly regionId: RegionId;
  readonly onExit: () => void;
}): ReactNode {
  const snapshot = useLayoutSnapshot();
  return (
    <InspectorShell onExit={props.onExit}>
      <SurfaceSection
        surface="sidebar"
        snapshot={snapshot}
        openRows={[]}
        onToggleRow={vi.fn()}
        onSelectRow={null}
        selectedRow={props.regionId}
      />
    </InspectorShell>
  );
}

function section(regionId: RegionId, onExit: () => void): ReactNode {
  return <SidebarSection regionId={regionId} onExit={onExit} />;
}

function rows(): ReadonlyArray<HTMLElement> {
  return [...document.querySelectorAll<HTMLElement>("[data-sortable-id]")];
}

function row(id: string): HTMLElement {
  const node = document.querySelector(`[data-sortable-id="${id}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`no such row: ${id}`);
  return node;
}

function rowIds(): ReadonlyArray<string> {
  return rows().map((node) => node.getAttribute("data-sortable-id") ?? "");
}

function rail(): ReadonlyArray<RailEntry> {
  return useLayoutStore.getState().arrangement.rail;
}

/** The rail's panel ids alone, in order - what a stack write must not disturb. */
function panelIds(entries: ReadonlyArray<RailEntry>): ReadonlyArray<string> {
  return entries.flatMap((entry) => (entry.kind === "panel" ? [entry.id] : []));
}

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLeftPanelStore.setState({
    panelSectionCollapsedByPanelId: {},
    panelSectionWeightsByPanelId: {},
  });
  useLayoutEditorStore.getState().endSession();
  useLayoutEditorStore.getState().beginSession({
    entry: "keyboard",
    source: "direct_ui",
    startedAt: 0,
    origin: { kind: "tab" },
  });
});

afterEach(() => {
  cleanup();
  useLayoutEditorStore.getState().endSession();
});

describe("the stack link as its own Position-list row (L-166, L-168)", () => {
  it("sits between the Agents row and the Artifacts row, with no grip, listing both as Unstack chips (L-181)", () => {
    render(section("railAgents", vi.fn()));
    const linkId = railStackId(["railAgents", "railArtifacts"]);

    const ids = rowIds();
    expect(ids.indexOf("railAgents")).toBe(0);
    expect(ids.indexOf(linkId)).toBe(1);
    expect(ids.indexOf("railArtifacts")).toBe(2);

    const linkRow = row(linkId);
    expect(linkRow.querySelector("[data-row-grab]")?.textContent).toBe("Stack");
    // Not draggable: the link moves with its panels rather than on its own
    // (L-168), so its row carries no grip - the one thing that sets it apart
    // from a divider row, which IS draggable.
    expect(linkRow.querySelector("[data-row-grip]")).toBeNull();
    // Both members drawn as their own chip, each with its own way out.
    expect(
      Array.from(linkRow.querySelectorAll("[data-stack-member]")).map((chip) =>
        chip.getAttribute("data-stack-member"),
      ),
    ).toEqual(["railAgents", "railArtifacts"]);
    expect(
      within(linkRow).getByRole("button", { name: "Unstack Agents" }),
    ).toBeDefined();
    expect(
      within(linkRow).getByRole("button", { name: "Unstack Artifacts" }),
    ).toBeDefined();
  });

  it("removes the link on 'Remove stack', leaving both panels where they were", () => {
    render(section("railAgents", vi.fn()));
    const linkId = railStackId(["railAgents", "railArtifacts"]);
    const before = rail();

    fireEvent.click(screen.getByRole("button", { name: "Remove stack" }));

    const after = rail();
    expect(
      after.some((entry) => entry.kind === "stack" && entry.id === linkId),
    ).toBe(false);
    expect(after).toHaveLength(before.length - 1);
    // Both panels stay exactly where they were, in the same order - unstacking
    // takes out the join and nothing else (L-168).
    expect(panelIds(after)).toEqual(panelIds(before));
  });

  it("takes a MIDDLE member out from its own chip, moving it just after the remaining stack (L-181)", () => {
    useLayoutStore.setState({
      arrangement: stackRailPanels(
        useLayoutStore.getState().arrangement,
        "terminals",
        "artifacts",
        "stack",
      ),
    });
    render(section("railAgents", vi.fn()));
    const linkId = railStackId([
      "railAgents",
      "railArtifacts",
      "railTerminals",
    ]);
    const linkRow = row(linkId);

    fireEvent.click(
      within(linkRow).getByRole("button", { name: "Unstack Artifacts" }),
    );

    const after = rail();
    const remainingLinkId = railStackId(["railAgents", "railTerminals"]);
    expect(
      after.some(
        (entry) => entry.kind === "stack" && entry.id === remainingLinkId,
      ),
    ).toBe(true);
    // Artifacts steps out to just after the (now two-member) stack, rather
    // than staying in the middle and splitting it.
    expect(panelIds(after)).toEqual([
      "railAgents",
      "railTerminals",
      "railArtifacts",
      "railBrowsers",
      "railGitDiff",
      "railPullRequests",
      "railFileTree",
      "railSharing",
      "railComments",
    ]);
  });
});

describe("stacking a panel from its own row (L-166, L-168)", () => {
  it("offers 'Stack <name> with the panel below' only on the LAST member of a block whose next entry is a panel (L-181)", () => {
    render(section("railAgents", vi.fn()));

    // Terminals sits directly above Browsers and neither is in a stack yet:
    // the one case the button was always for.
    expect(
      screen.getByRole("button", {
        name: "Stack terminals with the panel below",
      }),
    ).toBeDefined();
    // Agents is the FIRST member of the shipped pair, not the last.
    expect(
      screen.queryByRole("button", {
        name: "Stack agents with the panel below",
      }),
    ).toBeNull();
    // Artifacts IS the last member, and Terminals follows it: now offered,
    // since a join can grow a stack past two (L-181), unlike the old
    // two-member cap that refused every already-stacked panel.
    expect(
      screen.getByRole("button", {
        name: "Stack artifacts with the panel below",
      }),
    ).toBeDefined();
    // Comments is the rail's last row: nothing sits below it to join.
    expect(
      screen.queryByRole("button", {
        name: "Stack comments with the panel below",
      }),
    ).toBeNull();
  });

  it("keeps the pressed panel ABOVE and moves nothing (L-170)", () => {
    render(section("railAgents", vi.fn()));
    const before = panelIds(rail());

    fireEvent.click(
      screen.getByRole("button", {
        name: "Stack terminals with the panel below",
      }),
    );

    const after = rail();
    // The row promises "with the panel below", so Terminals stays where it is
    // and Browsers stays where it is: the join is placed between them and the
    // panel ORDER is untouched, which is the same promise Remove makes.
    expect(panelIds(after)).toEqual(before);
    const linkId = railStackId(["railTerminals", "railBrowsers"]);
    const linkIndex = after.findIndex(
      (entry) => entry.kind === "stack" && entry.id === linkId,
    );
    expect(linkIndex).toBeGreaterThan(-1);
    expect(after[linkIndex - 1]).toEqual({
      kind: "panel",
      id: "railTerminals",
    });
    expect(after[linkIndex + 1]).toEqual({ kind: "panel", id: "railBrowsers" });
  });

  it("draws the Stack verb before the row's own control, with no leftover slot elsewhere (L-122, L-170)", () => {
    render(section("railAgents", vi.fn()));
    const terminals = row("railTerminals");

    const stack = within(terminals).getByRole("button", {
      name: "Stack terminals with the panel below",
    });
    const control = within(terminals).getByRole("radiogroup");
    // Before the control, not after it: the two rail-only verbs (Stack,
    // Remove) sit on either side of the row's one state control.
    expect(
      stack.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Nothing left behind on a row with no join to offer.
    expect(
      within(row("railComments")).queryByRole("button", { name: /^Stack / }),
    ).toBeNull();
  });

  it("opens a rejoined pair with both sections showing (L-170)", () => {
    render(section("railAgents", vi.fn()));
    // Collapse one half of the shipped pair, take the pair apart, then put it
    // back: while the two are apart neither draws a chevron, so the flag has
    // had no control that could clear it and must not come back with the join.
    useLeftPanelStore.getState().togglePanelSectionCollapsed("artifacts");
    fireEvent.click(screen.getByRole("button", { name: "Remove stack" }));

    fireEvent.click(
      screen.getByRole("button", {
        name: "Stack agents with the panel below",
      }),
    );

    expect(
      useLeftPanelStore.getState().panelSectionCollapsedByPanelId.artifacts,
    ).toBe(false);
    expect(
      rail().some(
        (entry) =>
          entry.kind === "stack" &&
          entry.id === railStackId(["railAgents", "railArtifacts"]),
      ),
    ).toBe(true);
  });
});

describe("the rail list on a phone, which has no rail", () => {
  const originalWidth = window.innerWidth;
  beforeEach(() => {
    window.innerWidth = 500;
    const state = useLayoutStore.getState();
    // A divider as well as the shipped Agents + Artifacts stack, so both of
    // the kinds a phone cannot draw are in the rail.
    state.setArrangement(insertRailDivider(state.arrangement, 3));
  });
  afterEach(() => {
    window.innerWidth = originalWidth;
  });

  it("lists only the panels, with no divider, stack or Stack verb, and the pinned More line", () => {
    render(section("railAgents", vi.fn()));
    // Positive control: the rail really holds a divider and a stack.
    expect(rail().some((entry) => entry.kind === "divider")).toBe(true);
    expect(rail().some((entry) => entry.kind === "stack")).toBe(true);

    expect(rowIds()).toEqual(panelIds(rail()));
    expect(screen.queryByRole("button", { name: "Add divider" })).toBeNull();
    expect(screen.queryAllByRole("button", { name: /^Stack / })).toHaveLength(
      0,
    );
    expect(screen.getByTestId("layout-rail-more-row")).toBeTruthy();
    expect(
      screen.getByText(
        "Drag to reorder. Turn a panel off to move it into More.",
      ),
    ).toBeTruthy();
  });

  it("reorders the panels among their slots, leaving the divider and the stack where they are", () => {
    render(section("railAgents", vi.fn()));
    const before = rail();
    const panels = panelIds(before);
    const grabbed = row(panels[2]);

    fireEvent.keyDown(grabbed, { key: " " });
    fireEvent.keyDown(grabbed, { key: "ArrowUp" });
    fireEvent.keyDown(grabbed, { key: "ArrowUp" });
    fireEvent.keyDown(grabbed, { key: " " });

    expect(panelIds(rail())).toEqual([
      panels[2],
      panels[0],
      panels[1],
      ...panels.slice(3),
    ]);
    expect(rail().filter((entry) => entry.kind !== "panel")).toEqual(
      before.filter((entry) => entry.kind !== "panel"),
    );
    // The filtered check above passes even if the stack or the divider
    // physically slid to a different ARRAY index (it would still equal
    // itself); this checks the whole rail, positions included - the divider
    // and the stack link stay directly after the SAME panel they already
    // followed (Artifacts, Agents), not after whatever panel this move left
    // sitting at their old raw index.
    const stackEntry = before.find((entry) => entry.kind === "stack");
    const dividerEntry = before.find((entry) => entry.kind === "divider");
    if (stackEntry === undefined || dividerEntry === undefined) {
      throw new Error("fixture must seed a stack and a divider");
    }
    expect(rail()).toEqual([
      { kind: "panel", id: panels[2] },
      { kind: "panel", id: panels[0] },
      stackEntry,
      { kind: "panel", id: panels[1] },
      dividerEntry,
      ...panels.slice(3).map((id) => ({ kind: "panel", id })),
    ]);
  });
});

describe("the stack row while the rail does not draw the stack (T3)", () => {
  const linkId = railStackId(["railAgents", "railArtifacts"]);

  /** A row reads as off through its line's muted text, as a hidden panel's does. */
  function dimmed(id: string): boolean {
    return (
      row(id)
        .querySelector("[data-row-line]")
        ?.classList.contains("text-muted-foreground") ?? false
    );
  }

  it("reads as live while two of its members are shown", () => {
    render(section("railAgents", vi.fn()));

    expect(dimmed(linkId)).toBe(false);
  });

  it("dims once fewer than two members are shown, since the rail draws the lone one on its own, and wakes with the second", () => {
    render(section("railAgents", vi.fn()));

    act(() => {
      useLayoutStore
        .getState()
        .setRegionValues("railArtifacts", { shown: "hidden" });
    });
    expect(dimmed(linkId)).toBe(true);
    // The member's own row is the one that says Hidden; the Agents row is not
    // dimmed by it.
    expect(dimmed("railAgents")).toBe(false);

    act(() => {
      useLayoutStore
        .getState()
        .setRegionValues("railArtifacts", { shown: "shown" });
    });
    expect(dimmed(linkId)).toBe(false);
  });
});

describe("the rail list's own header revert (R3-11)", () => {
  it("shows a revert on the group header only once its order has moved", () => {
    render(section("railAgents", vi.fn()));

    expect(
      screen.queryByRole("button", { name: "Revert Sidebar panels order" }),
    ).toBeNull();

    fireEvent.keyDown(row("railAgents"), { key: "ArrowDown", altKey: true });

    expect(
      screen.getByRole("button", { name: "Revert Sidebar panels order" }),
    ).toBeDefined();
  });

  it("is the only revert after one panel moved: no member row shows one, and it puts back the order, the dividers and the stacks (T2)", () => {
    render(section("railAgents", vi.fn()));
    fireEvent.keyDown(row("railTerminals"), { key: "ArrowUp", altKey: true });
    act(() => {
      useLayoutStore
        .getState()
        .setArrangement(
          insertRailDivider(useLayoutStore.getState().arrangement, 3),
        );
    });
    act(() => {
      useLayoutStore
        .getState()
        .setArrangement(
          unstackRail(
            useLayoutStore.getState().arrangement,
            railStackId(["railAgents", "railArtifacts"]),
          ),
        );
    });
    expect(panelIds(rail())).not.toEqual(panelIds(DEFAULT_ARRANGEMENT.rail));

    // Not one dot or revert on a member row: every panel's own row is quiet,
    // so the header's is the one way back for the whole list.
    expect(
      screen
        .getAllByRole("button", { name: /^Revert / })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Revert Sidebar panels order"]);

    fireEvent.click(
      screen.getByRole("button", { name: "Revert Sidebar panels order" }),
    );

    expect(rail()).toEqual(DEFAULT_ARRANGEMENT.rail);
  });
});
