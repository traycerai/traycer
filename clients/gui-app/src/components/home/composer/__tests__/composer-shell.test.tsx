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
  attachmentsStrip: ReactNode,
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
      attachmentsStrip={attachmentsStrip}
      editor={<div data-testid="composer-editor" />}
      toolbar={<div />}
    />,
  );
}

describe("ComposerShell file-drop overlay", () => {
  it("keeps the existing image copy", () => {
    renderComposerShell("images", null, null);

    expect(screen.getByText("Drop image to attach")).not.toBeNull();
    expect(screen.getByText("PNG, JPG, GIF up to 5MB")).not.toBeNull();
  });

  it("describes path insertion for non-image drags", () => {
    renderComposerShell("paths", null, null);

    expect(screen.getByText("Drop to insert file path")).not.toBeNull();
    expect(
      screen.getByText("Path will be inserted in the message"),
    ).not.toBeNull();
  });

  it("describes both outcomes for mixed drags", () => {
    renderComposerShell("mixed", null, null);

    expect(
      screen.getByText("Drop to attach images and insert file paths"),
    ).not.toBeNull();
    expect(
      screen.getByText("Images attach; file paths are inserted"),
    ).not.toBeNull();
  });

  it("places attachments in their own row before the editor", () => {
    renderComposerShell(
      "images",
      null,
      <div data-testid="composer-attachments">Images</div>,
    );

    const attachments = screen.getByTestId("composer-attachments");
    const editor = screen.getByTestId("composer-editor");
    const editorFrame = editor.closest("[data-composer-editor-frame]");
    const attachmentRail = attachments.closest(
      "[data-composer-attachment-rail]",
    );
    expect(attachments.compareDocumentPosition(editor)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(attachmentRail?.parentElement).toBe(editorFrame);
    expect(attachmentRail?.nextElementSibling).toBe(editor);
  });

  it("collapses the attachment rail when there are no attachments", () => {
    renderComposerShell("images", null, null);

    const editor = screen.getByTestId("composer-editor");
    const attachmentRail = editor.previousElementSibling;

    expect(attachmentRail?.hasAttribute("data-composer-attachment-rail")).toBe(
      true,
    );
    expect(attachmentRail?.className).toContain("empty:hidden");
    expect(attachmentRail?.childElementCount).toBe(0);
  });

  it("anchors utility chrome above layout flow regardless of attachments", () => {
    renderComposerShell(
      "images",
      <div data-testid="composer-utility">Stash 2</div>,
      <div data-testid="composer-attachments">Images</div>,
    );

    const utility = screen.getByTestId("composer-utility");
    const overlay = utility.closest("[data-composer-utility-overlay]");
    const shell = utility.closest("[data-composer-shell]");
    const attachmentRail = screen
      .getByTestId("composer-attachments")
      .closest("[data-composer-attachment-rail]");

    expect(overlay?.className).toContain("absolute");
    expect(overlay?.className).toContain("right-3");
    expect(overlay?.className).toContain("-translate-y-1/2");
    expect(overlay?.parentElement).toBe(shell);
    expect(attachmentRail?.contains(utility)).toBe(false);
  });
});
