import { afterEach, describe, expect, it } from "vitest";
import { preserveWhenNestedOverlay } from "../preserve-when-nested-overlay";

/**
 * Runs the handler as a real listener so the dispatched event carries a `target`
 * and `preventDefault()` takes effect during dispatch. Returns whether the
 * popover would be PRESERVED (default prevented) or allowed to dismiss.
 */
function interactOutside(
  target: Element,
  contentEl: HTMLElement | null,
): boolean {
  const event = new Event("interactoutside", { cancelable: true });
  const handler = (e: Event): void => preserveWhenNestedOverlay(e, contentEl);
  target.addEventListener("interactoutside", handler);
  target.dispatchEvent(event);
  target.removeEventListener("interactoutside", handler);
  return event.defaultPrevented;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("preserveWhenNestedOverlay", () => {
  // body order: ancestor dialog (opened first) → popover content → stacked
  // overlay (opened from within the popover, so appended later).
  function buildTree(): {
    readonly content: HTMLElement;
    readonly ancestorClick: HTMLElement;
    readonly ancestorOverlay: HTMLElement;
    readonly stackedClick: HTMLElement;
    readonly outside: HTMLElement;
  } {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const ancestorClick = document.createElement("button");
    dialog.appendChild(ancestorClick);

    const ancestorOverlay = document.createElement("div");
    ancestorOverlay.setAttribute("data-slot", "dialog-overlay");

    const content = document.createElement("div");
    content.setAttribute("data-slot", "popover-content");

    const stacked = document.createElement("div");
    stacked.setAttribute("role", "listbox");
    const stackedClick = document.createElement("div");
    stacked.appendChild(stackedClick);

    const outside = document.createElement("div");

    // Append in open order: dialog + its overlay precede the popover content;
    // the stacked listbox (a Select opened inside the popover) follows it.
    document.body.append(dialog, ancestorOverlay, content, stacked, outside);
    return { content, ancestorClick, ancestorOverlay, stackedClick, outside };
  }

  it("dismisses when the click lands in the ancestor dialog that hosts the trigger", () => {
    const { content, ancestorClick } = buildTree();
    expect(interactOutside(ancestorClick, content)).toBe(false);
  });

  it("dismisses when the click lands on the ancestor dialog's backdrop", () => {
    const { content, ancestorOverlay } = buildTree();
    expect(interactOutside(ancestorOverlay, content)).toBe(false);
  });

  it("preserves when the click lands in an overlay stacked above the popover", () => {
    const { content, stackedClick } = buildTree();
    expect(interactOutside(stackedClick, content)).toBe(true);
  });

  it("dismisses for a plain outside click in no overlay", () => {
    const { content, outside } = buildTree();
    expect(interactOutside(outside, content)).toBe(false);
  });

  it("falls back to preserving any matched overlay when the content node is unknown", () => {
    const { ancestorClick } = buildTree();
    expect(interactOutside(ancestorClick, null)).toBe(true);
  });
});
