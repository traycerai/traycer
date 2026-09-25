import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import type { ComposerExpansion } from "@/components/home/composer/composer-expand-handle";
import { ComposerShell } from "../composer-shell";
import type { FileTransferDragOverlayVariant } from "@/lib/files/file-transfer-paths";

afterEach(cleanup);

// The layout signal, faked per test. Real module spread back in so everything
// else it exports keeps working. Mirrors the mocking approach used in
// chat-tile-lower-surfaces-agent-stop-host-routing.test.tsx.
const viewportMock = vi.hoisted(() => ({ phone: false }));
vi.mock("@/hooks/ui/use-mobile-viewport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/ui/use-mobile-viewport")>()),
  useIsMobileViewport: (): boolean => viewportMock.phone,
}));

function renderComposerShell(
  variant: FileTransferDragOverlayVariant,
  utilityRail: ReactNode,
  attachmentsStrip: ReactNode,
  expansion: ComposerExpansion | null,
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
      expansion={expansion}
    />,
  );
}

describe("ComposerShell file-drop overlay", () => {
  it("keeps the existing image copy", () => {
    renderComposerShell("images", null, null, null);

    expect(screen.getByText("Drop image to attach")).not.toBeNull();
    expect(screen.getByText("PNG, JPG, GIF up to 5MB")).not.toBeNull();
  });

  it("describes path insertion for non-image drags", () => {
    renderComposerShell("paths", null, null, null);

    expect(screen.getByText("Drop to insert file path")).not.toBeNull();
    expect(
      screen.getByText("Path will be inserted in the message"),
    ).not.toBeNull();
  });

  it("describes both outcomes for mixed drags", () => {
    renderComposerShell("mixed", null, null, null);

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
      null,
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
    renderComposerShell("images", null, null, null);

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
      <div data-testid="composer-utility">Drafts 2</div>,
      <div data-testid="composer-attachments">Images</div>,
      null,
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

function makeExpansion(expanded: boolean): ComposerExpansion {
  return { expanded, onExpandedChange: vi.fn() };
}

/**
 * Splits a `className` into its space-separated tokens so a bare utility
 * (`hidden`) can be told apart from a modifier that merely contains its name
 * as a substring (`empty:hidden`).
 */
function classTokens(element: Element | null): ReadonlyArray<string> {
  return (element?.className ?? "")
    .split(/\s+/)
    .filter((token) => token !== "");
}

describe("ComposerShell phone expansion", () => {
  afterEach(() => {
    viewportMock.phone = false;
  });

  it("renders no handle on a desktop viewport, even when expansion is given", () => {
    viewportMock.phone = false;
    renderComposerShell("images", null, null, makeExpansion(false));

    expect(screen.queryByRole("button", { name: /composer/i })).toBeNull();
  });

  it("renders the handle on a phone viewport", () => {
    viewportMock.phone = true;
    renderComposerShell("images", null, null, makeExpansion(false));

    expect(
      screen.getByRole("button", { name: "Expand composer" }),
    ).not.toBeNull();
  });

  it("renders no handle on a phone viewport when expansion is null", () => {
    viewportMock.phone = true;
    renderComposerShell("images", null, null, null);

    expect(screen.queryByRole("button", { name: /composer/i })).toBeNull();
  });

  it("puts the shell into its fixed sheet state when expanded on phone", () => {
    viewportMock.phone = true;
    renderComposerShell(
      "images",
      <div data-testid="composer-utility">Drafts</div>,
      null,
      makeExpansion(true),
    );

    const editor = screen.getByTestId("composer-editor");
    const shell = editor.closest("[data-composer-shell]");
    const utility = screen.getByTestId("composer-utility");
    const overlay = utility.closest("[data-composer-utility-overlay]");
    const editorFrame = editor.closest("[data-composer-editor-frame]");

    expect(shell?.hasAttribute("data-composer-expanded")).toBe(true);
    expect(shell?.className).toContain("fixed");
    expect(classTokens(overlay)).toContain("hidden");
    expect(editorFrame?.className).toContain("overflow-y-auto");
  });

  it("keeps the shell in flow, collapsed, when not expanded on phone", () => {
    viewportMock.phone = true;
    renderComposerShell(
      "images",
      <div data-testid="composer-utility">Drafts</div>,
      null,
      makeExpansion(false),
    );

    const editor = screen.getByTestId("composer-editor");
    const shell = editor.closest("[data-composer-shell]");
    const utility = screen.getByTestId("composer-utility");
    const overlay = utility.closest("[data-composer-utility-overlay]");
    const editorFrame = editor.closest("[data-composer-editor-frame]");

    expect(shell?.hasAttribute("data-composer-expanded")).toBe(false);
    expect(shell?.className).not.toContain("fixed");
    // The overlay always carries `empty:hidden`; only a bare `hidden` token
    // (added when expanded) should be absent here.
    expect(classTokens(overlay)).not.toContain("hidden");
    expect(editorFrame?.className).not.toContain("overflow-y-auto");
  });
});
