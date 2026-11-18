import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wiring pin: `probeUpdateAttemptLock` existing is not the same thing as
// runDoctor consulting it. This writes a REAL lock file at the environment's
// real `updateAttemptLockPath(hostHomeDir(env))` and lets `runDoctor` run the
// REAL probe end to end (real `verifyProcessIdentityAsync`, real
// `lockHolderLivenessGivenPublisher`) against a genuinely exited pid - unlike
// the marker-lock wiring test, the probe module itself is deliberately left
// unmocked here, since the point is to prove the engine's own wiring reaches
// the real rule, not to pin a call shape against a stub.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-doctor-attempt-lock-wiring-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_USERPROFILE === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  }
  rmSync(workHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock("../launchd-wedge");
  vi.doUnmock("../systemd-health");
  vi.doUnmock("../../manifest/host-install");
  vi.doUnmock("../../host/bootstrap-log");
  vi.doUnmock("../../host/pid-metadata");
  vi.doUnmock("../../service");
});

/** A pid that has genuinely exited - spawn a trivial child and wait it out. */
function spawnAndWaitDeadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "0"]);
  if (result.pid === undefined) {
    throw new Error("could not obtain a pid from the spawned child");
  }
  return result.pid;
}

function mockRoutineDoctorDependencies(hostExecutablePath: string): void {
  mkdirSync(join(hostExecutablePath, ".."), { recursive: true });
  writeFileSync(hostExecutablePath, "host-bin");
  vi.doMock("../../manifest/host-install", () => ({
    readHostInstallRecord: () => ({
      version: "1.4.0",
      environment: "production",
      executablePath: hostExecutablePath,
      installedAt: "2026-04-01T00:00:00Z",
      source: "registry",
      archiveSha256: "f".repeat(64),
      signatureKeyId: "registry:prod-2026",
    }),
  }));
  vi.doMock("../../host/bootstrap-log", () => ({
    readBootstrapMarkers: async () => [],
  }));
  vi.doMock("../../host/pid-metadata", () => ({
    readHostPidMetadata: async () => null,
  }));
  vi.doMock("../../service", () => ({
    createServiceController: () => ({
      status: async () => ({
        state: "externally-managed",
        version: "1.4.0",
        listenUrl: null,
        pid: null,
      }),
      install: async () => undefined,
      uninstall: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      restart: async () => undefined,
    }),
    serviceLabelFor: (environment: string) => ({
      id: `ai.traycer.host.${environment}`,
    }),
  }));
  vi.doMock("../launchd-wedge", () => ({
    createRealLaunchdPrintRunner: () => async () => {
      throw new Error("real runner must not be invoked in this test");
    },
    probeMacosWedgedJob: async () => null,
  }));
  vi.doMock("../systemd-health", () => ({
    createRealSystemdProbeRunner: () => async () => {
      throw new Error("real runner must not be invoked in this test");
    },
    probeLinuxSystemdHealth: async () => [],
  }));
}

describe("runDoctor update-attempt lock wiring", () => {
  it.skipIf(process.platform === "win32")(
    "reports HOST_UPDATE_ATTEMPT_LOCK_UNBREAKABLE for a dead publisher retained past its own death, at the environment's real lock path",
    async () => {
      const hostExecutablePath = join(workHome, "bin", "host");
      mockRoutineDoctorDependencies(hostExecutablePath);

      const { hostHomeDir } = await import("../../store/paths");
      const { updateAttemptLockPath } =
        await import("@traycer-clients/shared/host-update");
      const lockPath = updateAttemptLockPath(hostHomeDir("production"));
      mkdirSync(join(lockPath, ".."), { recursive: true });
      const deadPid = spawnAndWaitDeadPid();
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: deadPid,
          reason: "host-maintenance-lease",
          startedAt: "2026-09-06T22:00:00.000Z",
          hostname: null,
          token: "wiring-token-retain",
          processStartedAtMs: null,
          processStartIdentity: null,
          retainOnPublisherDeath: true,
        }),
      );

      const { runDoctor } = await import("../engine");
      const result = await runDoctor({
        environment: "production",
        portConflictDeps: null,
      });

      const issue = result.issues.find(
        (i) => i.code === "HOST_UPDATE_ATTEMPT_LOCK_UNBREAKABLE",
      );
      expect(issue).toBeDefined();
      expect(issue?.severity).toBe("warning");
      expect(issue?.message).toContain(lockPath);
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports no such issue for the same dead publisher without the retain flag - the lock self-heals",
    async () => {
      const hostExecutablePath = join(workHome, "bin", "host");
      mockRoutineDoctorDependencies(hostExecutablePath);

      const { hostHomeDir } = await import("../../store/paths");
      const { updateAttemptLockPath } =
        await import("@traycer-clients/shared/host-update");
      const lockPath = updateAttemptLockPath(hostHomeDir("production"));
      mkdirSync(join(lockPath, ".."), { recursive: true });
      const deadPid = spawnAndWaitDeadPid();
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: deadPid,
          reason: "host-maintenance-lease",
          startedAt: "2026-09-06T22:00:00.000Z",
          hostname: null,
          token: "wiring-token-no-retain",
          processStartedAtMs: null,
          processStartIdentity: null,
        }),
      );

      const { runDoctor } = await import("../engine");
      const result = await runDoctor({
        environment: "production",
        portConflictDeps: null,
      });

      const issue = result.issues.find(
        (i) => i.code === "HOST_UPDATE_ATTEMPT_LOCK_UNBREAKABLE",
      );
      expect(issue).toBeUndefined();
    },
  );
});
