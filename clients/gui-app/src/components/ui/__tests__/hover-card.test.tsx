/**
 * Integrated tests for the app's shared hover card
 * (`components/ui/hover-card.tsx`), rebuilt on `@floating-ui/react`. Real
 * component, real Floating UI hooks, driven through `fireEvent` pointer,
 * focus and keyboard events under fake timers.
 *
 * Motion is mocked off (matches `side-tab-strip.test.tsx`'s precedent): with
 * it on, closing schedules a real `requestAnimationFrame`-driven exit before
 * the content unmounts, which is `useTransitionStyles`' concern, not this
 * primitive's open/close/group/dismiss contract.
 */
import { useState, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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

vi.mock("@/lib/animation/use-motion-enabled", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/animation/use-motion-enabled")>();
  return { ...actual, useMotionEnabled: () => false };
});

const OPEN_DELAY_MS = 500;

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
  // Base's own trigger opens on the native button-activation Enter/Space
  // keyup, which jsdom does not synthesize for a bare `fireEvent.keyDown` -
  // a real click is the reliable stand-in for "opened, not by pointer".
  fireEvent.click(trigger);
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
            <ContextMenuTrigger
              render={
                <button type="button" data-testid="menu-trigger">
                  Menu row
                </button>
              }
            />
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
            <ContextMenuTrigger
              render={
                <button type="button" data-testid="menu-trigger">
                  Menu row
                </button>
              }
            />
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
            <DropdownMenuTrigger
              render={
                <button type="button" data-testid="dropdown-trigger">
                  Dropdown
                </button>
              }
            />
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
            <ContextMenuTrigger
              render={
                <button type="button" data-testid="row">
                  Row
                </button>
              }
            />
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
});
