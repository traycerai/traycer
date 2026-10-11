import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, type ComponentProps } from "react";
import { RevertOnEditDialog } from "@/components/chat/segments/revert-on-edit-dialog";

const onOpenChange = vi.fn();
const onRevert = vi.fn();
const onDontRevert = vi.fn();

// jsdom has no `CSS.escape` - Presence's real animationend handler calls it.
if (typeof CSS === "undefined") {
  Object.assign(globalThis, { CSS: { escape: (value: string) => value } });
}

// W2-F latch: the wrapper never renders `<Dialog>` at all before the first
// open, and once opened, keeps it mounted through every later close - so
// Radix's own Presence-driven exit animation on `DialogContent` (not our
// wrapper) decides when the subtree actually leaves the DOM. Counting
// `DialogPrimitive.Root`-equivalent mounts/unmounts (not "is content in the
// DOM", which is true either way once closed) is the instrument that
// distinguishes a latched root from a wrapper that keeps unmounting it.
const dialogMountEvents = { mounts: 0, unmounts: 0 };

beforeEach(() => {
  dialogMountEvents.mounts = 0;
  dialogMountEvents.unmounts = 0;
});

vi.mock(import("@/components/ui/dialog"), async (importOriginal) => {
  const actual = await importOriginal();
  function InstrumentedDialog(props: ComponentProps<typeof actual.Dialog>) {
    useEffect(() => {
      dialogMountEvents.mounts += 1;
      return () => {
        dialogMountEvents.unmounts += 1;
      };
    }, []);
    return <actual.Dialog {...props} />;
  }
  return { ...actual, Dialog: InstrumentedDialog };
});

function renderDialog(open: boolean) {
  return (
    <RevertOnEditDialog
      open={open}
      onOpenChange={onOpenChange}
      onRevert={onRevert}
      onDontRevert={onDontRevert}
      artifactCount={2}
      queuedCount={0}
    />
  );
}

