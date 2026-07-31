import { describe, expect, it } from "vitest";
import {
  AnalyticsEvent,
  reportIssuePrivateSubmitPropertiesFromResult,
  sanitizeAnalyticsProperties,
} from "@/lib/analytics";

describe("reportIssuePrivateSubmitPropertiesFromResult", () => {
  it("maps delivered to confirmed", () => {
    expect(
      reportIssuePrivateSubmitPropertiesFromResult({ status: "delivered" }, 0),
    ).toEqual({ outcome: "confirmed", blocker: null, attachment_count: 0 });
  });

  it("maps unconfirmed to its own outcome, never confirmed or failed", () => {
    expect(
      reportIssuePrivateSubmitPropertiesFromResult(
        { status: "unconfirmed" },
        0,
      ),
    ).toEqual({ outcome: "unconfirmed", blocker: null, attachment_count: 0 });
  });

  it("maps unavailable to unavailable", () => {
    expect(
      reportIssuePrivateSubmitPropertiesFromResult(
        { status: "unavailable" },
        0,
      ),
    ).toEqual({ outcome: "unavailable", blocker: null, attachment_count: 0 });
  });

  it("maps a structured failed result to failed with an unknown blocker", () => {
    expect(
      reportIssuePrivateSubmitPropertiesFromResult({ status: "failed" }, 0),
    ).toEqual({ outcome: "failed", blocker: "unknown", attachment_count: 0 });
  });

  it("carries the attachment count through on every outcome", () => {
    expect(
      reportIssuePrivateSubmitPropertiesFromResult({ status: "delivered" }, 2),
    ).toEqual({ outcome: "confirmed", blocker: null, attachment_count: 2 });
  });

  it("accepts every mapped outcome for private submit sanitization", () => {
    for (const status of [
      "delivered",
      "unconfirmed",
      "unavailable",
      "failed",
    ] as const) {
      const properties = reportIssuePrivateSubmitPropertiesFromResult(
        { status },
        1,
      );
      expect(
        sanitizeAnalyticsProperties(
          AnalyticsEvent.ReportIssuePrivateSubmit,
          properties,
        ),
      ).toEqual(properties);
    }
  });

  it("rejects the old hard-coded succeeded outcome for private submit", () => {
    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.ReportIssuePrivateSubmit, {
        outcome: "succeeded",
        blocker: null,
        attachment_count: 0,
      }),
    ).toBeNull();
  });

  it("rejects unconfirmed paired with a non-null blocker", () => {
    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.ReportIssuePrivateSubmit, {
        outcome: "unconfirmed",
        blocker: "unknown",
        attachment_count: 0,
      }),
    ).toBeNull();
  });

  it("rejects failed paired with a null blocker", () => {
    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.ReportIssuePrivateSubmit, {
        outcome: "failed",
        blocker: null,
        attachment_count: 0,
      }),
    ).toBeNull();
  });

  it("accepts a property-less public open attempted event", () => {
    expect(
      sanitizeAnalyticsProperties(
        AnalyticsEvent.ReportIssuePublicOpenAttempted,
        null,
      ),
    ).toEqual({});
  });
});
