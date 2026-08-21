import {
  memo,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEventHandler,
  type DragEventHandler,
  type KeyboardEventHandler,
  type Ref,
} from "react";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { Selection, type Transaction } from "@tiptap/pm/state";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

import type { ChatComposerSubmitSource } from "@/lib/chats/resolve-steer-submit";
import {
  createComposerEditorIncarnation,
  type ComposerEditorIncarnation,
} from "@/lib/composer/composer-editor-incarnation";
import type { MentionAttachment } from "@/lib/composer/types";
import { cn } from "@/lib/utils";
import {
  focusActiveComposer,
  registerComposerFocus,
} from "@/lib/composer/composer-focus-registry";
import { normalizeComposerContentWithSelection } from "@/lib/composer/composer-content-normalizer";
import { hasClaimableFileTransfer } from "@/lib/files/file-transfer-paths";
import { usePaneActivationFocusIntent } from "@/components/epic-canvas/pane-activation";

import { buildComposerExtensions } from "./editor/editor-config";
import type {
  PastedComposerImage,
  PastedComposerImageOutcome,
} from "./editor/extensions/chat-paste-handler";
import {
  insertMentionAttachmentCommand,
  mentionSuggestionPluginKey,
} from "./editor/extensions/mention-extension";
import {
  skillSuggestionPluginKey,
  slashSuggestionPluginKey,
} from "./editor/extensions/slash-command-extension";
import {
  insertPathSpansCommand,
  insertImageAttachmentsCommand,
  type PathInsertionCommit,
} from "@/hooks/composer/use-composer-paste";
import type { ImageAttachmentAttrs } from "./editor/extensions/image-attachment-extension";
import type { ComposerPickerStore } from "./picker/composer-picker-store";

const composerEditorIncarnations = new WeakMap<
  Editor,
  ComposerEditorIncarnation
>();

function incarnationForEditor(editor: Editor): ComposerEditorIncarnation {
  const existing = composerEditorIncarnations.get(editor);
  if (existing !== undefined) return existing;

  const created = createComposerEditorIncarnation();
  composerEditorIncarnations.set(editor, created);
  return created;
}

export interface ComposerPromptEditorHandle {
  /**
   * Whether the async Tiptap editor behind this handle exists yet. The handle
   * itself is created on first commit - before `useEditor` (with
   * `immediatelyRender: false`) has produced an editor - and every method
   * below silently no-ops until then. Callers that must not lose a write
   * (the draft-reset bridge) check this instead of treating a non-null handle
   * as "ready".
   */
  readonly isReady: () => boolean;
  /**
   * Identity of the actual Tiptap editor behind this capability facade.
   * Stable across facade replacement; changes only when the editor is
   * genuinely recreated. Returns `null` while the editor is not ready.
   */
  readonly getEditorIncarnation: () => ComposerEditorIncarnation | null;
  readonly focus: () => void;
  readonly focusAtEnd: () => void;
  readonly hasFocus: () => boolean;
  readonly getJSON: () => JsonContent;
  readonly isEmpty: () => boolean;
  readonly clear: () => void;
  /**
   * Replace the document and notify the owner via the normal `onDocumentChange`
   * signal (a real editor-level document mutation). The landing and new-
   * conversation prompt-stash destinations use this path; chat records its
   * canonical replacement first and then uses {@link syncContent}.
   */
  readonly setContent: (
    content: JsonContent,
    selection: { readonly from: number; readonly to: number } | null,
  ) => void;
  /**
   * Replace the document WITHOUT emitting `onDocumentChange` - for an owner
   * that already recorded this exact replacement against its own canonical
   * store (e.g. the chat draft store's resetEpoch bridge) before pushing it
   * into the live editor to match. An echoed `onDocumentChange` here would
   * double-count one external replacement as two document mutations.
   */
  readonly syncContent: (
    content: JsonContent,
    selection: { readonly from: number; readonly to: number } | null,
  ) => void;
  readonly insertImageAttachments: (
    attrs: ReadonlyArray<ImageAttachmentAttrs>,
  ) => void;
  /** Insert an existing @-mention attachment at the preserved caret. */
  readonly insertMentionAttachment: (mention: MentionAttachment) => boolean;
  /**
   * Starts a path-insertion job anchored to the current caret. The returned
   * one-shot `commit` maps that position through intervening editor changes
   * and returns `false` if the editor was destroyed before resolution.
   */
  readonly beginPathInsertion: () => PathInsertionCommit | null;
  readonly removeImageAttachmentById: (id: string) => void;
  /**
   * Flip a pending base64 image node (located by `id`) to its stored content
   * hash IN PLACE, preserving its document position. A landing paste inserts
   * image nodes in order carrying `b64content`; each node's background
   * hash+store job calls this to convert it to `{hash}` once bytes are durable.
   * Returns the command's result: `false` when no node with that id exists (the
   * user removed the pending node before the write settled, or the editor is
   * gone) so the caller can reclaim the now-unrooted bytes.
   */
  readonly rewriteImageAttachmentHashById: (
    id: string,
    hash: string,
  ) => boolean;
  /**
   * Insert a finalized dictation segment at the caret (with a trailing space
   * so consecutive segments don't run together). Focuses first so the
   * insertion lands at the live cursor and the caret advances past it -
   * sequential segments append cleanly.
   */
  readonly insertDictatedText: (text: string) => void;
  /**
   * Fully exit whichever `@`/`/` suggestion picker is currently open (clearing
   * the plugin's active range/decoration and closing the picker menu), and
   * report whether one was open. Lets a surrounding surface (e.g. a dialog)
   * treat Escape as "close the picker" without the editor's own keydown - see
   * the New Conversation modal, where Radix would otherwise swallow the Escape.
   */
  readonly dismissActiveSuggestion: () => boolean;
}

