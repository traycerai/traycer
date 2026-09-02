import { arch, platform, release } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "../../runner/environment";
import type {
  HostCrashEvent,
  HostCrashIdentity,
  HostCrashTelemetry,
} from "../crash-telemetry";
import type { HostPidMetadata } from "../pid-metadata";

// Fake Sentry scope surface: only the methods `captureHostCrashEvent`
// actually calls, mirroring how the module narrows `Sentry.Scope` itself.
interface FakeScope {
  setLevel(level: string): void;
  setFingerprint(fingerprint: readonly string[]): void;
  setTags(tags: Record<string, string>): void;
  setExtras(extras: Record<string, string | number | boolean>): void;
  setUser(user: { id: string }): void;
}

const sentryMocks = vi.hoisted(() => ({
  setLevel: vi.fn<(level: string) => void>(),
  setFingerprint: vi.fn<(fingerprint: readonly string[]) => void>(),
  setTags: vi.fn<(tags: Record<string, string>) => void>(),
  setExtras:
    vi.fn<(extras: Record<string, string | number | boolean>) => void>(),
  setUser: vi.fn<(user: { id: string }) => void>(),
  captureMessage: vi.fn<(message: string, level: string) => void>(),
}));

vi.mock("@sentry/node", () => ({
  withScope: (fn: (scope: FakeScope) => void) => {
    fn({
      setLevel: sentryMocks.setLevel,
      setFingerprint: sentryMocks.setFingerprint,
      setTags: sentryMocks.setTags,
      setExtras: sentryMocks.setExtras,
      setUser: sentryMocks.setUser,
    });
  },
  captureMessage: (message: string, level: string) =>
    sentryMocks.captureMessage(message, level),
}));

const pidMetadataMocks = vi.hoisted(() => ({
  readHostPidMetadata:
    vi.fn<
      (environment: string | undefined) => Promise<HostPidMetadata | null>
    >(),
}));

vi.mock("../pid-metadata", () => ({
  readHostPidMetadata: (environment: string | undefined) =>
    pidMetadataMocks.readHostPidMetadata(environment),
}));

const {
  crashKindToken,
  buildHostCrashEvent,
  readHostCrashIdentity,
  captureHostCrashEvent,
  reportHostCrashToSentry,
  HOST_CRASH_FINGERPRINT_ROOT,
  HOST_CRASH_IDENTITY_TIMEOUT_MS,
} = await import("../crash-telemetry");

const { resolveCliVersion } = await import("../../cli-version");

const TEST_ENVIRONMENT: Environment = "production";

function samplePidMetadata(
  overrides: Partial<HostPidMetadata>,
): HostPidMetadata {
  return {
    pid: 4242,
    hostId: "host-abc",
    version: "1.2.4",
    websocketUrl: "ws://127.0.0.1:1234",
    startedAt: "2026-05-15T00:00:00.000Z",
    processStartIdentity: null,
    layer0: null,
    layer0Slot: null,
    ...overrides,
  };
}

function sampleTelemetry(
  overrides: Partial<HostCrashTelemetry>,
): HostCrashTelemetry {
  return {
    environment: TEST_ENVIRONMENT,
    attemptId: "attempt-1",
    supervisorPid: 4242,
    // Matches samplePidMetadata().pid, so the pid-match rule resolves to
    // "written by this child" by default.
    childPid: 4242,
    hostVersion: "1.2.3",
    exitCode: 7,
    signal: null,
    exitMeaning: "some crash meaning",
    hasDiagnosticReport: true,
    uptimeMs: 1500,
    ...overrides,
  };
}

describe("crashKindToken", () => {
  it("prefers the signal over the exit code", () => {
    expect(crashKindToken(7, "SIGABRT")).toBe("SIGABRT");
  });

  it("renders a high-bit NTSTATUS code as uppercase hex", () => {
    // Windows fast-fail STATUS_STACK_BUFFER_OVERRUN.
    expect(crashKindToken(3221226505, null)).toBe("0xC0000409");
  });

  it("renders a small exit code as its plain decimal", () => {
    expect(crashKindToken(1, null)).toBe("1");
  });

  it("is 'unknown' when neither the code nor the signal is known", () => {
    expect(crashKindToken(null, null)).toBe("unknown");
  });
});

