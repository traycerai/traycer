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

// The guard's pure decision functions (`interactionStartedOnOverlay` +
// `dialogContentInertToPointer`) are unit-tested in `dialog-outside-guard.test.ts`.
// jsdom does not drive Radix's `DismissableLayer` pointer-down-outside path (no
// pointer-events hit-testing, no deferred dismissable-surface click sequencing),
// so the real "click out of the open dropdown closes the whole modal" flow can't
// be reproduced here by dispatching a `pointerdown` - a bare unguarded dialog
// does NOT dismiss on `fireEvent.pointerDown` in jsdom either. This file only
// exercises the wiring via Escape, which jsdom DOES drive end-to-end.

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
