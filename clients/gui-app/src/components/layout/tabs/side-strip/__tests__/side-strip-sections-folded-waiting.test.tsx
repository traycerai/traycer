/**
 * A folded Activity-view section draws the current task's row and a row that
 * is waiting in it for the pointer to leave the list, and nothing else. The
 * real `SideStripSections` draws the sections; only the row leaf is replaced
 * by a frame carrying the attributes the holds read, since a real row needs
 * the router, the drag provider and the tab stores.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TabStripController } from "@/components/layout/tabs/tab-strip-controller";
import { SideStripSections } from "../side-strip-sections";
import type { SideStripHandlers } from "../side-strip-item-input";
import {
  groupEntriesBySection,
  type StripSection,
  type StripSectionGroup,
} from "../strip-sections";
import { StripSectionsContext } from "../strip-sections-context";

// The row itself is a marker: it needs the router, the drag provider and the
// tab stores, and which rows a section draws, and in which lane, is decided
// above it, by the real sections, their fold and the hold hooks.
vi.mock("../side-strip-item", () => ({
  SideStripItem: (props: {
    readonly itemId: string;
    readonly lane: StripSection | null;
  }) => (
    <div
      data-testid={`row-${props.itemId}`}
      data-strip-item-id={props.itemId}
      data-strip-lane={props.lane ?? undefined}
    />
  ),
}));

const HANDLERS: SideStripHandlers = {
  onClose: vi.fn(),
  onCloseOtherTabs: vi.fn(),
  canCloseOtherTabs: false,
  onDuplicateTab: vi.fn(),
  onOpenInNewWindow: vi.fn(),
  canOpenInNewWindow: false,
  onSplitCommand: vi.fn(),
  taskPinnedStates: new Map(),
  pendingSetPinnedEpicIds: new Set(),
  onTaskPinMenuOpen: vi.fn(),
  onSetTaskPinned: vi.fn(),
};

function controllerOf(activeItemId: string): TabStripController {
  return {
    ...HANDLERS,
    headerItemIds: [],
    layoutItems: [],
    groups: undefined,
    customizations: undefined,
    tabs: [],
    activeItemId,
    homeTabDrawn: false,
    homeIsActive: false,
    tracy: null,
    isEmptyLanding: false,
    dropIndicatorIndex: null,
    dropGroupId: null,
    dragSourceItemId: null,
    offsets: new Map(),
    indicators: {
      epicIds: [],
      indicators: { epics: {}, chats: {} },
      chatEpicIds: {},
      chatScopes: [],
    },
    onNewTab: vi.fn(),
    onHomeTab: vi.fn(),
    onCloseGroup: vi.fn(),
    dialogs: null,
  };
}

function sectionsOf(
  rows: ReadonlyArray<readonly [string, StripSection]>,
): ReadonlyArray<StripSectionGroup> {
  return groupEntriesBySection(
    rows.map(([itemId, section], stripIndex) => ({
      kind: "tabs",
      itemId,
      stripIndex,
      section,
      group: null,
      members: [],
    })),
  );
}

function Strip(props: {
  readonly sections: ReadonlyArray<StripSectionGroup>;
  readonly activeItemId: string;
  readonly scroller: HTMLElement;
}) {
  return (
    <StripSectionsContext value={props.sections}>
      <SideStripSections
        controller={controllerOf(props.activeItemId)}
        handlers={HANDLERS}
        variant="expanded"
        scroller={props.scroller}
        needsYouAbove={false}
        stuck={null}
      />
    </StripSectionsContext>
  );
}

afterEach(cleanup);

describe("a folded section when another task is opened with the pointer in the list", () => {
  it("draws the row waiting in it until the pointer leaves, and no other row of it", () => {
    const scroller = document.body.appendChild(document.createElement("div"));
    const view = render(
      <Strip
        scroller={scroller}
        activeItemId="old"
        sections={sectionsOf([
          ["old", "to-review"],
          ["other-review", "to-review"],
          ["next", "working"],
        ])}
      />,
    );
    act(() => {
      screen.getByTestId("side-strip-section-to-review").click();
    });
    // The current task's state settles: its own section is now Idle, but it
    // stays in To review while it is the current one.
    view.rerender(
      <Strip
        scroller={scroller}
        activeItemId="old"
        sections={sectionsOf([
          ["old", "idle"],
          ["other-review", "to-review"],
          ["next", "working"],
        ])}
      />,
    );
    act(() => {
      scroller.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    view.rerender(
      <Strip
        scroller={scroller}
        activeItemId="next"
        sections={sectionsOf([
          ["old", "idle"],
          ["other-review", "to-review"],
          ["next", "working"],
        ])}
      />,
    );

    expect(screen.getByTestId("row-old").dataset.stripLane).toBe("to-review");
    expect(screen.queryByTestId("row-other-review")).toBeNull();

    act(() => {
      scroller.dispatchEvent(new Event("pointerleave"));
    });

    expect(screen.getByTestId("row-old").dataset.stripLane).toBe("idle");
    expect(screen.queryByTestId("row-other-review")).toBeNull();
  });
});
