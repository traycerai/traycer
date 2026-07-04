import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ProviderRateLimits } from "@traycer/protocol/host";
import {
  CodexRateLimitView,
  KiloCodeRateLimitView,
  OpenRouterRateLimitView,
  ProviderRateLimitDetail,
} from "../provider-rate-limit-views";

type CodexRateLimits = Extract<ProviderRateLimits, { provider: "codex" }>;
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
    resetCredits: { availableCount: 3 },
    rateLimitReachedType: null,
  };

  it("labels windows from their real duration (not a hardcoded 5-hour/Weekly)", () => {
    render(<CodexRateLimitView data={codex} variant="settings" />);
    expect(screen.getByText("5h · 4% used")).toBeTruthy();
    expect(screen.getByText("Weekly · 68% used")).toBeTruthy();
  });

  it("shows the plan/tier label from planType in the popover detail tab", () => {
    render(<CodexRateLimitView data={codex} variant="popover-detail" />);
    // `planType` ("pro_5x") title-cased - NOT `limitName` (a bucket id).
    expect(screen.getByText("Pro 5x")).toBeTruthy();
  });

  it("omits any plan/tier label in the settings variant", () => {
    render(<CodexRateLimitView data={codex} variant="settings" />);
    expect(screen.queryByText("Pro 5x")).toBeNull();
  });

  it("renders each extraWindow as its own labeled row (limit name + duration)", () => {
    render(<CodexRateLimitView data={codex} variant="settings" />);
    expect(screen.getByText("GPT-5 · 5h · 20% used")).toBeTruthy();
  });

  it("renders the manual reset-credits block", () => {
    render(<CodexRateLimitView data={codex} variant="settings" />);
    expect(screen.getByText("Manual resets")).toBeTruthy();
    expect(screen.getByText("3 available")).toBeTruthy();
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
    expect(screen.getByText("6h · 4% used")).toBeTruthy();
    expect(screen.getByText("30d · 68% used")).toBeTruthy();
  });

  it("renders the popover variant as '% used' with a four-tier bar color", () => {
    const { container } = render(
      <CodexRateLimitView data={codex} variant="popover-detail" />,
    );
    // primary 4% used -> blue tier; secondary 68% used -> yellow tier.
    expect(screen.getByText("5h · 4% used")).toBeTruthy();
    expect(screen.getByText("Weekly · 68% used")).toBeTruthy();
    expect(container.querySelectorAll(".bg-blue-500").length).toBeGreaterThan(
      0,
    );
    expect(container.querySelectorAll(".bg-yellow-500").length).toBeGreaterThan(
      0,
    );
  });

  it("draws every popover window track with a border so an empty bar stays visible", () => {
    // Regression (Issue 3): several dark presets set --muted == --popover, so a
    // borderless bg-muted track vanished at 0% fill. A 0%-used window must still
    // show a bordered, empty track.
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
    expect(screen.getByText("5h · 0% used")).toBeTruthy();
    const tracks = container.querySelectorAll(".bg-muted.border-border");
    expect(tracks.length).toBeGreaterThan(0);
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
    expect(screen.queryByText(/\([A-Za-z]{3}\) /)).toBeNull();
  });

  it("shows an absolute weekday-tagged date for a weekly popover window", () => {
    // The weekly (10080-min) `secondary` window keeps the absolute reset line
    // ("Resets Jul 11, 2026 (Tue) 3:35 AM"), since "Resets in 3d" is too coarse.
    render(
      <CodexRateLimitView
        data={{ ...codex, primary: null, extraWindows: [] }}
        variant="popover-detail"
      />,
    );
    expect(screen.getByText(/^Resets .+\([A-Za-z]{3}\) /)).toBeTruthy();
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
    expect(screen.getByText("5h · 4% used")).toBeTruthy();
    expect(screen.getByText("Weekly · 68% used")).toBeTruthy();
    // Dropped: plan label, per-model extraWindow row, reset-credits block, and
    // Credits.
    expect(screen.queryByText("Pro 5x")).toBeNull();
    expect(screen.queryByText("GPT-5 · 5h · 20% used")).toBeNull();
    expect(screen.queryByText("Manual resets")).toBeNull();
    expect(screen.queryByText("Credits")).toBeNull();
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
      />,
    );
    expect(screen.getByText("Credit balance")).toBeTruthy();
    expect(screen.getByText("$7.00")).toBeTruthy();
  });
});
