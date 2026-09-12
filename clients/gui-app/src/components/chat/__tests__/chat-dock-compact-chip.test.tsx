import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { ChatDockCompactChip } from "@/components/chat/chat-dock-compact-chip";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DiffLineCounts } from "@/lib/file-change-diff-hunks";

interface ChipProps {
  readonly icon: ReactElement;
  readonly text: string;
  readonly workingWord: string | null;
  readonly lineDeltas: DiffLineCounts | null;
  readonly label: string;
  readonly pulseToken: string | null;
  readonly expanded: boolean;
  readonly testId: string;
  readonly onClick: () => void;
}

function baseProps(): ChipProps {
  return {
    icon: <span data-testid="chip-icon" />,
    text: "3",
    workingWord: null,
    lineDeltas: null,
    label: "3 agents running. Show the active agents.",
    pulseToken: null,
    expanded: false,
    testId: "chip",
    onClick: vi.fn(),
  };
}

function renderChip(props: ChipProps) {
  return render(
    <TooltipProvider delayDuration={0}>
      <ChatDockCompactChip {...props} />
    </TooltipProvider>,
  );
}

function rerenderChip(
  rerender: (ui: ReactElement) => void,
  props: ChipProps,
): void {
  rerender(
    <TooltipProvider delayDuration={0}>
      <ChatDockCompactChip {...props} />
    </TooltipProvider>,
  );
}

// jsdom has no global `AnimationEvent`, so React's vendor-prefix probe
// (`getVendorPrefixedEventName`) drops its unprefixed "animationend" fallback
// and lands on the `WebkitAnimation` entry jsdom's `CSSStyleDeclaration` does
// expose - React ends up listening for `webkitAnimationEnd`, never plain
// `animationend`. `fireEvent.animationEnd` dispatches the standard name and is
// silently swallowed here, so the real event name is dispatched directly.
function fireAnimationEnd(element: Element): void {
  fireEvent(
    element,
    new Event("webkitAnimationEnd", { bubbles: true, cancelable: true }),
  );
}

