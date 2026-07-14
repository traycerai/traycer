import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ProviderRateLimits } from "@traycer/protocol/host";
import { formatResetFullDateTime } from "@/lib/relative-time";
import {
  ClaudeRateLimitView,
  CodexRateLimitView,
  KiloCodeRateLimitView,
  OpenRouterRateLimitView,
  ProviderRateLimitBody,
  ProviderRateLimitDetail,
} from "../provider-rate-limit-views";

type CodexRateLimits = Extract<ProviderRateLimits, { provider: "codex" }>;
type ClaudeRateLimits = Extract<
  ProviderRateLimits,
  { provider: "claude-code" }
>;
type OpenRouterRateLimits = Extract<
  ProviderRateLimits,
  { provider: "openrouter" }
>;
type KiloCodeRateLimits = Extract<ProviderRateLimits, { provider: "kilocode" }>;

const NOW = Date.now();

afterEach(() => {
  cleanup();
});

describe("CodexRateLimitView (extended fields)", () => {
  const codex: CodexRateLimits = {
    provider: "codex",
    available: true,
    planType: "pro_5x",
    limitId: "base",
    limitName: null,
    primary: {
      usedPercent: 4,
      resetsAt: NOW + 60 * 60 * 1000,
      durationMinutes: 300,
    },
    secondary: {
      usedPercent: 68,
      resetsAt: NOW + 3 * 24 * 60 * 60 * 1000,
      durationMinutes: 10080,
    },
    extraWindows: [
      {
        limitId: "gpt5",
        limitName: "GPT-5",
        primary: {
          usedPercent: 20,
          resetsAt: NOW + 2 * 60 * 60 * 1000,
          durationMinutes: 300,
        },
        secondary: null,
      },
    ],
    credits: null,
    individualLimit: null,
    resetCredits: { availableCount: 3, credits: null },
    rateLimitReachedType: null,
  };

  it("labels windows from their real duration (not a hardcoded 5-hour/Weekly)", () => {
    render(<CodexRateLimitView data={codex} variant="settings" />);
    expect(screen.getByText("Current session")).toBeTruthy();
    expect(screen.getByText("4% used")).toBeTruthy();
    expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.getByText("68% used")).toBeTruthy();
  });

  it("never renders the plan/tier label itself - the header popover owns that chip", () => {
    // `resolveProviderPlanLabel` (provider-rate-limit-content.test.ts) covers the
    // planType -> "Pro 5x" mapping; the popover header's own test coverage
    // (rate-limit-popover.test.tsx) covers the chip actually rendering.
    render(<CodexRateLimitView data={codex} variant="popover-detail" />);
    expect(screen.queryByText("Pro 5x")).toBeNull();
  });

  it("renders each extraWindow as its own labeled row (limit name + duration)", () => {
    render(<CodexRateLimitView data={codex} variant="settings" />);
    expect(screen.getByText("GPT-5 · Current session")).toBeTruthy();
    expect(screen.getByText("20% used")).toBeTruthy();
  });

  it("renders the manual reset-credits block", () => {
    render(<CodexRateLimitView data={codex} variant="settings" />);
    expect(screen.getByText("Manual resets")).toBeTruthy();
    expect(screen.getByText("3 available")).toBeTruthy();
  });

  it("lists reset expiries soonest first and discloses a capped remainder", () => {
    const soonExpiry = NOW + 2 * 60 * 60 * 1000;
    const laterExpiry = NOW + 3 * 24 * 60 * 60 * 1000;
    const detailedCodex = {
      ...codex,
      resetCredits: {
        availableCount: 3,
        credits: [
          {
            id: "later",
            resetType: "codexRateLimits" as const,
            status: "available" as const,
            grantedAt: NOW,
            expiresAt: laterExpiry,
            title: "Later reset",
            description: null,
          },
          {
            id: "soon",
            resetType: "codexRateLimits" as const,
            status: "available" as const,
            grantedAt: NOW,
            expiresAt: soonExpiry,
            title: "Soon reset",
            description: null,
          },
        ],
      },
    };
    const { rerender } = render(
      <CodexRateLimitView data={detailedCodex} variant="settings" />,
    );
    const resetLabels = screen.getAllByText(/reset$/);
    expect(resetLabels.map((label) => label.textContent)).toEqual([
      "Soon reset",
      "Later reset",
    ]);
    expect(screen.getByText(/^Expires in /)).toBeTruthy();
    expect(
      screen.getByText(`Expires ${formatResetFullDateTime(laterExpiry)}`),
    ).toBeTruthy();
    expect(screen.getByText("+1 more not shown")).toBeTruthy();

    rerender(
      <CodexRateLimitView data={detailedCodex} variant="popover-detail" />,
    );
    expect(
      screen.getByText(`Expires ${formatResetFullDateTime(laterExpiry)}`),
    ).toBeTruthy();
  });

  it("folds a single credit's expiry into the summary row", () => {
    render(
      <CodexRateLimitView
        data={{
          ...codex,
          resetCredits: {
            availableCount: 1,
            credits: [
              {
                id: "single",
                resetType: "codexRateLimits",
                status: "available",
                grantedAt: NOW,
                expiresAt: null,
                title: "Single reset",
                description: null,
              },
            ],
          },
        }}
        variant="settings"
      />,
    );
    expect(screen.getByText("1 available")).toBeTruthy();
    expect(screen.getByText("No expiry")).toBeTruthy();
    expect(screen.queryByText("Single reset")).toBeNull();
  });

  it("discloses capped credits when the only returned detail is inline", () => {
    render(
      <CodexRateLimitView
        data={{
          ...codex,
          resetCredits: {
            availableCount: 2,
            credits: [
              {
                id: "single-capped",
                resetType: "codexRateLimits",
                status: "available",
                grantedAt: NOW,
                expiresAt: null,
                title: null,
                description: null,
              },
            ],
          },
        }}
        variant="settings"
      />,
    );
    expect(screen.getByText("2 available")).toBeTruthy();
    expect(screen.getByText("No expiry")).toBeTruthy();
    expect(screen.getByText("+1 more not shown")).toBeTruthy();
  });

  it("renders a generic day/hour duration for an off-standard window", () => {
    render(
      <CodexRateLimitView
        data={{
          ...codex,
          limitName: null,
          extraWindows: [],
          primary: {
            usedPercent: 4,
            resetsAt: NOW + 60 * 60 * 1000,
            durationMinutes: 360,
          },
          secondary: {
            usedPercent: 68,
            resetsAt: NOW + 3 * 24 * 60 * 60 * 1000,
            durationMinutes: 30 * 24 * 60,
          },
        }}
        variant="settings"
      />,
    );
    expect(screen.getByText("6h")).toBeTruthy();
    expect(screen.getByText("4% used")).toBeTruthy();
    expect(screen.getByText("30d")).toBeTruthy();
    expect(screen.getByText("68% used")).toBeTruthy();
  });

  it("renders the popover variant as '% used' with the shared blue/red bar color", () => {
    const { container } = render(
      <CodexRateLimitView data={codex} variant="popover-detail" />,
    );
    // primary 4% used and secondary 68% used both stay blue.
    expect(screen.getByText("Current session")).toBeTruthy();
    expect(screen.getByText("4% used")).toBeTruthy();
    expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.getByText("68% used")).toBeTruthy();
    expect(container.querySelectorAll(".bg-blue-500").length).toBeGreaterThan(
      0,
    );
    expect(container.querySelectorAll(".bg-yellow-500").length).toBe(0);
  });

  it("draws every popover window track with a foreground-opacity fill so an empty bar stays visible", () => {
    // Regression (Issue 3): several dark presets set --muted == --popover, so
    // a `bg-muted` track vanished at 0% fill. The track now fills with
    // `bg-foreground/15` instead, which contrasts against any background
    // regardless of theme - a 0%-used window must still show a visible,
    // empty track, with no border needed to keep it that way.
    const { container } = render(
      <CodexRateLimitView
        data={{
          ...codex,
          secondary: null,
          extraWindows: [],
          resetCredits: null,
          primary: {
            usedPercent: 0,
            resetsAt: NOW + 60 * 60 * 1000,
            durationMinutes: 300,
          },
        }}
        variant="popover-detail"
      />,
    );
    expect(screen.getByText("Current session")).toBeTruthy();
    expect(screen.getByText("0% used")).toBeTruthy();
    const tracks = container.querySelectorAll(".bg-foreground\\/15");
    expect(tracks.length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".bg-green-500").length).toBe(0);
    const fill = container.querySelector(".bg-blue-500");
    expect(fill).toBeInstanceOf(HTMLElement);
    if (!(fill instanceof HTMLElement)) {
      throw new Error("Expected a blue rate-limit fill");
    }
    expect(fill.style.width).toBe("0%");
  });

  it("shows a relative countdown for a short popover window", () => {
    // Fixup C #1: the popover reverts to the same relative-for-short /
    // exact-for-weekly split as the Settings card. `primary` is a 5h window, so
    // it reads as a relative countdown ("Resets in 4h 7m"), not an absolute date.
    render(
      <CodexRateLimitView
        data={{ ...codex, secondary: null, extraWindows: [] }}
        variant="popover-detail"
      />,
    );
    expect(screen.getByText(/^Resets in /)).toBeTruthy();
    expect(screen.queryByText(/^Resets [A-Za-z]{3} \d{1,2}:\d{2}/)).toBeNull();
  });

  it("shows an absolute calendar date and time for a weekly popover window", () => {
    // The weekly (10080-min) `secondary` window keeps the absolute reset line
    // with its full date, since "Resets in 3d" is too coarse and a weekday
    // alone is ambiguous.
    render(
      <CodexRateLimitView
        data={{ ...codex, primary: null, extraWindows: [] }}
        variant="popover-detail"
      />,
    );
    expect(
      screen.getByText(
        `Resets ${formatResetFullDateTime(NOW + 3 * 24 * 60 * 60 * 1000)}`,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/^Resets in /)).toBeNull();
  });

  it("condenses the popover Overview to only the 5h/Weekly windows (credits dropped)", () => {
    // Item 3 feedback: Overview drops Credits too, along with per-model
    // extraWindows, the reset-credits block, and the plan label; it keeps only
    // the primary/secondary windows.
    render(
      <CodexRateLimitView
        data={{
          ...codex,
          credits: { unlimited: true, hasCredits: true, balance: null },
        }}
        variant="popover-overview"
      />,
    );
    // Kept: primary (4% used) + secondary (68% used) windows.
    expect(screen.getByText("Current session")).toBeTruthy();
    expect(screen.getByText("4% used")).toBeTruthy();
    expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.getByText("68% used")).toBeTruthy();
    // Dropped: plan label, per-model extraWindow row, reset-credits block, and
    // Credits.
    expect(screen.queryByText("Pro 5x")).toBeNull();
    expect(screen.queryByText("GPT-5 · Current session")).toBeNull();
    expect(screen.queryByText("Manual resets")).toBeNull();
    expect(screen.queryByText("Credits")).toBeNull();
  });
});

