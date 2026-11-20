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
import { Transaction } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { setMobileApp } from "@/lib/mobile-app";
import { ComposerPromptEditor } from "../composer-prompt-editor";
import type { ComposerPromptEditorHandle } from "../composer-prompt-editor";
import { createComposerPickerStore } from "../picker/composer-picker-store";

function invoke(fn: unknown, self: object, args: readonly unknown[]): void {
  if (typeof fn !== "function") throw new Error("not a function");
  Reflect.apply(fn, self, args);
}

const queuedFrames: FrameRequestCallback[] = [];

afterEach(() => {
  queuedFrames.length = 0;
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
      interceptKeyDown={null}
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

// Mount autofocus queues `view.focus()` on an animation frame. The queue is
// flushed here, so the wait is the frame the editor scheduled, not a timer.
function flushQueuedFrames(): void {
  act(() => {
    for (let pass = 0; pass < 3 && queuedFrames.length > 0; pass += 1) {
      const pending = queuedFrames.splice(0, queuedFrames.length);
      for (const frame of pending) frame(performance.now());
    }
  });
}

function settleEditor(): void {
  flushQueuedFrames();
}

function mountComposer(isActive: boolean): MountedComposer {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    queuedFrames.push(callback);
    return queuedFrames.length;
  });
  const viewFocus = vi.spyOn(EditorView.prototype, "focus");
  const handleRef: { current: ComposerPromptEditorHandle | null } = {
    current: null,
  };
  render(<Harness handleRef={handleRef} isActive={isActive} />);
  settleEditor();
  return { handleRef, viewFocus };
}

function readyHandle(mounted: MountedComposer): ComposerPromptEditorHandle {
  const handle = mounted.handleRef.current;
  if (handle === null) throw new Error("editor handle missing");
  if (!handle.isReady()) throw new Error("editor never became ready");
  return handle;
}

