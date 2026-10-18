import { mkdtempSync, rmSync } from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "../../runner/environment";
import { STDERR_FATAL_KINDS } from "../crash-diagnostics";
import type {
  HostCrashEvent,
  HostCrashIdentity,
  HostCrashTelemetry,
} from "../crash-telemetry";
import type { HostPidMetadata } from "../pid-metadata";

// The crash throttle keeps its state under the CLI home, which `store/paths`
// binds from `os.homedir()` at module load. Point it at a directory of this
// file's own so no test reads or writes a real `~/.traycer`.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

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
  // Defaults to a healthy, already-drained flush so tests that never touch
  // the transport budget still resolve cleanly.
  flush: vi.fn<(timeout: number) => Promise<boolean>>(() =>
    Promise.resolve(true),
  ),
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
  flush: (timeout: number) => sentryMocks.flush(timeout),
}));

const sentryTransportMocks = vi.hoisted(() => ({
  destroySentryTransportRequests: vi.fn<() => number>(() => 0),
}));

vi.mock("../../sentry-transport", () => ({
  destroySentryTransportRequests: () =>
    sentryTransportMocks.destroySentryTransportRequests(),
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
  HOST_CRASH_FINGERPRINT_ROOT,
  HOST_CRASH_IDENTITY_TIMEOUT_MS,
  HOST_CRASH_TRANSPORT_TIMEOUT_MS,
} = await import("../crash-telemetry");

// `reportHostCrashToSentry` is deliberately NOT destructured from the shared
// top-level import above: it now runs through crash-telemetry's
// module-level `HostCrashReportThrottle` singleton (see the
// "reportHostCrashToSentry" describe block below, which imports a fresh
// module instance per test instead).

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
    processStartIdentityRead: "absent",
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
    stopRequested: false,
    stderrEmpty: false,
    stderrFatal: "other",
    reportMemory: { heapLimitBytes: null, heapUsedBytes: null, rssBytes: null },
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
        "host_fatal",
        "host_output",
        "host_phase",
        "host_running_version",
        "host_version",
        "os_release",
        "platform",
        "stop_requested",
        "uptime_bucket",
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
      stop_requested: "no",
      host_output: "wrote",
      host_fatal: "other",
      host_phase: "published",
      uptime_bucket: "lt-10s",
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

  describe("external termination", () => {
    it("reports DBG_TERMINATE_PROCESS as a warning under its own fingerprint, tagged host_exit_kind", () => {
      const event = buildHostCrashEvent(
        sampleTelemetry({
          exitCode: 0x40010004,
          signal: null,
          exitMeaning:
            "0x40010004 DBG_TERMINATE_PROCESS (terminated from outside)",
        }),
        null,
      );
      expect(event.level).toBe("warning");
      expect(event.fingerprint).toEqual([
        HOST_CRASH_FINGERPRINT_ROOT,
        platform(),
        "external-termination",
      ]);
      expect(event.tags.host_exit_kind).toBe("external-termination");
      expect(event.tags.crash_kind).toBe("0x40010004");
    });

    it("keeps every other exit status an error under the crash fingerprint with no host_exit_kind", () => {
      const event = buildHostCrashEvent(
        sampleTelemetry({ exitCode: 0xc0000005, exitMeaning: null }),
        null,
      );
      expect(event.level).toBe("error");
      expect(event.fingerprint).toEqual([
        HOST_CRASH_FINGERPRINT_ROOT,
        platform(),
        "0xC0000005",
      ]);
      expect(event.tags).not.toHaveProperty("host_exit_kind");
    });
  });

  describe("exit-cause tags", () => {
    it("tags a requested stop and a silent child as closed-set verdicts", () => {
      const event = buildHostCrashEvent(
        sampleTelemetry({ stopRequested: true, stderrEmpty: true }),
        null,
      );
      expect(event.tags.stop_requested).toBe("yes");
      expect(event.tags.host_output).toBe("silent");
    });

    it.each(STDERR_FATAL_KINDS)(
      "carries the stderr fatal kind %s as the host_fatal tag, and nothing else of the capture",
      (kind) => {
        const event = buildHostCrashEvent(
          sampleTelemetry({ stderrFatal: kind }),
          null,
        );
        expect(event.tags.host_fatal).toBe(kind);
        expect(JSON.stringify(event)).not.toContain("heap out of memory");
      },
    );

    it("derives host_phase from whether the child published its own pid.json", () => {
      const published = buildHostCrashEvent(sampleTelemetry({}), {
        hostId: "host-a",
        runningVersion: "1.2.4",
      });
      const beforePublish = buildHostCrashEvent(sampleTelemetry({}), {
        hostId: "host-a",
        runningVersion: null,
      });
      const unknown = buildHostCrashEvent(sampleTelemetry({}), null);
      expect(published.tags.host_phase).toBe("published");
      expect(beforePublish.tags.host_phase).toBe("before-publish");
      expect(unknown.tags.host_phase).toBe("unknown");
      // A spawn that yielded no pid cannot be compared with the file's pid.
      const noChildPid = buildHostCrashEvent(
        sampleTelemetry({ childPid: null }),
        { hostId: "host-a", runningVersion: null },
      );
      expect(noChildPid.tags.host_phase).toBe("unknown");
    });

    it.each([
      [0, "lt-10s"],
      [9_999, "lt-10s"],
      [10_000, "lt-1m"],
      [59_999, "lt-1m"],
      [60_000, "lt-10m"],
      [10 * 60_000, "lt-1h"],
      [60 * 60_000, "lt-24h"],
      [24 * 60 * 60_000, "gte-24h"],
    ])("buckets an uptime of %d ms as %s", (uptimeMs, bucket) => {
      const event = buildHostCrashEvent(sampleTelemetry({ uptimeMs }), null);
      expect(event.tags.uptime_bucket).toBe(bucket);
    });
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

  it("carries the report's heap limit, heap used and rss as plain numbers", () => {
    const event = buildHostCrashEvent(
      sampleTelemetry({
        reportMemory: {
          heapLimitBytes: 4831838208,
          heapUsedBytes: 4100000000,
          rssBytes: 4750000000,
        },
      }),
      null,
    );
    expect(event.extra.heapLimitBytes).toBe(4831838208);
    expect(event.extra.heapUsedBytes).toBe(4100000000);
    expect(event.extra.rssBytes).toBe(4750000000);
  });

  it("leaves out a memory value the report did not give, never a zero or -1", () => {
    const event = buildHostCrashEvent(
      sampleTelemetry({
        reportMemory: {
          heapLimitBytes: 4831838208,
          heapUsedBytes: null,
          rssBytes: null,
        },
      }),
      null,
    );
    expect(event.extra.heapLimitBytes).toBe(4831838208);
    expect("heapUsedBytes" in event.extra).toBe(false);
    expect("rssBytes" in event.extra).toBe(false);
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

  it("sends an externally terminated host at warning level, not error", () => {
    const event = buildHostCrashEvent(
      sampleTelemetry({ exitCode: 0x40010004, signal: null }),
      null,
    );
    captureHostCrashEvent(event);

    expect(sentryMocks.setLevel).toHaveBeenCalledWith("warning");
    expect(sentryMocks.captureMessage).toHaveBeenCalledWith(
      event.message,
      "warning",
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
  let workHome: string;

  beforeEach(() => {
    workHome = mkdtempSync(join(tmpdir(), "traycer-crash-telemetry-test-"));
    osHome.current = workHome;
    pidMetadataMocks.readHostPidMetadata.mockReset();
    sentryMocks.setLevel.mockReset();
    sentryMocks.setFingerprint.mockReset();
    sentryMocks.setTags.mockReset();
    sentryMocks.setExtras.mockReset();
    sentryMocks.setUser.mockReset();
    sentryMocks.captureMessage.mockReset();
    sentryMocks.flush.mockReset();
    sentryMocks.flush.mockImplementation(() => Promise.resolve(true));
    sentryTransportMocks.destroySentryTransportRequests.mockReset();
    sentryTransportMocks.destroySentryTransportRequests.mockImplementation(
      () => 0,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    osHome.current = "";
    rmSync(workHome, { recursive: true, force: true });
  });

  // Every test below imports a FRESH crash-telemetry module instance rather
  // than reusing the file's shared top-level import. reportHostCrashToSentry
  // now runs through the module-level HostCrashReportThrottle singleton
  // (HOST_CRASH_REPORTS_BEFORE_THROTTLE = 3), and sampleTelemetry's default
  // fixture (exitCode 7, signal null) is the SAME crash "kind" across every
  // test in this describe block. Without a fresh module per test, only the
  // first 3 reportHostCrashToSentry calls across the WHOLE FILE would ever
  // reach Sentry.captureMessage - every later test's assertions would fail
  // not because reporting broke, but because an EARLIER test already spent
  // this kind's throttle budget.
  async function freshReportHostCrashToSentry(): Promise<
    (telemetry: HostCrashTelemetry) => Promise<void>
  > {
    vi.resetModules();
    const mod = await import("../crash-telemetry");
    return mod.reportHostCrashToSentry;
  }

  it("carries the resolved hostId and running version when the pid.json's pid matches the crashed child's", async () => {
    pidMetadataMocks.readHostPidMetadata.mockResolvedValue(
      samplePidMetadata({
        hostId: "host-resolved",
        version: "1.2.4",
        pid: 4242,
      }),
    );

    const report = await freshReportHostCrashToSentry();
    await report(sampleTelemetry({ childPid: 4242 }));

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

    const report = await freshReportHostCrashToSentry();
    await report(sampleTelemetry({ childPid: 4242 }));

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

    const report = await freshReportHostCrashToSentry();
    await report(sampleTelemetry({}));

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

    const report = await freshReportHostCrashToSentry();
    const reportPromise = report(sampleTelemetry({}));
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

    const report = await freshReportHostCrashToSentry();
    await expect(report(sampleTelemetry({}))).resolves.toBeUndefined();
  });

  describe("transport budget", () => {
    it("flushes the transport exactly once with the transport timeout after a successful capture", async () => {
      pidMetadataMocks.readHostPidMetadata.mockResolvedValue(null);

      const report = await freshReportHostCrashToSentry();
      await report(sampleTelemetry({}));

      expect(sentryMocks.flush).toHaveBeenCalledTimes(1);
      expect(sentryMocks.flush).toHaveBeenCalledWith(
        HOST_CRASH_TRANSPORT_TIMEOUT_MS,
      );
    });

    it("does not destroy the transport when flush resolves true", async () => {
      pidMetadataMocks.readHostPidMetadata.mockResolvedValue(null);
      sentryMocks.flush.mockImplementation(() => Promise.resolve(true));

      const report = await freshReportHostCrashToSentry();
      await report(sampleTelemetry({}));
      // Flush the microtask queue so a wrongly-called destroy would have run.
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(
        sentryTransportMocks.destroySentryTransportRequests,
      ).not.toHaveBeenCalled();
    });

    it("destroys the transport once when flush resolves false", async () => {
      pidMetadataMocks.readHostPidMetadata.mockResolvedValue(null);
      sentryMocks.flush.mockImplementation(() => Promise.resolve(false));

      const report = await freshReportHostCrashToSentry();
      await report(sampleTelemetry({}));

      await vi.waitFor(() => {
        expect(
          sentryTransportMocks.destroySentryTransportRequests,
        ).toHaveBeenCalledTimes(1);
      });
    });

    it("destroys the transport once when flush rejects, without an unhandled rejection", async () => {
      pidMetadataMocks.readHostPidMetadata.mockResolvedValue(null);
      sentryMocks.flush.mockImplementation(() =>
        Promise.reject(new Error("transport flush failed")),
      );

      const report = await freshReportHostCrashToSentry();
      await expect(report(sampleTelemetry({}))).resolves.toBeUndefined();

      await vi.waitFor(() => {
        expect(
          sentryTransportMocks.destroySentryTransportRequests,
        ).toHaveBeenCalledTimes(1);
      });
    });

    it("does not flush or destroy the transport when captureMessage throws", async () => {
      pidMetadataMocks.readHostPidMetadata.mockResolvedValue(null);
      sentryMocks.captureMessage.mockImplementation(() => {
        throw new Error("Sentry transport exploded");
      });

      const report = await freshReportHostCrashToSentry();
      await report(sampleTelemetry({}));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(sentryMocks.flush).not.toHaveBeenCalled();
      expect(
        sentryTransportMocks.destroySentryTransportRequests,
      ).not.toHaveBeenCalled();
    });

    it("resolves before the flush settles", async () => {
      let resolveFlush: (drained: boolean) => void = () => undefined;
      sentryMocks.flush.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            resolveFlush = resolve;
          }),
      );
      pidMetadataMocks.readHostPidMetadata.mockResolvedValue(null);

      const report = await freshReportHostCrashToSentry();
      await report(sampleTelemetry({}));

      // The reporter's own promise already resolved above, while flush is
      // still pending - so the destroy it could trigger has not run yet.
      expect(
        sentryTransportMocks.destroySentryTransportRequests,
      ).not.toHaveBeenCalled();

      resolveFlush(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  });
});
