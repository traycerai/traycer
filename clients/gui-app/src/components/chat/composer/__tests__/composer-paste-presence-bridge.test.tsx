import "../../../../../__tests__/test-browser-apis";
import { createRef, useState, type RefObject } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  buildComposerClipboardHtml,
  composerClipboardPlainText,
} from "@/lib/composer/composer-clipboard";
import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";

const mocks = vi.hoisted(() => ({
  reportableErrorToast: vi.fn(),
}));

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: mocks.reportableErrorToast,
}));

afterEach(() => {
  cleanup();
  mocks.reportableErrorToast.mockClear();
});

describe("ComposerPromptEditor pasted-image presence bridge", () => {
  it("uses the latest nullable presence predicate without rebuilding the editor", async () => {
    const handleRef = createRef<ComposerPromptEditorHandle>();
    const checker = (hash: string): boolean => hash.startsWith("present-");
    const view = render(
      <BridgeHarness handleRef={handleRef} hasPastedImageBytes={null} />,
    );
    const editor = await screen.findByRole("textbox", { name: "test" });

    pasteHashImage(editor, "early-image", "early-hash");
    expect(imageIds(handleRef)).toEqual(["early-image"]);
    expect(mocks.reportableErrorToast).not.toHaveBeenCalled();

    view.rerender(
      <BridgeHarness handleRef={handleRef} hasPastedImageBytes={checker} />,
    );
    pasteHashImage(editor, "missing-image", "missing-hash");
    pasteHashImage(editor, "present-image", "present-hash");
    expect(imageIds(handleRef)).toEqual(["early-image", "present-image"]);
    expect(mocks.reportableErrorToast).toHaveBeenCalledTimes(1);

    view.rerender(
      <BridgeHarness handleRef={handleRef} hasPastedImageBytes={null} />,
    );
    pasteHashImage(editor, "reset-image", "reset-hash");
    expect(imageIds(handleRef)).toEqual([
      "early-image",
      "present-image",
      "reset-image",
    ]);
    expect(mocks.reportableErrorToast).toHaveBeenCalledTimes(1);

    view.rerender(
      <BridgeHarness handleRef={handleRef} hasPastedImageBytes={checker} />,
    );
    pasteHashImage(editor, "missing-image-2", "missing-hash-2");
    pasteHashImage(editor, "present-image-2", "present-hash-2");
    expect(imageIds(handleRef)).toEqual([
      "early-image",
      "present-image",
      "reset-image",
      "present-image-2",
    ]);
    expect(mocks.reportableErrorToast).toHaveBeenCalledTimes(2);
  });
});

function BridgeHarness({
  handleRef,
  hasPastedImageBytes,
}: {
  readonly handleRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly hasPastedImageBytes: ((hash: string) => boolean) | null;
}) {
  const [pickerStore] = useState(() => createComposerPickerStore());
  const setHandle = (handle: ComposerPromptEditorHandle | null): void => {
    handleRef.current = handle;
  };
  return (
    <ComposerPromptEditor
      ref={setHandle}
      initialContent={{ type: "doc", content: [{ type: "paragraph" }] }}
      initialSelection={null}
      pickerStore={pickerStore}
      placeholder="test"
      editorClassName={undefined}
      isActive={false}
      disabled={false}
      slashProviderId="claude"
      hasPastedImageBytes={hasPastedImageBytes}
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

function pasteHashImage(element: HTMLElement, id: string, hash: string): void {
  const content = hashImageContent(id, hash);
  const html = buildComposerClipboardHtml(
    content,
    composerClipboardPlainText(content),
  );
  fireEvent.paste(element, {
    clipboardData: {
      files: [],
      items: [],
      types: ["text/html"],
      getData: (type: string) => (type === "text/html" ? html : ""),
    },
  });
}

function hashImageContent(id: string, hash: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id,
              fileName: `${id}.png`,
              b64content: null,
              hash,
              mimeType: "image/png",
              size: 3,
            },
          },
        ],
      },
    ],
  };
}

function imageIds(
  handleRef: RefObject<ComposerPromptEditorHandle | null>,
): string[] {
  const ids: string[] = [];
  handleRef.current?.getJSON().content?.forEach((block) => {
    block.content?.forEach((node) => {
      if (node.type !== "imageAttachment") return;
      const id = node.attrs?.id;
      if (typeof id === "string") ids.push(id);
    });
  });
  return ids;
}
