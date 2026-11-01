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
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { Transaction } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { setMobileApp } from "@/lib/mobile-app";
import { ComposerPromptEditor } from "../composer-prompt-editor";
import type { ComposerPromptEditorHandle } from "../composer-prompt-editor";
import { createComposerPickerStore } from "../picker/composer-picker-store";

// ProseMirror probes once per module whether `focus` honours `preventScroll`,
// by passing an options object whose getter flips a flag. jsdom's native focus
// never reads its options, so the probe would settle on "unsupported" and
// ProseMirror would pass no options at all. A real browser reads them.
function invoke(fn: unknown, self: object, args: readonly unknown[]): void {
  if (typeof fn !== "function") throw new Error("not a function");
  Reflect.apply(fn, self, args);
}

const jsdomFocus: unknown = Reflect.get(HTMLElement.prototype, "focus");
beforeAll(() => {
  HTMLElement.prototype.focus = function (
    this: HTMLElement,
    options: FocusOptions | undefined,
  ) {
    void options?.preventScroll;
    invoke(jsdomFocus, this, [options]);
  };
});
afterAll(() => {
  Reflect.set(HTMLElement.prototype, "focus", jsdomFocus);
});

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
      handle.focusAtEnd("reveal-caret");
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

  describe("focusAtEnd('hold-view') under an iOS platform", () => {
    interface HoldViewRun {
      readonly preventScrollPerFocus: Array<boolean | undefined>;
      readonly scrollIntoView: MockInstance;
      readonly view: EditorView;
    }

    // Runs the request, then every animation frame it (or Tiptap) queued, so
    // a scroll deferred to a frame has happened before the caller asserts.
    async function holdViewOnIos(): Promise<HoldViewRun> {
      setMobileApp(true);
      const mounted = await mountComposer(true);
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

    it("focuses the editor with preventScroll on every focus call", async () => {
      const run = await holdViewOnIos();

      expect(run.preventScrollPerFocus.length).toBeGreaterThan(0);
      expect(run.preventScrollPerFocus.every((value) => value === true)).toBe(
        true,
      );
    });

    it("scrolls nothing into view, not even in a later frame", async () => {
      const run = await holdViewOnIos();

      expect(run.scrollIntoView).not.toHaveBeenCalled();
    });

    it("leaves the caret at the end of the document", async () => {
      const run = await holdViewOnIos();

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
