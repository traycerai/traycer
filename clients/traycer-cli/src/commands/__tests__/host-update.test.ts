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
  //
  // The pre-lock publish primitive (`host-update.ts`'s `publishUpdating`
  // calls this, never `writeUpdateProgressMarker` - that unconditional write
  // has no production caller left).
  claimUpdateProgressMarkerBeforeLockMock: vi.fn(),
  deleteUpdateProgressMarkerMock: vi.fn(),
  readUpdateProgressMarkerMock: vi.fn(),
  deleteUpdateProgressMarkerIfUnchangedMock: vi.fn(),
  replaceUpdateProgressMarkerIfUnchangedMock: vi.fn(),
  createUpdateProgressMarkerIfAbsentMock: vi.fn(),
  updateProgressRecordHasLiveWriterMock: vi.fn(),
  // The writerIds `armActivationDefaults`'s `updateProgressRecordHasLiveWriterMock`
  // wiring treats as dead - a fixture DECIDES liveness explicitly rather than
  // shelling out to a real `isProcessAlive`. Reset per test by
  // `armActivationDefaults` itself.
  deadWriterIds: new Set<string>(),
  probeHostHealthMock: vi.fn(),
  readHostPidMetadataMock: vi.fn(),
  identityVerdictMock: vi.fn(),
  assertHostNotBusyMock: vi.fn(),
  stopHostForRestartWithAttemptMock: vi.fn(),
  relaunchHostAfterRestartWithAttemptMock: vi.fn(),
  // The fixture's model of the on-disk marker file. `armActivationDefaults`
  // wires the four marker primitives above to read/write/CAS against this
  // single holder, so `reassertMarkerUnderLock`'s "is the disk still ours"
  // decisions see a coherent file instead of the four mocks disagreeing with
  // each other. A plain field (not a `vi.fn()`), reset per test by
  // `armActivationDefaults` itself.
  disk: { current: null } as {
    current:
      | import("../../host/update-progress-marker").HostUpdateProgress
      | null;
  },
}));

