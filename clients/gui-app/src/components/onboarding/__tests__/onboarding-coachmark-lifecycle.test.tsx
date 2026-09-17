import { useRef } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computePosition } from "@floating-ui/dom";
import { OnboardingCoachmark } from "@/components/onboarding/onboarding-coachmark";

// See `first-task-coachmark.test.tsx`: jsdom has no layout, so the placement is
// stubbed and only the element the card anchors to is real.
vi.mock("@floating-ui/dom", () => ({
  computePosition: vi.fn(() =>
    Promise.resolve({
      x: 24,
      y: 48,
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

const positioned = vi.mocked(computePosition);

function anchors(): Element[] {
  return positioned.mock.calls
    .map(([reference]) => reference)
    .filter((reference): reference is Element => reference instanceof Element);
}

function CoachmarkHarness() {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef} data-testid="guide-root">
      <OnboardingCoachmark
        id="lifecycle-guide"
        title="Guide title"
        content="Guide content"
        progress={null}
        rootRef={rootRef}
        selector='[data-testid="guide-target"]'
        onClose={() => undefined}
        onTarget={null}
        back={null}
        action={null}
      />
    </div>
  );
}

function createVisibleTarget(): HTMLButtonElement {
  const target = document.createElement("button");
  target.setAttribute("data-testid", "guide-target");
  Object.defineProperty(target, "getClientRects", {
    configurable: true,
    value: () => ({ length: 1 }),
  });
  return target;
}

/**
 * `waitFor` cannot drive vitest's fake timers (Testing Library only advances
 * jest's), so the fake-timer cases step the clock by hand. Three passes: the
 * first runs the timers, and the next two let React commit what those timers
 * queued - including the timers that commit itself schedules.
 */
async function advance(ms: number): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
}

function openPicker(): HTMLDivElement {
  const popover = document.createElement("div");
  popover.setAttribute("data-slot", "popover-content");
  popover.setAttribute("data-state", "open");
  document.body.append(popover);
  return popover;
}

describe("OnboardingCoachmark lifecycle", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    positioned.mockClear();
    // Hand-appended pickers are not React's to clean up, and one left behind
    // obscures the target for every test after it.
    for (const stray of document.querySelectorAll(
      '[data-slot="popover-content"]',
    ))
      stray.remove();
  });

  it("re-anchors to a replaced target instead of measuring the detached one", async () => {
    render(<CoachmarkHarness />);
    const root = screen.getByTestId("guide-root");
    const target = createVisibleTarget();
    root.append(target);

    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Guide title" })).toBeTruthy(),
    );

    const replacement = createVisibleTarget();
    positioned.mockClear();
    vi.useFakeTimers();

    act(() => {
      window.dispatchEvent(new Event("resize"));
      target.replaceWith(replacement);
      vi.advanceTimersByTime(100);
    });
    vi.useRealTimers();

    await waitFor(() => {
      expect(root.querySelector('[data-testid="guide-target"]')).toBe(
        replacement,
      );
      expect(screen.getByRole("dialog", { name: "Guide title" })).toBeTruthy();
      expect(anchors()).toContain(replacement);
    });
    expect(anchors()).not.toContain(target);
    expect(replacement.hasAttribute("data-first-task-highlight")).toBe(false);
  });

  it("holds the next anchor until a closing picker has settled", async () => {
    vi.useFakeTimers();
    render(<CoachmarkHarness />);
    const root = screen.getByTestId("guide-root");
    const target = createVisibleTarget();
    root.append(target);
    await advance(0);
    expect(screen.getByTestId("guide-coachmark")).toBeTruthy();

    const popover = openPicker();
    await advance(300);
    expect(screen.queryByTestId("guide-coachmark")).toBeNull();

    positioned.mockClear();
    popover.remove();
    await advance(0);
    // The picker is out of the DOM but the page underneath has not finished
    // collapsing: measuring now is what pinned the card to a stale rect.
    expect(positioned).not.toHaveBeenCalled();
    expect(screen.queryByTestId("guide-coachmark")).toBeNull();

    await advance(200);
    expect(screen.getByTestId("guide-coachmark")).toBeTruthy();
    expect(anchors()).toContain(target);
  });

  it("re-measures as soon as the closing picker's transition ends", async () => {
    vi.useFakeTimers();
    render(<CoachmarkHarness />);
    const root = screen.getByTestId("guide-root");
    const target = createVisibleTarget();
    root.append(target);
    await advance(0);

    const popover = openPicker();
    await advance(300);
    expect(screen.queryByTestId("guide-coachmark")).toBeNull();

    positioned.mockClear();
    popover.setAttribute("data-state", "closed");
    await advance(0);
    expect(screen.queryByTestId("guide-coachmark")).toBeNull();

    popover.dispatchEvent(new Event("transitionend", { bubbles: true }));
    await advance(0);

    // The picker's own transition is the authoritative "it has landed", so the
    // card comes back without waiting out the settle timer.
    expect(screen.getByTestId("guide-coachmark")).toBeTruthy();
    expect(anchors()).toContain(target);
  });
});
