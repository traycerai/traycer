import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `host update` is the composite (Host Update Layer Redesign Tech Plan,
// "New/changed commands" > `host update`, D6): stage whatever `latest`
// requires via `downloadAndStageHost` (reusing an existing stage, or
// zero fetch beyond the manifest when already at latest), then promote
// it via `applyHost`. Busy: the stage stays intact and the command
// re-throws `E_HOST_BUSY` with the staged version attached to `details`.
//
// The command's `data` payload is a deliberate LEGACY-COMPAT projection,
// not the raw composite internals: Desktop's `host-management-ipc.ts`
// still runs `host update`'s stdout through `projectInstallResult`,
// which reads a flat shape (`version`, `installedAt`, `executablePath`,
// `source`, `archiveSha256`, `signatureKeyId`, `sizeBytes`,
// `previousVersion`, `serviceLifecycle`) and silently degrades any
// missing field to a fallback ("" / 0 / "none") rather than throwing -
// see `host-update.ts`'s module comment. The tests below replicate
// `projectInstallResult`'s exact field reads (not just spot-check a
// couple of fields) so a shape regression here fails loudly instead of
// silently degrading Desktop's update UI. Remove only when Desktop's
// `host update` invocation is deleted (post ticket-4 cleanup).

const mocks = vi.hoisted(() => ({
  downloadAndStageHostMock: vi.fn(),
  applyHostMock: vi.fn(),
  installHostDowngradeMock: vi.fn(),
  readHostStagedRecordMock: vi.fn(),
  readHostInstallRecordMock: vi.fn(),
  // Cross-mock ordering timeline for the Finding 8 test below (ticket-2
  // review round 1) - a SHARED array `withCliLock` and
  // `readHostStagedRecord` both push into, so a single assertion can pin
  // whether the staged-record read genuinely happened BEFORE lock-exit
  // (inside the same lock span the busy decision was made under) rather
  // than after it.
  callOrder: [] as string[],
  // Remote Host Support T16: the CLI writes `update-progress.json` so the
  // daemon can fold in-flight/failed update state into `host.status@1.1`.
  // Mocked so this suite never touches the real marker file or opens a real
  // TCP probe against a host that isn't running.
  writeUpdateProgressMarkerMock: vi.fn(),
  deleteUpdateProgressMarkerMock: vi.fn(),
  readUpdateProgressMarkerMock: vi.fn(),
  deleteUpdateProgressMarkerIfUnchangedMock: vi.fn(),
  replaceUpdateProgressMarkerIfUnchangedMock: vi.fn(),
  probeHostHealthMock: vi.fn(),
  readHostPidMetadataMock: vi.fn(),
  identityVerdictMock: vi.fn(),
  assertHostNotBusyMock: vi.fn(),
  stopHostForRestartWithAttemptMock: vi.fn(),
  relaunchHostAfterRestartWithAttemptMock: vi.fn(),
}));

vi.mock("../../host/update-progress-marker", () => ({
  writeUpdateProgressMarker: mocks.writeUpdateProgressMarkerMock,
  deleteUpdateProgressMarker: mocks.deleteUpdateProgressMarkerMock,
  readUpdateProgressMarker: mocks.readUpdateProgressMarkerMock,
  deleteUpdateProgressMarkerIfUnchanged:
    mocks.deleteUpdateProgressMarkerIfUnchangedMock,
  replaceUpdateProgressMarkerIfUnchanged:
    mocks.replaceUpdateProgressMarkerIfUnchangedMock,
  // Pure comparator; the real one, so the "is this marker still ours"
  // decisions under test compare the way production does.
  sameProgress: (
    a: {
      state: string;
      targetVersion: string;
      updatedAt: string;
      error: string | null;
    },
    b: {
      state: string;
      targetVersion: string;
      updatedAt: string;
      error: string | null;
    },
  ) =>
    a.state === b.state &&
    a.targetVersion === b.targetVersion &&
    a.updatedAt === b.updatedAt &&
    a.error === b.error,
}));

vi.mock("../../service/health-probe", () => ({
  probeHostHealth: mocks.probeHostHealthMock,
}));

vi.mock("../../installer/download-stage", () => ({
  downloadAndStageHost: mocks.downloadAndStageHostMock,
}));

// SAFETY, not convenience: `readActivationState` reads the REAL
// `~/.traycer/host/pid.json` (the CLI's home is `homedir()`-derived and not
// overridable), and with `readHostInstallRecord` mocked to a version the
// developer's live host is not running, an unmocked read would classify the
// developer's own host as activation debt and RESTART it from a unit test.
// Every test file that invokes `buildHostUpdateCommand` carries this mock.
vi.mock("../../host/pid-metadata", () => ({
  readHostPidMetadata: mocks.readHostPidMetadataMock,
}));
vi.mock("../../store/process-identity", () => ({
  getPublishedProcessIdentityVerdict: mocks.identityVerdictMock,
}));
vi.mock("../../host/busy-check", () => ({
  assertHostNotBusy: mocks.assertHostNotBusyMock,
}));
vi.mock("../../service", () => ({
  createServiceController: () => ({}),
  serviceLabelFor: (environment: string) => ({
    id: `ai.traycer.host.${environment}`,
    displayName: "Traycer Host",
    environment,
    devSlot: null,
  }),
}));
vi.mock("../../host/update-mutation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/update-mutation")>();
  return {
    ...actual,
    stopHostForRestartWithAttempt: mocks.stopHostForRestartWithAttemptMock,
    relaunchHostAfterRestartWithAttempt:
      mocks.relaunchHostAfterRestartWithAttemptMock,
  };
});

vi.mock("../../installer/apply", () => ({
  applyHost: mocks.applyHostMock,
}));

vi.mock("../host-update-downgrade", () => ({
  installHostDowngrade: mocks.installHostDowngradeMock,
}));