describe("ClaudeRateLimitView", () => {
  it("shows an absolute calendar date and time for a far per-model reset, even though modelScoped carries no durationMinutes", () => {
    // Regression: `modelScoped` entries never carry a `durationMinutes` (the
    // SDK's per-model usage has no separate duration field), so a
    // duration-based "is this weekly-scale" check always fell back to the
    // relative countdown for these rows, no matter how far away the real
    // reset was ("Fable" usage showed "Resets in 3d" instead of a precise
    // date/time). The reset-format decision is now based on the real
    // `resetsAt` delta instead, so a 3-day-out per-model reset gets the same
    // absolute treatment a weekly window does.
    const claude: ClaudeRateLimits = {
      provider: "claude-code",
      available: true,
      subscriptionType: "max",
      fiveHour: null,
      sevenDay: null,
      sevenDayOpus: null,
      sevenDaySonnet: null,
      modelScoped: [
        {
          displayName: "Fable",
          usedPercent: 12,
          resetsAt: NOW + 3 * 24 * 60 * 60 * 1000,
          durationMinutes: null,
        },
      ],
      extraUsage: null,
    };
    render(<ClaudeRateLimitView data={claude} variant="settings" />);
    expect(screen.getByText("Fable")).toBeTruthy();
    expect(
      screen.getByText(
        `Resets ${formatResetFullDateTime(NOW + 3 * 24 * 60 * 60 * 1000)}`,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/^Resets in /)).toBeNull();
  });

  it("sets the model-scoped rows off with a divider, not a 'Per-model' heading", () => {
    // Same header-less group treatment CodexRateLimitView gives its per-model
    // (Spark) extraWindows: the rows' own display names already say which
    // model each is, so the group gets a hairline divider instead of a label.
    const claude: ClaudeRateLimits = {
      provider: "claude-code",
      available: true,
      subscriptionType: "max",
      fiveHour: {
        usedPercent: 12,
        resetsAt: NOW + 60 * 60 * 1000,
        durationMinutes: 300,
      },
      sevenDay: {
        usedPercent: 55,
        resetsAt: NOW + 2 * 24 * 60 * 60 * 1000,
        durationMinutes: 10080,
      },
      sevenDayOpus: null,
      sevenDaySonnet: null,
      modelScoped: [
        {
          displayName: "Fable",
          usedPercent: 12,
          resetsAt: NOW + 3 * 24 * 60 * 60 * 1000,
          durationMinutes: null,
        },
      ],
      extraUsage: null,
    };
    const { container } = render(
      <ClaudeRateLimitView data={claude} variant="settings" />,
    );
    expect(screen.queryByText("Per-model")).toBeNull();
    // Exactly one divider: between the fixed windows and the model-scoped
    // group (extraUsage is null, so no second one).
    expect(container.querySelectorAll('[class*="bg-border/70"]').length).toBe(
      1,
    );
    expect(screen.getByText("Fable")).toBeTruthy();
  });

  it("renders no divider when only the fixed windows are present", () => {
    const claude: ClaudeRateLimits = {
      provider: "claude-code",
      available: true,
      subscriptionType: "max",
      fiveHour: {
        usedPercent: 12,
        resetsAt: NOW + 60 * 60 * 1000,
        durationMinutes: 300,
      },
      sevenDay: null,
      sevenDayOpus: null,
      sevenDaySonnet: null,
      modelScoped: [],
      extraUsage: null,
    };
    const { container } = render(
      <ClaudeRateLimitView data={claude} variant="settings" />,
    );
    expect(container.querySelectorAll('[class*="bg-border/70"]').length).toBe(
      0,
    );
  });

  it("formats extra usage cents as dollar amounts", () => {
    const claude: ClaudeRateLimits = {
      provider: "claude-code",
      available: true,
      subscriptionType: "max",
      fiveHour: null,
      sevenDay: null,
      sevenDayOpus: null,
      sevenDaySonnet: null,
      modelScoped: [],
      extraUsage: {
        isEnabled: true,
        monthlyLimit: 10000,
        usedCredits: 2360,
        utilization: 24,
      },
    };
    render(<ClaudeRateLimitView data={claude} variant="settings" />);
    expect(screen.getByText("Extra usage")).toBeTruthy();
    expect(screen.getByText("$23.60 / $100.00")).toBeTruthy();
    expect(screen.queryByText("2360.00 / 10000.00")).toBeNull();
  });
});

