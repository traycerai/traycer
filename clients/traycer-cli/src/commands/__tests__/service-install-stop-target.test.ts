import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";
import type { ServiceInstallArgs } from "../service-install";
import { writeInstalledHostFixture } from "./service-install-host-fixture";

// A `host service install --takeover` that Desktop's force restart bound to
// one host process (`--expect-host-pid`) holds the whole command to that
// host: the takeover's stop AND the install after it, whose bootouts and
// bootstrap recovery reach whatever the label runs. The install here is the
// real macOS controller over a recording runner, so what is refused is the
// controller's own `launchctl` call. The takeover actuator is the one
// stand-in: it reports its stop as done, which is the moment the host the
// person confirmed is gone and another can be published.

const mocks = vi.hoisted(() => ({
  takeoverMock: vi.fn(),
  // Runs after each capability check the command makes, so a test can publish
  // a host at one chosen check.
  afterCapabilityCheck: null as (() => void) | null,
  realController: null as import("../../service").ServiceController | null,
}));

vi.mock("../../host/update-mutation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/update-mutation")>();
  return {
    ...actual,
    takeoverDesktopRegistrationWithAttempt: (
      ...callArgs: Parameters<typeof mocks.takeoverMock>
    ) => mocks.takeoverMock(...callArgs),
  };
});

vi.mock("../../host/update-contender", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/update-contender")>();
  return {
    ...actual,
    requireCliUpdateMutationCapability: async (
      ...callArgs: Parameters<typeof actual.requireCliUpdateMutationCapability>
    ) => {
      await actual.requireCliUpdateMutationCapability(...callArgs);
      mocks.afterCapabilityCheck?.();
    },
  };
});

vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: () => {
      if (mocks.realController === null) {
        throw new Error("no controller staged for this test");
      }
      return mocks.realController;
    },
    resolveServiceCliInvocation: async () => ({
      command: "/usr/local/bin/traycer",
      args: [] as string[],
    }),
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

// The real `publishHostStartAdoption` waits for a supervisor to acknowledge a
// spawn that never happens under a recording runner.
vi.mock("../../host/host-start-adoption", () => ({
  publishHostStartAdoption: async () => ({
    waitForSpawn: async () => undefined,
    cancel: async () => undefined,
  }),
}));

