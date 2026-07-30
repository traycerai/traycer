import { afterEach, describe, expect, it } from "vitest";
import {
  createReportIssueDraftContext,
  isReportIssueDraftContext,
} from "@/lib/report-issue-draft-context";
import { __resetSupportContextRegistryForTests } from "@/lib/support-context-registry";

afterEach(() => {
  __resetSupportContextRegistryForTests();
});

const NO_CAUSE_INPUT = {
  title: "x",
  message: null,
  code: null,
  source: null,
  cause: null,
};

describe("createReportIssueDraftContext", () => {
  it("never leaks real error text into the public prefill", () => {
    const secret = "sk-secret-123 at /Users/alice/project/private.txt";
    const draft = createReportIssueDraftContext({
      title: "Something went wrong",
      message: "The app hit an unexpected error.",
      code: null,
      source: "Traycer app",
      cause: {
        type: "TypeError",
        message: secret,
        stack: `Error: ${secret}\n    at foo (/Users/alice/project/index.ts:1:1)`,
        componentStack: `in Foo\n    ${secret}`,
        errorCode: null,
        sourceAction: "App crash",
        timestamp: 0,
      },
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
    const draft = createReportIssueDraftContext(NO_CAUSE_INPUT);

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

  it("computes a fingerprint only when a cause exists", () => {
    const withCause = createReportIssueDraftContext({
      ...NO_CAUSE_INPUT,
      cause: {
        type: "Error",
        message: "boom",
        stack: null,
        componentStack: null,
        errorCode: "E_CODE",
        sourceAction: "op",
        timestamp: 0,
      },
    });
    const withoutCause = createReportIssueDraftContext(NO_CAUSE_INPUT);

    expect(withCause.privateDiagnostics.fingerprint).toMatch(/^fp:v1:/);
    expect(withoutCause.privateDiagnostics.fingerprint).toBeNull();
  });

  it("mints a fresh correlation id per draft", () => {
    const a = createReportIssueDraftContext(NO_CAUSE_INPUT);
    const b = createReportIssueDraftContext(NO_CAUSE_INPUT);

    expect(a.privateDiagnostics.correlationId).not.toBe(
      b.privateDiagnostics.correlationId,
    );
  });

  it("carries the current support-context registry snapshot", () => {
    const draft = createReportIssueDraftContext(NO_CAUSE_INPUT);

    expect(draft.privateDiagnostics.registry.hostId).toEqual({
      status: "unavailable",
    });
  });
});
