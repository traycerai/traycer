import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { getSupportContextSnapshot } from "@/lib/support-context-registry";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

/**
 * Every in-app Report button files under one entry point, `direct_ui`. That was
 * fine while none of them could be turned off. `18aef324` gates the app-update
 * toast while a window narration owns the frame, and from that moment a flat
 * `direct_ui` series cannot distinguish "people used the other button" from
 * "people stopped reporting" - the gated surface and its neighbour are the same
 * number.
 *
 * `surface` is the split. These arms are about the ANALYTICS payload only; the
 * report contents themselves were already distinguishable (`host-failure-report`
 * gives each failure family its own title/code), which is exactly why the
 * analytics gap was easy to miss.
 */
const APP_UPDATE = createReportIssueContext({
  title: "Could not install the update",
  message: "The update could not be installed.",
  code: "APP_UPDATE_FAILED",
  source: "App update",
});

const HOST_STARTUP = createReportIssueContext({
  title: "Could not start Traycer Host",
  message: "Traycer Host could not start.",
  code: "HOST_PROVISIONING_FAILED",
  source: "Host startup",
});

/**
 * Takes the raw `mock.calls` rather than the spy: naming the spy's type means
 * `ReturnType<typeof vi.spyOn>`, which this package's ESLint bans outright, and
 * the alternative - restating vitest's generic spy signature by hand - is a
 * private shape that would drift on every vitest bump.
 */
function trackedReportOpens(
  calls: readonly (readonly unknown[])[],
): readonly unknown[] {
  return calls
    .filter((call) => call[0] === AnalyticsEvent.ReportIssueOpened)
    .map((call) => call[1]);
}

describe("ReportIssueAction analytics", () => {
  beforeEach(() => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("names the surface it was rendered on, alongside the entry point", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    render(
      <ReportIssueAction
        context={APP_UPDATE}
        presentation="text"
        className={undefined}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /report issue/i }),
    );

    expect(trackedReportOpens(track.mock.calls)).toEqual([
      { source: "direct_ui", surface: "App update" },
    ]);
  });

  /**
   * THE ARM THAT MAKES THE SPLIT MEAN ANYTHING.
   *
   * Asserting one surface in isolation passes just as happily if `surface` were
   * a constant - which is the defect being fixed, wearing a new field name. The
   * claim is a CARDINALITY: two buttons, one entry point, two distinguishable
   * values. Only rendering both and comparing can say that.
   */
  it("distinguishes two surfaces that share the direct_ui entry point", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");

    render(
      <ReportIssueAction
        context={APP_UPDATE}
        presentation="text"
        className={undefined}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /report issue/i }),
    );
    cleanup();

    render(
      <ReportIssueAction
        context={HOST_STARTUP}
        presentation="text"
        className={undefined}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /report issue/i }),
    );

    const opens = trackedReportOpens(track.mock.calls);
    expect(opens).toEqual([
      { source: "direct_ui", surface: "App update" },
      { source: "direct_ui", surface: "Host startup" },
    ]);
    // Said as its own assertion so a failure reads as "the two surfaces
    // collapsed into one" rather than as a payload mismatch.
    expect(new Set(opens.map((open) => JSON.stringify(open))).size).toBe(2);
  });

  it("reads the public prefill's surface when the context is a lazy draft", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    render(
      <ReportIssueAction
        context={() => ({
          publicPrefill: HOST_STARTUP,
          privateDiagnostics: {
            cause: null,
            // The real producer, not a hand-rolled literal. A `{}` here type-
            // checks nowhere but RUNS fine - vitest transpiles without checking -
            // so the suite went 3/3 green while `tsc` was rejecting the file over
            // twelve missing fields.
            registry: getSupportContextSnapshot(),
            fingerprint: null,
            stackFamily: null,
            correlationId: "test-correlation",
          },
        })}
        presentation="text"
        className={undefined}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /report issue/i }),
    );

    expect(trackedReportOpens(track.mock.calls)).toEqual([
      { source: "direct_ui", surface: "Host startup" },
    ]);
  });
});