// `node:os.homedir()` is mocked so the lock, `pid.json`, the launcher and the
// plist all live under a temp home, never the operator's real one. One home
// for the file, emptied between tests: the modules under test bind their
// paths when first loaded, and the contender's lock handles must stay in the
// module instance that issued them, so the registry is not reset.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: makeTempDir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = makeTempDir(
      joinPath(actual.tmpdir(), "traycer-service-install-stop-target-test-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

afterAll(() => {
  if (osHome.current !== "") {
    rmSync(osHome.current, { recursive: true, force: true });
  }
});

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

const CONFIRMED_HOST = { pid: 4242, startIdentity: "linux:boot-a 4242" };

function boundTakeoverArgs(): ServiceInstallArgs {
  return {
    enableLinger: true,
    allowSelfInvocation: false,
    takeover: true,
    attemptAdoption: null,
    lifecycleOrigin: "desktop",
    expectedHost: CONFIRMED_HOST,
  };
}

describe.skipIf(process.platform === "win32")(
  "host service install --takeover bound to one host process, through the macOS controller",
  () => {
    beforeEach(async () => {
      const home = homedir();
      for (const entry of readdirSync(home)) {
        rmSync(join(home, entry), { recursive: true, force: true });
      }
      // Registration starts the installed host; the command refuses without a
      // real install record and executable.
      writeInstalledHostFixture(
        (await import("../../store/paths")).hostInstallRecordPath("production"),
      );
      mocks.takeoverMock.mockReset();
      mocks.takeoverMock.mockResolvedValue({
        kind: "cli-host-stopped",
        cooperativeStop: "stopped",
      });
      mocks.realController = null;
      mocks.afterCapabilityCheck = null;
    });

    async function writePidMetadata(published: {
      readonly pid: number;
      readonly identity: string | null;
    }): Promise<void> {
      const { hostPidMetadataPath } = await import("../../store/paths");
      const path = hostPidMetadataPath("production");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          pid: published.pid,
          hostId: "host-b",
          version: "1.9.0",
          websocketUrl: `ws://127.0.0.1:${String(published.pid)}/rpc`,
          startedAt: "2026-09-01T00:00:00.000Z",
          processStartIdentity: published.identity,
        }),
        "utf8",
      );
    }

    // A live host other than the confirmed one: this test process.
    async function publishReplacement(): Promise<void> {
      const { ownProcessStartIdentity } =
        await import("../../store/process-identity");
      await writePidMetadata({
        pid: process.pid,
        identity: ownProcessStartIdentity(),
      });
    }

    it("never boots out the loaded job when a different host is published after the takeover's stop, and says the stop had already run", async () => {
      const { createMacosController } =
        await import("../../service/platforms/macos");
      const { buildServiceInstallCommand } = await import("../service-install");
      await writePidMetadata({
        pid: CONFIRMED_HOST.pid,
        identity: CONFIRMED_HOST.startIdentity,
      });
      mocks.takeoverMock.mockImplementation(async () => {
        await publishReplacement();
        return { kind: "cli-host-stopped", cooperativeStop: "stopped" };
      });
      const calls: string[] = [];
      mocks.realController = createMacosController(async (command, args) => {
        calls.push([command, ...args].join(" "));
        return { stdout: "", stderr: "", exitCode: 0 };
      });

      await expect(
        buildServiceInstallCommand(boundTakeoverArgs())(fakeCtx()),
      ).rejects.toMatchObject({
        code: "E_HOST_RESTART_TARGET_CHANGED",
        message: expect.stringContaining(
          "its stop had already run against the confirmed host",
        ),
      });
      expect(calls.some((call) => call.includes("bootout"))).toBe(false);
      expect(calls.some((call) => call.includes("bootstrap"))).toBe(false);
    });

    // The first bootstrap loses a race with another registrar, and the
    // recovery boots the label out before bootstrapping again. A bootstrap
    // that failed launched nothing, so the recovery's bootout is still held
    // to the confirmed host.
    it("never runs the bootstrap race's recovery bootout when a different host is published as the first bootstrap fails", async () => {
      const { buildServiceInstallCommand } = await import("../service-install");
      const { createMacosController } =
        await import("../../service/platforms/macos");
      const { ProcessRunError } = await import("../../service/process-runner");
      await writePidMetadata({
        pid: CONFIRMED_HOST.pid,
        identity: CONFIRMED_HOST.startIdentity,
      });
      const calls: string[] = [];
      mocks.realController = createMacosController(async (command, args) => {
        calls.push([command, ...args].join(" "));
        if (args[0] === "bootstrap") {
          await publishReplacement();
          throw new ProcessRunError(
            "launchctl bootstrap exited with code 37",
            command,
            args,
            37,
            "",
            "Bootstrap failed: 37: Service is already loaded\n",
          );
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      });

      await expect(
        buildServiceInstallCommand(boundTakeoverArgs())(fakeCtx()),
      ).rejects.toMatchObject({ code: "E_HOST_RESTART_TARGET_CHANGED" });
      // The reload's own bootout, before the bootstrap, ran; the recovery's
      // did not, and nothing bootstrapped again.
      expect(calls.filter((call) => call.includes("bootout"))).toHaveLength(1);
      expect(calls.filter((call) => call.includes("bootstrap"))).toHaveLength(
        1,
      );
    });

    // The initial bootout of a loaded job is the first service call that can
    // stop the host. A host published at the check in front of it is a
    // target-change refusal, not a failed bootout.
    it("refuses with the target-change code, not an install failure, when a different host is published at the check before the initial bootout", async () => {
      const { createMacosController } =
        await import("../../service/platforms/macos");
      const { buildServiceInstallCommand } = await import("../service-install");
      const args = { ...boundTakeoverArgs(), takeover: false };
      const { hostPidMetadataPath } = await import("../../store/paths");
      const { ownProcessStartIdentity } =
        await import("../../store/process-identity");
      // Synchronous: the check that publishes it is followed at once by the
      // read that has to see it.
      const publishNow = (): void => {
        writeFileSync(
          hostPidMetadataPath("production"),
          JSON.stringify({
            pid: process.pid,
            hostId: "host-b",
            version: "1.9.0",
            websocketUrl: `ws://127.0.0.1:${String(process.pid)}/rpc`,
            startedAt: "2026-09-01T00:00:00.000Z",
            processStartIdentity: ownProcessStartIdentity(),
          }),
          "utf8",
        );
      };

      // `checks` counts the capability checks the command makes; each runner
      // call records how many had run before it, so the last check in front
      // of the bootout can be found with a run that publishes nothing.
      async function install(publishAt: number | null): Promise<{
        readonly calls: string[];
        readonly checksAtCall: number[];
        readonly error: unknown;
      }> {
        await writePidMetadata({
          pid: CONFIRMED_HOST.pid,
          identity: CONFIRMED_HOST.startIdentity,
        });
        let checks = 0;
        mocks.afterCapabilityCheck = () => {
          checks += 1;
          if (checks === publishAt) publishNow();
        };
        const calls: string[] = [];
        const checksAtCall: number[] = [];
        mocks.realController = createMacosController(async (command, argv) => {
          calls.push([command, ...argv].join(" "));
          checksAtCall.push(checks);
          return { stdout: "", stderr: "", exitCode: 0 };
        });
        const error = await buildServiceInstallCommand(args)(fakeCtx()).then(
          () => null,
          (cause: unknown) => cause,
        );
        return { calls, checksAtCall, error };
      }

      const dry = await install(null);
      const bootoutAt = dry.calls.findIndex((call) => call.includes("bootout"));
      expect(bootoutAt).toBeGreaterThanOrEqual(0);
      expect(dry.error).toBeNull();

      const raced = await install(dry.checksAtCall[bootoutAt] ?? null);

      expect(raced.error).toMatchObject({
        code: "E_HOST_RESTART_TARGET_CHANGED",
      });
      expect(raced.calls.some((call) => call.includes("bootout"))).toBe(false);
    });
  },
);
