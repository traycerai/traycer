import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { resetStatusAnimationClockForTests } from "@/lib/animation/status-animation-clock";
import { TabLeadingIcon } from "../tab-leading-icon";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import type { HeaderTabAppearance, TabIcon } from "@/stores/tabs/types";

function idleState(): NotificationIndicatorState {
  return {
    unreadFailure: false,
    unreadNonTerminalFailure: false,
    unreadTerminalFailure: false,
    pendingFork: false,
    pendingApproval: false,
    pendingInterview: false,
    unreadDone: false,
  };
}

const appearance: HeaderTabAppearance = { color: "#112233", icon: "🚀" };
const DefaultTabIcon: TabIcon = (props) => (
  <svg className={props.className} data-testid="default-tab-icon" />
);

afterEach(() => cleanup());

describe("TabLeadingIcon status and manual icon", () => {
  it("shows the first two graphemes of a long manual icon", () => {
    const identity: HeaderTabAppearance = {
      color: "#112233",
      icon: "TRAYCER",
    };
    render(
      <TabLeadingIcon
        icon={null}
        identity={identity}
        titleGenerationPending={false}
        activityStatus="idle"
        indicatorState={idleState()}
        tabId="tab-long-icon"
      />,
    );
    const manual = document.querySelector('[data-slot="tab-custom-icon"]');
    if (manual === null) throw new Error("expected manual icon slot");
    expect(manual.textContent).toBe("TR");
    expect(identity.icon).toBe("TRAYCER");
  });

  it.each([
    ["a family ZWJ emoji", "👨‍👩‍👧‍👦"],
    ["a flag emoji", "🇺🇸"],
  ])("keeps %s together as one manual icon", (_name, icon) => {
    render(
      <TabLeadingIcon
        icon={null}
        identity={{ color: "#112233", icon }}
        titleGenerationPending={false}
        activityStatus="idle"
        indicatorState={idleState()}
        tabId="tab-grapheme-icon"
      />,
    );
    const manual = document.querySelector('[data-slot="tab-custom-icon"]');
    if (manual === null) throw new Error("expected manual icon slot");
    expect(manual.textContent).toBe(icon);
  });

  it("keeps the status slot first and the readable manual icon second", () => {
    render(
      <TabLeadingIcon
        icon={null}
        identity={appearance}
        titleGenerationPending={false}
        activityStatus="idle"
        indicatorState={idleState()}
        tabId="tab-order"
      />,
    );
    const status = document.querySelector('[data-slot="tab-status-icon"]');
    const manual = document.querySelector('[data-slot="tab-custom-icon"]');
    expect(status).not.toBeNull();
    expect(manual).not.toBeNull();
    if (status === null || manual === null)
      throw new Error("expected leading icon slots");
    expect(
      Boolean(
        status.compareDocumentPosition(manual) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(screen.getByText("🚀")).toBeTruthy();
  });

  it("keeps the status slot mounted while idle content changes from loading to the default icon", () => {
    const { rerender } = render(
      <TabLeadingIcon
        icon={DefaultTabIcon}
        identity={null}
        titleGenerationPending
        activityStatus="idle"
        indicatorState={idleState()}
        tabId="tab-status"
      />,
    );
    const status = document.querySelector('[data-slot="tab-status-icon"]');
    expect(
      screen.getByTestId("header-tab-title-generating-tab-status"),
    ).toBeTruthy();
    rerender(
      <TabLeadingIcon
        icon={DefaultTabIcon}
        identity={null}
        titleGenerationPending={false}
        activityStatus="idle"
        indicatorState={idleState()}
        tabId="tab-status"
      />,
    );
    expect(document.querySelector('[data-slot="tab-status-icon"]')).toBe(
      status,
    );
    expect(screen.getByTestId("default-tab-icon")).toBeTruthy();
  });

  it("keeps the manual icon alongside running activity and attention status", () => {
    const { rerender } = render(
      <TabLeadingIcon
        icon={null}
        identity={appearance}
        titleGenerationPending={false}
        activityStatus="turn"
        indicatorState={idleState()}
        tabId="tab-3"
      />,
    );
    expect(screen.getByText("🚀")).toBeTruthy();
    expect(screen.getByTestId("header-tab-activity-tab-3")).toBeTruthy();
    rerender(
      <TabLeadingIcon
        icon={null}
        identity={appearance}
        titleGenerationPending={false}
        activityStatus="idle"
        indicatorState={{
          ...idleState(),
          unreadFailure: true,
          unreadNonTerminalFailure: true,
        }}
        tabId="tab-3"
      />,
    );
    expect(screen.queryByTestId("header-tab-activity-tab-3")).toBeNull();
    expect(screen.getByTestId("header-tab-failure-tab-3")).toBeTruthy();
    expect(screen.getByText("🚀")).toBeTruthy();
  });

  it("renders running status with no manual icon", () => {
    render(
      <TabLeadingIcon
        icon={null}
        identity={null}
        titleGenerationPending={false}
        activityStatus="turn"
        indicatorState={idleState()}
        tabId="tab-4"
      />,
    );
    expect(screen.getByTestId("header-tab-activity-tab-4")).toBeTruthy();
    expect(document.querySelector('[data-slot="tab-custom-icon"]')).toBeNull();
    // Drawn through the shared glyph set, like the side strip row (F3).
    const status = document.querySelector('[data-slot="tab-status-icon"]');
    expect(
      status
        ?.querySelector("[data-status-glyph]")
        ?.getAttribute("data-status-glyph"),
    ).toBe("running");
  });
});

/**
 * `AgentSpinningDots`' default ("dots") frames: the ten braille cells a
 * running agent shows everywhere. Written out here rather than imported,
 * because the claim is that the glyph draws THESE and not some other preset.
 */
const RUNNING_DOTS_FRAMES: ReadonlyArray<string> = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

const RUNNING_STATUS_NAME = "Task activity in progress";

interface ReducedMotionPreference {
  /** Flips what the stubbed MediaQueryList reports as `matches`. */
  readonly setMatches: (matches: boolean) => void;
  /** Invokes every `change` listener the clock registered on the stub. */
  readonly fireChange: () => void;
}

/**
 * The global test shim answers every media query with `matches: false`. This
 * answers the reduced-motion query alone, from a value a test can flip
 * mid-run, and records the `change` listener the shared status clock attaches
 * (once, on its first subscription after a reset) so the flip reaches it.
 */
function stubReducedMotion(initial: boolean): ReducedMotionPreference {
  let matches = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches(): boolean {
      return query === "(prefers-reduced-motion: reduce)" ? matches : false;
    },
    media: query,
    onchange: null,
    addEventListener: (type: string, listener: () => void) => {
      if (type === "change") listeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === "change") listeners.delete(listener);
    },
    dispatchEvent: () => false,
  }));
  return {
    setMatches: (next) => {
      matches = next;
    },
    fireChange: () => {
      for (const listener of listeners) listener();
    },
  };
}

