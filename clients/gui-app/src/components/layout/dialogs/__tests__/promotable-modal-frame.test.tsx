import { useRef, type ReactElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "@/components/ui/dialog";
import { PromotableModalFrame } from "@/components/layout/dialogs/promotable-modal-frame";

// Escape dismissal now runs through the Root's own `onOpenChange` reason
// ("escape-key"), which jsdom drives end-to-end - unlike an outside-press
// gesture, which needs real hit-testing (covered instead by the frame-
// ownership behaviour gate, `nestedChecks()` in
// `scripts/primitive-gate-browser.mjs`, against a real browser). The Root
// is the app's own `Dialog` wrapper (`@/components/ui/dialog`), matching
// every real caller (`SystemTabModalHost` et al.) - `PromotableModalFrame`
// itself owns no Root.
function Harness(props: {
  readonly onOpenChange: (open: boolean, details: { reason: string }) => void;
}): ReactElement {
  const backdropRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog open onOpenChange={props.onOpenChange}>
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
        backdropRef={backdropRef}
        initialFocus
      >
        <div data-testid="modal-body">body</div>
      </PromotableModalFrame>
    </Dialog>
  );
}

describe("PromotableModalFrame", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the framed chrome (title + promote/close) around its body", () => {
    render(<Harness onOpenChange={vi.fn()} />);
    screen.getByText("Settings");
    screen.getByTestId("promote");
    screen.getByTestId("close");
    screen.getByTestId("modal-body");
  });

  it("still closes on Escape", () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ reason: "escape-key" }),
    );
  });
});
