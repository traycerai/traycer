import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StatusBarProviderSegment } from "@/components/layout/status-bar/status-bar-provider-segment";
import type { StatusBarUsageDisplay } from "@/components/layout/status-bar/status-bar-usage-display";
import type {
  StatusBarProviderSegmentModel,
  StatusBarProviderSegmentState,
  StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import { RUNNING_LOW_TEXT_CLASS_NAME } from "@/lib/rate-limits/window-severity";
import type { RateLimitWindowSeverity } from "@/lib/rate-limits/window-severity";

/**
 * A reset instant `days:hours` out, sampled when the TEST runs. A function
 * rather than a `describe`-scoped constant: a `describe` body runs at
 * COLLECTION, so a constant there is minutes old by the last case. The extra
 * minutes keep the countdown off a day boundary for the render itself.
 */
function resetsAtIn(days: number, hours: number): number {
  return Date.now() + ((days * 24 + hours) * 60 + 5) * 60_000;
}

function windowFixture(overrides: {
  readonly windowKey: string;
  readonly label?: string;
  readonly labelIsDuration?: boolean;
  readonly usedPercent?: number;
  readonly resetsAt?: number | null;
  readonly severity?: RateLimitWindowSeverity;
}): StatusBarRateLimitWindow {
  return {
    windowKey: overrides.windowKey,
    label: overrides.label ?? "5h",
    labelIsDuration: overrides.labelIsDuration ?? true,
    kind: "session",
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
  readonly shown?: ReadonlyArray<StatusBarRateLimitWindow>;
  readonly profileId?: string | null;
  readonly account?: StatusBarProviderSegmentModel["account"];
}): StatusBarProviderSegmentModel {
  const windows = overrides.windows ?? [];
  const tightest = windows.length > 0 ? windows[0] : null;
  return {
    providerId: overrides.providerId ?? "codex",
    profileId: overrides.profileId ?? null,
    account: overrides.account ?? null,
    hidden: false,
    state: overrides.state ?? "live",
    reason: overrides.reason ?? null,
    windows,
    shown: overrides.shown ?? windows,
    tightest,
  };
}

function singleWindowSegment(
  severity: RateLimitWindowSeverity,
  usedPercent: number,
  resetsAt: number | null,
): StatusBarProviderSegmentModel {
  return segmentFixture({
    windows: [
      windowFixture({
        windowKey: "codex:primary",
        severity,
        usedPercent,
        resetsAt,
      }),
    ],
  });
}

function renderSegment(
  segment: StatusBarProviderSegmentModel,
  display: StatusBarUsageDisplay,
) {
  return render(
    <TooltipProvider delayDuration={0}>
      <StatusBarProviderSegment segment={segment} display={display} />
    </TooltipProvider>,
  );
}

const DISPLAY: StatusBarUsageDisplay = { percentMode: "used", showTimer: true };

const WORK = { profileId: "work", accentColor: "#ff0000", label: "Work" };

function text(testId: string): string {
  return screen.getByTestId(testId).textContent;
}

afterEach(() => {
  cleanup();
});

describe("<StatusBarProviderSegment /> severity forms", () => {
  let resetsAt = 0;
  beforeEach(() => {
    resetsAt = resetsAtIn(5, 1);
  });

  it("draws a healthy profile calm: a 16px bar and no text at all", () => {
    renderSegment(singleWindowSegment("healthy", 41, resetsAt), DISPLAY);

    const segment = screen.getByTestId("status-bar-provider-segment-codex");
    expect(segment.dataset.form).toBe("calm");
    expect(
      screen.getByTestId("status-bar-provider-mini-bar").className,
    ).toContain("w-4");
    expect(screen.queryByTestId("status-bar-window-codex:primary")).toBeNull();
    expect(screen.queryByTestId("status-bar-provider-name")).toBeNull();
  });

  it("gives a profile its numbers in its tooltip", async () => {
    renderSegment(
      segmentFixture({
        account: WORK,
        windows: [
          windowFixture({
            windowKey: "codex:primary",
            usedPercent: 41,
            resetsAt,
          }),
        ],
      }),
      DISPLAY,
    );

    fireEvent.focus(screen.getByTestId("status-bar-provider-tooltip-target"));

    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "Work · 41% used · resets in 5d",
    );
  });

  it("expands a running_low profile: name, 32px bar, percent and reset time", () => {
    renderSegment(
      segmentFixture({
        account: WORK,
        windows: [
          windowFixture({
            windowKey: "codex:primary",
            severity: "running_low",
            usedPercent: 86,
            resetsAt,
          }),
        ],
      }),
      DISPLAY,
    );

    const segment = screen.getByTestId("status-bar-provider-segment-codex");
    expect(segment.dataset.form).toBe("expanded");
    expect(text("status-bar-provider-account")).toBe("Work");
    expect(
      screen.getByTestId("status-bar-provider-mini-bar").className,
    ).toContain("w-8");
    expect(text("status-bar-window-codex:primary")).toBe("86%5d");
    expect(
      screen.getByTestId("status-bar-window-percent-codex:primary").className,
    ).toContain(RUNNING_LOW_TEXT_CLASS_NAME);
  });

  it("names an expanded profile by its provider when it has no account", () => {
    renderSegment(singleWindowSegment("running_low", 86, resetsAt), DISPLAY);

    expect(text("status-bar-provider-name")).toBe("Codex");
  });

  it("expands a limited profile with 'Limit' for the percent and 'resets Xd'", () => {
    renderSegment(singleWindowSegment("limited", 100, resetsAt), DISPLAY);

    expect(text("status-bar-window-percent-codex:primary")).toBe("Limit");
    expect(
      screen.getByTestId("status-bar-window-percent-codex:primary").className,
    ).toContain("text-destructive");
    expect(text("status-bar-window-codex:primary")).toBe("Limitresets 5d");
    expect(
      screen.getByTestId("status-bar-provider-mini-bar-fill").style.width,
    ).toBe("100%");
  });

  it("reads the worst window's severity, so a profile is never calmer than one of its limits", () => {
    const calmWindow = windowFixture({
      windowKey: "codex:primary",
      usedPercent: 10,
    });
    const lowWindow = windowFixture({
      windowKey: "codex:secondary",
      label: "wk",
      severity: "running_low",
      usedPercent: 88,
    });
    renderSegment(
      segmentFixture({
        windows: [calmWindow, lowWindow],
        shown: [calmWindow, lowWindow],
      }),
      DISPLAY,
    );

    expect(
      screen.getByTestId("status-bar-provider-segment-codex").dataset.form,
    ).toBe("expanded");
    // Each window still prints its own tier inside the expanded profile.
    expect(text("status-bar-window-percent-codex:primary")).toBe("10%");
    expect(text("status-bar-window-percent-codex:secondary")).toBe("88%");
  });
});

