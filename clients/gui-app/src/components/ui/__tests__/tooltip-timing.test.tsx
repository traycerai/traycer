/**
 * Timing coverage for the app's tuned Tooltip delays (D09): the app default
 * (500ms open / 300ms shared skip window), the subtrees that tune their own
 * open delay (150ms sidebar rail, 300ms notifications popover, 700ms as a
 * probe for an arbitrary override), a per-trigger override sitting above
 * whatever its Provider sets, and the self-provisioned default when no
 * Provider is mounted at all.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function hoverIn(trigger: Element): void {
  fireEvent.mouseEnter(trigger);
  fireEvent.mouseMove(trigger);
}

function isOpen(): boolean {
  return document.querySelector('[data-slot="tooltip-content"]') !== null;
}

describe("tooltip open delay", () => {
  it.each([150, 300, 500, 700])(
    "opens after exactly the Provider's %dms delay, not before",
    (delayMs) => {
      vi.useFakeTimers();
      render(
        <TooltipProvider delay={delayMs}>
          <Tooltip>
            <TooltipTrigger render={<button type="button">Trigger</button>} />
            <TooltipContent>Tip</TooltipContent>
          </Tooltip>
        </TooltipProvider>,
      );
      const trigger = screen.getByRole("button", { name: "Trigger" });
      act(() => {
        hoverIn(trigger);
      });

      act(() => {
        vi.advanceTimersByTime(delayMs - 1);
      });
      expect(isOpen()).toBe(false);

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(isOpen()).toBe(true);
    },
  );

  it("a Trigger-level delay overrides the Provider's own delay", () => {
    vi.useFakeTimers();
    render(
      <TooltipProvider delay={150}>
        <Tooltip>
          <TooltipTrigger
            delay={700}
            render={<button type="button">Trigger</button>}
          />
          <TooltipContent>Tip</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const trigger = screen.getByRole("button", { name: "Trigger" });
    act(() => {
      hoverIn(trigger);
    });

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(isOpen()).toBe(false);

    act(() => {
      vi.advanceTimersByTime(700 - 150);
    });
    expect(isOpen()).toBe(true);
  });

  it("self-provides the app's 500ms default when no Provider is mounted", () => {
    vi.useFakeTimers();
    render(
      <Tooltip>
        <TooltipTrigger render={<button type="button">Trigger</button>} />
        <TooltipContent>Tip</TooltipContent>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Trigger" });
    act(() => {
      hoverIn(trigger);
    });

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(isOpen()).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(isOpen()).toBe(true);
  });
});

describe("tooltip shared skip window", () => {
  it("opens a second tooltip instantly within the 300ms default skip window after the first closes", () => {
    vi.useFakeTimers();
    render(
      <TooltipProvider delay={500}>
        <Tooltip>
          <TooltipTrigger render={<button type="button">First</button>} />
          <TooltipContent>Tip one</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<button type="button">Second</button>} />
          <TooltipContent>Tip two</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });

    act(() => {
      hoverIn(first);
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(isOpen()).toBe(true);

    act(() => {
      fireEvent.mouseLeave(first);
    });
    act(() => {
      vi.advanceTimersByTime(299);
    });

    act(() => {
      hoverIn(second);
    });
    // Inside the skip window: no open-delay wait, just the mouseleave's own
    // close settling on the next tick.
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.getByText("Tip two")).toBeTruthy();
  });

  it("makes a second tooltip wait out the full delay again once the 300ms skip window has expired", () => {
    vi.useFakeTimers();
    render(
      <TooltipProvider delay={500}>
        <Tooltip>
          <TooltipTrigger render={<button type="button">First</button>} />
          <TooltipContent>Tip one</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<button type="button">Second</button>} />
          <TooltipContent>Tip two</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });

    act(() => {
      hoverIn(first);
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(isOpen()).toBe(true);

    act(() => {
      fireEvent.mouseLeave(first);
    });
    // Past the 300ms skip window: the group's shared instant-open has lapsed.
    act(() => {
      vi.advanceTimersByTime(301);
    });

    act(() => {
      hoverIn(second);
    });
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(isOpen()).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("Tip two")).toBeTruthy();
  });

  it("a 0ms skip window (timeout={0}) never lets a second tooltip skip the open delay", () => {
    vi.useFakeTimers();
    render(
      <TooltipProvider delay={500} timeout={0}>
        <Tooltip>
          <TooltipTrigger render={<button type="button">First</button>} />
          <TooltipContent>Tip one</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<button type="button">Second</button>} />
          <TooltipContent>Tip two</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });

    act(() => {
      hoverIn(first);
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(isOpen()).toBe(true);

    act(() => {
      fireEvent.mouseLeave(first);
    });
    act(() => {
      vi.advanceTimersByTime(0);
    });

    act(() => {
      hoverIn(second);
    });
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(isOpen()).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("Tip two")).toBeTruthy();
  });
});

describe("tooltip on expanded triggers", () => {
  function openAfterDelay(trigger: ReactElement): boolean {
    vi.useFakeTimers();
    render(
      <TooltipProvider delay={500}>
        <Tooltip>
          <TooltipTrigger render={trigger} />
          <TooltipContent>Tip</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const button = screen.getByRole("button", { name: "Trigger" });
    act(() => {
      hoverIn(button);
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    return isOpen();
  }

  it("stays closed on an expanded popup trigger (aria-haspopup + aria-expanded)", () => {
    expect(
      openAfterDelay(
        <button type="button" aria-haspopup="menu" aria-expanded="true">
          Trigger
        </button>,
      ),
    ).toBe(false);
  });

  it("still opens on a collapsed popup trigger", () => {
    expect(
      openAfterDelay(
        <button type="button" aria-haspopup="menu" aria-expanded="false">
          Trigger
        </button>,
      ),
    ).toBe(true);
  });

  it("still opens on an expanded disclosure trigger (aria-expanded without aria-haspopup)", () => {
    expect(
      openAfterDelay(
        <button type="button" aria-expanded="true">
          Trigger
        </button>,
      ),
    ).toBe(true);
  });
});
