import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { useRowSwipeTray } from "@/components/epics/mobile/use-row-swipe-tray";
import { useMobileHistorySwipes } from "@/components/layout/shell/use-mobile-history-swipes";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { getHistoryController } from "@/lib/history-navigation";
import { createAppRouter } from "@/router";
import { setMobileApp, setMobileAppPlatform } from "@/lib/mobile-app";
import { useMobileSwitcherStore } from "@/stores/epics/mobile-switcher-store";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useTabsStore } from "@/stores/tabs/store";

/**
 * A closed History row and the shell's trailing-edge navigation swipe both
 * answer a leftward drag that starts in the trailing band. Which of them gets
 * it is decided by whether the shell actually TAKES the gesture - it has a
 * live action for it - not by where the touch landed: a row that yields the band whenever
 * the geometry says "shell zone" leaves a dead strip wherever the shell stands
 * down - a browser tab, a screen with no selector to open, a covered app.
 *
 * Everything here is real: the shell recognizer, the row hook, the stores and
 * the history, driven by the same pointer events through one DOM element. The
 * only thing asserted is who took the touch.
 */
function Screen(props: {
  readonly onRevealStart: () => void;
  readonly sheetOpen: boolean;
}) {
  useMobileHistorySwipes();
  const tray = useRowSwipeTray({
    actionCount: 2,
    isOpen: false,
    onOpenChange: () => {},
    disabled: false,
    onDragStart: props.onRevealStart,
  });
  return (
    <>
      <div data-testid="row" {...tray.handlers} />
      <Sheet open={props.sheetOpen}>
        <SheetContent side="bottom">
          <SheetTitle>Confirm</SheetTitle>
        </SheetContent>
      </Sheet>
    </>
  );
}

function mount(options: {
  readonly history: RouterHistory;
  readonly onRevealStart: () => void;
  readonly sheetOpen: boolean;
}): void {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => null }),
    history: options.history,
  });
  render(
    <RouterContextProvider router={router}>
      <Screen
        onRevealStart={options.onRevealStart}
        sheetOpen={options.sheetOpen}
      />
    </RouterContextProvider>,
  );
}

/** A leftward drag from inside the trailing band, on the row. */
function trailingPan(): void {
  const row = screen.getByTestId("row");
  const touch = { pointerType: "touch", isPrimary: true, pointerId: 1 };
  act(() => {
    fireEvent.pointerDown(row, { ...touch, clientX: 380, clientY: 300 });
    fireEvent.pointerMove(row, { ...touch, clientX: 320, clientY: 300 });
  });
}

function fireTouchOnRow(type: string, clientX: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { clientX, clientY: 300 };
  Object.defineProperty(event, "touches", {
    value: Object.assign([point], { item: () => point }),
  });
  act(() => {
    screen.getByTestId("row").dispatchEvent(event);
  });
  return event;
}

/** The release of that drag, which is where a followed swipe commits. */
function releaseTrailingPan(): void {
  act(() => {
    fireEvent.pointerUp(screen.getByTestId("row"), {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 1,
      clientX: 160,
      clientY: 300,
    });
  });
}

/**
 * The history the installed app boots with, at its newest entry: the shell can
 * see there is nothing ahead of it, so a forward step has no destination.
 */
function history(): RouterHistory {
  return createAppRouter(null, null).history;
}

/**
 * A plain history with no brand: it cannot say what is ahead of it, so the
 * shell keeps its discrete forward step instead of declaring the swipe
 * unavailable.
 */
function plainHistory(): RouterHistory {
  return createMemoryHistory({ initialEntries: ["/", "/epics"] });
}

/**
 * The history the installed app actually boots with, stepped back once so a
 * forward step has an entry to land on. A plain memory history has no way to
 * say what is ahead of it, so the shell could never claim a forward swipe on it.
 */
function historyWithForwardEntry(): RouterHistory {
  const stack = createAppRouter(null, null).history;
  stack.push("/epics");
  stack.go(-1);
  return stack;
}

