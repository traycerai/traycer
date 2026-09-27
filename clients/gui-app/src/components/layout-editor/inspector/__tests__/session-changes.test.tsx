import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SessionChangesRow,
  SessionReviewLevel,
} from "@/components/layout-editor/inspector/session-changes";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * `SessionChangesRow` and `SessionReviewLevel`, against the real stores
 * (`layout-store.ts` and `layout-editor-store.ts`), the way the inspector
 * actually drives them: `beginSession` snapshots the entry, a gesture is a
 * `recordGesture`-wrapped write (the same path every real control uses), and
 * Review opens the session's change list as a LEVEL - `reviewingSession` -
 * rather than expanding inline, so the row's own Review button hides while it
 * is open and the level's own back row is the way out. Each line also has its
 * own revert, and the level heads a "Revert all"; every revert is one more
 * `recordGesture`, so `undo()` takes it back like any other edit.
 */

/**
 * The header row plus the level it can open, exactly as `InspectorBody` /
 * `InspectorLevel` in `layout-editor.tsx` compose them - the row is always
 * mounted, and the review level is a sibling that appears only while
 * `reviewingSession` is true.
 */
function Harness(): ReactNode {
  const reviewing = useLayoutEditorStore((state) => state.reviewingSession);
  return (
    <>
      <SessionChangesRow />
      {reviewing ? <SessionReviewLevel /> : null}
    </>
  );
}

function beginSession(): void {
  act(() => {
    useLayoutEditorStore.getState().beginSession({
      entry: "pointer",
      source: "direct_ui",
      startedAt: 0,
      origin: { kind: "tab" },
    });
  });
}

/** One gesture, on the editor's own undo stack - not a bare store write. */
function changeMinimapToHidden(): void {
  act(() => {
    useLayoutEditorStore.getState().recordGesture(() => {
      useLayoutStore.getState().setRegionValues("minimap", { shown: "hidden" });
    });
  });
}

/** Two independent lines in one gesture, for the "revert only one" tests. */
function changeMinimapAndMicToHidden(): void {
  act(() => {
    useLayoutEditorStore.getState().recordGesture(() => {
      useLayoutStore.getState().setRegionValues("minimap", { shown: "hidden" });
      useLayoutStore.getState().setRegionValues("mic", { shown: "hidden" });
    });
  });
}

function openReview(): void {
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
}

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
    layoutCarryDone: true,
  });
  useLayoutEditorStore.getState().endSession();
});

afterEach(() => {
  cleanup();
  useLayoutEditorStore.getState().endSession();
});

describe("no session open", () => {
  it("renders nothing when entrySnapshot is null", () => {
    render(<SessionChangesRow />);

    expect(screen.queryByTestId("layout-session-changes")).toBeNull();
  });
});

describe("a clean session", () => {
  it("reads 'No changes this session' with no Review button", () => {
    beginSession();
    render(<Harness />);

    expect(screen.getByTestId("layout-session-summary").textContent).toBe(
      "No changes this session",
    );
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
  });
});

describe("after a layout change", () => {
  it("reads '1 change this session', with a Review button and no level open yet", () => {
    beginSession();
    render(<Harness />);

    changeMinimapToHidden();

    expect(screen.getByTestId("layout-session-summary").textContent).toBe(
      "1 change this session",
    );
    expect(screen.getByRole("button", { name: "Review" })).not.toBeNull();
    expect(screen.queryByTestId("layout-session-review")).toBeNull();
  });

  it("pluralizes for more than one change", () => {
    beginSession();
    render(<Harness />);

    changeMinimapAndMicToHidden();

    expect(screen.getByTestId("layout-session-summary").textContent).toBe(
      "2 changes this session",
    );
  });
});

describe("Review opens the change list as a level, not inline", () => {
  it("sets reviewingSession, hides the row's Review button, and renders the level's line", () => {
    beginSession();
    render(<Harness />);
    changeMinimapToHidden();

    openReview();

    expect(useLayoutEditorStore.getState().reviewingSession).toBe(true);
    // The row's own trigger is gone while the level it opens is on screen.
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();

    const list = screen.getByTestId("layout-session-change-list");
    expect(list.textContent).toContain("Minimap");
    expect(list.textContent).toContain("Shown");
    expect(list.textContent).toContain("Hidden");
  });

  it("the back row reads 'All settings' with no area open", () => {
    beginSession();
    render(<Harness />);
    changeMinimapToHidden();

    openReview();

    expect(screen.getByRole("button", { name: "All settings" })).not.toBeNull();
  });
});

