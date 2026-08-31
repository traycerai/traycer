import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import { containsImageAtoms } from "@/lib/composer/image-atoms";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";

import type { ComposerPromptEditorHandle } from "./composer-prompt-editor";

interface UseChatComposerDraftArgs {
  readonly taskId: string;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
  /** Bumped by the owner when `ComposerPromptEditor` fires `onEditorReady`. */
  readonly editorReadyTick: number;
}

export function useChatComposerDraft(args: UseChatComposerDraftArgs) {
  const setSnapshotInStore = useComposerDraftStore(
    (state) => state.setSnapshot,
  );
  const setSelectionInStore = useComposerDraftStore(
    (state) => state.setSelection,
  );
  const [initialDraft] = useState(() => readComposerDraftSnapshot(args.taskId));
  const initialContent = initialDraft.content;
  const initialSelection = initialDraft.selection;

  const draftContent = useComposerDraftStore(
    (state) => state.drafts[args.taskId]?.content ?? initialContent,
  );
  const draftResetEpoch = useComposerDraftStore(
    (state) => state.drafts[args.taskId]?.resetEpoch ?? 0,
  );
  const draftHasText = useMemo(
    () =>
      extractPlainTextFromComposerJSONContent(draftContent).trim().length > 0,
    [draftContent],
  );
  const draftAnnotationCount = useComposerDraftStore(
    (state) => state.drafts[args.taskId]?.browserAnnotations.length ?? 0,
  );
  const draftHasImages = useMemo(
    () => containsImageAtoms(draftContent) || draftAnnotationCount > 0,
    [draftContent, draftAnnotationCount],
  );

  const handleDocumentChange = useCallback(
    (content: JsonContent, selection: { from: number; to: number }) => {
      setSnapshotInStore(args.taskId, content, selection);
    },
    [args.taskId, setSnapshotInStore],
  );

  const handleSelectionChange = useCallback(
    (selection: { from: number; to: number }) => {
      setSelectionInStore(args.taskId, selection);
    },
    [args.taskId, setSelectionInStore],
  );

  // `resetEpoch` bumps (queue-edit restore, failed-send restore, a quote
  // appended from elsewhere) can land while the editor is still constructing:
  // the handle exists from the owner's first commit but its methods no-op
  // until Tiptap's async `useEditor` resolves, so applying "into" it would
  // silently swallow the reset. `isReady()` blocks that, and `editorReadyTick`
  // (the owner's re-render signal for `onEditorReady`) re-runs the effect for
  // the pending-epoch catch-up once the editor truly exists.
  // `appliedResetEpochRef` keeps the apply idempotent per epoch; it stamps the
  // LIVE epoch read alongside the content so a bump that lands between render
  // and effect flush is not re-applied (which would re-fire `focus("end")`).
  // `syncContent` (not `setContent`) pushes the store's already-recorded
  // content into the editor WITHOUT re-emitting `onDocumentChange` - the store
  // bumped `revision` itself when it recorded this replacement, so an echoed
  // document-change here would double-count the one edit.
  const appliedResetEpochRef = useRef(draftResetEpoch);
  useEffect(() => {
    if (draftResetEpoch === appliedResetEpochRef.current) return;
    const editor = args.editorRef.current;
    if (editor === null || !editor.isReady()) return;
    const draft = useComposerDraftStore.getState().drafts[args.taskId];
    if (draft === undefined) return;
    editor.syncContent(draft.content, draft.selection);
    appliedResetEpochRef.current = draft.resetEpoch;
  }, [args.editorRef, args.taskId, args.editorReadyTick, draftResetEpoch]);

  return {
    initialContent,
    initialSelection,
    draftContent,
    draftHasText,
    draftHasImages,
    handleDocumentChange,
    handleSelectionChange,
  };
}