function runningGlyph(): HTMLElement {
  const glyph = document.querySelector<HTMLElement>(
    '[data-status-glyph="running"]',
  );
  if (glyph === null) throw new Error("expected a running status glyph");
  return glyph;
}

/** What assistive tech hears for the glyph: its enclosing status's name. */
function statusNameOf(glyph: HTMLElement): string | null {
  return glyph.closest('[role="status"]')?.getAttribute("aria-label") ?? null;
}

function renderRunningTab(): void {
  render(
    <TabLeadingIcon
      icon={null}
      identity={null}
      titleGenerationPending={false}
      activityStatus="turn"
      indicatorState={idleState()}
      tabId="tab-running"
    />,
  );
}

function advanceClock(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/**
 * The claim the retired browser driver's running phase made of the expanded strip and
 * the top header: both draw a running turn through this one component, so what
 * the glyph IS and how it moves are decided here. The shared status clock is
 * the only timer, and it is driven by fake timers.
 */
describe("a running turn's status glyph", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStatusAnimationClockForTests();
  });

  afterEach(() => {
    cleanup();
    resetStatusAnimationClockForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("is AgentSpinningDots' default dots inside a status named for the task: one braille frame, no svg, the same name on every frame", () => {
    renderRunningTab();
    const glyph = runningGlyph();

    expect(glyph.querySelector("svg")).toBeNull();
    const frames: string[] = [];
    const names: Array<string | null> = [];
    for (let step = 0; step < RUNNING_DOTS_FRAMES.length; step += 1) {
      frames.push(glyph.textContent);
      names.push(statusNameOf(glyph));
      advanceClock(80);
    }

    // Every sample is exactly one of the ten cells, and they are not all the
    // same one: the dots really moved across the samples.
    expect(frames.every((frame) => RUNNING_DOTS_FRAMES.includes(frame))).toBe(
      true,
    );
    expect(new Set(frames).size).toBeGreaterThan(1);
    expect(new Set(names)).toEqual(new Set([RUNNING_STATUS_NAME]));
  });

  it("holds one visible frame under prefers-reduced-motion: reduce with the same status name, and moves again once the preference clears", () => {
    // Installed BEFORE the first render: the clock attaches its change
    // listener once, on the first subscription after a reset.
    const preference = stubReducedMotion(true);
    renderRunningTab();
    const glyph = runningGlyph();
    const held = glyph.textContent;
    // A real frame, not a blank: the held glyph is still a drawn cell.
    expect(RUNNING_DOTS_FRAMES).toContain(held);

    advanceClock(1000);

    expect(glyph.textContent).toBe(held);
    expect(glyph.querySelector("svg")).toBeNull();
    expect(statusNameOf(glyph)).toBe(RUNNING_STATUS_NAME);

    // The control: the same mounted glyph advances once motion is allowed, so
    // the hold above is the preference's doing and not a glyph that never moves.
    preference.setMatches(false);
    act(() => {
      preference.fireChange();
    });
    advanceClock(400);

    expect(RUNNING_DOTS_FRAMES).toContain(glyph.textContent);
    expect(glyph.textContent).not.toBe(held);
    expect(statusNameOf(glyph)).toBe(RUNNING_STATUS_NAME);
  });
});
