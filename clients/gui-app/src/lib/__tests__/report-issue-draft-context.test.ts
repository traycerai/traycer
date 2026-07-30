import { afterEach, describe, expect, it } from "vitest";
import {
  createReportIssueDraftContext,
  isReportIssueDraftContext,
} from "@/lib/report-issue-draft-context";
import { captureReportIssueError } from "@/lib/report-issue-error-capture";
import { __resetSupportContextRegistryForTests } from "@/lib/support-context-registry";

afterEach(() => {
  __resetSupportContextRegistryForTests();
});

const NO_CAPTURE_INPUT = {
  title: "x",
  message: null,
  code: null,
  source: null,
  capture: null,
};

describe("createReportIssueDraftContext", () => {
  it("never leaks real error text into the public prefill", () => {
    const secret = "sk-secret-123 at /Users/alice/project/private.txt";
    const capture = captureReportIssueError({
      error: new Error(secret),
      componentStack: `in Foo\n    ${secret}`,
      errorCode: null,
      sourceAction: "App crash",
    });
    const draft = createReportIssueDraftContext({
      title: "Something went wrong",
      message: "The app hit an unexpected error.",
      code: null,
      source: "Traycer app",
      capture,
    });

    const serializedPublicPrefill = JSON.stringify(draft.publicPrefill);
    expect(serializedPublicPrefill).not.toContain("sk-secret-123");
    expect(serializedPublicPrefill).not.toContain("private.txt");
    expect(draft.publicPrefill).toEqual({
      title: "Something went wrong",
      message: "The app hit an unexpected error.",
      code: null,
      source: "Traycer app",
    });

    // The real text DOES reach privateDiagnostics - that is the point of the
    // public/private split, not an oversight.
    expect(draft.privateDiagnostics.cause?.message).toBe(secret);
  });

  it("is discriminable from a plain ReportIssueContext", () => {
    const draft = createReportIssueDraftContext(NO_CAPTURE_INPUT);

    expect(isReportIssueDraftContext(draft)).toBe(true);
    expect(
      isReportIssueDraftContext({
        title: "x",
        message: null,
        code: null,
        source: null,
      }),
    ).toBe(false);
  });

  it("computes a fingerprint only when a capture exists", () => {
    const capture = captureReportIssueError({
      error: new Error("boom"),
      componentStack: null,
      errorCode: "E_CODE",
      sourceAction: "op",
    });
    const withCapture = createReportIssueDraftContext({
      ...NO_CAPTURE_INPUT,
      capture,
    });
    const withoutCapture = createReportIssueDraftContext(NO_CAPTURE_INPUT);

    expect(withCapture.privateDiagnostics.fingerprint).toMatch(/^fp:v1:/);
    expect(withoutCapture.privateDiagnostics.fingerprint).toBeNull();
  });

  it("reuses the capture's correlation id / fingerprint / stack family rather than re-minting them", () => {
    const capture = captureReportIssueError({
      error: new Error("boom"),
      componentStack: null,
      errorCode: "E_CODE",
      sourceAction: "op",
    });
    const draft = createReportIssueDraftContext({
      ...NO_CAPTURE_INPUT,
      capture,
    });

    expect(draft.privateDiagnostics.correlationId).toBe(capture.correlationId);
    expect(draft.privateDiagnostics.fingerprint).toBe(capture.fingerprint);
    expect(draft.privateDiagnostics.stackFamily).toBe(capture.stackFamily);
  });

  it("mints a fresh correlation id per no-capture draft (nothing to correlate with)", () => {
    const a = createReportIssueDraftContext(NO_CAPTURE_INPUT);
    const b = createReportIssueDraftContext(NO_CAPTURE_INPUT);

    expect(a.privateDiagnostics.correlationId).not.toBe(
      b.privateDiagnostics.correlationId,
    );
  });

  it("carries the current support-context registry snapshot", () => {
    const draft = createReportIssueDraftContext(NO_CAPTURE_INPUT);

    expect(draft.privateDiagnostics.registry.hostId).toEqual({
      status: "unavailable",
    });
  });
});
