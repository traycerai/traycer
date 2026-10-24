import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";
import type { ServiceInstallArgs } from "../service-install";
import { writeInstalledHostFixture } from "./service-install-host-fixture";

// A `host service install --takeover` that Desktop's force restart bound to
// one host process (`--expect-host-pid`) waits for the real CLI lock before it
// boots anything out, and the lock is held by a genuine foreign process here
// (`store/__tests__/fixtures/cli-lock-worker.ts`, as in
// `host-restart-lock.test.ts`). Another actor can publish a healthy
// replacement in that wait, so `pid.json` is read after the lock is acquired,
// not before: the test changes it WHILE the command is blocked.
//
// Only the actuators behind the check are spied (`takeover…`/`install…`
// `WithAttempt`), plus the sign-in pre-flight and the service controller,
// which would otherwise touch the operator's real home. The lock, the
// contender layer and `pid.json` are real.

const mocks = vi.hoisted(() => ({
  takeoverMock: vi.fn(),
  installMock: vi.fn(),
}));

vi.mock("../../host/update-mutation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/update-mutation")>();
  return {
    ...actual,
    takeoverDesktopRegistrationWithAttempt: (
      ...callArgs: Parameters<typeof mocks.takeoverMock>
    ) => mocks.takeoverMock(...callArgs),
    installHostServiceWithAttempt: (
      ...callArgs: Parameters<typeof mocks.installMock>
    ) => mocks.installMock(...callArgs),
  };
});

vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: () => ({
      install: async () => undefined,
      takeoverDesktopRegistration: async () => ({
        kind: "cli-host-stopped" as const,
        cooperativeStop: "stopped" as const,
      }),
      hostStartAdoptionLabel: async (label: { id: string }) => label.id,
    }),
    resolveServiceCliInvocation: async () => ({
      command: "/usr/local/bin/traycer",
      args: [] as string[],
    }),
    serviceLabelFor: (environment: "dev" | "production") => ({
      id: "ai.traycer.host",
      displayName: "Traycer Host",
      environment,
      devSlot: null,
    }),
    serviceManifestPath: () => "/tmp/ai.traycer.host.plist",
    windowsTaskName: () => "ai.traycer.host",
  };
});

vi.mock("../../host/install-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/install-auth")>();
  return {
    ...actual,
    runSignInPreflight: async () => ({
      state: "signed-in" as const,
      reason: null,
    }),
    maybeProvisionCredential: async () => null,
  };
});

vi.mock("../../host/attested-install-runtime", () => ({
  attestInstallRuntime: async () => ({
    installGeneration: null,
    runtimeVersion: null,
    runtimeWasNull: false,
  }),
}));

