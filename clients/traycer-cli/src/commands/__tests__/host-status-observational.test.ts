import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";
import type { HostPidMetadata } from "../../host/pid-metadata";
import type { BootstrapLogEntry } from "../../host/bootstrap-log";
import type {
  HostUpdateAttemptRead,
  HostUpdateAttemptRecord,
} from "@traycer-clients/shared/host-update";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import type { HostInstallRecord } from "../../manifest/host-install";

// CLI-001: `host status` reads state, it never provisions. This used to call
// `maybeAutoBootstrap` first, so asking a clean machine for its status could
// install a host, register an OS service, and start it - none of which the
// command's own help text ("Show host status") promised. The fix deleted
// `host/auto-bootstrap.ts` entirely and pinned the payload's `bootstrap`
// field at `null` (mirroring `commands/login.ts`, which had already dropped
// its own auto-bootstrap call for the same reason).
//
// This file replaces the deleted `auto-bootstrap-integration.test.ts`, which
// pinned the OPPOSITE contract (status triggers bootstrap). The strong
// property worth pinning now is not just "the payload looks right" but
// "status never even imports a provisioning path" - so `../../host/provision`
// and `../../service` are mocked and asserted untouched, not merely absent
// from the payload.

const mocks = vi.hoisted(() => ({
  readHostPidMetadataMock: vi.fn(),
  readBootstrapMarkersMock: vi.fn(),
  readBootstrapLogTailMock: vi.fn(),
  isProcessAliveMock: vi.fn(),
  provisionHostMock: vi.fn(),
  createServiceControllerMock: vi.fn(),
  readUpdateAttemptRecordMock: vi.fn(),
  hostInstallRecordPathValue: "/tmp/test-host-home/absent-install.json",
}));

vi.mock("../../host/pid-metadata", async () => {
  // Only the read is stubbed; `publishedHostProcessGone` stays real so
  // `running` follows the (mocked) `isProcessAlive` as the command does.
  const actual = await vi.importActual<
    typeof import("../../host/pid-metadata")
  >("../../host/pid-metadata");
  return {
    ...actual,
    readHostPidMetadata: mocks.readHostPidMetadataMock,
  };
});

vi.mock("../../host/bootstrap-log", () => ({
  readBootstrapMarkers: mocks.readBootstrapMarkersMock,
  readBootstrapLogTail: mocks.readBootstrapLogTailMock,
}));

// Spread the real module: `host status` now reads the install record (through
// `manifest/host-install`) to tell a resumable park from a stale one, and that
// module imports further path helpers. Only the two the command's own reads
// resolve are redirected; `/tmp/test-host-home` holds no install record, so a
// parked fixture reads as "does not match the install" unless it is claim-less.
vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return {
    ...actual,
    bootstrapLogPath: () => "/tmp/test-bootstrap.log",
    hostHomeDir: () => "/tmp/test-host-home",
    // `manifest/host-install` resolves its own path through this helper, not
    // through `hostHomeDir`; without the override these tests read the
    // machine's REAL install record (CodeRabbit, traycer#2208). Overridden per
    // test when a record is needed; the default is an absent file.
    hostInstallRecordPath: () => mocks.hostInstallRecordPathValue,
  };
});

vi.mock("../../store/cli-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/cli-lock")>();
  return { ...actual, isProcessAlive: mocks.isProcessAliveMock };
});

// A read of host status must never import (let alone call) a provisioning
// path - this is the strong property CLI-001 asks for, not merely "the
// payload's bootstrap field is null".
vi.mock("../../host/provision", () => ({
  provisionHost: mocks.provisionHostMock,
}));

vi.mock("../../service", () => ({
  createServiceController: mocks.createServiceControllerMock,
}));

// Only `readUpdateAttemptRecord` is stubbed - everything else (types,
// `parkedActivationMatchesInstall`, etc.) stays the real module via
// `importOriginal`, matching this file's pattern for `store/cli-lock` above.
vi.mock("@traycer-clients/shared/host-update", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@traycer-clients/shared/host-update")
    >();
  return {
    ...actual,
    readUpdateAttemptRecord: mocks.readUpdateAttemptRecordMock,
  };
});

import { hostStatusCommand } from "../host-status";

function makeRuntime(overrides: Partial<RuntimeContext>): RuntimeContext {
  return {
    json: false,
    quiet: false,
    noProgress: false,
    noBootstrap: false,
    nonInteractive: false,
    environment: "production",
    logger: noopLogger,
    ...overrides,
  };
}

