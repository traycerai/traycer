import { describe, expect, it } from "vitest";
import {
  dialogContentInertToPointer,
  interactionStartedOnOverlay,
} from "@/components/layout/dialogs/dialog-outside-guard";

// NOTE ON REPRODUCTION: jsdom does not drive Radix's `DismissableLayer`
// pointer-down-outside path (no pointer-events hit-testing, no deferred
// dismissable-surface click sequencing), so the real "click out of the open
// dropdown closes the whole modal" flow can't be reproduced by dispatching a
// `pointerdown` here - a bare unguarded dialog does NOT dismiss on
// `fireEvent.pointerDown` in jsdom either. The pointer-down contract is therefore
// pinned on the guard's pure decision functions (`interactionStartedOnOverlay` +
// `dialogContentInertToPointer` - the modal may only close when the gesture
// started on the overlay AND the content was not inert at pointerdown); the
// wiring is exercised end-to-end in `promotable-modal-frame.test.tsx` via
// Escape, which jsdom DOES drive.

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
  // Radix DismissableLayer puts inline `pointer-events: none` on the dialog
  // Content exactly while a nested layer with outside-pointer-events disabled
  // (a modal DropdownMenu) sits above it. That is the moment when the overlay is
  // the hit-target for every click-out, so overlay-origin alone would wrongly
  // read "backdrop click" - this probe is what keeps the modal open then.

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
