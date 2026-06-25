import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ClipboardEventHandler,
  type DragEventHandler,
  type KeyboardEventHandler,
  type Ref,
} from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Selection } from "@tiptap/pm/state";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

import { cn } from "@/lib/utils";
import { registerComposerFocus } from "@/lib/composer/composer-focus-registry";

import { buildComposerExtensions } from "./editor/editor-config";
import { mentionSuggestionPluginKey } from "./editor/extensions/mention-extension";
import { slashSuggestionPluginKey } from "./editor/extensions/slash-command-extension";
import { insertImageAttachmentsCommand } from "@/hooks/composer/use-composer-paste";
import type { ImageAttachmentAttrs } from "./editor/extensions/image-attachment-extension";
import type { ComposerPickerStore } from "./picker/composer-picker-store";

export interface ComposerPromptEditorHandle {
  readonly focus: () => void;
  readonly focusAtEnd: () => void;
  readonly getJSON: () => JsonContent;
  readonly isEmpty: () => boolean;
  readonly clear: () => void;
  readonly setContent: (
    content: JsonContent,
    selection: { readonly from: number; readonly to: number } | null,
  ) => void;
  readonly insertImageAttachments: (
    attrs: ReadonlyArray<ImageAttachmentAttrs>,
  ) => void;
  readonly removeImageAttachmentById: (id: string) => void;
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
  readonly isActive: boolean;
  readonly disabled: boolean;
  readonly slashProviderId: GuiHarnessId;
  readonly onSnapshot: (
    content: JsonContent,
    selection: { from: number; to: number },
  ) => void;
  readonly onSubmit: () => void;
  readonly onPaste: ClipboardEventHandler<HTMLElement>;
  readonly onDragOver: DragEventHandler<HTMLElement>;
  readonly onDrop: DragEventHandler<HTMLElement>;
  readonly onKeyDown: KeyboardEventHandler<HTMLElement> | undefined;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
  readonly ref?: Ref<ComposerPromptEditorHandle>;
}

