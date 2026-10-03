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
import {
  bindComposerDraftHost,
  unbindComposerDraftHost,
} from "@/lib/drafts/draft-mirror-coordinator";
import { containsImageAtoms } from "@/lib/composer/image-atoms";
import {
  mentionPlainTextFromAttrs,
  slashCommandPlainTextFromAttrs,
} from "@/lib/composer/tiptap-json-content";

import type { ComposerPromptEditorHandle } from "./composer-prompt-editor";
import { isSuggestionPlaceholderDocument } from "./prompt-suggestion";

function memoizeContentPredicate(predicate: (content: JsonContent) => boolean) {
  let previousContent: JsonContent | null = null;
  let previousResult = false;
  return (content: JsonContent): boolean => {
    if (content !== previousContent) {
      previousResult = predicate(content);
      previousContent = content;
    }
    return previousResult;
  };
}

function composerNodeHasText(node: JsonContent): boolean {
  switch (node.type) {
    case "text":
      return /\S/u.test(node.text ?? "");
    case "mention":
      return mentionPlainTextFromAttrs(node.attrs).length > 0;
    case "slashCommand":
      return slashCommandPlainTextFromAttrs(node.attrs).length > 0;
    case "blockquote":
    case "sourcedQuote":
      // Even an empty quote projects to the non-whitespace prefix `>`.
      return true;
    case "hardBreak":
    case "imageAttachment":
    case "attachmentGroup":
      return false;
    default:
      return node.content?.some(composerNodeHasText) ?? false;
  }
}

interface UseChatComposerDraftArgs {
  readonly chatId: string;
  readonly epicId: string | null;
  readonly hostId: string;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
  /** Bumped by the owner when `ComposerPromptEditor` fires `onEditorReady`. */
  readonly editorReadyTick: number;
  /**
   * Display snapshots recorded on this chat's draft row so the drafts list
   * can name it once this composer is gone (the titles come from the
   * open-epic projector, which only exists while the epic is open). `null`
   * before the projector has answered - and, on the mobile standalone chat
   * view, for the whole lifetime of the mount, since this composer renders
   * there with no `<EpicSessionProvider>` to read. The store treats a `null`
   * as "not answered" and keeps whatever label it already has, so neither
   * case blanks a row the drafts list can name.
   */
  readonly chatTitle: string | null;
  readonly epicTitle: string | null;
}

export function useChatComposerDraft(args: UseChatComposerDraftArgs) {
  const setSnapshotInStore = useComposerDraftStore(
    (state) => state.setSnapshot,
  );
  const setSelectionInStore = useComposerDraftStore(
    (state) => state.setSelection,
  );
  const [initialDraft] = useState(() => readComposerDraftSnapshot(args.chatId));
  const initialContent = initialDraft.content;
  const initialSelection = initialDraft.selection;

  const draftResetEpoch = useComposerDraftStore(
    (state) => state.drafts[args.chatId]?.resetEpoch ?? 0,
  );
  // Selectors run on every store write, including another chat's keystrokes.
  // Draft content is immutable, so unchanged documents need no traversal.
  const hasText = useMemo(
    () =>
      memoizeContentPredicate(
        (content) => content.content?.some(composerNodeHasText) ?? false,
      ),
    [],
  );
  const hasImages = useMemo(
    () => memoizeContentPredicate(containsImageAtoms),
    [],
  );
  const draftHasText = useComposerDraftStore((state) =>
    hasText(state.drafts[args.chatId]?.content ?? initialContent),
  );
  const isPlaceholder = useMemo(
    () => memoizeContentPredicate(isSuggestionPlaceholderDocument),
    [],
  );
  const draftIsSuggestionPlaceholder = useComposerDraftStore((state) =>
    isPlaceholder(state.drafts[args.chatId]?.content ?? initialContent),
  );
  const draftHasImages = useComposerDraftStore(
    (state) =>
      (state.drafts[args.chatId]?.browserAnnotations.length ?? 0) > 0 ||
      hasImages(state.drafts[args.chatId]?.content ?? initialContent),
  );

  const handleDocumentChange = useCallback(
    (content: JsonContent, selection: { from: number; to: number }) => {
      setSnapshotInStore(args.chatId, content, selection);
    },
    [args.chatId, setSnapshotInStore],
  );

  const handleSelectionChange = useCallback(
    (selection: { from: number; to: number }) => {
      setSelectionInStore(args.chatId, selection, args.hostId);
    },
    [args.chatId, args.hostId, setSelectionInStore],
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
    const draft = useComposerDraftStore.getState().drafts[args.chatId];
    if (draft === undefined) return;
    editor.syncContent(draft.content, draft.selection);
    appliedResetEpochRef.current = draft.resetEpoch;
  }, [args.editorRef, args.chatId, args.editorReadyTick, draftResetEpoch]);

  const bindTarget = useComposerDraftStore((state) => state.bindTarget);
  useEffect(() => {
    bindComposerDraftHost(args.chatId, args.hostId);
    if (args.epicId !== null) bindTarget(args.chatId, args.epicId);
    return () => {
      unbindComposerDraftHost(args.chatId, args.hostId);
    };
  }, [args.chatId, args.epicId, args.hostId, bindTarget]);

  // Kept out of the bind effect above for two reasons: a title arriving late
  // would tear down and re-register the host binding, and the setter is a
  // no-op until this chat HAS a row - which happens on the first keystroke,
  // not on mount. `draftId` is the signal for exactly that moment, so the
  // labels land on the row the list will show.
  const setComposerDraftTitles = useComposerDraftStore(
    (state) => state.setComposerDraftTitles,
  );
  const draftId = useComposerDraftStore(
    (state) => state.drafts[args.chatId]?.draftId ?? null,
  );
  useEffect(() => {
    if (draftId === null) return;
    setComposerDraftTitles(args.chatId, args.chatTitle, args.epicTitle);
  }, [
    args.chatId,
    args.chatTitle,
    args.epicTitle,
    draftId,
    setComposerDraftTitles,
  ]);

  return {
    initialContent,
    initialSelection,
    draftHasText,
    draftHasImages,
    draftIsSuggestionPlaceholder,
    handleDocumentChange,
    handleSelectionChange,
  };
}