describe("<ChatDockCompactChip />", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the icon and the short text", () => {
    renderChip(baseProps());

    expect(screen.getByTestId("chip-icon")).not.toBeNull();
    expect(screen.getByText("3")).not.toBeNull();
  });

  // The Files changed chip prints two measurements: the count, then the lines,
  // in the panel's own tones. `null` is every other chip, which counts one
  // thing and must gain no second span for it.
  it("prints the line deltas after the short form, in the panel's tones", () => {
    renderChip({
      ...baseProps(),
      text: "3",
      lineDeltas: { additions: 12, deletions: 4 },
    });

    const chip = screen.getByTestId("chip");
    expect(chip.textContent).toBe("3+12−4");
    expect(screen.getByText("+12").getAttribute("class")).toContain(
      "text-emerald-600",
    );
    expect(screen.getByText("−4").getAttribute("class")).toContain(
      "text-destructive",
    );
  });

  it("omits a zero side, and the whole delta group for a chip with none", () => {
    const { rerender } = renderChip({
      ...baseProps(),
      text: "3",
      lineDeltas: { additions: 12, deletions: 0 },
    });
    const chip = screen.getByTestId("chip");
    expect(chip.textContent).toBe("3+12");

    rerenderChip(rerender, {
      ...baseProps(),
      text: "3",
      lineDeltas: { additions: 0, deletions: 4 },
    });
    expect(chip.textContent).toBe("3−4");

    // Both zero draws NO span, not an empty one: a chip is a few characters
    // wide, so an empty counts group is a visible gap after the number.
    rerenderChip(rerender, {
      ...baseProps(),
      text: "3",
      lineDeltas: { additions: 0, deletions: 0 },
    });
    expect(chip.textContent).toBe("3");
    expect(chip.childElementCount).toBe(2);

    rerenderChip(rerender, { ...baseProps(), text: "3", lineDeltas: null });
    expect(chip.textContent).toBe("3");
    expect(chip.childElementCount).toBe(2);
  });

  // The number is the chip's loudest text, so it carries the state too - and
  // the word after it names that state outright for the case an icon
  // treatment alone did not carry. The word folds out on a container query,
  // which is what keeps it from ever widening a cramped composer.
  it("tones the number and prints the word while working", () => {
    const { rerender } = renderChip({
      ...baseProps(),
      text: "1",
      workingWord: "running",
    });

    const chip = screen.getByTestId("chip");
    const word = chip.querySelector("[data-chip-working-word]");
    expect(word?.textContent).toBe("running");
    expect(word?.getAttribute("class")).toContain("hidden");
    expect(word?.getAttribute("class")).toContain("@min-[24rem]:inline");
    // Already in the accessible name, so drawing it must not say it twice.
    expect(word?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("1").getAttribute("class")).toContain(
      "text-primary",
    );

    rerenderChip(rerender, { ...baseProps(), text: "1", workingWord: null });

    expect(chip.querySelector("[data-chip-working-word]")).toBeNull();
    expect(screen.getByText("1").getAttribute("class")).not.toContain(
      "text-primary",
    );
  });

  it("uses the whole sentence as the accessible name", () => {
    renderChip(baseProps());

    expect(
      screen.getByRole("button", {
        name: "3 agents running. Show the active agents.",
      }),
    ).not.toBeNull();
  });

  it("tracks aria-pressed with expanded", () => {
    const props = { ...baseProps(), expanded: false };
    const { rerender } = renderChip(props);

    expect(screen.getByTestId("chip").getAttribute("aria-pressed")).toBe(
      "false",
    );

    rerenderChip(rerender, { ...props, expanded: true });

    expect(screen.getByTestId("chip").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("fires onClick when clicked", () => {
    const onClick = vi.fn();
    renderChip({ ...baseProps(), onClick });

    fireEvent.click(screen.getByTestId("chip"));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // A chip exists only while its section has something to show, so mounting
  // WITH a non-null token is the case that matters most: "the first agent
  // started" and "this chip mounted" are the same instant, and that first
  // arrival must not be the one pulse the chip swallows.
  it("pulses on mount when pulseToken is already non-null", () => {
    renderChip({ ...baseProps(), pulseToken: "3" });

    expect(screen.getByTestId("chip").getAttribute("data-pulse")).toBe("true");
  });

  it("does not pulse on mount when pulseToken is null", () => {
    renderChip({ ...baseProps(), pulseToken: null });

    expect(screen.getByTestId("chip").getAttribute("data-pulse")).toBeNull();
  });

  it("clears the pulse on animationend", () => {
    renderChip({ ...baseProps(), pulseToken: "3" });
    const chip = screen.getByTestId("chip");
    expect(chip.getAttribute("data-pulse")).toBe("true");

    fireAnimationEnd(chip);

    expect(chip.getAttribute("data-pulse")).toBeNull();
  });

  it("pulses again when pulseToken changes to a different non-null value", () => {
    const props = { ...baseProps(), pulseToken: "3" };
    const { rerender } = renderChip(props);
    fireAnimationEnd(screen.getByTestId("chip"));
    expect(screen.getByTestId("chip").getAttribute("data-pulse")).toBeNull();

    rerenderChip(rerender, { ...props, pulseToken: "5" });

    expect(screen.getByTestId("chip").getAttribute("data-pulse")).toBe("true");
  });

  it("does not pulse when pulseToken changes to null", () => {
    const props = { ...baseProps(), pulseToken: "3" };
    const { rerender } = renderChip(props);

    rerenderChip(rerender, { ...props, pulseToken: null });

    expect(screen.getByTestId("chip").getAttribute("data-pulse")).toBeNull();
  });

  it("does not pulse again on a re-render with the same token once cleared", () => {
    const props = { ...baseProps(), pulseToken: "3" };
    const { rerender } = renderChip(props);
    fireAnimationEnd(screen.getByTestId("chip"));
    expect(screen.getByTestId("chip").getAttribute("data-pulse")).toBeNull();

    rerenderChip(rerender, { ...props, pulseToken: "3" });

    expect(screen.getByTestId("chip").getAttribute("data-pulse")).toBeNull();
  });
});