describe("buildHostCrashEvent", () => {
  it("uses the decoded exitMeaning as the message cause when present", () => {
    const event = buildHostCrashEvent(
      sampleTelemetry({
        exitMeaning: "0xC0000409 STATUS_STACK_BUFFER_OVERRUN",
      }),
      null,
    );
    expect(event.message).toBe(
      "Host crashed: 0xC0000409 STATUS_STACK_BUFFER_OVERRUN",
    );
  });

  it("falls back to the crash-kind token when exitMeaning is null", () => {
    const event = buildHostCrashEvent(
      sampleTelemetry({ exitCode: 7, signal: null, exitMeaning: null }),
      null,
    );
    expect(event.message).toBe("Host crashed: 7");
  });

  it("builds the fingerprint from the root, the platform, and the crash kind", () => {
    const telemetry = sampleTelemetry({
      exitCode: 3221226505,
      signal: null,
      exitMeaning: null,
    });
    const event = buildHostCrashEvent(telemetry, null);
    expect(event.fingerprint).toEqual([
      HOST_CRASH_FINGERPRINT_ROOT,
      platform(),
      "0xC0000409",
    ]);
  });

  it("pins the exact tag and extra key sets - no stderr tail, no bundle path", () => {
    const telemetry = sampleTelemetry({});
    const event: HostCrashEvent = buildHostCrashEvent(telemetry, null);

    expect(Object.keys(event.tags).sort()).toEqual(
      [
        "arch",
        "cli_version",
        "crash_kind",
        "host_environment",
        "host_running_version",
        "host_version",
        "os_release",
        "platform",
      ].sort(),
    );
    expect(Object.keys(event.extra).sort()).toEqual(
      [
        "attemptId",
        "childPid",
        "exitCode",
        "exitMeaning",
        "hasDiagnosticReport",
        "hostIdKnown",
        "signal",
        "supervisorPid",
        "uptimeMs",
      ].sort(),
    );
    // Neither field set carries anything that could be a stderr capture or a
    // filesystem path - the module comment's explicit non-goal.
    for (const key of [
      ...Object.keys(event.tags),
      ...Object.keys(event.extra),
    ]) {
      expect(key.toLowerCase()).not.toContain("stderr");
      expect(key.toLowerCase()).not.toContain("bundle");
      expect(key.toLowerCase()).not.toContain("path");
    }
  });

  it("populates tags from the telemetry, the identity, and the resolved CLI version", () => {
    const telemetry = sampleTelemetry({
      environment: "production",
      hostVersion: "1.2.3",
      exitCode: 1,
      signal: null,
      exitMeaning: null,
    });
    const identity: HostCrashIdentity = {
      hostId: "host-abc",
      runningVersion: "1.2.4",
    };
    const event = buildHostCrashEvent(telemetry, identity);

    expect(event.tags).toEqual({
      host_environment: "production",
      host_version: "1.2.3",
      host_running_version: "1.2.4",
      cli_version: resolveCliVersion(process.env),
      platform: platform(),
      arch: arch(),
      os_release: release(),
      crash_kind: "1",
    });
  });

  it("tags host_running_version as 'unknown' when identity is null", () => {
    const event = buildHostCrashEvent(sampleTelemetry({}), null);
    expect(event.tags.host_running_version).toBe("unknown");
  });

  it("tags host_running_version as 'unknown' when identity carries a null runningVersion, but still reports the known hostId", () => {
    const identity: HostCrashIdentity = {
      hostId: "host-mismatched",
      runningVersion: null,
    };
    const event = buildHostCrashEvent(sampleTelemetry({}), identity);
    expect(event.tags.host_running_version).toBe("unknown");
    expect(event.hostId).toBe("host-mismatched");
    expect(event.extra.hostIdKnown).toBe(true);
  });

  describe("cli_version tag", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("follows the injected TRAYCER_CLI_VERSION at call time", () => {
      vi.stubEnv("TRAYCER_CLI_VERSION", "9.9.9");
      const event = buildHostCrashEvent(sampleTelemetry({}), null);
      expect(event.tags.cli_version).toBe("9.9.9");
      expect(event.tags.cli_version).toBe(resolveCliVersion(process.env));
    });
  });

  it("defaults exitCode to -1 and signal/exitMeaning to empty strings when null", () => {
    const event = buildHostCrashEvent(
      sampleTelemetry({ exitCode: null, signal: null, exitMeaning: null }),
      null,
    );
    expect(event.extra.exitCode).toBe(-1);
    expect(event.extra.signal).toBe("");
    expect(event.extra.exitMeaning).toBe("");
  });

  it("carries attemptId, supervisorPid, hasDiagnosticReport, and uptimeMs through verbatim", () => {
    const telemetry = sampleTelemetry({
      attemptId: "attempt-xyz",
      supervisorPid: 9999,
      hasDiagnosticReport: false,
      uptimeMs: 42,
    });
    const event = buildHostCrashEvent(telemetry, null);
    expect(event.extra.attemptId).toBe("attempt-xyz");
    expect(event.extra.supervisorPid).toBe(9999);
    expect(event.extra.hasDiagnosticReport).toBe(false);
    expect(event.extra.uptimeMs).toBe(42);
  });

  it("puts the telemetry's childPid in extra.childPid, and -1 when the spawn yielded no pid", () => {
    const withPid = buildHostCrashEvent(
      sampleTelemetry({ childPid: 4242 }),
      null,
    );
    expect(withPid.extra.childPid).toBe(4242);

    const withoutPid = buildHostCrashEvent(
      sampleTelemetry({ childPid: null }),
      null,
    );
    expect(withoutPid.extra.childPid).toBe(-1);
  });

  it("sets hostIdKnown true and hostId to the identity's id when identity is present", () => {
    const identity: HostCrashIdentity = {
      hostId: "host-known",
      runningVersion: "1.2.4",
    };
    const event = buildHostCrashEvent(sampleTelemetry({}), identity);
    expect(event.extra.hostIdKnown).toBe(true);
    expect(event.hostId).toBe("host-known");
  });

  it("sets hostIdKnown false and hostId null when identity is null", () => {
    const event = buildHostCrashEvent(sampleTelemetry({}), null);
    expect(event.extra.hostIdKnown).toBe(false);
    expect(event.hostId).toBeNull();
  });
});

