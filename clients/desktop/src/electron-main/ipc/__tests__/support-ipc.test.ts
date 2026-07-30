import { describe, expect, it } from "vitest";
import {
  parseSupportFreezeEvidenceInput,
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

const KNOWN_STRING = { status: "known", value: "epic-1" };
const STALE_STRING = { status: "stale", value: "tab-1" };
const UNAVAILABLE = { status: "unavailable" };

// Field-for-field match with ticket 05's `SupportContextSnapshot`
// (clients/gui-app/src/lib/support-context-registry.ts).
const VALID_REGISTRY = {
  routeTemplate: KNOWN_STRING,
  hostId: KNOWN_STRING,
  epicId: KNOWN_STRING,
  tabId: STALE_STRING,
  artifactId: UNAVAILABLE,
  chatId: KNOWN_STRING,
  agentId: KNOWN_STRING,
  harnessId: KNOWN_STRING,
  model: KNOWN_STRING,
  profileId: { status: "known", value: null },
  providerSelectionClass: { status: "known", value: "bundled" },
  providerVersion: { status: "stale", value: null },
};

const VALID_PRIVATE_DIAGNOSTICS = {
  cause: VALID_CAUSE,
  registry: VALID_REGISTRY,
  fingerprint: "fp:v1:abc",
  stackFamily: "stack:v1:abc",
  correlationId: "corr-1",
};

describe("parseSupportSubmitReportRequest", () => {
  it("accepts a well-formed request with no privateDiagnostics", () => {
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

  it("accepts a fully-populated privateDiagnostics payload", () => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      privateDiagnostics: VALID_PRIVATE_DIAGNOSTICS,
    });
    expect(result.privateDiagnostics).toEqual(VALID_PRIVATE_DIAGNOSTICS);
  });

  it("accepts a null cause, fingerprint, and stackFamily - all real, non-error states", () => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      privateDiagnostics: {
        ...VALID_PRIVATE_DIAGNOSTICS,
        cause: null,
        fingerprint: null,
        stackFamily: null,
      },
    });
    expect(result.privateDiagnostics?.cause).toBeNull();
    expect(result.privateDiagnostics?.fingerprint).toBeNull();
    expect(result.privateDiagnostics?.stackFamily).toBeNull();
  });

  it.each(["cause", "registry", "fingerprint", "stackFamily", "correlationId"])(
    "rejects privateDiagnostics missing the required %s key - the serializer never omits it",
    (key) => {
      const withoutKey = { ...VALID_PRIVATE_DIAGNOSTICS };
      delete (withoutKey as Record<string, unknown>)[key];
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          privateDiagnostics: withoutKey,
        }),
      ).toThrow();
    },
  );

  it("rejects a non-string correlationId", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: { ...VALID_PRIVATE_DIAGNOSTICS, correlationId: 1 },
      }),
    ).toThrow();
  });

  it("rejects an unlisted key inside privateDiagnostics", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: { ...VALID_PRIVATE_DIAGNOSTICS, extra: true },
      }),
    ).toThrow();
  });

  it("rejects an unlisted key inside privateDiagnostics.cause", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
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
          ...VALID_PRIVATE_DIAGNOSTICS,
          cause: { ...VALID_CAUSE, timestamp: Number.NaN },
        },
      }),
    ).toThrow();
  });

  it("rejects an unlisted key inside privateDiagnostics.registry", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          registry: { ...VALID_REGISTRY, rawFilePath: "/etc/passwd" },
        },
      }),
    ).toThrow();
  });

  it("rejects a providerSelectionClass value outside bundled/path/custom", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          registry: {
            ...VALID_REGISTRY,
            providerSelectionClass: { status: "known", value: "vendored" },
          },
        },
      }),
    ).toThrow();
  });

  it.each(["known", "stale", "unavailable"])(
    "accepts a registry field with status %s",
    (status) => {
      const field =
        status === "unavailable" ? UNAVAILABLE : { status, value: "epic-2" };
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          registry: { ...VALID_REGISTRY, epicId: field },
        },
      });
      expect(result.privateDiagnostics?.registry.epicId).toEqual(field);
    },
  );

  it("rejects a registry field with an unrecognized status", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          registry: {
            ...VALID_REGISTRY,
            epicId: { status: "fresh", value: "epic-1" },
          },
        },
      }),
    ).toThrow();
  });

  it("rejects a known registry field missing its value", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          registry: { ...VALID_REGISTRY, epicId: { status: "known" } },
        },
      }),
    ).toThrow();
  });

  it("rejects an unavailable registry field carrying a stray value", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          registry: {
            ...VALID_REGISTRY,
            epicId: { status: "unavailable", value: "epic-1" },
          },
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

  it("rejects an unrecognized target instead of failing open", () => {
    // Strict rejection everywhere: an unrecognized target used to silently
    // fall back to "desktop", which is exactly the caller-discipline pattern
    // this whole contract exists to close off.
    expect(() =>
      parseSupportReadFrozenLogTailInput({ draftId: 1, target: "nonsense" }),
    ).toThrow();
  });

  it("rejects a non-integer draftId", () => {
    expect(() =>
      parseSupportReadFrozenLogTailInput({ draftId: 1.5, target: "host" }),
    ).toThrow();
  });

  it("rejects an unlisted top-level field", () => {
    expect(() =>
      parseSupportReadFrozenLogTailInput({
        draftId: 1,
        target: "host",
        extra: true,
      }),
    ).toThrow();
  });
});

describe("parseSupportFreezeEvidenceInput", () => {
  it("accepts a well-formed input with a fingerprint", () => {
    expect(
      parseSupportFreezeEvidenceInput({
        draftId: 1,
        fingerprint: "fp:v1:abc",
      }),
    ).toEqual({ draftId: 1, fingerprint: "fp:v1:abc" });
  });

  it("accepts a null fingerprint - the manual-open / no-envelope case", () => {
    expect(
      parseSupportFreezeEvidenceInput({ draftId: 2, fingerprint: null }),
    ).toEqual({ draftId: 2, fingerprint: null });
  });

  it("rejects a missing fingerprint key - the wire always carries it", () => {
    expect(() => parseSupportFreezeEvidenceInput({ draftId: 1 })).toThrow();
  });

  it("rejects a non-integer draftId", () => {
    expect(() =>
      parseSupportFreezeEvidenceInput({
        draftId: 1.5,
        fingerprint: null,
      }),
    ).toThrow();
  });

  it("rejects a non-string non-null fingerprint", () => {
    expect(() =>
      parseSupportFreezeEvidenceInput({ draftId: 1, fingerprint: 42 }),
    ).toThrow();
  });

  it("rejects an unlisted top-level field", () => {
    expect(() =>
      parseSupportFreezeEvidenceInput({
        draftId: 1,
        fingerprint: null,
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects a bare draftId number - the pre-ledger shape", () => {
    expect(() => parseSupportFreezeEvidenceInput(1)).toThrow();
  });
});
