import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useActivateCommentThread } from "@/hooks/comments/use-activate-comment-thread";
import type { CommentArtifactKind } from "@/lib/comments/artifact-comment-kind";
import { registerCommentEditor } from "@/lib/comments/comment-editor-registry";
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

function activate(artifactType: CommentArtifactKind | undefined): void {
  const { result } = renderHook(() =>
    useActivateCommentThread({
      epicId: EPIC_ID,
      artifactId: ARTIFACT_ID,
      viewTabId: TAB_ID,
      ...(artifactType === undefined ? {} : { artifactType }),
    }),
  );
  act(() => result.current(THREAD_ID));
}

/**
 * Every field the hook writes, back to empty. `setActivePanelIdAndExpand`
 * touches two slices of the left-panel store and `revealCommentsPanel` a
 * third, so resetting the active-panel map alone would leave a test's expand
 * and reveal state visible to the next one.
 */
function resetStores(): void {
  useLeftPanelStore.setState({
    activePanelIdByTabId: {},
    mainCollapsedByTabId: {},
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
    activate(undefined);

    expect(useMobileSwitcherStore.getState().openTabId).toBe(TAB_ID);
    expect(useLeftPanelStore.getState().getActivePanelId(TAB_ID)).toBe(
      "comments",
    );
  });

  it("selects and flashes the thread so the panel opens on it", () => {
    activate(undefined);

    const state = useCommentThreadsStore.getState();
    expect(state.activeByEpicId[EPIC_ID]).toBe(THREAD_ID);
    expect(state.flashByEpicId[EPIC_ID]?.threadId).toBe(THREAD_ID);
  });

  it("leaves the sheet closed on a desktop viewport, where the sidebar holds the panel", () => {
    viewport.isMobile = false;

    activate(undefined);

    expect(useMobileSwitcherStore.getState().openTabId).toBeNull();
    expect(useLeftPanelStore.getState().getActivePanelId(TAB_ID)).toBe(
      "comments",
    );
  });

  it.each(["spec", "ticket", "story", "review"] as const)(
    "keeps the sidebar behaviour for a %s artifact",
    (artifactType) => {
      activate(artifactType);

      expect(useMobileSwitcherStore.getState().openTabId).toBe(TAB_ID);
      expect(useLeftPanelStore.getState().getActivePanelId(TAB_ID)).toBe(
        "comments",
      );
    },
  );

  describe.each([true, false])(
    "for html and canvas artifacts (mobile viewport: %s)",
    (isMobile) => {
      // Their threads live in pins on the frame, so there is no comments panel
      // to bring forward on either viewport.
      it.each(["html", "canvas"] as const)(
        "selects, flashes and reveals the thread of a %s artifact without opening the sidebar or the sheet",
        (artifactType) => {
          viewport.isMobile = isMobile;
          const reveal = vi.fn(() => true);
          const unregister = registerCommentEditor({
            epicId: EPIC_ID,
            artifactId: ARTIFACT_ID,
            tileId: "tile-1",
            isActive: true,
            reveal,
          });

          activate(artifactType);
          unregister();

          const threads = useCommentThreadsStore.getState();
          expect(threads.activeByEpicId[EPIC_ID]).toBe(THREAD_ID);
          expect(threads.flashByEpicId[EPIC_ID]?.threadId).toBe(THREAD_ID);
          expect(reveal).toHaveBeenCalledWith(THREAD_ID);
          expect(useMobileSwitcherStore.getState().openTabId).toBeNull();
          const leftPanel = useLeftPanelStore.getState();
          expect(leftPanel.activePanelIdByTabId[TAB_ID]).toBeUndefined();
          expect(leftPanel.mainCollapsedByTabId[TAB_ID]).toBeUndefined();
          expect(
            leftPanel.commentsPanelRevealedByTabId[TAB_ID],
          ).toBeUndefined();
        },
      );
    },
  );
});
