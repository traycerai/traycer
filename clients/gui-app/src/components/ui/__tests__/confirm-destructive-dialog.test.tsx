import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";

afterEach(() => {
  cleanup();
});

/**
 * A harness that owns `open` itself, exactly like every real caller of this
 * component (none renders a `DialogTrigger` - see the module comment on
 * `openerRef`): a plain button toggles `open` from outside the dialog's root.
 *
 * `hideOpener` is required, not optional - the lane's type-safety rule bans
 * optional props, and every call site states it explicitly (mirrors the
 * component under test's own `className={undefined}` style at
 * `confirm-destructive-dialog.tsx:173-177`). A SEPARATE "Remove opener"
 * button - not a side effect of opening - is what lets a test detach the
 * opener AFTER the dialog has already captured it, which is the only way to
 * actually reach the `isConnected` branch (see the detached-opener test
 * below for why batching removal into the same click as opening never does).
 */
function Harness(props: { readonly hideOpener: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  const [openerVisible, setOpenerVisible] = useState(true);
  return (
    <div>
      {openerVisible ? (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
          }}
        >
          Open
        </button>
      ) : null}
      {props.hideOpener ? (
        <button
          type="button"
          onClick={() => {
            setOpenerVisible(false);
          }}
        >
          Remove opener
        </button>
      ) : null}
      <ConfirmDestructiveDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete this?"
        description="This cannot be undone."
        cascadeSummary={null}
        actionLabel="Delete"
        isPending={false}
        blockedReason={null}
        onConfirm={() => {
          setOpen(false);
        }}
      />
    </div>
  );
}

describe("ConfirmDestructiveDialog - focus returns to the opener", () => {
  // Base defers the close-time focus restore past the synchronous
  // event-handler tick, so `document.activeElement` is NOT updated by the
  // time `fireEvent` returns - only `waitFor` (real timers) observes it.

  it("Escape returns focus to the button that opened the dialog", async () => {
    render(<Harness hideOpener={false} />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    // Prove initial focus actually left the opener before closing - Base's
    // initial focus is deferred, so an Escape fired too early would close a
    // dialog that never took focus in the first place, and the final
    // opener-focus assertion below would pass vacuously (see R3: a temporary
    // negative control that always disables `finalFocus` still passed all
    // three restoration tests here, because none of them proved focus had
    // ever left the opener).
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
    expect(document.activeElement).not.toBe(opener);
    // Negative control: forcing finalFocus to return false makes each of
    // the three restoration cases fail after focus has entered the dialog.
    fireEvent.keyDown(dialog, { key: "Escape" });
    // Popup removal and the queued focus restore are both async and
    // ordered - wait for the actual unmount before reading activeElement,
    // rather than a bare activeElement poll that could pass on a stale DOM.
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it("Cancel returns focus to the opener", async () => {
    render(<Harness hideOpener={false} />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
    expect(document.activeElement).not.toBe(opener);
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it("confirming (while the opener stays mounted) returns focus to the opener", async () => {
    render(<Harness hideOpener={false} />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
    expect(document.activeElement).not.toBe(opener);
    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it("a detached opener: closing does not throw, and focus lands on document.body - not a pin on the isConnected guard itself", async () => {
    // This does NOT distinguish the `isConnected` guard from its absence:
    // - WITH the guard, `finalFocus` returns `false` for a detached opener,
    //   so Base leaves focus where it already is - which by this point is
    //   document.body (removing the focused opener from the DOM resets
    //   activeElement to body immediately, before the dialog even closes);
    // - WITHOUT the guard, `finalFocus` would return the detached element,
    //   and Base's own `.focus()` call on a disconnected node is a silent
    //   DOM no-op -> focus stays wherever it already was, which is also
    //   document.body for the same reason above.
    // Both paths are observationally identical at this level, so this test
    // pins only "closing over a detached opener does not throw or hang".
    //
    // The guard's DISTINGUISHING consequence - a caller supplying its own
    // replacement focus target - is pinned by `fallback-danger-zone.test.tsx`'s
    // `focusResetOnMount` pair at the component level, and end to end by the
    // panel suite's "R3: a reset refused AFTER the dialog has closed..." and
    // "a confirmed reset returns focus to the remounted Reset button" cases.
    // It is NOT pinned by the panel's other confirmed-reset test, which asserts
    // policy values only and says nothing about focus - this comment claimed it
    // did, and the coverage walk had already recorded that half as open.
    render(<Harness hideOpener />);
    const opener = screen.getByRole("button", { name: "Open" });
    // Both controls are resolved BEFORE the dialog opens: a modal dialog
    // marks the rest of the document inert, so a role query cannot reach
    // anything outside it once it is up.
    const removeOpener = screen.getByRole("button", { name: "Remove opener" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog")).not.toBeNull();
    // Detach the opener NOW, while the dialog is open and has already
    // captured it as the return-focus target - a separate click from the
    // one that opened the dialog, so this is not batched into the same
    // commit.
    fireEvent.click(removeOpener);
    // The precondition this case exists for, stated directly: the dialog
    // captured a CONNECTED opener and it is detached by the time the close
    // handler runs. Without this the test would silently degrade into the
    // "nothing was ever captured" case, which takes a different branch.
    expect(opener.isConnected).toBe(false);

    fireEvent.click(screen.getByTestId("confirm-cancel"));
    await waitFor(() => {
      expect(document.activeElement).toBe(document.body);
    });
  });
});

describe("ConfirmDestructiveDialog - confirm gating", () => {
  it("disables confirm and renders the reason when blocked", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDestructiveDialog
        open
        onOpenChange={vi.fn()}
        title="Delete this?"
        description="This cannot be undone."
        cascadeSummary={null}
        actionLabel="Delete"
        isPending={false}
        blockedReason="Deselect the row still using this."
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByTestId("confirm-blocked-reason").textContent).toBe(
      "Deselect the row still using this.",
    );
    expect(
      screen.getByTestId<HTMLButtonElement>("confirm-action").disabled,
    ).toBe(true);
    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