export interface ComposerPromptEditorProps {
  readonly initialContent: JsonContent;
  readonly initialSelection: {
    readonly from: number;
    readonly to: number;
  } | null;
  readonly pickerStore: ComposerPickerStore;
  readonly placeholder: string;
  readonly editorClassName: string | undefined;
  readonly stabilizeImageAttachmentCaret: boolean;
  readonly isActive: boolean;
  readonly disabled: boolean;
  readonly slashProviderId: GuiHarnessId;
  readonly hasPastedImageBytes: ((hash: string) => boolean) | null;
  /**
   * Landing-only: validates a paste's inline-base64 images + starts their
   * in-place background ingest jobs, returning a verdict per image. `null` on
   * chat surfaces, where base64 nodes are inserted verbatim. See
   * `ChatPasteHandlerDeps`.
   */
  readonly ingestPastedComposerImages:
    | ((
        images: ReadonlyArray<PastedComposerImage>,
      ) => ReadonlyArray<PastedComposerImageOutcome>)
    | null;
  /**
   * A real document mutation (Tiptap's own `docChanged`-gated `update` event -
   * typing, pasting, an image insert/remove, or a programmatic `setContent`).
   * Never fired for a caret-only move; see `onSelectionChange`.
   */
  readonly onDocumentChange: (
    content: JsonContent,
    selection: { readonly from: number; readonly to: number },
  ) => void;
  /**
   * Caret/selection moved with no document mutation. Deliberately carries no
   * `content` - a selection-only event must never serialize the document (it
   * can carry multi-megabyte inline images), so this never calls `getJSON()`.
   */
  readonly onSelectionChange: (selection: {
    readonly from: number;
    readonly to: number;
  }) => void;
  readonly onSubmit: (source: ChatComposerSubmitSource) => void;
  readonly onPaste: ClipboardEventHandler<HTMLElement>;
  readonly onDragOver: DragEventHandler<HTMLElement>;
  readonly onDrop: DragEventHandler<HTMLElement>;
  readonly onKeyDown: KeyboardEventHandler<HTMLElement> | undefined;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
  /**
   * Fired (once per editor instance) when the async Tiptap editor is created
   * and the handle's methods stop no-oping. Ref mutations are invisible to the
   * owner's render cycle, so owners that must react to readiness (the
   * draft-reset bridge's handle-ready catch-up) take this explicit signal.
   */
  readonly onEditorReady: (() => void) | null;
  readonly ref?: Ref<ComposerPromptEditorHandle>;
}

interface ComposerTransactionEvent {
  readonly transaction: Transaction;
  readonly appendedTransactions: Transaction[];
}

function subscribeToComposerTransactions(
  editor: Editor,
  listener: (event: ComposerTransactionEvent) => void,
): () => void {
  editor.on("transaction", listener);
  return () => editor.off("transaction", listener);
}

