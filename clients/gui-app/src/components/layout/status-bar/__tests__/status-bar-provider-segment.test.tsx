import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StatusBarProviderSegment } from "@/components/layout/status-bar/status-bar-provider-segment";
import type {
  StatusBarProviderSegmentModel,
  StatusBarProviderSegmentState,
  StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import type { StatusBarDensity } from "@/components/layout/status-bar/status-bar-density";
import type { RateLimitWindowKind } from "@/lib/rate-limits/rate-limit-window-catalog";
import type { RateLimitWindowSeverity } from "@/lib/rate-limits/window-severity";
import type { PercentMode } from "@/stores/settings/layout-store";

function windowFixture(overrides: {
  readonly windowKey: string;
  readonly label?: string;
  /**
   * Defaults to `true` because the fixture's own default label ("5h") IS a
   * plain duration - the same shape `claude-code:fiveHour` has in the
   * catalog. A call that overrides `label` to a name that also carries
   * identity (a model, a bucket, a named limit) must override this too.
   */
  readonly labelIsDuration?: boolean;
  readonly kind?: RateLimitWindowKind;
  readonly usedPercent?: number;
  readonly resetsAt?: number | null;
  readonly severity?: RateLimitWindowSeverity;
}): StatusBarRateLimitWindow {
  return {
    windowKey: overrides.windowKey,
    label: overrides.label ?? "5h",
    labelIsDuration: overrides.labelIsDuration ?? true,
    kind: overrides.kind ?? "session",
    usedPercent: overrides.usedPercent ?? 40,
    resetsAt: overrides.resetsAt ?? null,
    severity: overrides.severity ?? "healthy",
  };
}

function segmentFixture(overrides: {
  readonly providerId?: StatusBarProviderSegmentModel["providerId"];
  readonly state?: StatusBarProviderSegmentState;
  readonly reason?: StatusBarProviderSegmentModel["reason"];
  readonly windows?: ReadonlyArray<StatusBarRateLimitWindow>;
  readonly tightest?: StatusBarRateLimitWindow | null;
}): StatusBarProviderSegmentModel {
  const windows = overrides.windows ?? [];
  return {
    providerId: overrides.providerId ?? "codex",
    state: overrides.state ?? "live",
    reason: overrides.reason ?? null,
    windows,
    tightest: overrides.tightest ?? (windows.length > 0 ? windows[0] : null),
  };
}

function renderSegment(props: {
  readonly segment: StatusBarProviderSegmentModel;
  readonly density?: StatusBarDensity;
  readonly percentMode?: PercentMode;
  readonly showTimer?: boolean;
  readonly showBar?: boolean;
}) {
  return render(
    <TooltipProvider>
      <StatusBarProviderSegment
        segment={props.segment}
        density={props.density ?? "full"}
        percentMode={props.percentMode ?? "used"}
        showTimer={props.showTimer ?? false}
        showBar={props.showBar ?? true}
      />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("<StatusBarProviderSegment />", () => {
  describe("percent mode", () => {
    it("prints the complement of the ROUNDED used percentage in remaining mode (33.4% used -> 67% remaining)", () => {
      const segment = segmentFixture({
        windows: [
          windowFixture({ windowKey: "codex:primary", usedPercent: 33.4 }),
        ],
      });
      renderSegment({ segment, percentMode: "used" });
      expect(
        screen.getByTestId("status-bar-window-codex:primary").textContent,
      ).toBe("33% used 5h");
      cleanup();

      renderSegment({ segment, percentMode: "remaining" });
      expect(
        screen.getByTestId("status-bar-window-codex:primary").textContent,
      ).toBe("67% remaining 5h");
    });

    it("computes remaining as 100 minus the rounded used percentage (66.6% used -> 67% used / 33% remaining)", () => {
      const segment = segmentFixture({
        windows: [
          windowFixture({ windowKey: "codex:primary", usedPercent: 66.6 }),
        ],
      });
      renderSegment({ segment, percentMode: "used" });
      expect(
        screen.getByTestId("status-bar-window-codex:primary").textContent,
      ).toBe("67% used 5h");
      cleanup();

      renderSegment({ segment, percentMode: "remaining" });
      expect(
        screen.getByTestId("status-bar-window-codex:primary").textContent,
      ).toBe("33% remaining 5h");
    });
  });

  describe("timer", () => {
    it("prints the catalog's static label when the timer is off", () => {
      const segment = segmentFixture({
        windows: [
          windowFixture({
            windowKey: "codex:primary",
            label: "5h",
            resetsAt: Date.now() + 1_000_000,
          }),
        ],
      });
      renderSegment({ segment, showTimer: false });
      expect(
        screen.getByTestId("status-bar-window-codex:primary").textContent,
      ).toBe("40% used 5h");
    });

    it("prints a countdown when the timer is on and a resetsAt is present", () => {
      const resetsAt = Date.now() + (4 * 60 + 15) * 60_000 + 5_000;
      const segment = segmentFixture({
        windows: [
          windowFixture({ windowKey: "codex:primary", label: "5h", resetsAt }),
        ],
      });
      renderSegment({ segment, showTimer: true });
      expect(
        screen.getByTestId("status-bar-window-codex:primary").textContent,
      ).toBe("40% used 4h 15m");
    });

    it("falls back to the static label when the timer is on but resetsAt is null", () => {
      const segment = segmentFixture({
        windows: [
          windowFixture({
            windowKey: "codex:primary",
            label: "5h",
            resetsAt: null,
          }),
        ],
      });
      renderSegment({ segment, showTimer: true });
      expect(
        screen.getByTestId("status-bar-window-codex:primary").textContent,
      ).toBe("40% used 5h");
    });
  });

  it("keeps a model-scoped window's name and appends the countdown", () => {
    const resetsAt = Date.now() + (2 * 60 + 5) * 60_000 + 5_000;
    const segment = segmentFixture({
      windows: [
        windowFixture({
          windowKey: "claude-code:model:Fable",
          label: "Fable",
          labelIsDuration: false,
          kind: "model",
          resetsAt,
        }),
      ],
    });
    renderSegment({ segment, showTimer: true });
    expect(
      screen.getByTestId("status-bar-window-claude-code:model:Fable")
        .textContent,
    ).toBe("40% used Fable 2h 5m");
  });

  // The regression guard for `windowLabel`'s replace-vs-append rule: a
  // countdown may only REPLACE a label that says nothing but the window's
  // length, because several labels are guaranteed to share one `resetsAt`
  // with a sibling window - dropping the name there would print two
  // different pools as one indistinguishable string.
  describe("label rule: countdown replaces a duration, joins everything else", () => {
    const resetsAt = Date.now() + (4 * 60 + 15) * 60_000 + 5_000;

    it("a duration label (labelIsDuration: true) renders the countdown alone", () => {
      const segment = segmentFixture({
        windows: [
          windowFixture({
            windowKey: "claude-code:fiveHour",
            label: "5h",
            labelIsDuration: true,
            resetsAt,
          }),
        ],
      });
      renderSegment({ segment, showTimer: true });
      expect(
        screen.getByTestId("status-bar-window-claude-code:fiveHour")
          .textContent,
      ).toBe("40% used 4h 15m");
    });

    it("a Cursor-style bucket (labelIsDuration: false) renders its name beside the countdown", () => {
      const segment = segmentFixture({
        windows: [
          windowFixture({
            windowKey: "cursor:cursorModels",
            label: "Cursor models",
            labelIsDuration: false,
            kind: "bucket",
            resetsAt,
          }),
        ],
      });
      renderSegment({ segment, showTimer: true });
      expect(
        screen.getByTestId("status-bar-window-cursor:cursorModels").textContent,
      ).toBe("40% used Cursor models 4h 15m");
    });

    it("two Cursor-style windows sharing ONE resetsAt render two distinct strings, each with its own bucket name", () => {
      const cursorModels = windowFixture({
        windowKey: "cursor:cursorModels",
        label: "Cursor models",
        labelIsDuration: false,
        kind: "bucket",
        resetsAt,
      });
      const otherModels = windowFixture({
        windowKey: "cursor:otherModels",
        label: "Other models",
        labelIsDuration: false,
        kind: "bucket",
        resetsAt,
      });
      const segment = segmentFixture({ windows: [cursorModels, otherModels] });
      renderSegment({ segment, showTimer: true });

      const cursorText = screen.getByTestId(
        "status-bar-window-cursor:cursorModels",
      ).textContent;
      const otherText = screen.getByTestId(
        "status-bar-window-cursor:otherModels",
      ).textContent;
      expect(cursorText).not.toBe(otherText);
      expect(cursorText).toContain("Cursor models");
      expect(otherText).toContain("Other models");
    });

    it("a named codex extra (labelIsDuration: false) keeps its name", () => {
      const segment = segmentFixture({
        windows: [
          windowFixture({
            windowKey: "codex:extra:gpt-5-codex:primary",
            label: "GPT-5 Codex 5h",
            labelIsDuration: false,
            resetsAt,
          }),
        ],
      });
      renderSegment({ segment, showTimer: true });
      expect(
        screen.getByTestId("status-bar-window-codex:extra:gpt-5-codex:primary")
          .textContent,
      ).toBe("40% used GPT-5 Codex 5h 4h 15m");
    });

    it("a grok period keeps its periodType name", () => {
      const segment = segmentFixture({
        windows: [
          windowFixture({
            windowKey: "grok:period",
            label: "monthly",
            labelIsDuration: false,
            kind: "period",
            resetsAt,
          }),
        ],
      });
      renderSegment({ segment, showTimer: true });
      expect(
        screen.getByTestId("status-bar-window-grok:period").textContent,
      ).toBe("40% used monthly 4h 15m");
    });

    it("'Opus wk' keeps its name", () => {
      const segment = segmentFixture({
        windows: [
          windowFixture({
            windowKey: "claude-code:sevenDayOpus",
            label: "Opus wk",
            labelIsDuration: false,
            kind: "weekly",
            resetsAt,
          }),
        ],
      });
      renderSegment({ segment, showTimer: true });
      expect(
        screen.getByTestId("status-bar-window-claude-code:sevenDayOpus")
          .textContent,
      ).toBe("40% used Opus wk 4h 15m");
    });

    it("keeps the Cursor case distinct with the timer off (static labels)", () => {
      const cursorModels = windowFixture({
        windowKey: "cursor:cursorModels",
        label: "Cursor models",
        labelIsDuration: false,
        kind: "bucket",
        resetsAt,
      });
      const otherModels = windowFixture({
        windowKey: "cursor:otherModels",
        label: "Other models",
        labelIsDuration: false,
        kind: "bucket",
        resetsAt,
      });
      const segment = segmentFixture({ windows: [cursorModels, otherModels] });
      renderSegment({ segment, showTimer: false });

      const cursorText = screen.getByTestId(
        "status-bar-window-cursor:cursorModels",
      ).textContent;
      const otherText = screen.getByTestId(
        "status-bar-window-cursor:otherModels",
      ).textContent;
      expect(cursorText).not.toBe(otherText);
      expect(cursorText).toBe("40% used Cursor models");
      expect(otherText).toBe("40% used Other models");
    });

    it("keeps the Cursor case distinct in remaining mode", () => {
      const cursorModels = windowFixture({
        windowKey: "cursor:cursorModels",
        label: "Cursor models",
        labelIsDuration: false,
        kind: "bucket",
        resetsAt,
      });
      const otherModels = windowFixture({
        windowKey: "cursor:otherModels",
        label: "Other models",
        labelIsDuration: false,
        kind: "bucket",
        resetsAt,
      });
      const segment = segmentFixture({ windows: [cursorModels, otherModels] });
      renderSegment({ segment, showTimer: true, percentMode: "remaining" });

      const cursorText = screen.getByTestId(
        "status-bar-window-cursor:cursorModels",
      ).textContent;
      const otherText = screen.getByTestId(
        "status-bar-window-cursor:otherModels",
      ).textContent;
      expect(cursorText).not.toBe(otherText);
      expect(cursorText).toBe("60% remaining Cursor models 4h 15m");
      expect(otherText).toBe("60% remaining Other models 4h 15m");
    });
  });

  describe("mini bar", () => {
    it("carries the tightest window's severity class and a width from its used percentage", () => {
      const tightest = windowFixture({
        windowKey: "codex:primary",
        usedPercent: 92,
        severity: "limited",
      });
      const segment = segmentFixture({ windows: [tightest], tightest });
      renderSegment({ segment, density: "full", showBar: true });

      const fill = screen.getByTestId("status-bar-provider-mini-bar-fill");
      expect(fill.className).toContain("bg-red-500");
      expect(fill.style.width).toBe("92%");
    });

    it("disappears when showBar is false", () => {
      const tightest = windowFixture({ windowKey: "codex:primary" });
      const segment = segmentFixture({ windows: [tightest], tightest });
      renderSegment({ segment, density: "full", showBar: false });

      expect(screen.queryByTestId("status-bar-provider-mini-bar")).toBeNull();
    });
  });

  describe("density", () => {
    it("compact renders only the tightest window and no mini bar", () => {
      const primary = windowFixture({
        windowKey: "codex:primary",
        usedPercent: 40,
      });
      const secondary = windowFixture({
        windowKey: "codex:secondary",
        usedPercent: 90,
      });
      const segment = segmentFixture({
        windows: [primary, secondary],
        tightest: secondary,
      });
      renderSegment({ segment, density: "compact" });

      expect(
        screen.queryByTestId("status-bar-window-codex:primary"),
      ).toBeNull();
      expect(
        screen.getByTestId("status-bar-window-codex:secondary"),
      ).not.toBeNull();
      expect(screen.queryByTestId("status-bar-provider-mini-bar")).toBeNull();
    });

    it("icon-only renders neither windows nor the mini bar", () => {
      const tightest = windowFixture({ windowKey: "codex:primary" });
      const segment = segmentFixture({ windows: [tightest], tightest });
      renderSegment({ segment, density: "icon-only" });

      expect(
        screen.queryByTestId("status-bar-window-codex:primary"),
      ).toBeNull();
      expect(screen.queryByTestId("status-bar-provider-mini-bar")).toBeNull();
    });
  });

  describe("segment states", () => {
    it("cold renders the neutral track and no spinner-carrying element", () => {
      const segment = segmentFixture({ state: "cold" });
      renderSegment({ segment });

      expect(
        screen.getByTestId("status-bar-provider-cold-track"),
      ).not.toBeNull();
      expect(
        screen.queryByTestId("status-bar-provider-unavailable"),
      ).toBeNull();
      expect(screen.queryByTestId("status-bar-provider-degraded")).toBeNull();
    });

    it("unavailable renders the dash", () => {
      const segment = segmentFixture({
        state: "unavailable",
        reason: "cli_not_found",
      });
      renderSegment({ segment });

      expect(
        screen.getByTestId("status-bar-provider-unavailable"),
      ).not.toBeNull();
      expect(screen.queryByTestId("status-bar-provider-cold-track")).toBeNull();
    });

    it("degraded renders the warning glyph and dims the segment", () => {
      const segment = segmentFixture({
        state: "degraded",
        reason: "usage_fetch_failed",
        windows: [windowFixture({ windowKey: "codex:primary" })],
      });
      renderSegment({ segment });

      const outer = screen.getByTestId("status-bar-provider-segment-codex");
      expect(outer.className).toContain("opacity-60");
      expect(screen.getByTestId("status-bar-provider-degraded")).not.toBeNull();
    });
  });
});
