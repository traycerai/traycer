import { createRef, type KeyboardEventHandler } from "react";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { modLabel } from "@/lib/keybindings/platform";
import { ChatComposerEditorSlot } from "@/components/chat/composer/chat-composer-editor-slot";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";

const narrowState = vi.hoisted(() => ({ value: false }));

vi.mock("@/components/home/composer/composer-narrow-hooks", () => ({
  useIsComposerNarrow: () => narrowState.value,
}));

interface MockComposerPromptEditorProps {
  readonly placeholder: string;
  readonly editorClassName: string | undefined;
  readonly onKeyDown: KeyboardEventHandler<HTMLElement> | undefined;
}

vi.mock("@/components/chat/composer/composer-prompt-editor", () => ({
  ComposerPromptEditor: (props: MockComposerPromptEditorProps) => (
    <div
      data-testid="composer-placeholder"
      role="textbox"
      tabIndex={0}
      className={props.editorClassName}
      onKeyDown={props.onKeyDown}
    >
      {props.placeholder}
    </div>
  ),
}));

type AcceptSuggestion = (suggestion: string) => boolean;

const NOOP_ACCEPT: AcceptSuggestion = () => false;

describe("ChatComposerEditorSlot", () => {
  afterEach(() => {
    cleanup();
    narrowState.value = false;
  });

  describe("placeholder", () => {
    it("uses a compact steering hint in a narrow composer", () => {
      narrowState.value = true;

      renderEditorSlot({
        suggestedPrompt: null,
        onAcceptSuggestion: NOOP_ACCEPT,
        steerHintActive: true,
      });

      expect(screen.getByTestId("composer-placeholder").textContent).toBe(
        `${modLabel()}+Enter to steer`,
      );
    });

    it("keeps the queue-and-steer discovery hint in a wide composer", () => {
      renderEditorSlot({
        suggestedPrompt: null,
        onAcceptSuggestion: NOOP_ACCEPT,
        steerHintActive: true,
      });

      expect(screen.getByTestId("composer-placeholder").textContent).toContain(
        "Enter to queue",
      );
    });

    it("shows the suggestion as the placeholder, outranking the steer hint", () => {
      renderEditorSlot({
        suggestedPrompt: "Add a test for the new endpoint",
        onAcceptSuggestion: NOOP_ACCEPT,
        steerHintActive: true,
      });

      expect(screen.getByTestId("composer-placeholder").textContent).toBe(
        "Add a test for the new endpoint",
      );
    });
  });

  describe("ArrowRight acceptance", () => {
    it("accepts a bare ArrowRight when a suggestion is offered", () => {
      const onAcceptSuggestion = vi.fn<AcceptSuggestion>(() => true);

      renderEditorSlot({
        suggestedPrompt: "Add a test for the new endpoint",
        onAcceptSuggestion,
        steerHintActive: false,
      });

      fireEvent.keyDown(screen.getByTestId("composer-placeholder"), {
        key: "ArrowRight",
      });

      expect(onAcceptSuggestion).toHaveBeenCalledTimes(1);
      expect(onAcceptSuggestion).toHaveBeenCalledWith(
        "Add a test for the new endpoint",
      );
    });

    it("takes the key when the suggestion was accepted, so the caret does not move", () => {
      const onAcceptSuggestion = vi.fn<AcceptSuggestion>(() => true);

      renderEditorSlot({
        suggestedPrompt: "Add a test for the new endpoint",
        onAcceptSuggestion,
        steerHintActive: false,
      });

      const target = screen.getByTestId("composer-placeholder");
      const event = createEvent.keyDown(target, { key: "ArrowRight" });
      fireEvent(target, event);

      expect(onAcceptSuggestion).toHaveBeenCalledTimes(1);
      expect(onAcceptSuggestion).toHaveBeenCalledWith(
        "Add a test for the new endpoint",
      );
      expect(event.defaultPrevented).toBe(true);
    });

    // The live draft can stop being empty before the suggestion prop
    // re-renders. The fill then declines and returns false, and the key must
    // keep its ordinary job: moving the caret.
    it("leaves the key alone when the fill is declined, so the caret still moves", () => {
      const onAcceptSuggestion = vi.fn<AcceptSuggestion>(() => false);

      renderEditorSlot({
        suggestedPrompt: "Add a test for the new endpoint",
        onAcceptSuggestion,
        steerHintActive: false,
      });

      const target = screen.getByTestId("composer-placeholder");
      const event = createEvent.keyDown(target, { key: "ArrowRight" });
      fireEvent(target, event);

      expect(onAcceptSuggestion).toHaveBeenCalledTimes(1);
      expect(onAcceptSuggestion).toHaveBeenCalledWith(
        "Add a test for the new endpoint",
      );
      expect(event.defaultPrevented).toBe(false);
    });

    it.each([
      ["shiftKey", { shiftKey: true }],
      ["altKey", { altKey: true }],
      ["metaKey", { metaKey: true }],
      ["ctrlKey", { ctrlKey: true }],
    ])("does not accept a modified ArrowRight (%s)", (_name, modifier) => {
      const onAcceptSuggestion = vi.fn<AcceptSuggestion>(() => true);

      renderEditorSlot({
        suggestedPrompt: "Add a test for the new endpoint",
        onAcceptSuggestion,
        steerHintActive: false,
      });

      fireEvent.keyDown(screen.getByTestId("composer-placeholder"), {
        key: "ArrowRight",
        ...modifier,
      });

      expect(onAcceptSuggestion).not.toHaveBeenCalled();
    });

    it("does not accept ArrowRight when there is no suggestion", () => {
      const onAcceptSuggestion = vi.fn<AcceptSuggestion>(() => true);

      renderEditorSlot({
        suggestedPrompt: null,
        onAcceptSuggestion,
        steerHintActive: false,
      });

      fireEvent.keyDown(screen.getByTestId("composer-placeholder"), {
        key: "ArrowRight",
      });

      expect(onAcceptSuggestion).not.toHaveBeenCalled();
    });

    it.each(["Enter", "ArrowLeft"])(
      "does not accept another key (%s)",
      (key) => {
        const onAcceptSuggestion = vi.fn<AcceptSuggestion>(() => true);

        renderEditorSlot({
          suggestedPrompt: "Add a test for the new endpoint",
          onAcceptSuggestion,
          steerHintActive: false,
        });

        fireEvent.keyDown(screen.getByTestId("composer-placeholder"), {
          key,
        });

        expect(onAcceptSuggestion).not.toHaveBeenCalled();
      },
    );
  });

  describe("touch swipe acceptance", () => {
    const SUGGESTION = "Add a test for the new endpoint";

    // A tap on a phone is how the user starts typing. Filling on it handed
    // them a prompt to delete before they could write their own.
    it("leaves a touch tap alone, so tapping the composer only focuses it", () => {
      const onAcceptSuggestion = vi.fn<AcceptSuggestion>(() => true);
      const target = renderOfferedSlot(SUGGESTION, onAcceptSuggestion);

      firePointer("pointerDown", target, TOUCH, { x: 100, y: 20, at: 1000 });
      firePointer("pointerUp", target, TOUCH, { x: 100, y: 20, at: 1080 });

      expect(onAcceptSuggestion).not.toHaveBeenCalled();
    });

    it("leaves a tap that wobbles alone", () => {
      const onAcceptSuggestion = vi.fn<AcceptSuggestion>(() => true);
      const target = renderOfferedSlot(SUGGESTION, onAcceptSuggestion);

      firePointer("pointerDown", target, TOUCH, { x: 100, y: 20, at: 1000 });
      firePointer("pointerMove", target, TOUCH, { x: 108, y: 23, at: 1400 });
      firePointer("pointerUp", target, TOUCH, { x: 108, y: 23, at: 1480 });

      expect(onAcceptSuggestion).not.toHaveBeenCalled();
    });

    it("accepts a slow rightward swipe once it has travelled far enough, and only once", () => {
      const onAcceptSuggestion = vi.fn<AcceptSuggestion>(() => true);
      const target = renderOfferedSlot(SUGGESTION, onAcceptSuggestion);

      firePointer("pointerDown", target, TOUCH, { x: 100, y: 20, at: 1000 });
      // Declared rightward, but neither far nor fast enough yet.
      firePointer("pointerMove", target, TOUCH, { x: 130, y: 22, at: 1400 });
      expect(onAcceptSuggestion).not.toHaveBeenCalled();

      firePointer("pointerMove", target, TOUCH, { x: 141, y: 22, at: 1800 });
      expect(onAcceptSuggestion).toHaveBeenCalledTimes(1);
      expect(onAcceptSuggestion).toHaveBeenCalledWith(SUGGESTION);

      firePointer("pointerMove", target, TOUCH, { x: 220, y: 22, at: 1900 });
      firePointer("pointerUp", target, TOUCH, { x: 220, y: 22, at: 1950 });
      expect(onAcceptSuggestion).toHaveBeenCalledTimes(1);
    });

    it("accepts a short rightward flick on its speed", () => {
      const onAcceptSuggestion = vi.fn<AcceptSuggestion>(() => true);
      const target = renderOfferedSlot(SUGGESTION, onAcceptSuggestion);

      firePointer("pointerDown", target, TOUCH, { x: 100, y: 20, at: 1000 });
      firePointer("pointerMove", target, TOUCH, { x: 120, y: 20, at: 1020 });

      expect(onAcceptSuggestion).toHaveBeenCalledTimes(1);
      expect(onAcceptSuggestion).toHaveBeenCalledWith(SUGGESTION);
    });

    it("keeps a swipe that curves downward once it has declared itself rightward", () => {
      const onAcceptSuggestion = vi.fn<AcceptSuggestion>(() => true);
      const target = renderOfferedSlot(SUGGESTION, onAcceptSuggestion);

      firePointer("pointerDown", target, TOUCH, { x: 100, y: 20, at: 1000 });
      firePointer("pointerMove", target, TOUCH, { x: 120, y: 22, at: 1400 });
      firePointer("pointerMove", target, TOUCH, { x: 145, y: 80, at: 1800 });

      expect(onAcceptSuggestion).toHaveBeenCalledTimes(1);
    });

    it("does not accept a leftward swipe", () => {
      const onAcceptSuggestion = vi.fn<AcceptSuggestion>(() => true);
      const target = renderOfferedSlot(SUGGESTION, onAcceptSuggestion);

      firePointer("pointerDown", target, TOUCH, { x: 100, y: 20, at: 1000 });
      firePointer("pointerMove", target, TOUCH, { x: 40, y: 20, at: 1100 });
      firePointer("pointerUp", target, TOUCH, { x: 40, y: 20, at: 1150 });

      expect(onAcceptSuggestion).not.toHaveBeenCalled();
    });

    it("does not accept a vertical drag, even one that turns rightward afterwards", () => {
      const onAcceptSuggestion = vi.fn<AcceptSuggestion>(() => true);
      const target = renderOfferedSlot(SUGGESTION, onAcceptSuggestion);

      firePointer("pointerDown", target, TOUCH, { x: 100, y: 20, at: 1000 });
      firePointer("pointerMove", target, TOUCH, { x: 104, y: 60, at: 1100 });
      firePointer("pointerMove", target, TOUCH, { x: 200, y: 60, at: 1200 });
      firePointer("pointerUp", target, TOUCH, { x: 200, y: 60, at: 1250 });

      expect(onAcceptSuggestion).not.toHaveBeenCalled();
    });

    it("does not accept a mouse drag, which is a text selection", () => {
      const onAcceptSuggestion = vi.fn<AcceptSuggestion>(() => true);
      const target = renderOfferedSlot(SUGGESTION, onAcceptSuggestion);

      firePointer("pointerDown", target, MOUSE, { x: 100, y: 20, at: 1000 });
      firePointer("pointerMove", target, MOUSE, { x: 200, y: 20, at: 1100 });
      firePointer("pointerUp", target, MOUSE, { x: 200, y: 20, at: 1150 });

      expect(onAcceptSuggestion).not.toHaveBeenCalled();
    });

    it("does not accept a swipe the system cancelled before it committed", () => {
      const onAcceptSuggestion = vi.fn<AcceptSuggestion>(() => true);
      const target = renderOfferedSlot(SUGGESTION, onAcceptSuggestion);

      firePointer("pointerDown", target, TOUCH, { x: 100, y: 20, at: 1000 });
      firePointer("pointerMove", target, TOUCH, { x: 120, y: 20, at: 1400 });
      firePointer("pointerCancel", target, TOUCH, { x: 120, y: 20, at: 1450 });
      firePointer("pointerMove", target, TOUCH, { x: 200, y: 20, at: 1500 });

      expect(onAcceptSuggestion).not.toHaveBeenCalled();
    });

    it("drops the swipe when a second finger lands", () => {
      const onAcceptSuggestion = vi.fn<AcceptSuggestion>(() => true);
      const target = renderOfferedSlot(SUGGESTION, onAcceptSuggestion);

      firePointer("pointerDown", target, TOUCH, { x: 100, y: 20, at: 1000 });
      firePointer("pointerDown", target, SECOND_TOUCH, {
        x: 160,
        y: 24,
        at: 1050,
      });
      firePointer("pointerMove", target, TOUCH, { x: 200, y: 20, at: 1100 });

      expect(onAcceptSuggestion).not.toHaveBeenCalled();
    });

    it("does not accept a swipe when there is no suggestion", () => {
      const onAcceptSuggestion = vi.fn<AcceptSuggestion>(() => true);

      renderEditorSlot({
        suggestedPrompt: null,
        onAcceptSuggestion,
        steerHintActive: false,
      });

      const target = screen.getByTestId("composer-placeholder");
      firePointer("pointerDown", target, TOUCH, { x: 100, y: 20, at: 1000 });
      firePointer("pointerMove", target, TOUCH, { x: 200, y: 20, at: 1100 });

      expect(onAcceptSuggestion).not.toHaveBeenCalled();
    });

    // What delivers the sideways moves on a real touch screen; the browser
    // spec (`browser-tests/prompt-suggestion-swipe.spec.ts`) proves it does.
    it("reserves the editor's horizontal axis only while a suggestion is offered", () => {
      const offered = renderOfferedSlot(SUGGESTION, NOOP_ACCEPT);
      expect(offered.classList.contains("touch-pan-y")).toBe(true);
      cleanup();

      renderEditorSlot({
        suggestedPrompt: null,
        onAcceptSuggestion: NOOP_ACCEPT,
        steerHintActive: false,
      });
      expect(
        screen
          .getByTestId("composer-placeholder")
          .classList.contains("touch-pan-y"),
      ).toBe(false);
    });
  });
});

