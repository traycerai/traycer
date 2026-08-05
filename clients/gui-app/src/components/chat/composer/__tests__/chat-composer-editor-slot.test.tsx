import { createRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { modLabel } from "@/lib/keybindings/platform";
import { ChatComposerEditorSlot } from "@/components/chat/composer/chat-composer-editor-slot";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";

const narrowState = vi.hoisted(() => ({ value: false }));

vi.mock("@/components/home/composer/composer-narrow-hooks", () => ({
  useIsComposerNarrow: () => narrowState.value,
}));

vi.mock("@/components/chat/composer/composer-prompt-editor", () => ({
  ComposerPromptEditor: (props: { readonly placeholder: string }) => (
    <div data-testid="composer-placeholder">{props.placeholder}</div>
  ),
}));

describe("ChatComposerEditorSlot", () => {
  afterEach(() => {
    cleanup();
    narrowState.value = false;
  });

  it("uses a compact steering hint in a narrow composer", () => {
    narrowState.value = true;

    renderEditorSlot();

    expect(screen.getByTestId("composer-placeholder").textContent).toBe(
      `${modLabel()}+Enter to steer`,
    );
  });

  it("keeps the queue-and-steer discovery hint in a wide composer", () => {
    renderEditorSlot();

    expect(screen.getByTestId("composer-placeholder").textContent).toContain(
      "Enter to queue",
    );
  });
});

function renderEditorSlot(): void {
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
      onDocumentChange={() => undefined}
      onFocus={() => undefined}

      onSelectionChange={() => undefined}
      onSubmit={() => undefined}
      steerHintActive
      onPaste={() => undefined}
      onDragOver={() => undefined}
      onDrop={() => undefined}
      onEditorReady={null}
    />,
  );
}
