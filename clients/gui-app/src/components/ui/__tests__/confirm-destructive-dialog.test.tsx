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
  // Radix's FocusScope defers the whole close-time restore to a macrotask
  // (`@radix-ui/react-focus-scope`'s unmount cleanup wraps it in
  // `setTimeout(..., 0)`), so `document.activeElement` is NOT updated by the
  // time `fireEvent` returns - only `waitFor` (real timers) observes it.

  it("Escape returns focus to the button that opened the dialog", async () => {
    render(<Harness hideOpener={false} />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    // Falsification: delete the `onCloseAutoFocus` handler entirely (or its
    // `event.preventDefault()` call) in `confirm-destructive-dialog.tsx` -
    // Radix's own null-trigger focus restoration would then drop focus on
    // `document.body` instead of the opener.
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it("Cancel returns focus to the opener", async () => {
    render(<Harness hideOpener={false} />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it("confirming (while the opener stays mounted) returns focus to the opener", async () => {
    render(<Harness hideOpener={false} />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it("a detached opener: closing does not throw, and focus lands on document.body - not a pin on the isConnected guard itself", async () => {
    // This does NOT distinguish the `isConnected` guard from its absence:
    // - WITH the guard, we skip `.focus()` and fall through to Radix's own
    //   handler, which (default not prevented, since we returned early) then
    //   focuses its null trigger -> document.body;
    // - WITHOUT the guard, we call `.focus()` on a detached element, which is
    //   a silent DOM no-op -> focus stays wherever it already was, which by
    //   this point is also document.body (removing the focused opener from
    //   the DOM resets activeElement to body immediately, before the dialog
    //   even closes).
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
    // Both controls are resolved BEFORE the dialog opens: a modal Radix dialog
    // marks the rest of the document `aria-hidden`, so a role query cannot
    // reach anything outside it once it is up.
    const removeOpener = screen.getByRole("button", { name: "Remove opener" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog")).not.toBeNull();
    // Detach the opener NOW, while the dialog is open and has already
    // captured it in `onOpenAutoFocus` - a separate click from the one that
    // opened the dialog, so this is not batched into the same commit.
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

describe("ConfirmDestructiveDialog - dismissable while pending", () => {
  function renderPending(
    isPending: boolean,
    dismissableWhilePending: boolean | undefined,
  ) {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDestructiveDialog
        open
        onOpenChange={onOpenChange}
        title="Delete this?"
        description="This cannot be undone."
        cascadeSummary={null}
        actionLabel="Delete"
        isPending={isPending}
        dismissableWhilePending={dismissableWhilePending}
        blockedReason={null}
        onConfirm={onConfirm}
      />,
    );
    return { onOpenChange, onConfirm };
  }

  it("locks Cancel and Escape while pending by default", () => {
    const { onOpenChange } = renderPending(true, undefined);
    const cancel = screen.getByTestId<HTMLButtonElement>("confirm-cancel");
    expect(cancel.disabled).toBe(true);
    expect(cancel.textContent).toBe("Cancel");
    expect(
      screen.getByTestId<HTMLButtonElement>("confirm-action").disabled,
    ).toBe(true);
    fireEvent.keyDown(screen.getByTestId("confirm-destructive-dialog"), {
      key: "Escape",
    });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("stays locked while pending when dismissableWhilePending is false", () => {
    const { onOpenChange } = renderPending(true, false);
    const cancel = screen.getByTestId<HTMLButtonElement>("confirm-cancel");
    expect(cancel.disabled).toBe(true);
    expect(cancel.textContent).toBe("Cancel");
    fireEvent.keyDown(screen.getByTestId("confirm-destructive-dialog"), {
      key: "Escape",
    });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("lets the user close while pending when dismissableWhilePending is set", () => {
    const { onOpenChange, onConfirm } = renderPending(true, true);
    const cancel = screen.getByTestId<HTMLButtonElement>("confirm-cancel");
    expect(cancel.disabled).toBe(false);
    expect(cancel.textContent).toBe("Close");
    fireEvent.click(cancel);
    expect(onOpenChange).toHaveBeenCalledWith(false);

    onOpenChange.mockClear();
    fireEvent.keyDown(screen.getByTestId("confirm-destructive-dialog"), {
      key: "Escape",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);

    expect(
      screen.getByTestId<HTMLButtonElement>("confirm-action").disabled,
    ).toBe(true);
    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps the Cancel label when not pending, even if dismissableWhilePending is set", () => {
    renderPending(false, true);
    const cancel = screen.getByTestId<HTMLButtonElement>("confirm-cancel");
    expect(cancel.disabled).toBe(false);
    expect(cancel.textContent).toBe("Cancel");
  });
});

/**
 * Mirrors a real caller that keeps the dialog dismissable while its action
 * runs: opening also starts the pending window, and the opener is disabled for
 * it. `withSurface` states explicitly whether the opener sits inside a
 * focusable (`tabindex`) ancestor, standing in for the Settings dialog content.
 */
function PendingOpenerHarness(props: {
  readonly withSurface: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const opener = (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        setOpen(true);
        setPending(true);
      }}
    >
      Open
    </button>
  );
  return (
    <div>
      {props.withSurface ? (
        <div tabIndex={-1} data-testid="surface">
          {opener}
        </div>
      ) : (
        opener
      )}
      <ConfirmDestructiveDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete this?"
        description="This cannot be undone."
        cascadeSummary={null}
        actionLabel="Delete"
        isPending={pending}
        dismissableWhilePending
        blockedReason={null}
        onConfirm={() => {
          setOpen(false);
        }}
      />
    </div>
  );
}

describe("ConfirmDestructiveDialog - focus when the opener is disabled at close", () => {
  it("returns focus to the opener's nearest [tabindex] ancestor", async () => {
    render(<PendingOpenerHarness withSurface />);
    const opener = screen.getByRole("button", { name: "Open" });
    const surface = screen.getByTestId("surface");
    opener.focus();
    fireEvent.click(opener);
    expect(opener.matches(":disabled")).toBe(true);
    // Falsification: replace the `closest("[tabindex]")` fallback in
    // `confirm-destructive-dialog.tsx` with `null` - focus then lands on
    // `document.body`.
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    await waitFor(() => {
      expect(document.activeElement).toBe(surface);
    });
  });

  it("with no [tabindex] ancestor, closing does not throw and focus ends on document.body", async () => {
    render(<PendingOpenerHarness withSurface={false} />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    expect(opener.matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(document.body);
    });
  });
});

/**
 * The cascade paragraph's one sentence frame. `cascadeNestedUnder` is optional
 * because a caller deleting a single target has nothing to say about it, and
 * that default is what the mobile switcher relies on - so it needs a witness
 * here rather than only at the sidebar sites, which all pass it explicitly.
 */
describe("ConfirmDestructiveDialog - the cascade sentence", () => {
  function renderWithCascade(
    cascadeNestedUnder: "it" | "them" | undefined,
  ): string {
    render(
      <ConfirmDestructiveDialog
        open
        onOpenChange={() => {}}
        title="Delete these?"
        description="This cannot be undone."
        cascadeSummary="2 tickets"
        cascadeNestedUnder={cascadeNestedUnder}
        actionLabel="Delete"
        isPending={false}
        blockedReason={null}
        onConfirm={() => {}}
      />,
    );
    return screen.getByTestId("confirm-cascade-meta").textContent;
  }

  it("addresses one target as it when the caller says nothing", () => {
    expect(renderWithCascade(undefined)).toBe(
      "This will also delete 2 tickets nested under it.",
    );
  });

  it("addresses a selection as them", () => {
    expect(renderWithCascade("them")).toBe(
      "This will also delete 2 tickets nested under them.",
    );
  });
});