// Same sandbox as `host-restart-lock.test.ts`: `node:os.homedir()` is mocked
// so the lock file and `pid.json` live under a per-test temp home, never the
// operator's real `~/.traycer`.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(path)) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${path}`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function spawnLockWorker(
  workerScript: string,
  env: Record<string, string>,
): {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
} {
  const child = spawn("bun", ["run", workerScript], {
    env: { ...process.env, ...env },
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  return { child, exited };
}

const WORKER_SCRIPT = join(
  __dirname,
  "..",
  "..",
  "store",
  "__tests__",
  "fixtures",
  "cli-lock-worker.ts",
);

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

function baseArgs(overrides: Partial<ServiceInstallArgs>): ServiceInstallArgs {
  return {
    enableLinger: true,
    allowSelfInvocation: false,
    takeover: false,
    attemptAdoption: null,
    lifecycleOrigin: "terminal",
    expectedHost: null,
    ...overrides,
  };
}

describe.skipIf(process.platform === "win32")(
  "host service install --takeover - genuine cli-lock contention",
  () => {
    beforeEach(async () => {
      workHome = mkdtempSync(
        join(tmpdir(), "traycer-service-install-lock-test-"),
      );
      osHome.current = workHome;
      process.env.HOME = workHome;
      process.env.USERPROFILE = workHome;
      vi.resetModules();
      // The registration starts the installed host, so the command refuses
      // without a real install record and executable (`service-install-missing-host.test.ts`).
      writeInstalledHostFixture(
        (await import("../../store/paths")).hostInstallRecordPath("production"),
      );
      mocks.takeoverMock.mockReset();
      mocks.takeoverMock.mockResolvedValue({
        kind: "cli-host-stopped",
        cooperativeStop: "stopped",
      });
      mocks.installMock.mockReset();
      mocks.installMock.mockResolvedValue(undefined);
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
    });

    async function pidMetadataWriter(): Promise<
      (pid: number, identity: string | null) => void
    > {
      const { hostPidMetadataPath } = await import("../../store/paths");
      const path = hostPidMetadataPath("production");
      return (pid, identity) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          JSON.stringify({
            pid,
            hostId: "host-a",
            version: "1.9.0",
            websocketUrl: `ws://127.0.0.1:${String(pid)}/rpc`,
            startedAt: "2026-09-01T00:00:00.000Z",
            processStartIdentity: identity,
          }),
          "utf8",
        );
      };
    }

    it("a takeover bound to one host refuses a host published while it waited for the lock", async () => {
      const { cliLockPath, ensureCliInstallHomeDir, hostHomeDir } =
        await import("../../store/paths");
      const { ownProcessStartIdentity } =
        await import("../../store/process-identity");
      expect(hostHomeDir("production").startsWith(workHome)).toBe(true);
      await ensureCliInstallHomeDir("production");
      const lockPath = cliLockPath("production");
      const writePidMetadata = await pidMetadataWriter();
      const confirmedHost = { pid: 4242, startIdentity: "linux:boot-a 4242" };
      // Published as the confirmed host when the restart was requested.
      writePidMetadata(confirmedHost.pid, confirmedHost.startIdentity);

      const holdBarrierDir = mkdtempSync(
        join(tmpdir(), "traycer-service-install-lock-barrier-"),
      );
      const { exited } = spawnLockWorker(WORKER_SCRIPT, {
        WORKER_LOCK_PATH: lockPath,
        WORKER_MARKER_DIR: holdBarrierDir,
        WORKER_LABEL: "foreign-holder",
        WORKER_HOLD_BARRIER_DIR: holdBarrierDir,
      });

      try {
        await waitForFile(join(holdBarrierDir, "held"));

        const { buildServiceInstallCommand } =
          await import("../service-install");
        const settled = buildServiceInstallCommand(
          baseArgs({
            takeover: true,
            lifecycleOrigin: "desktop",
            expectedHost: confirmedHost,
          }),
        )(fakeCtx()).then(
          () => null,
          (err: unknown) => err,
        );

        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(mocks.takeoverMock).not.toHaveBeenCalled();

        // A healthy replacement is published while the command is still
        // waiting for the lock: this test process stands in for it, a live
        // process under its own identity.
        writePidMetadata(process.pid, ownProcessStartIdentity());

        writeFileSync(join(holdBarrierDir, "release"), "");
        await expect(settled).resolves.toMatchObject({
          code: "E_HOST_RESTART_TARGET_CHANGED",
        });
        expect(mocks.takeoverMock).not.toHaveBeenCalled();
        expect(mocks.installMock).not.toHaveBeenCalled();
      } finally {
        writeFileSync(join(holdBarrierDir, "release"), "");
        await exited;
        rmSync(holdBarrierDir, { recursive: true, force: true });
      }
    }, 20_000);

    it("a takeover bound to one host proceeds after the lock wait when pid.json still names it", async () => {
      const { cliLockPath, ensureCliInstallHomeDir } =
        await import("../../store/paths");
      await ensureCliInstallHomeDir("production");
      const lockPath = cliLockPath("production");
      const writePidMetadata = await pidMetadataWriter();
      const confirmedHost = { pid: 4242, startIdentity: "linux:boot-a 4242" };
      writePidMetadata(confirmedHost.pid, confirmedHost.startIdentity);

      const holdBarrierDir = mkdtempSync(
        join(tmpdir(), "traycer-service-install-lock-barrier-ctrl-"),
      );
      const { exited } = spawnLockWorker(WORKER_SCRIPT, {
        WORKER_LOCK_PATH: lockPath,
        WORKER_MARKER_DIR: holdBarrierDir,
        WORKER_LABEL: "foreign-holder",
        WORKER_HOLD_BARRIER_DIR: holdBarrierDir,
      });

      try {
        await waitForFile(join(holdBarrierDir, "held"));

        const { buildServiceInstallCommand } =
          await import("../service-install");
        const pending = buildServiceInstallCommand(
          baseArgs({
            takeover: true,
            lifecycleOrigin: "desktop",
            expectedHost: confirmedHost,
          }),
        )(fakeCtx());

        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(mocks.takeoverMock).not.toHaveBeenCalled();

        writeFileSync(join(holdBarrierDir, "release"), "");
        await pending;
        expect(mocks.takeoverMock).toHaveBeenCalledTimes(1);
        expect(mocks.installMock).toHaveBeenCalledTimes(1);
      } finally {
        writeFileSync(join(holdBarrierDir, "release"), "");
        await exited;
        rmSync(holdBarrierDir, { recursive: true, force: true });
      }
    }, 20_000);
  },
);