interface PointerIdentity {
  readonly pointerType: "touch" | "mouse";
  readonly pointerId: number;
  readonly isPrimary: boolean;
}

const TOUCH: PointerIdentity = {
  pointerType: "touch",
  pointerId: 1,
  isPrimary: true,
};
const SECOND_TOUCH: PointerIdentity = {
  pointerType: "touch",
  pointerId: 2,
  isPrimary: false,
};
const MOUSE: PointerIdentity = {
  pointerType: "mouse",
  pointerId: 1,
  isPrimary: true,
};

/**
 * Dispatches one pointer event with an explicit `timeStamp`, which the swipe's
 * speed arm reads. Never 0: React substitutes the wall clock for a falsy
 * native timestamp.
 */
function firePointer(
  type: "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel",
  target: HTMLElement,
  pointer: PointerIdentity,
  sample: { readonly x: number; readonly y: number; readonly at: number },
): void {
  const event = createEvent[type](target, {
    ...pointer,
    clientX: sample.x,
    clientY: sample.y,
  });
  Object.defineProperty(event, "timeStamp", { value: sample.at });
  fireEvent(target, event);
}

function renderOfferedSlot(
  suggestedPrompt: string,
  onAcceptSuggestion: AcceptSuggestion,
): HTMLElement {
  renderEditorSlot({
    suggestedPrompt,
    onAcceptSuggestion,
    steerHintActive: false,
  });
  return screen.getByTestId("composer-placeholder");
}

interface RenderEditorSlotOptions {
  readonly suggestedPrompt: string | null;
  readonly onAcceptSuggestion: AcceptSuggestion;
  readonly steerHintActive: boolean;
}

function renderEditorSlot(options: RenderEditorSlotOptions): void {
  render(
    <ChatComposerEditorSlot
      ref={createRef<ComposerPromptEditorHandle>()}
      pickerStore={createComposerPickerStore()}
      initialContent={{ type: "doc", content: [{ type: "paragraph" }] }}
      initialSelection={null}
      slashProviderId="claude"
      hasPastedImageBytes={null}
      ingestPastedComposerImages={null}
      isActive
      disabled={false}
      onDocumentChange={() => undefined}
      onFocus={() => undefined}
      onSelectionChange={() => undefined}
      onSubmit={() => undefined}
      steerHintActive={options.steerHintActive}
      suggestedPrompt={options.suggestedPrompt}
      onAcceptSuggestion={options.onAcceptSuggestion}
      onPaste={() => undefined}
      onDragOver={() => undefined}
      onDrop={() => undefined}
      onEditorReady={null}
    />,
  );
}
