import { describe, expect, it } from "vitest";

describe("reportIssuePrivateSubmitPropertiesFromReportId", () => {
  it("maps a non-null reportId to confirmed", async () => {
    const { reportIssuePrivateSubmitPropertiesFromReportId } =
      await import("@/lib/analytics");

    expect(
      reportIssuePrivateSubmitPropertiesFromReportId("rpt_abc123"),
    ).toEqual({
      outcome: "confirmed",
      blocker: null,
    });
  });

  it("maps a null reportId to unavailable, never succeeded", async () => {
    const { reportIssuePrivateSubmitPropertiesFromReportId } =
      await import("@/lib/analytics");

    expect(reportIssuePrivateSubmitPropertiesFromReportId(null)).toEqual({
      outcome: "unavailable",
      blocker: null,
    });
  });

  it("accepts the mapped properties for private submit sanitization", async () => {
    const {
      AnalyticsEvent,
      reportIssuePrivateSubmitPropertiesFromReportId,
      sanitizeAnalyticsProperties,
    } = await import("@/lib/analytics");

    expect(
      sanitizeAnalyticsProperties(
        AnalyticsEvent.ReportIssuePrivateSubmit,
        reportIssuePrivateSubmitPropertiesFromReportId("rpt_abc123"),
      ),
    ).toEqual({ outcome: "confirmed", blocker: null });
    expect(
      sanitizeAnalyticsProperties(
        AnalyticsEvent.ReportIssuePrivateSubmit,
        reportIssuePrivateSubmitPropertiesFromReportId(null),
      ),
    ).toEqual({ outcome: "unavailable", blocker: null });
  });

  it("rejects the old hard-coded succeeded outcome for private submit", async () => {
    const { AnalyticsEvent, sanitizeAnalyticsProperties } =
      await import("@/lib/analytics");

    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.ReportIssuePrivateSubmit, {
        outcome: "succeeded",
        blocker: null,
      }),
    ).toBeNull();
  });

  it("accepts a property-less public open attempted event", async () => {
    const { AnalyticsEvent, sanitizeAnalyticsProperties } =
      await import("@/lib/analytics");

    expect(
      sanitizeAnalyticsProperties(
        AnalyticsEvent.ReportIssuePublicOpenAttempted,
        null,
      ),
    ).toEqual({});
  });
});
