import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { ComposerShell } from "../composer-shell";
import type { FileTransferDragOverlayVariant } from "@/lib/files/file-transfer-paths";

afterEach(cleanup);

function renderComposerShell(
  variant: FileTransferDragOverlayVariant,
  utilityRail: ReactNode,
): void {
  render(
    <ComposerShell
      pickerStore={createComposerPickerStore()}
      onDragOver={() => undefined}
      onDrop={() => undefined}
      onDragEnter={() => undefined}
      onDragLeave={() => undefined}
      dragOverlayVariant={variant}
      utilityRail={utilityRail}
      attachmentsStrip={null}
      editor={<div data-testid="composer-editor" />}
      toolbar={<div />}
    />,
  );
}

describe("ComposerShell file-drop overlay", () => {
  it("keeps the existing image copy", () => {
    renderComposerShell("images", null);

    expect(screen.getByText("Drop image to attach")).not.toBeNull();
    expect(screen.getByText("PNG, JPG, GIF up to 5MB")).not.toBeNull();
  });

  it("describes path insertion for non-image drags", () => {
    renderComposerShell("paths", null);

    expect(screen.getByText("Drop to insert file path")).not.toBeNull();
    expect(
      screen.getByText("Path will be inserted in the message"),
    ).not.toBeNull();
  });

  it("describes both outcomes for mixed drags", () => {
    renderComposerShell("mixed", null);

    expect(
      screen.getByText("Drop to attach images and insert file paths"),
    ).not.toBeNull();
    expect(
      screen.getByText("Images attach; file paths are inserted"),
    ).not.toBeNull();
  });

  it("places utility chrome in flow before the editor", () => {
    renderComposerShell(
      "images",
      <div data-composer-utility-rail="" data-testid="composer-utility-rail">
        Stash 2
      </div>,
    );

    const shell = document.querySelector("[data-composer-shell]");
    const rail = screen.getByTestId("composer-utility-rail");
    const editor = screen.getByTestId("composer-editor");
    const editorFrame = editor.closest("[data-composer-editor-frame]");
    expect(shell?.contains(rail)).toBe(true);
    expect(rail.compareDocumentPosition(editor)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(rail.nextElementSibling).toBe(editorFrame);
  });
});
