import { useRef } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computePosition } from "@floating-ui/dom";
import { FirstTaskLandingGuide } from "@/components/onboarding/first-task-landing-guide";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";

// jsdom has no layout, so Floating UI is stubbed the same way the coachmark's
// own suite stubs it. What stays real is WHICH element the card is anchored
// to, which is the whole question here.
vi.mock("@floating-ui/dom", () => ({
  computePosition: vi.fn(() =>
    Promise.resolve({
      x: 0,
      y: 0,
      placement: "bottom-start",
      strategy: "fixed",
      middlewareData: {},
    }),
  ),
  autoUpdate: (
    _reference: Element,
    _floating: Element,
    update: () => void,
  ): (() => void) => {
    update();
    return () => undefined;
  },
  offset: () => ({ name: "offset", fn: () => ({}) }),
  flip: () => ({ name: "flip", fn: () => ({}) }),
  shift: () => ({ name: "shift", fn: () => ({}) }),
}));

const viewport = vi.hoisted(() => ({ mobile: true }));
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => viewport.mobile,
  isMobileViewport: () => viewport.mobile,
}));

/** Only the four fields this branch reads off `useHistoryQuery`. */
interface HistoryStub {
  readonly data:
    | { readonly items: ReadonlyArray<{ readonly id: string }> }
    | undefined;
  readonly isPending: boolean;
  readonly cloudPagePending: boolean;
  readonly error: Error | null;
}

const TASKS: HistoryStub = {
  data: { items: [{ id: "epic-1" }] },
  isPending: false,
  cloudPagePending: false,
  error: null,
};

const history = vi.hoisted(() => {
  const state: { current: HistoryStub } = {
    current: {
      data: { items: [{ id: "epic-1" }] },
      isPending: false,
      cloudPagePending: false,
      error: null,
    },
  };
  return state;
});
vi.mock("@/hooks/home/use-history-query", () => ({
  useHistoryQuery: () => history.current,
}));
vi.mock("@/hooks/home/use-history-search-state", () => ({
  useAmbientHistorySearchState: () => ({
    search: {},
    update: () => undefined,
    clear: () => undefined,
  }),
}));
vi.mock("@/hooks/host/use-composer-surface-host-pin", () => ({
  useComposerSurfaceHostPin: () => ({ resolvedHostId: null }),
}));

const positioned = vi.mocked(computePosition);

function lastAnchor(): Element | null {
  const calls = positioned.mock.calls;
  const reference = calls[calls.length - 1]?.[0];
  return reference instanceof Element ? reference : null;
}

/** jsdom measures nothing, and the engine withholds a card for a zero rect. */
function makeVisible(element: HTMLElement): HTMLElement {
  Object.defineProperty(element, "getClientRects", {
    configurable: true,
    value: () => ({ length: 1 }),
  });
  return element;
}

function mountTrigger(): HTMLElement {
  const trigger = document.createElement("button");
  trigger.setAttribute("data-testid", "mobile-nav-trigger");
  document.body.append(makeVisible(trigger));
  return trigger;
}

/**
 * The drawer as the engine sees it: a Sheet, open, with a task row inside it.
 * Portalled to the body rather than nested in the landing surface, which is
 * the arrangement the real shell has and the reason this branch scopes its
 * targets to the document.
 */
const OPEN_SHEET: Readonly<Record<string, string>> = {
  "data-slot": "sheet-content",
  "data-state": "open",
};

const DRAWER_WIDTH_PX = 295;

function mountDrawer(markup: Readonly<Record<string, string>>): {
  readonly row: HTMLElement;
  /** The drawer's own bottom strip, which is what the CARD anchors above. */
  readonly settings: HTMLElement;
} {
  const surface = document.createElement("div");
  for (const [name, value] of Object.entries(markup))
    surface.setAttribute(name, value);
  // The measured width of the real drawer on an iPhone 15 (three quarters of a
  // 393pt screen). jsdom measures nothing, so the card's width clamp has an
  // input only if this says so.
  Object.defineProperty(surface, "clientWidth", {
    configurable: true,
    value: DRAWER_WIDTH_PX,
  });
  const row = document.createElement("button");
  row.setAttribute("data-testid", "mobile-nav-task-row");
  const settings = document.createElement("button");
  settings.setAttribute("data-testid", "mobile-nav-settings");
  surface.append(makeVisible(row), makeVisible(settings));
  document.body.append(surface);
  return { row, settings };
}

function Harness() {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef} data-testid="landing-root">
      <button data-testid="folder-add" type="button">
        Add folder
      </button>
      <FirstTaskLandingGuide rootRef={rootRef} workspaceFolders={null} />
    </div>
  );
}

async function cardTitle(): Promise<string> {
  const card = await screen.findByTestId("guide-coachmark");
  return card.querySelector("h2")?.textContent ?? "";
}