function usePastedImageBytesPresenceGetter(
  hasPastedImageBytes: ((hash: string) => boolean) | null,
): () => ((hash: string) => boolean) | null {
  const latest = useRef(hasPastedImageBytes);
  useLayoutEffect(() => {
    latest.current = hasPastedImageBytes;
  }, [hasPastedImageBytes]);
  return useCallback(() => latest.current, []);
}

// Stable getter for the live placeholder, mirroring the presence-getter above.
// The Tiptap Placeholder decoration closes over this once (extensions build
// once) and re-reads it on each transaction, so a changing placeholder never
// rebuilds the editor. The layout effect lands the new value before the owner's
// no-op-transaction poke fires.
function usePlaceholderGetter(placeholder: string): () => string {
  const latest = useRef(placeholder);
  useLayoutEffect(() => {
    latest.current = placeholder;
  }, [placeholder]);
  return useCallback(() => latest.current, []);
}

function useIngestPastedComposerImagesGetter(
  ingestPastedComposerImages:
    | ((
        images: ReadonlyArray<PastedComposerImage>,
      ) => ReadonlyArray<PastedComposerImageOutcome>)
    | null,
): () =>
  | ((
      images: ReadonlyArray<PastedComposerImage>,
    ) => ReadonlyArray<PastedComposerImageOutcome>)
  | null {
  const latest = useRef(ingestPastedComposerImages);
  useLayoutEffect(() => {
    latest.current = ingestPastedComposerImages;
  }, [ingestPastedComposerImages]);
  return useCallback(() => latest.current, []);
}

