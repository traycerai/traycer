import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { HeaderRateLimitBar } from "@/hooks/rate-limits/use-header-rate-limit-bars";
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";

let bars: ReadonlyArray<HeaderRateLimitBar> = [];

vi.mock("@/hooks/rate-limits/use-header-rate-limit-bars", () => ({
  useHeaderRateLimitBars: () => bars,
}));
vi.mock("@/hooks/rate-limits/use-rate-limit-profile-selection", () => ({
  useRateLimitProfileSelection: () => ({
    activeChatSettings: null,
    lastProfileByHarness: {},
  }),
}));

vi.mock("@/components/layout/header/rate-limit-popover", () => ({
  RateLimitPopover: (_props: { readonly onClose: () => void }) => (
    <div data-testid="rate-limit-popover" />
  ),
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
  return (element.getAttribute("class") ?? "").split(/\s+/).includes(className);
}

afterEach(() => {
  cleanup();
  bars = [];
  useTitleBarDragStore.setState({ suppressors: new Set() });
});

describe("<RateLimitIconButton />", () => {
  it("renders a clickable icon button with an accessible name, even with no bars", () => {
    renderIcon();
    const button = screen.getByRole("button", { name: "Usage limits" });
    expect(button).toBeTruthy();
    expect(button.getAttribute("data-variant")).toBe("outline");
    expect(screen.getByTestId("rate-limit-gauge-icon")).toBeTruthy();
  });

  it("suppresses title-bar dragging only while the popover is open", () => {
    renderIcon();

    const isSuppressed = () =>
      useTitleBarDragStore.getState().suppressors.has("rate-limits");
    const button = screen.getByRole("button", { name: "Usage limits" });

    expect(isSuppressed()).toBe(false);

    fireEvent.click(button);
    expect(isSuppressed()).toBe(true);

    fireEvent.click(button);
    expect(isSuppressed()).toBe(false);
  });

  it("renders zero providers as visible empty tracks without fabricated usage", () => {
    bars = [];
    renderIcon();
    const button = screen.getByTestId("rate-limit-header-button");
    const tracks = within(button).getAllByTestId("rate-limit-bar-track");
    expect(tracks).toHaveLength(2);
    expect(within(button).queryAllByTestId("rate-limit-bar-fill")).toHaveLength(
      0,
    );
    for (const track of tracks) {
      expect(track.className).toContain("bg-muted-foreground/35");
    }
  });

  it("keeps valid 0% readings empty while preserving visible tracks", () => {
    bars = [
      {
        providerId: "codex",
        windowLabel: "5h",
        usedPercent: 0,
        severity: "blue",
        degraded: false,
      },
      {
        providerId: "codex",
        windowLabel: "Weekly",
        usedPercent: 0,
        severity: "blue",
        degraded: false,
      },
    ];
    renderIcon();
    const button = screen.getByTestId("rate-limit-header-button");
    const tracks = within(button).getAllByTestId("rate-limit-bar-track");
    const fills = within(button).getAllByTestId("rate-limit-bar-fill");
    expect(tracks).toHaveLength(2);
    expect(fills).toHaveLength(2);
    expect(fills[0].style.width).toBe("0%");
    expect(fills[1].style.width).toBe("0%");
    for (const track of tracks) {
      expect(track.className).toContain("bg-muted-foreground/35");
    }
  });

  it("renders one bar per configured provider (Codex + Claude Code)", () => {
    bars = [
      {
        providerId: "codex",
        windowLabel: "5h",
        usedPercent: 70,
        severity: "blue",
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
    const fills = within(button).getAllByTestId("rate-limit-bar-fill");
    expect(fills).toHaveLength(2);
    expect(fills[0].className).toContain("blue-500");
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

  it("marks the gauge without dimming the whole button when data is degraded", () => {
    bars = [
      {
        providerId: "claude-code",
        windowLabel: "5h",
        usedPercent: 65,
        severity: "blue",
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
    expect(hasClass(button, "opacity-[0.55]")).toBe(false);
    expect(
      hasClass(screen.getByTestId("rate-limit-gauge-icon"), "text-amber-600"),
    ).toBe(true);
    // Both bars keep their own severity fill while the gauge carries the
    // degraded-state treatment.
    const fills = within(button).getAllByTestId("rate-limit-bar-fill");
    expect(fills).toHaveLength(2);
  });
});