function makeCtx(runtime: RuntimeContext): CommandContext {
  return {
    runtime,
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

const runningPidMetadata: HostPidMetadata = {
  pid: 4242,
  hostId: "host-1",
  version: "1.7.2",
  websocketUrl: "ws://127.0.0.1:9876",
  startedAt: "2026-08-01T00:00:00.000Z",
  processStartIdentity: null,
  processStartIdentityRead: "absent",
  layer0: null,
  layer0Slot: null,
};

const bootstrapMarkers: readonly BootstrapLogEntry[] = [];

// Mirrors `attempt-record-test-support.ts`'s `attemptRecord()` fixture -
// only the fields these tests override differ per case, everything else is
// a plain terminal-shaped default. Kept local because this file mocks the
// whole shared `host-update` read, not a real on-disk record.
function attemptRecord(
  overrides: Partial<HostUpdateAttemptRecord>,
): HostUpdateAttemptRecord {
  return {
    schemaVersion: 2,
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    trigger: "manual",
    targetVersion: "1.2.3",
    phase: "downloading",
    execution: "active",
    continuation: null,
    progress: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
    ...overrides,
  };
}

function validRead(
  overrides: Partial<HostUpdateAttemptRecord>,
): HostUpdateAttemptRead {
  return { kind: "valid", value: attemptRecord(overrides), version: 2 };
}

// The default this file's `store/paths` mock resolves to when a test does
// not point `hostInstallRecordPath` at a temp file - deliberately absent, so
// `readHostInstallRecord` reads it as "no host installed" (ENOENT) rather
// than the machine's real install record.
const ABSENT_INSTALL_RECORD_PATH = "/tmp/test-host-home/absent-install.json";

// Mirrors `host-restart.test.ts`'s `writeInstallRecordForAttestation` fixture
// shape - only the fields these tests override differ per case.
function installRecordFixture(
  overrides: Partial<HostInstallRecord>,
): HostInstallRecord {
  return {
    installId: "host-status-observational-install",
    version: "2.0.0",
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry", value: "2.0.0" },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath: "/tmp/test-host-home/host/traycer-host",
    executableSha256: null,
    ...overrides,
  };
}

// Per-test temp dir for a written install record, torn down in `afterEach`.
// `hostInstallRecordPathValue` is reset to the absent default in the SAME
// `beforeEach` so a test that does not call this leaves the mock exactly
// where it started.
let installRecordTmpDir: string | null = null;

function pointInstallRecordAtTempFile(contents: string): void {
  installRecordTmpDir = mkdtempSync(
    join(tmpdir(), "traycer-host-status-install-"),
  );
  const path = join(installRecordTmpDir, "install.json");
  writeFileSync(path, contents, "utf8");
  mocks.hostInstallRecordPathValue = path;
}

// Same cleanup discipline as `pointInstallRecordAtTempFile`, but the path
// itself is a DIRECTORY rather than a file, so `readFile` throws a real
// errno (EISDIR) instead of parsing JSON. No chmod - CI may run as root,
// which ignores permission bits - so a directory is the reader's own
// unprivileged errno rather than a simulated one.
function pointInstallRecordAtTempDirectory(): void {
  installRecordTmpDir = mkdtempSync(
    join(tmpdir(), "traycer-host-status-install-"),
  );
  const path = join(installRecordTmpDir, "install.json");
  mkdirSync(path, { recursive: true });
  mocks.hostInstallRecordPathValue = path;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readHostPidMetadataMock.mockResolvedValue(null);
  mocks.readBootstrapMarkersMock.mockResolvedValue(bootstrapMarkers);
  mocks.readBootstrapLogTailMock.mockResolvedValue("");
  mocks.isProcessAliveMock.mockReturnValue(false);
  // No update attempt record by default - most of these tests are about the
  // pre-existing payload shape and must not gain a hidden dependency on it.
  mocks.readUpdateAttemptRecordMock.mockResolvedValue({ kind: "absent" });
  mocks.hostInstallRecordPathValue = ABSENT_INSTALL_RECORD_PATH;
});

afterEach(() => {
  if (installRecordTmpDir !== null) {
    rmSync(installRecordTmpDir, { recursive: true, force: true });
    installRecordTmpDir = null;
  }
});

describe("hostStatusCommand - observational (CLI-001)", () => {
  it("never touches provisioning: provisionHost and createServiceController are not called", async () => {
    await hostStatusCommand(makeCtx(makeRuntime({})));

    expect(mocks.provisionHostMock).not.toHaveBeenCalled();
    expect(mocks.createServiceControllerMock).not.toHaveBeenCalled();
  });

  it("payload pins bootstrap: null and leaves the observed fields as read", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(runningPidMetadata);
    mocks.isProcessAliveMock.mockReturnValue(true);
    mocks.readBootstrapMarkersMock.mockResolvedValue(bootstrapMarkers);
    mocks.readBootstrapLogTailMock.mockResolvedValue("log tail");

    const result = await hostStatusCommand(makeCtx(makeRuntime({})));

    expect(result.data).toEqual({
      running: true,
      pidMetadata: runningPidMetadata,
      bootstrapMarkers,
      bootstrapLogPath: "/tmp/test-bootstrap.log",
      bootstrapLogTail: "log tail",
      bootstrap: null,
      updateAttempt: null,
    });
    expect(result.exitCode).toBe(0);
  });

  it("completes with exit 0 even when nothing is installed (pidMetadata null, not running)", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(null);
    mocks.isProcessAliveMock.mockReturnValue(false);

    const result = await hostStatusCommand(makeCtx(makeRuntime({})));

    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({ running: false, bootstrap: null });
    expect(mocks.provisionHostMock).not.toHaveBeenCalled();
  });

  it("human output on the not-running branch includes the 'host ensure' hint", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(null);
    mocks.isProcessAliveMock.mockReturnValue(false);

    const result = await hostStatusCommand(makeCtx(makeRuntime({})));

    expect(result.human).toContain(
      "Run 'traycer host ensure' to install, register, and start the host.",
    );
  });

  it("human output on the running branch omits the 'host ensure' hint", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(runningPidMetadata);
    mocks.isProcessAliveMock.mockReturnValue(true);

    const result = await hostStatusCommand(makeCtx(makeRuntime({})));

    expect(result.human).not.toContain("traycer host ensure");
  });

  // The 2026-09-27 staging outage: a parked record made `host ensure` and
  // every service command refuse, and `host status` still pointed at
  // `ensure` - the exact refusal loop the reader had no way out of. `host
  // update` is the one command that resumes a park, so the not-running hint
  // must name it, and must NOT keep naming `ensure` once a record stands.
  describe("updateAttempt", () => {
    it("a parked record while not running: payload populated, hint names 'host update' and not 'host ensure'", async () => {
      mocks.readHostPidMetadataMock.mockResolvedValue(null);
      mocks.isProcessAliveMock.mockReturnValue(false);
      mocks.readUpdateAttemptRecordMock.mockResolvedValue(
        validRead({
          attemptId: "attempt-parked",
          targetVersion: "2.0.0",
          phase: "waiting-to-activate",
          execution: "parked",
          continuation: "activate",
        }),
      );

      const result = await hostStatusCommand(makeCtx(makeRuntime({})));

      expect(result.data).toMatchObject({
        running: false,
        updateAttempt: {
          attemptId: "attempt-parked",
          targetVersion: "2.0.0",
          phase: "waiting-to-activate",
          execution: "parked",
          continuation: "activate",
        },
      });
      expect(result.human).toContain("traycer host update");
      expect(result.human).not.toContain("traycer host ensure");
    });

    it("an active record (restarting/active) while not running: 'in progress' hint names 'host update'", async () => {
      mocks.readHostPidMetadataMock.mockResolvedValue(null);
      mocks.isProcessAliveMock.mockReturnValue(false);
      mocks.readUpdateAttemptRecordMock.mockResolvedValue(
        validRead({
          attemptId: "attempt-active",
          targetVersion: "2.0.0",
          phase: "restarting",
          execution: "active",
          continuation: "activate",
        }),
      );

      const result = await hostStatusCommand(makeCtx(makeRuntime({})));

      expect(result.data).toMatchObject({
        updateAttempt: { execution: "active" },
      });
      expect(result.human).toContain("in progress");
      expect(result.human).toContain("traycer host update");
    });

    it("a terminal record while not running: updateAttempt is null, old ensure hint stays", async () => {
      mocks.readHostPidMetadataMock.mockResolvedValue(null);
      mocks.isProcessAliveMock.mockReturnValue(false);
      mocks.readUpdateAttemptRecordMock.mockResolvedValue(
        validRead({ execution: "terminal", phase: "verifying" }),
      );

      const result = await hostStatusCommand(makeCtx(makeRuntime({})));

      expect(result.data).toMatchObject({ updateAttempt: null });
      expect(result.human).toContain(
        "Run 'traycer host ensure' to install, register, and start the host.",
      );
    });

    it("an unreadable/corrupt record while not running: updateAttempt is null and status never fails", async () => {
      mocks.readHostPidMetadataMock.mockResolvedValue(null);
      mocks.isProcessAliveMock.mockReturnValue(false);
      mocks.readUpdateAttemptRecordMock.mockResolvedValue({ kind: "corrupt" });

      const result = await hostStatusCommand(makeCtx(makeRuntime({})));

      expect(result.exitCode).toBe(0);
      expect(result.data).toMatchObject({ updateAttempt: null });
      expect(result.human).toContain(
        "Run 'traycer host ensure' to install, register, and start the host.",
      );
    });

    it("running host + parked record: no hint at all, but updateAttempt is still populated", async () => {
      mocks.readHostPidMetadataMock.mockResolvedValue(runningPidMetadata);
      mocks.isProcessAliveMock.mockReturnValue(true);
      mocks.readUpdateAttemptRecordMock.mockResolvedValue(
        validRead({
          attemptId: "attempt-parked-while-running",
          targetVersion: "2.0.0",
          phase: "waiting-to-activate",
          execution: "parked",
          continuation: "activate",
        }),
      );

      const result = await hostStatusCommand(makeCtx(makeRuntime({})));

      expect(result.data).toMatchObject({
        running: true,
        updateAttempt: { execution: "parked" },
      });
      expect(result.human).not.toContain("traycer host update");
      expect(result.human).not.toContain("traycer host ensure");
    });

    // `waiting-for-work` is the busy-before-apply checkpoint: no bytes are
    // placed yet, so the resume compares nothing and always proceeds -
    // `parkedActivationRelaunchable` answers `false` for it by design (it
    // admits only a claimed `waiting-to-activate` park), and `host status`
    // must not report that `false` as `null`-worthy "stale". A claim on the
    // record must not change that (traycer#2208 review).
    it("a waiting-for-work parked record with a claim while not running: parkMatchesInstall is null, hint is resumable", async () => {
      mocks.readHostPidMetadataMock.mockResolvedValue(null);
      mocks.isProcessAliveMock.mockReturnValue(false);
      mocks.readUpdateAttemptRecordMock.mockResolvedValue(
        validRead({
          attemptId: "attempt-waiting-for-work",
          targetVersion: "2.0.0",
          phase: "waiting-for-work",
          execution: "parked",
          continuation: "resume-apply",
          claim: {
            installedVersion: "1.7.0",
            installGeneration: "id:some-install",
            stageFingerprint: null,
            allowDowngrade: false,
            acceptStoreFormatLoss: false,
          },
        }),
      );

      const result = await hostStatusCommand(makeCtx(makeRuntime({})));

      expect(result.data).toMatchObject({
        updateAttempt: { parkMatchesInstall: null },
      });
      expect(result.human).toContain("run 'traycer host update' to resume it");
      expect(result.human).not.toContain("no longer matches");
      expect(result.human).not.toContain("traycer host ensure");
    });

    // A malformed `install.json` makes `readHostInstallRecord` throw
    // `HOST_INSTALL_RECORD_INVALID`; `parkedActivationRelaunchable` turns
    // that into `null` rather than propagating, and `host status` (an
    // OBSERVATIONAL read, CLI-001) must resolve rather than die on it.
    it("a claimed waiting-to-activate park whose install record is malformed JSON: command resolves, parkMatchesInstall null, hint names 'traycer host doctor'", async () => {
      mocks.readHostPidMetadataMock.mockResolvedValue(null);
      mocks.isProcessAliveMock.mockReturnValue(false);
      pointInstallRecordAtTempFile("{ not json");
      mocks.readUpdateAttemptRecordMock.mockResolvedValue(
        validRead({
          attemptId: "attempt-parked-unreadable-install",
          targetVersion: "2.0.0",
          phase: "waiting-to-activate",
          execution: "parked",
          continuation: "activate",
          claim: {
            installedVersion: "2.0.0",
            installGeneration: "id:whatever-install",
            stageFingerprint: null,
            allowDowngrade: false,
            acceptStoreFormatLoss: false,
          },
        }),
      );

      const result = await hostStatusCommand(makeCtx(makeRuntime({})));

      expect(result.exitCode).toBe(0);
      expect(result.data).toMatchObject({
        running: false,
        updateAttempt: { parkMatchesInstall: null },
      });
      expect(result.human).toContain("install record could not be read");
      expect(result.human).toContain("'traycer host doctor'");
    });

    // A DIRECTORY at the install record's path makes `readHostInstallRecord`
    // throw a real errno (EISDIR) rather than `HOST_INSTALL_RECORD_INVALID`;
    // the reader maps only ENOENT to "absent" and rethrows every other
    // errno, and `parkedActivationRelaunchable` folds that errno into `null`
    // the same way it folds malformed JSON. This pins the observational
    // path (`host status`) surviving it rather than dying (traycer#2208
    // review, Codex P2).
    it("a claimed waiting-to-activate park whose install record cannot be read (errno, not ENOENT): command resolves, parkMatchesInstall null, hint names 'traycer host doctor'", async () => {
      mocks.readHostPidMetadataMock.mockResolvedValue(null);
      mocks.isProcessAliveMock.mockReturnValue(false);
      pointInstallRecordAtTempDirectory();
      mocks.readUpdateAttemptRecordMock.mockResolvedValue(
        validRead({
          attemptId: "attempt-parked-unreadable-install-errno",
          targetVersion: "2.0.0",
          phase: "waiting-to-activate",
          execution: "parked",
          continuation: "activate",
          claim: {
            installedVersion: "2.0.0",
            installGeneration: "id:whatever-install",
            stageFingerprint: null,
            allowDowngrade: false,
            acceptStoreFormatLoss: false,
          },
        }),
      );

      const result = await hostStatusCommand(makeCtx(makeRuntime({})));

      expect(result.exitCode).toBe(0);
      expect(result.data).toMatchObject({
        running: false,
        updateAttempt: { parkMatchesInstall: null },
      });
      expect(result.human).toContain("install record could not be read");
      expect(result.human).toContain("'traycer host doctor'");
    });

    it("a claimed waiting-to-activate park whose claim matches a temp install record: parkMatchesInstall true, resumable hint", async () => {
      mocks.readHostPidMetadataMock.mockResolvedValue(null);
      mocks.isProcessAliveMock.mockReturnValue(false);
      const installed = installRecordFixture({
        installId: "host-status-matching-install",
        version: "2.0.0",
      });
      pointInstallRecordAtTempFile(JSON.stringify(installed));
      mocks.readUpdateAttemptRecordMock.mockResolvedValue(
        validRead({
          attemptId: "attempt-parked-matching-install",
          targetVersion: "2.0.0",
          phase: "waiting-to-activate",
          execution: "parked",
          continuation: "activate",
          claim: {
            installedVersion: "2.0.0",
            installGeneration: encodeInstallGeneration(installed),
            stageFingerprint: null,
            allowDowngrade: false,
            acceptStoreFormatLoss: false,
          },
        }),
      );

      const result = await hostStatusCommand(makeCtx(makeRuntime({})));

      expect(result.data).toMatchObject({
        updateAttempt: { parkMatchesInstall: true },
      });
      expect(result.human).toContain("run 'traycer host update' to resume it");
      expect(result.human).not.toContain("no longer matches");
    });

    it("a claimed waiting-to-activate park whose claim mismatches a temp install record: parkMatchesInstall false, stale hint", async () => {
      mocks.readHostPidMetadataMock.mockResolvedValue(null);
      mocks.isProcessAliveMock.mockReturnValue(false);
      const installed = installRecordFixture({
        installId: "host-status-mismatching-install",
        version: "2.0.0",
      });
      pointInstallRecordAtTempFile(JSON.stringify(installed));
      mocks.readUpdateAttemptRecordMock.mockResolvedValue(
        validRead({
          attemptId: "attempt-parked-mismatching-install",
          targetVersion: "2.0.0",
          phase: "waiting-to-activate",
          execution: "parked",
          continuation: "activate",
          claim: {
            // Disagrees with `installed.version` ("2.0.0") above.
            installedVersion: "1.6.0",
            installGeneration: encodeInstallGeneration(installed),
            stageFingerprint: null,
            allowDowngrade: false,
            acceptStoreFormatLoss: false,
          },
        }),
      );

      const result = await hostStatusCommand(makeCtx(makeRuntime({})));

      expect(result.data).toMatchObject({
        updateAttempt: { parkMatchesInstall: false },
      });
      expect(result.human).toContain("installed host no longer matches");
      expect(result.human).toContain("'traycer host ensure' to start the host");
    });
  });
});
