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
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";

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
          onEscapeKeyDown={() => {}}
          onOpenAutoFocus={undefined}
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

  // The frame lies over the side strip's and header's window-drag regions,
  // which Electron resolves before the DOM: without a suppressor the frame's
  // bottom-left corner (Settings' Host rows) took no clicks.
  it("suppresses the window drag regions for exactly as long as it is up", () => {
    expect(useTitleBarDragStore.getState().suppressors.size).toBe(0);
    renderFrame(vi.fn());
    expect(useTitleBarDragStore.getState().suppressors.size).toBe(1);
    cleanup();
    expect(useTitleBarDragStore.getState().suppressors.size).toBe(0);
  });

  it("still closes on Escape (Escape is deliberately NOT guarded)", async () => {
    const onOpenChange = vi.fn();
    renderFrame(onOpenChange);
    await waitForDismissableLayerListener();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