function ComposerPromptEditorImpl(props: ComposerPromptEditorProps) {
  const composerSurfaceId = useId();
  const {
    initialContent,
    initialSelection,
    pickerStore,
    placeholder,
    editorClassName,
    stabilizeImageAttachmentCaret,
    isActive,
    disabled,
    slashProviderId,
    hasPastedImageBytes,
    ingestPastedComposerImages,
    onDocumentChange,
    onSelectionChange,
    onSubmit,
    onPaste,
    onDragOver,
    onDrop,
    onKeyDown,
    onFocus,
    onBlur,
    onEditorReady,
    ref,
  } = props;
  const paneActivationFocusIntent = usePaneActivationFocusIntent();

  // Tiptap's `useEditor` extension chain is built once (`buildComposerExtensions`
  // is memoized with empty editor deps). The plugin closure inside calls
  // `onSubmit`/`onDocumentChange`/`onSelectionChange` long after extensions
  // were registered, so we feed it via refs that always point at the latest
  // prop. This is a *legitimate* latest-value-ref usage (closure into a static
  // external library plugin) - do not "fix" it by adding the callbacks to the
  // editor deps; that would rebuild Tiptap on every keystroke.
  const normalizedInitial = useMemo(
    () =>
      normalizeComposerContentWithSelection(initialContent, initialSelection),
    [initialContent, initialSelection],
  );
  const onSubmitRef = useRef(onSubmit);
  const onDocumentChangeRef = useRef(onDocumentChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onEditorReadyRef = useRef(onEditorReady);
  const initialSelectionRef = useRef(normalizedInitial.selection);
  const initialAutofocusSelectionPreparedRef = useRef(false);
  useEffect(() => {
    onSubmitRef.current = onSubmit;
    onDocumentChangeRef.current = onDocumentChange;
    onSelectionChangeRef.current = onSelectionChange;
    onEditorReadyRef.current = onEditorReady;
  });

  const [stableSubmitHolder] = useState<{
    readonly current: (source: ChatComposerSubmitSource) => void;
  }>(() => ({
    current: (source) => {
      onSubmitRef.current(source);
    },
  }));
  // Live placeholder source. The editor is built once, so a changing placeholder
  // (e.g. the mid-turn steer hint) flows through this stable getter rather than
  // rebuilding extensions; an effect below re-reads it via a no-op transaction.
  const getPlaceholder = usePlaceholderGetter(placeholder);
  const getHasPastedImageBytes =
    usePastedImageBytesPresenceGetter(hasPastedImageBytes);
  const getIngestPastedComposerImages = useIngestPastedComposerImagesGetter(
    ingestPastedComposerImages,
  );
  const extensions = useMemo(
    () =>
      buildComposerExtensions({
        pickerStore,
        getPlaceholder,
        onSubmit: stableSubmitHolder,
        slashProviderId,
        getHasPastedImageBytes,
        getIngestPastedComposerImages,
      }),
    [
      getHasPastedImageBytes,
      getPlaceholder,
      getIngestPastedComposerImages,
      pickerStore,
      slashProviderId,
      stableSubmitHolder,
    ],
  );

  const editorAttributesObject = useMemo(
    () => editorAttributes(placeholder, editorClassName),
    [editorClassName, placeholder],
  );
  const editor = useEditor(
    {
      extensions,
      content: normalizedInitial.content,
      // Initial focus is coordinated by the guarded effect below. Tiptap's
      // intrinsic autofocus runs after its deferred mount and bypasses pane
      // activation / restored-terminal ownership checks.
      autofocus: false,
      immediatelyRender: false,
      editable: !disabled,
      editorProps: {
        attributes: editorAttributesObject,
      },
      onUpdate({ editor: updatedEditor }) {
        // Tiptap only fires `update` when a transaction actually changed the
        // document (gated internally on `docChanged` plus a structural
        // doc-equality check) - so every call here is a real mutation, never
        // a caret-only echo. `getJSON()` is safe precisely because of that
        // gate, not despite it.
        onDocumentChangeRef.current(updatedEditor.getJSON(), {
          from: updatedEditor.state.selection.from,
          to: updatedEditor.state.selection.to,
        });
      },
      onSelectionUpdate({ editor: updatedEditor }) {
        // Never call `getJSON()` here - a selection-only event must not
        // serialize the document, which can carry multi-megabyte inline
        // images.
        onSelectionChangeRef.current({
          from: updatedEditor.state.selection.from,
          to: updatedEditor.state.selection.to,
        });
      },
    },
    [],
  );

  useEffect(() => {
    if (editor === null) return;
    onEditorReadyRef.current?.();
  }, [editor]);

  useEffect(() => {
    if (editor === null) return;
    const selection = initialSelectionRef.current;
    if (selection === null) return;
    editor.commands.setTextSelection({
      from: selection.from,
      to: selection.to,
    });
  }, [editor]);

  useEffect(() => {
    if (editor === null) return;
    // Tiptap's `setEditable` emits `update` unconditionally when told to -
    // bypassing the normal `docChanged` gate entirely - so toggling `disabled`
    // (e.g. the moment a submission starts) would otherwise fire a phantom
    // `onDocumentChange` for a document that never changed. Suppress it: this
    // call carries no content change to report.
    editor.setEditable(!disabled, false);
  }, [editor, disabled]);

  useLayoutEffect(() => {
    if (editor === null) return;
    return registerComposerFocus(
      composerSurfaceId,
      {
        focus: () => {
          editor.commands.focus();
        },
        containsActiveElement: (activeElement) =>
          activeElement === editor.view.dom ||
          (activeElement !== null && editor.view.dom.contains(activeElement)),
        isEligible: () => editor.view.dom.isConnected,
      },
      isActive,
    );
  }, [composerSurfaceId, editor, isActive]);

  useEffect(() => {
    if (editor === null) return;
    if (!isActive) return;
    if (editor.isFocused) return;
    if (paneActivationFocusIntent.shouldYieldAutoFocus()) return;
    const focusScope = editor.view.dom.closest(
      "[data-primary-focus-scope='true']",
    );
    if (
      focusScope !== null &&
      document.activeElement !== null &&
      focusScope.contains(document.activeElement)
    ) {
      return;
    }
    if (
      !initialAutofocusSelectionPreparedRef.current &&
      initialSelectionRef.current === null
    ) {
      editor.commands.setTextSelection(editor.state.doc.content.size);
    }
    initialAutofocusSelectionPreparedRef.current = true;
    focusActiveComposer();
  }, [editor, isActive, paneActivationFocusIntent]);

  useEffect(() => {
    if (editor === null) return;
    Object.entries(editorAttributesObject).forEach(([name, value]) => {
      editor.view.dom.setAttribute(name, value);
    });
  }, [editor, editorAttributesObject]);

  useEffect(() => {
    // The Placeholder decoration only re-reads the getter on a transaction. Poke
    // an empty one when the placeholder changes and the editor is showing it
    // (empty), so a mid-turn steer hint appears without waiting for a keystroke.
    // Skipped while non-empty to avoid disturbing an in-progress edit / IME.
    // `usePlaceholderGetter`'s layout effect has already landed the new value.
    if (editor !== null && editor.isEmpty) {
      editor.view.dispatch(editor.state.tr);
    }
  }, [editor, placeholder]);

  const isReady = useCallback(() => editor !== null, [editor]);

  const focus = useCallback(() => {
    editor?.commands.focus();
  }, [editor]);

  const focusAtEnd = useCallback(() => {
    editor?.commands.focus("end");
  }, [editor]);

  const hasFocus = useCallback(
    (): boolean => editor?.isFocused ?? false,
    [editor],
  );

  const getJSON = useCallback((): JsonContent => {
    if (editor === null) return normalizedInitial.content;
    return editor.getJSON();
  }, [editor, normalizedInitial.content]);

  const isEmpty = useCallback((): boolean => {
    if (editor === null) return true;
    return editor.isEmpty;
  }, [editor]);

  const clear = useCallback(() => {
    if (editor === null) return;
    editor.chain().clearContent().focus().run();
  }, [editor]);

  const applyContent = useCallback(
    (
      content: JsonContent,
      selection: { readonly from: number; readonly to: number } | null,
      emitUpdate: boolean,
    ) => {
      if (editor === null) return;
      const normalized = normalizeComposerContentWithSelection(
        content,
        selection,
      );
      editor.commands.setContent(normalized.content, { emitUpdate });
      if (normalized.selection !== null) {
        editor.commands.setTextSelection({
          from: normalized.selection.from,
          to: normalized.selection.to,
        });
      } else {
        editor.commands.focus("end");
      }
    },
    [editor],
  );

  const setContent = useCallback(
    (
      content: JsonContent,
      selection: { readonly from: number; readonly to: number } | null,
    ) => {
      applyContent(content, selection, true);
    },
    [applyContent],
  );

  const syncContent = useCallback(
    (
      content: JsonContent,
      selection: { readonly from: number; readonly to: number } | null,
    ) => {
      applyContent(content, selection, false);
    },
    [applyContent],
  );

  const handleDrop = useCallback<DragEventHandler<HTMLElement>>(
    (event) => {
      if (editor !== null && hasClaimableFileTransfer(event.dataTransfer)) {
        const dropPos = editor.view.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        });
        if (dropPos !== null) {
          editor.commands.setTextSelection(dropPos.pos);
        }
      }
      onDrop(event);
    },
    [editor, onDrop],
  );

  const insertImageAttachments = useCallback(
    (attrs: ReadonlyArray<ImageAttachmentAttrs>) => {
      if (editor === null) return;
      insertImageAttachmentsCommand(
        editor,
        attrs,
        stabilizeImageAttachmentCaret,
      );
    },
    [editor, stabilizeImageAttachmentCaret],
  );

  const insertMentionAttachment = useCallback(
    (mention: MentionAttachment): boolean => {
      if (editor === null || editor.isDestroyed) return false;
      return insertMentionAttachmentCommand(editor, mention);
    },
    [editor],
  );

  const beginPathInsertion = useCallback((): PathInsertionCommit | null => {
    if (editor === null || editor.isDestroyed) return null;
    let position = editor.state.selection.to;
    const onTransaction = ({
      transaction,
      appendedTransactions,
    }: ComposerTransactionEvent): void => {
      [transaction, ...appendedTransactions].forEach((tr) => {
        position = tr.mapping.map(position, -1);
      });
    };
    const unsubscribeFromTransactions = subscribeToComposerTransactions(
      editor,
      onTransaction,
    );
    let settled = false;
    return (paths): boolean => {
      if (settled) return false;
      settled = true;
      unsubscribeFromTransactions();
      if (editor.isDestroyed) return false;
      if (paths.length > 0) {
        insertPathSpansCommand(editor, { paths, position });
        editor.commands.focus();
      }
      return true;
    };
  }, [editor]);

  const removeImageAttachmentById = useCallback(
    (id: string) => {
      if (editor === null) return;
      editor.commands.removeImageAttachmentById(id);
    },
    [editor],
  );

  const rewriteImageAttachmentHashById = useCallback(
    (id: string, hash: string): boolean => {
      if (editor === null || editor.isDestroyed) return false;
      return editor.commands.rewriteImageAttachmentHashById(id, hash);
    },
    [editor],
  );

  const insertDictatedText = useCallback(
    (text: string) => {
      if (editor === null) return;
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      // A trailing space keeps consecutive segments from running together.
      // Insert as a ProseMirror text node (not a string): `insertContent` parses
      // a string as editor content, so a transcript containing `<…>` would be
      // interpreted as markup - a text node is always inserted verbatim.
      const node = { type: "text", text: `${trimmed} ` };
      if (editor.isFocused) {
        // Editor has the caret: insert there so segments append in order.
        editor.chain().focus().insertContent(node).run();
      } else {
        // Don't steal focus (e.g. user clicked Stop/another field, or a mid-
        // utterance auto-commit landed) - append at the end of the last text
        // block. Inserting at `doc.content.size` lands *after* the final
        // paragraph, so ProseMirror wraps the text in a fresh paragraph and an
        // empty composer gains a leading blank line before the first segment.
        // `Selection.atEnd` resolves inside the last textblock, appending
        // cleanly with no spurious newline.
        const endPos = Selection.atEnd(editor.state.doc).to;
        editor.chain().insertContentAt(endPos, node).run();
      }
    },
    [editor],
  );

  const dismissActiveSuggestion = useCallback((): boolean => {
    if (editor === null) return false;
    // The store's `open` flips with the suggestion plugin's active state (the
    // render's onStart/onExit drive it), so this gates on a picker actually
    // showing. Dispatch the suggestion-exit meta to every plugin key; the
    // active one transitions to "stopped" - clearing its range/decoration and
    // firing onExit, which closes the menu - and the inactive ones ignore it.
    if (!pickerStore.getState().open) return false;
    editor.view.dispatch(
      editor.state.tr
        .setMeta(mentionSuggestionPluginKey, { exit: true })
        .setMeta(slashSuggestionPluginKey, { exit: true })
        .setMeta(skillSuggestionPluginKey, { exit: true }),
    );
    return true;
  }, [editor, pickerStore]);

  const getEditorIncarnation = useCallback(
    (): ComposerEditorIncarnation | null =>
      editor === null ? null : incarnationForEditor(editor),
    [editor],
  );

  useImperativeHandle(
    ref,
    () => ({
      isReady,
      getEditorIncarnation,
      focus,
      focusAtEnd,
      hasFocus,
      getJSON,
      isEmpty,
      clear,
      setContent,
      syncContent,
      insertImageAttachments,
      insertMentionAttachment,
      beginPathInsertion,
      removeImageAttachmentById,
      rewriteImageAttachmentHashById,
      insertDictatedText,
      dismissActiveSuggestion,
    }),
    [
      beginPathInsertion,
      clear,
      dismissActiveSuggestion,
      focus,
      focusAtEnd,
      getEditorIncarnation,
      hasFocus,
      getJSON,
      insertImageAttachments,
      insertMentionAttachment,
      insertDictatedText,
      isEmpty,
      isReady,
      removeImageAttachmentById,
      rewriteImageAttachmentHashById,
      setContent,
      syncContent,
    ],
  );

  if (editor === null) return null;

  return (
    <EditorContent
      editor={editor}
      className="relative flex-1"
      onPaste={onPaste}
      onDragOver={onDragOver}
      onDrop={handleDrop}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
    />
  );
}

function editorAttributes(
  placeholder: string,
  className: string | undefined,
): Record<string, string> {
  return {
    class: cn(
      "block max-h-[min(50vh,15rem)] min-h-10 w-full overflow-y-auto whitespace-pre-wrap wrap-break-word bg-transparent text-ui leading-relaxed text-foreground focus:outline-none",
      className,
    ),
    "data-testid": "composer-editor",
    "data-composer-editor": "",
    "aria-label": placeholder,
    "aria-placeholder": placeholder,
    role: "textbox",
    "aria-multiline": "true",
    // Explicit opt-in to native spell-check. Without this attribute,
    // some ProseMirror/TipTap defaults render `spellcheck="false"` on
    // the contenteditable, which suppresses Chromium's red underline +
    // the desktop shell's right-click suggestions menu.
    spellcheck: "true",
  };
}

export const ComposerPromptEditor = memo(ComposerPromptEditorImpl);