describe("readHostCrashIdentity", () => {
  beforeEach(() => {
    pidMetadataMocks.readHostPidMetadata.mockReset();
  });

  it("reports the pid.json's version when its pid matches the crashed child's", async () => {
    pidMetadataMocks.readHostPidMetadata.mockResolvedValue(
      samplePidMetadata({ hostId: "host-42", version: "1.9.9", pid: 4242 }),
    );
    const identity = await readHostCrashIdentity(TEST_ENVIRONMENT, 4242);
    expect(identity).toEqual({ hostId: "host-42", runningVersion: "1.9.9" });
  });

  it("reports the hostId but a null runningVersion when the pid.json's pid does not match the crashed child's", async () => {
    pidMetadataMocks.readHostPidMetadata.mockResolvedValue(
      samplePidMetadata({ hostId: "host-42", version: "1.9.9", pid: 1111 }),
    );
    const identity = await readHostCrashIdentity(TEST_ENVIRONMENT, 4242);
    expect(identity).toEqual({ hostId: "host-42", runningVersion: null });
  });

  it("reports the hostId but a null runningVersion when the crashed child's pid is unknown (null)", async () => {
    pidMetadataMocks.readHostPidMetadata.mockResolvedValue(
      samplePidMetadata({ hostId: "host-42", version: "1.9.9", pid: 4242 }),
    );
    const identity = await readHostCrashIdentity(TEST_ENVIRONMENT, null);
    expect(identity).toEqual({ hostId: "host-42", runningVersion: null });
  });

  it("returns null when no pid.json metadata exists", async () => {
    pidMetadataMocks.readHostPidMetadata.mockResolvedValue(null);
    const identity = await readHostCrashIdentity(TEST_ENVIRONMENT, 4242);
    expect(identity).toBeNull();
  });
});

describe("captureHostCrashEvent", () => {
  beforeEach(() => {
    sentryMocks.setLevel.mockReset();
    sentryMocks.setFingerprint.mockReset();
    sentryMocks.setTags.mockReset();
    sentryMocks.setExtras.mockReset();
    sentryMocks.setUser.mockReset();
    sentryMocks.captureMessage.mockReset();
  });

  it("sets error level, the fingerprint, tags, and extras, then captures the message", () => {
    const event = buildHostCrashEvent(sampleTelemetry({}), null);
    captureHostCrashEvent(event);

    expect(sentryMocks.setLevel).toHaveBeenCalledWith("error");
    expect(sentryMocks.setFingerprint).toHaveBeenCalledWith([
      ...event.fingerprint,
    ]);
    expect(sentryMocks.setTags).toHaveBeenCalledWith(event.tags);
    expect(sentryMocks.setExtras).toHaveBeenCalledWith(event.extra);
    expect(sentryMocks.captureMessage).toHaveBeenCalledWith(
      event.message,
      "error",
    );
  });

  it("sets the Sentry user to the host id when hostId is known", () => {
    const identity: HostCrashIdentity = {
      hostId: "host-known",
      runningVersion: "1.2.4",
    };
    const event = buildHostCrashEvent(sampleTelemetry({}), identity);
    captureHostCrashEvent(event);

    expect(sentryMocks.setUser).toHaveBeenCalledWith({ id: "host-known" });
  });

  it("never calls setUser when hostId is null", () => {
    const event = buildHostCrashEvent(sampleTelemetry({}), null);
    captureHostCrashEvent(event);

    expect(sentryMocks.setUser).not.toHaveBeenCalled();
  });
});

