import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { userEvent, type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { LazySidebarTooltipWrapper } from "../lazy-sidebar-hover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { TooltipProvider } from "@/components/ui/tooltip";

afterEach(cleanup);

describe("LazySidebarTooltipWrapper", () => {
  it("keeps keyboard focus on the trigger after the first-focus mount", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <LazySidebarTooltipWrapper
          label="x"
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <button type="button" data-testid="leaf">
            leaf
          </button>
        </LazySidebarTooltipWrapper>
      </TooltipProvider>,
    );

    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId("leaf"));
    expect(document.activeElement).not.toBe(document.body);
  });
});

interface TooltipLeafProps {
  readonly label: string;
  readonly side: "top";
  readonly sideOffset: undefined;
  readonly align: undefined;
  readonly children: ReactElement;
}

// Both `LazySidebarTooltipWrapper` and the eager `TooltipWrapper` accept this
// same prop shape, so every case below can be parameterized over which one
// is under test.
type TooltipLeafComponent = (props: TooltipLeafProps) => ReactNode;

const LEAVES: ReadonlyArray<readonly [string, TooltipLeafComponent]> = [
  ["lazy", LazySidebarTooltipWrapper],
  ["eager", TooltipWrapper],
];

function leaf(
  Leaf: TooltipLeafComponent,
  testId: string,
  label: string,
): ReactElement {
  return (
    <Leaf label={label} side="top" sideOffset={undefined} align={undefined}>
      <button type="button" data-testid={testId}>
        {label}
      </button>
    </Leaf>
  );
}

function tooltipTexts(): readonly string[] {
  return screen.queryAllByRole("tooltip").map((element) => element.textContent);
}