describe("<StatusBarProviderSegment /> in place", () => {
  it("keeps every profile where it was when one expands", () => {
    const profiles = ["a", "b", "c"];
    function row(severityOfB: RateLimitWindowSeverity) {
      return (
        <TooltipProvider delayDuration={0}>
          {profiles.map((profileId) => (
            <StatusBarProviderSegment
              key={profileId}
              display={DISPLAY}
              segment={segmentFixture({
                profileId,
                account: { profileId, accentColor: "#00f", label: profileId },
                windows: [
                  windowFixture({
                    windowKey: `codex:${profileId}`,
                    severity: profileId === "b" ? severityOfB : "healthy",
                  }),
                ],
              })}
            />
          ))}
        </TooltipProvider>
      );
    }
    const order = () =>
      [...document.querySelectorAll("[data-profile-id]")].map((node) =>
        node.getAttribute("data-profile-id"),
      );

    const { rerender } = render(row("healthy"));
    expect(order()).toEqual(["a", "b", "c"]);

    rerender(row("limited"));

    expect(order()).toEqual(["a", "b", "c"]);
    expect(
      [...document.querySelectorAll("[data-profile-id]")].map(
        (node) => (node as HTMLElement).dataset.form,
      ),
    ).toEqual(["calm", "expanded", "calm"]);
  });
});

