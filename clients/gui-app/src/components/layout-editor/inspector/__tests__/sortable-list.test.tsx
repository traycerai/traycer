import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { armLayoutDrag } from "@/components/layout-editor/canvas/drag-engine";
import { LayoutFormHostContext } from "@/components/layout-editor/inspector/layout-form-host";
import { InspectorShell } from "@/components/layout-editor/inspector/inspector-shell";
import { RevertButton } from "@/components/layout-editor/inspector/inspector-row";
import { RegionDisplayControl } from "@/components/layout-editor/inspector/region-controls";
import {
  BARE_ROW,
  regionRowItems,
  type SortableRowDecoration,
} from "@/components/layout-editor/inspector/rows/order-row-items";
import {
  SortableList,
  type SortableListItem,
} from "@/components/layout-editor/inspector/sortable-list";
import { SurfaceSection } from "@/components/layout-editor/inspector/surface-section";
import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import { regionFacts } from "@/components/layout-editor/regions/region-facts";
import {
  ORDER_GROUPS,
  orderGroupInstruction,
  orderGroupListLabel,
} from "@/components/layout-editor/regions/surface-groups";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
import { DEFAULT_RAIL, railDividerId } from "@/lib/layout/rail";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import type { RegionId } from "@/lib/layout/region-id";

/**
 * The engine that owns the real pointer machinery (rAF, springs,
 * `pointercapture`) is replaced by a spy: what these tests are about is which
 * press starts a drag, not the drag itself, which `canvas/__tests__/drag-engine.test.ts`
 * already covers on its own.
 */
vi.mock(
  "@/components/layout-editor/canvas/drag-engine",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/layout-editor/canvas/drag-engine")
      >();
    return { ...actual, armLayoutDrag: vi.fn() };
  },
);

/**
 * The inspector's sortable list, through the section that draws it (L-24,
 * L-31).
 *
 * Rendered as the real section rather than as the list alone, because the two
 * things under test are relationships with the surfaces around it: a reorder
 * has to be ONE entry on the editor's own history, and a cancelled grab has to
 * stop before the editor's Escape ladder, which listens on the shell.
 */

function section(regionId: RegionId, onExit: () => void): ReactNode {
  return (
    <InspectorShell onExit={onExit}>
      <SurfaceSection
        surface={LAYOUT_REGIONS[regionId].surface}
        snapshot={snapshot()}
        openRows={[]}
        onToggleRow={vi.fn()}
        onSelectRow={null}
        selectedRow={regionId}
      />
    </InspectorShell>
  );
}

/**
 * The same list on the other host (L-03, L-95), where the rows carry their own
 * controls: the Settings page draws a surface card with `onMove: null`, so its
 * rows are unordered AND decorated, which is the combination R1-02 was about.
 * Chat is the surface with no picture and no order group, so the card is its
 * two rows and nothing else.
 */
function chatCard(
  openRows: ReadonlyArray<string>,
  onToggleRow: (rowId: string) => void,
): ReactNode {
  return (
    <LayoutFormHostContext value="page">
      <SurfaceSection
        surface="chat"
        snapshot={snapshot()}
        openRows={openRows}
        onToggleRow={onToggleRow}
        onSelectRow={null}
        selectedRow={null}
      />
    </LayoutFormHostContext>
  );
}

function snapshot(): LayoutSnapshot {
  const state = useLayoutStore.getState();
  return {
    basePreset: state.basePreset,
    overrides: state.overrides,
    arrangement: state.arrangement,
  };
}

/**
 * `scope` narrows to one order group's own list, needed only where a surface
 * draws more than one (composer's dock, toolbarLeft and toolbarRight): every
 * other surface under test here has a single sortable list, so its rows are
 * unambiguous straight off `document`.
 */
