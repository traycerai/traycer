import { describe, expect, it, vi } from "vitest";
import { crossHostMessagingIssue } from "../engine";
import { DOCTOR_ISSUE_CODES } from "../issues";
import { noopLogger } from "../../logger";
import type { CommandContext } from "../../runner/runner";

/**
 * The host answered `host.status`, so it is reachable - but its cross-host
 * messages can still be paused (`host.status@1.8` `crossHostMessaging`). That
 * is a warning: the host retries on its own and nothing local is broken, so
 * it must never flip the exit code of `traycer host doctor`.
 */

function makeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: noopLogger,
    },
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

const SINCE = Date.UTC(2026, 9, 17, 10, 0, 0);
const RETRY = Date.UTC(2026, 9, 17, 10, 5, 0);

describe("crossHostMessagingIssue", () => {
  it("raises nothing when the host did not report (older than host.status@1.8)", () => {
    expect(crossHostMessagingIssue(null)).toBeNull();
  });

  it("raises nothing when messages flow", () => {
    expect(
      crossHostMessagingIssue({
        state: "ok",
        pausedSince: null,
        nextRetryAt: null,
        cause: null,
      }),
    ).toBeNull();
  });

  it("raises a warning when messages are paused, with the times and the cause", () => {
    const issue = crossHostMessagingIssue({
      state: "paused",
      pausedSince: SINCE,
      nextRetryAt: RETRY,
      cause: "breaker-open",
    });

    expect(issue).not.toBeNull();
    expect(issue?.code).toBe(
      DOCTOR_ISSUE_CODES.HOST_CROSS_HOST_MESSAGES_PAUSED,
    );
    expect(issue?.severity).toBe("warning");
    expect(issue?.title).toBe("Degraded: cross-host messages paused");
    expect(issue?.message).toContain(new Date(SINCE).toISOString());
    expect(issue?.message).toContain(new Date(RETRY).toISOString());
    expect(issue?.details).toEqual({
      pausedSince: SINCE,
      nextRetryAt: RETRY,
      cause: "breaker-open",
    });
    // Nothing for the CLI to fix: the host retries on its own.
    expect(issue?.fixAction).toBeNull();
    expect(issue?.terminalCommand).toBeNull();
  });

  // The schema bounds the instants below only, and `toISOString()` throws
  // `RangeError` past 8.64e15. That must not turn a healthy, answering host
  // into a failed RPC probe.
  it("still raises, without throwing, when an instant is beyond what Date can hold", () => {
    const issue = crossHostMessagingIssue({
      state: "paused",
      pausedSince: 9e15,
      nextRetryAt: Number.MAX_SAFE_INTEGER,
      cause: "breaker-open",
    });

    expect(issue?.code).toBe(
      DOCTOR_ISSUE_CODES.HOST_CROSS_HOST_MESSAGES_PAUSED,
    );
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).not.toContain("Paused since");
    expect(issue?.message).not.toContain("next attempt at");
    expect(issue?.message).toContain("It retries on its own.");
    expect(issue?.details).toEqual({
      pausedSince: 9e15,
      nextRetryAt: Number.MAX_SAFE_INTEGER,
      cause: "breaker-open",
    });
  });

  it("still raises when the times and cause are unknown", () => {
    const issue = crossHostMessagingIssue({
      state: "paused",
      pausedSince: null,
      nextRetryAt: null,
      cause: null,
    });

    expect(issue?.severity).toBe("warning");
    expect(issue?.message).not.toContain("Paused since");
    expect(issue?.message).toContain("retries on its own");
    expect(issue?.details).toEqual({
      pausedSince: null,
      nextRetryAt: null,
      cause: null,
    });
  });
});

describe("traycer host doctor exit code", () => {
  it("stays 0 for a report whose only issue is paused cross-host messages", async () => {
    const issue = crossHostMessagingIssue({
      state: "paused",
      pausedSince: SINCE,
      nextRetryAt: null,
      cause: "transient",
    });
    if (issue === null) throw new Error("expected an issue");
    vi.resetModules();
    vi.doMock("../../doctor", () => ({
      runDoctor: async () => ({ issues: [issue] }),
    }));
    vi.doMock("../../host/lifecycle-snapshot", () => ({
      lifecycleSnapshotRows: () => [],
    }));
    try {
      const { hostDoctorCommand } = await import("../../commands/host-doctor");
      const result = await hostDoctorCommand(makeCtx());
      expect(result.exitCode).toBe(0);
    } finally {
      vi.doUnmock("../../doctor");
      vi.doUnmock("../../host/lifecycle-snapshot");
    }
  });
});
