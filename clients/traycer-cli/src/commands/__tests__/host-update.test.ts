import { afterEach, describe, expect, it, vi } from "vitest";

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
  readHostStagedRecordMock: vi.fn(),
  readHostInstallRecordMock: vi.fn(),
  // Cross-mock ordering timeline for the Finding 8 test below (ticket-2
  // review round 1) - a SHARED array `withCliLock` and
  // `readHostStagedRecord` both push into, so a single assertion can pin
  // whether the staged-record read genuinely happened BEFORE lock-exit
  // (inside the same lock span the busy decision was made under) rather
  // than after it.
  callOrder: [] as string[],
}));

vi.mock("../../installer/download-stage", () => ({
  downloadAndStageHost: mocks.downloadAndStageHostMock,
}));

vi.mock("../../installer/apply", () => ({
  applyHost: mocks.applyHostMock,
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

describe("buildHostUpdateCommand composite", () => {
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

    const command = buildHostUpdateCommand({ force: false });
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

    const command = buildHostUpdateCommand({ force: false });
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

    const command = buildHostUpdateCommand({ force: false });
    await command(fakeCtx());

    expect(mocks.downloadAndStageHostMock).toHaveBeenCalledWith({
      environment: "production",
      versionRequest: null,
      automatic: false,
      onProgress: expect.any(Function),
      registryClient: null,
    });
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

    const command = buildHostUpdateCommand({ force: false });
    const result = await command(fakeCtx());

    expect(mocks.applyHostMock).toHaveBeenCalledWith({
      environment: "production",
      force: false,
      noService: false,
      expectedStageFingerprint: null,
      onProgress: expect.any(Function),
    });
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

    const command = buildHostUpdateCommand({ force: false });
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

    const command = buildHostUpdateCommand({ force: true });
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

    const command = buildHostUpdateCommand({ force: false });
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

    const command = buildHostUpdateCommand({ force: false });
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

    const command = buildHostUpdateCommand({ force: false });
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

    const command = buildHostUpdateCommand({ force: false });
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

    const command = buildHostUpdateCommand({ force: false });
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

    const command = buildHostUpdateCommand({ force: false });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
    });
    expect(mocks.applyHostMock).not.toHaveBeenCalled();
  });
});
