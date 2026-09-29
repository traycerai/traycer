/**
 * Integrated tests for the app's shared hover card
 * (`components/ui/hover-card.tsx`), rebuilt on `@floating-ui/react`. Real
 * component, real Floating UI hooks, driven through `fireEvent` pointer,
 * focus and keyboard events under fake timers.
 *
 * Motion is mocked off (matches `side-tab-strip.test.tsx`'s precedent): with
 * it on, closing schedules a real `requestAnimationFrame`-driven exit before
 * the content unmounts, which is `useTransitionStyles`' concern, not this
 * primitive's open/close/group/dismiss contract. Only the (n) cases turn it
 * on (`motion.enabled`), because the fade IS what they pin.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HoverCard,
  HoverCardGroup,
  type HoverCardOpenReason,
  type HoverCardSemantics,
} from "@/components/ui/hover-card";
import { MenuOpenMarker, useAnyMenuOpen } from "@/components/ui/open-menus";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

const motion = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/lib/animation/use-motion-enabled", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/animation/use-motion-enabled")>();
  return { ...actual, useMotionEnabled: () => motion.enabled };
});

const OPEN_DELAY_MS = 500;
const CLOSE_DELAY_MS = 150;
const EXIT_FADE_MS = 100;
/** A timer tick or two: nothing beside the exit fade (100ms) is this long. */
const TICK_SLACK_MS = 10;
/** One animation frame, which `useTransitionStyles` waits for before it fades in. */
const FRAME_MS = 16;

function contentNode(testId: string): HTMLElement | null {
  return screen.queryByTestId(testId);
}

function cardIsOpen(testId: string): boolean {
  return contentNode(testId) !== null;
}

/** A real mouse hover: Floating UI's own open-delay timer lives on the
 * native `mouseenter` listener `useHover` attaches directly to the DOM node
 * (bypassing React's synthetic system), and it gates on the pointer type
 * `onPointerEnter` (a React prop, delegated) records just before - so both
 * have to fire, in this order, the way a real browser's compat mouse events
 * would. */
function hoverIn(trigger: HTMLElement): void {
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
  fireEvent.mouseEnter(trigger);
}

/**
 * The pointer leaving a trigger for somewhere far from any card. With the
 * safe polygon, `mouseleave` only starts the judgement: the document-level
 * `mousemove` that follows is what finds the pointer outside it and starts
 * the close delay.
 */
function leave(trigger: HTMLElement): void {
  fireEvent.mouseLeave(trigger);
  fireEvent.mouseMove(document.body, { clientX: 4000, clientY: 4000 });
}

