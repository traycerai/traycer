import { describe, expect, it } from "vitest";
import {
  parseSupportReadFrozenLogTailInput,
  parseSupportSubmitReportRequest,
} from "../support-ipc";

const VALID_FORM = {
  draftId: 1,
  title: "Something broke",
  whatHappened: "It broke",
  stepsToReproduce: "1. Do the thing",
  expectedBehavior: "It should work",
  actualBehavior: "It did not",
};

const VALID_CAUSE = {
  type: "RangeError",
  message: "index out of bounds",
  stack: "at foo (bar.ts:1:1)",
  componentStack: null,
  errorCode: "E_BOUNDS",
  sourceAction: "chat.subscribe",
  timestamp: 1_700_000_000_000,
};

const VALID_SESSION = {
  routeTemplate: "/epics/:epicId",
  hostId: "host-1",
  epicId: "epic-1",
  tabId: "tab-1",
  artifactId: null,
  chatId: "chat-1",
  agentId: "agent-1",
  harness: "claude",
  model: "opus",
  profileId: "profile-1",
  profileMode: "managed",
  providerVersion: "1.2.3",
  providerClass: "bundled" as const,
};

describe("parseSupportSubmitReportRequest", () => {
  it("accepts a well-formed request with no optional fields", () => {
    expect(parseSupportSubmitReportRequest(VALID_FORM)).toEqual(VALID_FORM);
  });

  it("rejects a non-object payload", () => {
    expect(() => parseSupportSubmitReportRequest(null)).toThrow();
    expect(() => parseSupportSubmitReportRequest("nope")).toThrow();
    expect(() => parseSupportSubmitReportRequest([VALID_FORM])).toThrow();
  });

  it("rejects a missing draftId", () => {
    const { draftId: _draftId, ...withoutDraftId } = VALID_FORM;
    expect(() => parseSupportSubmitReportRequest(withoutDraftId)).toThrow();
  });

  it("rejects a non-number draftId", () => {
    expect(() =>
      parseSupportSubmitReportRequest({ ...VALID_FORM, draftId: "1" }),
    ).toThrow();
  });

  it("rejects a non-string required text field", () => {
    expect(() =>
      parseSupportSubmitReportRequest({ ...VALID_FORM, title: 42 }),
    ).toThrow();
  });

  it("rejects an unlisted top-level field - the allowlist is not caller-discipline", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        secretPayload: { anything: "goes" },
      }),
    ).toThrow();
  });

  it("accepts an optional fingerprint and correlationId", () => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      fingerprint: "fp:v1:abc",
      correlationId: "corr-1",
    });
    expect(result.fingerprint).toBe("fp:v1:abc");
    expect(result.correlationId).toBe("corr-1");
  });

  it("rejects a non-string fingerprint", () => {
    expect(() =>
      parseSupportSubmitReportRequest({ ...VALID_FORM, fingerprint: 123 }),
    ).toThrow();
  });

  it("accepts a fully-populated privateDiagnostics payload", () => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      privateDiagnostics: { cause: VALID_CAUSE, session: VALID_SESSION },
    });
    expect(result.privateDiagnostics).toEqual({
      cause: VALID_CAUSE,
      session: VALID_SESSION,
    });
  });

  it("treats an omitted cause/session as null, not a rejection", () => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      privateDiagnostics: {},
    });
    expect(result.privateDiagnostics).toEqual({ cause: null, session: null });
  });

  it("rejects an unlisted key inside privateDiagnostics", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: { cause: null, session: null, extra: true },
      }),
    ).toThrow();
  });

  it("rejects an unlisted key inside privateDiagnostics.cause", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          cause: { ...VALID_CAUSE, workspacePath: "/Users/anurag/secret" },
        },
      }),
    ).toThrow();
  });

  it("rejects a non-finite timestamp in privateDiagnostics.cause", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          cause: { ...VALID_CAUSE, timestamp: Number.NaN },
        },
      }),
    ).toThrow();
  });

  it("rejects an unlisted key inside privateDiagnostics.session", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          session: { ...VALID_SESSION, rawFilePath: "/etc/passwd" },
        },
      }),
    ).toThrow();
  });

  it("rejects a providerClass outside the bundled/custom/null allowlist", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          session: { ...VALID_SESSION, providerClass: "unknown-vendor" },
        },
      }),
    ).toThrow();
  });
});

describe("parseSupportReadFrozenLogTailInput", () => {
  it("accepts a well-formed input", () => {
    expect(
      parseSupportReadFrozenLogTailInput({ draftId: 1, target: "host" }),
    ).toEqual({ draftId: 1, target: "host" });
  });

  it("rejects a non-number draftId", () => {
    expect(() =>
      parseSupportReadFrozenLogTailInput({ draftId: "1", target: "host" }),
    ).toThrow();
  });

  it("falls back to the desktop target for an unrecognized value", () => {
    // parseSupportLogTarget fails open by design (a bad target is not a
    // security-relevant field the way draftId is) - pin that here so a
    // future tightening is a deliberate choice, not an accidental regression.
    expect(
      parseSupportReadFrozenLogTailInput({ draftId: 1, target: "nonsense" }),
    ).toEqual({ draftId: 1, target: "desktop" });
  });
});