/** The copy lags a step change by the first half of the card's crossfade. */
async function expectCardTitle(title: string): Promise<void> {
  await waitFor(async () => {
    expect(await cardTitle()).toBe(title);
  });
}

describe("FirstTaskLandingGuide mobile tasks branch", () => {
  beforeEach(() => {
    viewport.mobile = true;
    history.current = TASKS;
    positioned.mockClear();
    useMobileNavStore.setState({ open: false });
    useFirstTaskGuideStore.getState().prepare();
    useFirstTaskGuideStore.getState().activate();
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    useMobileNavStore.setState({ open: false });
    useFirstTaskGuideStore.getState().prepare();
  });

  it("points at the hamburger when the account already has tasks", async () => {
    const trigger = mountTrigger();
    render(<Harness />);
    fireEvent(window, new Event("resize"));

    await expectCardTitle("Your tasks live here");
    await waitFor(() => expect(lastAnchor()).toBe(trigger));
    expect(
      screen.getByTestId("guide-coachmark-progress").getAttribute("aria-label"),
    ).toBe("Step 1 of 2");
  });

  it("moves into the open drawer, and back out when it closes", async () => {
    mountTrigger();
    render(<Harness />);
    fireEvent(window, new Event("resize"));
    await screen.findByTestId("guide-coachmark");

    const { row } = mountDrawer(OPEN_SHEET);
    useMobileNavStore.setState({ open: true });
    fireEvent(window, new Event("resize"));

    // The card anchors on the row the halo is on and overlays what follows:
    // parked at the bottom of the drawer it read as unrelated to the task it
    // was pointing at.
    await waitFor(() => expect(lastAnchor()).toBe(row));
    expect(screen.getByTestId("guide-coachmark-halo")).toBeTruthy();
    await expectCardTitle("Resume any task");
    // Inside the drawer, not beside it: a modal surface seals every body-level
    // sibling off, so a card left at the body would be on screen and dead.
    expect(
      screen
        .getByTestId("guide-coachmark")
        .closest('[data-slot="sheet-content"]'),
    ).toBe(row.parentElement);
    // A surface that already owns attention is not dimmed, and the card is
    // lifted over its layer.
    expect(screen.queryByTestId("guide-coachmark-dim")).toBeNull();
    expect(screen.getByTestId("guide-coachmark-halo").dataset.overOverlay).toBe(
      "true",
    );

    // Closing without picking is not an answer, so step 1 comes back.
    row.closest('[data-slot="sheet-content"]')?.remove();
    useMobileNavStore.setState({ open: false });
    fireEvent(window, new Event("resize"));

    await expectCardTitle("Your tasks live here");
    expect(useFirstTaskGuideStore.getState().acknowledgedHints.size).toBe(0);
  });

  // The installed app's drawer is hand-rolled - it owns its transform so a
  // finger can reverse it mid-flight - so it carries no shadcn slot and says
  // the same two things on one attribute instead.
  it("portals into the installed app's hand-rolled drawer too", async () => {
    mountTrigger();
    render(<Harness />);
    fireEvent(window, new Event("resize"));
    await screen.findByTestId("guide-coachmark");

    const { row } = mountDrawer({ "data-overlay-surface": "open" });
    useMobileNavStore.setState({ open: true });
    fireEvent(window, new Event("resize"));

    await waitFor(() => expect(lastAnchor()).toBe(row));
    expect(
      screen.getByTestId("guide-coachmark").closest("[data-overlay-surface]"),
    ).toBe(row.parentElement);
    expect(screen.queryByTestId("guide-coachmark-dim")).toBeNull();
  });

  // jsdom resolves no `min()`, so what is asserted is the INPUT the clamp is
  // written against: the surface the card was portalled into, not the viewport.
  // Measured, a 22rem card against `100vw` overhung the 295pt drawer by 145pt.
  it("clamps its width to the surface it is portalled into", async () => {
    mountTrigger();
    render(<Harness />);
    fireEvent(window, new Event("resize"));
    await screen.findByTestId("guide-coachmark");

    mountDrawer(OPEN_SHEET);
    useMobileNavStore.setState({ open: true });
    fireEvent(window, new Event("resize"));

    await waitFor(() => {
      const floater = screen
        .getByTestId("guide-coachmark")
        .closest(".first-task-coachmark-floater");
      expect(
        floater instanceof HTMLElement
          ? floater.style.getPropertyValue("--coachmark-available")
          : null,
      ).toBe(`${DRAWER_WIDTH_PX}px`);
    });
  });

  // The bug this replaced: step 2's button was "Show me" and only FOCUSED the
  // row. There is no visible focus on a touch device and no keyboard to carry
  // it, so the card's only affordance measurably did nothing. It opens the task
  // now, which is the gesture the step is teaching.
  it("opens the first task from step two's action and ends the guide", async () => {
    mountTrigger();
    render(<Harness />);
    fireEvent(window, new Event("resize"));
    await screen.findByTestId("guide-coachmark");

    const { row } = mountDrawer(OPEN_SHEET);
    // What the real drawer's `openItem` does when a row is pressed.
    const opened = vi.fn(() => {
      const guide = useFirstTaskGuideStore.getState();
      if (guide.status === "active") guide.dismiss();
    });
    row.addEventListener("click", opened);
    useMobileNavStore.setState({ open: true });
    fireEvent(window, new Event("resize"));
    await expectCardTitle("Resume any task");

    fireEvent.click(screen.getByRole("button", { name: /Open task/ }));

    expect(opened).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(row);
    expect(useFirstTaskGuideStore.getState().status).toBe("finished");
  });

  // The X and Escape are still a dismissal, not an open: the step has a way out
  // that is not "resume something".
  it("still dismisses from the card's X and from Escape without opening a task", async () => {
    mountTrigger();
    render(<Harness />);
    fireEvent(window, new Event("resize"));
    await screen.findByTestId("guide-coachmark");

    const { row } = mountDrawer(OPEN_SHEET);
    const opened = vi.fn();
    row.addEventListener("click", opened);
    useMobileNavStore.setState({ open: true });
    fireEvent(window, new Event("resize"));
    await expectCardTitle("Resume any task");

    fireEvent.keyDown(row, { key: "Escape" });
    expect(opened).not.toHaveBeenCalled();
    expect(useFirstTaskGuideStore.getState().status).toBe("finished");

    useFirstTaskGuideStore.getState().activate();
    await screen.findByTestId("guide-coachmark");
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss getting started guide" }),
    );

    expect(opened).not.toHaveBeenCalled();
    expect(useFirstTaskGuideStore.getState().status).toBe("finished");
  });

  it("points at the menu at once, while the task query is still outstanding", async () => {
    // A fresh install waits on cloud authorization and then on the first page
    // for many seconds. Drawing nothing for that long meant the user had opened
    // the menu themselves before step 1 ever appeared.
    history.current = { ...TASKS, data: undefined, isPending: true };
    mountTrigger();
    render(<Harness />);
    // Visible, so falling through to the folder flow would draw ITS card.
    makeVisible(screen.getByTestId("folder-add"));
    fireEvent(window, new Event("resize"));

    await expectCardTitle("Your tasks live here");
  });

  it("stays on the menu step while only the cloud page is pending", async () => {
    history.current = { ...TASKS, data: { items: [] }, cloudPagePending: true };
    mountTrigger();
    render(<Harness />);
    makeVisible(screen.getByTestId("folder-add"));
    fireEvent(window, new Event("resize"));

    await expectCardTitle("Your tasks live here");
  });

  it("hides the card and halo while the target is scrolled out of sight", async () => {
    // Measured on a phone: the highlighted row scrolled out of the drawer's
    // list, and the fixed halo and card followed its rect over the status bar
    // and the drawer's header. Hit-testing the target's edges is the gate.
    const trigger = mountTrigger();
    Object.defineProperty(trigger, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(16, 60, 44, 44),
    });
    const cover = document.createElement("div");
    document.body.append(cover);
    const occludedWhenHitting = async (hit: Element): Promise<string> => {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => hit,
      });
      try {
        render(<Harness />);
        fireEvent(window, new Event("resize"));
        const card = await screen.findByTestId("guide-coachmark");
        const floater = card.closest<HTMLElement>(
          ".first-task-coachmark-floater",
        );
        await waitFor(() => expect(floater?.dataset.occluded).toBeDefined());
        expect(
          screen.getByTestId("guide-coachmark-halo").dataset.occluded,
        ).toBe(floater?.dataset.occluded);
        return floater?.dataset.occluded ?? "";
      } finally {
        Reflect.deleteProperty(document, "elementFromPoint");
        cleanup();
      }
    };

    // Something else is on top of the target's edges: it is out of sight.
    expect(await occludedWhenHitting(cover)).toBe("true");
    // The target itself answers the hit test: it is on show.
    expect(await occludedWhenHitting(trigger)).toBe("false");
  });

  it("falls through to the folder flow for an account with no tasks", async () => {
    history.current = { ...TASKS, data: { items: [] } };
    mountTrigger();
    render(<Harness />);
    makeVisible(screen.getByTestId("folder-add"));
    fireEvent(window, new Event("resize"));

    await expectCardTitle("Pick a project");
  });

  it("leaves the desktop flow alone", async () => {
    viewport.mobile = false;
    mountTrigger();
    render(<Harness />);
    makeVisible(screen.getByTestId("folder-add"));
    fireEvent(window, new Event("resize"));

    await expectCardTitle("Pick a project");
  });
});