describe("ComposerPromptEditor autofocus vs the mobile app", () => {
  it("takes the caret on mount when active off the mobile app", () => {
    setMobileApp(false);
    const mounted = mountComposer(true);

    readyHandle(mounted);
    expect(mounted.viewFocus).toHaveBeenCalled();
  });

  it("leaves the caret alone on mount when active on the mobile app", () => {
    setMobileApp(true);
    const mounted = mountComposer(true);

    readyHandle(mounted);
    expect(mounted.viewFocus).not.toHaveBeenCalled();
  });

  it("still focuses on the mobile app when the user asks for it", () => {
    setMobileApp(true);
    const mounted = mountComposer(true);
    const handle = readyHandle(mounted);

    // Cleared so the assertion pins the explicit request itself - without
    // this, a regression that re-enables mount autofocus would satisfy the
    // final expectation before focusAtEnd ever ran.
    mounted.viewFocus.mockClear();
    act(() => {
      handle.focusAtEnd("reveal-caret");
    });
    settleEditor();

    expect(mounted.viewFocus).toHaveBeenCalled();
  });

  it("does not take focus back on the frame after the caret was revealed", () => {
    setMobileApp(false);
    const mounted = mountComposer(true);
    const handle = readyHandle(mounted);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(
      (callback) => {
        frames.push(callback);
        return frames.length;
      },
    );
    const scrollIntoView = vi.spyOn(Transaction.prototype, "scrollIntoView");
    const button = document.createElement("button");
    document.body.append(button);

    mounted.viewFocus.mockClear();
    act(() => {
      handle.focusAtEnd("reveal-caret");
    });
    expect(mounted.viewFocus).toHaveBeenCalledTimes(1);

    button.focus();
    expect(document.activeElement).toBe(button);
    mounted.viewFocus.mockClear();
    scrollIntoView.mockClear();
    act(() => {
      while (frames.length > 0) frames.shift()?.(performance.now());
    });

    expect(mounted.viewFocus).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    button.remove();
  });

  it("does not take focus back after a fill that places the caret at the end", () => {
    setMobileApp(false);
    const mounted = mountComposer(true);
    const handle = readyHandle(mounted);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(
      (callback) => {
        frames.push(callback);
        return frames.length;
      },
    );
    const button = document.createElement("button");
    document.body.append(button);
    const filled: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Add a test for the new endpoint" }],
        },
      ],
    };

    mounted.viewFocus.mockClear();
    act(() => {
      handle.setContent(filled, null);
    });
    expect(mounted.viewFocus).toHaveBeenCalled();

    button.focus();
    expect(document.activeElement).toBe(button);
    mounted.viewFocus.mockClear();
    act(() => {
      while (frames.length > 0) frames.shift()?.(performance.now());
    });

    expect(mounted.viewFocus).not.toHaveBeenCalled();
    button.remove();
  });

  it("leaves an inactive composer alone off the mobile app too", () => {
    setMobileApp(false);
    const mounted = mountComposer(false);

    readyHandle(mounted);
    expect(mounted.viewFocus).not.toHaveBeenCalled();
  });

  describe("focusAtEnd('hold-view') under an iOS platform", () => {
    interface HoldViewRun {
      readonly preventScrollPerFocus: Array<boolean | undefined>;
      readonly scrollIntoView: MockInstance;
      readonly view: EditorView;
    }

    // Runs the request, then every animation frame it (or Tiptap) queued, so
    // a scroll deferred to a frame has happened before the caller asserts.
    function holdViewOnIos(): HoldViewRun {
      setMobileApp(true);
      const mounted = mountComposer(true);
      const handle = readyHandle(mounted);

      vi.spyOn(navigator, "platform", "get").mockReturnValue("iPhone");
      const preventScrollPerFocus: Array<boolean | undefined> = [];
      const nativeFocus: unknown = Reflect.get(HTMLElement.prototype, "focus");
      vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
        this: HTMLElement,
        options: FocusOptions | undefined,
      ) {
        preventScrollPerFocus.push(options?.preventScroll);
        invoke(nativeFocus, this, [options]);
      });
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(
        (callback) => frames.push(callback),
      );
      const scrollIntoView = vi.spyOn(Transaction.prototype, "scrollIntoView");

      act(() => {
        handle.focusAtEnd("hold-view");
      });
      act(() => {
        while (frames.length > 0) frames.shift()?.(performance.now());
      });

      const view = mounted.viewFocus.mock.contexts[0] as EditorView;
      return { preventScrollPerFocus, scrollIntoView, view };
    }

    it("focuses the editor with preventScroll on every focus call", () => {
      const run = holdViewOnIos();

      expect(run.preventScrollPerFocus.length).toBeGreaterThan(0);
      expect(run.preventScrollPerFocus.every((value) => value === true)).toBe(
        true,
      );
    });

    it("scrolls nothing into view, not even in a later frame", () => {
      const run = holdViewOnIos();

      expect(run.scrollIntoView).not.toHaveBeenCalled();
    });

    it("leaves the caret at the end of the document", () => {
      const run = holdViewOnIos();

      expect(run.view.state.selection.empty).toBe(true);
      expect(run.view.state.selection.from).toBe(
        run.view.state.doc.content.size - 1,
      );
    });
  });
});

// Tiptap's focus command is a no-op on a view that already has DOM focus, so
// both arms below start from a blurred field. Without this the off-mobile arm
// passes for the wrong reason (nothing to do) and proves nothing about clear.
function blurActiveElement(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
}

async function clearFromBlurred(mounted: MountedComposer): Promise<void> {
  const handle = readyHandle(mounted);
  act(() => {
    blurActiveElement();
  });
  mounted.viewFocus.mockClear();
  act(() => {
    handle.clear();
  });
  // Settled through frames on purpose: Tiptap defers the real `view.focus()`
  // to an animation frame, and that deferred call is the one that matters.
  await settleEditor();
}

describe("ComposerPromptEditor clear vs the mobile app", () => {
  it("returns the caret after a clear off the mobile app", async () => {
    setMobileApp(false);
    const mounted = await mountComposer(true);

    await clearFromBlurred(mounted);

    expect(mounted.viewFocus).toHaveBeenCalled();
  });

  // A send clears the composer and then blurs it so the keyboard goes away
  // with the message. A focus queued by the clear would run after that blur
  // and raise the keyboard again.
  it("queues no focus after a clear on the mobile app", async () => {
    setMobileApp(true);
    const mounted = await mountComposer(true);

    await clearFromBlurred(mounted);

    expect(mounted.viewFocus).not.toHaveBeenCalled();
  });
});
