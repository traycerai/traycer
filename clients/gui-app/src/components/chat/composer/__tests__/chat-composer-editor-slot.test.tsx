import { createRef, type KeyboardEventHandler } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { modLabel } from "@/lib/keybindings/platform";
import { ChatComposerEditorSlot } from "@/components/chat/composer/chat-composer-editor-slot";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { PROMPT_SUGGESTION_TAP_SLOP_PX } from "@/components/chat/composer/prompt-suggestion";

const narrowState = vi.hoisted(() => ({ value: false }));

vi.mock("@/components/home/composer/composer-narrow-hooks", () => ({
  useIsComposerNarrow: () => narrowState.value,
}));

interface MockComposerPromptEditorProps {
  readonly placeholder: string;
  readonly onKeyDown: KeyboardEventHandler<HTMLElement> | undefined;
}

vi.mock("@/components/chat/composer/composer-prompt-editor", () => ({
  ComposerPromptEditor: (props: MockComposerPromptEditorProps) => (
    <div
      data-testid="composer-placeholder"
      role="textbox"
      tabIndex={0}
      onKeyDown={props.onKeyDown}
    >
      {props.placeholder}
    </div>
  ),
}));

const NOOP_ACCEPT = (): void => undefined;

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
      const onAcceptSuggestion = vi.fn();

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

    it.each([
      ["shiftKey", { shiftKey: true }],
      ["altKey", { altKey: true }],
      ["metaKey", { metaKey: true }],
      ["ctrlKey", { ctrlKey: true }],
    ])("does not accept a modified ArrowRight (%s)", (_name, modifier) => {
      const onAcceptSuggestion = vi.fn();

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
      const onAcceptSuggestion = vi.fn();

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
        const onAcceptSuggestion = vi.fn();

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

  describe("touch tap acceptance", () => {
    it("accepts a touch tap that stays within the slop radius", () => {
      const onAcceptSuggestion = vi.fn();

      renderEditorSlot({
        suggestedPrompt: "Add a test for the new endpoint",
        onAcceptSuggestion,
        steerHintActive: false,
      });

      const target = screen.getByTestId("composer-placeholder");
      fireEvent.pointerDown(target, {
        pointerType: "touch",
        clientX: 5,
        clientY: 5,
      });
      fireEvent.pointerUp(target, {
        pointerType: "touch",
        clientX: 5,
        clientY: 5,
      });

      expect(onAcceptSuggestion).toHaveBeenCalledTimes(1);
      expect(onAcceptSuggestion).toHaveBeenCalledWith(
        "Add a test for the new endpoint",
      );
    });

    it("does not accept a touch that travels past the slop radius", () => {
      const onAcceptSuggestion = vi.fn();

      renderEditorSlot({
        suggestedPrompt: "Add a test for the new endpoint",
        onAcceptSuggestion,
        steerHintActive: false,
      });

      const target = screen.getByTestId("composer-placeholder");
      fireEvent.pointerDown(target, {
        pointerType: "touch",
        clientX: 0,
        clientY: 0,
      });
      fireEvent.pointerUp(target, {
        pointerType: "touch",
        clientX: PROMPT_SUGGESTION_TAP_SLOP_PX + 1,
        clientY: 0,
      });

      expect(onAcceptSuggestion).not.toHaveBeenCalled();
    });

    it("does not accept a mouse pointer tap", () => {
      const onAcceptSuggestion = vi.fn();

      renderEditorSlot({
        suggestedPrompt: "Add a test for the new endpoint",
        onAcceptSuggestion,
        steerHintActive: false,
      });

      const target = screen.getByTestId("composer-placeholder");
      fireEvent.pointerDown(target, {
        pointerType: "mouse",
        clientX: 5,
        clientY: 5,
      });
      fireEvent.pointerUp(target, {
        pointerType: "mouse",
        clientX: 5,
        clientY: 5,
      });

      expect(onAcceptSuggestion).not.toHaveBeenCalled();
    });

    it("does not accept a tap cancelled between down and up", () => {
      const onAcceptSuggestion = vi.fn();

      renderEditorSlot({
        suggestedPrompt: "Add a test for the new endpoint",
        onAcceptSuggestion,
        steerHintActive: false,
      });

      const target = screen.getByTestId("composer-placeholder");
      fireEvent.pointerDown(target, {
        pointerType: "touch",
        clientX: 5,
        clientY: 5,
      });
      fireEvent.pointerCancel(target);
      fireEvent.pointerUp(target, {
        pointerType: "touch",
        clientX: 5,
        clientY: 5,
      });

      expect(onAcceptSuggestion).not.toHaveBeenCalled();
    });

    it("does not accept a tap when there is no suggestion", () => {
      const onAcceptSuggestion = vi.fn();

      renderEditorSlot({
        suggestedPrompt: null,
        onAcceptSuggestion,
        steerHintActive: false,
      });

      const target = screen.getByTestId("composer-placeholder");
      fireEvent.pointerDown(target, {
        pointerType: "touch",
        clientX: 5,
        clientY: 5,
      });
      fireEvent.pointerUp(target, {
        pointerType: "touch",
        clientX: 5,
        clientY: 5,
      });

      expect(onAcceptSuggestion).not.toHaveBeenCalled();
    });
  });
});

interface RenderEditorSlotOptions {
  readonly suggestedPrompt: string | null;
  readonly onAcceptSuggestion: (suggestion: string) => void;
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
