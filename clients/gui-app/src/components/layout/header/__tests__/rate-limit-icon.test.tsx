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
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";

let bars: ReadonlyArray<HeaderRateLimitBar> = [];
/** Default: one host, followed — the glyph's pre-picker world. */
let scope: HostScope = hostScopeFixture({});
/** Default: following the active host, not an explicit pick. */
let hasExplicitPick = false;
/**
 * Whether `useHeaderRateLimitBars` was mounted this render. A plain counter
 * rather than `vi.fn()` because the return value already flows through the
 * mutable `bars` above — this only needs to answer "did the icon mount the
 * hook at all", which is the fetch-against-the-wrong-host guarantee the
 * placeholder-glyph tests below exist to prove.
 */
let useHeaderRateLimitBarsCalled = false;

vi.mock("@/hooks/rate-limits/use-header-rate-limit-bars", () => ({
  useHeaderRateLimitBars: () => {
    useHeaderRateLimitBarsCalled = true;
    return bars;
  },
}));
// Mocked at the SCOPE, not at the six hooks behind it — the same boundary
// every Settings panel suite mocks, and the reason `hostScopeFixture` lives
// outside `__tests__/`. `useScopedHostBinding` is left real: it is a pure
// function of the scope, and stubbing it would hide the one thing this suite
// cares about (that a null binding means the glyph must not draw).
vi.mock("@/hooks/rate-limits/use-rate-limit-host-scope", () => ({
  useRateLimitHostScope: () => ({ scope, hasExplicitPick }),
}));
vi.mock("@/lib/host", () => ({
  HostRuntimeContext: {
    Provider: (props: { readonly children: unknown }) => props.children,
  },
  useHostBinding: () => null,
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
  scope = hostScopeFixture({});
  hasExplicitPick = false;
  useHeaderRateLimitBarsCalled = false;
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
        severity: "healthy",
        degraded: false,
      },
      {
        providerId: "codex",
        windowLabel: "Weekly",
        usedPercent: 0,
        severity: "healthy",
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
        severity: "healthy",
        degraded: false,
      },
      {
        providerId: "claude-code",
        windowLabel: "5h",
        usedPercent: 40,
        severity: "healthy",
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
        severity: "running_low",
        degraded: false,
      },
      {
        providerId: "codex",
        windowLabel: "Weekly",
        usedPercent: 20,
        severity: "healthy",
        degraded: false,
      },
    ];
    renderIcon();
    const button = screen.getByTestId("rate-limit-header-button");
    const fills = within(button).getAllByTestId("rate-limit-bar-fill");
    expect(fills).toHaveLength(2);
    expect(fills[0].className).toContain("amber-500");
    expect(fills[0].style.width).toBe("92%");
    expect(fills[1].className).toContain("blue-500");
    expect(fills[1].style.width).toBe("20%");
  });

  it("renders Running low and Limited as distinct amber and red tones", () => {
    bars = [
      {
        providerId: "codex",
        windowLabel: "5h",
        usedPercent: 80,
        severity: "running_low",
        degraded: false,
      },
      {
        providerId: "codex",
        windowLabel: "Weekly",
        usedPercent: 100,
        severity: "limited",
        degraded: false,
      },
    ];
    renderIcon();
    const fills = within(
      screen.getByTestId("rate-limit-header-button"),
    ).getAllByTestId("rate-limit-bar-fill");
    expect(fills[0].className).toContain("amber-500");
    expect(fills[1].className).toContain("red-500");
  });

  it("marks the gauge without dimming the whole button when data is degraded", () => {
    bars = [
      {
        providerId: "claude-code",
        windowLabel: "5h",
        usedPercent: 65,
        severity: "healthy",
        degraded: true,
      },
      {
        providerId: "codex",
        windowLabel: "5h",
        usedPercent: 30,
        severity: "healthy",
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

  describe("host scope", () => {
    function twoBars(): ReadonlyArray<HeaderRateLimitBar> {
      return [
        {
          providerId: "codex",
          windowLabel: "5h",
          usedPercent: 45,
          severity: "healthy",
          degraded: false,
        },
        {
          providerId: "claude-code",
          windowLabel: "5h",
          usedPercent: 10,
          severity: "healthy",
          degraded: false,
        },
      ];
    }

    it("mounts the live-bars hook for a usable explicit pick", () => {
      hasExplicitPick = true;
      scope = hostScopeFixture({
        status: "ready",
        isViewingActive: false,
        hostLabel: "Other Machine",
      });
      bars = twoBars();

      renderIcon();

      expect(useHeaderRateLimitBarsCalled).toBe(true);
      const fills = within(
        screen.getByTestId("rate-limit-header-button"),
      ).getAllByTestId("rate-limit-bar-fill");
      expect(fills).toHaveLength(2);
    });

    // The no-regression case: without an explicit pick, an `unreachable`
    // scope is the routine blip a single-host user's active host can have at
    // any time - the rate-limit envelope's own lastGood/degraded retention
    // already rides that out. Blanking the bars here would make every
    // single-host user worse off for a picker they never opened.
    it("keeps the live bars visible while following the active host, even when its status looks unreachable", () => {
      hasExplicitPick = false;
      scope = hostScopeFixture({
        status: "unreachable",
        isViewingActive: true,
      });
      bars = twoBars();

      renderIcon();

      expect(useHeaderRateLimitBarsCalled).toBe(true);
      const button = screen.getByTestId("rate-limit-header-button");
      expect(within(button).getAllByTestId("rate-limit-bar-fill")).toHaveLength(
        2,
      );
      expect(
        within(button).queryAllByTestId("rate-limit-bar-track"),
      ).toHaveLength(2);
    });

    // The fetch-against-the-wrong-host guarantee: an explicit pick that has
    // not resolved to its own client must not mount the live hook at all, not
    // just hide its output - a mounted-but-hidden hook still fires against the
    // ambient host and caches the answer under its key.
    it("falls back to the neutral placeholder and never mounts the live-bars hook when an explicit pick is unusable", () => {
      hasExplicitPick = true;
      scope = hostScopeFixture({
        host: null,
        hosts: [],
        vanishedHostId: "host-gone",
        hostLabel: "host-gone",
        status: "vanished",
        isViewingActive: false,
      });
      bars = twoBars();

      renderIcon();

      expect(useHeaderRateLimitBarsCalled).toBe(false);
      const button = screen.getByTestId("rate-limit-header-button");
      const tracks = within(button).getAllByTestId("rate-limit-bar-track");
      expect(tracks).toHaveLength(2);
      expect(
        within(button).queryAllByTestId("rate-limit-bar-fill"),
      ).toHaveLength(0);
      for (const track of tracks) {
        expect(track.className).toContain("bg-muted-foreground/35");
      }
    });

    it("omits the host name from the tooltip while viewing the active host", async () => {
      renderIcon();

      fireEvent.focus(screen.getByRole("button", { name: "Usage limits" }));
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.textContent).toBe("Usage limits");
    });

    it("names the host in the tooltip label when not viewing the active host", async () => {
      hasExplicitPick = true;
      scope = hostScopeFixture({
        status: "ready",
        isViewingActive: false,
        hostLabel: "Other Machine",
      });

      renderIcon();

      fireEvent.focus(screen.getByRole("button", { name: "Usage limits" }));
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.textContent).toBe("Usage limits · Other Machine");
    });
  });
});
