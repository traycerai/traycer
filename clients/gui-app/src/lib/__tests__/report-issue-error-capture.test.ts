import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureDictationFailure,
  capturePersistedAgentError,
  captureReportIssueError,
} from "@/lib/report-issue-error-capture";
import { createReportIssueDraftContext } from "@/lib/report-issue-draft-context";
import { __resetSupportContextRegistryForTests } from "@/lib/support-context-registry";

const captureException = vi.hoisted(() => vi.fn());
const isInitialized = vi.hoisted(() => vi.fn(() => true));

vi.mock("@sentry/browser", () => ({
  captureException,
  isInitialized,
}));

afterEach(() => {
  captureException.mockClear();
  isInitialized.mockClear();
  isInitialized.mockReturnValue(true);
  __resetSupportContextRegistryForTests();
});

describe("capturePersistedAgentError", () => {
  // A persisted transcript error row already happened host-side; a fresh
  // renderer captureException would mint an unrelated Sentry stream.
  it("never calls captureException", () => {
    capturePersistedAgentError({
      message: "Boom went the host",
      code: "RUNTIME_THROWN",
      recoverable: false,
    });

    expect(captureException).not.toHaveBeenCalled();
    // Contrast: live captures DO call Sentry when it is initialized.
    captureReportIssueError({
      error: new Error("live"),
      componentStack: null,
      errorCode: "LIVE",
      sourceAction: "test",
    });
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("builds an AgentError cause with the transcript message and code", () => {
    const capture = capturePersistedAgentError({
      message: "Boom went the host",
      code: "RUNTIME_THROWN",
      recoverable: false,
    });

    expect(capture.cause).toEqual(
      expect.objectContaining({
        type: "AgentError",
        message: "Boom went the host",
        errorCode: "RUNTIME_THROWN",
        sourceAction: "agent-turn",
        stack: null,
        componentStack: null,
      }),
    );
    expect(typeof capture.cause.timestamp).toBe("number");
    expect(capture.fingerprint).toMatch(/^fp:v1:/);
    expect(capture.correlationId.length).toBeGreaterThan(0);
    expect(capture.stackFamily).toBeNull();
  });

  it("uses the AgentErrorRecoverable type when recoverable is true", () => {
    const capture = capturePersistedAgentError({
      message: "Please re-authenticate",
      code: "auth",
      recoverable: true,
    });

    expect(capture.cause.type).toBe("AgentErrorRecoverable");
    expect(capture.cause.errorCode).toBe("auth");
    expect(capture.cause.sourceAction).toBe("agent-turn");
    expect(capture.fingerprint).toMatch(/^fp:v1:/);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("accepts a null code and still mints a fingerprint", () => {
    const capture = capturePersistedAgentError({
      message: "Something failed",
      code: null,
      recoverable: false,
    });

    expect(capture.cause.errorCode).toBeNull();
    expect(capture.fingerprint).toMatch(/^fp:v1:/);
  });
});

describe("captureDictationFailure", () => {
  // Change C (int#4836): the failure class travels in the PUBLIC prefill so a
  // filed issue names the failing path, while the raw error text - which can
  // carry browser/host wording - stays private. These are the invariants that
  // change exists to establish, so they are pinned rather than inspected.
  it("never calls captureException", () => {
    captureDictationFailure({
      failureClass: "not_connected",
      message: "Not connected to the local host.",
    });

    expect(captureException).not.toHaveBeenCalled();
  });

  it("keeps the raw message private and the class as the app-defined code", () => {
    const capture = captureDictationFailure({
      failureClass: "mic_open_failed",
      message: "Could not access the microphone: Device in use by OBS",
    });
    const draft = createReportIssueDraftContext({
      title: "Dictation failed",
      message: null,
      code: "mic_open_failed",
      source: "Dictation",
      capture,
    });

    // Public: the fixed class only - no raw error text anywhere in it.
    expect(draft.publicPrefill.code).toBe("mic_open_failed");
    expect(JSON.stringify(draft.publicPrefill)).not.toContain("OBS");
    // Private: the real text, joined to the report by correlation id.
    expect(draft.privateDiagnostics.cause).toEqual(
      expect.objectContaining({
        type: "DictationFailed",
        message: "Could not access the microphone: Device in use by OBS",
        errorCode: "mic_open_failed",
        sourceAction: "dictation",
        stack: null,
        componentStack: null,
      }),
    );
    expect(draft.privateDiagnostics.correlationId).toBe(capture.correlationId);
  });

  it("fingerprints two different failure classes apart", () => {
    const notConnected = captureDictationFailure({
      failureClass: "not_connected",
      message: "Not connected to the local host.",
    });
    const lost = captureDictationFailure({
      failureClass: "connection_lost",
      message: "Lost connection to the local host.",
    });

    expect(notConnected.fingerprint).not.toBe(lost.fingerprint);
  });
});
