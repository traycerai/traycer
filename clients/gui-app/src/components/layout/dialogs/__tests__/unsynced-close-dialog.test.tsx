import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnsyncedCloseDialog } from "@/components/layout/dialogs/unsynced-close-dialog";

// The dialog dismisses itself the moment its epic reads clean, so the
// registry has to report unsynced edits or the dialog would be measured after
// it had already closed.
vi.mock("@/lib/registries/epic-session-registry", () => ({
  epicHasUnsyncedEdits: () => true,
  getOpenEpicRegistry: () => ({
    subscribe: () => () => undefined,
  }),
}));

describe("UnsyncedCloseDialog", () => {
  afterEach(() => {
    cleanup();
  });

  // The tab-close confirmation is reached by closing a tab, which people do
  // constantly, and its destructive answer discards unsynced work. Radix's
  // FocusScope focuses the first tabbable descendant on open, and this
  // footer's DOM order puts the destructive "Close anyway" first, so without
  // the dialog's own `onOpenAutoFocus` it opens focused on the destructive
  // control (measured in a real browser: FOCUS_ON_OPEN =
  // epic-tab-unsynced-discard, TAB_ORDER = discard > wait > close-x).
  //
  // This is a jsdom test, not a browser one: Radix's focus scope resolves
  // "first tabbable descendant" from tabIndex and computed visibility, which
  // jsdom has, and the claim reads `document.activeElement` on open without
  // sending any input.
  it("opens focused on Keep open, not on Close anyway", async () => {
    render(
      <UnsyncedCloseDialog
        open
        epicId="epic-close-focus"
        onWait={() => undefined}
        onDiscard={() => undefined}
      />,
    );

    const keepOpen = await screen.findByTestId("epic-tab-unsynced-wait");
    const closeAnyway = screen.getByTestId("epic-tab-unsynced-discard");

    // The premise: both buttons are in the dialog, with the destructive one
    // first in DOM order - the order that put focus on it before the fix.
    expect(
      closeAnyway.compareDocumentPosition(keepOpen) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      "Close anyway must precede Keep open in DOM order, or this test no longer guards the fix",
    ).toBeGreaterThan(0);

    expect(
      document.activeElement,
      'the tab-close confirmation must open with focus on "Keep open"',
    ).toBe(keepOpen);
    expect(
      document.activeElement,
      'the tab-close confirmation must not open with focus on "Close anyway"',
    ).not.toBe(closeAnyway);
  });
});
