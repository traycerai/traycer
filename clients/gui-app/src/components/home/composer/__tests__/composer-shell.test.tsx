import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import type { ComposerExpansion } from "@/components/home/composer/composer-shell";
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

function grabber(): Element | null {
  return document.querySelector("[data-composer-grabber]");
}

function grabberOrThrow(): Element {
  const element = grabber();
  if (element === null) throw new Error("grabber missing");
  return element;
}

function pull(zone: Element, fromY: number, toY: number): void {
  fireEvent.pointerDown(zone, { clientY: fromY, pointerId: 1 });
  fireEvent.pointerMove(zone, { clientY: toY, pointerId: 1 });
  fireEvent.pointerUp(zone, { clientY: toY, pointerId: 1 });
}

const FITTING_EDITOR = (
  <div data-testid="composer-editor" data-composer-editor="" />
);

const PICKER_STORE = createComposerPickerStore();

function shellWith(
  expansion: ComposerExpansion | null,
  editor: ReactNode,
): ReactNode {
  return (
    <ComposerShell
      pickerStore={PICKER_STORE}
      onDragOver={() => undefined}
      onDrop={() => undefined}
      onDragEnter={() => undefined}
      onDragLeave={() => undefined}
      dragOverlayVariant="images"
      utilityRail={null}
      attachmentsStrip={null}
      editor={editor}
      toolbar={<div />}
      expansion={expansion}
    />
  );
}

function renderShellWithEditor(
  expansion: ComposerExpansion | null,
  editor: ReactNode,
): void {
  render(shellWith(expansion, editor));
}

describe("ComposerShell phone expansion", () => {
  // jsdom does not implement `setPointerCapture`, and the grabber calls it on
  // every press.
  beforeEach(() => {
    HTMLElement.prototype.setPointerCapture = vi.fn();
  });
  afterEach(() => {
    viewportMock.phone = false;
  });

  it("renders no pull zone on a desktop viewport", () => {
    viewportMock.phone = false;
    renderShellWithEditor(makeExpansion(false), FITTING_EDITOR);

    expect(grabber()).toBeNull();
  });

  it("renders no grabber and no hidden button on a phone viewport when expansion is null", () => {
    viewportMock.phone = true;
    renderShellWithEditor(null, FITTING_EDITOR);

    expect(grabber()).toBeNull();
    expect(screen.queryByRole("button", { name: /composer/i })).toBeNull();
  });

  it("offers the pull zone on a phone whatever the draft's size, with nothing drawn in it", () => {
    viewportMock.phone = true;
    renderShellWithEditor(makeExpansion(false), FITTING_EDITOR);

    const zone = grabber();
    expect(zone).not.toBeNull();
    expect(zone?.getAttribute("aria-hidden")).toBe("true");
    expect(zone?.childElementCount).toBe(0);
    const button = screen.getByRole("button", { name: "Expand composer" });
    expect(classTokens(button)).toContain("sr-only");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles the sheet from the hidden button, which stays mounted across the collapse", () => {
    viewportMock.phone = true;
    const expansion = makeExpansion(true);
    const view = render(shellWith(expansion, FITTING_EDITOR));
    const button = screen.getByRole("button", { name: "Collapse composer" });
    button.focus();

    fireEvent.click(button);
    expect(expansion.onExpandedChange).toHaveBeenCalledWith(false);

    // The owner collapses; the button is the same element, still focused.
    view.rerender(shellWith(makeExpansion(false), FITTING_EDITOR));
    expect(screen.getByRole("button", { name: "Expand composer" })).toBe(
      button,
    );
    expect(document.activeElement).toBe(button);
  });

  it("opens the sheet on a pull up past the threshold, once", () => {
    viewportMock.phone = true;
    const expansion = makeExpansion(false);
    renderShellWithEditor(expansion, FITTING_EDITOR);
    const zone = grabberOrThrow();

    fireEvent.pointerDown(zone, { clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(zone, { clientY: 76, pointerId: 1 });
    fireEvent.pointerMove(zone, { clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(zone, { clientY: 40, pointerId: 1 });

    expect(expansion.onExpandedChange).toHaveBeenCalledTimes(1);
    expect(expansion.onExpandedChange).toHaveBeenCalledWith(true);
  });

  it("closes the sheet on a pull down past the threshold while expanded", () => {
    viewportMock.phone = true;
    vi.useFakeTimers();
    const expansion = makeExpansion(true);
    renderShellWithEditor(expansion, FITTING_EDITOR);

    pull(grabberOrThrow(), 100, 130);
    expect(expansion.onExpandedChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(expansion.onExpandedChange).toHaveBeenCalledTimes(1);
    expect(expansion.onExpandedChange).toHaveBeenCalledWith(false);
    vi.useRealTimers();
  });

  it("holds the sheet's top under the finger while the pull lasts", () => {
    viewportMock.phone = true;
    const expansion = makeExpansion(true);
    renderShellWithEditor(expansion, FITTING_EDITOR);
    const zone = grabberOrThrow();
    const sheet = zone.parentElement;
    if (sheet === null) throw new Error("sheet missing");

    fireEvent.pointerDown(zone, { clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(zone, { clientY: 60, pointerId: 1 });
    expect(sheet.hasAttribute("data-composer-pulling")).toBe(true);
    expect(sheet.style.getPropertyValue("--composer-sheet-top")).not.toBe("");

    fireEvent.pointerUp(zone, { clientY: 60, pointerId: 1 });
    expect(sheet.hasAttribute("data-composer-pulling")).toBe(false);
    expect(sheet.style.getPropertyValue("--composer-sheet-top")).toBe("");
    expect(expansion.onExpandedChange).not.toHaveBeenCalled();
  });

  it("does nothing on a tap or a short wobble", () => {
    viewportMock.phone = true;
    const expansion = makeExpansion(false);
    renderShellWithEditor(expansion, FITTING_EDITOR);
    const zone = grabberOrThrow();

    pull(zone, 100, 100);
    pull(zone, 100, 90);
    fireEvent.click(zone);

    expect(expansion.onExpandedChange).not.toHaveBeenCalled();
  });

  it("ignores a pull in the direction the sheet already is", () => {
    viewportMock.phone = true;
    const expansion = makeExpansion(false);
    renderShellWithEditor(expansion, FITTING_EDITOR);

    pull(grabberOrThrow(), 100, 160);

    expect(expansion.onExpandedChange).not.toHaveBeenCalled();
  });

  it("keeps the press from moving focus off the editor", () => {
    viewportMock.phone = true;
    renderShellWithEditor(makeExpansion(false), FITTING_EDITOR);

    const notCancelled = fireEvent.pointerDown(grabberOrThrow(), {
      clientY: 100,
      pointerId: 1,
    });

    expect(notCancelled).toBe(false);
  });

  it("puts the shell into its sheet state when expanded on phone", () => {
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
    // Not `fixed`: iOS draws no caret in a fixed sheet inside a chat tile.
    expect(shell?.className).not.toContain("fixed");
    expect(classTokens(overlay)).toContain("hidden");
    expect(editorFrame?.className).toContain("overflow-y-auto");
    // The dim is a sibling painted before the sheet, not part of it.
    const backdrop = shell?.previousElementSibling;
    expect(backdrop?.hasAttribute("data-composer-sheet-backdrop")).toBe(true);
    expect(backdrop?.className).toContain("fixed");
    expect(
      backdrop?.querySelector("[data-composer-sheet-slot]"),
    ).not.toBeNull();
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
