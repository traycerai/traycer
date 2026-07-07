import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog as DialogPrimitive } from "radix-ui";
import { PromotableModalFrame } from "@/components/layout/dialogs/promotable-modal-frame";
import { interactionStartedOnOverlay } from "@/components/layout/dialogs/dialog-outside-guard";

// NOTE ON REPRODUCTION: jsdom does not drive Radix's `DismissableLayer`
// pointer-down-outside path (its pointer-capture / event sequencing is absent), so
// the original "click outside the open dropdown closes the whole modal" race can't
// be reproduced by dispatching a `pointerdown` here - a bare unguarded dialog does
// NOT dismiss on `fireEvent.pointerDown` in jsdom either. The pointer-down contract
// is therefore pinned on the guard's pure decision function
// (`interactionStartedOnOverlay`), and the wiring is exercised via Escape, which
// jsdom DOES drive end-to-end.

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

describe("PromotableModalFrame", () => {
  afterEach(() => {
    cleanup();
  });

  async function waitForDismissableLayerListener(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }

  function renderFrame(onOpenChange: (open: boolean) => void): void {
    render(
      <DialogPrimitive.Root open onOpenChange={onOpenChange}>
        <PromotableModalFrame
          icon={<span data-testid="icon" />}
          title="Settings"
          contentClassName="h-[80vh] w-[80vw]"
          dataAttributes={{}}
          promoteAriaLabel="Open Settings as a tab"
          promoteTestId="promote"
          closeTestId="close"
          onPromote={() => {}}
          onClose={() => {}}
        >
          <div data-testid="modal-body">body</div>
        </PromotableModalFrame>
      </DialogPrimitive.Root>,
    );
  }

  it("renders the framed chrome (title + promote/close) around its body", () => {
    renderFrame(vi.fn());
    screen.getByText("Settings");
    screen.getByTestId("promote");
    screen.getByTestId("close");
    screen.getByTestId("modal-body");
  });

  it("still closes on Escape (Escape is deliberately NOT guarded)", async () => {
    const onOpenChange = vi.fn();
    renderFrame(onOpenChange);
    await waitForDismissableLayerListener();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