describe("the back row", () => {
  it("clears reviewingSession and unmounts the level, restoring the row's Review button", () => {
    beginSession();
    render(<Harness />);
    changeMinimapToHidden();
    openReview();
    expect(screen.getByTestId("layout-session-review")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All settings" }));

    expect(useLayoutEditorStore.getState().reviewingSession).toBe(false);
    expect(screen.queryByTestId("layout-session-review")).toBeNull();
    expect(screen.getByRole("button", { name: "Review" })).not.toBeNull();
  });

  it("reads the open area's label instead of 'All settings'", () => {
    beginSession();
    act(() => {
      useLayoutEditorStore.getState().openArea("statusBar", null);
      useLayoutEditorStore.getState().setReviewingSession(true);
    });

    render(<SessionReviewLevel />);

    expect(
      screen.getByRole("button", { name: "Usage and resources" }),
    ).not.toBeNull();
  });
});

describe("reverting a line", () => {
  it("removes only that line, leaving the other one in place, and stays open", () => {
    beginSession();
    render(<Harness />);
    changeMinimapAndMicToHidden();
    openReview();
    expect(screen.getByTestId("layout-session-summary").textContent).toBe(
      "2 changes this session",
    );

    fireEvent.click(screen.getByRole("button", { name: "Revert Minimap" }));

    expect(useLayoutStore.getState().overrides.minimap).toBeUndefined();
    expect(useLayoutStore.getState().overrides.mic).toEqual({
      shown: "hidden",
    });
    expect(screen.getByTestId("layout-session-summary").textContent).toBe(
      "1 change this session",
    );
    const list = screen.getByTestId("layout-session-change-list");
    expect(list.textContent).not.toContain("Minimap");
    expect(list.textContent).toContain("Microphone");
    // The level stays open - a line's own revert is not the way out of it.
    expect(screen.getByTestId("layout-session-review")).not.toBeNull();
  });
});

describe("Revert all", () => {
  it("empties the level to 'No changes this session.' while it stays open", () => {
    beginSession();
    render(<Harness />);
    changeMinimapAndMicToHidden();
    openReview();

    fireEvent.click(screen.getByRole("button", { name: "Revert all" }));

    expect(screen.getByTestId("layout-session-review")).not.toBeNull();
    expect(screen.queryByTestId("layout-session-change-list")).toBeNull();
    expect(screen.getByText("No changes this session.")).not.toBeNull();
    expect(useLayoutStore.getState().overrides.minimap).toBeUndefined();
    expect(useLayoutStore.getState().overrides.mic).toBeUndefined();
  });

  it("undo brings both lines back", () => {
    beginSession();
    render(<Harness />);
    changeMinimapAndMicToHidden();
    openReview();
    fireEvent.click(screen.getByRole("button", { name: "Revert all" }));
    expect(screen.getByText("No changes this session.")).not.toBeNull();

    act(() => {
      useLayoutEditorStore.getState().undo();
    });

    expect(screen.getByTestId("layout-session-summary").textContent).toBe(
      "2 changes this session",
    );
    const list = screen.getByTestId("layout-session-change-list");
    expect(list.textContent).toContain("Minimap");
    expect(list.textContent).toContain("Microphone");
  });
});

describe("undoing back to the entry snapshot while the level is open", () => {
  it("reads 'No changes this session.' and stays mounted", () => {
    beginSession();
    render(<Harness />);
    changeMinimapToHidden();
    openReview();
    expect(screen.getByTestId("layout-session-change-list")).not.toBeNull();

    act(() => {
      useLayoutEditorStore.getState().undo();
    });

    // The level stays open - the back row is still the way out - and its
    // list is replaced by the empty message rather than the level closing.
    expect(screen.getByTestId("layout-session-review")).not.toBeNull();
    expect(screen.queryByTestId("layout-session-change-list")).toBeNull();
    expect(screen.getByText("No changes this session.")).not.toBeNull();
  });
});
