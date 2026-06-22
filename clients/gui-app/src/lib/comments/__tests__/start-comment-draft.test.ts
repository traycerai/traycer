import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { startCommentDraft } from "@/lib/comments/start-comment-draft";
import type { DraftRange } from "@/stores/comments/comment-threads-store";
import {
  DEFAULT_LEFT_PANEL_GROUPS,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";

const editors: Editor[] = [];

function makeEditor(content: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit],
    content,
  });
  editors.push(editor);
  return editor;
}

function resetLeftPanelStore(): void {
  useLeftPanelStore.setState({
    activePanelIdByTabId: {},
    panelGroups: DEFAULT_LEFT_PANEL_GROUPS,
    mainCollapsedByTabId: {},
    panelSectionCollapsedByPanelId: {},
    panelSectionWeightsByPanelId: {},
    commentsPanelRevealedByTabId: {},
    localRootCreatePendingByEpicPanel: {},
    acknowledgedRootCreatePendingByEpicPanel: {},
    chatFilterByEpicId: {},
    artifactFilterByEpicId: {},
  });
}

beforeEach(resetLeftPanelStore);

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  resetLeftPanelStore();
});

describe("startCommentDraft", () => {
  it("stores the selected range with the owning tile and artifact", () => {
    const editor = makeEditor("hello world");
    editor.commands.setTextSelection({ from: 1, to: 6 });

    let captured: DraftRange | null = null;
    const result = startCommentDraft(
      editor,
      {
        epicId: "epic-a",
        tabId: "tab-a",
        tileId: "tile-a",
        artifactId: "spec-a",
      },
      (_epicId, draft) => {
        captured = draft;
      },
    );

    expect(result.started).toBe(true);
    expect(captured).toEqual({
      tileId: "tile-a",
      artifactId: "spec-a",
      from: 1,
      to: 6,
      quotedText: "hello",
    });
    expect(useLeftPanelStore.getState().getActivePanelId("tab-a")).toBe(
      "comments",
    );
    expect(useLeftPanelStore.getState().getActivePanelId("tab-b")).toBe(
      "chats",
    );
  });

  it("does not create a draft for a collapsed selection", () => {
    const editor = makeEditor("hello world");
    editor.commands.setTextSelection(1);

    let called = false;
    const result = startCommentDraft(
      editor,
      {
        epicId: "epic-a",
        tabId: "tab-a",
        tileId: "tile-a",
        artifactId: "spec-a",
      },
      () => {
        called = true;
      },
    );

    expect(result).toEqual({ started: false, draft: null });
    expect(called).toBe(false);
  });
});
