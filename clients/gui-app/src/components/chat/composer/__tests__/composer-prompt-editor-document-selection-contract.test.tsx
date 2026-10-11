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
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { ComposerPromptEditor } from "../composer-prompt-editor";
import type { ComposerPromptEditorHandle } from "../composer-prompt-editor";
import { createComposerPickerStore } from "../picker/composer-picker-store";
import { changedComposerImages } from "../composer-image-changes";

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
    changedImages: JsonContent | null,
  ) => void;
  readonly onSelectionChange: (selection: { from: number; to: number }) => void;
  readonly initialContent: JsonContent;
  readonly initialSelection: { from: number; to: number } | null;
  readonly placeholder: string;
  readonly disabled: boolean;
}

function Harness(props: HarnessProps) {
  const {
    handleRef,
    onDocumentChange,
    onSelectionChange,
    initialContent,
    initialSelection,
    placeholder,
    disabled,
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
      placeholder={placeholder}
      editorClassName={undefined}
      isActive={false}
      disabled={disabled}
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
        placeholder="revision-contract"
        disabled={false}
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
        placeholder="revision-contract"
        disabled={false}
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
        placeholder="revision-contract"
        disabled={false}
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
        placeholder="revision-contract"
        disabled={false}
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
        placeholder="revision-contract"
        disabled={false}
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
        placeholder="revision-contract"
        disabled={false}
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
        placeholder="revision-contract"
        disabled={false}
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

// Ticket W2-F: `onDocumentChange`'s third argument (`changedImages`) exists so
// the chat/inline-edit ingest callers can scan only the images this
// transaction actually touched instead of re-scanning the whole document on
// every keystroke (see `composer-image-changes.ts`). These pin the boundary
// contract; the ingest-side consumer is pinned in
// `chat-composer-reingest-on-host-document.test.tsx`.
describe("ComposerPromptEditor onDocumentChange third argument: changed images only", () => {
  function imageAttrs(id: string): {
    readonly id: string;
    readonly fileName: string;
    readonly mimeType: string;
    readonly size: number;
    readonly byHashEligible: boolean;
    readonly hash: string;
  } {
    return {
      id,
      fileName: `${id}.png`,
      mimeType: "image/png",
      size: 10,
      byHashEligible: false,
      hash: `hash-${id}`,
    };
  }

  function docWithLeadingImageAndText(
    imageId: string,
    text: string,
  ): JsonContent {
    return {
      type: "doc",
      content: [
        { type: "imageAttachment", attrs: imageAttrs(imageId) },
        { type: "paragraph", content: [{ type: "text", text }] },
      ],
    };
  }

  it("carries only the image this transaction inserted, excluding a pre-existing one", async () => {
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
        initialContent={docWithLeadingImageAndText("img-existing", "hello")}
        initialSelection={null}
        placeholder="revision-contract"
        disabled={false}
      />,
    );
    await flushEditor();

    const handle = handleRef.current;
    expect(handle).not.toBeNull();
    if (handle === null) throw new Error("editor handle missing");

    act(() => {
      handle.focusAtEnd();
    });
    onDocumentChange.mockClear();

    act(() => {
      handle.insertImageAttachments([imageAttrs("img-new")]);
    });

    expect(onDocumentChange).toHaveBeenCalled();
    const lastCall = onDocumentChange.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    if (lastCall === undefined)
      throw new Error("expected document-change call");
    const changedImages = lastCall[2] as JsonContent | null;
    expect(changedImages).not.toBeNull();
    if (changedImages === null) throw new Error("expected changed images");
    const ids = (changedImages.content ?? []).map(
      (node) => (node.attrs as { id: string }).id,
    );
    expect(ids).toEqual(["img-new"]);
  });

  it("is null for a text-only edit in a document that already has an image", async () => {
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
        initialContent={docWithLeadingImageAndText("img-existing", "hello")}
        initialSelection={null}
        placeholder="revision-contract"
        disabled={false}
      />,
    );
    await flushEditor();

    const handle = handleRef.current;
    expect(handle).not.toBeNull();
    if (handle === null) throw new Error("editor handle missing");

    act(() => {
      handle.focusAtEnd();
    });
    onDocumentChange.mockClear();

    act(() => {
      handle.insertDictatedText("more");
    });

    expect(onDocumentChange).toHaveBeenCalled();
    const lastCall = onDocumentChange.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    if (lastCall === undefined)
      throw new Error("expected document-change call");
    expect(lastCall[2]).toBeNull();
  });
});

