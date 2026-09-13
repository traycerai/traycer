import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FallbackDangerZone } from "@/components/settings/panels/fallback/fallback-danger-zone";

afterEach(() => {
  cleanup();
});

function openConfirmDialog(): void {
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
}

describe("FallbackDangerZone - confirm dialog scope", () => {
  it("names the host when one is resolved", () => {
    render(
      <FallbackDangerZone
        hostLabel="Anurag's MacBook"
        isPending={false}
        onConfirm={vi.fn()}
        focusResetOnMount={false}
        onFocusApplied={vi.fn()}
        status={null}
      />,
    );
    openConfirmDialog();
    expect(
      screen.getByText(/Applies to your chat agents on Anurag's MacBook\./),
    ).not.toBeNull();
  });

  it("drops the scope clause entirely when no host is resolved, rather than naming 'No host'", () => {
    render(
      <FallbackDangerZone
        hostLabel={null}
        isPending={false}
        onConfirm={vi.fn()}
        focusResetOnMount={false}
        onFocusApplied={vi.fn()}
        status={null}
      />,
    );
    openConfirmDialog();
    // The negative pin: stub `resetConfirmDescription` to always append the
    // host clause (or to render "on No host" for a null label) and this
    // assertion goes red.
    expect(screen.queryByText(/Applies to your chat agents on/)).toBeNull();
    // Positive control: the dialog still rendered its (host-independent)
    // description, so the absence above is the clause missing, not the
    // dialog failing to open.
    expect(screen.getByText(/Turns automatic fallback off/)).not.toBeNull();
  });

  it("invokes onConfirm only after the destructive action is confirmed, not on opening the dialog", () => {
    const onConfirm = vi.fn();
    render(
      <FallbackDangerZone
        hostLabel="Local host"
        isPending={false}
        onConfirm={onConfirm}
        focusResetOnMount={false}
        onFocusApplied={vi.fn()}
        status={null}
      />,
    );
    openConfirmDialog();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("FallbackDangerZone - F26 focus return after a confirmed reset", () => {
  it("focusResetOnMount focuses the Reset button on mount and calls onFocusApplied exactly once", () => {
    const onFocusApplied = vi.fn();
    render(
      <FallbackDangerZone
        hostLabel="Local host"
        isPending={false}
        onConfirm={vi.fn()}
        focusResetOnMount
        onFocusApplied={onFocusApplied}
        status={null}
      />,
    );
    // Falsification: delete the `resetButtonRef.current?.focus()` call in the
    // mount effect (`fallback-danger-zone.tsx`) - this would leave focus
    // wherever it started (`document.body` in this harness) instead of on
    // Reset.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Reset" }),
    );
    expect(onFocusApplied).toHaveBeenCalledTimes(1);
  });

  it("focusResetOnMount: false focuses nothing and never calls onFocusApplied", () => {
    const onFocusApplied = vi.fn();
    render(
      <FallbackDangerZone
        hostLabel="Local host"
        isPending={false}
        onConfirm={vi.fn()}
        focusResetOnMount={false}
        onFocusApplied={onFocusApplied}
        status={null}
      />,
    );
    expect(document.activeElement).not.toBe(
      screen.getByRole("button", { name: "Reset" }),
    );
    expect(onFocusApplied).not.toHaveBeenCalled();
  });
});

/**
 * The parent, for the R-OSS-2 cells: a sibling text field plus the Danger Zone.
 *
 * The sibling exists so 4b has somewhere real for the keyboard to be. This
 * component holds no state of its own - see {@link renderResetHarness} for why
 * `isPending` is driven from outside instead.
 */
function Harness(props: { readonly isPending: boolean }): ReactNode {
  return (
    <>
      <input aria-label="Sibling field" />
      <FallbackDangerZone
        hostLabel="Local host"
        isPending={props.isPending}
        onConfirm={() => {}}
        focusResetOnMount={false}
        onFocusApplied={vi.fn()}
        status={null}
      />
    </>
  );
}

/**
 * Drives the SECOND `useEffect` in `fallback-danger-zone.tsx` - the one keyed
 * on `isPending` falling, which restores focus to Reset when a CONFIRMED reset
 * settles without replacing the whole editor (in practice, a refusal).
 *
 * The macrotask wait each cell does after confirming mirrors the panel's own R3
 * cell (`fallback-settings-panel.test.tsx`): confirming closes the dialog and
 * starts the request in one gesture, and Radix defers `onCloseAutoFocus` to a
 * `setTimeout(0)` - a tick after that render - so it finds the Reset button
 * already `disabled={isPending}` and its own restoration silently no-ops,
 * landing focus on `document.body`. Without waiting that macrotask out first, a
 * cell would settle before Radix's own attempt had even run, and would not be
 * exercising the sequence the effect exists to repair.
 *
 * ## `isPending` is driven by RERENDER, not by state inside the harness
 *
 * The first version of this held `useState` in `Harness` and published the
 * setter by assigning a closure variable from the component body. That is an
 * outer-variable write DURING RENDER, which this workspace's lint bans outright
 * (see `clients/gui-app/AGENTS.md`) - and the ban is right on the merits here,
 * not merely satisfiable: under `StrictMode`'s double render the assignment
 * happens twice per commit, and which of the two setters the closure ends up
 * holding is an implementation detail of the reconciler.
 *
 * Driving the prop from outside is also the more honest model. `isPending` IS a
 * controlled prop in production - the panel derives it from the mutation - so a
 * test that flips it explicitly is simulating the parent, which is exactly what
 * these two cells are about. `onConfirm` is a no-op for the same reason: the
 * component sets its own internal awaiting-reset flag inside the dialog's
 * confirm handler, before calling out, so it does not depend on the parent
 * having re-rendered yet.
 */
function renderResetHarness(): {
  startPending: () => void;
  settle: () => void;
} {
  const view = render(<Harness isPending={false} />);
  return {
    startPending: () => {
      view.rerender(<Harness isPending />);
    },
    settle: () => {
      view.rerender(<Harness isPending={false} />);
    },
  };
}

describe("FallbackDangerZone - R-OSS-2 recovery: focus after a CONFIRMED reset settles", () => {
  it("puts focus back on Reset when a confirmed reset settles and nothing else has claimed the keyboard", async () => {
    const { startPending, settle } = renderResetHarness();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByTestId("confirm-action"));
    // The parent starts the mutation in the SAME gesture that confirms, which
    // is what disables the opener before Radix gets to restore focus to it.
    act(() => {
      startPending();
    });

    // Let Radix's deferred `onCloseAutoFocus` run and land its own silent
    // no-op on the now-disabled button - the state this effect exists to
    // repair, not one this test hand-simulates.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Admission evidence: Radix really did leave the keyboard nowhere. If this
    // is ever false the cell below is asserting a recovery from a state that
    // did not occur, and would pass with the effect deleted.
    expect(document.activeElement).toBe(document.body);

    act(() => {
      settle();
    });

    // Falsification: delete the second `useEffect` in
    // `fallback-danger-zone.tsx` entirely. Nothing then moves focus after the
    // reset settles - Radix already spent its restoration on a disabled
    // button - and `document.activeElement` stays `document.body`.
    await waitFor(() => {
      const reset = screen.getByRole("button", { name: "Reset" });
      expect(reset.hasAttribute("disabled")).toBe(false);
      expect(document.activeElement).toBe(reset);
    });
  });

  it("leaves focus alone when the user has moved to another control while the reset was pending", async () => {
    const { startPending, settle } = renderResetHarness();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByTestId("confirm-action"));
    act(() => {
      startPending();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The user has moved on while the reset was still in flight - a
    // deliberate gesture that outranks a deferred restoration.
    const sibling = screen.getByLabelText<HTMLInputElement>("Sibling field");
    act(() => {
      sibling.focus();
    });
    expect(document.activeElement).toBe(sibling);

    act(() => {
      settle();
    });

    // Falsification: drop the `active !== null && active !== document.body`
    // guard so the effect restores focus unconditionally. The sibling field
    // would then lose focus to Reset the moment the reset settles, which is
    // exactly the "steals focus mid-edit" defect R-OSS-2 exists to prevent.
    expect(document.activeElement).toBe(sibling);
  });
});