describe("reportHostCrashToSentry", () => {
  beforeEach(() => {
    pidMetadataMocks.readHostPidMetadata.mockReset();
    sentryMocks.setLevel.mockReset();
    sentryMocks.setFingerprint.mockReset();
    sentryMocks.setTags.mockReset();
    sentryMocks.setExtras.mockReset();
    sentryMocks.setUser.mockReset();
    sentryMocks.captureMessage.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("carries the resolved hostId and running version when the pid.json's pid matches the crashed child's", async () => {
    pidMetadataMocks.readHostPidMetadata.mockResolvedValue(
      samplePidMetadata({
        hostId: "host-resolved",
        version: "1.2.4",
        pid: 4242,
      }),
    );

    await reportHostCrashToSentry(sampleTelemetry({ childPid: 4242 }));

    expect(sentryMocks.setUser).toHaveBeenCalledWith({ id: "host-resolved" });
    expect(sentryMocks.setTags).toHaveBeenCalledWith(
      expect.objectContaining({ host_running_version: "1.2.4" }),
    );
    expect(sentryMocks.setExtras).toHaveBeenCalledWith(
      expect.objectContaining({ hostIdKnown: true }),
    );
    expect(sentryMocks.captureMessage).toHaveBeenCalledTimes(1);
  });

  it("still carries the resolved hostId but tags 'unknown' when the pid.json's pid does not match the crashed child's", async () => {
    pidMetadataMocks.readHostPidMetadata.mockResolvedValue(
      samplePidMetadata({
        hostId: "host-resolved",
        version: "1.2.4",
        pid: 1111,
      }),
    );

    await reportHostCrashToSentry(sampleTelemetry({ childPid: 4242 }));

    expect(sentryMocks.setUser).toHaveBeenCalledWith({ id: "host-resolved" });
    expect(sentryMocks.setTags).toHaveBeenCalledWith(
      expect.objectContaining({ host_running_version: "unknown" }),
    );
    expect(sentryMocks.setExtras).toHaveBeenCalledWith(
      expect.objectContaining({ hostIdKnown: true }),
    );
    expect(sentryMocks.captureMessage).toHaveBeenCalledTimes(1);
  });

  it("still captures with hostId null when the identity read rejects", async () => {
    pidMetadataMocks.readHostPidMetadata.mockRejectedValue(
      new Error("EACCES reading pid.json"),
    );

    await reportHostCrashToSentry(sampleTelemetry({}));

    expect(sentryMocks.setUser).not.toHaveBeenCalled();
    expect(sentryMocks.setTags).toHaveBeenCalledWith(
      expect.objectContaining({ host_running_version: "unknown" }),
    );
    expect(sentryMocks.setExtras).toHaveBeenCalledWith(
      expect.objectContaining({ hostIdKnown: false }),
    );
    expect(sentryMocks.captureMessage).toHaveBeenCalledTimes(1);
  });

  it("resolves within HOST_CRASH_IDENTITY_TIMEOUT_MS when the identity read never settles", async () => {
    vi.useFakeTimers();
    pidMetadataMocks.readHostPidMetadata.mockImplementation(
      () => new Promise(() => undefined),
    );

    const reportPromise = reportHostCrashToSentry(sampleTelemetry({}));
    await vi.advanceTimersByTimeAsync(HOST_CRASH_IDENTITY_TIMEOUT_MS);
    await reportPromise;

    expect(sentryMocks.setUser).not.toHaveBeenCalled();
    expect(sentryMocks.setExtras).toHaveBeenCalledWith(
      expect.objectContaining({ hostIdKnown: false }),
    );
    expect(sentryMocks.captureMessage).toHaveBeenCalledTimes(1);
  });

  it("does not reject when Sentry.captureMessage throws", async () => {
    pidMetadataMocks.readHostPidMetadata.mockResolvedValue(null);
    sentryMocks.captureMessage.mockImplementation(() => {
      throw new Error("Sentry transport exploded");
    });

    await expect(
      reportHostCrashToSentry(sampleTelemetry({})),
    ).resolves.toBeUndefined();
  });
});