describe("OpenRouterRateLimitView", () => {
  const openRouter: OpenRouterRateLimits = {
    provider: "openrouter",
    available: true,
    limit: 100,
    limitRemaining: 40,
    dailySpend: 5,
    weeklySpend: 12,
    monthlySpend: 30,
    totalCredits: 100,
    totalUsage: 60,
    balance: 40,
  };

  it("renders a usage bar from limit/limitRemaining", () => {
    render(<OpenRouterRateLimitView data={openRouter} variant="settings" />);
    expect(screen.getByText("Credits")).toBeTruthy();
    expect(screen.getByText("$60.00 / $100.00")).toBeTruthy();
  });

  it("renders the uncapped spend/credit figures as plain rows", () => {
    render(<OpenRouterRateLimitView data={openRouter} variant="settings" />);
    expect(screen.getByText("Balance")).toBeTruthy();
    expect(screen.getByText("Spent this month")).toBeTruthy();
    expect(screen.getByText("$30.00")).toBeTruthy();
  });

  it("omits the bar when there is no hard limit", () => {
    render(
      <OpenRouterRateLimitView
        data={{ ...openRouter, limit: null, limitRemaining: null }}
        variant="settings"
      />,
    );
    expect(screen.queryByText("Credits")).toBeNull();
    // The uncapped figures still render.
    expect(screen.getByText("Balance")).toBeTruthy();
  });

  it("condenses the Overview to only the Credits bar and Balance", () => {
    // Issue 2d: Overview keeps the balance-shaped fields, drops the total /
    // per-period spend rows.
    render(
      <OpenRouterRateLimitView data={openRouter} variant="popover-overview" />,
    );
    expect(screen.getByText("Credits")).toBeTruthy();
    expect(screen.getByText("Balance")).toBeTruthy();
    expect(screen.queryByText("Spent this month")).toBeNull();
    expect(screen.queryByText("Total credits")).toBeNull();
  });
});

