/**
 * Ticket 2 - editor-boundary contract.
 *
 * `ComposerPromptEditor` splits Tiptap's document-change `update` event from
 * selection-only `selectionUpdate`. Selection must never call `getJSON()`
 * (documents can carry multi-megabyte inline images).
 */
import { useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { ComposerPromptEditor } from "../composer-prompt-editor";
import type { ComposerPromptEditorHandle } from "../composer-prompt-editor";
import { createComposerPickerStore } from "../picker/composer-picker-store";

afterEach(() => {
  cleanup();
});

function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function emptyDoc(): JsonContent {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

interface HarnessProps {
  readonly handleRef: { current: ComposerPromptEditorHandle | null };
  readonly onDocumentChange: (
    content: JsonContent,
    selection: { from: number; to: number },
  ) => void;
  readonly onSelectionChange: (selection: { from: number; to: number }) => void;
  readonly initialContent: JsonContent;
  readonly initialSelection: { from: number; to: number } | null;
}

function Harness(props: HarnessProps) {
  const {
    handleRef,
    onDocumentChange,
    onSelectionChange,
    initialContent,
    initialSelection,
  } = props;
  const [pickerStore] = useState(() => createComposerPickerStore());
  return (
    <ComposerPromptEditor
      ref={(instance) => {
        handleRef.current = instance;
      }}
      initialContent={initialContent}
      initialSelection={initialSelection}
      pickerStore={pickerStore}
      placeholder="revision-contract"
      editorClassName={undefined}
      isActive={false}
      disabled={false}
      slashProviderId="claude"
      hasPastedImageBytes={null}
      ingestPastedComposerImages={null}
      stabilizeImageAttachmentCaret={false}
      onDocumentChange={onDocumentChange}
      onSelectionChange={onSelectionChange}
      onSubmit={() => undefined}
      onPaste={() => undefined}
      onDragOver={() => undefined}
      onDrop={() => undefined}
      onKeyDown={undefined}
      onFocus={() => undefined}
      onBlur={() => undefined}
      onEditorReady={null}
    />
  );
}

async function flushEditor(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ComposerPromptEditor document vs selection contract", () => {
  it("keeps one incarnation for the Tiptap editor and changes it on remount", async () => {
    const onDocumentChange = vi.fn();
    const onSelectionChange = vi.fn();
    const handleRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };
    const initialContent = emptyDoc();

    const mounted = render(
      <Harness
        handleRef={handleRef}
        onDocumentChange={onDocumentChange}
        onSelectionChange={onSelectionChange}
        initialContent={initialContent}
        initialSelection={null}
      />,
    );
    await flushEditor();

    const firstHandle = handleRef.current;
    if (firstHandle === null) throw new Error("editor handle missing");
    const firstIncarnation = firstHandle.getEditorIncarnation();
    expect(firstIncarnation).not.toBeNull();

    // This suite runs through the same React Compiler preset as production.
    // A render may replace the imperative facade, but not the Tiptap Editor.
    mounted.rerender(
      <Harness
        handleRef={handleRef}
        onDocumentChange={onDocumentChange}
        onSelectionChange={onSelectionChange}
        initialContent={textDoc("new prop, same mounted editor")}
        initialSelection={null}
      />,
    );
    await flushEditor();

    const rerenderedHandle = handleRef.current;
    if (rerenderedHandle === null) throw new Error("editor handle missing");
    expect(rerenderedHandle).not.toBe(firstHandle);
    expect(rerenderedHandle.getEditorIncarnation()).toBe(firstIncarnation);

    mounted.unmount();
    render(
      <Harness
        handleRef={handleRef}
        onDocumentChange={onDocumentChange}
        onSelectionChange={onSelectionChange}
        initialContent={initialContent}
        initialSelection={null}
      />,
    );
    await flushEditor();

    const remountedHandle = handleRef.current;
    if (remountedHandle === null) throw new Error("editor handle missing");
    expect(remountedHandle.getEditorIncarnation()).not.toBe(firstIncarnation);
  });

  it("fires onDocumentChange for a real document mutation", async () => {
    const onDocumentChange = vi.fn();
    const onSelectionChange = vi.fn();
    const handleRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };

    render(
      <Harness
        handleRef={handleRef}
        onDocumentChange={onDocumentChange}
        onSelectionChange={onSelectionChange}
        initialContent={emptyDoc()}
        initialSelection={null}
      />,
    );
    await flushEditor();

    const handle = handleRef.current;
    expect(handle).not.toBeNull();
    if (handle === null) throw new Error("editor handle missing");

    onDocumentChange.mockClear();
    onSelectionChange.mockClear();

    act(() => {
      handle.insertDictatedText("typed");
    });

    expect(onDocumentChange).toHaveBeenCalled();
    const lastCall = onDocumentChange.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    if (lastCall === undefined)
      throw new Error("expected document-change call");
    const content = lastCall[0] as JsonContent;
    expect(JSON.stringify(content)).toContain("typed");
  });

  it("fires only onSelectionChange for a pure caret move (no getJSON)", async () => {
    const onDocumentChange = vi.fn();
    const onSelectionChange = vi.fn();
    const handleRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };
    const initial = textDoc("hello world");

    render(
      <Harness
        handleRef={handleRef}
        onDocumentChange={onDocumentChange}
        onSelectionChange={onSelectionChange}
        initialContent={initial}
        initialSelection={{ from: 1, to: 1 }}
      />,
    );
    await flushEditor();

    const handle = handleRef.current;
    expect(handle).not.toBeNull();
    if (handle === null) throw new Error("editor handle missing");

    // Baseline after mount / initial selection apply.
    onDocumentChange.mockClear();
    onSelectionChange.mockClear();

    const getJSONSpy = vi.spyOn(Editor.prototype, "getJSON");
    const getJSONBefore = getJSONSpy.mock.calls.length;

    // Move the caret without changing the document. `syncContent` applies
    // with emitUpdate:false (no onDocumentChange) then setTextSelection
    // (onSelectionChange only).
    for (let i = 0; i < 10; i += 1) {
      const from = 1 + (i % 5);
      act(() => {
        handle.syncContent(initial, { from, to: from });
      });
    }

    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(onSelectionChange).toHaveBeenCalled();
    // Selection-only path must never serialize the document.
    expect(getJSONSpy.mock.calls.length).toBe(getJSONBefore);

    getJSONSpy.mockRestore();
  });

  it("syncContent suppresses onDocumentChange even when content genuinely changes", async () => {
    // The two tests above only ever pass `syncContent` UNCHANGED content, so
    // a passing result there is also consistent with a broken/inverted
    // `emitUpdate` flag - Tiptap's own `prevState.doc.eq(state.doc)` gate
    // would independently suppress `update` for a no-op replace regardless of
    // what `emitUpdate` says. This test replaces the document with something
    // genuinely different (mirroring the chat resetEpoch bridge restoring
    // different content) to isolate the `emitUpdate:false` mechanism itself.
    const onDocumentChange = vi.fn();
    const onSelectionChange = vi.fn();
    const handleRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };

    render(
      <Harness
        handleRef={handleRef}
        onDocumentChange={onDocumentChange}
        onSelectionChange={onSelectionChange}
        initialContent={textDoc("original")}
        initialSelection={{ from: 1, to: 1 }}
      />,
    );
    await flushEditor();

    const handle = handleRef.current;
    expect(handle).not.toBeNull();
    if (handle === null) throw new Error("editor handle missing");

    onDocumentChange.mockClear();
    onSelectionChange.mockClear();

    act(() => {
      handle.syncContent(textDoc("replaced entirely"), { from: 2, to: 2 });
    });

    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(onSelectionChange).toHaveBeenCalled();
    const serialized = JSON.stringify(handle.getJSON());
    expect(serialized).toContain("replaced entirely");
    expect(serialized).not.toContain("original");
  });

  it("does not call getJSON across repeated selection-only moves on large docs", async () => {
    const largeB64 = "A".repeat(2 * 1024 * 1024);
    const largeDoc: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "imageAttachment",
              attrs: {
                id: "img-large",
                fileName: "large.png",
                b64content: largeB64,
                hash: null,
                mimeType: "image/png",
                size: largeB64.length,
              },
            },
            { type: "text", text: " caption" },
          ],
        },
      ],
    };

    const onDocumentChange = vi.fn();
    const onSelectionChange = vi.fn();
    const handleRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };

    render(
      <Harness
        handleRef={handleRef}
        onDocumentChange={onDocumentChange}
        onSelectionChange={onSelectionChange}
        initialContent={largeDoc}
        initialSelection={{ from: 1, to: 1 }}
      />,
    );
    await flushEditor();

    const handle = handleRef.current;
    expect(handle).not.toBeNull();
    if (handle === null) throw new Error("editor handle missing");

    onDocumentChange.mockClear();
    onSelectionChange.mockClear();

    const getJSONSpy = vi.spyOn(Editor.prototype, "getJSON");
    const before = getJSONSpy.mock.calls.length;

    for (let i = 0; i < 20; i += 1) {
      const from = 1 + (i % 3);
      act(() => {
        handle.syncContent(largeDoc, { from, to: from });
      });
    }

    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(onSelectionChange.mock.calls.length).toBeGreaterThan(0);
    expect(getJSONSpy.mock.calls.length).toBe(before);

    getJSONSpy.mockRestore();
  });
});
