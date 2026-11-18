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
import type { HeaderTab } from "@/stores/tabs/types";
import {
  groupEntriesBySection,
  needsYouRowOf,
  needsYouTaskCountOf,
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

const MEMBER_TAB: Extract<HeaderTab, { kind: "settings" }> = {
  kind: "settings",
  id: "settings",
  route: "/settings/general",
  name: "Settings",
  icon: null,
  canDuplicate: false,
  canOpenInNewWindow: false,
  lastPath: null,
};

/** `needsYouItemId` is held in its section by a member that really needs the person. */
function sectionsWithNeedsYouMember(
  rows: ReadonlyArray<readonly [string, StripSection]>,
  needsYouItemId: string,
): ReadonlyArray<StripSectionGroup> {
  return groupEntriesBySection(
    rows.map(([itemId, section], stripIndex) => ({
      kind: "tabs",
      itemId,
      stripIndex,
      section,
      group: null,
      members:
        itemId === needsYouItemId
          ? [{ tab: MEMBER_TAB, row: needsYouRowOf([], "reply") }]
          : [],
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

// The fold lives in a session store with no reset, so a test that left To
// review folded unfolds it through the real header before unmounting.
afterEach(() => {
  const header = screen.queryByTestId("side-strip-section-to-review");
  if (header?.getAttribute("aria-expanded") === "false") {
    act(() => {
      header.click();
    });
  }
  cleanup();
});

const ROWS: ReadonlyArray<readonly [string, StripSection]> = [
  ["old", "idle"],
  ["other-review", "to-review"],
  ["next", "working"],
];

/** `old` is current and settled to Idle while held in the folded To review. */
function renderOldHeldInFoldedToReview() {
  const scroller = document.body.appendChild(document.createElement("div"));
  const view = render(
    <Strip
      scroller={scroller}
      activeItemId="old"
      sections={sectionsOf([["old", "to-review"], ...ROWS.slice(1)])}
    />,
    { container: scroller },
  );
  act(() => {
    screen.getByTestId("side-strip-section-to-review").click();
  });
  view.rerender(
    <Strip
      scroller={scroller}
      activeItemId="old"
      sections={sectionsOf(ROWS)}
    />,
  );
  const openNext = (): void => {
    view.rerender(
      <Strip
        scroller={scroller}
        activeItemId="next"
        sections={sectionsOf(ROWS)}
      />,
    );
  };
  return { scroller, view, openNext };
}

/** `old` is current and really in the folded To review, as is another row. */
function renderOldReallyInFoldedToReview() {
  const scroller = document.body.appendChild(document.createElement("div"));
  const sections = sectionsOf([["old", "to-review"], ...ROWS.slice(1)]);
  const view = render(
    <Strip scroller={scroller} activeItemId="old" sections={sections} />,
    { container: scroller },
  );
  act(() => {
    screen.getByTestId("side-strip-section-to-review").click();
  });
  const openNext = (): void => {
    view.rerender(
      <Strip scroller={scroller} activeItemId="next" sections={sections} />,
    );
  };
  return { scroller, openNext };
}

describe("a folded section when another task is opened with the pointer in the list", () => {
  it("draws the row waiting in it until the pointer leaves, and no other row of it", () => {
    const { scroller, openNext } = renderOldHeldInFoldedToReview();
    act(() => {
      scroller.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    openNext();

    expect(screen.getByTestId("row-old").dataset.stripLane).toBe("to-review");
    expect(screen.queryByTestId("row-other-review")).toBeNull();

    act(() => {
      scroller.dispatchEvent(new Event("pointerleave"));
    });

    expect(screen.getByTestId("row-old").dataset.stripLane).toBe("idle");
    expect(screen.queryByTestId("row-other-review")).toBeNull();
  });

  it("keeps a waiting row under the pointer drawn when the window loses focus", () => {
    const { scroller, openNext } = renderOldHeldInFoldedToReview();
    act(() => {
      screen
        .getByTestId("row-old")
        .dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    openNext();

    expect(screen.getByTestId("row-old").dataset.stripLane).toBe("to-review");

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(screen.getByTestId("row-old").dataset.stripLane).toBe("to-review");
    expect(screen.queryByTestId("row-other-review")).toBeNull();

    act(() => {
      scroller.dispatchEvent(new Event("pointerleave"));
    });

    expect(screen.getByTestId("row-old").dataset.stripLane).toBe("idle");
  });

  it("keeps a waiting row drawn when its own section becomes the folded one it waits in", () => {
    const { scroller, view, openNext } = renderOldHeldInFoldedToReview();
    act(() => {
      scroller.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    openNext();

    expect(screen.getByTestId("row-old").dataset.stripLane).toBe("to-review");

    act(() => {
      view.rerender(
        <Strip
          scroller={scroller}
          activeItemId="next"
          sections={sectionsOf([["old", "to-review"], ...ROWS.slice(1)])}
        />,
      );
    });

    expect(screen.getByTestId("row-old").dataset.stripLane).toBe("to-review");
    expect(screen.queryByTestId("row-other-review")).toBeNull();

    act(() => {
      scroller.dispatchEvent(new Event("pointerleave"));
    });

    expect(screen.queryByTestId("row-old")).toBeNull();
    expect(screen.queryByTestId("row-other-review")).toBeNull();
  });

  it("keeps the previous row drawn when it was really in the folded section", () => {
    const { scroller, openNext } = renderOldReallyInFoldedToReview();
    act(() => {
      scroller.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    openNext();

    expect(screen.getByTestId("row-old").dataset.stripLane).toBe("to-review");
    expect(screen.queryByTestId("row-other-review")).toBeNull();

    act(() => {
      scroller.dispatchEvent(new Event("pointerleave"));
    });

    expect(screen.queryByTestId("row-old")).toBeNull();
  });
});

describe("an unfolded section when another task is opened with the pointer in the list", () => {
  it("keeps a waiting row in its section through a change of its own, until the pointer leaves", () => {
    const { scroller, view, openNext } = renderOldHeldInFoldedToReview();
    act(() => {
      screen.getByTestId("side-strip-section-to-review").click();
    });
    act(() => {
      scroller.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    openNext();
    expect(screen.getByTestId("row-old").dataset.stripLane).toBe("to-review");

    const settle = (section: StripSection): void => {
      act(() => {
        view.rerender(
          <Strip
            scroller={scroller}
            activeItemId="next"
            sections={sectionsOf([["old", section], ...ROWS.slice(1)])}
          />,
        );
      });
    };
    settle("to-review");
    expect(screen.getByTestId("row-old").dataset.stripLane).toBe("to-review");

    settle("needs-you");
    expect(screen.getByTestId("row-old").dataset.stripLane).toBe("to-review");

    act(() => {
      scroller.dispatchEvent(new Event("pointerleave"));
    });

    expect(screen.getByTestId("row-old").dataset.stripLane).toBe("needs-you");
  });
});

describe("a row that needs the person while it waits in another section", () => {
  it("counts it in the notification count and not in a Needs you header", () => {
    const { scroller, view, openNext } = renderOldHeldInFoldedToReview();
    act(() => {
      screen.getByTestId("side-strip-section-to-review").click();
    });
    act(() => {
      scroller.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    openNext();

    const sections = sectionsWithNeedsYouMember(
      [["old", "needs-you"], ...ROWS.slice(1)],
      "old",
    );
    act(() => {
      view.rerender(
        <Strip scroller={scroller} activeItemId="next" sections={sections} />,
      );
    });

    expect(screen.getByTestId("row-old").dataset.stripLane).toBe("to-review");
    expect(screen.queryByTestId("side-strip-section-needs-you")).toBeNull();
    // The count the Notifications pill and the bell show.
    expect(needsYouTaskCountOf(sections)).toBe(1);

    act(() => {
      scroller.dispatchEvent(new Event("pointerleave"));
    });

    expect(screen.getByTestId("row-old").dataset.stripLane).toBe("needs-you");
    expect(
      screen.getByTestId("side-strip-section-needs-you").textContent,
    ).toContain("1");
  });
});
