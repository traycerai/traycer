import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { getSupportContextSnapshot } from "@/lib/support-context-registry";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

/** `18aef324` gates the app-update toast while a window narration owns the frame, and from that moment a flat
 * `direct_ui` series cannot distinguish "people used the other button" from "people stopped reporting". */
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

/** Takes the raw `mock.calls` rather than the spy: naming the spy's type means `ReturnType<typeof vi.spyOn>`,
 * which this package's ESLint bans outright, and the alternative. */
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

  /** The claim is a cardinality: two buttons, one entry point, two distinguishable values. Only rendering both
   * and comparing can say that. */
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
            // The real producer, not a hand-rolled literal.
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
