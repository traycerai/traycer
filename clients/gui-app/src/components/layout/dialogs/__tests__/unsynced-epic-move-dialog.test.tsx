import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnsyncedEpicMoveDialog } from "@/components/layout/dialogs/unsynced-epic-move-dialog";
import type { EpicNewWindowFlow } from "@/components/layout/hooks/use-epic-open-in-new-window";

// The dialog dismisses itself the moment its epic reads clean, so the
// registry has to report unsynced edits or the dialog would be measured after
// it had already closed.
vi.mock("@/lib/registries/epic-session-registry", () => ({
  epicHasUnsyncedEdits: () => true,
  getOpenEpicRegistry: () => ({
    subscribe: () => () => undefined,
  }),
}));

// A plain object: `EpicNewWindowFlow` is an interface, and only `pendingMove`
// (which opens the dialog) is read on the way in.
const FLOW: EpicNewWindowFlow = {
  isAvailable: true,
  pendingMove: {
    epicId: "epic-move-focus",
    tabId: "tab-move-focus",
    title: "Rewrite the onboarding",
  },
  requestOpenInNewWindow: () => undefined,
  waitForSync: () => undefined,
  cancelMove: () => undefined,
  discardAndMove: () => undefined,
};

describe("UnsyncedEpicMoveDialog", () => {
  afterEach(() => {
    cleanup();
  });

  // Moving an epic to a new window is offered from a context menu, and its
  // destructive answer discards unsynced work. Radix's FocusScope focuses the
  // first tabbable descendant on open, and this footer's DOM order puts the
  // destructive "Discard and move" first, so without the dialog's own
  // `onOpenAutoFocus` it opens focused on the destructive control - the
  // failure its tab-close sibling (`unsynced-close-dialog`) was measured to
  // have in a real browser.
  //
  // A jsdom test, for the same reason as the sibling's: Radix's focus scope
  // resolves "first tabbable descendant" from tabIndex and computed
  // visibility, which jsdom has, and the claim reads `document.activeElement`
  // on open without sending any input.
  it("opens focused on Wait for sync, not on Discard and move", async () => {
    render(<UnsyncedEpicMoveDialog flow={FLOW} />);

    const waitForSync = await screen.findByTestId("epic-move-unsynced-wait");
    const discardAndMove = screen.getByTestId("epic-move-unsynced-discard");

    // The premise: both buttons are in the dialog, with the destructive one
    // first in DOM order - the order that puts focus on it without the fix.
    expect(
      discardAndMove.compareDocumentPosition(waitForSync) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      "Discard and move must precede Wait for sync in DOM order, or this test no longer guards the fix",
    ).toBeGreaterThan(0);

    expect(
      document.activeElement,
      'the epic-move confirmation must open with focus on "Wait for sync"',
    ).toBe(waitForSync);
    expect(
      document.activeElement,
      'the epic-move confirmation must not open with focus on "Discard and move"',
    ).not.toBe(discardAndMove);
  });
});
