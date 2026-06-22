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
}

export function useChatComposerDraft(args: UseChatComposerDraftArgs) {
  const setSnapshotInStore = useComposerDraftStore(
    (state) => state.setSnapshot,
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
  const draftHasImages = useMemo(
    () => containsImageAtoms(draftContent),
    [draftContent],
  );

  const handleSnapshot = useCallback(
    (content: JsonContent, selection: { from: number; to: number }) => {
      setSnapshotInStore(args.taskId, content, selection);
    },
    [args.taskId, setSnapshotInStore],
  );

  const applyDraftResetRef = useRef(NOOP);
  useEffect(() => {
    applyDraftResetRef.current = () => {
      const editor = args.editorRef.current;
      if (editor === null) return;
      const draft = useComposerDraftStore.getState().drafts[args.taskId];
      if (draft === undefined) return;
      editor.setContent(draft.content, draft.selection);
    };
  }, [args.editorRef, args.taskId]);
  useEffect(() => {
    if (draftResetEpoch === 0) return;
    applyDraftResetRef.current();
  }, [draftResetEpoch]);

  return {
    initialContent,
    initialSelection,
    draftContent,
    draftHasText,
    draftHasImages,
    handleSnapshot,
  };
}

const NOOP = (): void => undefined;
