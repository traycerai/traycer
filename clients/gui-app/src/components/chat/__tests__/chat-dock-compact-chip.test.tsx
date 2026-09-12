import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { ChatDockCompactChip } from "@/components/chat/chat-dock-compact-chip";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DiffLineCounts } from "@/lib/file-change-diff-hunks";

interface ChipProps {
  readonly icon: ReactElement;
  readonly text: string;
  readonly working: boolean;
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
    working: false,
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

  // The number is the chip's loudest text, so it carries the state too - as a
  // tone, which costs no width. The chip's only other text is the deltas.
  it("tones the number while working", () => {
    const { rerender } = renderChip({
      ...baseProps(),
      text: "1",
      working: true,
    });

    const chip = screen.getByTestId("chip");
    expect(screen.getByText("1").getAttribute("class")).toContain(
      "text-primary",
    );
    expect(chip.textContent).toBe("1");

    rerenderChip(rerender, { ...baseProps(), text: "1", working: false });

    expect(screen.getByText("1").getAttribute("class")).not.toContain(
      "text-primary",
    );
  });

  // The word that used to follow the number (`1 running`) is gone: a chip is
  // `[icon] N` at every width, so nothing here may be width-conditional and
  // there is no container query left to fold. The state is the icon's job, and
  // `label`'s.
  it("prints no working word, and no width-gated node, at any width", () => {
    const { rerender } = renderChip({
      ...baseProps(),
      text: "1",
      working: true,
      label: "Background. 1 running.",
    });

    const chip = screen.getByTestId("chip");
    expect(chip.querySelector("[data-chip-working-word]")).toBeNull();
    expect(chip.textContent).toBe("1");
    expect(chip.childElementCount).toBe(2);
    for (const element of [chip, ...chip.querySelectorAll("*")]) {
      expect(element.getAttribute("class") ?? "").not.toMatch(/@(min|max)-/);
    }
    // The sentence is unchanged - it is the one channel that still says it.
    expect(chip.getAttribute("aria-label")).toBe("Background. 1 running.");

    // ...and an idle chip is the same shape, one tone lighter.
    rerenderChip(rerender, { ...baseProps(), text: "1", working: false });
    expect(chip.querySelector("[data-chip-working-word]")).toBeNull();
    expect(chip.textContent).toBe("1");
    expect(chip.childElementCount).toBe(2);
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