// `changedComposerImages` combines the root transaction's mapping with every
// APPENDED transaction's before scanning - a caller that only mapped through
// the root (or skipped the append step) would scan the inserted image's
// STALE post-root position once a later transaction shifts it again. A real
// editor's `onUpdate` only ever hands this a single un-appended transaction
// for a plain insert, so that path alone cannot catch a regression here; this
// builds a minimal real `Schema`/`EditorState`/`Transaction` chain instead of
// faking transform internals, to pin the two-step mapping directly.
describe("changedComposerImages: multi-transaction position mapping", () => {
  const imageChangesSchema = new Schema({
    nodes: {
      doc: { content: "paragraph+" },
      paragraph: { content: "inline*", group: "block" },
      text: { group: "inline" },
      imageAttachment: {
        group: "inline",
        inline: true,
        atom: true,
        attrs: { id: {} },
      },
    },
  });

  function imageIds(result: JsonContent | null): string[] {
    if (result === null) return [];
    return (result.content ?? []).map(
      (node) => (node.attrs as { id: string }).id,
    );
  }

  function stateWithOldImage() {
    const { nodes } = imageChangesSchema;
    const oldImage = nodes.imageAttachment.create({ id: "old" });
    const initialDoc = nodes.doc.create(null, [
      nodes.paragraph.create(null, [oldImage]),
    ]);
    return EditorState.create({ schema: imageChangesSchema, doc: initialDoc });
  }

  it("maps the inserted image through a later transaction instead of its stale post-root position", () => {
    const initialState = stateWithOldImage();
    const newImage = imageChangesSchema.nodes.imageAttachment.create({
      id: "new",
    });
    // Root: insert the new image at the start of the paragraph, before "old".
    const root = initialState.tr.insert(1, newImage);
    const stateAfterRoot = initialState.apply(root);

    // Appended: insert prefix text at the same position, shifting the image
    // (and "old" behind it) further into the document. Using the image's
    // post-root position directly against the FINAL doc would land on this
    // prefix text instead.
    const appended = stateAfterRoot.tr.insertText("hi", 1);
    const finalState = stateAfterRoot.apply(appended);

    const result = changedComposerImages(finalState.doc, [root, appended]);
    expect(imageIds(result)).toEqual(["new"]);
  });

  it("returns null when a later transaction deletes the image the root transaction inserted", () => {
    const initialState = stateWithOldImage();
    const newImage = imageChangesSchema.nodes.imageAttachment.create({
      id: "new",
    });
    const root = initialState.tr.insert(1, newImage);
    const stateAfterRoot = initialState.apply(root);

    const appended = stateAfterRoot.tr.delete(1, 2);
    const finalState = stateAfterRoot.apply(appended);

    const result = changedComposerImages(finalState.doc, [root, appended]);
    expect(result).toBeNull();
  });
});

// Ticket W2-F: the manual `editor.view.dom.setAttribute` effect and the
// unconditional `editor.view.dispatch(editor.state.tr)` poke on every
// placeholder-deps run were removed as redundant with `editorProps.attributes`
// (Tiptap applies those on creation and on every options sync) and with a
// ref-gated "did the text actually change" check. Both mechanisms still need
// to produce the same placeholder decoration a viewer sees; these tests pin
// that at the component boundary rather than at the removed effects.
function placeholderDecorationText(container: HTMLElement): string | null {
  const node = container.querySelector(
    "[data-composer-editor] p[data-placeholder]",
  );
  return node === null ? null : node.getAttribute("data-placeholder");
}

function composerContentEditable(container: HTMLElement): string | null {
  return (
    container
      .querySelector("[data-composer-editor]")
      ?.getAttribute("contenteditable") ?? null
  );
}

describe("ComposerPromptEditor placeholder decoration and disabled editability", () => {
  it("shows the initial placeholder without waiting for an extra transaction", async () => {
    const handleRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };

    const { container } = render(
      <Harness
        handleRef={handleRef}
        onDocumentChange={vi.fn()}
        onSelectionChange={vi.fn()}
        initialContent={emptyDoc()}
        initialSelection={null}
        placeholder="initial hint"
        disabled={false}
      />,
    );
    await flushEditor();

    expect(placeholderDecorationText(container)).toBe("initial hint");
  });

  it("updates the empty-state placeholder decoration when the prop changes", async () => {
    const handleRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };

    const view = render(
      <Harness
        handleRef={handleRef}
        onDocumentChange={vi.fn()}
        onSelectionChange={vi.fn()}
        initialContent={emptyDoc()}
        initialSelection={null}
        placeholder="first hint"
        disabled={false}
      />,
    );
    await flushEditor();
    expect(placeholderDecorationText(view.container)).toBe("first hint");

    view.rerender(
      <Harness
        handleRef={handleRef}
        onDocumentChange={vi.fn()}
        onSelectionChange={vi.fn()}
        initialContent={emptyDoc()}
        initialSelection={null}
        placeholder="second hint"
        disabled={false}
      />,
    );
    await flushEditor();

    expect(placeholderDecorationText(view.container)).toBe("second hint");
  });

  it("toggles editability on a disabled change without emitting a document update", async () => {
    const onDocumentChange = vi.fn();
    const handleRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };

    const view = render(
      <Harness
        handleRef={handleRef}
        onDocumentChange={onDocumentChange}
        onSelectionChange={vi.fn()}
        initialContent={textDoc("hello")}
        initialSelection={null}
        placeholder="hint"
        disabled={false}
      />,
    );
    await flushEditor();
    onDocumentChange.mockClear();

    view.rerender(
      <Harness
        handleRef={handleRef}
        onDocumentChange={onDocumentChange}
        onSelectionChange={vi.fn()}
        initialContent={textDoc("hello")}
        initialSelection={null}
        placeholder="hint"
        disabled
      />,
    );
    await flushEditor();

    expect(composerContentEditable(view.container)).toBe("false");
    expect(onDocumentChange).not.toHaveBeenCalled();

    view.rerender(
      <Harness
        handleRef={handleRef}
        onDocumentChange={onDocumentChange}
        onSelectionChange={vi.fn()}
        initialContent={textDoc("hello")}
        initialSelection={null}
        placeholder="hint"
        disabled={false}
      />,
    );
    await flushEditor();

    expect(composerContentEditable(view.container)).toBe("true");
    expect(onDocumentChange).not.toHaveBeenCalled();
  });
});