vi.mock("../../manifest/host-staged", () => ({
  readHostStagedRecord: async (
    ...callArgs: Parameters<typeof mocks.readHostStagedRecordMock>
  ) => {
    mocks.callOrder.push("read-staged");
    return mocks.readHostStagedRecordMock(...callArgs);
  },
}));

vi.mock("../../manifest/host-install", () => ({
  readHostInstallRecord: mocks.readHostInstallRecordMock,
}));

vi.mock("../../store/cli-lock", () => ({
  withCliLock: async (
    _opts: unknown,
    fn: (handle: {
      path: string;
      metadata: Record<string, unknown>;
      release: () => Promise<void>;
    }) => Promise<unknown>,
  ) => {
    mocks.callOrder.push("lock-enter");
    try {
      return await fn({
        path: "/tmp/.lock",
        metadata: {},
        release: async () => {},
      });
    } finally {
      mocks.callOrder.push("lock-exit");
    }
  },
}));

import { buildHostUpdateCommand } from "../host-update";
import { CLI_ERROR_CODES, cliError } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";
import type { HostInstallRecord } from "../../manifest/host-install";
import type { HostDownloadOutcome } from "../../installer/download-stage";
import type { ApplyHostOutcome } from "../../installer/apply";
import type { HostUpdateProgress } from "../../host/update-progress-marker";

// Mirrors host-management-ipc.ts's `projectInstallResult` field-by-field,
// including its tolerant fallbacks - the contract this suite pins.
function projectInstallResultLikeDesktop(raw: unknown): {
  version: string;
  installedAt: string;
  executablePath: string;
  source: { kind: string; value: string };
  archiveSha256: string;
  signatureKeyId: string;
  sizeBytes: number;
  previousVersion: string | null;
  serviceLifecycle: {
    priorServiceState: "running" | "stopped" | "not-installed";
    stoppedBeforeSwap: boolean;
    postSwapAction: "install" | "restart" | "start" | "none";
    postSwapError: string | null;
  };
} {
  const obj = raw as Record<string, unknown>;
  const sourceRaw = (obj.source ?? null) as Record<string, unknown> | null;
  const lifecycleRaw = (obj.serviceLifecycle ?? null) as Record<
    string,
    unknown
  > | null;
  return {
    version: typeof obj.version === "string" ? obj.version : "",
    installedAt: typeof obj.installedAt === "string" ? obj.installedAt : "",
    executablePath:
      typeof obj.executablePath === "string" ? obj.executablePath : "",
    source:
      sourceRaw === null
        ? { kind: "registry", value: "" }
        : {
            kind: sourceRaw.kind === "local-file" ? "local-file" : "registry",
            value: typeof sourceRaw.value === "string" ? sourceRaw.value : "",
          },
    archiveSha256:
      typeof obj.archiveSha256 === "string" ? obj.archiveSha256 : "",
    signatureKeyId:
      typeof obj.signatureKeyId === "string" ? obj.signatureKeyId : "",
    sizeBytes: typeof obj.sizeBytes === "number" ? obj.sizeBytes : 0,
    previousVersion:
      typeof obj.previousVersion === "string" ? obj.previousVersion : null,
    serviceLifecycle:
      lifecycleRaw === null
        ? {
            priorServiceState: "not-installed",
            stoppedBeforeSwap: false,
            postSwapAction: "none",
            postSwapError: null,
          }
        : {
            priorServiceState:
              lifecycleRaw.priorServiceState === "running" ||
              lifecycleRaw.priorServiceState === "stopped" ||
              lifecycleRaw.priorServiceState === "not-installed"
                ? lifecycleRaw.priorServiceState
                : "not-installed",
            stoppedBeforeSwap: lifecycleRaw.stoppedBeforeSwap === true,
            postSwapAction:
              lifecycleRaw.postSwapAction === "install" ||
              lifecycleRaw.postSwapAction === "restart" ||
              lifecycleRaw.postSwapAction === "start"
                ? lifecycleRaw.postSwapAction
                : "none",
            postSwapError:
              typeof lifecycleRaw.postSwapError === "string"
                ? lifecycleRaw.postSwapError
                : null,
          },
  };
}

function sampleRecord(version: string): HostInstallRecord {
  return {
    installId: `install-${version}`,
    version,
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry", value: version },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath: "/tmp/traycer-host",
    executableSha256: null,
  };
}

function appliedOutcome(
  previousVersion: string,
  version: string,
  postSwapError: string | null,
): ApplyHostOutcome {
  return {
    outcome: "applied",
    record: sampleRecord(version),
    previous: sampleRecord(previousVersion),
    runningActivated: postSwapError === null,
    installGeneration: `id:install-${version}`,
    serviceLifecycle: {
      priorServiceState: "running",
      stoppedBeforeSwap: true,
      postSwapAction: "restart",
    },
    postSwapError,
  };
}

function fakeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
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

// No running host by default: the activation-debt probe finds nothing and
// every existing short-circuit test keeps its no-op contract. Tests that
// exercise activation opt in with an explicit pid record. Re-armed per test
// because `resetAllMocks` wipes return values.
function armActivationDefaults(): void {
  mocks.readUpdateProgressMarkerMock.mockResolvedValue(null);
  mocks.deleteUpdateProgressMarkerIfUnchangedMock.mockResolvedValue("cleared");
  mocks.replaceUpdateProgressMarkerIfUnchangedMock.mockResolvedValue(
    "replaced",
  );
  mocks.readHostPidMetadataMock.mockResolvedValue(null);
  mocks.identityVerdictMock.mockResolvedValue("current");
  mocks.assertHostNotBusyMock.mockResolvedValue(undefined);
  mocks.stopHostForRestartWithAttemptMock.mockResolvedValue({
    forcedRecycle: false,
  });
  mocks.relaunchHostAfterRestartWithAttemptMock.mockResolvedValue(undefined);
}