function ComposerPromptEditorImpl(props: ComposerPromptEditorProps) {
  const {
    initialContent,
    initialSelection,
    pickerStore,
    placeholder,
    editorClassName,
    isActive,
    disabled,
    slashProviderId,
    onSnapshot,
    onSubmit,
    onPaste,
    onDragOver,
    onDrop,
    onKeyDown,
    onFocus,
    onBlur,
    ref,
  } = props;

  // Tiptap's `useEditor` extension chain is built once (`buildComposerExtensions`
  // is memoized with empty editor deps). The plugin closure inside calls
  // `onSubmit`/`onSnapshot` long after extensions were registered, so we feed
  // it via refs that always point at the latest prop. This is a *legitimate*
  // latest-value-ref usage (closure into a static external library plugin) -
  // do not "fix" it by adding the callbacks to the editor deps; that would
  // rebuild Tiptap on every keystroke.
  const onSubmitRef = useRef(onSubmit);
  const onSnapshotRef = useRef(onSnapshot);
  const initialSelectionRef = useRef(initialSelection);
  useEffect(() => {
    onSubmitRef.current = onSubmit;
    onSnapshotRef.current = onSnapshot;
  });

  const [stableSubmitHolder] = useState<{ readonly current: () => void }>(
    () => ({
      current: () => {
        onSubmitRef.current();
      },
    }),
  );

  const extensions = useMemo(
    () =>
      buildComposerExtensions({
        pickerStore,
        placeholder,
        onSubmit: stableSubmitHolder,
        slashProviderId,
      }),
    [pickerStore, placeholder, slashProviderId, stableSubmitHolder],
  );

  const editorAttributesObject = useMemo(
    () => editorAttributes(placeholder, editorClassName),
    [editorClassName, placeholder],
  );

  const editor = useEditor(
    {
      extensions,
      content: initialContent,
      autofocus: isActive ? "end" : false,
      immediatelyRender: false,
      editable: !disabled,
      editorProps: {
        attributes: editorAttributesObject,
      },
      onUpdate({ editor: updatedEditor }) {
        onSnapshotRef.current(updatedEditor.getJSON(), {
          from: updatedEditor.state.selection.from,
          to: updatedEditor.state.selection.to,
        });
      },
      onSelectionUpdate({ editor: updatedEditor }) {
        onSnapshotRef.current(updatedEditor.getJSON(), {
          from: updatedEditor.state.selection.from,
          to: updatedEditor.state.selection.to,
        });
      },
    },
    [],
  );

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
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  useEffect(() => {
    if (editor === null) return;
    if (!isActive) return;
    if (editor.isFocused) return;
    editor.commands.focus();
  }, [editor, isActive]);

  useEffect(() => {
    if (editor === null) return;
    return registerComposerFocus(() => {
      editor.commands.focus();
    }, isActive);
  }, [editor, isActive]);

  useEffect(() => {
    if (editor === null) return;
    Object.entries(editorAttributesObject).forEach(([name, value]) => {
      editor.view.dom.setAttribute(name, value);
    });
  }, [editor, editorAttributesObject]);

  const focus = useCallback(() => {
    editor?.commands.focus();
  }, [editor]);

  const focusAtEnd = useCallback(() => {
    editor?.commands.focus("end");
  }, [editor]);

  const getJSON = useCallback((): JsonContent => {
    if (editor === null) return initialContent;
    return editor.getJSON();
  }, [editor, initialContent]);

  const isEmpty = useCallback((): boolean => {
    if (editor === null) return true;
    return editor.isEmpty;
  }, [editor]);

  const clear = useCallback(() => {
    if (editor === null) return;
    editor.chain().clearContent().focus().run();
  }, [editor]);

  const setContent = useCallback(
    (
      content: JsonContent,
      selection: { readonly from: number; readonly to: number } | null,
    ) => {
      if (editor === null) return;
      editor.commands.setContent(content);
      if (selection !== null) {
        editor.commands.setTextSelection({
          from: selection.from,
          to: selection.to,
        });
      } else {
        editor.commands.focus("end");
      }
    },
    [editor],
  );

  const insertImageAttachments = useCallback(
    (attrs: ReadonlyArray<ImageAttachmentAttrs>) => {
      if (editor === null) return;
      insertImageAttachmentsCommand(editor, attrs);
    },
    [editor],
  );

  const removeImageAttachmentById = useCallback(
    (id: string) => {
      if (editor === null) return;
      editor.commands.removeImageAttachmentById(id);
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
    // showing. Dispatch the suggestion-exit meta to both plugin keys; the
    // active one transitions to "stopped" - clearing its range/decoration and
    // firing onExit, which closes the menu - and the inactive one ignores it.
    if (!pickerStore.getState().open) return false;
    editor.view.dispatch(
      editor.state.tr
        .setMeta(mentionSuggestionPluginKey, { exit: true })
        .setMeta(slashSuggestionPluginKey, { exit: true }),
    );
    return true;
  }, [editor, pickerStore]);

  useImperativeHandle(
    ref,
    () => ({
      focus,
      focusAtEnd,
      getJSON,
      isEmpty,
      clear,
      setContent,
      insertImageAttachments,
      removeImageAttachmentById,
      insertDictatedText,
      dismissActiveSuggestion,
    }),
    [
      clear,
      dismissActiveSuggestion,
      focus,
      focusAtEnd,
      getJSON,
      insertImageAttachments,
      insertDictatedText,
      isEmpty,
      removeImageAttachmentById,
      setContent,
    ],
  );

  if (editor === null) return null;

  return (
    <EditorContent
      editor={editor}
      className="relative flex-1"
      onPaste={onPaste}
      onDragOver={onDragOver}
      onDrop={onDrop}
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