describe("<StatusBarProviderSegment /> settings", () => {
  it("prints the remaining percent when Percent shows is Remaining", () => {
    renderSegment(singleWindowSegment("running_low", 86, null), {
      percentMode: "remaining",
      showTimer: false,
    });

    expect(text("status-bar-window-percent-codex:primary")).toBe("14%");
  });

  it("omits the reset time from expanded profiles when Reset time is off", () => {
    const resetsAt = resetsAtIn(5, 1);
    renderSegment(singleWindowSegment("running_low", 86, resetsAt), {
      percentMode: "used",
      showTimer: false,
    });

    expect(text("status-bar-window-codex:primary")).toBe("86%");
    cleanup();

    renderSegment(singleWindowSegment("limited", 100, resetsAt), {
      percentMode: "used",
      showTimer: false,
    });
    expect(text("status-bar-window-codex:primary")).toBe("Limit");
  });

  it("does not change a calm profile when Reset time flips", () => {
    renderSegment(singleWindowSegment("healthy", 12, resetsAtIn(5, 1)), {
      percentMode: "used",
      showTimer: false,
    });

    expect(
      screen.getByTestId("status-bar-provider-segment-codex").dataset.form,
    ).toBe("calm");
    expect(screen.queryByTestId("status-bar-window-codex:primary")).toBeNull();
  });

  it("keeps the window's name beside two limits so two bars can be told apart", () => {
    const primary = windowFixture({
      windowKey: "cursor:cursorModels",
      label: "Cursor models",
      labelIsDuration: false,
      severity: "running_low",
      resetsAt: resetsAtIn(2, 1),
    });
    const other = windowFixture({
      windowKey: "cursor:otherModels",
      label: "Other models",
      labelIsDuration: false,
      severity: "running_low",
      resetsAt: resetsAtIn(2, 1),
    });
    renderSegment(
      segmentFixture({ windows: [primary, other], shown: [primary, other] }),
      DISPLAY,
    );

    expect(text("status-bar-window-cursor:cursorModels")).toContain(
      "Cursor models",
    );
    expect(text("status-bar-window-cursor:otherModels")).toContain(
      "Other models",
    );
  });

  it("draws one bar per shown limit, in order, each filled from its own window", () => {
    const primary = windowFixture({
      windowKey: "codex:primary",
      usedPercent: 30,
    });
    const secondary = windowFixture({
      windowKey: "codex:secondary",
      label: "wk",
      usedPercent: 92,
      severity: "limited",
    });
    renderSegment(
      segmentFixture({
        windows: [primary, secondary],
        shown: [primary, secondary],
      }),
      DISPLAY,
    );

    expect(
      screen
        .getAllByTestId("status-bar-provider-mini-bar")
        .map((bar) => bar.getAttribute("data-window-key")),
    ).toEqual(["codex:primary", "codex:secondary"]);
    expect(
      screen
        .getAllByTestId("status-bar-provider-mini-bar-fill")
        .map((fill) => fill.style.width),
    ).toEqual(["30%", "92%"]);
  });

  it("clamps the percentage text to 0-100 in both modes", () => {
    renderSegment(singleWindowSegment("running_low", 104, null), {
      percentMode: "used",
      showTimer: false,
    });
    expect(text("status-bar-window-percent-codex:primary")).toBe("100%");
    cleanup();

    renderSegment(singleWindowSegment("running_low", 104, null), {
      percentMode: "remaining",
      showTimer: false,
    });
    expect(text("status-bar-window-percent-codex:primary")).toBe("0%");
  });
});

describe("<StatusBarProviderSegment /> states", () => {
  it("cold renders the neutral track at the calm width", () => {
    renderSegment(segmentFixture({ state: "cold" }), DISPLAY);

    expect(
      screen.getByTestId("status-bar-provider-cold-track").className,
    ).toContain("w-4");
    expect(screen.queryByTestId("status-bar-provider-reading")).toBeNull();
  });

  it("unavailable renders the dash", () => {
    renderSegment(
      segmentFixture({ state: "unavailable", reason: "cli_not_found" }),
      DISPLAY,
    );

    expect(
      screen.getByTestId("status-bar-provider-unavailable"),
    ).not.toBeNull();
  });

  it("degraded keeps the warning glyph and the last reading, undimmed", () => {
    renderSegment(
      segmentFixture({
        state: "degraded",
        reason: "usage_fetch_failed",
        windows: [windowFixture({ windowKey: "codex:primary" })],
      }),
      DISPLAY,
    );

    expect(
      screen.getByTestId("status-bar-provider-segment-codex").className,
    ).not.toContain("opacity-60");
    expect(screen.getByTestId("status-bar-provider-degraded")).not.toBeNull();
    expect(screen.getByTestId("status-bar-provider-mini-bar")).not.toBeNull();
  });

  it("animates the reading in when a cold provider first reports, and not on first paint", () => {
    const live = segmentFixture({
      windows: [windowFixture({ windowKey: "codex:primary" })],
    });
    renderSegment(live, DISPLAY);
    expect(
      screen.getByTestId("status-bar-provider-reading").style.opacity,
    ).toBe("1");
    cleanup();

    const cold = renderSegment(segmentFixture({ state: "cold" }), DISPLAY);
    cold.rerender(
      <TooltipProvider delayDuration={0}>
        <StatusBarProviderSegment segment={live} display={DISPLAY} />
      </TooltipProvider>,
    );
    expect(screen.queryByTestId("status-bar-provider-cold-track")).toBeNull();
    expect(
      screen.getByTestId("status-bar-provider-reading").style.opacity,
    ).toBe("0");
  });
});

describe("<StatusBarProviderSegment /> account", () => {
  it("draws the accent dot beside the icon for a segment with an account mark", () => {
    renderSegment(
      segmentFixture({
        profileId: "work",
        account: WORK,
        windows: [windowFixture({ windowKey: "codex:primary" })],
      }),
      DISPLAY,
    );

    expect(
      screen.getByTestId("status-bar-provider-segment-codex").dataset.profileId,
    ).toBe("work");
    expect(screen.getByTestId("status-bar-provider-account-dot")).toBeTruthy();
  });

  it("draws no dot for a segment with no account mark", () => {
    renderSegment(
      segmentFixture({
        windows: [windowFixture({ windowKey: "codex:primary" })],
      }),
      DISPLAY,
    );

    expect(screen.queryByTestId("status-bar-provider-account-dot")).toBeNull();
  });
});
