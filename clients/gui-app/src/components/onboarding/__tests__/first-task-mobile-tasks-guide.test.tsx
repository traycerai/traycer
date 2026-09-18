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

function mountDrawer(markup: Readonly<Record<string, string>>): HTMLElement {
  const surface = document.createElement("div");
  for (const [name, value] of Object.entries(markup))
    surface.setAttribute(name, value);
  const row = document.createElement("button");
  row.setAttribute("data-testid", "mobile-nav-task-row");
  surface.append(makeVisible(row));
  document.body.append(surface);
  return row;
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

    const row = mountDrawer(OPEN_SHEET);
    useMobileNavStore.setState({ open: true });
    fireEvent(window, new Event("resize"));

    await waitFor(() => expect(lastAnchor()).toBe(row));
    await expectCardTitle("Pick up where you left off");
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

    const row = mountDrawer({ "data-overlay-surface": "open" });
    useMobileNavStore.setState({ open: true });
    fireEvent(window, new Event("resize"));

    await waitFor(() => expect(lastAnchor()).toBe(row));
    expect(
      screen.getByTestId("guide-coachmark").closest("[data-overlay-surface]"),
    ).toBe(row.parentElement);
    expect(screen.queryByTestId("guide-coachmark-dim")).toBeNull();
  });

  it("draws nothing while the task query is still outstanding", () => {
    history.current = { ...TASKS, data: undefined, isPending: true };
    mountTrigger();
    render(<Harness />);
    // Visible, so a guide that fell through to the folder flow here would
    // draw a card - which is the flip this step must not do mid-read.
    makeVisible(screen.getByTestId("folder-add"));
    fireEvent(window, new Event("resize"));

    expect(screen.queryByTestId("guide-coachmark")).toBeNull();
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