describe("KiloCodeRateLimitView", () => {
  const kilo: KiloCodeRateLimits = {
    provider: "kilocode",
    available: true,
    creditBalance: 25.5,
    passState: "active",
  };

  it("renders the credit balance and pass state as plain rows (no bar)", () => {
    const { container } = render(
      <KiloCodeRateLimitView data={kilo} variant="settings" />,
    );
    expect(screen.getByText("Credit balance")).toBeTruthy();
    expect(screen.getByText("$25.50")).toBeTruthy();
    expect(screen.getByText("Kilo Pass")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    // No computable percentage -> no fill bar.
    expect(container.querySelectorAll(".bg-primary").length).toBe(0);
  });

  it("condenses the Overview to only the credit balance (drops Kilo Pass)", () => {
    render(<KiloCodeRateLimitView data={kilo} variant="popover-overview" />);
    expect(screen.getByText("Credit balance")).toBeTruthy();
    expect(screen.queryByText("Kilo Pass")).toBeNull();
  });
});

describe("ProviderRateLimitDetail dispatch", () => {
  it("dispatches to the OpenRouter view", () => {
    render(
      <ProviderRateLimitDetail
        data={{
          provider: "openrouter",
          available: true,
          limit: null,
          limitRemaining: null,
          dailySpend: null,
          weeklySpend: null,
          monthlySpend: null,
          totalCredits: null,
          totalUsage: null,
          balance: 12,
        }}
        variant="settings"
        codexResetAction={null}
      />,
    );
    expect(screen.getByText("Balance")).toBeTruthy();
    expect(screen.getByText("$12.00")).toBeTruthy();
  });

  it("dispatches to the Kilo Code view", () => {
    render(
      <ProviderRateLimitDetail
        data={{
          provider: "kilocode",
          available: true,
          creditBalance: 7,
          passState: null,
        }}
        variant="settings"
        codexResetAction={null}
      />,
    );
    expect(screen.getByText("Credit balance")).toBeTruthy();
    expect(screen.getByText("$7.00")).toBeTruthy();
  });
});

describe("ProviderRateLimitBody (unavailable state)", () => {
  it("prefixes the reason with 'Usage limits unavailable', not a bare dash", () => {
    render(
      <ProviderRateLimitBody
        isPending={false}
        isFetching={false}
        isError={false}
        envelope={{
          latest: {
            provider: "codex",
            available: false,
            reason: "rate_limits_not_available",
          },
          lastGood: null,
          lastGoodAt: null,
          lastFailureAt: NOW,
        }}
        codexResetAction={null}
      />,
    );
    expect(
      screen.getByText(
        "Usage limits unavailable - not available for this account",
      ),
    ).toBeTruthy();
  });
});

describe("ProviderRateLimitBody (Codex reset action)", () => {
  it("places the supplied action beside a positive manual-reset count", () => {
    render(
      <ProviderRateLimitBody
        isPending={false}
        isFetching={false}
        isError={false}
        envelope={{
          latest: {
            provider: "codex",
            available: true,
            planType: "pro_5x",
            limitId: "codex",
            limitName: "Codex",
            primary: null,
            secondary: null,
            extraWindows: [],
            credits: null,
            individualLimit: null,
            resetCredits: { availableCount: 3, credits: null },
            rateLimitReachedType: null,
          },
          lastGood: null,
          lastGoodAt: null,
          lastFailureAt: null,
        }}
        codexResetAction={() => <button type="button">Use reset</button>}
      />,
    );

    expect(screen.getByText("3 available")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use reset" })).toBeTruthy();
  });
});