describe("buildHostUpdateCommand composite", () => {
  beforeEach(() => {
    // The post-apply health probe gates success, so every apply-path test
    // needs a verdict. `resetAllMocks` below wipes return values, so the
    // healthy default is re-established per test rather than once.
    mocks.probeHostHealthMock.mockResolvedValue({
      healthy: true,
      detail: "ok",
    });
    armActivationDefaults();
  });

  afterEach(() => {
    // resetAllMocks (not clearAllMocks) so a mockResolvedValue/
    // mockRejectedValue configured in one test can't leak into the next.
    vi.resetAllMocks();
    mocks.callOrder = [];
  });

  it("short-circuits with no apply call when already at latest, backfilling the legacy shape from a locked install-record read", async () => {
    const outcome: HostDownloadOutcome = {
      outcome: "short-circuit",
      reason: "installed-up-to-date",
      targetVersion: "2.0.0",
      installedVersion: "2.0.0",
      stagedVersion: null,
    };
    mocks.downloadAndStageHostMock.mockResolvedValue(outcome);
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));

    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    });
    const result = await command(fakeCtx());

    expect(mocks.applyHostMock).not.toHaveBeenCalled();
    expect(mocks.readHostInstallRecordMock).toHaveBeenCalledWith("production");
    expect(result.human).toContain("no-op");
    const projected = projectInstallResultLikeDesktop(result.data);
    expect(projected).toEqual({
      version: "2.0.0",
      installedAt: "2026-01-01T00:00:00.000Z",
      executablePath: "/tmp/traycer-host",
      source: { kind: "registry", value: "2.0.0" },
      archiveSha256: "a".repeat(64),
      signatureKeyId: "test-key",
      sizeBytes: 1,
      previousVersion: "2.0.0",
      serviceLifecycle: {
        priorServiceState: "not-installed",
        stoppedBeforeSwap: false,
        postSwapAction: "none",
        postSwapError: null,
      },
    });
  });

  it("throws E_HOST_NOT_INSTALLED if the install record vanishes between the short-circuit read and the locked backfill", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "short-circuit",
      reason: "installed-up-to-date",
      targetVersion: "2.0.0",
      installedVersion: "2.0.0",
      stagedVersion: null,
    } satisfies HostDownloadOutcome);
    mocks.readHostInstallRecordMock.mockResolvedValue(null);

    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
    });
  });

  it("calls downloadAndStageHost with the explicit-incomparable policy (automatic: false) so a local-* install proceeds (D6 parity)", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "promoted",
      stagedVersion: "2.0.0",
      installedVersion: "local-abc123",
    } satisfies HostDownloadOutcome);
    mocks.applyHostMock.mockResolvedValue(
      appliedOutcome("local-abc123", "2.0.0", null),
    );

    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    });
    await command(fakeCtx());

    expect(mocks.downloadAndStageHostMock).toHaveBeenCalledWith({
      environment: "production",
      versionRequest: null,
      automatic: false,
      onProgress: expect.any(Function),
      registryClient: null,
    });
  });

  it("forwards an explicit version request to downloadAndStageHost", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "promoted",
      stagedVersion: "2.1.0",
      installedVersion: "2.0.0",
    } satisfies HostDownloadOutcome);
    mocks.applyHostMock.mockResolvedValue(
      appliedOutcome("2.0.0", "2.1.0", null),
    );

    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: "2.1.0",
      ackNonce: null,
    });
    await command(fakeCtx());

    expect(mocks.downloadAndStageHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        versionRequest: "2.1.0",
        automatic: false,
      }),
    );
  });

  it("uses the owned downgrade installer for an explicit lower target and keeps the normal progress and health flow", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleRecord("1.3.0-rc.1"),
    );
    mocks.installHostDowngradeMock.mockResolvedValue(
      appliedOutcome("1.3.0-rc.1", "1.2.0", null),
    );

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: true,
      versionRequest: "1.2.0",
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.downloadAndStageHostMock).not.toHaveBeenCalled();
    expect(mocks.installHostDowngradeMock).toHaveBeenCalledWith({
      environment: "production",
      version: "1.2.0",
      force: false,
      onProgress: expect.any(Function),
    });
    expect(mocks.writeUpdateProgressMarkerMock).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({ state: "updating", targetVersion: "1.2.0" }),
    );
    expect(mocks.probeHostHealthMock).toHaveBeenCalledTimes(1);
    // The clear is CONDITIONAL on the marker still being the one this
    // invocation wrote - a third updater's `updating`, written before it
    // waits for the lock, must survive this command's exit.
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({ state: "updating" }),
    );
    expect(result.human).toContain("updated host 1.3.0-rc.1 → 1.2.0");
  });

  it("keeps an explicit lower target on the monotonic stage path unless downgrade is explicitly enabled", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "discarded",
      reason: "not-strictly-newer",
      targetVersion: "1.2.0",
    } satisfies HostDownloadOutcome);
    mocks.applyHostMock.mockResolvedValue({
      outcome: "no-op",
      installedVersion: "1.3.0-rc.1",
    } satisfies ApplyHostOutcome);
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleRecord("1.3.0-rc.1"),
    );

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: "1.2.0",
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.installHostDowngradeMock).not.toHaveBeenCalled();
    expect(mocks.downloadAndStageHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        versionRequest: "1.2.0",
        automatic: false,
      }),
    );
    expect(result.human).toContain("host already at 1.3.0-rc.1 (no-op)");
  });

  it("keeps a null version request for latest semantics", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "promoted",
      stagedVersion: "2.1.0",
      installedVersion: "2.0.0",
    } satisfies HostDownloadOutcome);
    mocks.applyHostMock.mockResolvedValue(
      appliedOutcome("2.0.0", "2.1.0", null),
    );

    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: null,
      ackNonce: null,
    });
    await command(fakeCtx());

    expect(mocks.downloadAndStageHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        versionRequest: null,
        automatic: false,
      }),
    );
  });

  it("reuses an existing stage (already-staged short-circuit) and still applies it, projecting the legacy shape from the applied record", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "short-circuit",
      reason: "already-staged",
      targetVersion: "2.0.0",
      installedVersion: "1.0.0",
      stagedVersion: "2.0.0",
    } satisfies HostDownloadOutcome);
    mocks.applyHostMock.mockResolvedValue(
      appliedOutcome("1.0.0", "2.0.0", null),
    );

    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    });
    const result = await command(fakeCtx());

    expect(mocks.applyHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: "production",
        force: false,
        noService: false,
        expectedStageFingerprint: null,
        onProgress: expect.any(Function),
        publishHostStartAdoption: expect.any(Function),
        verifyMutationCapability: expect.any(Function),
      }),
    );
    expect(result.human).toContain("updated host 1.0.0 → 2.0.0");
    const projected = projectInstallResultLikeDesktop(result.data);
    expect(projected.version).toBe("2.0.0");
    expect(projected.previousVersion).toBe("1.0.0");
    expect(projected.serviceLifecycle).toEqual({
      priorServiceState: "running",
      stoppedBeforeSwap: true,
      postSwapAction: "restart",
      postSwapError: null,
    });
  });

  it("downloads, promotes, then applies end to end", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "promoted",
      stagedVersion: "3.0.0",
      installedVersion: "2.0.0",
    } satisfies HostDownloadOutcome);
    mocks.applyHostMock.mockResolvedValue(
      appliedOutcome("2.0.0", "3.0.0", null),
    );

    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    });
    const result = await command(fakeCtx());

    expect(mocks.downloadAndStageHostMock).toHaveBeenCalled();
    expect(mocks.applyHostMock).toHaveBeenCalled();
    expect(result.human).toContain("updated host 2.0.0 → 3.0.0");
  });

  it("forwards --force to applyHost", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "promoted",
      stagedVersion: "2.0.0",
      installedVersion: "1.0.0",
    } satisfies HostDownloadOutcome);
    mocks.applyHostMock.mockResolvedValue(
      appliedOutcome("1.0.0", "2.0.0", null),
    );

    const command = buildHostUpdateCommand({
      force: true,
      allowDowngrade: false,
      ackNonce: null,
    });
    await command(fakeCtx());

    expect(mocks.applyHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
  });

  it("reports the postSwapError warning without throwing (no-rollback contract), nested under serviceLifecycle like the legacy shape", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "promoted",
      stagedVersion: "2.0.0",
      installedVersion: "1.0.0",
    } satisfies HostDownloadOutcome);
    mocks.applyHostMock.mockResolvedValue(
      appliedOutcome("1.0.0", "2.0.0", "service failed to start"),
    );

    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    });
    const result = await command(fakeCtx());

    expect(result.human).toContain("service did not converge");
    expect(result.human).toContain("service failed to start");
    const projected = projectInstallResultLikeDesktop(result.data);
    expect(projected.serviceLifecycle.postSwapError).toBe(
      "service failed to start",
    );
  });

  it("reports a no-op summary when applyHost itself finds nothing staged after a discarded download, backfilling from a locked re-read", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "discarded",
      reason: "not-strictly-newer",
      targetVersion: "2.0.0",
    } satisfies HostDownloadOutcome);
    mocks.applyHostMock.mockResolvedValue({
      outcome: "no-op",
      installedVersion: "2.0.0",
    } satisfies ApplyHostOutcome);
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));

    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    });
    const result = await command(fakeCtx());

    expect(mocks.applyHostMock).toHaveBeenCalled();
    expect(result.human).toContain("host already at 2.0.0 (no-op)");
    const projected = projectInstallResultLikeDesktop(result.data);
    expect(projected.version).toBe("2.0.0");
    expect(projected.previousVersion).toBe("2.0.0");
  });

  it("busy: re-throws E_HOST_BUSY with the staged version attached to details, stage kept", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "promoted",
      stagedVersion: "2.0.0",
      installedVersion: "1.0.0",
    } satisfies HostDownloadOutcome);
    mocks.applyHostMock.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: "The running host has work in progress",
        details: null,
        exitCode: 1,
      }),
    );
    mocks.readHostStagedRecordMock.mockResolvedValue({
      schemaVersion: 1,
      version: "2.0.0",
      runtimeVersion: null,
      archiveSha256: null,
      sizeBytes: 1,
      source: { kind: "registry", value: "2.0.0" },
      signatureKeyId: "test-key",
      signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
      executablePath: "traycer-host",
      platform: "darwin",
      arch: "arm64",
    });

    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
      details: { stagedVersion: "2.0.0" },
    });
  });

  it("busy: reads the staged record INSIDE the apply lock span, never after it releases (Finding 8)", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "promoted",
      stagedVersion: "2.0.0",
      installedVersion: "1.0.0",
    } satisfies HostDownloadOutcome);
    mocks.applyHostMock.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: "The running host has work in progress",
        details: null,
        exitCode: 1,
      }),
    );
    mocks.readHostStagedRecordMock.mockResolvedValue({
      schemaVersion: 1,
      version: "2.0.0",
      runtimeVersion: null,
      archiveSha256: null,
      sizeBytes: 1,
      source: { kind: "registry", value: "2.0.0" },
      signatureKeyId: "test-key",
      signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
      executablePath: "traycer-host",
      platform: "darwin",
      arch: "arm64",
    });

    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
      details: { stagedVersion: "2.0.0" },
    });

    // The read happens strictly BETWEEN lock-enter and lock-exit - the
    // exact coherence guarantee Finding 8 requires (a read after
    // lock-exit could observe a stage a different, now-unblocked actor
    // already mutated).
    expect(mocks.callOrder).toEqual(["lock-enter", "read-staged", "lock-exit"]);
  });

  it("propagates a non-busy applyHost error unchanged, without reading the staged record", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "promoted",
      stagedVersion: "2.0.0",
      installedVersion: "1.0.0",
    } satisfies HostDownloadOutcome);
    mocks.applyHostMock.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
        message: "no host installed",
        details: null,
        exitCode: 1,
      }),
    );

    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
    });
    expect(mocks.readHostStagedRecordMock).not.toHaveBeenCalled();
  });

  it("propagates E_HOST_NOT_INSTALLED thrown by downloadAndStageHost's own precondition", async () => {
    mocks.downloadAndStageHostMock.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
        message: "no host installed",
        details: null,
        exitCode: 1,
      }),
    );

    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
    });
    expect(mocks.applyHostMock).not.toHaveBeenCalled();
  });
});

