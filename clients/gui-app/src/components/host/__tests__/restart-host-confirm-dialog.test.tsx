import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RestartHostConfirmDialog } from "@/components/host/restart-host-confirm-dialog";

/**
 * `HostRestartSessions` pulls in `useFocusModel`, the terminal registry and
 * the epic canvas store - none of which this suite is about. It is replaced
 * with a stand-in that exposes exactly the one prop under test here:
 * `onNavigate`, wired to a button so a click can drive the same
 * navigation-close path a real session link's successful navigation takes.
 */
vi.mock("@/components/host/host-restart-sessions", () => ({
  HostRestartSessions: (props: { readonly onNavigate: () => void }) => (
    <button type="button" onClick={props.onNavigate}>
      Fake session link
    </button>
  ),
}));

afterEach(() => {
  cleanup();
});

/**
 * Mirrors the harness in `confirm-destructive-dialog.test.tsx`: a plain
 * button outside the dialog's root owns `open`, since no real caller renders
 * a `DialogTrigger`.
 */
function Harness(): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <RestartHostConfirmDialog
        hostId="host-a"
        open={open}
        isPending={false}
        onOpenChange={setOpen}
        onConfirm={() => {
          setOpen(false);
        }}
      />
    </div>
  );
}

/**
 * Opens the dialog from `opener` and closes it via the fake session link's
 * navigation, then flushes Radix's deferred `onCloseAutoFocus` macrotask for
 * real (`setTimeout(..., 0)`) before returning.
 *
 * The flush is not optional here: the assertion this sets up for
 * (`document.activeElement === document.body`) is also the state BEFORE the
 * macrotask ever runs, so a `waitFor` wrapped around it would resolve on its
 * first synchronous check and could pass even if the deferred handler later
 * (wrongly) refocused the opener. Flushing first, then asserting
 * synchronously, is the only way to observe the settled state. Mirrors
 * `fallback-danger-zone.test.tsx`'s `await act(async () => { await new
 * Promise((resolve) => setTimeout(resolve, 0)); });` convention.
 */
async function closeViaNavigationAndFlush(opener: HTMLElement): Promise<void> {
  opener.focus();
  fireEvent.click(opener);
  fireEvent.click(screen.getByRole("button", { name: "Fake session link" }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("RestartHostConfirmDialog - navigation-close focus suppression", () => {
  it("a session link's navigation close does not restore focus to the opener", async () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    await closeViaNavigationAndFlush(opener);

    expect(screen.queryByRole("dialog")).toBeNull();
    // Falsification: drop `navigationCloseRef` (or its `event.preventDefault()`
    // call) in `restart-host-confirm-dialog.tsx` - `ConfirmDestructiveDialog`'s
    // own `onCloseAutoFocus` would then run its default branch and refocus the
    // still-connected opener.
    expect(document.activeElement).toBe(document.body);
  });

  it("a Cancel close on the open immediately following a navigation close still restores focus to the opener", async () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    // Flushed BEFORE reopening, not only before asserting: reopening while the
    // first close's macrotask is still pending would let it fire against the
    // freshly-reopened dialog's state instead of the one it belongs to.
    await closeViaNavigationAndFlush(opener);
    expect(document.activeElement).toBe(document.body);

    // Falsification: fail to reset `navigationCloseRef.current` to `false`
    // after consuming it - this reopen's Cancel would then also skip
    // restoring focus, showing the suppression was not actually one-shot.
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    // `waitFor` here (rather than an explicit flush) is fine: the assertion
    // is a state distinct from the pre-flush default (`opener`, not `body`),
    // so a passing `waitFor` genuinely observed the deferred handler run -
    // matches `confirm-destructive-dialog.test.tsx`'s convention for the same
    // positive assertion.
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it("an Escape close on the open immediately following a navigation close still restores focus to the opener", async () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    await closeViaNavigationAndFlush(opener);
    expect(document.activeElement).toBe(document.body);

    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });
});
