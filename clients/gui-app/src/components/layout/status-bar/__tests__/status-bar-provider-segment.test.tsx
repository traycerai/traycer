import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StatusBarProviderSegment } from "@/components/layout/status-bar/status-bar-provider-segment";
import type { StatusBarUsageDetail } from "@/components/layout/status-bar/status-bar-usage-ladder";
import type {
  StatusBarProviderSegmentModel,
  StatusBarProviderSegmentState,
  StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import type { RateLimitWindowKind } from "@/lib/rate-limits/rate-limit-window-catalog";
import {
  rateLimitWindowSeverityTextClassName,
  RUNNING_LOW_TEXT_CLASS_NAME,
} from "@/lib/rate-limits/window-severity";
import type { RateLimitWindowSeverity } from "@/lib/rate-limits/window-severity";
import type { PercentMode } from "@/stores/settings/layout-store";

/**
 * A reset instant `hours:minutes` out, sampled when the TEST runs.
 *
 * A function rather than a `describe`-scoped constant, and that is the whole
 * point of it: a `describe` body runs at COLLECTION, so a constant there is
 * already minutes old by the time the last case in the block renders. The
 * 5-second cushion keeps the countdown off a minute boundary for the render
 * itself; it was never a budget for the suite's own runtime, and on a slower
 * runner that is exactly what it was being spent on - flipping `4h 15m` to
 * `4h 14m` in a case that had asserted the former.
 */
function resetsAtIn(hours: number, minutes: number): number {
  return Date.now() + (hours * 60 + minutes) * 60_000 + 5_000;
}

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

/**
 * A second live window, so the reading under test has something it has to be
 * told apart FROM.
 *
 * A name is printed only once a provider has two or more live limits, so a
 * fixture asserting a name has to state the sibling that earns it. It is not
 * drawn - `shown` defaults to the tightest alone, which defaults to the first
 * window - which is exactly the case the rule is about: the count is what the
 * provider HAS, not what this rung draws.
 */
function siblingWindow(): StatusBarRateLimitWindow {
  return windowFixture({ windowKey: "sibling:other", label: "wk" });
}

function segmentFixture(overrides: {
  readonly providerId?: StatusBarProviderSegmentModel["providerId"];
  readonly state?: StatusBarProviderSegmentState;
  readonly reason?: StatusBarProviderSegmentModel["reason"];
  readonly windows?: ReadonlyArray<StatusBarRateLimitWindow>;
  /** The selection resolved; defaults to the tightest alone, as the store does. */
  readonly shown?: ReadonlyArray<StatusBarRateLimitWindow>;
  readonly tightest?: StatusBarRateLimitWindow | null;
}): StatusBarProviderSegmentModel {
  const windows = overrides.windows ?? [];
  const tightest =
    overrides.tightest ?? (windows.length > 0 ? windows[0] : null);
  return {
    providerId: overrides.providerId ?? "codex",
    state: overrides.state ?? "live",
    reason: overrides.reason ?? null,
    windows,
    shown: overrides.shown ?? (tightest === null ? [] : [tightest]),
    tightest,
  };
}

function renderSegment(props: {
  readonly segment: StatusBarProviderSegmentModel;
  readonly detail?: StatusBarUsageDetail;
  readonly percentMode?: PercentMode;
  readonly showModeWord?: boolean;
  readonly showTimer?: boolean;
  readonly showBar?: boolean;
}) {
  return render(
    <TooltipProvider>
      <StatusBarProviderSegment
        segment={props.segment}
        detail={props.detail ?? "full"}
        percentMode={props.percentMode ?? "used"}
        showModeWord={props.showModeWord ?? true}
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

    // Nothing upstream clamps for the text: `windowProjection` passes the
    // host's `usedPercent` through verbatim, and `openRouterCreditProjection`
    // derives one from a `limitRemaining` that goes negative on an overdrawn
    // account. Unclamped, `remaining` prints `-4%`, which reads as a bug in the
    // app rather than as an account past its limit.
    it("clamps a percentage above 100, so remaining never goes negative", () => {
      const segment = segmentFixture({
        windows: [
          windowFixture({ windowKey: "codex:primary", usedPercent: 104 }),
        ],
      });
      renderSegment({ segment, percentMode: "used" });
      expect(
        screen.getByTestId("status-bar-window-codex:primary").textContent,
      ).toBe("100% used 5h");
      cleanup();

      renderSegment({ segment, percentMode: "remaining" });
      expect(
        screen.getByTestId("status-bar-window-codex:primary").textContent,
      ).toBe("0% remaining 5h");
    });

    // The other end of the same clamp. A negative reading is the rarer wire
    // shape, but `100 - used` would print `103% remaining` from it - a number
    // that cannot be true of any window.
    it("clamps a percentage below 0, so used never goes negative and remaining never exceeds 100", () => {
      const segment = segmentFixture({
        windows: [
          windowFixture({ windowKey: "codex:primary", usedPercent: -3 }),
        ],
      });
      renderSegment({ segment, percentMode: "used" });
      expect(
        screen.getByTestId("status-bar-window-codex:primary").textContent,
      ).toBe("0% used 5h");
      cleanup();

      renderSegment({ segment, percentMode: "remaining" });
      expect(
        screen.getByTestId("status-bar-window-codex:primary").textContent,
      ).toBe("100% remaining 5h");
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
      const resetsAt = resetsAtIn(4, 15);
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
    const resetsAt = resetsAtIn(2, 5);
    const segment = segmentFixture({
      windows: [
        windowFixture({
          windowKey: "claude-code:model:Fable",
          label: "Fable",
          labelIsDuration: false,
          kind: "model",
          resetsAt,
        }),
        // The sibling that earns the name. Drawn or not, it is what this
        // provider's reading has to be distinguishable FROM.
        siblingWindow(),
      ],
    });
    renderSegment({ segment, showTimer: true });
    expect(
      screen.getByTestId("status-bar-window-claude-code:model:Fable")
        .textContent,
    ).toBe("40% used Fable 2h 5m");
  });

  // The regression guard for `windowLabelText`'s replace-vs-append rule, which
  // applies once a provider has TWO OR MORE visible limits: a countdown may
  // only REPLACE a label that says nothing but the window's length, because
  // several labels are guaranteed to share one `resetsAt` with a sibling
  // window - dropping the name there would print two different pools as one
  // indistinguishable string. Every fixture here therefore carries a sibling;
  // a provider with one visible limit is the block below.
  describe("label rule: countdown replaces a duration, joins everything else", () => {
    let resetsAt = 0;
    beforeEach(() => {
      resetsAt = resetsAtIn(4, 15);
    });

    it("a duration label (labelIsDuration: true) renders the countdown alone", () => {
      const segment = segmentFixture({
        windows: [
          windowFixture({
            windowKey: "claude-code:fiveHour",
            label: "5h",
            labelIsDuration: true,
            resetsAt,
          }),
          siblingWindow(),
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
          siblingWindow(),
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
      const segment = segmentFixture({
        windows: [cursorModels, otherModels],
        shown: [cursorModels, otherModels],
      });
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
          siblingWindow(),
        ],
      });
      renderSegment({ segment, showTimer: true });
      expect(
        screen.getByTestId("status-bar-window-codex:extra:gpt-5-codex:primary")
          .textContent,
      ).toBe("40% used GPT-5 Codex 5h 4h 15m");
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
          siblingWindow(),
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
      const segment = segmentFixture({
        windows: [cursorModels, otherModels],
        shown: [cursorModels, otherModels],
      });
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
      const segment = segmentFixture({
        windows: [cursorModels, otherModels],
        shown: [cursorModels, otherModels],
      });
      renderSegment({
        segment,
        showTimer: true,
        percentMode: "remaining",
      });

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

  // The other half of the rule above. A name is worth strip width only when it
  // tells one of a provider's readings from another, so a provider with ONE
  // visible limit prints none - and gets it straight back the moment there is
  // no countdown, since a bare percentage under an icon names no limit at all.
  describe("naming rule: one visible limit prints no name", () => {
    let resetsAt = 0;
    beforeEach(() => {
      resetsAt = resetsAtIn(4, 15);
    });

    it("a grok period - the one window that provider reports - is the countdown alone", () => {
      const segment = segmentFixture({
        windows: [
          windowFixture({
            windowKey: "grok:period",
            // The catalog's compact word for a weekly period - the strip's
            // vocabulary, not the provider page's "Weekly".
            label: "wk",
            labelIsDuration: false,
            kind: "period",
            usedPercent: 100,
            resetsAt,
          }),
        ],
      });
      renderSegment({ segment, showTimer: true });
      expect(
        screen.getByTestId("status-bar-window-grok:period").textContent,
      ).toBe("100% used 4h 15m");
    });

    it("the same grok period falls back to its short name with no countdown to print", () => {
      const segment = segmentFixture({
        windows: [
          windowFixture({
            windowKey: "grok:period",
            // The catalog's compact word for a weekly period - the strip's
            // vocabulary, not the provider page's "Weekly".
            label: "wk",
            labelIsDuration: false,
            kind: "period",
            usedPercent: 100,
            resetsAt: null,
          }),
        ],
      });
      renderSegment({ segment, showTimer: true });
      expect(
        screen.getByTestId("status-bar-window-grok:period").textContent,
      ).toBe("100% used wk");
    });

    it("keeps 'Fable' while Claude has several visible limits", () => {
      const segment = segmentFixture({
        windows: [
          windowFixture({
            windowKey: "claude-code:model:Fable",
            label: "Fable",
            labelIsDuration: false,
            kind: "model",
            usedPercent: 57,
            resetsAt,
          }),
          siblingWindow(),
        ],
      });
      renderSegment({ segment, showTimer: true });
      expect(
        screen.getByTestId("status-bar-window-claude-code:model:Fable")
          .textContent,
      ).toBe("57% used Fable 4h 15m");
    });

    it("drops 'Fable' once it is the only limit Claude still shows", () => {
      // Same window, same reading. Hiding its siblings in Settings is what
      // leaves the name with nothing to disambiguate.
      const segment = segmentFixture({
        windows: [
          windowFixture({
            windowKey: "claude-code:model:Fable",
            label: "Fable",
            labelIsDuration: false,
            kind: "model",
            usedPercent: 57,
            resetsAt,
          }),
        ],
      });
      renderSegment({ segment, showTimer: true });
      expect(
        screen.getByTestId("status-bar-window-claude-code:model:Fable")
          .textContent,
      ).toBe("57% used 4h 15m");
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
      renderSegment({ segment, detail: "full", showBar: true });

      const fill = screen.getByTestId("status-bar-provider-mini-bar-fill");
      expect(fill.className).toContain("bg-red-500");
      expect(fill.style.width).toBe("92%");
    });

    it("disappears when showBar is false", () => {
      const tightest = windowFixture({ windowKey: "codex:primary" });
      const segment = segmentFixture({ windows: [tightest], tightest });
      renderSegment({ segment, detail: "full", showBar: false });

      expect(screen.queryByTestId("status-bar-provider-mini-bar")).toBeNull();
    });

    it("draws exactly one bar for a provider drawing one limit", () => {
      const tightest = windowFixture({ windowKey: "codex:primary" });
      const segment = segmentFixture({ windows: [tightest], tightest });
      renderSegment({ segment, detail: "full", showBar: true });

      expect(
        screen.getAllByTestId("status-bar-provider-mini-bar"),
      ).toHaveLength(1);
    });

    // A provider showing several limits is showing several independent gauges.
    describe("one bar per drawn limit", () => {
      function twoLimitSegment(): StatusBarProviderSegmentModel {
        const primary = windowFixture({
          windowKey: "codex:primary",
          usedPercent: 30,
          severity: "healthy",
        });
        const secondary = windowFixture({
          windowKey: "codex:secondary",
          label: "wk",
          usedPercent: 92,
          severity: "limited",
        });
        return segmentFixture({
          windows: [primary, secondary],
          shown: [primary, secondary],
          tightest: secondary,
        });
      }

      it("gives each drawn limit its own bar, filled and coloured from that window", () => {
        renderSegment({
          segment: twoLimitSegment(),
          detail: "full",
          showBar: true,
        });

        const bars = screen.getAllByTestId("status-bar-provider-mini-bar");
        expect(bars.map((bar) => bar.getAttribute("data-window-key"))).toEqual([
          "codex:primary",
          "codex:secondary",
        ]);
        const fills = screen.getAllByTestId(
          "status-bar-provider-mini-bar-fill",
        );
        expect(fills.map((fill) => fill.style.width)).toEqual(["30%", "92%"]);
        // The severity is the WINDOW's, so two bars under one icon can - and
        // here do - read as two different states.
        expect(fills[0].className).toContain("bg-blue-500");
        expect(fills[1].className).toContain("bg-red-500");
      });

      it("puts each bar immediately before the reading it measures", () => {
        renderSegment({
          segment: twoLimitSegment(),
          detail: "full",
          showBar: true,
        });

        for (const windowKey of ["codex:primary", "codex:secondary"]) {
          const bar = screen
            .getAllByTestId("status-bar-provider-mini-bar")
            .find((candidate) => candidate.dataset.windowKey === windowKey);
          expect(bar?.nextElementSibling).toBe(
            screen.getByTestId(`status-bar-window-${windowKey}`),
          );
        }
      });

      it("drops every bar when the switch is off, however many limits are drawn", () => {
        renderSegment({
          segment: twoLimitSegment(),
          detail: "full",
          showBar: false,
        });

        expect(screen.queryAllByTestId("status-bar-provider-mini-bar")).toEqual(
          [],
        );
        expect(
          screen.getByTestId("status-bar-window-codex:primary"),
        ).not.toBeNull();
        expect(
          screen.getByTestId("status-bar-window-codex:secondary"),
        ).not.toBeNull();
      });

      it("keeps a bar per limit at three, in catalog order", () => {
        const primary = windowFixture({
          windowKey: "codex:primary",
          usedPercent: 30,
        });
        const secondary = windowFixture({
          windowKey: "codex:secondary",
          label: "wk",
          usedPercent: 60,
          severity: "running_low",
        });
        const extra = windowFixture({
          windowKey: "codex:extra:gpt-5-codex:primary",
          label: "GPT-5 Codex 5h",
          labelIsDuration: false,
          usedPercent: 92,
          severity: "limited",
        });
        const segment = segmentFixture({
          windows: [primary, secondary, extra],
          shown: [primary, secondary, extra],
          tightest: extra,
        });

        renderSegment({ segment, detail: "full", showBar: true });

        expect(
          screen
            .getAllByTestId("status-bar-provider-mini-bar")
            .map((bar) => bar.getAttribute("data-window-key")),
        ).toEqual([
          "codex:primary",
          "codex:secondary",
          "codex:extra:gpt-5-codex:primary",
        ]);
        expect(
          screen
            .getAllByTestId("status-bar-provider-mini-bar-fill")
            .map((fill) => fill.style.width),
        ).toEqual(["30%", "60%", "92%"]);
      });

      // The rung above `no-bars` takes the mode word and nothing else, so the
      // bars are all still there - one per reading, as at `full`.
      it("keeps one bar per limit on the no-mode-word rung", () => {
        renderSegment({
          segment: twoLimitSegment(),
          detail: "no-mode-word",
          showBar: true,
        });

        expect(
          screen
            .getAllByTestId("status-bar-provider-mini-bar")
            .map((bar) => bar.getAttribute("data-window-key")),
        ).toEqual(["codex:primary", "codex:secondary"]);
        expect(
          screen.getByTestId("status-bar-window-codex:primary").textContent,
        ).toBe("30% 5h");
      });

      it("drops every bar at once on the no-bars rung, keeping both readings", () => {
        renderSegment({
          segment: twoLimitSegment(),
          detail: "no-bars",
          showBar: true,
        });

        expect(screen.queryAllByTestId("status-bar-provider-mini-bar")).toEqual(
          [],
        );
        expect(
          screen.getByTestId("status-bar-window-codex:primary"),
        ).not.toBeNull();
        expect(
          screen.getByTestId("status-bar-window-codex:secondary"),
        ).not.toBeNull();
      });

      // `percent-only` narrows to the tightest whatever is selected, so at most
      // one bar could ever be drawn there - and in fact none is, because the
      // ladder took the bars away two rungs earlier.
      it("narrows to the tightest reading alone at percent-only, with no bar", () => {
        renderSegment({
          segment: twoLimitSegment(),
          detail: "percent-only",
          showBar: true,
        });

        expect(screen.queryAllByTestId("status-bar-provider-mini-bar")).toEqual(
          [],
        );
        expect(
          screen.queryByTestId("status-bar-window-codex:primary"),
        ).toBeNull();
        expect(
          screen.getByTestId("status-bar-window-codex:secondary").textContent,
        ).toBe("92%");
      });

      // The bars are gauges, not readings: the segment's accessible content is
      // the provider icon's tooltip and the percentages, and adding one bar
      // per limit must not add anything a screen reader has to walk past.
      it("keeps every bar out of the accessible tree", () => {
        renderSegment({
          segment: twoLimitSegment(),
          detail: "full",
          showBar: true,
        });

        for (const bar of screen.getAllByTestId(
          "status-bar-provider-mini-bar",
        )) {
          expect(bar.getAttribute("aria-hidden")).toBe("true");
        }
      });
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

    it("degraded renders the warning glyph and leaves the reading undimmed", () => {
      const segment = segmentFixture({
        state: "degraded",
        reason: "usage_fetch_failed",
        windows: [windowFixture({ windowKey: "codex:primary" })],
      });
      renderSegment({ segment });

      // Not on the segment: it composites the percentage, whose severity shade
      // was chosen to clear 4.5:1 and has no contrast left to spend.
      const outer = screen.getByTestId("status-bar-provider-segment-codex");
      expect(outer.className).not.toContain("opacity-60");
      const percent = screen.getByTestId(
        "status-bar-window-percent-codex:primary",
      );
      for (
        let node: HTMLElement | null = percent;
        node !== null;
        node = node.parentElement
      ) {
        expect(node.className).not.toContain("opacity-60");
      }
      const glyph = screen.getByTestId("status-bar-provider-degraded");
      expect(glyph).not.toBeNull();
      // The same amber a running_low percentage prints - the two sit inches
      // apart on this row, and a shade of difference between them would read
      // as a rendering fault rather than as two distinct ideas. `className`
      // on an SVG element is an `SVGAnimatedString`, not a plain string, so
      // the class list has to be read off the attribute instead.
      const glyphClass = glyph.getAttribute("class") ?? "";
      for (const severityClass of RUNNING_LOW_TEXT_CLASS_NAME.split(" ")) {
        expect(glyphClass).toContain(severityClass);
      }
    });
  });

  // The collapse ladder's own rungs: each one takes away exactly one thing
  // from the reading, down to nothing at all. `resetsAt` sits comfortably
  // inside the hour band `formatResetCountdown` renders as `Xh Ym`, far
  // enough from any minute boundary that the render itself cannot flip the
  // string mid-assertion - and re-sampled per case (`resetsAtIn`), so the
  // cushion is not spent on the suite's own runtime before the case starts.
  describe("the collapse ladder", () => {
    let resetsAt = 0;
    beforeEach(() => {
      resetsAt = resetsAtIn(4, 15);
    });

    function stableWindow(): StatusBarRateLimitWindow {
      return windowFixture({
        windowKey: "codex:primary",
        label: "5h",
        labelIsDuration: true,
        usedPercent: 57,
        resetsAt,
      });
    }

    it.each<{
      readonly detail: StatusBarUsageDetail;
      readonly text: string | null;
      readonly bar: boolean;
    }>([
      { detail: "full", text: "57% used 4h 15m", bar: true },
      { detail: "no-mode-word", text: "57% 4h 15m", bar: true },
      { detail: "no-bars", text: "57% 4h 15m", bar: false },
      { detail: "no-timers", text: "57% 5h", bar: false },
      { detail: "percent-only", text: "57%", bar: false },
      { detail: "icon-only", text: null, bar: false },
    ])(
      "renders '$text' at $detail, with its own bar presence",
      ({ detail, text, bar }) => {
        const window = stableWindow();
        const segment = segmentFixture({ windows: [window], tightest: window });
        renderSegment({ segment, detail, showTimer: true });

        if (text === null) {
          expect(
            screen.queryByTestId("status-bar-window-codex:primary"),
          ).toBeNull();
        } else {
          expect(
            screen.getByTestId("status-bar-window-codex:primary").textContent,
          ).toBe(text);
        }
        expect(
          screen.queryByTestId("status-bar-provider-mini-bar") !== null,
        ).toBe(bar);
      },
    );

    const PERCENT_BEARING_RUNGS: ReadonlyArray<StatusBarUsageDetail> = [
      "full",
      "no-mode-word",
      "no-bars",
      "no-timers",
      "percent-only",
    ];
    const SEVERITIES: ReadonlyArray<RateLimitWindowSeverity> = [
      "healthy",
      "running_low",
      "limited",
    ];

    it.each(
      PERCENT_BEARING_RUNGS.flatMap((detail) =>
        SEVERITIES.map((severity) => ({ detail, severity })),
      ),
    )(
      "carries the $severity severity class on the percentage at $detail",
      ({ detail, severity }) => {
        const window = windowFixture({
          windowKey: "codex:primary",
          usedPercent: 57,
          severity,
        });
        const segment = segmentFixture({ windows: [window], tightest: window });
        renderSegment({ segment, detail });

        const percentSpan = screen.getByTestId(
          "status-bar-window-percent-codex:primary",
        );
        expect(percentSpan.className).toBe(
          rateLimitWindowSeverityTextClassName(severity),
        );
      },
    );

    it("icon-only never renders a percentage span, for any severity", () => {
      const window = windowFixture({
        windowKey: "codex:primary",
        usedPercent: 57,
        severity: "limited",
      });
      const segment = segmentFixture({ windows: [window], tightest: window });
      renderSegment({ segment, detail: "icon-only" });

      expect(
        screen.queryByTestId("status-bar-window-percent-codex:primary"),
      ).toBeNull();
    });

    it("showModeWord: false makes no-mode-word a no-op level, rendering identically to full", () => {
      const window = stableWindow();
      const segment = segmentFixture({ windows: [window], tightest: window });

      renderSegment({
        segment,
        detail: "full",
        showTimer: true,
        showModeWord: false,
      });
      const fullText = screen.getByTestId(
        "status-bar-window-codex:primary",
      ).textContent;
      cleanup();

      renderSegment({
        segment,
        detail: "no-mode-word",
        showTimer: true,
        showModeWord: false,
      });
      const noModeWordText = screen.getByTestId(
        "status-bar-window-codex:primary",
      ).textContent;

      expect(noModeWordText).toBe(fullText);
      expect(noModeWordText).toBe("57% 4h 15m");
    });

    it("showBar: false makes no-bars a no-op step down from no-mode-word", () => {
      // no-bars only additionally removes the bar beyond no-mode-word - both
      // already have the mode word off by rung, so with the bar preference
      // already off, stepping onto no-bars changes nothing on screen.
      const window = stableWindow();
      const segment = segmentFixture({ windows: [window], tightest: window });

      renderSegment({
        segment,
        detail: "no-mode-word",
        showTimer: true,
        showBar: false,
      });
      const noModeWordText = screen.getByTestId(
        "status-bar-window-codex:primary",
      ).textContent;
      const noModeWordHasBar = screen.queryByTestId(
        "status-bar-provider-mini-bar",
      );
      cleanup();

      renderSegment({
        segment,
        detail: "no-bars",
        showTimer: true,
        showBar: false,
      });
      const noBarsText = screen.getByTestId(
        "status-bar-window-codex:primary",
      ).textContent;
      const noBarsHasBar = screen.queryByTestId("status-bar-provider-mini-bar");

      expect(noBarsText).toBe(noModeWordText);
      expect(noBarsText).toBe("57% 4h 15m");
      expect(noModeWordHasBar).toBeNull();
      expect(noBarsHasBar).toBeNull();
    });

    it("showTimer: false makes no-timers a no-op step down from no-bars", () => {
      // no-timers only additionally removes the countdown beyond no-bars -
      // with the timer preference already off, both already fall back to the
      // static label, so stepping onto no-timers changes nothing on screen.
      const window = stableWindow();
      const segment = segmentFixture({ windows: [window], tightest: window });

      renderSegment({
        segment,
        detail: "no-bars",
        showTimer: false,
      });
      const noBarsText = screen.getByTestId(
        "status-bar-window-codex:primary",
      ).textContent;
      cleanup();

      renderSegment({
        segment,
        detail: "no-timers",
        showTimer: false,
      });
      const noTimersText = screen.getByTestId(
        "status-bar-window-codex:primary",
      ).textContent;

      expect(noTimersText).toBe(noBarsText);
      expect(noTimersText).toBe("57% 5h");
    });
  });

  describe("selected limits", () => {
    function twoWindowSegment(
      shown: "both" | "tightest",
    ): StatusBarProviderSegmentModel {
      const primary = windowFixture({
        windowKey: "codex:primary",
        usedPercent: 40,
      });
      const secondary = windowFixture({
        windowKey: "codex:secondary",
        usedPercent: 90,
      });
      return segmentFixture({
        windows: [primary, secondary],
        shown: shown === "both" ? [primary, secondary] : [secondary],
        tightest: secondary,
      });
    }

    it("renders every window the selection resolved to", () => {
      renderSegment({ segment: twoWindowSegment("both"), detail: "full" });

      expect(
        screen.getByTestId("status-bar-window-codex:primary"),
      ).not.toBeNull();
      expect(
        screen.getByTestId("status-bar-window-codex:secondary"),
      ).not.toBeNull();
    });

    it("renders only the tightest when that is all the selection resolved to", () => {
      renderSegment({ segment: twoWindowSegment("tightest"), detail: "full" });

      expect(
        screen.queryByTestId("status-bar-window-codex:primary"),
      ).toBeNull();
      expect(
        screen.getByTestId("status-bar-window-codex:secondary"),
      ).not.toBeNull();
    });

    it("stays on the tightest window however many are selected, once the rung is percent-only", () => {
      // Several bare percentages under one icon would say which limits exist
      // without saying which is which, so the rung overrides the selection.
      renderSegment({
        segment: twoWindowSegment("both"),
        detail: "percent-only",
      });

      expect(
        screen.queryByTestId("status-bar-window-codex:primary"),
      ).toBeNull();
      expect(
        screen.getByTestId("status-bar-window-codex:secondary"),
      ).not.toBeNull();
    });
  });
});