function settle(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/**
 * The group's close-the-previous cascade (a sibling's `useDelayGroup` effect
 * setting the shared `currentId`, which a DIFFERENT component's own effect
 * then reads to call its `onOpenChange(false)`) crosses a React scheduler
 * task boundary partway through - one `act(() => advanceTimersByTime(...))`
 * call, however large, flushes only the first half of it. Two separate
 * one-tick `act()` calls (with real control returning to the event loop
 * between them, which `shouldAdvanceTime: true` allows) drain both halves;
 * verified by bisection against the real component.
 */
function settleGroupHandoff(): void {
  settle(1);
  settle(1);
}

/**
 * Keyboard (Enter) activation, not a mouse press: a bare `pointerdown` on the
 * dropdown's own trigger would ALSO trip the card's `outsidePress` dismiss
 * (on by default, listening for `pointerdown` anywhere outside the card),
 * which closes the card by itself regardless of the menu-gate under test here
 * - confirmed by mutation: opening the dropdown by `pointerDown` + `click`
 * closed the card even with `<MenuOpenMarker/>` removed from
 * `DropdownMenuContent`, which is not the mechanism this pins.
 */
function openDropdownByKeyboard(trigger: HTMLElement): void {
  fireEvent.keyDown(trigger, { key: "Enter" });
}

interface TestCardProps {
  readonly triggerTestId: string;
  readonly contentTestId: string;
  readonly enabled: boolean;
  readonly open: boolean | null;
  readonly onOpenChange:
    | ((open: boolean, reason: HoverCardOpenReason) => void)
    | null;
  readonly onClick: (() => void) | null;
  readonly onPointerDown: (() => void) | null;
  readonly appearance: "preview" | "tooltip";
  readonly semantics: HoverCardSemantics;
  readonly content: ReactNode;
}

const DEFAULT_TEST_CARD_PROPS: TestCardProps = {
  triggerTestId: "trigger",
  contentTestId: "content",
  enabled: true,
  open: null,
  onOpenChange: null,
  onClick: null,
  onPointerDown: null,
  appearance: "preview",
  semantics: { role: "dialog", label: "Row preview" },
  content: <span>Body</span>,
};

function TestCard(props: Partial<TestCardProps>): ReactNode {
  const merged = { ...DEFAULT_TEST_CARD_PROPS, ...props };
  return (
    <HoverCard
      trigger={
        <button
          type="button"
          data-testid={merged.triggerTestId}
          onClick={merged.onClick ?? undefined}
          onPointerDown={merged.onPointerDown ?? undefined}
        >
          Row
        </button>
      }
      content={merged.content}
      appearance={merged.appearance}
      semantics={merged.semantics}
      side="right"
      align="start"
      sideOffset={8}
      enabled={merged.enabled}
      open={merged.open}
      onOpenChange={merged.onOpenChange}
      testId={merged.contentTestId}
      className={null}
    />
  );
}

/** Renders one uncontrolled card and returns its trigger. */
function renderCard(props: Partial<TestCardProps>): HTMLElement {
  render(<TestCard {...props} />);
  return screen.getByTestId(
    props.triggerTestId ?? DEFAULT_TEST_CARD_PROPS.triggerTestId,
  );
}

describe("HoverCard", () => {
  beforeEach(() => {
    motion.enabled = false;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("(a) opens only after 500ms of hover, not before", () => {
    const trigger = renderCard({});

    hoverIn(trigger);
    settle(OPEN_DELAY_MS - 1);
    expect(cardIsOpen("content")).toBe(false);

    settle(2);
    expect(cardIsOpen("content")).toBe(true);
  });

  describe("(b) group hand-off", () => {
    function renderGroup(): {
      readonly a: HTMLElement;
      readonly b: HTMLElement;
    } {
      render(
        <HoverCardGroup>
          <TestCard triggerTestId="row-a" contentTestId="card-a" />
          <TestCard triggerTestId="row-b" contentTestId="card-b" />
        </HoverCardGroup>,
      );
      return {
        a: screen.getByTestId("row-a"),
        b: screen.getByTestId("row-b"),
      };
    }

    it("opens a sibling at once while one is open, and closes the previous", () => {
      const { a, b } = renderGroup();

      hoverIn(a);
      settle(OPEN_DELAY_MS);
      expect(cardIsOpen("card-a")).toBe(true);
      expect(cardIsOpen("card-b")).toBe(false);

      hoverIn(b);
      settleGroupHandoff();
      expect(cardIsOpen("card-b")).toBe(true);
      expect(cardIsOpen("card-a")).toBe(false);
    });

    it("still waits the full 500ms for the first open in a fresh group", () => {
      const { a } = renderGroup();

      hoverIn(a);
      settle(OPEN_DELAY_MS - 1);
      expect(cardIsOpen("card-a")).toBe(false);
    });
  });

  it("(c) swallows an open that lands after a press during the delay (the old S5 stick)", () => {
    const trigger = renderCard({});

    hoverIn(trigger);
    settle(200);
    fireEvent.pointerDown(trigger, { pointerType: "mouse" });
    // Let the rest of the original 500ms elapse: the pending open must not
    // fire after the press, unlike Radix's orphaned timer.
    settle(OPEN_DELAY_MS);
    expect(cardIsOpen("content")).toBe(false);

    // ...and leaving afterwards must not let it land either: the timer the
    // press was meant to cancel is what once stuck a card open under a pointer
    // that had already gone.
    leave(trigger);
    settle(OPEN_DELAY_MS * 2);
    expect(cardIsOpen("content")).toBe(false);
  });

  it("(c) swallows it on a CONTROLLED card too: the parent is never asked to open", () => {
    // The controlled path is the one a caller with its own `open` state takes
    // (the sidebar rows that hide a card while renaming, the graph nodes): the
    // press has to cancel the pending open there as well, or `onOpenChange(true)`
    // lands after it and the caller shows a card nobody is hovering.
    const onOpenChange = vi.fn();
    function ControlledCard(): ReactNode {
      const [open, setOpen] = useState(false);
      return (
        <TestCard
          open={open}
          onOpenChange={(next, reason) => {
            onOpenChange(next, reason);
            setOpen(next);
          }}
        />
      );
    }
    render(<ControlledCard />);
    const trigger = screen.getByTestId("trigger");

    hoverIn(trigger);
    settle(200);
    fireEvent.pointerDown(trigger, { pointerType: "mouse" });
    settle(OPEN_DELAY_MS);
    leave(trigger);
    settle(OPEN_DELAY_MS * 2);

    expect(cardIsOpen("content")).toBe(false);
    expect(onOpenChange).not.toHaveBeenCalledWith(true, expect.anything());
  });

  it("(e) closes on Escape", () => {
    const trigger = renderCard({});

    hoverIn(trigger);
    settle(OPEN_DELAY_MS);
    expect(cardIsOpen("content")).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    settle(0);
    expect(cardIsOpen("content")).toBe(false);
  });

  describe("(f) enabled=false", () => {
    it("suppresses a new hover open while disabled", () => {
      const trigger = renderCard({ enabled: false });

      hoverIn(trigger);
      settle(OPEN_DELAY_MS * 2);
      expect(cardIsOpen("content")).toBe(false);
    });

    it("does not re-show a forgotten open just by re-enabling", () => {
      const { rerender } = render(<TestCard enabled />);
      const trigger = screen.getByTestId("trigger");

      hoverIn(trigger);
      settle(OPEN_DELAY_MS);
      expect(cardIsOpen("content")).toBe(true);

      rerender(<TestCard enabled={false} />);
      settle(0);
      expect(cardIsOpen("content")).toBe(false);

      rerender(<TestCard enabled />);
      expect(cardIsOpen("content")).toBe(false);

      // A fresh hover still works after re-enabling.
      hoverIn(trigger);
      settle(OPEN_DELAY_MS);
      expect(cardIsOpen("content")).toBe(true);
    });
  });

  describe("(g) controlled open + onOpenChange reasons", () => {
    it("reports 'hover' without moving a controlled `open` on its own", () => {
      const onOpenChange = vi.fn();
      const { rerender } = render(
        <TestCard open={false} onOpenChange={onOpenChange} />,
      );
      const trigger = screen.getByTestId("trigger");

      hoverIn(trigger);
      settle(OPEN_DELAY_MS);
      // Controlled: the card stays shut until the caller flips `open`.
      expect(cardIsOpen("content")).toBe(false);
      expect(onOpenChange).toHaveBeenCalledWith(true, "hover");

      rerender(<TestCard open onOpenChange={onOpenChange} />);
      expect(cardIsOpen("content")).toBe(true);
    });

    it("reports 'press' for a pointerdown close and 'escape' for Escape", () => {
      const onOpenChange = vi.fn();
      const { rerender } = render(
        <TestCard open onOpenChange={onOpenChange} />,
      );
      const trigger = screen.getByTestId("trigger");
      expect(cardIsOpen("content")).toBe(true);

      fireEvent.pointerDown(trigger, { pointerType: "mouse" });
      expect(onOpenChange).toHaveBeenCalledWith(false, "press");

      onOpenChange.mockClear();
      rerender(<TestCard open onOpenChange={onOpenChange} />);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onOpenChange).toHaveBeenCalledWith(false, "escape");
    });

    it("reports 'group' when a sibling's open closes this one", () => {
      const onOpenChangeA = vi.fn();
      render(
        <HoverCardGroup>
          <TestCard
            triggerTestId="row-a"
            contentTestId="card-a"
            onOpenChange={onOpenChangeA}
          />
          <TestCard triggerTestId="row-b" contentTestId="card-b" />
        </HoverCardGroup>,
      );
      const a = screen.getByTestId("row-a");
      const b = screen.getByTestId("row-b");

      hoverIn(a);
      settle(OPEN_DELAY_MS);
      onOpenChangeA.mockClear();

      hoverIn(b);
      settleGroupHandoff();
      expect(onOpenChangeA).toHaveBeenCalledWith(false, "group");
    });
  });

  it("(h) a focus event opens the card at once (jsdom always reports :focus-visible)", () => {
    // Floating UI's `useFocus({visibleOnly:true})` gates on
    // `target.matches(':focus-visible')` through its own `matchesFocusVisible`
    // helper - which special-cases jsdom (detected off the user agent string)
    // and answers `true` unconditionally there, because jsdom cannot evaluate
    // the pseudo-class. So `visibleOnly` genuinely gates mouse- vs.
    // keyboard-driven focus only in a real browser; in this suite, any focus
    // opens the card immediately (no 500ms wait - `useFocus` never delays),
    // and no jsdom test can tell `visibleOnly: true` apart from `false`.
    const trigger = renderCard({});

    fireEvent.focus(trigger);
    expect(cardIsOpen("content")).toBe(true);
  });

  it("(i) composes the trigger's own onPointerDown/onClick with the card's own dismissal, via Slot", () => {
    // A weaker version of this test (just firing the events and checking the
    // spies) would pass even if `Slot.Root` were dropped entirely, since the
    // trigger button owns those handlers regardless of any wrapper. Asserting
    // both the spy AND the card's own reaction from the SAME event is what
    // actually pins the composition: it fails if either side of the merge is
    // lost.
    const onClick = vi.fn();
    const onPointerDown = vi.fn();
    const trigger = renderCard({ onClick, onPointerDown });

    hoverIn(trigger);
    settle(OPEN_DELAY_MS);
    expect(cardIsOpen("content")).toBe(true);

    fireEvent.pointerDown(trigger, { pointerType: "mouse" });
    settle(0);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(cardIsOpen("content")).toBe(false);

    hoverIn(trigger);
    settle(OPEN_DELAY_MS);
    expect(cardIsOpen("content")).toBe(true);

    fireEvent.click(trigger);
    settle(0);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(cardIsOpen("content")).toBe(false);
  });

  it("names a tooltip-role card by its accessible role alone (a rail label has no name)", () => {
    // A real `RailButton` (`epic-sidebar-rail.tsx`) needs a column-placement
    // context and drag-and-drop wiring unrelated to this - it renders exactly
    // this: `appearance="tooltip"` and `semantics={{role:"tooltip"}}`. This
    // pins that wiring on the primitive directly instead.
    const trigger = renderCard({
      appearance: "tooltip",
      semantics: { role: "tooltip" },
      content: <span>Terminal</span>,
    });

    hoverIn(trigger);
    settle(OPEN_DELAY_MS);

    expect(screen.getByRole("tooltip")).toBeTruthy();
  });

  it("names a dialog-role card that carries an action by its own label (the compact file-path chip)", () => {
    // Fallback from the real `workspace-file-tile.tsx` compact chip: its
    // suite (`workspace-file-tile-path-header.test.tsx`) has two PRE-EXISTING
    // failures unrelated to this task ("hides the copy control..." and
    // "opens the accessible popover..." both fail on a fresh checkout of this
    // shared worktree, confirmed via `git stash` - the DOM never reaches the
    // state either test expects), so adding a role/name assertion there would
    // ride on an already-broken harness. This pins the same
    // `semantics={{role:"dialog", label:"File path"}}` wiring that call site
    // uses, directly on the primitive.
    const trigger = renderCard({
      semantics: { role: "dialog", label: "File path" },
    });

    hoverIn(trigger);
    settle(OPEN_DELAY_MS);

    expect(screen.getByRole("dialog", { name: "File path" })).toBeTruthy();
  });

  describe("(k) shut while any menu is open anywhere", () => {
    it("a sibling context menu suppresses a hover open, with no spontaneous reopen once it closes", () => {
      render(
        <div>
          <TestCard />
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <button type="button" data-testid="menu-trigger">
                Menu row
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem>Item</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>,
      );
      const trigger = screen.getByTestId("trigger");
      const menuTrigger = screen.getByTestId("menu-trigger");

      // Not a `pointerdown` + `contextmenu` (a real right-click's sequence):
      // `contextmenu` alone is enough to open Radix's menu, and staying off
      // `pointerdown` keeps this test from ALSO tripping the trigger's own
      // reference-press dismiss, which is a different mechanism from the one
      // under test here.
      fireEvent.contextMenu(menuTrigger);
      expect(screen.getByRole("menu")).toBeTruthy();

      hoverIn(trigger);
      settle(OPEN_DELAY_MS * 2);
      expect(cardIsOpen("content")).toBe(false);

      fireEvent.keyDown(document, { key: "Escape" });
      settle(0);
      expect(screen.queryByRole("menu")).toBeNull();
      // Lifting the suppression must not show the swallowed open on its own.
      expect(cardIsOpen("content")).toBe(false);

      // A fresh hover still works once the gate is lifted.
      hoverIn(trigger);
      settle(OPEN_DELAY_MS);
      expect(cardIsOpen("content")).toBe(true);
    });

    it("never reports onOpenChange(true, ...) to a CONTROLLED caller while suppressed by a sibling menu", () => {
      // The uncontrolled case above is self-healing even without this guard:
      // the render-time "forgets its own open state" reset (`if (suppressed
      // && uncontrolledOpen) setUncontrolledOpen(false)`) fires on the very
      // same render that a stray `setUncontrolledOpen(true)` would produce,
      // since `suppressed` hasn't changed - so it never becomes observable
      // there. A CONTROLLED caller has no such internal state for that reset
      // to correct: it only learns of the open through `onOpenChange`, and a
      // caller that dutifully obeyed a stray `(true, "hover")` here would show
      // the card itself the instant suppression lifts.
      const onOpenChange = vi.fn();
      render(
        <div>
          <TestCard open={false} onOpenChange={onOpenChange} />
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <button type="button" data-testid="menu-trigger">
                Menu row
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem>Item</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>,
      );
      const trigger = screen.getByTestId("trigger");
      fireEvent.contextMenu(screen.getByTestId("menu-trigger"));

      hoverIn(trigger);
      settle(OPEN_DELAY_MS * 2);

      expect(onOpenChange).not.toHaveBeenCalledWith(true, expect.anything());
    });

    it("an already-open card closes the instant a dropdown opens elsewhere", () => {
      render(
        <div>
          <TestCard />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" data-testid="dropdown-trigger">
                Dropdown
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>Item</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>,
      );
      const trigger = screen.getByTestId("trigger");
      const dropdownTrigger = screen.getByTestId("dropdown-trigger");

      hoverIn(trigger);
      settle(OPEN_DELAY_MS);
      expect(cardIsOpen("content")).toBe(true);

      openDropdownByKeyboard(dropdownTrigger);
      settle(0);
      expect(screen.getByRole("menu")).toBeTruthy();
      expect(cardIsOpen("content")).toBe(false);

      fireEvent.keyDown(document, { key: "Escape" });
      settle(0);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(cardIsOpen("content")).toBe(false);
    });
  });

  it("(g) disabling a CONTROLLED open card reports 'disabled', and re-enabling after the caller drops `open` stays closed", () => {
    // Pins the FULL round trip a real controlled caller does - the card shuts
    // even though the caller owns `open`, reports the "disabled" reason, the
    // caller drops its own `open`, then re-enables.
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <TestCard open enabled onOpenChange={onOpenChange} />,
    );
    expect(cardIsOpen("content")).toBe(true);

    rerender(<TestCard open enabled={false} onOpenChange={onOpenChange} />);
    settle(0);
    expect(cardIsOpen("content")).toBe(false);
    expect(onOpenChange).toHaveBeenCalledWith(false, "disabled");

    onOpenChange.mockClear();
    rerender(<TestCard open={false} enabled onOpenChange={onOpenChange} />);
    settle(0);
    expect(cardIsOpen("content")).toBe(false);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("focus-latch regression: a right-click that never got to open the card still lets a LATER focus open it", () => {
    // The primitive's own doc comment: a disabled `useFocus` drops its
    // `onMouseLeave`/`onBlur`, which is what clears the "dismissed until the
    // pointer leaves" latch a reference-press sets - so a right-clicked
    // trigger would never open on focus again. Reproduced here without the
    // conditional gating (useHover/useFocus are unconditionally enabled in
    // the current primitive): right-click opens a context menu (suppressing
    // the card), the pointer leaves WHILE the menu is still open, the menu
    // closes, and a subsequent focus must still open the card.
    render(
      <ContextMenu>
        <HoverCard
          trigger={
            <ContextMenuTrigger asChild>
              <button type="button" data-testid="row">
                Row
              </button>
            </ContextMenuTrigger>
          }
          content={<span>Body</span>}
          appearance="preview"
          semantics={{ role: "dialog", label: "Row preview" }}
          side="right"
          align="start"
          sideOffset={8}
          enabled
          open={null}
          onOpenChange={null}
          testId="content"
          className={null}
        />
        <ContextMenuContent>
          <ContextMenuItem>Item</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    const row = screen.getByTestId("row");

    fireEvent.pointerDown(row, { pointerType: "mouse", button: 2 });
    fireEvent.contextMenu(row);
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.mouseLeave(row);

    fireEvent.keyDown(document, { key: "Escape" });
    settle(0);
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.focus(row);
    expect(cardIsOpen("content")).toBe(true);
  });

  describe("open-menus.ts: the shared open-menu counter", () => {
    function Probe(): ReactNode {
      const anyMenuOpen = useAnyMenuOpen();
      return <span data-testid="probe">{String(anyMenuOpen)}</span>;
    }

    function MarkerHost(props: {
      readonly a: boolean;
      readonly b: boolean;
    }): ReactNode {
      return (
        <>
          <Probe />
          {props.a ? <MenuOpenMarker /> : null}
          {props.b ? <MenuOpenMarker /> : null}
        </>
      );
    }

    it("is open while either of two mounted markers is up, and closed only once both are gone", () => {
      const { rerender } = render(<MarkerHost a={false} b={false} />);
      expect(screen.getByTestId("probe").textContent).toBe("false");

      rerender(<MarkerHost a b={false} />);
      expect(screen.getByTestId("probe").textContent).toBe("true");

      rerender(<MarkerHost a b />);
      expect(screen.getByTestId("probe").textContent).toBe("true");

      rerender(<MarkerHost a={false} b />);
      expect(screen.getByTestId("probe").textContent).toBe("true");

      rerender(<MarkerHost a={false} b={false} />);
      expect(screen.getByTestId("probe").textContent).toBe("false");
    });
  });

  it("(l) keeps every control inside the content out of sequential focus, including one that renders later", async () => {
    function LateButton(): ReactNode {
      const [shown, setShown] = useState(false);
      return (
        <div>
          <button type="button" data-testid="content-button-early">
            Early
          </button>
          {shown ? (
            <button type="button" data-testid="content-button-late">
              Late
            </button>
          ) : null}
          <button
            type="button"
            data-testid="content-button-reveal"
            onClick={() => {
              setShown(true);
            }}
          >
            Reveal
          </button>
        </div>
      );
    }
    const trigger = renderCard({ content: <LateButton /> });

    hoverIn(trigger);
    settle(OPEN_DELAY_MS);
    const early = screen.getByTestId("content-button-early");
    expect(early.tabIndex).toBe(-1);

    fireEvent.click(screen.getByTestId("content-button-reveal"));
    // The sweep on a later-rendered control runs off the `MutationObserver`
    // callback, a microtask - a bare synchronous `act()` does not wait for it.
    await act(async () => {
      await Promise.resolve();
    });
    const late = screen.getByTestId("content-button-late");
    expect(late.tabIndex).toBe(-1);
  });

  it("(m) Escape closes the card first, and a modal Dialog it sits inside stays open", () => {
    function CardInDialog(): ReactNode {
      const [dialogOpen, setDialogOpen] = useState(true);
      return (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <DialogTitle>Settings</DialogTitle>
            <HoverCard
              trigger={
                <button type="button" data-testid="trigger">
                  Row
                </button>
              }
              content={<span>Body</span>}
              appearance="preview"
              semantics={{ role: "dialog", label: "Row preview" }}
              side="right"
              align="start"
              sideOffset={8}
              enabled
              open={null}
              onOpenChange={null}
              testId="content"
              className={null}
            />
          </DialogContent>
        </Dialog>
      );
    }
    render(<CardInDialog />);
    const trigger = screen.getByTestId("trigger");
    // Disambiguated by name: the card's own `semantics` role is ALSO
    // `"dialog"` once it opens, so a bare `getByRole("dialog")` would match
    // both surfaces.
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();

    hoverIn(trigger);
    settle(OPEN_DELAY_MS);
    expect(cardIsOpen("content")).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    settle(0);
    expect(cardIsOpen("content")).toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    settle(0);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  describe("(n) motion: what the fade does to the card's life", () => {
    /**
     * Reads the styled node's opacity at the commit that MOUNTS it. It is a
     * callback ref on the content, which React attaches after the parent's
     * props (its inline style) are applied and before any frame or effect
     * could change them, so it is the first thing a user's first frame can see.
     */
    function OpacityAtMount(props: {
      readonly onMount: (opacity: string) => void;
    }): ReactNode {
      return (
        <span
          ref={(node) => {
            if (node !== null) {
              props.onMount(node.parentElement?.style.opacity ?? "no parent");
            }
          }}
        >
          Body
        </span>
      );
    }

    function openAndLeave(
      seen: string[],
      mounted: () => void,
    ): {
      readonly trigger: HTMLElement;
      readonly card: HTMLElement;
    } {
      const trigger = renderCard({
        content: (
          <OpacityAtMount
            onMount={(opacity) => {
              seen.push(opacity);
              mounted();
            }}
          />
        ),
      });
      hoverIn(trigger);
      settle(OPEN_DELAY_MS);
      return { trigger, card: screen.getByTestId("content") };
    }

    it("with reduced motion the card is opaque from the commit that mounts it, and leaving unmounts it when the close delay ends, with no exit", () => {
      motion.enabled = false;
      const seen: string[] = [];
      const { trigger, card } = openAndLeave(seen, () => undefined);

      // No inline opacity at all: it was never faded out, so there is no frame
      // in which it is not fully drawn.
      expect(seen[0]).toBe("");
      expect(card.style.opacity).toBe("");

      leave(trigger);
      settle(CLOSE_DELAY_MS - 1);
      expect(cardIsOpen("content")).toBe(true);
      // The close delay ends and the card is gone within a tick: nothing
      // holds it on the page for an exit. (Two acts: the close renders in the
      // first, and the unmount timer it sets can only fire in the second.)
      settle(1);
      settle(TICK_SLACK_MS);
      expect(cardIsOpen("content")).toBe(false);
    });

    it("with motion the card mounts transparent and fades in, and after leaving it stays mounted, faded out, through the exit before it unmounts", () => {
      motion.enabled = true;
      const seen: string[] = [];
      const { trigger, card } = openAndLeave(seen, () => undefined);

      // Mounted at opacity 0 in the very commit that mounts it: the fade-in
      // starts from nothing, which is what the reduced-motion case must not do.
      expect(seen[0]).toBe("0");
      // And on to full opacity over the enter transition, one frame later.
      settle(FRAME_MS);
      expect(card.style.opacity).toBe("");
      expect(card.style.transitionDuration).toBe(`${EXIT_FADE_MS}ms`);

      leave(trigger);
      settle(CLOSE_DELAY_MS + 1);
      // The close delay is over and the card is closed, and half an exit
      // later it is still on the page, fading out.
      settle(EXIT_FADE_MS / 2);
      expect(cardIsOpen("content")).toBe(true);
      expect(card.getAttribute("data-state")).toBe("closed");
      expect(card.style.opacity).toBe("0");

      settle(EXIT_FADE_MS / 2 + TICK_SLACK_MS);
      expect(cardIsOpen("content")).toBe(false);
    });
  });

  it("(o) a card left open under the pointer while the keyboard moves on: no Tab stop lands in it, the control that arrives late included, and it stays open", async () => {
    // What the sequence of real Tab presses does, not what one control's
    // `tabIndex` says ((l) pins that): a control the sweep missed, or one whose
    // `tabIndex` a re-render restored, is a stop only a walk of the whole page
    // can find.
    const user = userEvent.setup({
      delay: null,
      advanceTimers: (ms) => {
        vi.advanceTimersByTime(ms);
      },
    });
    function ActionsBody(): ReactNode {
      const [late, setLate] = useState(false);
      useEffect(() => {
        const timer = window.setTimeout(() => {
          setLate(true);
        }, CLOSE_DELAY_MS);
        return () => {
          window.clearTimeout(timer);
        };
      }, []);
      return (
        <div>
          <a href="#install" data-testid="content-link">
            Install
          </a>
          <button type="button" data-testid="content-action">
            Refresh
          </button>
          {late ? (
            <button type="button" data-testid="content-late-action">
              Retry
            </button>
          ) : null}
        </div>
      );
    }
    render(
      <div>
        <button type="button" data-testid="first-stop">
          First
        </button>
        {/* Out of the tab order itself: the pointer opened this card, and the
            keyboard never visits its trigger. */}
        <HoverCard
          trigger={
            <button type="button" tabIndex={-1} data-testid="trigger">
              Row
            </button>
          }
          content={<ActionsBody />}
          appearance="preview"
          semantics={{ role: "dialog", label: "Row preview" }}
          side="right"
          align="start"
          sideOffset={8}
          enabled
          open={null}
          onOpenChange={null}
          testId="content"
          className={null}
        />
        <button type="button" data-testid="last-stop">
          Last
        </button>
      </div>,
    );

    hoverIn(screen.getByTestId("trigger"));
    settle(OPEN_DELAY_MS);
    settle(CLOSE_DELAY_MS + 1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("content-late-action")).toBeTruthy();

    act(() => {
      screen.getByTestId("last-stop").focus();
    });
    const stops: Array<string | null> = [];
    for (let press = 0; press < 3; press += 1) {
      await user.tab();
      const active = document.activeElement;
      expect(active?.closest('[data-slot="hover-card-content"]') ?? null).toBe(
        null,
      );
      stops.push(
        active instanceof HTMLElement ? (active.dataset.testid ?? null) : null,
      );
    }

    // The walk went round the page's own stops (past the body, which is where
    // a Tab off the last control leaves), and none of them was the card's.
    expect(stops).toContain("first-stop");
    expect(stops).toContain("last-stop");
    expect(screen.getByTestId("content").getAttribute("data-state")).toBe(
      "open",
    );
  });
});
