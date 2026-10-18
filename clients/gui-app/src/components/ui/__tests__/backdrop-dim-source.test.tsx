import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ReactNode } from "react";

import { PromotableModalFrame } from "@/components/layout/dialogs/promotable-modal-frame";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  useBackdropDimStore,
  type OpenBackdrop,
} from "@/stores/layout/backdrop-dim-store";

// Every window overlay renders `BackdropDimSource` as its only child, which
// publishes the overlay in the backdrop store for as long as it is mounted
// (`JoinedTabDim` draws one layer per entry). These are the real overlays, so
// what is read is what the product registers.

function SharedDialog(props: { readonly open: boolean }): ReactNode {
  return (
    <Dialog open={props.open}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Dialog</DialogTitle>
      </DialogContent>
    </Dialog>
  );
}

function Frame(props: { readonly open: boolean }): ReactNode {
  return (
    <DialogPrimitive.Root open={props.open}>
      <PromotableModalFrame
        icon={null}
        title="Frame"
        contentClassName="h-1/4 w-1/4"
        dataAttributes={{}}
        promoteAriaLabel="Open as tab"
        promoteTestId="promote"
        closeTestId="close"
        onPromote={() => undefined}
        onClose={() => undefined}
        onEscapeKeyDown={() => undefined}
        onOpenAutoFocus={undefined}
      >
        {null}
      </PromotableModalFrame>
    </DialogPrimitive.Root>
  );
}

function Stack(props: {
  readonly frameOpen: boolean;
  readonly dialogOpen: boolean;
}): ReactNode {
  return (
    <>
      <Frame open={props.frameOpen} />
      <SharedDialog open={props.dialogOpen} />
    </>
  );
}

function backdrops(): readonly OpenBackdrop[] {
  return useBackdropDimStore.getState().backdrops;
}

function overlays(): readonly HTMLElement[] {
  return [
    ...document.body.querySelectorAll<HTMLElement>(
      '[data-slot="dialog-overlay"]',
    ),
  ];
}

/** Lets the overlay's `MutationObserver` deliver. */
async function settleObserver(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("BackdropDimSource", () => {
  beforeEach(() => {
    useBackdropDimStore.setState({ backdrops: [] });
  });

  afterEach(() => {
    cleanup();
    useBackdropDimStore.setState({ backdrops: [] });
  });

  it("registers an open shared dialog's overlay at strength 10", () => {
    render(<SharedDialog open />);

    expect(backdrops().map((backdrop) => backdrop.strength)).toEqual(["10"]);
    expect(backdrops()[0]?.closing).toBe(false);
  });

  it("registers nothing for a dialog that is not open", () => {
    render(<SharedDialog open={false} />);

    expect(backdrops()).toEqual([]);
  });

  it("registers an open modal frame's overlay at strength 30", () => {
    render(<Frame open />);

    expect(backdrops().map((backdrop) => backdrop.strength)).toEqual(["30"]);
  });

  it("registers stacked overlays in the order they opened, not by strength", () => {
    const { rerender } = render(<Stack frameOpen dialogOpen={false} />);
    rerender(<Stack frameOpen dialogOpen />);

    const stacked = backdrops();
    expect(stacked.map((backdrop) => backdrop.strength)).toEqual(["30", "10"]);
    expect(stacked[0]?.id).toBeLessThan(
      stacked[1]?.id ?? Number.NEGATIVE_INFINITY,
    );
  });

  it("registers two shared dialogs as two entries", () => {
    render(
      <>
        <SharedDialog open />
        <SharedDialog open />
      </>,
    );

    expect(backdrops().map((backdrop) => backdrop.strength)).toEqual([
      "10",
      "10",
    ]);
    expect(new Set(backdrops().map((backdrop) => backdrop.id)).size).toBe(2);
  });

  it("removes the entry once the overlay unmounts, and only that one", () => {
    const { rerender } = render(<Stack frameOpen dialogOpen />);
    expect(backdrops().map((backdrop) => backdrop.strength)).toEqual([
      "30",
      "10",
    ]);

    rerender(<Stack frameOpen dialogOpen={false} />);
    expect(overlays()).toHaveLength(1);
    expect(backdrops().map((backdrop) => backdrop.strength)).toEqual(["30"]);

    rerender(<Stack frameOpen={false} dialogOpen={false} />);
    expect(overlays()).toHaveLength(0);
    expect(backdrops()).toEqual([]);
  });

  it("removes the entries when the whole tree unmounts", () => {
    const { unmount } = render(<Stack frameOpen dialogOpen />);
    expect(backdrops()).toHaveLength(2);

    unmount();
    expect(backdrops()).toEqual([]);
  });

  it("follows the overlay's data-state in its closing flag", async () => {
    render(<SharedDialog open />);
    const overlay = overlays().at(0);
    if (overlay === undefined) throw new Error("the dialog overlay is missing");
    const id = backdrops()[0]?.id;
    expect(backdrops()[0]?.closing).toBe(false);

    overlay.setAttribute("data-state", "closed");
    await settleObserver();
    expect(backdrops()).toHaveLength(1);
    expect(backdrops()[0]?.id).toBe(id);
    expect(backdrops()[0]?.closing).toBe(true);

    overlay.setAttribute("data-state", "open");
    await settleObserver();
    expect(backdrops()[0]?.closing).toBe(false);
  });

  it("marks only the overlay whose state changed as closing", async () => {
    render(<Stack frameOpen dialogOpen />);
    const frameOverlay = overlays().at(0);
    const dialogOverlay = overlays().at(1);
    if (frameOverlay === undefined || dialogOverlay === undefined) {
      throw new Error("the stacked overlays are missing");
    }

    dialogOverlay.setAttribute("data-state", "closed");
    await settleObserver();

    expect(backdrops().map((backdrop) => backdrop.closing)).toEqual([
      false,
      true,
    ]);
  });
});
