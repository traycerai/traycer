import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capturePersistedAgentError,
  captureReportIssueError,
} from "@/lib/report-issue-error-capture";
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
