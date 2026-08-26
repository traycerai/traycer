/**
 * Keyboard-summoning contract for the composer editor.
 *
 * On the installed mobile app a software keyboard costs half the screen, so it
 * must be summoned by a tap and never by a composer mounting active. On
 * desktop the same mount takes the caret, because a hardware keyboard makes
 * that free.
 *
 * The assertion is on ProseMirror's `EditorView.focus` - the single funnel for
 * both routes into the editor (Tiptap's `autofocus` option and the composer
 * focus registry) - because jsdom does not focus a contenteditable node, so
 * `editor.isFocused` reads false even where production would have raised the
 * keyboard.
 */
import { useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { EditorView } from "@tiptap/pm/view";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { setMobileApp } from "@/lib/mobile-app";
import { ComposerPromptEditor } from "../composer-prompt-editor";
import type { ComposerPromptEditorHandle } from "../composer-prompt-editor";
import { createComposerPickerStore } from "../picker/composer-picker-store";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setMobileApp(false);
});

function emptyDoc(): JsonContent {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

interface HarnessProps {
  readonly handleRef: { current: ComposerPromptEditorHandle | null };
  readonly isActive: boolean;
}

function Harness(props: HarnessProps) {
  const { handleRef, isActive } = props;
  const [pickerStore] = useState(() => createComposerPickerStore());
  return (
    <ComposerPromptEditor
      ref={(instance) => {
        handleRef.current = instance;
      }}
      initialContent={emptyDoc()}
      initialSelection={null}
      pickerStore={pickerStore}
      placeholder="mobile-autofocus"
      editorClassName={undefined}
      isActive={isActive}
      disabled={false}
      slashProviderId="claude"
      hasPastedImageBytes={null}
      ingestPastedComposerImages={null}
      stabilizeImageAttachmentCaret={false}
      onDocumentChange={() => undefined}
      onSelectionChange={() => undefined}
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

interface MountedComposer {
  readonly handleRef: { current: ComposerPromptEditorHandle | null };
  readonly viewFocus: MockInstance;
}

// Tiptap defers the actual `view.focus()` to an animation frame, so settling
// the editor means letting frames run, not just draining microtasks.
async function settleEditor(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

async function mountComposer(isActive: boolean): Promise<MountedComposer> {
  const viewFocus = vi.spyOn(EditorView.prototype, "focus");
  const handleRef: { current: ComposerPromptEditorHandle | null } = {
    current: null,
  };
  render(<Harness handleRef={handleRef} isActive={isActive} />);
  await settleEditor();
  return { handleRef, viewFocus };
}

function readyHandle(mounted: MountedComposer): ComposerPromptEditorHandle {
  const handle = mounted.handleRef.current;
  if (handle === null) throw new Error("editor handle missing");
  if (!handle.isReady()) throw new Error("editor never became ready");
  return handle;
}

describe("ComposerPromptEditor autofocus vs the mobile app", () => {
  it("takes the caret on mount when active off the mobile app", async () => {
    setMobileApp(false);
    const mounted = await mountComposer(true);

    readyHandle(mounted);
    expect(mounted.viewFocus).toHaveBeenCalled();
  });

  it("leaves the caret alone on mount when active on the mobile app", async () => {
    setMobileApp(true);
    const mounted = await mountComposer(true);

    readyHandle(mounted);
    expect(mounted.viewFocus).not.toHaveBeenCalled();
  });

  it("still focuses on the mobile app when the user asks for it", async () => {
    setMobileApp(true);
    const mounted = await mountComposer(true);
    const handle = readyHandle(mounted);

    // Cleared so the assertion pins the explicit request itself - without
    // this, a regression that re-enables mount autofocus would satisfy the
    // final expectation before focusAtEnd ever ran.
    mounted.viewFocus.mockClear();
    act(() => {
      handle.focusAtEnd();
    });
    await settleEditor();

    expect(mounted.viewFocus).toHaveBeenCalled();
  });

  it("leaves an inactive composer alone off the mobile app too", async () => {
    setMobileApp(false);
    const mounted = await mountComposer(false);

    readyHandle(mounted);
    expect(mounted.viewFocus).not.toHaveBeenCalled();
  });
});
