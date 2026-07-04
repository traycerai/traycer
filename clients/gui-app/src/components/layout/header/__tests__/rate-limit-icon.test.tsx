import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { HeaderRateLimitBar } from "@/hooks/rate-limits/use-header-rate-limit-bars";

let bars: ReadonlyArray<HeaderRateLimitBar> = [];

vi.mock("@/hooks/rate-limits/use-header-rate-limit-bars", () => ({
  useHeaderRateLimitBars: () => bars,
}));

import { RateLimitIconButton } from "@/components/layout/header/rate-limit-icon";

function renderIcon() {
  return render(
    <TooltipProvider>
      <RateLimitIconButton />
    </TooltipProvider>,
  );
}

// Exact class-token membership, not substring containment - the button's base
// variant classes always carry `disabled:opacity-50`, which would otherwise
// false-positive a substring check for the bare `opacity-50` utility.
function hasClass(element: Element, className: string): boolean {
  return element.className.split(/\s+/).includes(className);
}

afterEach(() => {
  cleanup();
  bars = [];
});

describe("<RateLimitIconButton />", () => {
  it("renders a clickable icon button with an accessible name, even with no bars", () => {
    renderIcon();
    const button = screen.getByRole("button", { name: "Rate limits" });
    expect(button).toBeTruthy();
  });

  it("renders zero providers configured as a muted, pre-filled placeholder glyph", () => {
    bars = [];
    renderIcon();
    const button = screen.getByTestId("rate-limit-header-button");
    expect(hasClass(button, "opacity-50")).toBe(true);
    expect(hasClass(button, "opacity-[0.55]")).toBe(false);
    const tracks = within(button).getAllByTestId("rate-limit-bar-track");
    expect(tracks).toHaveLength(2);
    const fills = within(button).getAllByTestId("rate-limit-bar-fill");
    expect(fills).toHaveLength(2);
    expect(fills[0].style.width).toBe("75%");
    expect(fills[1].style.width).toBe("60%");
    for (const fill of fills) {
      expect(hasClass(fill, "bg-muted-foreground")).toBe(true);
    }
  });

  it("renders one bar per configured provider (Codex + Claude Code)", () => {
    bars = [
      {
        providerId: "codex",
        windowLabel: "5h",
        usedPercent: 70,
        severity: "yellow",
        degraded: false,
      },
      {
        providerId: "claude-code",
        windowLabel: "5h",
        usedPercent: 40,
        severity: "blue",
        degraded: false,
      },
    ];
    renderIcon();
    const button = screen.getByTestId("rate-limit-header-button");
    expect(hasClass(button, "opacity-50")).toBe(false);
    expect(hasClass(button, "opacity-[0.55]")).toBe(false);
    const fills = within(button).getAllByTestId("rate-limit-bar-fill");
    expect(fills).toHaveLength(2);
    expect(fills[0].className).toContain("yellow-500");
    expect(fills[0].style.width).toBe("70%");
    expect(fills[1].className).toContain("blue-500");
    expect(fills[1].style.width).toBe("40%");
  });

  it("renders both of a single provider's windows without a key collision", () => {
    // Single-provider case: both bars share a providerId and are disambiguated
    // by windowLabel in the React key - both must still render.
    bars = [
      {
        providerId: "codex",
        windowLabel: "5h",
        usedPercent: 92,
        severity: "red",
        degraded: false,
      },
      {
        providerId: "codex",
        windowLabel: "Weekly",
        usedPercent: 20,
        severity: "blue",
        degraded: false,
      },
    ];
    renderIcon();
    const button = screen.getByTestId("rate-limit-header-button");
    const fills = within(button).getAllByTestId("rate-limit-bar-fill");
    expect(fills).toHaveLength(2);
    expect(fills[0].className).toContain("red-500");
    expect(fills[0].style.width).toBe("92%");
    expect(fills[1].className).toContain("blue-500");
    expect(fills[1].style.width).toBe("20%");
  });

  it("dims the whole glyph when a contributing bar's last poll failed (degraded)", () => {
    bars = [
      {
        providerId: "claude-code",
        windowLabel: "5h",
        usedPercent: 65,
        severity: "yellow",
        degraded: true,
      },
      {
        providerId: "codex",
        windowLabel: "5h",
        usedPercent: 30,
        severity: "blue",
        degraded: false,
      },
    ];
    renderIcon();
    const button = screen.getByTestId("rate-limit-header-button");
    expect(hasClass(button, "opacity-[0.55]")).toBe(true);
    expect(hasClass(button, "opacity-50")).toBe(false);
    // Degraded dims the whole icon container, not the individual bar - both
    // bars keep their own severity fill.
    const fills = within(button).getAllByTestId("rate-limit-bar-fill");
    expect(fills).toHaveLength(2);
  });
});
