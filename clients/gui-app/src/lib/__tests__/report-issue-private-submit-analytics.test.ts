import { describe, expect, it } from "vitest";

describe("reportIssuePrivateSubmitPropertiesFromResult", () => {
  it("maps delivered to confirmed", async () => {
    const { reportIssuePrivateSubmitPropertiesFromResult } =
      await import("@/lib/analytics");

    expect(
      reportIssuePrivateSubmitPropertiesFromResult({ status: "delivered" }),
    ).toEqual({ outcome: "confirmed", blocker: null });
  });

  it("maps unconfirmed to its own outcome, never confirmed or failed", async () => {
    const { reportIssuePrivateSubmitPropertiesFromResult } =
      await import("@/lib/analytics");

    expect(
      reportIssuePrivateSubmitPropertiesFromResult({ status: "unconfirmed" }),
    ).toEqual({ outcome: "unconfirmed", blocker: null });
  });

  it("maps unavailable to unavailable", async () => {
    const { reportIssuePrivateSubmitPropertiesFromResult } =
      await import("@/lib/analytics");

    expect(
      reportIssuePrivateSubmitPropertiesFromResult({ status: "unavailable" }),
    ).toEqual({ outcome: "unavailable", blocker: null });
  });

  it("maps a structured failed result to failed with an unknown blocker", async () => {
    const { reportIssuePrivateSubmitPropertiesFromResult } =
      await import("@/lib/analytics");

    expect(
      reportIssuePrivateSubmitPropertiesFromResult({ status: "failed" }),
    ).toEqual({ outcome: "failed", blocker: "unknown" });
  });

  it("accepts every mapped outcome for private submit sanitization", async () => {
    const {
      AnalyticsEvent,
      reportIssuePrivateSubmitPropertiesFromResult,
      sanitizeAnalyticsProperties,
    } = await import("@/lib/analytics");

    for (const status of [
      "delivered",
      "unconfirmed",
      "unavailable",
      "failed",
    ] as const) {
      const properties = reportIssuePrivateSubmitPropertiesFromResult({
        status,
      });
      expect(
        sanitizeAnalyticsProperties(
          AnalyticsEvent.ReportIssuePrivateSubmit,
          properties,
        ),
      ).toEqual(properties);
    }
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

  it("rejects unconfirmed paired with a non-null blocker", async () => {
    const { AnalyticsEvent, sanitizeAnalyticsProperties } =
      await import("@/lib/analytics");

    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.ReportIssuePrivateSubmit, {
        outcome: "unconfirmed",
        blocker: "unknown",
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
