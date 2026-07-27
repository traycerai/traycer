import "../../../../../__tests__/test-browser-apis";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../composer-prompt-editor";
import {
  createComposerPickerStore,
  type ComposerPickerStore,
} from "../picker/composer-picker-store";

afterEach(() => {
  cleanup();
});

/**
 * Exercises `insertPathSpansCommand` (via `ComposerPromptEditorHandle.
 * beginPathInsertion`'s commit closure) against the real TipTap editor /
 * ProseMirror doc used by every composer surface, rather than a mocked
 * editor handle - a fully mocked handle would hide real insertion-order,
 * mark, and undo-step bugs.
 */
describe("insertPathSpansCommand via the real composer editor", () => {
  it("inserts a single path as an inline-code span followed by a trailing plain space", async () => {
    const handleRef = await mountedHandle();

    act(() => {
      handleRef.current?.beginPathInsertion()?.(["src/app.ts"]);
    });

    expect(pathSpanRuns(handleRef.current)).toEqual([
      { text: "src/app.ts", code: true },
      { text: " ", code: false },
    ]);
    const codeEl = screen.getByText("src/app.ts");
    expect(codeEl.tagName).toBe("CODE");
  });

  it("inserts multiple paths as separate code spans joined by plain spaces", async () => {
    const handleRef = await mountedHandle();

    act(() => {
      handleRef.current?.beginPathInsertion()?.(["a.ts", "nested/b.ts"]);
    });

    expect(pathSpanRuns(handleRef.current)).toEqual([
      { text: "a.ts", code: true },
      { text: " ", code: false },
      { text: "nested/b.ts", code: true },
      { text: " ", code: false },
    ]);
    expect(
      screen.getAllByText((_content, element) => element?.tagName === "CODE"),
    ).toHaveLength(2);
  });

  it("preserves a selection and inserts at its caret end", async () => {
    const handleRef = await mountedHandle();

    act(() => {
      handleRef.current?.setContent(paragraphText("abcdef"), {
        from: 2,
        to: 5,
      });
      handleRef.current?.beginPathInsertion()?.(["src/app.ts"]);
    });

    expect(composerText(handleRef.current)).toBe("abcdsrc/app.ts ef");
    expect(pathSpanRuns(handleRef.current)).toContainEqual({
      text: "src/app.ts",
      code: true,
    });
  });

  it("does nothing for an empty path list", async () => {
    const handleRef = await mountedHandle();
    const before = handleRef.current?.getJSON();

    act(() => {
      handleRef.current?.beginPathInsertion()?.([]);
    });

    expect(handleRef.current?.getJSON()).toEqual(before);
  });

  it("undoes a multi-path insertion in a single step", async () => {
    const handleRef = await mountedHandle();
    const before = handleRef.current?.getJSON();

    act(() => {
      handleRef.current?.beginPathInsertion()?.(["a.ts", "b.ts"]);
    });
    expect(handleRef.current?.isEmpty()).toBe(false);

    const editorDom = screen.getByTestId("composer-editor");
    fireEvent.keyDown(editorDom, { key: "z", code: "KeyZ", ctrlKey: true });

    // A single undo fully reverts the insertion - proof it was dispatched as
    // one ProseMirror transaction (one chain().insertContent(...).unsetMark(
    // "code").run() call), not one transaction per span.
    expect(handleRef.current?.getJSON()).toEqual(before);
  });
});

async function mountedHandle(): Promise<{
  readonly current: ComposerPromptEditorHandle | null;
}> {
  const handleRef: { current: ComposerPromptEditorHandle | null } = {
    current: null,
  };
  render(<Harness handleRef={handleRef} />);
  await waitFor(() => {
    expect(handleRef.current?.isReady()).toBe(true);
  });
  return handleRef;
}

function Harness({
  handleRef,
}: {
  readonly handleRef: { current: ComposerPromptEditorHandle | null };
}) {
  const [pickerStore] = useState<ComposerPickerStore>(() =>
    createComposerPickerStore(),
  );
  const setHandle = (instance: ComposerPromptEditorHandle | null): void => {
    handleRef.current = instance;
  };
  return (
    <ComposerPromptEditor
      ref={setHandle}
      initialContent={emptyContent()}
      initialSelection={null}
      pickerStore={pickerStore}
      placeholder="test"
      editorClassName={undefined}
      isActive={false}
      disabled={false}
      slashProviderId="claude"
      hasPastedImageBytes={null}
      stabilizeImageAttachmentCaret={false}
      onSnapshot={() => undefined}
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

function emptyContent(): JsonContent {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

function paragraphText(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function composerText(handle: ComposerPromptEditorHandle | null): string {
  const content = handle?.getJSON();
  return (content?.content ?? [])
    .flatMap((paragraph) => paragraph.content ?? [])
    .map((node) => node.text ?? "")
    .join("");
}

interface PathSpanRun {
  readonly text: string;
  readonly code: boolean;
}

function pathSpanRuns(
  handle: ComposerPromptEditorHandle | null,
): PathSpanRun[] {
  const content = handle?.getJSON();
  const paragraph = content?.content?.[0];
  return (paragraph?.content ?? []).flatMap((node) => {
    if (node.type !== "text") return [];
    const marks = node.marks ?? [];
    return [
      {
        text: node.text ?? "",
        code: marks.some((mark) => mark.type === "code"),
      },
    ];
  });
}
