import { afterEach, describe, expect, it } from "vitest";
import {
  createReportIssueDraftContext,
  isReportIssueDraftContext,
  serializeReportIssuePrivateDiagnostics,
} from "@/lib/report-issue-draft-context";
import { captureReportIssueError } from "@/lib/report-issue-error-capture";
import {
  __resetSupportContextRegistryForTests,
  knownField,
  setSupportEnvironmentSection,
  staleField,
} from "@/lib/support-context-registry";
import type { SupportEnvironmentSection } from "@/lib/support-environment-section";

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

const ENVIRONMENT_SECTION: SupportEnvironmentSection = {
  hostId: "host-1",
  principal: "team",
  reachability: "connected",
  bindingGeneration: 3,
  desiredRevision: 7,
  receivedRevision: 7,
  appliedRevision: 6,
  receiptAgeMs: 1200,
  items: [
    {
      kind: "variable",
      key: "DATABASE_URL",
      os: "all",
      status: "applied",
      code: "ok",
      args: { exitStatus: null, stage: null, durationMs: null, kind: null },
    },
  ],
  setupAttempts: null,
  policy: {
    source: "account",
    readState: "ready",
    teamState: null,
    teamPolicyVersion: null,
  },
  rotations: [
    {
      secretName: "STRIPE_KEY",
      state: "enforcing",
      producers: [
        {
          producer: "host",
          workerClass: null,
          hostId: "host-2",
          hostName: null,
          status: "missing",
          evidence: null,
        },
      ],
    },
  ],
  reachDenials: null,
  servedTask: null,
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

  describe("environment section", () => {
    it("is unavailable until a section has been written to the registry", () => {
      const draft = createReportIssueDraftContext(NO_CAPTURE_INPUT);

      expect(draft.privateDiagnostics.environment).toEqual({
        status: "unavailable",
      });
    });

    it("carries the registry's environment field, read when the report opens", () => {
      setSupportEnvironmentSection(knownField(ENVIRONMENT_SECTION));

      const draft = createReportIssueDraftContext(NO_CAPTURE_INPUT);

      expect(draft.privateDiagnostics.environment).toEqual({
        status: "known",
        value: ENVIRONMENT_SECTION,
      });
    });

    it("carries a stale section as stale, and an error-triggered report carries it too", () => {
      setSupportEnvironmentSection(staleField(ENVIRONMENT_SECTION));
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

      expect(draft.privateDiagnostics.environment).toEqual({
        status: "stale",
        value: ENVIRONMENT_SECTION,
      });
    });

    it("sees a section written after an earlier draft, not a copy taken at import", () => {
      const before = createReportIssueDraftContext(NO_CAPTURE_INPUT);
      setSupportEnvironmentSection(knownField(ENVIRONMENT_SECTION));
      const after = createReportIssueDraftContext(NO_CAPTURE_INPUT);

      expect(before.privateDiagnostics.environment.status).toBe("unavailable");
      expect(after.privateDiagnostics.environment.status).toBe("known");
    });

    it("is copied by the serializer, beside the other five keys", () => {
      setSupportEnvironmentSection(knownField(ENVIRONMENT_SECTION));
      const draft = createReportIssueDraftContext(NO_CAPTURE_INPUT);

      const serialized = serializeReportIssuePrivateDiagnostics(
        draft.privateDiagnostics,
      );

      expect(serialized.environment).toEqual({
        status: "known",
        value: ENVIRONMENT_SECTION,
      });
      expect(Object.keys(serialized).sort()).toEqual([
        "cause",
        "correlationId",
        "environment",
        "fingerprint",
        "registry",
        "stackFamily",
      ]);
    });
  });
});
