import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

afterEach(() => {
  cleanup();
});

describe("<Dialog /> nested backdrop", () => {
  it("paints one backdrop per layer when a dialog opens inside another", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Outer</DialogTitle>
          <Dialog open>
            <DialogContent>
              <DialogTitle>Inner</DialogTitle>
            </DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>,
    );

    // Base UI's `DialogBackdrop` renders nothing for a nested dialog unless
    // `forceRender` is set, so an un-forced wrapper leaves the inner layer
    // with no dim of its own.
    expect(
      document.querySelectorAll('[data-slot="dialog-overlay"]'),
    ).toHaveLength(2);
  });
});