// Remote Host Support T16. The daemon has no view of this process, so the
// `update-progress.json` marker is the ONLY way a remote client learns that an
// update is in flight or that it failed. These pin that the marker is written
// before the apply half runs and terminated on every exit path - a silently
// missing marker leaves a remote client reporting a permanently "updating"
// (or permanently idle) host.
describe("buildHostUpdateCommand update-progress marker (T16)", () => {
  beforeEach(() => {
    mocks.probeHostHealthMock.mockResolvedValue({
      healthy: true,
      detail: "ok",
    });
    armActivationDefaults();
  });

  afterEach(() => {
    vi.resetAllMocks();
    mocks.callOrder = [];
  });

  function promoted(stagedVersion: string): HostDownloadOutcome {
    return { outcome: "promoted", stagedVersion, installedVersion: "1.0.0" };
  }

  it("marks the update in flight before applying and clears the marker once the host probes healthy", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue(promoted("2.0.0"));
    mocks.applyHostMock.mockResolvedValue(
      appliedOutcome("1.0.0", "2.0.0", null),
    );

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(result.exitCode).toBe(0);
    expect(mocks.writeUpdateProgressMarkerMock).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({ state: "updating", targetVersion: "2.0.0" }),
    );
    // The clear is CONDITIONAL on the marker still being the one this
    // invocation wrote - a third updater's `updating`, written before it
    // waits for the lock, must survive this command's exit.
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({ state: "updating" }),
    );
  });

  it("leaves a failed marker (and refuses success) when the applied host never becomes healthy", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue(promoted("2.0.0"));
    mocks.applyHostMock.mockResolvedValue(
      appliedOutcome("1.0.0", "2.0.0", null),
    );
    mocks.probeHostHealthMock.mockResolvedValue({
      healthy: false,
      detail: "port 8765 never accepted a connection",
    });

    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
    });

    expect(mocks.writeUpdateProgressMarkerMock).toHaveBeenCalledTimes(1);
    const written = mocks.writeUpdateProgressMarkerMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(written.state).toBe("updating");
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      written,
      expect.objectContaining({
        state: "failed",
        targetVersion: "2.0.0",
        error: "port 8765 never accepted a connection",
      }),
    );
    // A failed update must never look finished to the daemon.
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
  });

  it("leaves a failed marker carrying the cause when the apply half throws", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue(promoted("2.0.0"));
    mocks.applyHostMock.mockRejectedValue(new Error("commit failed"));

    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toThrow("commit failed");

    expect(mocks.writeUpdateProgressMarkerMock).toHaveBeenCalledTimes(1);
    const written = mocks.writeUpdateProgressMarkerMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      written,
      expect.objectContaining({ state: "failed", error: "commit failed" }),
    );
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
  });

  it("never writes a marker for an already-at-latest run that applies nothing", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "short-circuit",
      reason: "installed-up-to-date",
      targetVersion: "2.0.0",
      installedVersion: "2.0.0",
      stagedVersion: null,
    } satisfies HostDownloadOutcome);
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(result.exitCode).toBe(0);
    expect(mocks.writeUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
    // No install was touched, so there is nothing to health-check either.
    expect(mocks.probeHostHealthMock).not.toHaveBeenCalled();
  });

  it("keeps the update working when the marker write itself fails", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue(promoted("2.0.0"));
    mocks.applyHostMock.mockResolvedValue(
      appliedOutcome("1.0.0", "2.0.0", null),
    );
    mocks.writeUpdateProgressMarkerMock.mockRejectedValue(
      new Error("EACCES: read-only home"),
    );

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    // Degraded remote progress reporting must not fail a local update.
    expect(result.exitCode).toBe(0);
  });
});

