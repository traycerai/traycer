import { describe, expect, it } from "vitest";
import {
  dialogContentInertToPointer,
  interactionStartedOnOverlay,
} from "@/components/layout/dialogs/dialog-outside-guard";

// NOTE ON reproduction: jsdom does not drive Radix's `DismissableLayer`

describe("interactionStartedOnOverlay (backdrop-only close decision)", () => {
  function eventWithTarget(target: EventTarget | null): Event {
    // Mirror how Radix hands the guard `event.detail.originalEvent`: a pointerdown
    // whose `.target` is the element the gesture landed on (without re-parenting it).
    const event = new Event("pointerdown");
    Object.defineProperty(event, "target", { value: target });
    return event;
  }

  it("returns true for a pointer-down whose target IS the overlay (real backdrop click)", () => {
    const overlay = document.createElement("div");
    expect(interactionStartedOnOverlay(eventWithTarget(overlay), overlay)).toBe(
      true,
    );
  });

  it("returns true when the target is a descendant of the overlay", () => {
    const overlay = document.createElement("div");
    const child = document.createElement("span");
    overlay.appendChild(child);
    expect(interactionStartedOnOverlay(eventWithTarget(child), overlay)).toBe(
      true,
    );
  });

  it("returns false when the target is OUTSIDE the overlay (e.g. a portaled dropdown item)", () => {
    const overlay = document.createElement("div");
    const dropdownItem = document.createElement("button");
    document.body.appendChild(dropdownItem);
    expect(
      interactionStartedOnOverlay(eventWithTarget(dropdownItem), overlay),
    ).toBe(false);
    dropdownItem.remove();
  });

  it("returns false when there is no target or no overlay", () => {
    const overlay = document.createElement("div");
    expect(interactionStartedOnOverlay(eventWithTarget(null), overlay)).toBe(
      false,
    );
    expect(interactionStartedOnOverlay(eventWithTarget(overlay), null)).toBe(
      false,
    );
  });
});

describe("dialogContentInertToPointer (nested-layer-open detection)", () => {
  // Radix DismissableLayer puts inline `pointer-events: none` on the dialog Content exactly while a nested layer
  // with outside-pointer-events disabled (a modal DropdownMenu) sits above it.

  it("returns true while Radix has made the content inert (nested dropdown open)", () => {
    const content = document.createElement("div");
    content.style.pointerEvents = "none";
    expect(dialogContentInertToPointer(content)).toBe(true);
  });

  it("returns false when the content owns the pointer again (dialog is top layer)", () => {
    const content = document.createElement("div");
    content.style.pointerEvents = "auto";
    expect(dialogContentInertToPointer(content)).toBe(false);
  });

  it("returns false with no inline pointer-events or no content node", () => {
    const content = document.createElement("div");
    expect(dialogContentInertToPointer(content)).toBe(false);
    expect(dialogContentInertToPointer(null)).toBe(false);
  });
});
