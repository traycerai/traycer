import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { ComposerShell } from "../composer-shell";
import type { FileTransferDragOverlayVariant } from "@/lib/files/file-transfer-paths";

afterEach(cleanup);

function renderComposerShell(variant: FileTransferDragOverlayVariant): void {
  render(
    <ComposerShell
      pickerStore={createComposerPickerStore()}
      onDragOver={() => undefined}
      onDrop={() => undefined}
      onDragEnter={() => undefined}
      onDragLeave={() => undefined}
      dragOverlayVariant={variant}
      attachmentsStrip={null}
      editor={<div />}
      toolbar={<div />}
    />,
  );
}

describe("ComposerShell file-drop overlay", () => {
  it("keeps the existing image copy", () => {
    renderComposerShell("images");

    expect(screen.getByText("Drop image to attach")).not.toBeNull();
    expect(screen.getByText("PNG, JPG, GIF up to 5MB")).not.toBeNull();
  });

  it("describes path insertion for non-image drags", () => {
    renderComposerShell("paths");

    expect(screen.getByText("Drop to insert file path")).not.toBeNull();
    expect(
      screen.getByText("Path will be inserted in the message"),
    ).not.toBeNull();
  });

  it("describes both outcomes for mixed drags", () => {
    renderComposerShell("mixed");

    expect(
      screen.getByText("Drop to attach images and insert file paths"),
    ).not.toBeNull();
    expect(
      screen.getByText("Images attach; file paths are inserted"),
    ).not.toBeNull();
  });
});