describe("<RevertOnEditDialog /> opt-out reset", () => {
  afterEach(() => {
    cleanup();
  });

  it("resets 'Also revert artifacts' to checked each time it reopens", () => {
    const { rerender } = render(renderDialog(true));

    const checkbox = () =>
      screen.getByRole("checkbox", { name: /also revert/i });
    expect(checkbox().getAttribute("aria-checked")).toBe("true");

    // User opts out for this edit.
    fireEvent.click(checkbox());
    expect(checkbox().getAttribute("aria-checked")).toBe("false");

    // Close, then reopen for a DIFFERENT edit: once latched mounted (see the
    // root-mount test below), the dialog must not carry the prior opt-out -
    // it resets to checked via the previousOpen render-state adjustment.
    rerender(renderDialog(false));
    rerender(renderDialog(true));
    expect(checkbox().getAttribute("aria-checked")).toBe("true");
  });

  it("mounts no Dialog root before the first open, then latches it mounted through a close", () => {
    const { rerender, container } = render(renderDialog(false));

    expect(dialogMountEvents.mounts).toBe(0);
    expect(dialogMountEvents.unmounts).toBe(0);
    expect(container.innerHTML).toBe("");

    // jsdom has no real CSS engine, so Presence's own animation-name check
    // would read "none" and skip the exit state entirely. Fake just that one
    // property, live off the dialog's own `data-state`, so Presence takes
    // its real "wait for animationend" branch instead of unmounting at once.
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    const getComputedStyleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((elt, pseudo) => {
        const real = realGetComputedStyle(elt, pseudo);
        if (
          !(elt instanceof Element) ||
          elt.getAttribute("role") !== "dialog"
        ) {
          return real;
        }
        return new Proxy(real, {
          get(target, prop) {
            if (prop === "animationName") {
              return elt.getAttribute("data-state") === "closed"
                ? "radix-exit"
                : "radix-enter";
            }
            // jsdom 30's CSSStyleProperties getters and methods reject a
            // Proxy as `this`, so they run against the real object.
            const value: unknown = Reflect.get(target, prop, target);
            if (typeof value !== "function") return value;
            return (...args: unknown[]): unknown =>
              Reflect.apply(value, target, args);
          },
        });
      });

    rerender(renderDialog(true));
    expect(dialogMountEvents.mounts).toBe(1);
    expect(dialogMountEvents.unmounts).toBe(0);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-state")).toBe("open");

    rerender(renderDialog(false));
    // The wrapper itself did not unmount the root - Radix's own Presence on
    // DialogContent now owns removing it, and it is genuinely mid-exit.
    expect(dialogMountEvents.mounts).toBe(1);
    expect(dialogMountEvents.unmounts).toBe(0);
    expect(dialog.isConnected).toBe(true);
    expect(dialog.getAttribute("data-state")).toBe("closed");

    // jsdom has no `AnimationEvent` constructor; a plain Event with the one
    // property the handler reads is equivalent. Wrapped in `act` so the
    // resulting unmount is flushed before the assertions below run.
    act(() => {
      const animationEnd = new Event("animationend");
      Object.assign(animationEnd, { animationName: "radix-exit" });
      dialog.dispatchEvent(animationEnd);
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(dialogMountEvents.mounts).toBe(1);
    expect(dialogMountEvents.unmounts).toBe(0);

    getComputedStyleSpy.mockRestore();
  });
});

describe("<RevertOnEditDialog /> queued-messages note", () => {
  afterEach(() => {
    cleanup();
  });

  it("names parked queue items so the edit doesn't silently carry them", () => {
    render(
      <RevertOnEditDialog
        open
        onOpenChange={onOpenChange}
        onRevert={onRevert}
        onDontRevert={onDontRevert}
        artifactCount={0}
        queuedCount={2}
      />,
    );
    expect(screen.getByRole("dialog").textContent).toMatch(
      /2 queued messages stay queued and will send after the edited message when the queue next runs/i,
    );
  });

  it("uses singular wording for a single parked item", () => {
    render(
      <RevertOnEditDialog
        open
        onOpenChange={onOpenChange}
        onRevert={onRevert}
        onDontRevert={onDontRevert}
        artifactCount={0}
        queuedCount={1}
      />,
    );
    expect(screen.getByRole("dialog").textContent).toMatch(
      /1 queued message stays queued and will send after the edited message when the queue next runs/i,
    );
  });

  it("omits the note when the queue is empty", () => {
    render(renderDialog(true));
    expect(screen.getByRole("dialog").textContent).not.toMatch(
      /queued message/i,
    );
  });
});

/**
 * A windowed transcript whose history below the edit point is not hydrated
 * cannot count the artifacts in scope. The opt-out still has to appear: it
 * defaults to CHECKED, so hiding it would revert artifacts with nothing on
 * screen saying so - and the host reverts the true scope regardless of what
 * this side could see.
 */
describe("<RevertOnEditDialog /> uncountable artifact scope", () => {
  afterEach(() => {
    cleanup();
  });

  it("still offers the opt-out when the count is unknown", () => {
    render(
      <RevertOnEditDialog
        open
        onOpenChange={onOpenChange}
        onRevert={onRevert}
        onDontRevert={onDontRevert}
        artifactCount={null}
        queuedCount={0}
      />,
    );
    const checkbox = screen.getByRole("checkbox", { name: /also revert/i });
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
  });

  it("states no number rather than an under-count", () => {
    render(
      <RevertOnEditDialog
        open
        onOpenChange={onOpenChange}
        onRevert={onRevert}
        onDontRevert={onDontRevert}
        artifactCount={null}
        queuedCount={0}
      />,
    );
    const label = screen.getByRole("dialog").textContent;
    expect(label).toMatch(/also revert artifacts changed since this message/i);
    // A digit here would be a measurement the client is not in a position to
    // make - the failure this whole three-state exists to prevent.
    expect(label).not.toMatch(/also revert \d+ artifact/i);
  });
});