vi.mock("../../host/update-progress-marker", () => ({
  claimUpdateProgressMarkerBeforeLock:
    mocks.claimUpdateProgressMarkerBeforeLockMock,
  deleteUpdateProgressMarker: mocks.deleteUpdateProgressMarkerMock,
  readUpdateProgressMarker: mocks.readUpdateProgressMarkerMock,
  deleteUpdateProgressMarkerIfUnchanged:
    mocks.deleteUpdateProgressMarkerIfUnchangedMock,
  replaceUpdateProgressMarkerIfUnchanged:
    mocks.replaceUpdateProgressMarkerIfUnchangedMock,
  createUpdateProgressMarkerIfAbsent:
    mocks.createUpdateProgressMarkerIfAbsentMock,
  updateProgressRecordHasLiveWriter:
    mocks.updateProgressRecordHasLiveWriterMock,
  progressRecord: (fields: {
    state: "updating" | "failed";
    error: string | null;
    targetVersion: string;
  }): HostUpdateProgress => ({
    ...fields,
    updatedAt: new Date().toISOString(),
    writerId: "test-writer",
  }),
  // Pure comparator; the real one, so the "is this marker still ours"
  // decisions under test compare the way production does.
  sameProgress: (
    a: {
      state: string;
      targetVersion: string;
      updatedAt: string;
      error: string | null;
      writerId: string | null;
    },
    b: {
      state: string;
      targetVersion: string;
      updatedAt: string;
      error: string | null;
      writerId: string | null;
    },
  ) =>
    a.state === b.state &&
    a.targetVersion === b.targetVersion &&
    a.updatedAt === b.updatedAt &&
    a.error === b.error &&
    a.writerId === b.writerId,
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
import type {
  DownloadAndStageHostOptions,
  HostDownloadOutcome,
} from "../../installer/download-stage";
import type { ApplyHostOptions, ApplyHostOutcome } from "../../installer/apply";
import type {
  HostUpdateProgress,
  UpdateProgressMarkerClaim,
} from "../../host/update-progress-marker";
// Value import (not type-only): the module is mocked above, and that mock
// factory defines `sameProgress` as the REAL comparator (not a `vi.fn()`), so
// this import gets production comparison logic - the same test double the
// mocked `../../host/update-progress-marker` module hands the CLI code under
// test. Used by `armActivationDefaults`'s disk fixture below to decide CAS
// outcomes the way the real marker module would.
import { sameProgress } from "../../host/update-progress-marker";

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
//
// The four marker primitives are wired to `mocks.disk` - a single fixture
// modeling the on-disk marker file - rather than given independent canned
// return values. `reassertMarkerUnderLock` (host-update.ts) reads the disk,
// compares it against the marker THIS run wrote, and CAS-replaces or CAS-
// deletes it; a `readUpdateProgressMarker` that always answers `null`
// (the old default) makes every under-lock reassertion see an "empty disk"
// and republish over its own still-live marker - a write this run did not
// intend and tests must not double-count. A test that needs to simulate a
// FOREIGN writer or a lost CAS race still overrides the individual mock
// (`.mockResolvedValue(...)` on top of this wiring) exactly as before; that
// override wins for that call and simply does not touch `mocks.disk`.
function armActivationDefaults(): void {
  mocks.disk.current = null;
  mocks.deadWriterIds = new Set<string>();
  mocks.readUpdateProgressMarkerMock.mockImplementation(
    async () => mocks.disk.current,
  );
  // The real rule shape (`updateProgressRecordHasLiveWriter`,
  // `update-progress-marker.ts`): a `failed` has no writer by construction,
  // and an `updating` is live unless the test has declared its writer dead
  // in `mocks.deadWriterIds` - a fixture decides liveness explicitly rather
  // than shelling out to a real `isProcessAlive`.
  mocks.updateProgressRecordHasLiveWriterMock.mockImplementation(
    (record: HostUpdateProgress) =>
      record.state !== "failed" &&
      (record.writerId === null || !mocks.deadWriterIds.has(record.writerId)),
  );
  // Pre-lock claim: models the SAME rule `claimUpdateProgressMarkerBeforeLock`
  // applies against a real disk (see its production doc comment) - published
  // into an empty path, deferred (nothing written) otherwise against a live
  // writer's record. A test that needs "replaced-stale" or "failed"
  // overrides this mock directly; that override wins for its call and does
  // not touch `mocks.disk`.
  mocks.claimUpdateProgressMarkerBeforeLockMock.mockImplementation(
    async (
      _environment: string,
      next: HostUpdateProgress,
    ): Promise<UpdateProgressMarkerClaim> => {
      if (mocks.disk.current === null) {
        mocks.disk.current = next;
        return { outcome: "published" };
      }
      return { outcome: "deferred" };
    },
  );
  mocks.replaceUpdateProgressMarkerIfUnchangedMock.mockImplementation(
    async (
      _environment: string,
      expected: HostUpdateProgress,
      next: HostUpdateProgress,
    ) => {
      if (
        mocks.disk.current !== null &&
        sameProgress(mocks.disk.current, expected)
      ) {
        mocks.disk.current = next;
        return "replaced";
      }
      return "changed";
    },
  );
  mocks.deleteUpdateProgressMarkerIfUnchangedMock.mockImplementation(
    async (_environment: string, expected: HostUpdateProgress) => {
      if (mocks.disk.current === null) return "absent";
      if (sameProgress(mocks.disk.current, expected)) {
        mocks.disk.current = null;
        return "cleared";
      }
      return "changed";
    },
  );
  // Create-if-absent: `"exists"` when the fixture already holds a marker
  // (the live path is not empty), else stores `next` and reports
  // `"created"` - mirrors the real module's create-vs-refuse contract
  // against the same shared disk fixture the other four primitives use.
  mocks.createUpdateProgressMarkerIfAbsentMock.mockImplementation(
    async (_environment: string, next: HostUpdateProgress) => {
      if (mocks.disk.current !== null) return "exists";
      mocks.disk.current = next;
      return "created";
    },
  );
  mocks.readHostPidMetadataMock.mockResolvedValue(null);
  mocks.identityVerdictMock.mockResolvedValue("current");
  mocks.assertHostNotBusyMock.mockResolvedValue(undefined);
  // Models the facade's boundary: the capability check passed and the
  // actuator is about to stop the host, so `onAuthorityVerified` fires
  // before the (mock) stop returns. A test that needs the check to FAIL
  // rejects WITHOUT calling it.
  mocks.stopHostForRestartWithAttemptMock.mockImplementation(
    async (
      _capability: unknown,
      _contenderOptions: unknown,
      _controller: unknown,
      _label: unknown,
      _options: unknown,
      onAuthorityVerified: (() => void) | null,
    ) => {
      onAuthorityVerified?.();
      return { forcedRecycle: false };
    },
  );
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
      onWillDownload: expect.any(Function),
      // The legacy command drives no attempt record: no verified-bytes
      // barrier, and no own attempt for the promotion guard to exempt.
      beforeExtract: expect.any(Function),
      ownAttempt: null,
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
      onBeforeCommit: expect.any(Function),
    });
    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledWith(
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
    // already mutated). Only the HOST_BUSY catch itself reads the staged
    // record now (for the error payload) - `applyAndProjectLegacy` no
    // longer pre-reads it before `applyHost`, so there is exactly ONE read.
    expect(mocks.callOrder).toEqual(["lock-enter", "read-staged", "lock-exit"]);
  });

  it("propagates a non-busy applyHost error unchanged, without reading the staged record", async () => {
    // Falsification: read the staged record in the generic (non-HOST_BUSY)
    // catch arm, or pre-read it before calling `applyHost`, and
    // `readHostStagedRecordMock` below is called.
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

// The stage this run promoted before it waited for the contender lock can
// be consumed by another actor - Desktop's launch converge runs
// `host apply --no-service`, which commits the bytes and restarts nothing -
// by the time this run holds the lock. `applyHost` then reports the no-op
// it saw (`needsApply && !apply.applied`), and the command re-derives
// `readActivationState` UNDER the same "only `debt` is a reason to act"
// rule the pre-lock check applies (see `ActivationReading`'s doc comment:
// "before the lock, only `debt` is a reason to act"). These pin every
// reading that rule can land on.
describe("buildHostUpdateCommand — stage consumed by another actor while waiting", () => {
  beforeEach(() => {
    mocks.probeHostHealthMock.mockResolvedValue({
      healthy: true,
      detail: "ok",
    });
    armActivationDefaults();
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "promoted",
      stagedVersion: "2.0.0",
      installedVersion: "1.0.0",
    } satisfies HostDownloadOutcome);
    // The stage was consumed by the time this run holds the lock.
    mocks.readHostStagedRecordMock.mockResolvedValue(null);
    mocks.applyHostMock.mockResolvedValue({
      outcome: "no-op",
      installedVersion: "2.0.0",
    } satisfies ApplyHostOutcome);
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
  });

  afterEach(() => {
    vi.resetAllMocks();
    mocks.callOrder = [];
  });

  function pidAt(version: string): {
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
      pid: 4242,
      hostId: "host-1",
      version,
      websocketUrl: "ws://127.0.0.1:51820/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: null,
      layer0: null,
      layer0Slot: null,
    };
  }

  it("reading DEBT: activates the committed install instead of reporting a false no-op", async () => {
    // Falsification: gate the re-derived activation on any predicate other
    // than `reading.kind === "debt"` (e.g. `!== "no-install"`) and this
    // still passes for the right reason but the `activated`/`no-live-host`
    // pins below would then wrongly activate too.
    mocks.readHostPidMetadataMock.mockResolvedValue(pidAt("1.0.0"));
    mocks.identityVerdictMock.mockResolvedValue("current");

    const ctx = fakeCtx();
    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(ctx);

    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update found its stage consumed by another actor without activation; activating the committed install",
      expect.objectContaining({
        environment: "production",
        installedVersion: "2.0.0",
        runningVersion: "1.0.0",
      }),
    );
    expect(mocks.stopHostForRestartWithAttemptMock).toHaveBeenCalledTimes(1);
    expect(mocks.relaunchHostAfterRestartWithAttemptMock).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.probeHostHealthMock).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    expect(result.human).toContain("updated host 1.0.0 → 2.0.0");
  });

  it("reading ACTIVATED: no activation, no probe - the running host already matches the record", async () => {
    // Falsification: widen the re-derived guard to also cover `activated`
    // and the activation arm fires despite the running host already
    // matching the install record.
    mocks.readHostPidMetadataMock.mockResolvedValue(pidAt("2.0.0"));
    mocks.identityVerdictMock.mockResolvedValue("current");

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.stopHostForRestartWithAttemptMock).not.toHaveBeenCalled();
    expect(
      mocks.relaunchHostAfterRestartWithAttemptMock,
    ).not.toHaveBeenCalled();
    expect(mocks.probeHostHealthMock).not.toHaveBeenCalled();
    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", written);
    expect(result.exitCode).toBe(0);
    expect(result.human).toContain("host already at 2.0.0 (no-op)");
  });

  it("reading NO-LIVE-HOST: no activation, no probe - the out-of-lock rule is debt-only, same as the pre-lock check", async () => {
    // Per `ActivationReading`'s own doc comment: "before the lock, only
    // `debt` is a reason to act". This re-derived check runs OUT of the
    // lock too (the stage-consumed no-op was observed before this
    // command's own `withCliUpdateContender` call in the activation arm),
    // so it applies the SAME rule rather than a wider one that would also
    // fire on a host that is merely down.
    mocks.readHostPidMetadataMock.mockResolvedValue(null);

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.stopHostForRestartWithAttemptMock).not.toHaveBeenCalled();
    expect(
      mocks.relaunchHostAfterRestartWithAttemptMock,
    ).not.toHaveBeenCalled();
    expect(mocks.probeHostHealthMock).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it("raced-stage debt clears under the activation arm's own lock: activationClearedWhileWaiting is true, not activatedInstalled", async () => {
    // Falsification: revert the field to
    // `needsActivate && !activationPerformed` and it logs false - this
    // raced-stage debt never sets `needsActivate` (only the pre-lock
    // short-circuit does), so the old field would miss this case entirely.
    mocks.readHostPidMetadataMock
      .mockResolvedValueOnce(pidAt("1.0.0"))
      .mockResolvedValue(pidAt("2.0.0"));
    mocks.identityVerdictMock.mockResolvedValue("current");

    const ctx = fakeCtx();
    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(ctx);

    expect(mocks.stopHostForRestartWithAttemptMock).not.toHaveBeenCalled();
    expect(
      mocks.relaunchHostAfterRestartWithAttemptMock,
    ).not.toHaveBeenCalled();
    expect(mocks.probeHostHealthMock).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update command completed",
      expect.objectContaining({
        activatedInstalled: false,
        activationClearedWhileWaiting: true,
      }),
    );
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
    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledWith(
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

  it("the final clear could not be written: the update still succeeds, and the CLI logs why an `updating` outlives it", async () => {
    // Falsification: collapse "failed" into "changed" in the final-clear
    // branch and this log assertion goes red - "failed" is an I/O failure
    // on the delete itself, not a race with a third updater's marker.
    mocks.downloadAndStageHostMock.mockResolvedValue(promoted("2.0.0"));
    mocks.applyHostMock.mockResolvedValue(
      appliedOutcome("1.0.0", "2.0.0", null),
    );
    mocks.deleteUpdateProgressMarkerIfUnchangedMock.mockResolvedValue("failed");

    const ctx = fakeCtx();
    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(ctx);

    expect(result.exitCode).toBe(0);
    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update could not clear its progress marker; it stays until the next update supersedes it",
      { environment: "production" },
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

    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
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

    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
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
    expect(
      mocks.claimUpdateProgressMarkerBeforeLockMock,
    ).not.toHaveBeenCalled();
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
    // No install was touched, so there is nothing to health-check either.
    expect(mocks.probeHostHealthMock).not.toHaveBeenCalled();
  });

  it("keeps the update working when the marker write itself fails", async () => {
    // Falsification: read `ownMarker.current` as non-null after a "failed"
    // claim (`publishUpdating`'s `claim === "failed"` arm in host-update.ts
    // sets `ownMarker.current = null` silently) and the final clear below
    // would fire against a marker this run never actually landed.
    mocks.downloadAndStageHostMock.mockResolvedValue(promoted("2.0.0"));
    mocks.applyHostMock.mockResolvedValue(
      appliedOutcome("1.0.0", "2.0.0", null),
    );
    // `downloadAndStageHostMock` here is `mockResolvedValue`, not a
    // `mockImplementation` that invokes `onWillDownload` - so the pre-lock
    // claim this run actually makes is the post-prepare guard's
    // (`needsWork && ownMarker.current === null`), exactly once. It fails,
    // and `applyHostMock`'s default resolved value never invokes
    // `onWillCommitStaged`, so `reassertMarkerUnderLock` is never reached
    // under the lock either - `ownMarker.current` stays `null` end to end.
    mocks.claimUpdateProgressMarkerBeforeLockMock.mockResolvedValue({
      outcome: "failed",
    });

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    // Degraded remote progress reporting must not fail a local update.
    expect(result.exitCode).toBe(0);
    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    // Never a fact about the disk - a `failed` claim writes nothing - so the
    // final clear (gated on `ownMarker.current !== null`) never fires.
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
  });

  it("pre-lock claim defers to a live writer's marker", async () => {
    // Falsification: treat "deferred" like "published" in `publishUpdating`
    // (set `ownMarker.current = fresh` regardless of the claim result) and
    // the pre-lock write assertions below would see a record this run never
    // actually landed.
    const foreignRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "9.9.9",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "999999-abc",
    };
    mocks.disk.current = foreignRecord;
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        if (opts.onWillDownload === null) {
          throw new Error("expected onWillDownload to be provided");
        }
        await opts.onWillDownload("2.0.0");
        return promoted("2.0.0");
      },
    );
    mocks.applyHostMock.mockImplementation(async (opts: ApplyHostOptions) => {
      await opts.onWillCommitStaged?.("2.0.0");
      return appliedOutcome("1.0.0", "2.0.0", null);
    });

    const ctx = fakeCtx();
    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(ctx);

    // The claim is asked for a fresh `updating` record naming the download
    // target - the disk fixture's default wiring (`armActivationDefaults`)
    // answers "deferred" whenever it is non-null, exactly the fail-open rule
    // `claimUpdateProgressMarkerBeforeLock` applies to a live foreign writer.
    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({ state: "updating", targetVersion: "2.0.0" }),
    );
    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update left another updater's live progress marker in place; this run publishes its own once it holds the lock",
      expect.objectContaining({
        environment: "production",
        targetVersion: "2.0.0",
      }),
    );
    // Nothing was written pre-lock: the create-if-absent primitive is only
    // reached on an EMPTY disk, and the disk was never empty here.
    expect(mocks.createUpdateProgressMarkerIfAbsentMock).not.toHaveBeenCalled();
    // Under the lock, `own` is still null (the claim never landed anything),
    // so `reassertMarkerUnderLock` takes the foreign record over rather than
    // treating it as this run's own.
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      foreignRecord,
      expect.objectContaining({ state: "updating", targetVersion: "2.0.0" }),
    );
    const adopted = mocks.replaceUpdateProgressMarkerIfUnchangedMock.mock
      .calls[0][2] as HostUpdateProgress;
    // The final clear is CAS'd against the record adopted under the lock,
    // not against anything the pre-lock claim believed it held (it held
    // nothing).
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", adopted);
    expect(result.exitCode).toBe(0);
  });

  it("a lost download after a deferred claim lands its failure into the path the other writer has since cleared", async () => {
    // A download rejection that follows a deferred pre-lock claim still
    // reaches `markUpdateFailed`: the catch's `ownMarker.current === null`
    // branch (host-update.ts) stamps whenever `intendedTarget.current` was
    // announced, regardless of `disruptionStarted` - a download failure
    // happens strictly before any disruptive work, but the OTHER writer
    // this run deferred to may have finished and cleared its own marker
    // while this run was still downloading, leaving the path empty for
    // this run's failure to claim.
    //
    // Falsification: gate the null-record stamp on `disruptionStarted`
    // again and `createUpdateProgressMarkerIfAbsentMock` below is never
    // called - the catch would report nothing even though the announced
    // target ("2.0.0") never landed anywhere.
    const foreignRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "9.9.9",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    mocks.disk.current = foreignRecord;
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        if (opts.onWillDownload === null) {
          throw new Error("expected onWillDownload to be provided");
        }
        await opts.onWillDownload("2.0.0");
        // The other writer's clear, mid-download: the disk is empty by the
        // time this run's failure reaches `markUpdateFailed`.
        mocks.disk.current = null;
        throw new Error("download failed: ECONNRESET");
      },
    );

    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toThrow("download failed: ECONNRESET");

    // `ownMarker.current` was `null` (the claim deferred), so the stamp
    // lands by create-if-absent against the announced target, never a CAS.
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
    expect(mocks.createUpdateProgressMarkerIfAbsentMock).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({
        state: "failed",
        targetVersion: "2.0.0",
        error: "download failed: ECONNRESET",
      }),
    );
    // Create-if-absent against an EMPTY path succeeds - nothing to replace
    // or delete.
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
  });

  it("a lost download after a deferred claim stamps nothing over the other writer's still-live marker", async () => {
    // Same shape as above, but the other writer's marker is still on disk
    // when this run's failure reaches `markUpdateFailed`: the create-if-
    // absent primitive refuses to write over a live record, so the attempt
    // is made and reported, but nothing on disk changes.
    //
    // Falsification: gate the null-record stamp on `disruptionStarted`
    // again and `createUpdateProgressMarkerIfAbsentMock` below is never
    // called, and the "did not stamp its failure" log line never fires.
    const foreignRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "9.9.9",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    mocks.disk.current = foreignRecord;
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        if (opts.onWillDownload === null) {
          throw new Error("expected onWillDownload to be provided");
        }
        await opts.onWillDownload("2.0.0");
        throw new Error("download failed: ECONNRESET");
      },
    );

    const ctx = fakeCtx();
    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(ctx),
    ).rejects.toThrow("download failed: ECONNRESET");

    // The attempt is made exactly once - `armActivationDefaults`'s wiring
    // reports "exists" against a still-live disk and leaves it untouched.
    expect(mocks.createUpdateProgressMarkerIfAbsentMock).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.createUpdateProgressMarkerIfAbsentMock).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({
        state: "failed",
        targetVersion: "2.0.0",
        error: "download failed: ECONNRESET",
      }),
    );
    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update did not stamp its failure - the progress marker holds another record",
      expect.objectContaining({
        environment: "production",
        targetVersion: "2.0.0",
        outcome: "exists",
      }),
    );
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
    // The foreign record on disk is byte-identical afterwards - the refused
    // create-if-absent never touched it.
    expect(mocks.disk.current).toEqual(foreignRecord);
  });

  it("a lost download after a deferred claim stamps nothing when the running host is OBSERVED at the announced target", async () => {
    // `targetObservedRunning` (host-update.ts): the other writer this run
    // deferred to has already delivered - the install record names the
    // announced target and the live process is running it - so a `failed`
    // for that target would report a failure that did not happen, and
    // nothing short of the next no-work run's reconcile would ever clear
    // it.
    //
    // Falsification: drop the `targetObservedRunning` guard (stamp
    // whenever `intendedTarget.current !== null`, regardless of the
    // observed state) and the "not called" assertion below goes red.
    mocks.claimUpdateProgressMarkerBeforeLockMock.mockResolvedValue({
      outcome: "deferred",
    });
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        if (opts.onWillDownload === null) {
          throw new Error("expected onWillDownload to be provided");
        }
        await opts.onWillDownload("2.0.0");
        throw new Error("download failed: ECONNRESET");
      },
    );
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue({
      pid: 4242,
      hostId: "host-1",
      version: "2.0.0",
      websocketUrl: "ws://127.0.0.1:51820/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: null,
      layer0: null,
      layer0Slot: null,
    });
    mocks.identityVerdictMock.mockResolvedValue("current");

    const ctx = fakeCtx();
    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(ctx),
    ).rejects.toThrow("download failed: ECONNRESET");

    expect(mocks.createUpdateProgressMarkerIfAbsentMock).not.toHaveBeenCalled();
    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update did not stamp its failure - the running host has been observed at the target it announced",
      expect.objectContaining({
        environment: "production",
        targetVersion: "2.0.0",
      }),
    );
  });

  it("a lost download after a deferred claim still stamps when the running host is observed at an OLDER version", async () => {
    // Same shape as the pin above, but the observed match is against the
    // PREVIOUS version - the announced target ("2.0.0") was never actually
    // delivered, so the failure is real and must land.
    mocks.claimUpdateProgressMarkerBeforeLockMock.mockResolvedValue({
      outcome: "deferred",
    });
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        if (opts.onWillDownload === null) {
          throw new Error("expected onWillDownload to be provided");
        }
        await opts.onWillDownload("2.0.0");
        throw new Error("download failed: ECONNRESET");
      },
    );
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.0.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue({
      pid: 4242,
      hostId: "host-1",
      version: "1.0.0",
      websocketUrl: "ws://127.0.0.1:51820/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: null,
      layer0: null,
      layer0Slot: null,
    });
    mocks.identityVerdictMock.mockResolvedValue("current");

    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toThrow("download failed: ECONNRESET");

    expect(mocks.createUpdateProgressMarkerIfAbsentMock).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({
        state: "failed",
        targetVersion: "2.0.0",
        error: "download failed: ECONNRESET",
      }),
    );
  });

  it("a lost download after a deferred claim still stamps when the observed-state read itself fails - unreadable is not observed", async () => {
    // `targetObservedRunning` never throws past its own boundary: a reading
    // that cannot be taken (the install record read rejects) is "not
    // observed", so the failure lands rather than being silently swallowed
    // by an I/O error unrelated to the download.
    mocks.claimUpdateProgressMarkerBeforeLockMock.mockResolvedValue({
      outcome: "deferred",
    });
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        if (opts.onWillDownload === null) {
          throw new Error("expected onWillDownload to be provided");
        }
        await opts.onWillDownload("2.0.0");
        throw new Error("download failed: ECONNRESET");
      },
    );
    mocks.readHostInstallRecordMock.mockRejectedValue(
      new Error("EACCES: permission denied"),
    );

    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toThrow("download failed: ECONNRESET");

    expect(mocks.createUpdateProgressMarkerIfAbsentMock).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({
        state: "failed",
        targetVersion: "2.0.0",
        error: "download failed: ECONNRESET",
      }),
    );
  });

  it("a deferred run that disturbed the host and failed lands its failure into an empty path", async () => {
    // The other half of `markUpdateFailed`'s `ours === null` arm: a run that
    // never landed a marker of its own but DID disturb the host (the apply
    // reported `service-stop` before it failed) must still surface the
    // failure remotely - by creating a fresh `failed` record into whatever
    // empty path it finds, never by overwriting a live one.
    //
    // Falsification: gate the null-record stamp on `disruptionStarted`
    // instead of `intendedTarget.current !== null` and
    // `createUpdateProgressMarkerIfAbsentMock` below is still called here
    // (this run did disturb the host) - the distinction only shows up in
    // the two tests above, where disruption never started but a target was
    // still announced.
    const foreignRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    mocks.disk.current = foreignRecord;
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        if (opts.onWillDownload === null) {
          throw new Error("expected onWillDownload to be provided");
        }
        await opts.onWillDownload("2.0.0");
        return promoted("2.0.0");
      },
    );
    // The takeover under the lock itself fails (I/O) - `own` stays null.
    mocks.replaceUpdateProgressMarkerIfUnchangedMock.mockResolvedValue(
      "failed",
    );
    mocks.applyHostMock.mockImplementation(async (opts: ApplyHostOptions) => {
      await opts.onWillCommitStaged?.("2.0.0");
      opts.onProgress({
        stage: "service-stop",
        message: null,
        percent: null,
        bytes: null,
        totalBytes: null,
        workUnits: null,
      });
      throw new Error("commit failed");
    });

    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toThrow("commit failed");

    expect(mocks.createUpdateProgressMarkerIfAbsentMock).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({
        state: "failed",
        targetVersion: "2.0.0",
        error: "commit failed",
      }),
    );
    // Never a CAS against the foreign record - this run holds no marker of
    // its own to compare against.
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalledWith(
      "production",
      foreignRecord,
      expect.objectContaining({ state: "failed" }),
    );
  });

  it("a marker-less run whose apply succeeds but whose host never becomes healthy lands its failure into an empty path - `markUpdateFailed`'s `ours === null` arm, the health-probe call site", async () => {
    // The OTHER call site that can pass `markUpdateFailed` a `null` `ours`
    // (alongside the generic catch's `intendedTarget.current !== null`
    // arm): the post-apply health-probe failure passes `ownMarker.current`
    // unconditionally. Reached here by making BOTH pre-lock claims defer (a
    // live foreign writer never let go of the marker) while the apply
    // itself is mocked to succeed WITHOUT ever calling `onWillCommitStaged`,
    // so `reassertMarkerUnderLock` never runs and `ownMarker.current` is
    // still `null` when the probe fails.
    //
    // Falsification: revert `markUpdateFailed`'s `ours === null` arm to a
    // log-only no-op and `createUpdateProgressMarkerIfAbsentMock` below is
    // never called.
    mocks.claimUpdateProgressMarkerBeforeLockMock.mockResolvedValue({
      outcome: "deferred",
    });
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        if (opts.onWillDownload === null) {
          throw new Error("expected onWillDownload to be provided");
        }
        await opts.onWillDownload("2.0.0");
        return promoted("2.0.0");
      },
    );
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

    // `ours` was null, so the stamp lands by create-if-absent - never a CAS
    // against a record this run never held.
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
    expect(mocks.createUpdateProgressMarkerIfAbsentMock).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({
        state: "failed",
        targetVersion: "2.0.0",
        error: "port 8765 never accepted a connection",
      }),
    );
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
  });

  it("a deferred claim is retried after the download", async () => {
    // Falsification: gate the post-prepare guard on anything other than
    // `ownMarker.current === null` (e.g. on the download outcome alone) and
    // the second claim call below never happens - a run whose pre-lock claim
    // deferred would then reach the lock with no marker of its own even
    // though the other updater cleared meanwhile.
    mocks.claimUpdateProgressMarkerBeforeLockMock
      .mockResolvedValueOnce({ outcome: "deferred" })
      .mockImplementationOnce(
        async (
          _environment: string,
          next: HostUpdateProgress,
        ): Promise<UpdateProgressMarkerClaim> => {
          mocks.disk.current = next;
          return { outcome: "published" };
        },
      );
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        if (opts.onWillDownload === null) {
          throw new Error("expected onWillDownload to be provided");
        }
        await opts.onWillDownload("2.0.0");
        return promoted("2.0.0");
      },
    );
    // No `onWillCommitStaged` invocation: `ownMarker.current` is left exactly
    // as the second claim set it, so the final clear targets that record
    // directly rather than something re-pointed under the lock.
    mocks.applyHostMock.mockResolvedValue(
      appliedOutcome("1.0.0", "2.0.0", null),
    );

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      2,
    );
    expect(
      mocks.claimUpdateProgressMarkerBeforeLockMock.mock.calls[0][1],
    ).toEqual(
      expect.objectContaining({ state: "updating", targetVersion: "2.0.0" }),
    );
    const second = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[1][1] as HostUpdateProgress;
    expect(second).toEqual(
      expect.objectContaining({ state: "updating", targetVersion: "2.0.0" }),
    );
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", second);
    expect(result.exitCode).toBe(0);
  });

  it("a stale record is replaced by the pre-lock claim", async () => {
    // Falsification: treat "replaced-stale" like "deferred" in
    // `publishUpdating` (set `ownMarker.current = null`) and the final clear
    // assertion below would never fire - the run would believe it holds no
    // marker despite having just landed one by CAS.
    mocks.claimUpdateProgressMarkerBeforeLockMock.mockImplementation(
      async (
        _environment: string,
        next: HostUpdateProgress,
      ): Promise<UpdateProgressMarkerClaim> => {
        mocks.disk.current = next;
        return { outcome: "replaced-stale" };
      },
    );
    mocks.downloadAndStageHostMock.mockResolvedValue(promoted("2.0.0"));
    mocks.applyHostMock.mockResolvedValue(
      appliedOutcome("1.0.0", "2.0.0", null),
    );

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    // `downloadAndStageHostMock` here is `mockResolvedValue`, so the only
    // claim this run makes is the post-prepare guard's, exactly once.
    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(written.state).toBe("updating");
    expect(written.targetVersion).toBe("2.0.0");
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", written);
    expect(result.exitCode).toBe(0);
  });

  it("a stale `failed` replaced by the pre-lock claim is NOT put back when the run parks - own is withdrawn and the path is left empty", async () => {
    // `publishUpdating` no longer retains what a "replaced-stale" claim
    // replaced (`displacedMarker.current` stays null on every pre-lock
    // outcome - see its doc comment) - a `failed` no writer is acting on is
    // not this run's to restore. A park after a "replaced-stale" claim
    // therefore withdraws (deletes) this run's own record, same as any
    // other run that never took over a live writer's marker.
    //
    // Falsification: retain the claim's replaced record and restore it on
    // park (reintroduce `displacedMarker.current = claim.displaced`) and
    // the `replaceUpdateProgressMarkerIfUnchangedMock` "not called with the
    // stale record" assertion below goes red.
    const staleFailed: HostUpdateProgress = {
      state: "failed",
      error: "host did not become healthy: tcp refused",
      targetVersion: "1.9.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "dead-writer",
    };
    mocks.claimUpdateProgressMarkerBeforeLockMock.mockImplementation(
      async (
        _environment: string,
        next: HostUpdateProgress,
      ): Promise<UpdateProgressMarkerClaim> => {
        mocks.disk.current = next;
        return { outcome: "replaced-stale" };
      },
    );
    mocks.downloadAndStageHostMock.mockResolvedValue(promoted("2.0.0"));
    // Rejects busy WITHOUT ever calling `onWillCommitStaged` - the host is
    // never disturbed, so the park's withdrawal (not a `failed` stamp) is
    // what has to happen.
    mocks.applyHostMock.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: "The running host has work in progress",
        details: null,
        exitCode: 1,
      }),
    );
    mocks.readHostStagedRecordMock.mockResolvedValue(null);

    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_BUSY });

    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    // The park WITHDRAWS this run's own record - never a restore of the
    // stale `failed` the claim replaced.
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", written);
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalledWith("production", written, staleFailed);
    expect(mocks.disk.current).toBeNull();
  });

  it("a dead writer's `updating` replaced by the pre-lock claim is not re-planted by a busy park", async () => {
    // Same shape as the stale-`failed` pin above, for the OTHER kind of
    // stale record `updateProgressRecordHasLiveWriter` refuses to call
    // live: an `updating` whose writer process is gone. Putting it back on
    // a park would re-plant a marker no process will ever clear - a host
    // without dead-writer suppression would render "updating" forever.
    const deadWriterUpdating: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "1.9.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "424242-dead",
    };
    mocks.deadWriterIds.add("424242-dead");
    mocks.claimUpdateProgressMarkerBeforeLockMock.mockImplementation(
      async (
        _environment: string,
        next: HostUpdateProgress,
      ): Promise<UpdateProgressMarkerClaim> => {
        mocks.disk.current = next;
        return { outcome: "replaced-stale" };
      },
    );
    mocks.downloadAndStageHostMock.mockResolvedValue(promoted("2.0.0"));
    mocks.applyHostMock.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: "The running host has work in progress",
        details: null,
        exitCode: 1,
      }),
    );
    mocks.readHostStagedRecordMock.mockResolvedValue(null);

    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_BUSY });

    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", written);
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalledWith("production", written, deadWriterUpdating);
    expect(mocks.disk.current).toBeNull();
  });

  it("a retry whose download fails again stamps the NEW failure over its own record - the earlier `failed` is not restored", async () => {
    // The pre-disruption failure counterpart to the two park pins above: a
    // second failed attempt over a "replaced-stale" claim reports ITS OWN
    // cause via the `ownMarker.current !== null` CAS branch, never a
    // restore of the earlier attempt's `failed`.
    const staleFailed: HostUpdateProgress = {
      state: "failed",
      error: "host did not become healthy: tcp refused",
      targetVersion: "1.9.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "dead-writer",
    };
    mocks.claimUpdateProgressMarkerBeforeLockMock.mockImplementation(
      async (
        _environment: string,
        next: HostUpdateProgress,
      ): Promise<UpdateProgressMarkerClaim> => {
        mocks.disk.current = next;
        return { outcome: "replaced-stale" };
      },
    );
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        if (opts.onWillDownload === null) {
          throw new Error("expected onWillDownload to be provided");
        }
        await opts.onWillDownload("2.0.0");
        throw new Error("download failed again: ECONNRESET");
      },
    );

    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toThrow("download failed again: ECONNRESET");

    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      written,
      expect.objectContaining({
        state: "failed",
        error: "download failed again: ECONNRESET",
        targetVersion: "2.0.0",
      }),
    );
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalledWith("production", written, staleFailed);
  });

  it("a pre-disruption failure over this run's own record is WITHDRAWN when the running host is OBSERVED at the announced target", async () => {
    // The `ownMarker.current !== null` sibling of the null-arm
    // `targetObservedRunning` pins above: an actor that writes no marker at
    // all (`host apply --no-service`, Desktop's launch converge) can commit
    // and activate the very target this run announced underneath its OWN
    // live `updating`, consuming the shared stage its download then fails
    // on. The record describes an update another actor completed, so it is
    // WITHDRAWN, not stamped with a `failed` that would report a failure
    // that did not happen.
    //
    // Falsification: drop the `targetObservedRunning` check from this arm
    // (fall straight to the `else` stamp) and the "not called with a
    // failed record" assertion below goes red.
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        if (opts.onWillDownload === null) {
          throw new Error("expected onWillDownload to be provided");
        }
        await opts.onWillDownload("2.0.0");
        throw new Error("download failed: ECONNRESET");
      },
    );
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue({
      pid: 4242,
      hostId: "host-1",
      version: "2.0.0",
      websocketUrl: "ws://127.0.0.1:51820/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: null,
      layer0: null,
      layer0Slot: null,
    });
    mocks.identityVerdictMock.mockResolvedValue("current");

    const ctx = fakeCtx();
    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(ctx),
    ).rejects.toThrow("download failed: ECONNRESET");

    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", written);
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalledWith(
      "production",
      written,
      expect.objectContaining({ state: "failed" }),
    );
    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update failed before disturbing the host, and the running host has been observed at the target it announced; the progress marker was withdrawn",
      expect.objectContaining({
        environment: "production",
        outcome: "cleared",
      }),
    );
    expect(mocks.disk.current).toBeNull();
  });

  it("a pre-disruption failure over this run's own record still stamps `failed` when the observed version is OLDER", async () => {
    // Same shape as the pin above, but the observed match is against the
    // PREVIOUS version - the announced target was never actually
    // delivered by anyone else, so this run's own failure is real.
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        if (opts.onWillDownload === null) {
          throw new Error("expected onWillDownload to be provided");
        }
        await opts.onWillDownload("2.0.0");
        throw new Error("download failed: ECONNRESET");
      },
    );
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.0.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue({
      pid: 4242,
      hostId: "host-1",
      version: "1.0.0",
      websocketUrl: "ws://127.0.0.1:51820/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: null,
      layer0: null,
      layer0Slot: null,
    });
    mocks.identityVerdictMock.mockResolvedValue("current");

    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toThrow("download failed: ECONNRESET");

    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      written,
      expect.objectContaining({
        state: "failed",
        targetVersion: "2.0.0",
        error: "download failed: ECONNRESET",
      }),
    );
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
  });

  it("a failure AFTER disruption stamps `failed` over this run's own record even when the observed version matches the target - past the stop, whatever the host serves is reported", async () => {
    // The `targetObservedRunning` withdrawal is pre-disruption ONLY: once
    // `disruptionStarted` is true, this run's own stop/swap is what put the
    // host in whatever state it now serves, and its failure must be
    // reported regardless of an observed match.
    //
    // Falsification: drop the `!disruptionStarted` guard from the
    // observed-match arm and this pin's stamp assertion goes red - the
    // failure would be silently withdrawn instead.
    mocks.downloadAndStageHostMock.mockResolvedValue(promoted("2.0.0"));
    mocks.applyHostMock.mockImplementation(async (opts: ApplyHostOptions) => {
      await opts.onWillCommitStaged?.("2.0.0");
      opts.onProgress({
        stage: "service-stop",
        message: null,
        percent: null,
        bytes: null,
        totalBytes: null,
        workUnits: null,
      });
      throw new Error("commit failed");
    });
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue({
      pid: 4242,
      hostId: "host-1",
      version: "2.0.0",
      websocketUrl: "ws://127.0.0.1:51820/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: null,
      layer0: null,
      layer0Slot: null,
    });
    mocks.identityVerdictMock.mockResolvedValue("current");

    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toThrow("commit failed");

    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      written,
      expect.objectContaining({
        state: "failed",
        targetVersion: "2.0.0",
        error: "commit failed",
      }),
    );
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
  });

  it("the observed-match comparator ignores build metadata: 2.0.0+build.7 satisfies an announced 2.0.0", async () => {
    // `targetObservedRunning` uses `compareHostVersions` (the catalog-domain
    // comparator, same as `readActivationState`), not `===` - the installed
    // record's build metadata must not defeat a real match.
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        if (opts.onWillDownload === null) {
          throw new Error("expected onWillDownload to be provided");
        }
        await opts.onWillDownload("2.0.0");
        throw new Error("download failed: ECONNRESET");
      },
    );
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleRecord("2.0.0+build.7"),
    );
    mocks.readHostPidMetadataMock.mockResolvedValue({
      pid: 4242,
      hostId: "host-1",
      version: "2.0.0+build.7",
      websocketUrl: "ws://127.0.0.1:51820/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: null,
      layer0: null,
      layer0Slot: null,
    });
    mocks.identityVerdictMock.mockResolvedValue("current");

    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toThrow("download failed: ECONNRESET");

    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", written);
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalledWith(
      "production",
      written,
      expect.objectContaining({ state: "failed" }),
    );
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

    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledWith(
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
    //
    // This is also the raced-stage `debt` case for `activationClearedWhileWaiting`:
    // the activation arm was ENTERED (the pre-lock read saw debt) but its
    // under-lock re-read now says `activated`, so no activation is
    // performed. Falsification: revert the field to
    // `needsActivate && !activationPerformed` (both are true/false the same
    // way here, so a plain `needsActivate` read cannot tell this apart from
    // debt that was never entered - but `activationAttempted` can).
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock
      .mockResolvedValueOnce(pidRecord("1.0.0", 4242))
      .mockResolvedValue(pidRecord("2.0.0", 4343));
    mocks.identityVerdictMock.mockResolvedValue("current");

    const ctx = fakeCtx();
    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(ctx);

    expect(mocks.readHostPidMetadataMock).toHaveBeenCalledTimes(2);
    expect(mocks.stopHostForRestartWithAttemptMock).not.toHaveBeenCalled();
    const projected = projectInstallResultLikeDesktop(result.data);
    expect(projected.previousVersion).toBe("2.0.0");
    expect(projected.version).toBe("2.0.0");
    expect(result.human).toContain("no-op");
    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update command completed",
      expect.objectContaining({
        activatedInstalled: false,
        activationClearedWhileWaiting: true,
      }),
    );
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
    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledWith(
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

    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    const written =
      mocks.claimUpdateProgressMarkerBeforeLockMock.mock.calls[0][1];
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
    // A REAL failure under the lock - the stop half throws AFTER it has
    // reported the disruption boundary, the way the actuator does. Not a
    // busy refusal: that one is a park now (see "the host is busy" below)
    // and never reaches the failure stamp this test is about. And not a
    // capability refusal either - that rejects BEFORE the boundary and is
    // the subject of "the activation arm's stop refused by its capability
    // check" below.
    mocks.stopHostForRestartWithAttemptMock.mockImplementation(
      async (
        _capability: unknown,
        _contenderOptions: unknown,
        _controller: unknown,
        _label: unknown,
        _options: unknown,
        onAuthorityVerified: (() => void) | null,
      ) => {
        onAuthorityVerified?.();
        throw new Error("stop failed");
      },
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
    ).rejects.toThrow("stop failed");

    // Our own `updating` was written once; no unconditional `failed` write
    // ever happens - the failure goes through the compare-and-swap instead,
    // and a "changed" answer means it never landed.
    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
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

    // The pre-lock `updating:2.0.0` is published once, as a CLAIM: the
    // path was empty here, so the claim lands unconditionally against
    // nothing, but it still goes through the conditional
    // `claimUpdateProgressMarkerBeforeLock` primitive, never a blind write.
    // The re-point under the lock is ownership-aware too: it goes through
    // the compare-and-swap against that same pre-lock marker, never a
    // second unconditional write.
    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(written.state).toBe("updating");
    expect(written.targetVersion).toBe("2.0.0");
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      written,
      expect.objectContaining({ state: "updating", targetVersion: "2.1.0" }),
    );
    expect(mocks.stopHostForRestartWithAttemptMock).toHaveBeenCalledTimes(1);
    expect(mocks.probeHostHealthMock).toHaveBeenCalledTimes(1);
    // The compare-and-swap reports "replaced" by default, so the marker this
    // run tracks follows the re-pointed record - the final clear targets the
    // MOVED version, not the stale pre-lock one.
    const repointed = mocks.replaceUpdateProgressMarkerIfUnchangedMock.mock
      .calls[0][2] as HostUpdateProgress;
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", repointed);
    const projected = projectInstallResultLikeDesktop(result.data);
    expect(projected.previousVersion).toBe("1.0.0");
    expect(projected.version).toBe("2.1.0");
    expect(result.human).toContain("updated host 1.0.0 → 2.1.0");
  });

  it("the record moved under the lock but the marker is no longer ours: the re-point is refused, and the final clear still targets the ORIGINAL marker", async () => {
    // Same setup as the re-point test above, but the compare-and-swap always
    // reports "failed" - an I/O failure landing the re-point, not a race
    // with another writer. `reassertMarkerUnderLock`'s retry loop only
    // re-reads on "changed" (a record that moved); a "failed" answer is
    // never retried - it warns and stops immediately, on the FIRST attempt.
    // The activation still proceeds - the debt clears either way - but the
    // progress marker this run tracks must stay pinned to the ORIGINAL
    // pre-lock record rather than following a re-point that never actually
    // landed.
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock
      .mockResolvedValueOnce(sampleRecord("2.0.0"))
      .mockResolvedValue(sampleRecord("2.1.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue(pidRecord("1.0.0", 4242));
    mocks.identityVerdictMock.mockResolvedValue("current");
    mocks.replaceUpdateProgressMarkerIfUnchangedMock.mockResolvedValue(
      "failed",
    );

    const ctx = fakeCtx();
    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(ctx);

    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(written.targetVersion).toBe("2.0.0");
    // Exactly ONE replace attempt - the loop stops after the re-read shows
    // the write did not land, rather than retrying against an unchanging
    // disk.
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledTimes(1);
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      written,
      expect.objectContaining({ state: "updating", targetVersion: "2.1.0" }),
    );
    expect(ctx.runtime.logger.warn).toHaveBeenCalledWith(
      "Host update could not write the progress marker under the lock; proceeding without re-asserting it",
      expect.objectContaining({ environment: "production" }),
    );
    // Activation still proceeds: a refused re-point does not block the
    // restart, it only leaves the progress marker pointed at the stale
    // record.
    expect(mocks.stopHostForRestartWithAttemptMock).toHaveBeenCalledTimes(1);
    expect(mocks.relaunchHostAfterRestartWithAttemptMock).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.probeHostHealthMock).toHaveBeenCalledTimes(1);
    // The final clear is CONDITIONAL on `writtenMarker`, which never moved
    // off the original pre-lock record because the swap reported "changed" -
    // it must target that original marker, never a record naming the moved
    // 2.1.0 version.
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", written);
    const projected = projectInstallResultLikeDesktop(result.data);
    expect(projected.previousVersion).toBe("1.0.0");
    expect(projected.version).toBe("2.1.0");
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
      writerId: null,
    });

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.stopHostForRestartWithAttemptMock).not.toHaveBeenCalled();
    expect(
      mocks.claimUpdateProgressMarkerBeforeLockMock,
    ).not.toHaveBeenCalled();
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

  it("the stale-failure clear could not be written: left alone, logged, no throw", async () => {
    // Falsification: collapse "failed" into "changed" in
    // `clearStaleFailedMarker` and this log assertion goes red - the
    // "failed" arm names why a `failed` marker outlived an observed match
    // (an I/O failure on the clear, not a race with another writer).
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    mocks.readHostPidMetadataMock.mockResolvedValue(pidRecord("2.0.0", 4242));
    mocks.identityVerdictMock.mockResolvedValue("current");
    mocks.readUpdateProgressMarkerMock.mockResolvedValue({
      state: "failed",
      error: "host did not become healthy: tcp refused",
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: null,
    });
    mocks.deleteUpdateProgressMarkerIfUnchangedMock.mockResolvedValue("failed");

    const ctx = fakeCtx();
    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(ctx);

    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update left the progress marker alone - the stale-failure clear could not be written",
      expect.objectContaining({
        environment: "production",
        outcome: "failed",
      }),
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
      writerId: null,
    });

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.identityVerdictMock).toHaveBeenCalledWith(4242, null);
    expect(mocks.stopHostForRestartWithAttemptMock).not.toHaveBeenCalled();
    expect(mocks.assertHostNotBusyMock).not.toHaveBeenCalled();
    expect(
      mocks.claimUpdateProgressMarkerBeforeLockMock,
    ).not.toHaveBeenCalled();
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
      writerId: null,
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
      writerId: null,
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
    expect(
      mocks.claimUpdateProgressMarkerBeforeLockMock,
    ).not.toHaveBeenCalledWith(
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
    expect(
      mocks.claimUpdateProgressMarkerBeforeLockMock,
    ).not.toHaveBeenCalled();
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
    expect(
      mocks.claimUpdateProgressMarkerBeforeLockMock,
    ).not.toHaveBeenCalled();
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
    expect(
      mocks.claimUpdateProgressMarkerBeforeLockMock,
    ).not.toHaveBeenCalled();
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
    expect(
      mocks.claimUpdateProgressMarkerBeforeLockMock,
    ).not.toHaveBeenCalled();
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

  it("a non-SemVer runtime stamp (staging.<epoch>.<sha>) that MATCHES the running host: activated, not foreign - the stale failed marker is cleared and nothing restarts", async () => {
    // A staging host publishes `staging.<epoch>.<sha>` in both pid.json and
    // the install record's runtimeVersion. That stamp is not SemVer, but
    // equality still decides - no isValidHostVersion guard applies once the
    // record carries a runtime stamp.
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue({
      ...sampleRecord("2.0.0"),
      runtimeVersion: "staging.1783550586518.bb8c937d9",
    });
    mocks.readHostPidMetadataMock.mockResolvedValue(
      pidRecord("staging.1783550586518.bb8c937d9", 4242),
    );
    mocks.identityVerdictMock.mockResolvedValue("current");
    mocks.readUpdateProgressMarkerMock.mockResolvedValue({
      state: "failed",
      error: "host did not become healthy: tcp refused",
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: null,
    });

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.stopHostForRestartWithAttemptMock).not.toHaveBeenCalled();
    expect(
      mocks.claimUpdateProgressMarkerBeforeLockMock,
    ).not.toHaveBeenCalled();
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

  it("a non-SemVer runtime stamp the running host does NOT match: debt, activated - a staging host is never 'foreign'", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue(upToDate("2.0.0"));
    mocks.readHostInstallRecordMock.mockResolvedValue({
      ...sampleRecord("2.0.0"),
      runtimeVersion: "staging.1783550586518.bb8c937d9",
    });
    mocks.readHostPidMetadataMock.mockResolvedValue(
      pidRecord("staging.1783540000000.0a1b2c3d4", 4242),
    );
    mocks.identityVerdictMock.mockResolvedValue("current");

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.stopHostForRestartWithAttemptMock).toHaveBeenCalledTimes(1);
    expect(mocks.relaunchHostAfterRestartWithAttemptMock).toHaveBeenCalledTimes(
      1,
    );
    const projected = projectInstallResultLikeDesktop(result.data);
    expect(projected.previousVersion).toBe("staging.1783540000000.0a1b2c3d4");
  });

  it("the host is busy: assertHostNotBusy rejects, the run PARKS - its own updating marker is withdrawn, nothing is stamped failed, and restart never runs", async () => {
    // A busy refusal is the policy working, not a failure: the install is
    // committed and the running host is behind it, and the GUI derives
    // "installed, restart to finish" from those two records. Stamping
    // `failed` here painted "Update failed: work in progress" in red on
    // every surface for a host doing exactly what it was asked to.
    //
    // Falsification: replace the `E_HOST_BUSY` catch arm in `host-update.ts`
    // with a fall-through to `markUpdateFailed` and the `replace…` negative
    // below goes red; drop the conditional delete and the `delete…` positive
    // does.
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
    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(written).toEqual(
      expect.objectContaining({ state: "updating", targetVersion: "2.0.0" }),
    );
    // Withdrawn CONDITIONALLY, against the record this run wrote - a newer
    // updater's marker is not this run's to remove.
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", written);
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
  });

  it("a park whose withdrawal cannot land reports the I/O failure, not a withdrawal", async () => {
    // Same shape as the plain busy park above, but the conditional delete's
    // own write fails (`logConditionalMarkerOutcome`'s "failed" arm) - the
    // marker stays put until the next update supersedes it, and the log
    // must say so rather than the "was withdrawn" success line.
    //
    // Falsification: collapse `logConditionalMarkerOutcome` back to a
    // two-way branch (done vs. everything else) and this pin goes red -
    // the "could not be withdrawn" line would never fire for a "failed"
    // outcome.
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
    mocks.deleteUpdateProgressMarkerIfUnchangedMock.mockResolvedValueOnce(
      "failed",
    );

    const ctx = fakeCtx();
    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(ctx),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_BUSY });

    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update parked - the host has work in progress; its progress marker could not be withdrawn and stays until the next update supersedes it",
      expect.objectContaining({ environment: "production", outcome: "failed" }),
    );
    expect(ctx.runtime.logger.info).not.toHaveBeenCalledWith(
      "Host update parked - the host has work in progress; the progress marker was withdrawn",
      expect.anything(),
    );
  });

  it("a park whose withdrawal finds the path already empty says so - not that another updater owns it", async () => {
    // Falsification: drop the `gone` arm of `logConditionalMarkerOutcome`
    // (route "absent" through `moved`) and the park narrates a record
    // "another updater owns" over a path that is empty.
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
    mocks.deleteUpdateProgressMarkerIfUnchangedMock.mockResolvedValueOnce(
      "absent",
    );

    const ctx = fakeCtx();
    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(ctx),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_BUSY });

    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update parked - the host has work in progress; found no progress marker to withdraw",
      expect.objectContaining({ environment: "production", outcome: "absent" }),
    );
    expect(ctx.runtime.logger.info).not.toHaveBeenCalledWith(
      "Host update parked - the host has work in progress; the progress marker was left in place - another updater owns it now",
      expect.anything(),
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
    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
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

// Busy park + early marker (Host Update Layer Redesign): `onWillDownload`
// publishes the `updating` marker BEFORE the transfer starts, and a
// HOST_BUSY rethrow from the apply arm withdraws that same marker instead of
// stamping `failed` - the park is the policy working, not a failure.
describe("buildHostUpdateCommand busy park + early marker", () => {
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

  function requireHook(
    opts: DownloadAndStageHostOptions,
  ): (targetVersion: string) => Promise<void> {
    if (opts.onWillDownload === null) {
      throw new Error("expected onWillDownload to be provided");
    }
    return opts.onWillDownload;
  }

  it("writes the updating marker from onWillDownload strictly before the download resolves, and clears it with the same written record", async () => {
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        await requireHook(opts)("2.0.0");
        mocks.callOrder.push("download-resolved");
        return {
          outcome: "promoted",
          stagedVersion: "2.0.0",
          installedVersion: "1.0.0",
        } satisfies HostDownloadOutcome;
      },
    );
    // Falsification: leave the claim mock's `armActivationDefaults` default
    // wiring in place (it does not push into `callOrder`) and this test could
    // not tell "claimed" from "claimed strictly before the download
    // resolved" apart.
    mocks.claimUpdateProgressMarkerBeforeLockMock.mockImplementation(
      async (
        _environment: string,
        next: HostUpdateProgress,
      ): Promise<UpdateProgressMarkerClaim> => {
        mocks.callOrder.push("marker-written");
        mocks.disk.current = next;
        return { outcome: "published" };
      },
    );
    mocks.applyHostMock.mockResolvedValue(
      appliedOutcome("1.0.0", "2.0.0", null),
    );

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({ state: "updating", targetVersion: "2.0.0" }),
    );
    const markerIndex = mocks.callOrder.indexOf("marker-written");
    const resolvedIndex = mocks.callOrder.indexOf("download-resolved");
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(resolvedIndex).toBeGreaterThanOrEqual(0);
    // The load-bearing ordering: the marker is on disk before the download
    // promise this command awaits ever resolves, not merely before `apply`.
    expect(markerIndex).toBeLessThan(resolvedIndex);
    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", written);
    expect(result.exitCode).toBe(0);
  });

  it("a transport failure that happens AFTER the hook fired stamps failed and does not delete", async () => {
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        await requireHook(opts)("2.0.0");
        throw new Error("download failed: ECONNRESET");
      },
    );

    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toThrow("download failed: ECONNRESET");

    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(written.state).toBe("updating");
    expect(written.targetVersion).toBe("2.0.0");
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      written,
      expect.objectContaining({
        state: "failed",
        error: "download failed: ECONNRESET",
        targetVersion: "2.0.0",
      }),
    );
    // Falsification: fold the HOST_BUSY delete-on-park branch into every
    // catch arm (instead of gating it on the HOST_BUSY code check) and this
    // goes red.
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
  });

  it("a failure BEFORE the hook fires writes no marker of any kind", async () => {
    mocks.downloadAndStageHostMock.mockRejectedValue(
      new Error("manifest unreachable"),
    );

    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toThrow("manifest unreachable");

    // Falsification: move `publishUpdating`'s first write to before
    // `prepareHostUpdate` runs (outside the try that owns `onWillDownload`)
    // and this goes red - a marker would appear for a run that never
    // reached the hook.
    expect(
      mocks.claimUpdateProgressMarkerBeforeLockMock,
    ).not.toHaveBeenCalled();
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
  });

  it("apply-arm busy park: withdraws its own updating marker, never stamps failed, names the staged version in the message, and skips the health probe", async () => {
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        await requireHook(opts)("2.0.0");
        return {
          outcome: "promoted",
          stagedVersion: "2.0.0",
          installedVersion: "1.0.0",
        } satisfies HostDownloadOutcome;
      },
    );
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

    let caught: unknown;
    try {
      await buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(fakeCtx());
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
      details: { stagedVersion: "2.0.0" },
    });
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("stays staged");
    expect(message).toContain("--force");

    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(written.state).toBe("updating");
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledTimes(1);
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", written);
    // Falsification: drop the HOST_BUSY arm in the catch (let it fall
    // through to the generic failure branch) and this goes red.
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
    // Falsification: probe health unconditionally instead of gating it on
    // `workPerformed` and this goes red.
    expect(mocks.probeHostHealthMock).not.toHaveBeenCalled();
  });

  it("already-staged short-circuit then apply: the marker is still written exactly once (the post-prepare write) and cleared conditionally", async () => {
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

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({ state: "updating", targetVersion: "2.0.0" }),
    );
    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", written);
    expect(result.exitCode).toBe(0);
  });

  it("--force on the apply arm is unchanged (positive control)", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "promoted",
      stagedVersion: "2.0.0",
      installedVersion: "1.0.0",
    } satisfies HostDownloadOutcome);
    mocks.applyHostMock.mockResolvedValue(
      appliedOutcome("1.0.0", "2.0.0", null),
    );

    const result = await buildHostUpdateCommand({
      force: true,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.applyHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
    expect(result.exitCode).toBe(0);
  });
});