describe("who takes a leftward drag from the trailing band of a closed row", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      value: 400,
      configurable: true,
    });
    setMobileApp(true);
    setMobileAppPlatform("android");
    useSettingsStore.setState({ mobileSwipeHistory: false });
    useTabsStore.setState({
      version: 2,
      items: [],
      activeItemId: null,
      stripOrder: [],
      systemTabs: { history: null, settings: null },
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setMobileApp(false);
    setMobileAppPlatform(null);
    useSettingsStore.setState({ mobileSwipeHistory: false });
    useMobileNavStore.setState({ open: false });
    useMobileSwitcherStore.setState({ swipeOpenByTabId: {} });
  });

  // No shell recognizer exists outside the installed app: the browser tab and
  // an iOS build keep the row's whole width.
  it("gives the row the band in a plain browser tab", () => {
    setMobileApp(false);
    setMobileAppPlatform(null);
    const reveal = vi.fn();
    mount({ history: history(), onRevealStart: reveal, sheetOpen: false });

    trailingPan();

    expect(reveal).toHaveBeenCalledTimes(1);
  });

  // The arbitration is Android's: an iOS build keeps the row exactly as it was.
  it("keeps the row's whole width in an iOS build", () => {
    setMobileAppPlatform("ios");
    const reveal = vi.fn();
    mount({ history: history(), onRevealStart: reveal, sheetOpen: false });

    trailingPan();

    expect(reveal).toHaveBeenCalledTimes(1);
  });

  // The default mode forwards the trailing swipe to the focused task's tile
  // selector. With no selector registered (the History screen has none) the
  // shell declines, and a decline owes nothing, so the row is free to reveal.
  it("gives the row the band when the shell has no selector to open", () => {
    const stack = history();
    const forward = vi.spyOn(stack, "forward");
    const reveal = vi.fn();
    mount({ history: stack, onRevealStart: reveal, sheetOpen: false });

    trailingPan();

    expect(reveal).toHaveBeenCalledTimes(1);
    expect(forward).not.toHaveBeenCalled();
  });

  it("leaves the band to the shell when it has a selector to open", () => {
    const ref = { kind: "epic" as const, id: "task-tab" };
    useTabsStore.setState({
      items: [{ kind: "tab", id: "item", ref }],
      activeItemId: "item",
      stripOrder: [ref],
    });
    const open = vi.fn();
    useMobileSwitcherStore.getState().registerSwipeOpen(ref.id, open);
    const reveal = vi.fn();
    mount({ history: history(), onRevealStart: reveal, sheetOpen: false });

    trailingPan();

    expect(open).toHaveBeenCalledTimes(1);
    expect(reveal).not.toHaveBeenCalled();
  });

  it("leaves the band to the shell's history-forward step when there is an entry to step to", async () => {
    useSettingsStore.setState({ mobileSwipeHistory: true });
    const stack = historyWithForwardEntry();
    const controller = getHistoryController(stack);
    if (controller === null) throw new Error("the app history lost its brand");
    const before = controller.getIndex();
    const reveal = vi.fn();
    mount({ history: stack, onRevealStart: reveal, sheetOpen: false });

    trailingPan();
    releaseTrailingPan();

    await waitFor(() => {
      expect(controller.getIndex()).toBe(before + 1);
    });
    expect(reveal).not.toHaveBeenCalled();
  });

  // The same setting with nothing ahead: the shell has no live action, so the
  // gesture is not its and the row keeps it.
  it("gives the row the band when swipe history is on but there is nothing to step forward to", () => {
    useSettingsStore.setState({ mobileSwipeHistory: true });
    const stack = history();
    const forward = vi.spyOn(stack, "forward");
    const reveal = vi.fn();
    mount({ history: stack, onRevealStart: reveal, sheetOpen: false });

    trailingPan();

    expect(reveal).toHaveBeenCalledTimes(1);
    expect(forward).not.toHaveBeenCalled();
  });

  // Ownership by something covering the app: the shell stands down, so
  // nothing else wants the band.
  it("gives the row the band while the navigation drawer is out", () => {
    useSettingsStore.setState({ mobileSwipeHistory: true });
    useMobileNavStore.setState({ open: true });
    const reveal = vi.fn();
    mount({
      history: historyWithForwardEntry(),
      onRevealStart: reveal,
      sheetOpen: false,
    });

    trailingPan();

    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("gives the row the band while a modal layer covers the app", async () => {
    useSettingsStore.setState({ mobileSwipeHistory: true });
    const reveal = vi.fn();
    mount({
      history: historyWithForwardEntry(),
      onRevealStart: reveal,
      sheetOpen: true,
    });
    await waitFor(() => {
      expect(document.body.style.pointerEvents).toBe("none");
    });

    trailingPan();

    expect(reveal).toHaveBeenCalledTimes(1);
  });

  // Plain history cannot be asked what is ahead, so a missing answer is not
  // "nothing there": the shell attempts the step, and the row does not reveal.
  it("leaves the band to the shell's discrete forward step on a plain history", () => {
    useSettingsStore.setState({ mobileSwipeHistory: true });
    const stack = plainHistory();
    const forward = vi.spyOn(stack, "forward");
    const reveal = vi.fn();
    mount({ history: stack, onRevealStart: reveal, sheetOpen: false });

    trailingPan();

    expect(forward).toHaveBeenCalledTimes(1);
    expect(reveal).not.toHaveBeenCalled();
  });

  /**
   * The touch stream is reserved from the browser at touch-down, before any
   * pointer move can be arbitrated, so the no-action decision has to be made
   * there too: a contact the shell would pass on must stay scrollable.
   */
  describe("reserving the touch stream from the browser", () => {
    function touchPan(): { readonly cancelled: boolean } {
      fireTouchOnRow("touchstart", 380);
      return { cancelled: fireTouchOnRow("touchmove", 320).defaultPrevented };
    }

    it("leaves a contact the shell would pass on to the page", () => {
      mount({ history: history(), onRevealStart: vi.fn(), sheetOpen: false });

      expect(touchPan().cancelled).toBe(false);
    });

    it("reserves a contact the shell has a selector to open for", () => {
      const ref = { kind: "epic" as const, id: "task-tab" };
      useTabsStore.setState({
        items: [{ kind: "tab", id: "item", ref }],
        activeItemId: "item",
        stripOrder: [ref],
      });
      useMobileSwitcherStore.getState().registerSwipeOpen(ref.id, vi.fn());
      mount({ history: history(), onRevealStart: vi.fn(), sheetOpen: false });

      expect(touchPan().cancelled).toBe(true);
    });

    it("reserves a forward contact when there is an entry to step to", () => {
      useSettingsStore.setState({ mobileSwipeHistory: true });
      mount({
        history: historyWithForwardEntry(),
        onRevealStart: vi.fn(),
        sheetOpen: false,
      });

      expect(touchPan().cancelled).toBe(true);
    });

    it("leaves a forward contact to the page when swipe history has nothing ahead", () => {
      useSettingsStore.setState({ mobileSwipeHistory: true });
      mount({ history: history(), onRevealStart: vi.fn(), sheetOpen: false });

      expect(touchPan().cancelled).toBe(false);
    });
  });

  // A claim is the shell taking ONE pointer's move. Another finger's claimed
  // move that passes through the row must not end the contact the row is
  // tracking for a different pointer.
  it("keeps the row's own contact when a different pointer's move is the shell's", () => {
    const ref = { kind: "epic" as const, id: "task-tab" };
    useTabsStore.setState({
      items: [{ kind: "tab", id: "item", ref }],
      activeItemId: "item",
      stripOrder: [ref],
    });
    useMobileSwitcherStore.getState().registerSwipeOpen(ref.id, vi.fn());
    const reveal = vi.fn();
    mount({ history: history(), onRevealStart: reveal, sheetOpen: false });
    const row = screen.getByTestId("row");
    const finger = (pointerId: number) => ({
      pointerType: "touch",
      isPrimary: true,
      pointerId,
      clientY: 300,
    });

    act(() => {
      // Pointer 1 starts on the row, well inside the screen.
      fireEvent.pointerDown(row, { ...finger(1), clientX: 300 });
      // Pointer 2 lands in the trailing band on the page and is the shell's.
      fireEvent.pointerDown(document.body, { ...finger(2), clientX: 380 });
      fireEvent.pointerMove(row, { ...finger(2), clientX: 320 });
      fireEvent.pointerMove(row, { ...finger(1), clientX: 240 });
    });

    expect(reveal).toHaveBeenCalledTimes(1);
  });

  /**
   * One physical contact reaches the page as pointerdown and THEN touchstart,
   * and the focused task can change between them. The two must answer the
   * contact the same way, or the browser is told to give up a touch nothing
   * acts on, or keeps one something does. The eligibility the pointer saw is
   * the contact's, and the next contact starts clean.
   */
  /**
   * A stylus reaches Android as `pen` pointer events and the same touch
   * events, so it is a contact the shell takes exactly as a finger is.
   */
  describe.each(["touch", "pen"])(
    "a %s contact whose focus changes between pointerdown and touchstart",
    (pointerType) => {
      // The row swipe is a finger's: it never tracks a stylus, so a contact the
      // shell passes on reveals the row for touch and for nothing else.
      const rowReveals = pointerType === "touch" ? 1 : 0;

      const REF = { kind: "epic" as const, id: "task-tab" };

      function focusTaskWithSelector(open: () => void): void {
        useTabsStore.setState({
          items: [{ kind: "tab", id: "item", ref: REF }],
          activeItemId: "item",
          stripOrder: [REF],
        });
        useMobileSwitcherStore.getState().registerSwipeOpen(REF.id, open);
      }

      function focusNothing(): void {
        useTabsStore.setState({
          items: [],
          activeItemId: null,
          stripOrder: [],
        });
        useMobileSwitcherStore.setState({ swipeOpenByTabId: {} });
      }

      const finger = {
        pointerType,
        isPrimary: true,
        pointerId: 1,
        clientY: 300,
      };

      /** pointerdown, [between], touchstart, pointer + touch move, release. */
      function contact(between: () => void): { readonly cancelled: boolean } {
        const row = screen.getByTestId("row");
        act(() => {
          fireEvent.pointerDown(row, { ...finger, clientX: 380 });
        });
        act(between);
        fireTouchOnRow("touchstart", 380);
        act(() => {
          fireEvent.pointerMove(row, { ...finger, clientX: 320 });
        });
        const move = fireTouchOnRow("touchmove", 320);
        act(() => {
          fireEvent.pointerUp(row, { ...finger, clientX: 320 });
        });
        fireTouchOnRow("touchend", 320);
        return { cancelled: move.defaultPrevented };
      }

      it("keeps the touch and the navigation together when the selector disappears mid-contact", () => {
        const open = vi.fn();
        focusTaskWithSelector(open);
        const reveal = vi.fn();
        mount({ history: history(), onRevealStart: reveal, sheetOpen: false });

        const first = contact(focusNothing);

        expect(first.cancelled).toBe(true);
        expect(open).toHaveBeenCalledTimes(1);
        expect(reveal).not.toHaveBeenCalled();

        // The next contact starts clean: nothing to open, so nothing reserved.
        const second = contact(() => {});

        expect(second.cancelled).toBe(false);
        expect(open).toHaveBeenCalledTimes(1);
        expect(reveal).toHaveBeenCalledTimes(rowReveals);
      });

      // A touch with no pointer event before it has no snapshot to follow and is
      // judged live. A snapshot left over from the contact before must not answer
      // for it, even at the same coordinates.
      it("judges a touch with no pointer before it live once the last contact has ended", () => {
        focusTaskWithSelector(vi.fn());
        mount({ history: history(), onRevealStart: vi.fn(), sheetOpen: false });
        contact(() => {});

        focusNothing();
        fireTouchOnRow("touchstart", 380);
        const move = fireTouchOnRow("touchmove", 320);

        expect(move.defaultPrevented).toBe(false);
      });

      // The pointer's decision answers the ONE touchstart it belongs to. A later
      // touchstart at the same spot, with no pointer event of its own in between,
      // is judged on what is true now.
      it("answers only one touchstart from a pointer's snapshot", () => {
        focusTaskWithSelector(vi.fn());
        mount({ history: history(), onRevealStart: vi.fn(), sheetOpen: false });
        act(() => {
          fireEvent.pointerDown(screen.getByTestId("row"), {
            ...finger,
            clientX: 380,
          });
        });
        fireTouchOnRow("touchstart", 380);
        fireTouchOnRow("touchend", 380);

        focusNothing();
        fireTouchOnRow("touchstart", 380);
        const move = fireTouchOnRow("touchmove", 320);

        expect(move.defaultPrevented).toBe(false);
      });

      // Another finger lifting is not the end of this contact.
      it("keeps the contact's snapshot when a different pointer is released", () => {
        focusTaskWithSelector(vi.fn());
        mount({ history: history(), onRevealStart: vi.fn(), sheetOpen: false });
        act(() => {
          fireEvent.pointerDown(screen.getByTestId("row"), {
            ...finger,
            clientX: 380,
          });
          fireEvent.pointerUp(document.body, {
            ...finger,
            pointerId: 2,
            isPrimary: false,
            clientX: 100,
          });
        });

        focusNothing();
        fireTouchOnRow("touchstart", 380);
        const move = fireTouchOnRow("touchmove", 320);

        expect(move.defaultPrevented).toBe(true);
      });

      it("keeps the touch and the navigation together when a selector appears mid-contact", () => {
        const open = vi.fn();
        const reveal = vi.fn();
        mount({ history: history(), onRevealStart: reveal, sheetOpen: false });

        const first = contact(() => {
          focusTaskWithSelector(open);
        });

        expect(first.cancelled).toBe(false);
        expect(open).not.toHaveBeenCalled();
        expect(reveal).toHaveBeenCalledTimes(rowReveals);

        // The next contact starts clean: there is a selector now, so it is the
        // shell's end to end.
        const second = contact(() => {});

        expect(second.cancelled).toBe(true);
        expect(open).toHaveBeenCalledTimes(1);
        expect(reveal).toHaveBeenCalledTimes(rowReveals);
      });
    },
  );
});