function row(id: string, scope: ParentNode): HTMLElement {
  const node = scope.querySelector(`[data-sortable-id="${id}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`no such row: ${id}`);
  return node;
}

function rows(scope: ParentNode): ReadonlyArray<HTMLElement> {
  return [...scope.querySelectorAll<HTMLElement>("[data-sortable-id]")];
}

/** The element carrying the row's operation, which is never the whole line. */
function grabOf(rowNode: HTMLElement): HTMLElement {
  const node = rowNode.querySelector("[data-row-grab]");
  if (!(node instanceof HTMLElement)) throw new Error("row has no grab");
  return node;
}

/**
 * The element a row's grab names as its presence rule: the second of the two
 * descriptions, the first being the list's one shared line of grab
 * instructions.
 */
function ruleOf(rowNode: HTMLElement): HTMLElement {
  const ids = (grabOf(rowNode).getAttribute("aria-describedby") ?? "").split(
    " ",
  );
  const node = document.getElementById(ids.at(-1) ?? "");
  if (!(node instanceof HTMLElement)) throw new Error("row has no rule");
  return node;
}

/** Anything a screen reader names as a control, or a Tab stop can land on. */
const INTERACTIVE =
  'a[href], button, input, select, textarea, [tabindex], [role="button"], [role="radio"], [role="radiogroup"], [role="switch"], [role="checkbox"]';

/** A row's ONE state control, whatever shape its options take (L-121). */
const STATE_CONTROL = '[role="radiogroup"], [role="switch"]';

function rowOrder(scope: ParentNode): ReadonlyArray<string> {
  return rows(scope).map((node) => node.getAttribute("data-sortable-id") ?? "");
}

/** The dock's own list, scoped out of composer's other two (toolbarLeft/Right). */
function dockGroup(): HTMLElement {
  return screen.getByRole("group", { name: orderGroupListLabel("dock") });
}

/**
 * The dock list's own announcement, a SIBLING of its `role="group"` rather
 * than a descendant (`SortableList` renders the two side by side) - composer
 * draws three ordered lists, so the unscoped `announcement()` below would read
 * whichever of the three happened to render last.
 */
function dockAnnouncement(): string {
  return dockGroup().nextElementSibling?.textContent ?? "";
}

function announcement(): string {
  return screen.getAllByRole("status").at(-1)?.textContent ?? "";
}

function dockOrder(): ReadonlyArray<string> {
  return useLayoutStore.getState().arrangement.dock;
}

function historyDepth(): number {
  return useLayoutEditorStore.getState().history.past.length;
}

/**
 * The shipped rail carries no dividers of its own any more (L-155): it is a
 * flat list of panels, and a divider exists only once a user adds one. Tests
 * that are about an EXISTING divider's own row seed one directly rather than
 * relying on a default the rail no longer ships.
 */
function seedRailDivider(): void {
  const arrangement = useLayoutStore.getState().arrangement;
  useLayoutStore.setState({
    arrangement: {
      ...arrangement,
      rail: [
        ...DEFAULT_RAIL.slice(0, 1),
        { kind: "divider", id: railDividerId(1) },
        ...DEFAULT_RAIL.slice(1),
      ],
      dividerSeq: 1,
    },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
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

describe("the sortable list's keyboard path (L-24, L-31)", () => {
  it("grabs with space, moves with the arrows and drops as one history entry", () => {
    render(section("runningAgents", vi.fn()));
    const start = dockOrder();
    const grabbed = row(start[0], dockGroup());

    fireEvent.keyDown(grabbed, { key: " " });

    expect(dockAnnouncement()).toContain("Grabbed");
    // A grab moves nothing yet: the list shows where it would land.
    expect(dockOrder()).toEqual(start);

    fireEvent.keyDown(grabbed, { key: "ArrowDown" });
    fireEvent.keyDown(grabbed, { key: "ArrowDown" });

    const movedDownTwo = [start[1], start[2], start[0], ...start.slice(3)];

    expect(rowOrder(dockGroup())).toEqual(movedDownTwo);
    expect(dockOrder()).toEqual(start);
    expect(dockAnnouncement()).toContain(
      `position 3 of ${String(start.length)}`,
    );

    fireEvent.keyDown(grabbed, { key: " " });

    expect(dockOrder()).toEqual(movedDownTwo);
    // Two arrow presses, one entry: undo puts the row back where it was.
    expect(historyDepth()).toBe(1);
    expect(dockAnnouncement()).toContain("Dropped");

    useLayoutEditorStore.getState().undo();

    expect(dockOrder()).toEqual(start);
  });

  it("puts a cancelled grab back and stops the escape short of the ladder", () => {
    const onExit = vi.fn();
    render(section("runningAgents", onExit));
    const start = dockOrder();
    const grabbed = row(start[0], dockGroup());

    fireEvent.keyDown(grabbed, { key: " " });
    fireEvent.keyDown(grabbed, { key: "ArrowDown" });
    expect(rowOrder(dockGroup())).toEqual([
      start[1],
      start[0],
      ...start.slice(2),
    ]);

    fireEvent.keyDown(grabbed, { key: "Escape" });

    expect(rowOrder(dockGroup())).toEqual(start);
    expect(dockOrder()).toEqual(start);
    expect(historyDepth()).toBe(0);
    expect(dockAnnouncement()).toContain("Cancelled");
    // The section is still open and the editor is still here: a cancelled
    // grab is its own rung of the Escape ladder.
    expect(onExit).not.toHaveBeenCalled();
    expect(useLayoutEditorStore.getState().selected).toBeNull();
  });

  it("drops a grab that loses focus rather than leaving it swallowing arrows", () => {
    render(section("runningAgents", vi.fn()));
    const start = dockOrder();
    const grabbed = row(start[0], dockGroup());

    fireEvent.keyDown(grabbed, { key: " " });
    fireEvent.keyDown(grabbed, { key: "ArrowDown" });
    fireEvent.blur(grabbed);

    expect(rowOrder(dockGroup())).toEqual(start);
    expect(dockOrder()).toEqual(start);
    expect(historyDepth()).toBe(0);
  });

  it("nudges by one on Alt+Arrow, which is one entry of its own", () => {
    render(section("runningAgents", vi.fn()));
    const start = dockOrder();

    fireEvent.keyDown(row(start[2], dockGroup()), {
      key: "ArrowUp",
      altKey: true,
    });

    expect(dockOrder()).toEqual([
      start[0],
      start[2],
      start[1],
      ...start.slice(3),
    ]);
    expect(historyDepth()).toBe(1);
  });

  it("leaves a bare arrow to the index, which is the surface that walks", () => {
    render(section("runningAgents", vi.fn()));
    const start = dockOrder();

    fireEvent.keyDown(row(start[0], dockGroup()), { key: "ArrowDown" });

    expect(dockOrder()).toEqual(start);
    expect(historyDepth()).toBe(0);
  });
});

describe("what a row claims as its own (R1-02)", () => {
  it("keeps the dock's own row controls out of the grab", () => {
    // The rail is the inspector's decorated list: every divider carries a real
    // Remove button, which used to sit INSIDE the `role="button"` line. The
    // shipped rail carries none of its own (L-155), so this seeds one.
    seedRailDivider();
    render(section("railAgents", vi.fn()));

    const decorated = rows(document).filter(
      (node) => node.querySelectorAll(INTERACTIVE).length > 1,
    );
    expect(decorated.length).toBeGreaterThan(0);
    for (const rowNode of rows(document)) {
      expect(
        grabOf(rowNode).querySelectorAll(INTERACTIVE),
        rowNode.getAttribute("data-sortable-id") ?? "",
      ).toHaveLength(0);
    }
  });

  it("keeps the page's row controls out of the grab, and out of its name", () => {
    render(chatCard([], vi.fn()));

    const minimap = row("minimap", document);
    // The row really does carry controls - a side choice and a Shown switch -
    // so the emptiness asserted below is a place, not an absence.
    expect(
      minimap.querySelectorAll('[role="radio"], [role="switch"]').length,
    ).toBeGreaterThan(1);
    for (const rowNode of rows(document)) {
      expect(grabOf(rowNode).querySelectorAll(INTERACTIVE)).toHaveLength(0);
    }

    // A composite widget names itself from its contents: the row is "Minimap",
    // never "Minimap Left Right Show Minimap". Said of EVERY row in the card,
    // hinted or not, because the precondition that used to stand here excluded
    // the only rows the defect was ever about (R2-08).
    const facts = regionFacts("minimap");
    expect(grabOf(minimap).textContent).toBe(facts.name);
    const named = screen.getByRole("button", { name: facts.name });
    expect(named).toBe(grabOf(minimap));
  });

  it("still opens an unordered row's disclosure from the keyboard", () => {
    const toggled = vi.fn();
    render(chatCard([], toggled));
    // Context usage is the chat row with something behind it (Style and
    // Fine-tune); the minimap row has no disclosure at all.
    const grab = grabOf(row("contextUsage", document));

    fireEvent.keyDown(grab, { key: " " });
    fireEvent.keyDown(grab, { key: "Enter" });

    expect(toggled.mock.calls).toEqual([["contextUsage"], ["contextUsage"]]);
    expect(grab.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("a region row's one line in the dock host (L-64)", () => {
  it("never wraps the label under the control, which sits after it as a sibling", () => {
    render(section("runningAgents", vi.fn()));
    const line = row(dockOrder()[0], dockGroup()).querySelector(
      "[data-row-line]",
    );
    if (line === null) throw new Error("row has no line");

    // The page host alone wraps, and only below `md` - the dock host never
    // carries the wrap classes at all.
    expect(line.className).not.toMatch(/flex-wrap|basis-full/);

    const [labelCluster, controlColumn] = [...line.children];
    expect(labelCluster.querySelector("[data-row-grab]")).not.toBeNull();
    expect(controlColumn.querySelectorAll(STATE_CONTROL)).toHaveLength(1);
    expect(controlColumn.previousElementSibling).toBe(labelCluster);
  });
});

/**
 * The page row's own anatomy, built from the row builders rather than through
 * a surface card: what is under test is the ROW - its one state control, the
 * slot it reserves for a revert, where its presence rule lives and what it
 * draws for a glyph - and which regions get which of those is the card's
 * decision, on the other side of this seam.
 */
describe("the page's row anatomy (L-120, L-121, L-122, R2-08)", () => {
  /** One plain rail panel and one that carries a presence rule and a revert. */
  const ROW_IDS: ReadonlyArray<RegionId> = ["railAgents", "railPullRequests"];
  const CHANGED: RegionId = "railPullRequests";

  function PageRowList(props: {
    /** Which rows are showing their disclosure, as the page owns it (L-89). */
    readonly openIds: ReadonlyArray<string>;
  }): ReactNode {
    const snap = snapshot();
    const values = effectiveLayoutValues(snap.basePreset, snap.overrides);

    function decorate(id: string): SortableRowDecoration {
      const regionId = ROW_IDS.find((candidate) => candidate === id);
      if (regionId === undefined) return BARE_ROW;
      const changed = regionId === CHANGED;
      return {
        ...BARE_ROW,
        hint: regionFacts(regionId).hint,
        control: <RegionDisplayControl regionId={regionId} values={values} />,
        revert: changed ? (
          <RevertButton
            label={`Revert ${regionFacts(regionId).name}`}
            onRevert={() => undefined}
          />
        ) : null,
        detail: <p data-testid={`${regionId}-detail`}>Style and fine-tune</p>,
        open: props.openIds.includes(regionId),
        onToggleOpen: () => undefined,
      };
    }

    return (
      <LayoutFormHostContext value="page">
        <SortableList
          label="Sidebar panels"
          selectedId={null}
          items={regionRowItems(ROW_IDS, values, decorate)}
          onMove={() => undefined}
        />
      </LayoutFormHostContext>
    );
  }

  it("shows a revert only on the changed row, with no reserved slot on the rest", () => {
    render(<PageRowList openIds={[]} />);

    // No empty box is left behind on the row that has not changed.
    expect(
      within(row("railAgents", document)).queryByRole("button", {
        name: /^Revert /,
      }),
    ).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Revert / })).toHaveLength(1);
    const revert = within(row(CHANGED, document)).getByRole("button", {
      name: `Revert ${regionFacts(CHANGED).name}`,
    });
    // Right after the name, in the same cluster as the grab (L-122, LV2-11).
    expect(grabOf(row(CHANGED, document)).parentElement?.contains(revert)).toBe(
      true,
    );
  });

  it("gives a row exactly one state control, outside its grab", () => {
    render(<PageRowList openIds={[]} />);

    for (const node of rows(document)) {
      expect(node.querySelectorAll(STATE_CONTROL)).toHaveLength(1);
      // Still true with a real component drawn inside the grab: the glyph is
      // `inert`, so the picture of a rail button is not a second button.
      expect(grabOf(node).querySelectorAll(INTERACTIVE)).toHaveLength(0);
    }
    expect(
      screen.getByRole("radiogroup", {
        name: `${regionFacts("railAgents").name} display`,
      }),
    ).toBeDefined();
  });

  it("describes the row by its presence rule instead of naming itself from it", () => {
    render(<PageRowList openIds={[]} />);
    const hint = regionFacts(CHANGED).hint;
    const grab = grabOf(row(CHANGED, document));

    expect(hint).not.toBeNull();
    expect(grab.textContent).toBe(regionFacts(CHANGED).name);

    const described = (grab.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id));
    const rule = described.find((node) => node?.textContent === hint);
    expect(rule).toBeDefined();
    // A description is a SIBLING of the control it describes; inside it, it is
    // part of the control's name instead (R2-08).
    expect(grab.contains(rule ?? null)).toBe(false);
    // The grab instructions are still there beside it.
    expect(described.length).toBe(2);
  });

  /**
   * One row height for a plain row and a hinted one (R3-08, LV2-11).
   *
   * Measured as the thing that CAUSED the difference rather than as a pixel
   * count jsdom cannot give: the rule used to be an extra line inside the row's
   * own padding box, so a list of nine panels had rows of two different heights
   * depending on which of them happened to have a presence rule. It is the
   * first line of the disclosure now, and while the row is closed it is present
   * and described but takes no space at all.
   */
  it("keeps the presence rule out of the row's line, and in its disclosure", () => {
    render(<PageRowList openIds={[]} />);
    const hint = regionFacts(CHANGED).hint;
    const closed = ruleOf(row(CHANGED, document));

    // Still reachable without opening anything, and still costing no height.
    expect(closed.className).toContain("sr-only");
    // The line is the padding box every row draws, hinted or not, and the rule
    // is outside it on both - which is the whole of the fix.
    for (const node of rows(document)) {
      const line = node.querySelector("[data-row-line]");
      expect(line).not.toBeNull();
      expect(line?.contains(closed)).toBe(false);
    }

    cleanup();
    render(<PageRowList openIds={[CHANGED]} />);
    const opened = ruleOf(row(CHANGED, document));
    const detail = row(CHANGED, document).querySelector(
      "[data-sortable-detail]",
    );

    // Opened, it is the first thing the row says about itself: the first
    // element of the disclosure is the rule's own gutter, holding it.
    expect(detail?.firstElementChild?.contains(opened)).toBe(true);
    expect(opened.className).not.toContain("sr-only");
    expect(opened.textContent).toBe(hint);
  });

  it("draws the registry icon for a rail row, now that the rail carries no glyph of its own (L-120)", () => {
    render(<PageRowList openIds={[]} />);
    const rail = row("railAgents", document);

    expect(rail.querySelector("[data-row-icon]")).not.toBeNull();
    // The rail's real button used to sit here instead; only a provider row
    // still carries a glyph.
    expect(rail.querySelectorAll("[data-row-glyph]")).toHaveLength(0);
  });
});

/**
 * One header component, composed by both hosts (R3-11).
 *
 * The page's surface card and the dock's Providers level each used to BUILD
 * this header - the same gutter, the same `h3`, the same `max-w-[72ch]`
 * paragraph - so a change to its shape had to be made in two files or the two
 * stopped matching, which is the drift R1-04 named one layer down. What the two
 * hosts are allowed to differ by is the row scale, and nothing else.
 */
describe("the list header, in both hosts (R3-11)", () => {
  /** The Status bar card, whose one list is the providers (L-123). */
  function statusBarCard(): ReactNode {
    return (
      <LayoutFormHostContext value="page">
        <SurfaceSection
          surface="statusBar"
          snapshot={snapshot()}
          openRows={[]}
          onToggleRow={vi.fn()}
          onSelectRow={null}
          selectedRow={null}
        />
      </LayoutFormHostContext>
    );
  }

  /** The same list in the dock, under Usage limits (L-26): the same
   * `SurfaceSection`, only the host context differs (L-03). */
  function providersLevel(): ReactNode {
    return (
      <LayoutFormHostContext value="inspector">
        <SurfaceSection
          surface="statusBar"
          snapshot={snapshot()}
          openRows={[]}
          onToggleRow={vi.fn()}
          onSelectRow={null}
          selectedRow={null}
        />
      </LayoutFormHostContext>
    );
  }

  /** What the two hosts may differ by: the row's own gutter and type scale. */
  function shapeOf(
    node: HTMLElement | null | undefined,
  ): ReadonlyArray<string> {
    return (node?.className ?? "")
      .split(" ")
      .filter(
        (name) =>
          name !== "" &&
          !name.startsWith("px-") &&
          !name.startsWith("py-") &&
          !name.startsWith("text-ui"),
      );
  }

  function headingOf(): HTMLElement {
    return screen.getByRole("heading", {
      name: ORDER_GROUPS.usageProviders.label,
      level: 3,
    });
  }

  /** The heading and its revert share a row; the instruction is that row's sibling. */
  function instructionOf(heading: HTMLElement): string | undefined {
    return heading.parentElement?.nextElementSibling?.textContent ?? undefined;
  }

  it("draws one header shape wherever the list is drawn", () => {
    const words = orderGroupInstruction("usageProviders");

    render(statusBarCard());
    const onPage = headingOf();
    expect(instructionOf(onPage)).toBe(words);
    const pageShape = [
      shapeOf(onPage.parentElement),
      shapeOf(onPage.parentElement?.parentElement),
    ];

    cleanup();
    render(providersLevel());
    const inDock = headingOf();

    // Same words, said once, in the same box: the instruction is the header's
    // description on both hosts rather than a footnote under one of them.
    expect(instructionOf(inDock)).toBe(words);
    expect([
      shapeOf(inDock.parentElement),
      shapeOf(inDock.parentElement?.parentElement),
    ]).toEqual(pageShape);
  });

  it("names the rail list 'Panels'", () => {
    render(section("railAgents", vi.fn()));

    expect(
      screen.getByRole("heading", { name: "Panels", level: 3 }),
    ).toBeDefined();
  });

  it("states the message-queue rule as part of the dock's own instruction", () => {
    render(section("runningAgents", vi.fn()));
    const heading = screen.getByRole("heading", {
      name: ORDER_GROUPS.dock.label,
      level: 3,
    });

    expect(instructionOf(heading)).toContain(
      "The message queue stays next to the message box.",
    );
  });
});

describe("the rail's dividers as items (L-25)", () => {
  function railIds(): ReadonlyArray<string> {
    return useLayoutStore.getState().arrangement.rail.map((entry) => entry.id);
  }

  it("adds a boundary before the last panel, as one entry (L-159)", () => {
    render(section("railAgents", vi.fn()));
    const before = railIds();

    fireEvent.click(screen.getByRole("button", { name: "Add divider" }));

    const after = railIds();
    expect(after).toHaveLength(before.length + 1);
    const newDividerId = after.find((id) => !before.includes(id)) ?? "";
    // Never an id a divider has held before, so the rail's own ids stay unique.
    expect(newDividerId).not.toBe("");
    // Sits between the second-to-last and last rail rows rather than
    // appended past the last icon: a divider past the last icon in a
    // justify-start column spaces nothing, so the press would read as a
    // no-op.
    expect(after.at(-2)).toBe(newDividerId);
    expect(after.at(-1)).toBe(before.at(-1));
    expect(historyDepth()).toBe(1);
  });

  it("removes one from its own row", () => {
    seedRailDivider();
    render(section("railAgents", vi.fn()));
    const before = railIds();
    const dividerId = before.find((id) => id.startsWith("divider:")) ?? "";

    fireEvent.click(
      screen.getAllByRole("button", { name: "Remove divider" })[0],
    );

    expect(railIds()).not.toContain(dividerId);
    expect(railIds()).toHaveLength(before.length - 1);
    expect(historyDepth()).toBe(1);
  });

  it("draws a rule on a divider row, which is the whole of what it is", () => {
    seedRailDivider();
    render(section("railAgents", vi.fn()));
    const dividerId = railIds().find((id) => id.startsWith("divider:")) ?? "";
    const dividerRow = row(dividerId, document);

    // A hairline spanning the row, and no state to speak of: the thing that
    // represents a boundary used to be the emptiest item in the list (LV2-12).
    expect(dividerRow.querySelector("[data-divider-rule]")).not.toBeNull();
    expect(dividerRow.querySelectorAll(STATE_CONTROL)).toHaveLength(0);
    // Its one verb sits in the row's own control column.
    expect(
      within(dividerRow).getByRole("button", { name: "Remove divider" }),
    ).toBeDefined();
  });

  it("gives every row kind the same two 14px slots before its label (grip/spacer + icon/spacer)", () => {
    seedRailDivider();
    render(section("railAgents", vi.fn()));
    const dividerId = railIds().find((id) => id.startsWith("divider:")) ?? "";
    const stackId = railIds().find((id) => id.startsWith("stack:")) ?? "";

    // A movable panel, a divider and the unmovable stack link: three
    // different builders, the same two leading slots on every one of them.
    for (const id of ["railAgents", dividerId, stackId]) {
      const [grip, icon] = [...grabOf(row(id, document)).children];
      expect(grip.getAttribute("class")).toContain("size-3.5");
      expect(icon.getAttribute("class")).toContain("size-3.5");
    }
  });

  it("moves a divider like any other item", () => {
    seedRailDivider();
    render(section("railAgents", vi.fn()));
    const before = railIds();
    const dividerId = before.find((id) => id.startsWith("divider:")) ?? "";
    const grabbed = row(dividerId, document);

    fireEvent.keyDown(grabbed, { key: " " });
    fireEvent.keyDown(grabbed, { key: "ArrowUp" });
    fireEvent.keyDown(grabbed, { key: " " });

    const after = railIds();
    expect(after.indexOf(dividerId)).toBe(before.indexOf(dividerId) - 1);
    expect(historyDepth()).toBe(1);
  });
});

/**
 * A hand-built row, bypassing every row builder: what is under test here is
 * the LIST's own keyboard step, not any of the rows the app decorates (those
 * are the rail's real Position list, covered by the last test below).
 */
function testItem(id: string, movable: boolean): SortableListItem<string> {
  return {
    id,
    label: id,
    icon: null,
    glyph: null,
    divider: false,
    movable,
    dimmed: false,
    hint: null,
    control: null,
    revert: null,
    detail: null,
    open: false,
    onToggleOpen: null,
    onRemove: null,
    removeLabel: null,
    onStack: null,
    stackMembers: null,
  };
}

function bareList(
  items: ReadonlyArray<SortableListItem<string>>,
  onMove: (id: string, toIndex: number) => void,
): ReactNode {
  return (
    <SortableList
      label="Test list"
      selectedId={null}
      items={items}
      onMove={onMove}
    />
  );
}

describe("a keyboard step goes past a row that cannot move (G6)", () => {
  const WITH_LINK: ReadonlyArray<SortableListItem<string>> = [
    testItem("A", true),
    testItem("L", false),
    testItem("B", true),
    testItem("C", true),
  ];

  it("nudges past the link on Alt+ArrowDown, landing on the next movable row", () => {
    const onMove = vi.fn();
    render(bareList(WITH_LINK, onMove));

    fireEvent.keyDown(row("A", document), { key: "ArrowDown", altKey: true });

    expect(onMove.mock.calls).toEqual([["A", 2]]);
    expect(announcement()).toBe("Moved A, position 3 of 4.");
  });

  it("nudges past the link the other way on Alt+ArrowUp", () => {
    const onMove = vi.fn();
    render(bareList(WITH_LINK, onMove));

    fireEvent.keyDown(row("B", document), { key: "ArrowUp", altKey: true });

    expect(onMove.mock.calls).toEqual([["B", 0]]);
    expect(announcement()).toBe("Moved B, position 1 of 4.");
  });

  it("skips the link in grab mode too, dropping where the nudge would land", () => {
    const onMove = vi.fn();
    render(bareList(WITH_LINK, onMove));
    const grabbed = row("A", document);

    fireEvent.keyDown(grabbed, { key: " " });
    fireEvent.keyDown(grabbed, { key: "ArrowDown" });

    expect(onMove).not.toHaveBeenCalled();
    expect(announcement()).toBe("Moved A, position 3 of 4.");

    fireEvent.keyDown(grabbed, { key: " " });

    expect(onMove.mock.calls).toEqual([["A", 2]]);
  });

  it("moves nothing and announces nothing when no slot exists past the link", () => {
    const onMove = vi.fn();
    render(bareList([testItem("A", true), testItem("L", false)], onMove));

    fireEvent.keyDown(row("A", document), { key: "ArrowDown", altKey: true });

    expect(onMove).not.toHaveBeenCalled();
    expect(announcement()).toBe("");
  });

  it("swaps Agents and Artifacts through the real rail list, keeping the group", () => {
    render(section("railAgents", vi.fn()));

    fireEvent.keyDown(row("railAgents", document), {
      key: "ArrowDown",
      altKey: true,
    });

    expect(
      useLayoutStore.getState().arrangement.rail.map((entry) => entry.id),
    ).toEqual([
      "railArtifacts",
      "stack:railArtifacts+railAgents",
      "railAgents",
      "railTerminals",
      "railBrowsers",
      "railGitDiff",
      "railPullRequests",
      "railFileTree",
      "railSharing",
      "railComments",
    ]);
    expect(historyDepth()).toBe(1);
  });
});

/**
 * The pointer path's own guard (G6): `handlePointerDown` refused every press
 * inside the grab because the old selector, `closest("button")`, matched the
 * grab itself - the row's own `<button data-row-grab>` wraps the grip, the
 * name and, on a divider, its label and rule. A divider row could never be
 * dragged. `ROW_CONTROL_SELECTOR` excludes the grab button by name instead, so
 * only a REAL control - a Remove or a Stack button, drawn as the grab's
 * sibling - refuses the press.
 */
describe("a pointer press inside the grab arms the drag (G6)", () => {
  const armSpy = vi.mocked(armLayoutDrag);

  beforeEach(() => {
    armSpy.mockClear();
  });

  function pointerItem(options: {
    readonly id: string;
    readonly label: string;
    readonly movable: boolean;
    readonly divider: boolean;
    readonly onRemove: (() => void) | null;
    readonly onStack: (() => void) | null;
  }): SortableListItem<string> {
    return {
      id: options.id,
      label: options.label,
      icon: null,
      glyph: null,
      divider: options.divider,
      movable: options.movable,
      dimmed: false,
      hint: null,
      control: null,
      revert: null,
      detail: null,
      open: false,
      onToggleOpen: null,
      onRemove: options.onRemove,
      removeLabel: null,
      onStack: options.onStack,
      stackMembers: null,
    };
  }

  function unorderedList(
    items: ReadonlyArray<SortableListItem<string>>,
  ): ReactNode {
    return (
      <SortableList
        label="Test list"
        selectedId={null}
        items={items}
        onMove={null}
      />
    );
  }

  function press(target: Element): void {
    fireEvent.pointerDown(target, { button: 0, pointerId: 1 });
  }

  /** The `onDrop` the most recent `armLayoutDrag` call was given. */
  function dropLastArm(toIndex: number): void {
    const input = armSpy.mock.calls.at(-1)?.[0];
    if (input === undefined) throw new Error("armLayoutDrag was not called");
    input.onDrop(0, toIndex);
  }

  it("arms a divider row's drag from its grip, its label and its rule", () => {
    const onMove = vi.fn();
    const items = [
      pointerItem({
        id: "divider",
        label: "Divider",
        movable: true,
        divider: true,
        onRemove: null,
        onStack: null,
      }),
      pointerItem({
        id: "A",
        label: "A",
        movable: true,
        divider: false,
        onRemove: null,
        onStack: null,
      }),
      pointerItem({
        id: "B",
        label: "B",
        movable: true,
        divider: false,
        onRemove: null,
        onStack: null,
      }),
    ];
    render(bareList(items, onMove));
    const dividerRow = row("divider", document);
    const grip = dividerRow.querySelector("[data-row-grip]");
    if (grip === null) throw new Error("divider row has no grip");
    const rule = dividerRow.querySelector("[data-divider-rule]");
    if (rule === null) throw new Error("divider row has no rule");

    press(grip);
    expect(armSpy).toHaveBeenCalledTimes(1);
    dropLastArm(2);
    expect(onMove).toHaveBeenNthCalledWith(1, "divider", 2);

    press(within(dividerRow).getByText("Divider"));
    expect(armSpy).toHaveBeenCalledTimes(2);
    dropLastArm(1);
    expect(onMove).toHaveBeenNthCalledWith(2, "divider", 1);

    press(rule);
    expect(armSpy).toHaveBeenCalledTimes(3);
    dropLastArm(0);
    expect(onMove).toHaveBeenNthCalledWith(3, "divider", 0);
  });

  it("arms a regular row's drag from its name", () => {
    const onMove = vi.fn();
    const items = [
      pointerItem({
        id: "A",
        label: "A",
        movable: true,
        divider: false,
        onRemove: null,
        onStack: null,
      }),
      pointerItem({
        id: "B",
        label: "B",
        movable: true,
        divider: false,
        onRemove: null,
        onStack: null,
      }),
    ];
    render(bareList(items, onMove));

    press(within(row("A", document)).getByText("A"));

    expect(armSpy).toHaveBeenCalledTimes(1);
    dropLastArm(1);
    expect(onMove).toHaveBeenCalledWith("A", 1);
  });

  it("does not arm a press on the row's own control button", () => {
    const onMove = vi.fn();
    const items = [
      pointerItem({
        id: "divider",
        label: "Divider",
        movable: true,
        divider: true,
        onRemove: vi.fn(),
        onStack: null,
      }),
      pointerItem({
        id: "A",
        label: "A",
        movable: true,
        divider: false,
        onRemove: null,
        onStack: vi.fn(),
      }),
    ];
    render(bareList(items, onMove));

    press(
      within(row("divider", document)).getByRole("button", {
        name: /^Remove /i,
      }),
    );
    press(within(row("A", document)).getByRole("button", { name: /^Stack /i }));

    expect(armSpy).not.toHaveBeenCalled();
  });

  it("does not arm an unmovable row, nor any row in an unordered list", () => {
    const onMove = vi.fn();
    const withLink = [
      pointerItem({
        id: "A",
        label: "A",
        movable: true,
        divider: false,
        onRemove: null,
        onStack: null,
      }),
      pointerItem({
        id: "L",
        label: "L",
        movable: false,
        divider: false,
        onRemove: null,
        onStack: null,
      }),
    ];
    render(bareList(withLink, onMove));

    press(grabOf(row("L", document)));
    expect(armSpy).not.toHaveBeenCalled();

    cleanup();
    render(unorderedList(withLink));

    press(grabOf(row("A", document)));
    expect(armSpy).not.toHaveBeenCalled();
  });
});
