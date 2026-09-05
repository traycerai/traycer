import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { ChatDockCompactChip } from "@/components/chat/chat-dock-compact-chip";
import { TooltipProvider } from "@/components/ui/tooltip";

interface ChipProps {
  readonly icon: ReactElement;
  readonly text: string;
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