// The lazy leaf mounts its Base root in a 0 ms task after the pointer first
// enters, and React only commits that mount - and the layout effect that
// carries focus over to the new node - once the `act` scope containing the
// timer fires closes. The pointer replay itself is a SECOND 0 ms task, fired
// from a `useEffect` after that mount so Base's own hover machinery has
// finished arming before it is handed an enter. Flushing two dedicated, empty
// `advanceTimersByTimeAsync(0)` `act`s right after every `user.hover()` forces
// both to land before any further advance, so the provider's own delay timer
// (armed by the replayed `pointermove`) starts counting from zero rather than
// from wherever the mount and replay happened to land inside a later, larger
// advance. For the eager leaf this is a no-op: nothing is ever scheduled at
// 0 ms.
async function flushHoverMount(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

// Leaving the trigger does NOT close the tooltip by itself: the trigger's
// native `pointerleave` arms Base's own grace handling, closed for real only
// once a subsequent move lands clearly outside both the trigger and the
// content. So closing for real needs a `pointerleave` on the trigger, then a
// move that clearly lands outside it.
//
// Two mechanisms have to be driven together here, because closing this
// tooltip touches two independent pieces of state:
//
// - Base's own close handling is armed by whichever DOM node its native
//   `addEventListener("pointerleave", ...)` is actually attached to. On the
//   lazy leaf, that is the POST-mount trigger node - mounting replaces the
//   DOM node under it (see the docblock on `LazySidebarHover` and the "keeps
//   keyboard focus..." test above). `fireEvent.pointerLeave` on the
//   freshly-requeried live node reaches that listener directly.
// - `user-event`'s own session separately tracks "what element is the
//   pointer currently over", entirely apart from the DOM: `unhover(el)`
//   (see `@testing-library/user-event`'s `convenience/hover.js`) ignores
//   `el` for anything but its `ownerDocument` and always moves the session's
//   tracked pointer from wherever IT last thinks it is to `document.body`.
//   Skipping it leaves that session still believing the pointer sits on the
//   original trigger, so a later `user.hover()` on that same element (true
//   for the eager leaf, which never remounts) sees no change of target and
//   silently drops the enter/move that would restart the open timer.
//
// So both run: `fireEvent.pointerLeave` + `fireEvent.mouseLeave` on the live
// node for Base's real listener (Base reads the native `mouseleave` pair the
// same way its open path reads `mouseenter`, not the pointer event alone -
// `pointerLeave` on its own left the lazy leaf's replayed hover open
// indefinitely), `user.unhover()` for user-event's own bookkeeping - neither
// alone closes and reopens correctly for both leaves.
async function closeTrigger(user: UserEvent, testId: string): Promise<void> {
  const current = screen.getByTestId(testId);
  fireEvent.pointerLeave(current);
  fireEvent.mouseLeave(current);
  const pendingUnhover = user.unhover(current);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  await pendingUnhover;
  fireEvent.pointerMove(document, { clientX: 9999, clientY: 9999 });
}

describe("LazySidebarTooltipWrapper opens through Base", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it.each(LEAVES)(
    "(a) skip-delay between two %s leaves",
    async (_name, Leaf) => {
      const user = userEvent.setup({
        delay: null,
        advanceTimers: vi.advanceTimersByTimeAsync,
      });
      render(
        <TooltipProvider delay={150}>
          {leaf(Leaf, "leaf-a", "Label A")}
          {leaf(Leaf, "leaf-b", "Label B")}
        </TooltipProvider>,
      );
      const a = screen.getByTestId("leaf-a");
      const b = screen.getByTestId("leaf-b");

      // `user.hover`'s own `act` waits on the pending intent/delay timer, so
      // the hover must be started before the fake timers are advanced -
      // awaiting it up front never resolves (see the sibling
      // sidebar-row-first-use-overlays.test.tsx for the same idiom).
      const hoveredA = user.hover(a);
      await flushHoverMount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(155);
      });
      await hoveredA;
      expect(tooltipTexts()).toContain("Label A");

      await closeTrigger(user, "leaf-a");
      expect(tooltipTexts()).not.toContain("Label A");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      const hoveredB = user.hover(b);
      await flushHoverMount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      await hoveredB;
      expect(tooltipTexts()).toContain("Label B");
    },
  );

  it.each(LEAVES)(
    "(b) an eager tooltip opens right after a %s one closes",
    async (_name, Leaf) => {
      const user = userEvent.setup({
        delay: null,
        advanceTimers: vi.advanceTimersByTimeAsync,
      });
      render(
        <TooltipProvider delay={150}>
          {leaf(Leaf, "leaf-a", "Label A")}
          {leaf(TooltipWrapper, "leaf-c", "Label C")}
        </TooltipProvider>,
      );
      const a = screen.getByTestId("leaf-a");
      const c = screen.getByTestId("leaf-c");

      const hoveredA = user.hover(a);
      await flushHoverMount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(155);
      });
      await hoveredA;
      expect(tooltipTexts()).toContain("Label A");

      await closeTrigger(user, "leaf-a");
      expect(tooltipTexts()).not.toContain("Label A");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      const hoveredC = user.hover(c);
      await flushHoverMount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      await hoveredC;
      expect(tooltipTexts()).toContain("Label C");
    },
  );

  it.each(LEAVES)(
    "(c) only one tooltip is open at a time with a %s leaf",
    async (_name, Leaf) => {
      const user = userEvent.setup({
        delay: null,
        advanceTimers: vi.advanceTimersByTimeAsync,
      });
      render(
        <TooltipProvider delay={150}>
          {leaf(Leaf, "leaf-a", "Label A")}
          {leaf(TooltipWrapper, "leaf-c", "Label C")}
        </TooltipProvider>,
      );
      const a = screen.getByTestId("leaf-a");
      const c = screen.getByTestId("leaf-c");

      // Focus opens a Base tooltip at once - no delay timer is armed, so
      // this can stay a plain synchronous `act`.
      act(() => {
        c.focus();
      });
      expect(tooltipTexts()).toContain("Label C");

      const hoveredA = user.hover(a);
      await flushHoverMount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(155);
      });
      await hoveredA;

      const tooltips = screen.queryAllByRole("tooltip");
      expect(tooltips).toHaveLength(1);
      expect(tooltips[0]?.textContent).toBe("Label A");
    },
  );

  it.each(LEAVES)(
    "(d) the provider's delay is honoured by a %s leaf",
    async (_name, Leaf) => {
      const user = userEvent.setup({
        delay: null,
        advanceTimers: vi.advanceTimersByTimeAsync,
      });
      render(
        <TooltipProvider delay={500}>
          {leaf(Leaf, "leaf-a", "Label A")}
        </TooltipProvider>,
      );
      const a = screen.getByTestId("leaf-a");

      const hoveredA = user.hover(a);
      await flushHoverMount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(tooltipTexts()).not.toContain("Label A");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(349);
      });
      expect(tooltipTexts()).not.toContain("Label A");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3);
      });
      await hoveredA;
      expect(tooltipTexts()).toContain("Label A");
    },
  );

  it.each(LEAVES)(
    "(e) a press spends the hover for a %s leaf",
    async (_name, Leaf) => {
      const user = userEvent.setup({
        delay: null,
        advanceTimers: vi.advanceTimersByTimeAsync,
      });
      render(
        <TooltipProvider delay={150}>
          {leaf(Leaf, "leaf-a", "Label A")}
        </TooltipProvider>,
      );
      const a = screen.getByTestId("leaf-a");

      const hoveredA = user.hover(a);
      await flushHoverMount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      await hoveredA;

      // Re-query rather than reuse `a`: the 0 ms mount flush above may have
      // already replaced the trigger's DOM node (lazy leaf only - see the
      // docblock on `LazySidebarHover`), so `a` can be a detached, stale node
      // by this point, and events fired at it would never reach React.
      const current = screen.getByTestId("leaf-a");
      fireEvent.pointerDown(current, { button: 0, pointerType: "mouse" });
      fireEvent.pointerUp(current, { button: 0, pointerType: "mouse" });
      fireEvent.click(current);

      fireEvent.pointerMove(current, { pointerType: "mouse" });
      fireEvent.pointerMove(current, { pointerType: "mouse" });
      fireEvent.pointerMove(current, { pointerType: "mouse" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(tooltipTexts()).not.toContain("Label A");

      // Re-query again for the same reason: if the lazy leaf mounted
      // somewhere in the block above, any earlier reference is stale from
      // here on and dispatching against it would silently do nothing.
      await closeTrigger(user, "leaf-a");
      const hoveredAgain = user.hover(screen.getByTestId("leaf-a"));
      await flushHoverMount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(155);
      });
      await hoveredAgain;
      expect(tooltipTexts()).toContain("Label A");
    },
  );

  it.each(LEAVES)(
    "(e-before-mount) a press before the root mounts spends the hover for a %s leaf",
    async (_name, Leaf) => {
      const user = userEvent.setup({
        delay: null,
        advanceTimers: vi.advanceTimersByTimeAsync,
      });
      render(
        <TooltipProvider delay={150}>
          {leaf(Leaf, "leaf-a", "Label A")}
        </TooltipProvider>,
      );
      const a = screen.getByTestId("leaf-a");
      const hoveredA = user.hover(a);

      // `user.hover()`'s own enter/move dispatch is deferred behind a
      // microtask - calling `fireEvent` on `a` right here, with no await at
      // all, would run BEFORE that dispatch ever reaches the DOM (confirmed
      // by instrumenting both leaves: `hover()` returning is not the same as
      // its events having landed). That reorders this into "press an
      // untouched trigger, then start hovering it" instead of the intended
      // "hover begins, then a press interrupts it" - on the eager leaf that
      // makes the press a no-op (Base's own pending-timer cancellation on
      // click has nothing to cancel yet) and the tooltip opens anyway once
      // the delayed `pointermove` lands. A bare microtask flush - no fake
      // timer advance - is enough to let that deferred dispatch land, and
      // unlike `flushHoverMount()` it does NOT run the lazy leaf's 0 ms
      // mount timer (a real macrotask), so the root is still genuinely
      // unmounted when the press below fires.
      await Promise.resolve();

      // Pressing here, before the root exists at all, is what test (e)
      // cannot exercise - there the press always lands after the 0 ms mount
      // flush.
      fireEvent.pointerDown(a, { button: 0, pointerType: "mouse" });
      fireEvent.pointerUp(a, { button: 0, pointerType: "mouse" });
      fireEvent.click(a);

      await flushHoverMount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      await hoveredA;

      // Re-query rather than reuse `a`: the 0 ms mount flush above may have
      // replaced the trigger's DOM node (lazy leaf only).
      const current = screen.getByTestId("leaf-a");
      fireEvent.pointerMove(current, { pointerType: "mouse" });
      fireEvent.pointerMove(current, { pointerType: "mouse" });
      fireEvent.pointerMove(current, { pointerType: "mouse" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(tooltipTexts()).not.toContain("Label A");

      await closeTrigger(user, "leaf-a");
      const hoveredAgain = user.hover(screen.getByTestId("leaf-a"));
      await flushHoverMount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(155);
      });
      await hoveredAgain;
      expect(tooltipTexts()).toContain("Label A");
    },
  );

  it.each(LEAVES)(
    "guard: tabbing to an untouched %s leaf opens its tooltip immediately",
    async (_name, Leaf) => {
      const user = userEvent.setup({
        delay: null,
        advanceTimers: vi.advanceTimersByTimeAsync,
      });
      render(
        <TooltipProvider delay={150}>
          {leaf(Leaf, "leaf-a", "Label A")}
        </TooltipProvider>,
      );
      // Deliberately not captured before `tab()`: on the lazy leaf, the
      // first focus mounts the Base root and replaces the trigger's DOM
      // node (see the "keeps keyboard focus on the trigger..." test above,
      // and the docblock on `LazySidebarHover`), so a reference taken
      // beforehand is stale by the time focus lands. Query fresh afterwards,
      // matching that same proven pattern, so this checks the tab landed on
      // *a* leaf-a button - the live one - not a stray element or the body.
      // Unlike the hover path, focus mounts synchronously (no 0 ms timer),
      // so no extra flush is needed here.
      const tabbed = user.tab();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      await tabbed;

      expect(document.activeElement).toBe(screen.getByTestId("leaf-a"));
      expect(document.activeElement).not.toBe(document.body);
      expect(tooltipTexts()).toContain("Label A");
    },
  );
});
