/**
 * Shared fake `ComposerPromptEditorHandle` for tests.
 *
 * The production handle now requires both `setContent` (emit update) and
 * `syncContent` (silent apply). Tests that hand-rolled incomplete object
 * literals broke when `syncContent` was added - use this factory instead of
 * scattering partial fixtures.
 */
import { vi, type Mock } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ComposerPromptEditorHandle } from "../composer-prompt-editor";

export type FakeEditorSelection = {
  readonly from: number;
  readonly to: number;
};

export const EMPTY_COMPOSER_DOC: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

export interface FakeComposerPromptEditorHandleOptions {
  readonly ready: boolean;
  readonly content: JsonContent;
  readonly selection: FakeEditorSelection | null;
  readonly isEmpty: boolean | (() => boolean);
  readonly onFocus: (() => void) | null;
  readonly onClear: (() => void) | null;
}

export type ContentMutator = (
  content: JsonContent,
  selection: FakeEditorSelection | null,
) => void;

export interface FakeComposerPromptEditorHandleResult {
  readonly handle: ComposerPromptEditorHandle;
  readonly setContent: Mock<ContentMutator>;
  readonly syncContent: Mock<ContentMutator>;
  readonly markReady: (ready: boolean) => void;
  readonly setReady: (ready: boolean) => void;
  readonly getContent: () => JsonContent;
  readonly getSelectionValue: () => FakeEditorSelection | null;
  readonly editorRef: { current: ComposerPromptEditorHandle | null };
  /** Replace the handle under the same ref (remount simulation). */
  readonly rebuild: () => ComposerPromptEditorHandle;
  readonly setContents: Array<{
    content: JsonContent;
    selection: FakeEditorSelection | null;
    mode: "set" | "sync";
  }>;
  readonly clears: number[];
  readonly focuses: number[];
}

export function createFakeComposerPromptEditorHandle(
  options: FakeComposerPromptEditorHandleOptions,
): FakeComposerPromptEditorHandleResult {
  let ready = options.ready;
  let content = options.content;
  let selection: FakeEditorSelection | null = options.selection;
  const setContents: Array<{
    content: JsonContent;
    selection: FakeEditorSelection | null;
    mode: "set" | "sync";
  }> = [];
  const clears: number[] = [];
  const focuses: number[] = [];

  const applyContent = (
    next: JsonContent,
    nextSelection: FakeEditorSelection | null,
    mode: "set" | "sync",
  ): void => {
    content = next;
    selection = nextSelection;
    setContents.push({ content: next, selection: nextSelection, mode });
  };

  const setContent: Mock<ContentMutator> = vi.fn((next, nextSelection) => {
    applyContent(next, nextSelection, "set");
  });
  const syncContent: Mock<ContentMutator> = vi.fn((next, nextSelection) => {
    applyContent(next, nextSelection, "sync");
  });

  const buildHandle = (): ComposerPromptEditorHandle => ({
    isReady: () => ready,
    hasFocus: () => false,
    focus: () => {
      focuses.push(1);
      options.onFocus?.();
    },
    focusAtEnd: () => undefined,
    getJSON: () => content,
    isEmpty: () => {
      if (typeof options.isEmpty === "function") return options.isEmpty();
      return options.isEmpty;
    },
    clear: () => {
      clears.push(1);
      content = EMPTY_COMPOSER_DOC;
      selection = null;
      options.onClear?.();
    },
    setContent,
    syncContent,
    insertImageAttachments: () => undefined,
    beginPathInsertion: () => null,
    removeImageAttachmentById: () => undefined,
    rewriteImageAttachmentHashById: () => false,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  });

  const handle = buildHandle();
  const editorRef: { current: ComposerPromptEditorHandle | null } = {
    current: handle,
  };

  return {
    handle,
    setContent,
    syncContent,
    markReady: (next) => {
      ready = next;
    },
    setReady: (next) => {
      ready = next;
    },
    getContent: () => content,
    getSelectionValue: () => selection,
    editorRef,
    rebuild: () => {
      ready = true;
      const next = buildHandle();
      editorRef.current = next;
      return next;
    },
    setContents,
    clears,
    focuses,
  };
}

/**
 * Minimal complete handle for prompt-based submit-gate fixtures that only
 * care about `getJSON` / `isEmpty` return values.
 */
export function createPromptTextEditorHandle(
  prompt: string,
): ComposerPromptEditorHandle {
  const content: JsonContent =
    prompt.length === 0
      ? EMPTY_COMPOSER_DOC
      : {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: prompt }],
            },
          ],
        };
  return createFakeComposerPromptEditorHandle({
    content,
    ready: true,
    selection: null,
    isEmpty: prompt.length === 0,
    onFocus: null,
    onClear: null,
  }).handle;
}
