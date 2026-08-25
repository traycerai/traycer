import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useActivateCommentThread } from "@/hooks/comments/use-activate-comment-thread";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import { useMobileSwitcherStore } from "@/stores/epics/mobile-switcher-store";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";
const ARTIFACT_ID = "spec-1";
const THREAD_ID = "thread-1";

const viewport = { isMobile: true };
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => viewport.isMobile,
  isMobileViewport: () => viewport.isMobile,
}));

function activate(): void {
  const { result } = renderHook(() =>
    useActivateCommentThread({
      epicId: EPIC_ID,
      artifactId: ARTIFACT_ID,
      viewTabId: TAB_ID,
    }),
  );
  act(() => result.current(THREAD_ID));
}

/**
 * Every field the hook writes, back to empty. `setActivePanelIdAndExpand`
 * touches three slices of the left-panel store and `revealCommentsPanel` a
 * fourth, so resetting the active-panel map alone would leave a test's expand
 * and reveal state visible to the next one.
 */
function resetStores(): void {
  useLeftPanelStore.setState({
    activePanelIdByTabId: {},
    mainCollapsedByTabId: {},
    panelSectionCollapsedByPanelId: {},
    commentsPanelRevealedByTabId: {},
  });
  useMobileSwitcherStore.setState({ openTabId: null });
  useCommentThreadsStore.setState({
    activeByEpicId: {},
    hoverByEpicId: {},
    flashByEpicId: {},
    draftByEpicId: {},
    artifactByEpicId: {},
  });
}

beforeEach(() => {
  viewport.isMobile = true;
  resetStores();
});

afterEach(() => {
  cleanup();
  resetStores();
});

describe("useActivateCommentThread", () => {
  it("opens the switcher sheet on Comments for a narrow viewport", () => {
    // The phone has no sidebar mounted, so selecting the panel alone would write
    // a selection nothing on screen reads - the anchor tap would look inert.
    activate();

    expect(useMobileSwitcherStore.getState().openTabId).toBe(TAB_ID);
    expect(useLeftPanelStore.getState().getActivePanelId(TAB_ID)).toBe(
      "comments",
    );
  });

  it("selects and flashes the thread so the panel opens on it", () => {
    activate();

    const state = useCommentThreadsStore.getState();
    expect(state.activeByEpicId[EPIC_ID]).toBe(THREAD_ID);
    expect(state.flashByEpicId[EPIC_ID]?.threadId).toBe(THREAD_ID);
  });

  it("leaves the sheet closed on a desktop viewport, where the sidebar holds the panel", () => {
    viewport.isMobile = false;

    activate();

    expect(useMobileSwitcherStore.getState().openTabId).toBeNull();
    expect(useLeftPanelStore.getState().getActivePanelId(TAB_ID)).toBe(
      "comments",
    );
  });
});