// `detectActivationDebt` (Ticket: activation debt owed by `host update` when
// the install record is ahead of the running host - see the module's own
// comment on `ActivationDebt`). These exercise the SHORT-CIRCUIT
// (`installed-up-to-date`) leg only, which is exactly where a stale running
// process would otherwise be silently left behind: `downloadAndStageHost`
// already says nothing needs staging, so activation is the only work left.
describe("buildHostUpdateCommand — activation debt (installed-up-to-date short-circuit)", () => {
  beforeEach(() => {
    mocks.probeHostHealthMock.mockResolvedValue({
      healthy: true,
      detail: "ok",
    });
    armActivationDefaults();
  });

  afterEach(() => {
    vi.resetAllMocks();
    mocks.callOrder = [];
  });

  function upToDate(version: string): HostDownloadOutcome {
    return {
      outcome: "short-circuit",
      reason: "installed-up-to-date",
      targetVersion: version,
      installedVersion: version,
      stagedVersion: null,
    };
  }

  function pidRecord(
    version: string,
    pid: number,
  ): {
    pid: number;
    hostId: string;
    version: string;
    websocketUrl: string;
    startedAt: string;
    processStartIdentity: null;
    layer0: null;
    layer0Slot: null;
  } {
    return {
      pid,
      hostId: "host-1",
      version,
      websocketUrl: "ws://127.0.0.1:51820/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: null,
      layer0: null,
      layer0Slot: null,
    };
  }

  it("running behind the install record: activates, writes the updating marker, restarts under the busy gate, probes health, and clears the marker", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue(pidRecord("1.0.0", 4242));
    mocks.identityVerdictMock.mockResolvedValue("current");

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.writeUpdateProgressMarkerMock).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({ state: "updating", targetVersion: "2.0.0" }),
    );
    expect(mocks.assertHostNotBusyMock).toHaveBeenCalledWith("production");
    // The SAME stop → relaunch pair `host restart` drives, force threaded
    // into the stop half (a cooperative stand-down here, not a kill).
    expect(mocks.stopHostForRestartWithAttemptMock).toHaveBeenCalledTimes(1);
    expect(mocks.stopHostForRestartWithAttemptMock.mock.calls[0][4]).toEqual({
      force: false,
    });
    expect(mocks.relaunchHostAfterRestartWithAttemptMock).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.probeHostHealthMock).toHaveBeenCalledTimes(1);
    // The clear is CONDITIONAL on the marker still being the one this
    // invocation wrote - a third updater's `updating`, written before it
    // waits for the lock, must survive this command's exit.
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({ state: "updating" }),
    );
    expect(mocks.applyHostMock).not.toHaveBeenCalled();
    const projected = projectInstallResultLikeDesktop(result.data);
    expect(projected.previousVersion).toBe("1.0.0");
    expect(projected.version).toBe("2.0.0");
    expect(projected.serviceLifecycle).toEqual({
      priorServiceState: "running",
      stoppedBeforeSwap: false,
      postSwapAction: "restart",
      postSwapError: null,
    });
    expect(result.human).toContain("updated host 1.0.0 → 2.0.0");
  });

  it("debt cleared while waiting for the contender lock: no restart, projected as the no-op", async () => {
    // First read (outside the lock): the host runs 1.0.0 behind a 2.0.0
    // record. Second read (under the lock): another actor - Desktop's
    // parked-registration fallback runs `host restart` on this very host -
    // has already brought 2.0.0 up. Restarting again would cost the fresh
    // host its connections and report a transition this command did not make.
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock
      .mockResolvedValueOnce(pidRecord("1.0.0", 4242))
      .mockResolvedValue(pidRecord("2.0.0", 4343));
    mocks.identityVerdictMock.mockResolvedValue("current");

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.readHostPidMetadataMock).toHaveBeenCalledTimes(2);
    expect(mocks.stopHostForRestartWithAttemptMock).not.toHaveBeenCalled();
    const projected = projectInstallResultLikeDesktop(result.data);
    expect(projected.previousVersion).toBe("2.0.0");
    expect(projected.version).toBe("2.0.0");
    expect(result.human).toContain("no-op");
  });

  it("debt cleared under the lock while the health probe would FAIL: no probe, no failed marker, the updating marker is cleared, exit 0", async () => {
    // The marker was written pre-lock because work was owed then; the work
    // was paid by another actor under the lock. Probing a host this command
    // never touched, and stamping the no-op `failed` on a miss, would report
    // a failure for an update that did not happen. The stale `updating`
    // marker still has to go.
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock
      .mockResolvedValueOnce(pidRecord("1.0.0", 4242))
      .mockResolvedValue(pidRecord("2.0.0", 4343));
    mocks.identityVerdictMock.mockResolvedValue("current");
    mocks.probeHostHealthMock.mockResolvedValue({
      healthy: false,
      detail: "tcp refused",
    });

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.probeHostHealthMock).not.toHaveBeenCalled();
    expect(mocks.writeUpdateProgressMarkerMock).toHaveBeenCalledTimes(1);
    expect(mocks.writeUpdateProgressMarkerMock).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({ state: "updating" }),
    );
    // The clear is CONDITIONAL on the marker still being the one this
    // invocation wrote - a third updater's `updating`, written before it
    // waits for the lock, must survive this command's exit.
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({ state: "updating" }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.human).toContain("no-op");
  });

  it("debt cleared while waiting and a THIRD updater has since written its own marker: the clear is asked with exactly the marker this run wrote, and a `changed` answer leaves the third updater's marker alone", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock
      .mockResolvedValueOnce(pidRecord("1.0.0", 4242))
      .mockResolvedValue(pidRecord("2.0.0", 4343));
    // The primitive reports the marker is no longer ours.
    mocks.deleteUpdateProgressMarkerIfUnchangedMock.mockResolvedValue(
      "changed",
    );

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.writeUpdateProgressMarkerMock).toHaveBeenCalledTimes(1);
    const written = mocks.writeUpdateProgressMarkerMock.mock.calls[0][1];
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledTimes(1);
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock.mock.calls[0][1],
    ).toEqual(written);
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(mocks.stopHostForRestartWithAttemptMock).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it("this run FAILS while a third updater's marker has replaced ours: the failure is not stamped over the other updater's live marker", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue(pidRecord("1.0.0", 4242));
    mocks.assertHostNotBusyMock.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: "host is busy",
        details: {},
        exitCode: 1,
      }),
    );
    // By the time the failure is stamped, a third updater has already
    // landed its own `updating` at the live path - the compare-and-swap
    // reports "changed" and leaves it alone rather than stamping over it.
    mocks.replaceUpdateProgressMarkerIfUnchangedMock.mockResolvedValue(
      "changed",
    );

    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_BUSY });

    // Our own `updating` was written once; no unconditional `failed` write
    // ever happens - the failure goes through the compare-and-swap instead,
    // and a "changed" answer means it never landed.
    expect(mocks.writeUpdateProgressMarkerMock).toHaveBeenCalledTimes(1);
    const written = mocks.writeUpdateProgressMarkerMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(written.state).toBe("updating");
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      written,
      expect.objectContaining({ state: "failed" }),
    );
  });

  it("the install record moves while waiting for the lock: the restart activates the record as read UNDER the lock and the marker is re-pointed at it", async () => {
    // Pre-lock the record says 2.0.0 (marker target 2.0.0). Another contender
    // installs 2.1.0 before this command is admitted. The under-lock read is
    // what gets activated and what a `failed` stamp would have to name.
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock
      .mockResolvedValueOnce(sampleRecord("2.0.0"))
      .mockResolvedValue(sampleRecord("2.1.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue(pidRecord("1.0.0", 4242));
    mocks.identityVerdictMock.mockResolvedValue("current");

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    const markerTargets = mocks.writeUpdateProgressMarkerMock.mock.calls.map(
      (call) => {
        const progress = call[1] as { targetVersion: string; state: string };
        return `${progress.state}:${progress.targetVersion}`;
      },
    );
    expect(markerTargets).toEqual(["updating:2.0.0", "updating:2.1.0"]);
    expect(mocks.stopHostForRestartWithAttemptMock).toHaveBeenCalledTimes(1);
    expect(mocks.probeHostHealthMock).toHaveBeenCalledTimes(1);
    const projected = projectInstallResultLikeDesktop(result.data);
    expect(projected.previousVersion).toBe("1.0.0");
    expect(projected.version).toBe("2.1.0");
    expect(result.human).toContain("updated host 1.0.0 → 2.1.0");
  });

  it("the running host VANISHES under the lock (pid gone, not replaced): relaunched through the stop → relaunch pair, busy gate not asked, health probed, reported as the update", async () => {
    // Pre-lock: 1.0.0 serving behind a 2.0.0 record. Under the lock: no pid
    // metadata at all - the old host exited, crashed, or is mid-relaunch and
    // has not republished. That is not cleared debt; reporting the no-op
    // would skip the probe, clear the marker and exit 0 over a host that may
    // never come back.
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock
      .mockResolvedValueOnce(pidRecord("1.0.0", 4242))
      .mockResolvedValue(null);
    mocks.identityVerdictMock.mockResolvedValue("current");

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.assertHostNotBusyMock).not.toHaveBeenCalled();
    expect(mocks.stopHostForRestartWithAttemptMock).toHaveBeenCalledTimes(1);
    expect(mocks.relaunchHostAfterRestartWithAttemptMock).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.probeHostHealthMock).toHaveBeenCalledTimes(1);
    // The clear is CONDITIONAL on the marker still being the one this
    // invocation wrote - a third updater's `updating`, written before it
    // waits for the lock, must survive this command's exit.
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({ state: "updating" }),
    );
    const projected = projectInstallResultLikeDesktop(result.data);
    expect(projected.previousVersion).toBe("1.0.0");
    expect(projected.version).toBe("2.0.0");
    expect(projected.serviceLifecycle.postSwapAction).toBe("restart");
  });

  it("no work owed and the running host is OBSERVED at the installed version: a stale `failed` marker is cleared", async () => {
    // A prior update's health probe timed out on a host that finished
    // starting a moment later; the marker still says `failed` and every
    // @1.3 host renders it. The retry has nothing to do, so this is the only
    // place that can reconcile it - and only against an observed match.
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue(pidRecord("2.0.0", 4242));
    mocks.identityVerdictMock.mockResolvedValue("current");
    mocks.readUpdateProgressMarkerMock.mockResolvedValue({
      state: "failed",
      error: "host did not become healthy: tcp refused",
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.stopHostForRestartWithAttemptMock).not.toHaveBeenCalled();
    expect(mocks.writeUpdateProgressMarkerMock).not.toHaveBeenCalled();
    // CONDITIONAL on the marker still being the `failed` record that was
    // read - never the unconditional delete, which would erase a live
    // `updating` another updater wrote in between.
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({ state: "failed", targetVersion: "2.0.0" }),
    );
    expect(result.human).toContain("no-op");
  });

  it("pid.json names a RECYCLED pid (identity verdict `mismatch`): not a live host - no debt, no restart, and a `failed` marker is NOT cleared", async () => {
    // The pid survived a crash and the OS handed it to an unrelated process.
    // Bare liveness would call that occupant the host: with the recorded
    // 1.0.0 that reads as debt (and the busy gate then fails against a stale
    // endpoint); with a matching version it would clear a `failed` marker
    // over no host at all. The published identity verdict rules it out.
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue(pidRecord("2.0.0", 4242));
    mocks.identityVerdictMock.mockResolvedValue("mismatch");
    mocks.readUpdateProgressMarkerMock.mockResolvedValue({
      state: "failed",
      error: "host did not become healthy: tcp refused",
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.identityVerdictMock).toHaveBeenCalledWith(4242, null);
    expect(mocks.stopHostForRestartWithAttemptMock).not.toHaveBeenCalled();
    expect(mocks.assertHostNotBusyMock).not.toHaveBeenCalled();
    expect(mocks.writeUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(result.human).toContain("no-op");
  });

  it("identity verdict `indeterminate` (a pid.json that predates the stamp): the host is KEPT - debt is still detected and activated", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue(pidRecord("1.0.0", 4242));
    mocks.identityVerdictMock.mockResolvedValue("indeterminate");

    await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.stopHostForRestartWithAttemptMock).toHaveBeenCalledTimes(1);
  });

  it("no work owed but the host is DOWN: a `failed` marker is left alone - it may still be exactly true", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue(null);
    mocks.readUpdateProgressMarkerMock.mockResolvedValue({
      state: "failed",
      error: "host did not become healthy: tcp refused",
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
    expect(mocks.stopHostForRestartWithAttemptMock).not.toHaveBeenCalled();
  });

  it("no work owed and an `updating` marker (another updater in flight): left alone", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue(pidRecord("2.0.0", 4242));
    mocks.identityVerdictMock.mockResolvedValue("current");
    mocks.readUpdateProgressMarkerMock.mockResolvedValue({
      state: "updating",
      error: null,
      targetVersion: "2.1.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
  });

  it("debt cleared under the lock on a BUSY host: still the no-op - the busy gate is never consulted and no failed marker is written", async () => {
    // The host that came up on the committed bytes while this command
    // waited is already doing work. It owes nothing, so its busyness is not
    // a reason to fail the command: the debt decision runs before the gate.
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock
      .mockResolvedValueOnce(pidRecord("1.0.0", 4242))
      .mockResolvedValue(pidRecord("2.0.0", 4343));
    mocks.identityVerdictMock.mockResolvedValue("current");
    mocks.assertHostNotBusyMock.mockRejectedValue(
      new Error("host is busy: 1 live session"),
    );

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.assertHostNotBusyMock).not.toHaveBeenCalled();
    expect(mocks.stopHostForRestartWithAttemptMock).not.toHaveBeenCalled();
    expect(mocks.writeUpdateProgressMarkerMock).not.toHaveBeenCalledWith(
      "production",
      expect.objectContaining({ state: "failed" }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.human).toContain("no-op");
  });

  it("running already equal to the install record: old no-op contract, no restart, no marker", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue(pidRecord("2.0.0", 4242));
    mocks.identityVerdictMock.mockResolvedValue("current");

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.stopHostForRestartWithAttemptMock).not.toHaveBeenCalled();
    expect(mocks.writeUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(result.human).toContain("no-op");
  });

  it("pid record present but the process is dead: no debt, old no-op contract", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue(pidRecord("1.0.0", 4242));
    mocks.identityVerdictMock.mockResolvedValue("dead");

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.stopHostForRestartWithAttemptMock).not.toHaveBeenCalled();
    expect(mocks.writeUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(result.human).toContain("no-op");
  });

  it("an incomparable running version (e.g. a local-* build): no debt, old no-op contract", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue(
      pidRecord("local-abc123", 4242),
    );
    mocks.identityVerdictMock.mockResolvedValue("current");

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.stopHostForRestartWithAttemptMock).not.toHaveBeenCalled();
    expect(mocks.writeUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(result.human).toContain("no-op");
  });

  it("downgrade-shaped debt (running AHEAD of the install record) still activates - either direction of inequality counts", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("1.9.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.9.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue(pidRecord("2.0.0", 4242));
    mocks.identityVerdictMock.mockResolvedValue("current");

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.stopHostForRestartWithAttemptMock).toHaveBeenCalledTimes(1);
    const projected = projectInstallResultLikeDesktop(result.data);
    expect(projected.previousVersion).toBe("2.0.0");
    expect(projected.version).toBe("1.9.0");
    expect(result.human).toContain("updated host 2.0.0 → 1.9.0");
  });

  it("--force skips the busy assertion but still restarts", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue(pidRecord("1.0.0", 4242));
    mocks.identityVerdictMock.mockResolvedValue("current");

    await buildHostUpdateCommand({
      force: true,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.assertHostNotBusyMock).not.toHaveBeenCalled();
    // `--force` reaches the stop half, not only the busy pre-check: a busy
    // Desktop-managed host denies the cooperative stand-down claim, and
    // `host update --force` promises to force-stop it - the recovery case
    // this path exists for.
    expect(mocks.stopHostForRestartWithAttemptMock).toHaveBeenCalledTimes(1);
    expect(mocks.stopHostForRestartWithAttemptMock.mock.calls[0][4]).toEqual({
      force: true,
    });
    expect(mocks.relaunchHostAfterRestartWithAttemptMock).toHaveBeenCalledTimes(
      1,
    );
  });

  it("the record carries a runtime stamp: debt is decided by runtime-stamp EQUALITY, not by SemVer on the catalog version", async () => {
    // An older CLI installing a newer archive records the archive's own
    // runtime version beside the catalog version it was asked for. The host
    // publishes the RUNTIME version in pid.json, so comparing it against the
    // catalog version would restart a correctly activated host forever.
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue({
      ...sampleRecord("2.0.0"),
      runtimeVersion: "2.0.1",
    });
    mocks.readHostPidMetadataMock.mockResolvedValue(pidRecord("2.0.1", 4242));
    mocks.identityVerdictMock.mockResolvedValue("current");

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.stopHostForRestartWithAttemptMock).not.toHaveBeenCalled();
    expect(mocks.writeUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(result.human).toContain("no-op");
  });

  it("the record carries a runtime stamp the running host does not match: debt, even when the catalog versions would compare equal", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue({
      ...sampleRecord("2.0.0"),
      runtimeVersion: "2.0.0",
    });
    // Same catalog identity, different runtime stamp: the committed archive
    // is not what is running.
    mocks.readHostPidMetadataMock.mockResolvedValue(
      pidRecord("2.0.0-rc.3", 4242),
    );
    mocks.identityVerdictMock.mockResolvedValue("current");

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.stopHostForRestartWithAttemptMock).toHaveBeenCalledTimes(1);
    const projected = projectInstallResultLikeDesktop(result.data);
    expect(projected.previousVersion).toBe("2.0.0-rc.3");
    expect(projected.version).toBe("2.0.0");
  });

  it("the host is busy: assertHostNotBusy rejects, the marker is left failed, and restart never runs", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue(pidRecord("1.0.0", 4242));
    mocks.identityVerdictMock.mockResolvedValue("current");
    mocks.assertHostNotBusyMock.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: "The running host has work in progress",
        details: null,
        exitCode: 1,
      }),
    );

    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_BUSY });

    expect(mocks.stopHostForRestartWithAttemptMock).not.toHaveBeenCalled();
    expect(mocks.writeUpdateProgressMarkerMock).toHaveBeenCalledTimes(1);
    const written = mocks.writeUpdateProgressMarkerMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      written,
      expect.objectContaining({ state: "failed", targetVersion: "2.0.0" }),
    );
  });

  it("the health probe fails after activation: rejects the health-check error, marks the marker failed, and never clears it", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue(pidRecord("1.0.0", 4242));
    mocks.identityVerdictMock.mockResolvedValue("current");
    mocks.probeHostHealthMock.mockResolvedValue({
      healthy: false,
      detail: "port never accepted a connection",
    });

    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
    });

    expect(mocks.stopHostForRestartWithAttemptMock).toHaveBeenCalledTimes(1);
    expect(mocks.writeUpdateProgressMarkerMock).toHaveBeenCalledTimes(1);
    const written = mocks.writeUpdateProgressMarkerMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      written,
      expect.objectContaining({
        state: "failed",
        error: "port never accepted a connection",
      }),
    );
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
  });
});