// `reassertMarkerUnderLock` (host-update.ts): under the contender lock, right
// before the disruptive half of every arm, re-establish what the pre-lock
// marker only claimed. These pin the three cases named in its own doc
// comment against the DISK FIXTURE (`mocks.disk`, wired by
// `armActivationDefaults`) rather than canned per-call return values, so a
// test can simulate the disk changing out from under this run mid-flight.
describe("buildHostUpdateCommand — reassertMarkerUnderLock under the lock", () => {
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

  function requireHook(
    opts: DownloadAndStageHostOptions,
  ): (targetVersion: string) => Promise<void> {
    if (opts.onWillDownload === null) {
      throw new Error("expected onWillDownload to be provided");
    }
    return opts.onWillDownload;
  }

  it("marker withdrawn while waiting: republished under the lock before the apply", async () => {
    // Falsification: stub `reassertMarkerUnderLock` to return early instead
    // of republishing on an empty disk, and `createUpdateProgressMarkerIfAbsent`
    // below is never called (the second-write assertion drops to zero).
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        await requireHook(opts)("2.0.0");
        // Another updater's run cleared our marker while this run waited
        // for admission - a wait this run controls none of.
        mocks.disk.current = null;
        return {
          outcome: "promoted",
          stagedVersion: "2.0.0",
          installedVersion: "1.0.0",
        } satisfies HostDownloadOutcome;
      },
    );
    // The hook now fires INSIDE `applyHost` (after its own reconcile and
    // busy gate, immediately before it commits) rather than from
    // `applyAndProjectLegacy` directly, so the mock standing in for
    // `applyHost` has to invoke it itself to exercise the republish.
    mocks.applyHostMock.mockImplementation(async (opts: ApplyHostOptions) => {
      await opts.onWillCommitStaged?.("2.0.0");
      return appliedOutcome("1.0.0", "2.0.0", null);
    });

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    // The pre-lock publish is the only conditional CLAIM (no unconditional
    // write exists any more); the empty-path republish under the lock goes
    // through the create-if-absent primitive instead, never through a
    // second `claimUpdateProgressMarkerBeforeLock` call.
    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    const firstWrite = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(mocks.createUpdateProgressMarkerIfAbsentMock).toHaveBeenCalledTimes(
      1,
    );
    const republished = mocks.createUpdateProgressMarkerIfAbsentMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(firstWrite.targetVersion).toBe("2.0.0");
    expect(republished.targetVersion).toBe("2.0.0");
    // The republish happens while `applyHost` is in flight - INSIDE its own
    // call, via the `onWillCommitStaged` hook - not before `applyHost` is
    // invoked. `invocationCallOrder` gives a global ordering across every
    // mock, so the create's order comes out AFTER applyHost's own entry.
    const createOrder =
      mocks.createUpdateProgressMarkerIfAbsentMock.mock.invocationCallOrder[0];
    const applyOrder = mocks.applyHostMock.mock.invocationCallOrder[0];
    expect(createOrder).toBeGreaterThan(applyOrder);
    // The final clear follows the republished record, not the withdrawn one -
    // `ownMarker.current` was adopted from the create call's own argument.
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", republished);
    expect(result.exitCode).toBe(0);
  });

  it("under the lock, the marker target follows the version applyHost is committing, not the pre-lock download target", async () => {
    // Falsification: pass the pre-lock download target to
    // `onWillCommitStaged` instead of the version `applyHost` is actually
    // committing, and the re-point call below never happens - the marker
    // stays pointed at 2.0.0 while `applyHost` actually installs 2.1.0.
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "promoted",
      stagedVersion: "2.0.0",
      installedVersion: "1.0.0",
    } satisfies HostDownloadOutcome);
    // `applyHost` commits a NEWER version than the one this run promoted
    // before it waited for the lock - a later promoter left it on the
    // shared stage, and `applyHost` reports the version it is actually
    // committing through the hook.
    mocks.applyHostMock.mockImplementation(async (opts: ApplyHostOptions) => {
      await opts.onWillCommitStaged?.("2.1.0");
      return appliedOutcome("1.0.0", "2.1.0", null);
    });

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    const preLock = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(preLock.targetVersion).toBe("2.0.0");
    // The re-point happens INSIDE `applyHost` (via `onWillCommitStaged`),
    // against this run's own pre-lock record, naming the version
    // `applyHost` is actually committing.
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      preLock,
      expect.objectContaining({ state: "updating", targetVersion: "2.1.0" }),
    );
    const repointed = mocks.replaceUpdateProgressMarkerIfUnchangedMock.mock
      .calls[0][2] as HostUpdateProgress;
    const replaceOrder =
      mocks.replaceUpdateProgressMarkerIfUnchangedMock.mock
        .invocationCallOrder[0];
    const applyOrder = mocks.applyHostMock.mock.invocationCallOrder[0];
    expect(replaceOrder).toBeGreaterThan(applyOrder);
    // The final clear is CAS'd against the re-pointed 2.1.0 record.
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", repointed);
    expect(result.exitCode).toBe(0);
  });

  it("another updater's marker on disk under the lock: taken over (the lock holder owns the marker)", async () => {
    // Falsification: revert the takeover branch to a `return` and the
    // replace call below never happens.
    const foreignRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        await requireHook(opts)("2.0.0");
        // Another updater's `updating` has landed at the same path by the
        // time this run reaches the lock - a live progress signal, but
        // from a writer that is NOT doing disruptive work right now (it
        // is waiting for this same lock, or already released it).
        mocks.disk.current = foreignRecord;
        return {
          outcome: "promoted",
          stagedVersion: "2.0.0",
          installedVersion: "1.0.0",
        } satisfies HostDownloadOutcome;
      },
    );
    // `applyHost` proceeds past its own busy gate and calls the hook right
    // before it commits - this run takes the marker over and the apply
    // itself succeeds.
    mocks.applyHostMock.mockImplementation(async (opts: ApplyHostOptions) => {
      await opts.onWillCommitStaged?.("2.0.0");
      return appliedOutcome("1.0.0", "2.0.0", null);
    });

    const ctx = fakeCtx();
    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(ctx);

    expect(result.exitCode).toBe(0);
    // The pre-lock publish is the only `claimUpdateProgressMarkerBeforeLock`
    // call - the takeover itself goes through the CAS replace primitive.
    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    // The takeover replaces the FOREIGN record with a fresh `updating`
    // record naming the target this run is working toward.
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      foreignRecord,
      expect.objectContaining({ state: "updating", targetVersion: "2.0.0" }),
    );
    const adopted = mocks.replaceUpdateProgressMarkerIfUnchangedMock.mock
      .calls[0][2] as HostUpdateProgress;
    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update took over the progress marker under the lock - its writer is not doing disruptive work",
      expect.objectContaining({
        environment: "production",
        targetVersion: "2.0.0",
        previousState: "updating",
        previousTarget: "2.0.0",
      }),
    );
    // The final clear is CAS'd against the ADOPTED fresh record - not the
    // pre-lock record this run originally wrote.
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", adopted);
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledTimes(1);
  });

  it("a takeover of a stale record under the lock does not restore it on a busy park", async () => {
    // The takeover counterpart to the `publishUpdating` pins above: a
    // record no writer is acting on (`updateProgressRecordHasLiveWriter`
    // false) is replaced under the lock too, and `displacedMarker.current`
    // stays null for it - so a busy park that follows withdraws this run's
    // own record instead of restoring the stale one.
    //
    // Falsification: retain every taken-over record regardless of
    // liveness (`displacedMarker.current = onDisk` unconditionally) and
    // the "restore never happens" assertions below go red.
    const staleFailed: HostUpdateProgress = {
      state: "failed",
      error: "host did not become healthy: tcp refused",
      targetVersion: "1.9.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "dead-writer",
    };
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        await requireHook(opts)("2.0.0");
        mocks.disk.current = staleFailed;
        return {
          outcome: "promoted",
          stagedVersion: "2.0.0",
          installedVersion: "1.0.0",
        } satisfies HostDownloadOutcome;
      },
    );
    // `applyHost` takes the marker over (replacing the stale `failed`) and
    // only THEN rejects busy - same shape as the live-writer busy-park pin.
    mocks.applyHostMock.mockImplementation(async (opts: ApplyHostOptions) => {
      await opts.onWillCommitStaged?.("2.0.0");
      throw cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: "The running host has work in progress",
        details: null,
        exitCode: 1,
      });
    });
    mocks.readHostStagedRecordMock.mockResolvedValue(null);

    const ctx = fakeCtx();
    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(ctx),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_BUSY });

    // The takeover itself still happens (one replace call, over the stale
    // record) - what's under test is what the PARK does afterward.
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      staleFailed,
      expect.objectContaining({ state: "updating", targetVersion: "2.0.0" }),
    );
    const adopted = mocks.replaceUpdateProgressMarkerIfUnchangedMock.mock
      .calls[0][2] as HostUpdateProgress;
    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update replaced the progress marker under the lock - no writer is acting on it",
      expect.objectContaining({
        environment: "production",
        targetVersion: "2.0.0",
      }),
    );
    // The park WITHDRAWS this run's own (adopted) record - never a second
    // replace call putting the stale `failed` back.
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", adopted);
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledTimes(1);
    expect(mocks.disk.current).toBeNull();
  });

  it("a takeover of a LIVE foreign record is not restored if that writer dies before the park re-checks it", async () => {
    // Liveness is re-evaluated at the PARK, not trusted from the takeover
    // (`liveDisplacedRecord`): the displaced writer had the whole stop
    // attempt to die in between, and a park that restored its now-dead
    // `updating` would re-plant exactly the record the retain rule exists
    // to drop. `mocks.deadWriterIds.add` runs as a side effect INSIDE the
    // apply mock's rejection path - after the takeover already read the
    // writer as live - so this only passes if the re-check genuinely reads
    // AGAIN at the restore rather than reusing a liveness verdict a
    // constant fixture could not tell apart from a stale one.
    //
    // Falsification: cache the takeover's liveness verdict instead of
    // re-reading it at the park (drop the second `updateProgressRecordHasLiveWriter`
    // call) and this pin's "delete, not restore" assertions go red.
    const foreignRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "will-die-writer",
    };
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        await requireHook(opts)("2.0.0");
        mocks.disk.current = foreignRecord;
        return {
          outcome: "promoted",
          stagedVersion: "2.0.0",
          installedVersion: "1.0.0",
        } satisfies HostDownloadOutcome;
      },
    );
    mocks.applyHostMock.mockImplementation(async (opts: ApplyHostOptions) => {
      await opts.onWillCommitStaged?.("2.0.0");
      // The takeover above already read this writer as live. It dies here,
      // mid-swap-attempt, before the busy rejection reaches the park.
      mocks.deadWriterIds.add("will-die-writer");
      throw cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: "The running host has work in progress",
        details: null,
        exitCode: 1,
      });
    });
    mocks.readHostStagedRecordMock.mockResolvedValue(null);

    const ctx = fakeCtx();
    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(ctx),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_BUSY });

    // The takeover itself read the writer as live (still one replace call
    // over the foreign record).
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      foreignRecord,
      expect.objectContaining({ state: "updating", targetVersion: "2.0.0" }),
    );
    const adopted = mocks.replaceUpdateProgressMarkerIfUnchangedMock.mock
      .calls[0][2] as HostUpdateProgress;
    // The park DELETES own - never a second replace restoring the now-dead
    // writer's record.
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", adopted);
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledTimes(1);
    expect(mocks.disk.current).toBeNull();
  });

  it("a failure after a takeover of a LIVE foreign record stamps `failed` if that writer dies before the restore re-checks it", async () => {
    // The pre-disruption-failure sibling of the park pin above: same
    // dies-between-takeover-and-restore shape, reached through the OTHER
    // arm that consults `liveDisplacedRecord`.
    const foreignRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "will-die-writer",
    };
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        await requireHook(opts)("2.0.0");
        mocks.disk.current = foreignRecord;
        return {
          outcome: "promoted",
          stagedVersion: "2.0.0",
          installedVersion: "1.0.0",
        } satisfies HostDownloadOutcome;
      },
    );
    // Takes the marker over, then rejects a NON-busy error WITHOUT ever
    // reporting progress - no `service-stop` or `swap` reached the host.
    mocks.applyHostMock.mockImplementation(async (opts: ApplyHostOptions) => {
      await opts.onWillCommitStaged?.("2.0.0");
      mocks.deadWriterIds.add("will-die-writer");
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: "could not stop the service",
        details: null,
        exitCode: 1,
      });
    });

    const ctx = fakeCtx();
    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(ctx),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    });

    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenNthCalledWith(
      1,
      "production",
      foreignRecord,
      expect.objectContaining({
        state: "updating",
        targetVersion: "2.0.0",
      }),
    );
    const adopted = mocks.replaceUpdateProgressMarkerIfUnchangedMock.mock
      .calls[0][2] as HostUpdateProgress;
    // The SECOND replace call stamps `failed` over own (the now-dead
    // writer is not restored) - never a restore of the foreign record.
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenNthCalledWith(
      2,
      "production",
      adopted,
      expect.objectContaining({
        state: "failed",
        targetVersion: "2.0.0",
        error: "could not stop the service",
      }),
    );
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalledWith("production", adopted, foreignRecord);
  });

  it("busy park after a takeover: the displaced record is RESTORED, and no `failed` stamp lands", async () => {
    // Falsification: withdraw this run's own record unconditionally on
    // park instead of restoring the displaced one when
    // `displacedMarker.current` is set, and the second replace call below
    // never happens (or targets the wrong pair).
    const foreignRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        await requireHook(opts)("2.0.0");
        mocks.disk.current = foreignRecord;
        return {
          outcome: "promoted",
          stagedVersion: "2.0.0",
          installedVersion: "1.0.0",
        } satisfies HostDownloadOutcome;
      },
    );
    // `applyHost` calls the hook - taking the marker over - and only THEN
    // rejects busy: the stop's own cooperative claim can still be denied
    // past `applyHost`'s pre-commit busy gate.
    mocks.applyHostMock.mockImplementation(async (opts: ApplyHostOptions) => {
      await opts.onWillCommitStaged?.("2.0.0");
      throw cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: "The running host has work in progress",
        details: null,
        exitCode: 1,
      });
    });
    // The busy catch re-reads the staged record for the error payload,
    // still inside the same lock span - not read anywhere else in this
    // scenario.
    mocks.readHostStagedRecordMock.mockResolvedValue(null);

    const ctx = fakeCtx();
    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(ctx),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_BUSY });

    const adopted = mocks.replaceUpdateProgressMarkerIfUnchangedMock.mock
      .calls[0][2] as HostUpdateProgress;
    // The park RESTORES the displaced record (the foreign marker this run
    // took over) rather than withdrawing this run's own - it did no
    // disruptive work after all.
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", adopted, foreignRecord);
    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update parked - the host has work in progress; the progress marker it took over was restored to its previous writer",
      expect.objectContaining({ environment: "production" }),
    );
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
    // Exactly two replace calls - the takeover, then the restore - proves
    // no `failed` stamp landed too: a PARK never reaches `markUpdateFailed`,
    // which would have been a third replace call naming `state: "failed"`.
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledTimes(2);
  });

  it("a failure after a takeover but before the host is disturbed restores the displaced record", async () => {
    // Falsification: drop the `!disruptionStarted` restore branch in the
    // generic catch and the second replace becomes a `failed` stamp.
    const foreignRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        await requireHook(opts)("2.0.0");
        // Another updater's `updating` is on disk by the time this run
        // reaches the lock - the takeover target below.
        mocks.disk.current = foreignRecord;
        return {
          outcome: "promoted",
          stagedVersion: "2.0.0",
          installedVersion: "1.0.0",
        } satisfies HostDownloadOutcome;
      },
    );
    // `applyHost` takes the marker over via the hook, then rejects a
    // NON-busy error WITHOUT ever reporting progress - no `service-stop`
    // or `swap` reached the host at all.
    mocks.applyHostMock.mockImplementation(async (opts: ApplyHostOptions) => {
      await opts.onWillCommitStaged?.("2.0.0");
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: "could not stop the service",
        details: null,
        exitCode: 1,
      });
    });

    const ctx = fakeCtx();
    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(ctx),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    });

    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenNthCalledWith(
      1,
      "production",
      foreignRecord,
      expect.objectContaining({
        state: "updating",
        targetVersion: "2.0.0",
      }),
    );
    const adopted = mocks.replaceUpdateProgressMarkerIfUnchangedMock.mock
      .calls[0][2] as HostUpdateProgress;
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenNthCalledWith(2, "production", adopted, foreignRecord);
    // Exactly two replace calls - the takeover, then the restore - proves
    // no `failed` record ever landed on any marker mock: a third call
    // naming `state: "failed"` would have shown up here.
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledTimes(2);
    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update failed before disturbing the host; the progress marker it took over was restored to its previous writer",
      expect.objectContaining({ environment: "production" }),
    );
  });

  it("a live-writer restore that loses the CAS reports it was not restored, not silence", async () => {
    // The `logConditionalMarkerOutcome` "moved" arm for the pre-disruption
    // restore: the takeover's own record changed underneath the restore
    // attempt (a newer updater already claimed the path), so the restore's
    // compare-and-swap reports "changed" rather than landing.
    //
    // Falsification: log the "done" ("was restored to its previous
    // writer") message unconditionally instead of branching on the
    // restore's own outcome, and this pin goes red.
    const foreignRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        await requireHook(opts)("2.0.0");
        mocks.disk.current = foreignRecord;
        return {
          outcome: "promoted",
          stagedVersion: "2.0.0",
          installedVersion: "1.0.0",
        } satisfies HostDownloadOutcome;
      },
    );
    mocks.applyHostMock.mockImplementation(async (opts: ApplyHostOptions) => {
      await opts.onWillCommitStaged?.("2.0.0");
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: "could not stop the service",
        details: null,
        exitCode: 1,
      });
    });
    // First replace call is the takeover itself (still lands, same as the
    // sibling pin above); the SECOND - the restore attempt - loses its CAS.
    mocks.replaceUpdateProgressMarkerIfUnchangedMock
      .mockImplementationOnce(
        async (
          _environment: string,
          _expected: HostUpdateProgress,
          next: HostUpdateProgress,
        ) => {
          mocks.disk.current = next;
          return "replaced";
        },
      )
      .mockResolvedValueOnce("changed");

    const ctx = fakeCtx();
    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(ctx),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    });

    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledTimes(2);
    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update failed before disturbing the host; the progress marker it took over was not restored - another updater owns it now",
      expect.objectContaining({
        environment: "production",
        outcome: "changed",
      }),
    );
  });

  it("a failure after the host was disturbed stamps `failed` over the taken-over record", async () => {
    // Falsification: make `reportProgress` ignore `service-stop` and this
    // stamps nothing / restores instead.
    const foreignRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        await requireHook(opts)("2.0.0");
        mocks.disk.current = foreignRecord;
        return {
          outcome: "promoted",
          stagedVersion: "2.0.0",
          installedVersion: "1.0.0",
        } satisfies HostDownloadOutcome;
      },
    );
    // `applyHost` takes the marker over, reports `service-stop` - the host
    // is now being disturbed - and only then rejects a NON-busy error.
    mocks.applyHostMock.mockImplementation(async (opts: ApplyHostOptions) => {
      await opts.onWillCommitStaged?.("2.0.0");
      opts.onProgress({
        stage: "service-stop",
        message: null,
        percent: null,
        bytes: null,
        totalBytes: null,
        workUnits: null,
      });
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: "could not stop the service",
        details: null,
        exitCode: 1,
      });
    });

    const ctx = fakeCtx();
    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(ctx),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    });

    const adopted = mocks.replaceUpdateProgressMarkerIfUnchangedMock.mock
      .calls[0][2] as HostUpdateProgress;
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenNthCalledWith(
      2,
      "production",
      adopted,
      expect.objectContaining({
        state: "failed",
        targetVersion: "2.0.0",
      }),
    );
    expect(ctx.runtime.logger.info).not.toHaveBeenCalledWith(
      "Host update failed before disturbing the host; the progress marker it took over was restored to its previous writer",
      expect.anything(),
    );
  });

  it("the activation arm's stop refused by its capability check, before the actuator, restores a live writer's taken-over record", async () => {
    // Falsification: set `disruptionStarted` around the stop call (the old
    // `reassertMarkerThenDisrupt`) instead of from the facade's
    // `onAuthorityVerified`, and a refused check stamps this run's `failed`
    // over the live writer's record - which that writer's later clear can
    // never land. The stop mock here rejects WITHOUT calling the boundary
    // callback: the check failed, the actuator never ran.
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "short-circuit",
      reason: "installed-up-to-date",
      targetVersion: "2.0.0",
      installedVersion: "2.0.0",
      stagedVersion: null,
    } satisfies HostDownloadOutcome);
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    const runningAt1 = {
      pid: 4242,
      hostId: "host-1",
      version: "1.0.0",
      websocketUrl: "ws://127.0.0.1:51820/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: null,
      layer0: null,
      layer0Slot: null,
    };
    const foreignRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    // Debt on both reads (out of the lock, and again under the activation
    // arm's own lock) - the SECOND read's side effect is what lands the
    // foreign marker under the lock, between this run's pre-lock publish
    // and the activation arm's takeover hook.
    mocks.readHostPidMetadataMock
      .mockResolvedValueOnce(runningAt1)
      .mockImplementationOnce(async () => {
        mocks.disk.current = foreignRecord;
        return runningAt1;
      });
    mocks.identityVerdictMock.mockResolvedValue("current");
    mocks.stopHostForRestartWithAttemptMock.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: "mutation capability refused",
        details: null,
        exitCode: 1,
      }),
    );

    const ctx = fakeCtx();
    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(ctx),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    });

    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenNthCalledWith(
      1,
      "production",
      foreignRecord,
      expect.objectContaining({
        state: "updating",
        targetVersion: "2.0.0",
      }),
    );
    const adopted = mocks.replaceUpdateProgressMarkerIfUnchangedMock.mock
      .calls[0][2] as HostUpdateProgress;
    // The takeover happened (above), the boundary never did: the second
    // conditional write RESTORES the foreign record over the adopted one.
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenNthCalledWith(2, "production", adopted, foreignRecord);
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalledWith(
      "production",
      expect.anything(),
      expect.objectContaining({ state: "failed" }),
    );
    expect(mocks.disk.current).toEqual(foreignRecord);
    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update failed before disturbing the host; the progress marker it took over was restored to its previous writer",
      expect.objectContaining({
        environment: "production",
        outcome: "replaced",
      }),
    );
  });

  it("the activation arm counts as disturbing the host from the stop's authority check on", async () => {
    // Falsification: drop `onWillDisruptHost` from the activation arm's stop
    // call (pass `null`) and this restores instead of stamping. The stop
    // mock here CALLS the boundary callback - the check passed, the actuator
    // ran and failed - and then rejects.
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "short-circuit",
      reason: "installed-up-to-date",
      targetVersion: "2.0.0",
      installedVersion: "2.0.0",
      stagedVersion: null,
    } satisfies HostDownloadOutcome);
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    const runningAt1 = {
      pid: 4242,
      hostId: "host-1",
      version: "1.0.0",
      websocketUrl: "ws://127.0.0.1:51820/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: null,
      layer0: null,
      layer0Slot: null,
    };
    const foreignRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    // Debt on both reads (out of the lock, and again under the activation
    // arm's own lock) - the SECOND read's side effect is what lands the
    // foreign marker under the lock, between this run's pre-lock publish
    // and the activation arm's takeover hook.
    mocks.readHostPidMetadataMock
      .mockResolvedValueOnce(runningAt1)
      .mockImplementationOnce(async () => {
        mocks.disk.current = foreignRecord;
        return runningAt1;
      });
    mocks.identityVerdictMock.mockResolvedValue("current");
    mocks.stopHostForRestartWithAttemptMock.mockImplementation(
      async (
        _capability: unknown,
        _contenderOptions: unknown,
        _controller: unknown,
        _label: unknown,
        _options: unknown,
        onAuthorityVerified: (() => void) | null,
      ) => {
        onAuthorityVerified?.();
        throw cliError({
          code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
          message: "could not stop the service",
          details: null,
          exitCode: 1,
        });
      },
    );

    const ctx = fakeCtx();
    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(ctx),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    });

    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenNthCalledWith(
      1,
      "production",
      foreignRecord,
      expect.objectContaining({
        state: "updating",
        targetVersion: "2.0.0",
      }),
    );
    const adopted = mocks.replaceUpdateProgressMarkerIfUnchangedMock.mock
      .calls[0][2] as HostUpdateProgress;
    // The boundary fired before the stop rejected, so this is a `failed`
    // stamp, never a restore.
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenNthCalledWith(
      2,
      "production",
      adopted,
      expect.objectContaining({
        state: "failed",
        targetVersion: "2.0.0",
      }),
    );
    expect(ctx.runtime.logger.info).not.toHaveBeenCalledWith(
      "Host update failed before disturbing the host; the progress marker it took over was restored to its previous writer",
      expect.anything(),
    );
  });

  it("downgrade arm passes onBeforeCommit and it re-asserts", async () => {
    // Falsification: pass a no-op callback as `onBeforeCommit` from the
    // downgrade arm in `host-update.ts` instead of
    // `() => reassertMarkerUnderLock(downgradeTarget)`, and the create call
    // below never happens.
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleRecord("1.3.0-rc.1"),
    );
    mocks.installHostDowngradeMock.mockImplementation(
      async (opts: { readonly onBeforeCommit: () => Promise<void> }) => {
        // Simulate another updater withdrawing our marker before this run
        // reaches the mutation lock's commit point.
        mocks.disk.current = null;
        await opts.onBeforeCommit();
        return appliedOutcome("1.3.0-rc.1", "1.2.0", null);
      },
    );

    await buildHostUpdateCommand({
      force: false,
      allowDowngrade: true,
      versionRequest: "1.2.0",
      ackNonce: null,
    })(fakeCtx());

    expect(mocks.installHostDowngradeMock).toHaveBeenCalledWith(
      expect.objectContaining({ onBeforeCommit: expect.any(Function) }),
    );
    // The pre-lock publish is the only `claimUpdateProgressMarkerBeforeLock`
    // call; the empty-path republish under the lock lands through the
    // create-if-absent primitive instead.
    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.createUpdateProgressMarkerIfAbsentMock).toHaveBeenCalledTimes(
      1,
    );
    expect(
      mocks.createUpdateProgressMarkerIfAbsentMock.mock.calls[0][1],
    ).toEqual(
      expect.objectContaining({ state: "updating", targetVersion: "1.2.0" }),
    );
  });

  it("empty path, but a marker lands between the read and the republish \u2192 the create refuses, the next iteration reads it and takes it over", async () => {
    // Falsification: revert the empty arm to `publishUpdating` and this pin
    // reddens on the write assertion.
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        await requireHook(opts)("2.0.0");
        // Another updater's run cleared our marker while this run waited
        // for admission - reassertMarkerUnderLock's disk read sees an
        // empty path.
        mocks.disk.current = null;
        return {
          outcome: "promoted",
          stagedVersion: "2.0.0",
          installedVersion: "1.0.0",
        } satisfies HostDownloadOutcome;
      },
    );
    mocks.applyHostMock.mockImplementation(async (opts: ApplyHostOptions) => {
      await opts.onWillCommitStaged?.("2.0.0");
      return appliedOutcome("1.0.0", "2.0.0", null);
    });
    const foreignRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    // A marker lands at the live path in the gap between
    // reassertMarkerUnderLock's read and its create-if-absent call, so the
    // create itself refuses rather than overwriting it.
    mocks.createUpdateProgressMarkerIfAbsentMock.mockImplementationOnce(
      async () => {
        mocks.disk.current = foreignRecord;
        return "exists";
      },
    );

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    // No second pre-lock claim - the refusal is the create call itself,
    // never a second `claimUpdateProgressMarkerBeforeLock`.
    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.createUpdateProgressMarkerIfAbsentMock).toHaveBeenCalledTimes(
      1,
    );
    // The loop's NEXT iteration reads the record the refused create just
    // observed on disk, and takes it over - the old "proceeds under
    // another updater's marker" log line no longer exists.
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith(
      "production",
      foreignRecord,
      expect.objectContaining({ state: "updating", targetVersion: "2.0.0" }),
    );
    const adopted = mocks.replaceUpdateProgressMarkerIfUnchangedMock.mock
      .calls[0][2] as HostUpdateProgress;
    // `ownMarker` was ADOPTED from the takeover - the later conditional
    // clear/stamp is CAS'd against the newly taken-over record, not this
    // run's original pre-lock one.
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", adopted);
    expect(result.exitCode).toBe(0);
  });

  it("the create fails \u2192 nothing changes, the update continues", async () => {
    // Falsification: revert the empty arm to `publishUpdating` and this pin
    // reddens on the write assertion.
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        await requireHook(opts)("2.0.0");
        mocks.disk.current = null;
        return {
          outcome: "promoted",
          stagedVersion: "2.0.0",
          installedVersion: "1.0.0",
        } satisfies HostDownloadOutcome;
      },
    );
    mocks.applyHostMock.mockImplementation(async (opts: ApplyHostOptions) => {
      await opts.onWillCommitStaged?.("2.0.0");
      return appliedOutcome("1.0.0", "2.0.0", null);
    });
    mocks.createUpdateProgressMarkerIfAbsentMock.mockImplementationOnce(
      async () => "failed",
    );

    const ctx = fakeCtx();
    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(ctx);

    // The apply still runs to completion - a failed create is advisory
    // state, never a reason to abort or throw.
    expect(mocks.applyHostMock).toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(mocks.claimUpdateProgressMarkerBeforeLockMock).toHaveBeenCalledTimes(
      1,
    );
    const firstWrite = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    // A "failed" create now warns exactly like a "failed" replace - the
    // retry loop's I/O-failure arms report the same way regardless of which
    // primitive hit it.
    expect(ctx.runtime.logger.warn).toHaveBeenCalledWith(
      "Host update could not write the progress marker under the lock; proceeding without re-asserting it",
      expect.objectContaining({
        environment: "production",
        targetVersion: "2.0.0",
      }),
    );
    // `ownMarker` was never adopted from a failed create - the final clear
    // is still CAS'd against this run's ORIGINAL pre-lock record.
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", firstWrite);
  });

  it('an I/O-failed CAS is not retried: the replace reports "failed", so the run stops trying on the FIRST attempt', async () => {
    // Falsification: retry on a "failed" answer the same way the loop
    // retries on "changed" and this test would see more than one replace
    // call - `reassertMarkerUnderLock` only re-reads on "changed" (a record
    // that moved); "failed" (an I/O failure, already warned about by the
    // marker layer) is never retried.
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        await requireHook(opts)("2.0.0");
        return {
          outcome: "promoted",
          stagedVersion: "2.0.0",
          installedVersion: "1.0.0",
        } satisfies HostDownloadOutcome;
      },
    );
    // The hook reports a MOVED target ("2.1.0"), so the loop must re-point
    // the record it already owns - and the CAS resolves "failed": an I/O
    // failure on the write itself, not a race with another writer.
    mocks.applyHostMock.mockImplementation(async (opts: ApplyHostOptions) => {
      await opts.onWillCommitStaged?.("2.1.0");
      return appliedOutcome("1.0.0", "2.1.0", null);
    });
    mocks.replaceUpdateProgressMarkerIfUnchangedMock.mockResolvedValue(
      "failed",
    );

    const ctx = fakeCtx();
    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(ctx);

    // Exactly ONE replace call - a "failed" answer is never retried.
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledTimes(1);
    expect(ctx.runtime.logger.warn).toHaveBeenCalledWith(
      "Host update could not write the progress marker under the lock; proceeding without re-asserting it",
      expect.objectContaining({
        environment: "production",
        targetVersion: "2.1.0",
      }),
    );
    // The update continues regardless - marker I/O never fails the command.
    expect(result.exitCode).toBe(0);
    // This is now CORRECT behavior, not merely tolerated: a "failed" replace
    // RESTORES the expected record it held in scratch (see the production
    // comment on `swapMarkerIfUnchanged`'s stamp/restore branch), so the
    // pre-lock record is still exactly what is on disk - which is why the
    // final clear targeting it, rather than the refused re-point, is right.
    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", written);
  });

  it('a "changed" replace re-reads and takes over the record a newer updater actually landed', async () => {
    // Falsification: treat "changed" like "failed" (stop after one attempt)
    // and the takeover below never happens - the loop would warn and leave
    // the marker pointed at the stale record even though a fresh one is
    // sitting right there to adopt.
    //
    // The pre-lock claim must defer (own stays null) for `reassertMarkerUnderLock`
    // to ever reach the replace path at all - an ESTABLISHED own record whose
    // target already matches returns immediately without a single replace
    // call. Seed the disk with a live foreign record BEFORE the download
    // hook fires so the claim defers.
    const foreignRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    mocks.disk.current = foreignRecord;
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        await requireHook(opts)("2.0.0");
        return {
          outcome: "promoted",
          stagedVersion: "2.0.0",
          installedVersion: "1.0.0",
        } satisfies HostDownloadOutcome;
      },
    );
    const newerRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "2.0.0",
      updatedAt: "2026-01-01T00:00:01.000Z",
      writerId: "newer-writer",
    };
    // The FIRST replace attempt (against `foreignRecord`) reports "changed"
    // AND lands a DIFFERENT, even newer updater's record on the disk fixture
    // at the same time - modeling a real race, not a static disk. The loop
    // re-reads, sees the newer record, and its SECOND replace attempt takes
    // it over via the default `armActivationDefaults` wiring.
    mocks.replaceUpdateProgressMarkerIfUnchangedMock.mockImplementationOnce(
      async () => {
        mocks.disk.current = newerRecord;
        return "changed";
      },
    );
    mocks.applyHostMock.mockImplementation(async (opts: ApplyHostOptions) => {
      await opts.onWillCommitStaged?.("2.0.0");
      return appliedOutcome("1.0.0", "2.0.0", null);
    });

    const result = await buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      ackNonce: null,
    })(fakeCtx());

    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledTimes(2);
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenNthCalledWith(
      1,
      "production",
      foreignRecord,
      expect.objectContaining({ state: "updating", targetVersion: "2.0.0" }),
    );
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenNthCalledWith(
      2,
      "production",
      newerRecord,
      expect.objectContaining({ state: "updating", targetVersion: "2.0.0" }),
    );
    const adopted = mocks.replaceUpdateProgressMarkerIfUnchangedMock.mock
      .calls[1][2] as HostUpdateProgress;
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", adopted);
    expect(result.exitCode).toBe(0);
  });

  it("a park before the hook never touches the marker beyond this run's own record", async () => {
    // Pins the COMMAND's park path, not `applyHost`'s own ordering:
    // `applyHost` itself is mocked here, so moving `onWillCommitStaged`
    // relative to the busy gate inside `apply.ts` cannot redden this test -
    // that ordering is `apply.test.ts`'s "is not called when the busy check
    // throws" to pin. What THIS test pins is that a busy rejection which
    // never invokes the hook leaves `host-update.ts`'s park path with
    // nothing to take over or replace - it only ever touches this run's own
    // pre-lock record, exactly as if no foreign marker were on disk at all.
    const foreignRecord: HostUpdateProgress = {
      state: "updating",
      error: null,
      targetVersion: "9.9.9",
      updatedAt: "2026-01-01T00:00:00.000Z",
      writerId: "foreign-writer",
    };
    mocks.downloadAndStageHostMock.mockImplementation(
      async (opts: DownloadAndStageHostOptions) => {
        await requireHook(opts)("2.0.0");
        // A foreign marker is already on disk BEFORE this run even reaches
        // `applyHost` - it is never read or touched by the park below.
        mocks.disk.current = foreignRecord;
        return {
          outcome: "promoted",
          stagedVersion: "2.0.0",
          installedVersion: "1.0.0",
        } satisfies HostDownloadOutcome;
      },
    );
    // `applyHost` rejects busy WITHOUT ever calling the hook - the real
    // busy gate runs before `onWillCommitStaged`, so a run parked there
    // never got the chance to take anything over.
    mocks.applyHostMock.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: "The running host has work in progress",
        details: null,
        exitCode: 1,
      }),
    );
    mocks.readHostStagedRecordMock.mockResolvedValue(null);

    await expect(
      buildHostUpdateCommand({
        force: false,
        allowDowngrade: false,
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_BUSY });

    // No takeover ever happened - the hook was never called.
    expect(
      mocks.replaceUpdateProgressMarkerIfUnchangedMock,
    ).not.toHaveBeenCalled();
    // The withdrawal is asked for against this run's OWN pre-lock record
    // only - the foreign marker on disk means the CAS reports "changed"
    // and leaves it alone, untouched.
    const written = mocks.claimUpdateProgressMarkerBeforeLockMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", written);
    const outcome =
      await mocks.deleteUpdateProgressMarkerIfUnchangedMock.mock.results[0]
        .value;
    expect(outcome).toBe("changed");
    expect(mocks.disk.current).toEqual(foreignRecord);
  });
});
