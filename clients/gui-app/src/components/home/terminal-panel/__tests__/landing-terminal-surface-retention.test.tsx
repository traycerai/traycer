import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  LandingTerminalHost,
  LandingTerminalPaneAnchor,
} from "../landing-terminal-host";
import {
  resolveHostedLandingDraftId,
  selectLandingTerminalSurfaceActive,
} from "../landing-terminal-surface-binding";
import { useTabsStore } from "@/stores/tabs/store";
import type {
  SplitSideName,
  SplitStripItem,
  StripItem,
  TabStripItem,
} from "@/stores/tabs/layout";

// The host's own mount lifetime is what is under test; the provider and panel
// are stubbed so a remount shows up as a fresh DOM node rather than as a
// terminal bootstrap.
vi.mock(
  "@/components/home/terminal-panel/landing-terminal-gesture-provider",
  () => ({
    LandingTerminalGestureProvider: (props: {
      readonly draftId: string | null;
      readonly children: ReactNode;
    }) => (
      <div data-draft-id={props.draftId ?? ""} data-testid="landing-terminal">
        {props.children}
      </div>
    ),
  }),
);
vi.mock("@/components/home/terminal-panel/landing-terminal-panel", () => ({
  LandingTerminalPanel: () => <div data-testid="landing-terminal-panel-body" />,
}));

function anchorsFor(
  ...draftIds: ReadonlyArray<string>
): ReadonlyMap<string, HTMLElement> {
  return new Map(
    draftIds.map((draftId) => [draftId, document.createElement("div")]),
  );
}

const DRAFT_TAB: TabStripItem = {
  kind: "tab",
  id: "item-draft-a",
  ref: { kind: "draft", id: "draft-a" },
};
const EPIC_TAB: TabStripItem = {
  kind: "tab",
  id: "item-epic-a",
  ref: { kind: "epic", id: "epic-a" },
};

function splitOf(focusedSide: SplitSideName): SplitStripItem {
  return {
    kind: "split",
    id: "item-split",
    left: { kind: "tab", ref: DRAFT_TAB.ref },
    right: { kind: "tab", ref: EPIC_TAB.ref },
    focusedSide,
    routeBackingSide: focusedSide,
    leftRatio: 0.5,
  };
}

const INITIAL_LAYOUT = {
  items: useTabsStore.getState().items,
  activeItemId: useTabsStore.getState().activeItemId,
};

function seedLayout(
  items: ReadonlyArray<StripItem>,
  activeItemId: string,
): void {
  useTabsStore.setState({ items, activeItemId });
}

afterEach(() => {
  cleanup();
  useTabsStore.setState(INITIAL_LAYOUT);
});

describe("resolveHostedLandingDraftId", () => {
  it("hosts the focused start page", () => {
    expect(
      resolveHostedLandingDraftId({
        focusedDraftId: "draft-a",
        hostedDraftId: null,
        anchors: anchorsFor("draft-a"),
      }),
    ).toBe("draft-a");
  });

  it("keeps hosting a retained page once focus leaves the drafts entirely", () => {
    expect(
      resolveHostedLandingDraftId({
        focusedDraftId: null,
        hostedDraftId: "draft-a",
        anchors: anchorsFor("draft-a"),
      }),
    ).toBe("draft-a");
  });

  it("does not follow focus to a start page that has no anchor yet", () => {
    // Moving the panel is a portal retarget, which remounts the subtree; an
    // unanchored target would tear the terminals down for nothing.
    expect(
      resolveHostedLandingDraftId({
        focusedDraftId: "draft-b",
        hostedDraftId: "draft-a",
        anchors: anchorsFor("draft-a"),
      }),
    ).toBe("draft-a");
  });

  it("moves to the focused page once both are anchored (split focus)", () => {
    expect(
      resolveHostedLandingDraftId({
        focusedDraftId: "draft-b",
        hostedDraftId: "draft-a",
        anchors: anchorsFor("draft-a", "draft-b"),
      }),
    ).toBe("draft-b");
  });

  it("adopts a remaining retained page when the hosting one unmounts", () => {
    expect(
      resolveHostedLandingDraftId({
        focusedDraftId: null,
        hostedDraftId: "draft-a",
        anchors: anchorsFor("draft-b"),
      }),
    ).toBe("draft-b");
  });

  it("reports no host when no start page is mounted", () => {
    expect(
      resolveHostedLandingDraftId({
        focusedDraftId: null,
        hostedDraftId: "draft-a",
        anchors: anchorsFor(),
      }),
    ).toBeNull();
  });
});

describe("<LandingTerminalHost /> retention", () => {
  it("keeps the panel mounted when an epic tab is activated", () => {
    seedLayout([DRAFT_TAB, EPIC_TAB], DRAFT_TAB.id);
    render(
      <>
        <LandingTerminalPaneAnchor draftId="draft-a" />
        <LandingTerminalHost />
      </>,
    );
    const body = screen.getByTestId("landing-terminal-panel-body");

    // The start page stays mounted behind the epic tab (its anchor is still
    // registered), so the panel must not be torn down and rebuilt - that
    // teardown is what made every returning terminal re-attach from scratch.
    act(() => seedLayout([DRAFT_TAB, EPIC_TAB], EPIC_TAB.id));

    expect(screen.getByTestId("landing-terminal-panel-body")).toBe(body);
    expect(screen.getByTestId("landing-terminal").dataset.draftId).toBe(
      "draft-a",
    );
  });

  it("drops the panel once the start page's pane unmounts", () => {
    seedLayout([DRAFT_TAB, EPIC_TAB], DRAFT_TAB.id);
    const view = render(
      <>
        <LandingTerminalPaneAnchor draftId="draft-a" />
        <LandingTerminalHost />
      </>,
    );
    expect(screen.queryByTestId("landing-terminal-panel-body")).not.toBeNull();

    // Closing the start page removes its anchor; nothing is left to portal
    // into, so the terminals are released rather than parked.
    act(() => {
      view.rerender(<LandingTerminalHost />);
      seedLayout([EPIC_TAB], EPIC_TAB.id);
    });

    expect(screen.queryByTestId("landing-terminal-panel-body")).toBeNull();
  });
});

describe("selectLandingTerminalSurfaceActive", () => {
  function activeFor(
    items: ReadonlyArray<StripItem>,
    activeItemId: string,
  ): boolean {
    seedLayout(items, activeItemId);
    return selectLandingTerminalSurfaceActive(useTabsStore.getState());
  }

  it("is active while a start page is the active tab", () => {
    expect(activeFor([DRAFT_TAB], DRAFT_TAB.id)).toBe(true);
  });

  it("is inactive while an epic tab is active, though the panel stays mounted", () => {
    // The panel outliving activation is exactly why its chord registrations
    // have to gate on this: a registered dynamic handler would swallow the
    // epic canvas's `tab.*` chords instead of letting the static one run.
    expect(activeFor([DRAFT_TAB, EPIC_TAB], EPIC_TAB.id)).toBe(false);
  });

  it("follows the focused side of a split, not mere membership", () => {
    const epicFocused = splitOf("right");
    expect(activeFor([epicFocused], epicFocused.id)).toBe(false);
    const draftFocused = splitOf("left");
    expect(activeFor([draftFocused], draftFocused.id)).toBe(true);
  });

  it("stays active when no top-level surface holds focus", () => {
    // Nothing to shadow: an empty split slot's chooser, or a window with no
    // tabs yet. The panel behaved this way before it outlived activation.
    expect(activeFor([], "")).toBe(true);
  });
});
