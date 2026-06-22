import type { Editor } from "@tiptap/core";
import type {
  CommentThreadsStore,
  DraftRange,
} from "@/stores/comments/comment-threads-store";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";

export interface StartCommentDraftResult {
  /** True when a non-empty selection produced a draft range and the store
   *  was updated. False when the caller should toast / no-op (e.g. the
   *  selection was collapsed). */
  readonly started: boolean;
  readonly draft: DraftRange | null;
}

/**
 * Snap the editor's current selection into a `DraftRange` and stash it on
 * the comments store. Shared between the toolbar button and the
 * `Cmd+Opt+M` keyboard shortcut so both paths produce the exact same draft
 * shape - the floating draft popover then renders against the saved range.
 *
 * Quoted text snapshot is taken **once** here, frozen for the thread's
 * lifetime: subsequent edits inside the range never mutate the stored
 * `quotedText`, matching Views' freeze-at-creation behavior.
 */
export interface CommentDraftTarget {
  readonly epicId: string;
  readonly tabId: string;
  readonly tileId: string;
  readonly artifactId: string;
}

export function startCommentDraft(
  editor: Editor,
  target: CommentDraftTarget,
  setDraft: CommentThreadsStore["setDraft"],
): StartCommentDraftResult {
  const { from, to } = editor.state.selection;
  if (from >= to) return { started: false, draft: null };
  const quotedText = editor.state.doc.textBetween(from, to, " ");
  const draft: DraftRange = {
    tileId: target.tileId,
    artifactId: target.artifactId,
    from,
    to,
    quotedText,
  };
  setDraft(target.epicId, draft);
  // First in-doc comment-button click of this session reveals and opens
  // the Comments panel.
  // Per-tab, in-memory - recomputes on full reload.
  const leftPanel = useLeftPanelStore.getState();
  leftPanel.revealCommentsPanel(target.tabId);
  leftPanel.setActivePanelIdAndExpand(target.tabId, "comments");
  return { started: true, draft };
}
