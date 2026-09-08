import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStatusAnimationClockForTests } from "@/lib/animation/status-animation-clock";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";

beforeEach(() => {
  vi.useFakeTimers();
  resetStatusAnimationClockForTests();
});

afterEach(() => {
  cleanup();
  resetStatusAnimationClockForTests();
  vi.useRealTimers();
});

describe("AgentSpinningDots", () => {
  it("renders the first frame immediately and advances to the second frame after one clock tick", () => {
    render(
      <AgentSpinningDots
        className={undefined}
        testId="spinner"
        variant="dots"
      />,
    );
    const node = screen.getByTestId("spinner");
    // AGENT_SPINNER_PRESETS.dots.frames[0], intervalMs 80.
    expect(node.textContent).toBe("⠋");

    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(node.textContent).toBe("⠙");
  });

  it("keeps one stable text node across ticks instead of replacing it", () => {
    render(
      <AgentSpinningDots
        className={undefined}
        testId="spinner"
        variant="dots"
      />,
    );
    const node = screen.getByTestId("spinner");
    const initialTextNode = node.firstChild;
    expect(node.childNodes.length).toBe(1);
    expect(initialTextNode).not.toBeNull();

    for (let index = 0; index < 5; index += 1) {
      act(() => {
        vi.advanceTimersByTime(80);
      });
    }

    // Same node identity and still exactly one child: a `:has()` subject
    // above this element never re-triggers a childList invalidation.
    expect(node.childNodes.length).toBe(1);
    expect(node.firstChild).toBe(initialTextNode);
  });

  it("keeps a slow preset's frame steady inside its interval and advances once the interval elapses", () => {
    render(
      <AgentSpinningDots
        className={undefined}
        testId="spinner"
        variant="checkerboard"
      />,
    );
    const node = screen.getByTestId("spinner");
    const initialFrame = node.textContent;
    expect(initialFrame).not.toBeNull();

    // checkerboard's intervalMs is 250: neither 80ms nor 160ms should move it.
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(node.textContent).toBe(initialFrame);

    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(node.textContent).toBe(initialFrame);

    // 320ms total has crossed the 250ms interval once.
    act(() => {
      vi.advanceTimersByTime(160);
    });
    expect(node.textContent).not.toBe(initialFrame);
  });

  it("renders WorkingDots for the typing variant, with inline opacity written pre-paint", () => {
    render(
      <AgentSpinningDots
        className={undefined}
        testId="spinner"
        variant="typing"
      />,
    );
    const node = screen.getByTestId("spinner");
    const dots = node.querySelectorAll<HTMLSpanElement>(":scope > span");
    expect(dots.length).toBe(3);
    dots.forEach((dot) => {
      expect(dot.style.opacity).not.toBe("");
    });
  });

  it("shares one interval across multiple spinners on screen", () => {
    render(
      <>
        <AgentSpinningDots
          className={undefined}
          testId="spinner-1"
          variant="dots"
        />
        <AgentSpinningDots
          className={undefined}
          testId="spinner-2"
          variant="dots2"
        />
      </>,
    );
    expect(vi.getTimerCount()).toBe(1);
  });

  it("holds the first frame with no interval inside a hidden keep-alive pane, and starts ticking once the pane shows", () => {
    const { rerender } = render(
      <PaneVisibilityContext.Provider value={false}>
        <AgentSpinningDots
          className={undefined}
          testId="spinner"
          variant="dots"
        />
      </PaneVisibilityContext.Provider>,
    );
    const node = screen.getByTestId("spinner");
    expect(node.textContent).toBe("⠋");
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(160);
    });
    expect(node.textContent).toBe("⠋");

    rerender(
      <PaneVisibilityContext.Provider value>
        <AgentSpinningDots
          className={undefined}
          testId="spinner"
          variant="dots"
        />
      </PaneVisibilityContext.Provider>,
    );
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(node.textContent).not.toBe("⠋");
  });
});
