import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  CompetingRegistrationRetirement,
  ServiceController,
  ServiceLabel,
} from "../index";
import {
  createBytesOnlyInstallLifecycle,
  createServiceInstallLifecycle,
  type BootstrapServiceOptions,
  type ServiceInstallLifecycleState,
} from "../install-lifecycle";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { SwapLockRecovery } from "../../installer";

const mocks = vi.hoisted(() => ({
  createServiceControllerMock: vi.fn(),
  serviceLabelForMock: vi.fn(),
  resolveServiceCliInvocationMock: vi.fn(),
  readRegisteredCliInvocationMock: vi.fn(),
  cliLoggerWarnMock: vi.fn(),
  killLingeringSlotProcessesMock: vi.fn(),
  describeSlotLockHoldersMock: vi.fn(),
}));

// The externally-managed branch reports an unforeseen repair failure through
// the real CLI logger, which appends to the invoking user's `~/.traycer` log
// file. Stub it so the suite stays hermetic and that warning is assertable.
vi.mock("../../logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logger")>();
  return {
    ...actual,
    createCliLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: mocks.cliLoggerWarnMock,
      error: vi.fn(),
    }),
  };
});

vi.mock("../index", () => ({
  createServiceController: mocks.createServiceControllerMock,
  serviceLabelFor: mocks.serviceLabelForMock,
}));

vi.mock("../cli-binary", () => ({
  resolveServiceCliInvocation: mocks.resolveServiceCliInvocationMock,
}));

// The update path's no-repoint preservation reads the REAL registered
// LaunchAgent plist under the invoking user's home on darwin - stub it so
// the suite never depends on (or leaks) the developer's actual host
// registration.
vi.mock("../platforms/macos", () => ({
  readRegisteredCliInvocation: mocks.readRegisteredCliInvocationMock,
}));

// The Windows swap-lock recovery functions shell out to schtasks /
// powershell / taskkill - stub the module so the wiring tests can assert
// the lifecycle hands the label through without touching the OS.
vi.mock("../platforms/windows", () => ({
  killLingeringSlotProcesses: mocks.killLingeringSlotProcessesMock,
  describeSlotLockHolders: mocks.describeSlotLockHoldersMock,
}));

const label: ServiceLabel = {
  id: "ai.traycer.host",
  displayName: "Traycer Host",
  environment: "production",
  devSlot: null,
};

type HarnessServiceState =
  "running" | "stopped" | "not-installed" | "externally-managed";

interface ControllerHarness {
  readonly controller: ServiceController;
  readonly install: Mock<() => Promise<void>>;
  readonly start: Mock<() => Promise<void>>;
  readonly restart: Mock<() => Promise<void>>;
  readonly stop: Mock<() => Promise<void>>;
  // The kickstart -k half of the post-swap externally-managed relaunch -
  // surfaced separately from `start` so tests can assert which of the two
  // kickstart routes the lifecycle actually took.
  readonly relaunchAfterRestart: Mock<() => Promise<void>>;
  readonly retireCompetingRegistration: Mock<
    () => Promise<CompetingRegistrationRetirement>
  >;
}

function makeController(initialState: HarnessServiceState): ControllerHarness {
  const currentState = initialState;
  const install = vi.fn(async () => undefined);
  const start = vi.fn(async () => undefined);
  const restart = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const relaunchAfterRestart = vi.fn(async () => {
    await start();
  });
  const retireCompetingRegistration = vi.fn(
    async (): Promise<CompetingRegistrationRetirement> => ({
      kind: "nothing-to-retire",
    }),
  );
  const controller: ServiceController = {
    status: vi.fn(async () => ({
      state: currentState,
      version: null,
      listenUrl: null,
      pid: null,
    })),
    install,
    uninstall: vi.fn(async () => undefined),
    stop,
    start,
    restart,
    stopForRestart: vi.fn(async () => {
      await stop();
      return { forcedRecycle: false };
    }),
    relaunchAfterRestart,
    retireCompetingRegistration,
    takeoverDesktopRegistration: vi.fn(async () => ({
      kind: "not-applicable" as const,
    })),
  };
  return {
    controller,
    install,
    start,
    restart,
    stop,
    relaunchAfterRestart,
    retireCompetingRegistration,
  };
}

const bootstrap: BootstrapServiceOptions = {
  enableLinger: true,
  allowSelfInvocation: true,
};

async function runLifecycle(
  priorState: HarnessServiceState,
  options: BootstrapServiceOptions | null,
  force: boolean,
): Promise<{
  readonly state: ServiceInstallLifecycleState;
  readonly harness: ControllerHarness;
}> {
  const harness = makeController(priorState);
  mocks.createServiceControllerMock.mockReturnValue(harness.controller);
  const handle = createServiceInstallLifecycle({
    environment: "production",
    bootstrap: options,
    force,
  });
  await handle.lifecycle.beforeSwap();
  await handle.lifecycle.afterSwap();
  return { state: handle.state, harness };
}

describe("service install lifecycle re-registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.serviceLabelForMock.mockReturnValue(label);
    mocks.resolveServiceCliInvocationMock.mockResolvedValue({
      command: "/usr/local/bin/traycer",
      args: [],
    });
    // Default: no registered manifest to preserve - updates fall through to
    // normal resolution, matching the pre-preservation expectations below.
    mocks.readRegisteredCliInvocationMock.mockResolvedValue(null);
  });

  it.each(["running", "stopped"] as const)(
    "re-registers an existing %s service with install, not start/restart",
    async (priorState) => {
      const { state, harness } = await runLifecycle(
        priorState,
        bootstrap,
        false,
      );

      expect(state.priorState).toBe(priorState);
      expect(state.postSwapAction).toBe("install");
      expect(harness.install).toHaveBeenCalledTimes(1);
      expect(harness.start).not.toHaveBeenCalled();
      expect(harness.restart).not.toHaveBeenCalled();
      expect(mocks.resolveServiceCliInvocationMock).toHaveBeenCalledWith({
        environment: "production",
        override: null,
        allowSelfInvocation: true,
      });
      expect(harness.install).toHaveBeenCalledWith({
        label,
        cli: { command: "/usr/local/bin/traycer", args: [] },
        enableLinger: true,
      });
    },
  );

  it("leaves a not-installed service untouched when bootstrap is null", async () => {
    const { state, harness } = await runLifecycle("not-installed", null, false);

    expect(state.postSwapAction).toBe("none");
    expect(harness.install).not.toHaveBeenCalled();
    expect(mocks.resolveServiceCliInvocationMock).not.toHaveBeenCalled();
  });

  it("installs a not-installed service when bootstrap options are provided", async () => {
    const { state, harness } = await runLifecycle(
      "not-installed",
      bootstrap,
      false,
    );

    expect(state.postSwapAction).toBe("install");
    expect(harness.install).toHaveBeenCalledWith({
      label,
      cli: { command: "/usr/local/bin/traycer", args: [] },
      enableLinger: true,
    });
    expect(mocks.resolveServiceCliInvocationMock).toHaveBeenCalledWith({
      environment: "production",
      override: null,
      allowSelfInvocation: true,
    });
  });

  it("reloads an existing host-update registration with linger off and self-invocation permitted", async () => {
    const { state, harness } = await runLifecycle("stopped", null, false);

    expect(state.postSwapAction).toBe("install");
    expect(state.postSwapError).toBeNull();
    expect(mocks.resolveServiceCliInvocationMock).toHaveBeenCalledWith({
      environment: "production",
      override: null,
      // Brew/manual installs have no CLI manifest; self-invocation is
      // the supported fallback so reinstall does not leave the host down.
      allowSelfInvocation: true,
    });
    expect(harness.install).toHaveBeenCalledWith({
      label,
      cli: { command: "/usr/local/bin/traycer", args: [] },
      enableLinger: false,
    });
    // Still re-registers (reload definition), never plain start/restart.
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.restart).not.toHaveBeenCalled();
  });

  it("host update re-registers with self-invocation CLI when no manifest is available", async () => {
    // Brew/manual: resolveServiceCliInvocation falls back to the running
    // process (process.execPath + entry argv). Lifecycle must still reload
    // the definition via install — not leave the service stopped-with-success.
    const selfInvocationCli = {
      command: process.execPath,
      args: ["/path/to/traycer-cli/entry.js"],
    };
    mocks.resolveServiceCliInvocationMock.mockResolvedValue(selfInvocationCli);

    const { state, harness } = await runLifecycle("running", null, false);

    expect(state.priorState).toBe("running");
    expect(state.postSwapAction).toBe("install");
    expect(state.postSwapError).toBeNull();
    expect(mocks.resolveServiceCliInvocationMock).toHaveBeenCalledWith({
      environment: "production",
      override: null,
      allowSelfInvocation: true,
    });
    expect(harness.install).toHaveBeenCalledTimes(1);
    expect(harness.install).toHaveBeenCalledWith({
      label,
      cli: selfInvocationCli,
      enableLinger: false,
    });
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.restart).not.toHaveBeenCalled();
  });

  it("leaves an externally-managed (SMAppService-owned) REGISTRATION untouched while cooperatively cycling the host on macOS", async () => {
    // Desktop owns this label. Any manifest rewrite / bootstrap from the
    // CLI would either corrupt the BTM registration or run into
    // installService's SMAppService refusal - that half is unchanged. What
    // changed: on macOS the host PROCESS is now stopped through its own
    // lifecycle RPCs before the swap (an honest install, instead of
    // printing "stopping service" and swapping under the live host) and
    // kickstarted back on the new bytes after - via `relaunchAfterRestart`
    // (kickstart -k semantics), since the pre-swap stop RESOLVED and proved
    // the host child gone.
    const { state, harness } = await runLifecycle(
      "externally-managed",
      bootstrap,
      false,
    );

    expect(state.priorState).toBe("externally-managed");
    expect(state.postSwapError).toBeNull();
    expect(harness.install).not.toHaveBeenCalled();
    expect(harness.restart).not.toHaveBeenCalled();
    expect(mocks.resolveServiceCliInvocationMock).not.toHaveBeenCalled();
    if (process.platform === "darwin") {
      expect(harness.stop).toHaveBeenCalledTimes(1);
      // Not asserting `harness.start` counts here - `relaunchAfterRestart`'s
      // mock internally calls `start()` too, so a count on `start` conflates
      // the two routes. `relaunchAfterRestart` is the one that matters.
      expect(harness.relaunchAfterRestart).toHaveBeenCalledTimes(1);
      expect(harness.relaunchAfterRestart).toHaveBeenCalledWith(label, {
        forcedRecycle: true,
      });
      expect(state.postSwapAction).toBe("start");
    } else {
      expect(state.postSwapAction).toBe("none");
      expect(harness.start).not.toHaveBeenCalled();
      if (process.platform !== "win32") {
        // win32 always stops in beforeSwap (stray-process cleanup before
        // the dir swap); Linux has no Desktop-managed arm at all.
        expect(harness.stop).not.toHaveBeenCalled();
      }
    }
  });

  it.runIf(process.platform === "darwin")(
    "force-stops the Desktop-managed host when force is set",
    async () => {
      // `--force` threads into the pre-swap `controller.stop` on the
      // externally-managed path exactly like every other stop route: the
      // caller's stated consent to kill in-flight work, not an implicit
      // side effect of installing.
      const { harness } = await runLifecycle(
        "externally-managed",
        bootstrap,
        true,
      );

      expect(harness.stop).toHaveBeenCalledWith(label, { force: true });
    },
  );

  it("force-stops a running CLI-owned host when force is set", async () => {
    // Not darwin-gated in source: the running/win32 branch of beforeSwap
    // forwards `options.force` on every platform.
    const { harness } = await runLifecycle("running", bootstrap, true);

    expect(harness.stop).toHaveBeenCalledWith(label, { force: true });
  });

  it.runIf(process.platform === "darwin")(
    "aborts the swap when the Desktop-managed host denies the shutdown claim (busy)",
    async () => {
      // Never swap the install dir out from under live work: a busy denial
      // from the cooperative stop is a user-visible refusal, not a
      // degradation to swap-anyway.
      const harness = makeController("externally-managed");
      harness.stop.mockRejectedValue(
        new CliError({
          code: CLI_ERROR_CODES.HOST_BUSY,
          message:
            "host stop: the running host has work in progress and denied the shutdown claim; retry once the work completes, or re-run with --force to stop it anyway (running terminal sessions and in-flight agent work will be killed).",
          details: null,
          exitCode: 1,
        }),
      );
      mocks.createServiceControllerMock.mockReturnValue(harness.controller);
      const handle = createServiceInstallLifecycle({
        environment: "production",
        bootstrap,
        force: false,
      });

      await expect(handle.lifecycle.beforeSwap()).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_BUSY,
      });
      expect(handle.state.stoppedBeforeSwap).toBe(false);
    },
  );

  it.runIf(process.platform === "darwin")(
    "kickstarts the agent post-swap with a plain start (not relaunchAfterRestart) when the cooperative stop is unreachable",
    async () => {
      // A host too broken to answer its own RPC must not make the install
      // refuse - that is the lockout shape this epic exists to end. The
      // swap proceeds exactly as it did before the cooperative era and the
      // degradation is logged. The machine is no longer left alone
      // post-swap, though: a plain kickstart starts a genuinely stopped job
      // and is a silent no-op at the launchd layer on one that is still
      // live (never `relaunchAfterRestart`'s forced recycle - the stop
      // never proved the host child dead, so recycling could kill live
      // work).
      const harness = makeController("externally-managed");
      harness.stop.mockRejectedValue(
        new CliError({
          code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
          message: "host stop: RPC endpoint unreachable (dial timeout)",
          details: null,
          exitCode: 1,
        }),
      );
      mocks.createServiceControllerMock.mockReturnValue(harness.controller);
      const handle = createServiceInstallLifecycle({
        environment: "production",
        bootstrap,
        force: false,
      });

      await expect(handle.lifecycle.beforeSwap()).resolves.toBeUndefined();
      expect(handle.state.stoppedBeforeSwap).toBe(false);
      expect(mocks.cliLoggerWarnMock).toHaveBeenCalled();

      await expect(handle.lifecycle.afterSwap()).resolves.toBeUndefined();
      expect(handle.state.postSwapAction).toBe("start");
      expect(harness.start).toHaveBeenCalledTimes(1);
      expect(harness.relaunchAfterRestart).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform === "darwin")(
    "starts the agent post-swap even when the host was already stopped (stop --force then install must not leave the machine hostless)",
    async () => {
      // Field scenario: a prior `host stop --force` purges pid.json, so the
      // pre-swap stop here throws no-endpoint rather than resolving - the
      // same degraded path as an unreachable RPC, just a different cause.
      // The OLD (gated) post-swap logic skipped the kickstart whenever
      // `stoppedBeforeSwap` was false, which left a completed install, a
      // printed "starting service", and no host running until someone ran
      // `host restart` by hand. The unconditional post-swap kickstart
      // exists to close exactly this gap.
      const harness = makeController("externally-managed");
      harness.stop.mockRejectedValue(
        new CliError({
          code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
          message:
            "host stop: no host endpoint is published for 'ai.traycer.host' (pid metadata is missing or unreadable); the host may already be stopped",
          details: null,
          exitCode: 1,
        }),
      );
      mocks.createServiceControllerMock.mockReturnValue(harness.controller);
      const handle = createServiceInstallLifecycle({
        environment: "production",
        bootstrap,
        force: false,
      });

      await expect(handle.lifecycle.beforeSwap()).resolves.toBeUndefined();
      expect(handle.state.stoppedBeforeSwap).toBe(false);

      await expect(handle.lifecycle.afterSwap()).resolves.toBeUndefined();
      expect(handle.state.postSwapAction).toBe("start");
      expect(harness.start).toHaveBeenCalledTimes(1);
      expect(harness.relaunchAfterRestart).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform === "darwin")(
    "records postSwapError without throwing when the post-swap kickstart itself fails",
    async () => {
      // The completed install must not be undone by a failing kickstart -
      // the failure is recorded for the command to surface (and Doctor to
      // flag), never thrown.
      const harness = makeController("externally-managed");
      harness.relaunchAfterRestart.mockRejectedValue(
        new Error("launchctl kickstart -k failed: no such process"),
      );
      mocks.createServiceControllerMock.mockReturnValue(harness.controller);
      const handle = createServiceInstallLifecycle({
        environment: "production",
        bootstrap,
        force: false,
      });
      await handle.lifecycle.beforeSwap();

      await expect(handle.lifecycle.afterSwap()).resolves.toBeUndefined();
      expect(handle.state.postSwapAction).toBe("none");
      expect(handle.state.postSwapError).not.toBeNull();
    },
  );

  // The repair half: leaving Desktop's registration alone must NOT mean
  // leaving a competing CLI-label registration alone. This is the one
  // routine flow that reaches a machine poisoned during the v1.1.7 window,
  // and a refusal alone can never clean up what already exists.
  it("retires a competing CLI registration on the externally-managed path", async () => {
    const { harness } = await runLifecycle(
      "externally-managed",
      bootstrap,
      false,
    );

    expect(harness.retireCompetingRegistration).toHaveBeenCalledWith(label);
  });

  // The repair is contractually non-throwing, but the lifecycle must not rely
  // on that politely holding: an install whose bytes are already swapped in
  // must never be failed by its own opportunistic cleanup.
  it("does not fail the install when the competing-registration repair throws", async () => {
    const harness = makeController("externally-managed");
    harness.retireCompetingRegistration.mockRejectedValue(
      new Error("launchctl exploded"),
    );
    mocks.createServiceControllerMock.mockReturnValue(harness.controller);
    const handle = createServiceInstallLifecycle({
      environment: "production",
      bootstrap,
      force: false,
    });
    await handle.lifecycle.beforeSwap();

    await expect(handle.lifecycle.afterSwap()).resolves.toBeUndefined();
    // The repair throw never aborts the lifecycle; on macOS the
    // cooperative stop still gets its kickstart-back (via
    // `relaunchAfterRestart`, since the stop resolved), elsewhere the
    // service is left alone.
    expect(handle.state.postSwapAction).toBe(
      process.platform === "darwin" ? "start" : "none",
    );
    if (process.platform === "darwin") {
      expect(harness.relaunchAfterRestart).toHaveBeenCalledTimes(1);
    }
    // Caught, but never silent. Every failure the repair anticipates is
    // logged at its own seam, so the only way into that catch is an
    // unforeseen throw - exactly the case that escaped the logging.
    expect(mocks.cliLoggerWarnMock).toHaveBeenCalled();
  });

  // Every other prior state either registers the CLI label itself or
  // deliberately leaves the service alone; there is no Desktop-owned agent
  // to defer to, so a competing registration cannot exist to repair.
  it.each(["running", "stopped", "not-installed"] as const)(
    "does not attempt a competing-registration repair from prior state %s",
    async (priorState) => {
      const { harness } = await runLifecycle(priorState, bootstrap, false);

      expect(harness.retireCompetingRegistration).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "host update preserves the registered plist's CLI invocation instead of repointing to freshly resolved binaries",
    async () => {
      // Brew/manual cohort: a stale staged ~/.traycer/cli binary would win
      // normal resolution, silently repointing the plist away from the brew
      // binary the registration actually invokes.
      const registered = { command: "/opt/homebrew/bin/traycer", args: [] };
      mocks.readRegisteredCliInvocationMock.mockResolvedValue(registered);
      mocks.resolveServiceCliInvocationMock.mockResolvedValue({
        command: "/Users/example/.traycer/cli/bin/traycer",
        args: [],
      });

      const { state, harness } = await runLifecycle("running", null, false);

      expect(state.postSwapAction).toBe("install");
      expect(state.postSwapError).toBeNull();
      expect(harness.install).toHaveBeenCalledWith({
        label,
        cli: registered,
        enableLinger: false,
      });
      // Preservation bypasses resolution entirely - nothing to repoint to.
      expect(mocks.resolveServiceCliInvocationMock).not.toHaveBeenCalled();
    },
  );

  it("manifest-based existing-registration reload still uses install, not kickstart", async () => {
    // Explicit bootstrap (host install / orchestrator) with a staged CLI
    // path: existing registration must rewrite+reload via install, never
    // plain start/restart of a cached definition.
    const manifestCli = {
      command: "/Users/example/.traycer/cli/bin/traycer",
      args: [] as string[],
    };
    mocks.resolveServiceCliInvocationMock.mockResolvedValue(manifestCli);

    const { state, harness } = await runLifecycle("running", bootstrap, false);

    expect(state.postSwapAction).toBe("install");
    expect(state.postSwapError).toBeNull();
    expect(mocks.resolveServiceCliInvocationMock).toHaveBeenCalledWith({
      environment: "production",
      override: null,
      allowSelfInvocation: true,
    });
    expect(harness.install).toHaveBeenCalledWith({
      label,
      cli: manifestCli,
      enableLinger: true,
    });
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.restart).not.toHaveBeenCalled();
  });
});

describe("swap-lock recovery wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.serviceLabelForMock.mockReturnValue(label);
    mocks.killLingeringSlotProcessesMock.mockResolvedValue(undefined);
    mocks.describeSlotLockHoldersMock.mockResolvedValue([]);
  });

  function withPlatform(platform: string, run: () => void): void {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    if (original === undefined) {
      throw new Error("process.platform descriptor missing");
    }
    Object.defineProperty(process, "platform", {
      value: platform,
      configurable: true,
    });
    try {
      run();
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  }

  it("wires Windows recovery to the platform kill and detail scan on both lifecycle factories", async () => {
    let recoveries: (SwapLockRecovery | null)[] = [];
    withPlatform("win32", () => {
      const harness = makeController("stopped");
      mocks.createServiceControllerMock.mockReturnValue(harness.controller);
      const serviceHandle = createServiceInstallLifecycle({
        environment: "production",
        bootstrap: null,
        force: false,
      });
      const bytesOnly = createBytesOnlyInstallLifecycle(
        harness.controller,
        label,
      );
      recoveries = [
        serviceHandle.lifecycle.swapLockRecovery,
        bytesOnly.swapLockRecovery,
      ];
    });

    for (const recovery of recoveries) {
      // A null here is exactly the quiet regression this test exists to
      // catch: the installer would silently run without re-kill or
      // holder diagnostics on the only platform that needs them.
      expect(recovery).not.toBeNull();
      if (recovery === null) throw new Error("unreachable");
      await recovery.killLingeringProcesses();
      const holders = [
        { pid: 7, name: "orphan.exe", executablePath: "C:\\orphan.exe" },
      ];
      mocks.describeSlotLockHoldersMock.mockResolvedValueOnce(holders);
      await expect(recovery.describeLockHolders()).resolves.toEqual(holders);
    }
    expect(mocks.killLingeringSlotProcessesMock).toHaveBeenCalledTimes(2);
    expect(mocks.killLingeringSlotProcessesMock).toHaveBeenCalledWith(
      label,
      null,
    );
    expect(mocks.describeSlotLockHoldersMock).toHaveBeenCalledWith(label, null);
  });

  it("carries no swap-lock recovery off Windows", () => {
    withPlatform("darwin", () => {
      const harness = makeController("stopped");
      mocks.createServiceControllerMock.mockReturnValue(harness.controller);
      const serviceHandle = createServiceInstallLifecycle({
        environment: "production",
        bootstrap: null,
        force: false,
      });
      const bytesOnly = createBytesOnlyInstallLifecycle(
        harness.controller,
        label,
      );
      expect(serviceHandle.lifecycle.swapLockRecovery).toBeNull();
      expect(bytesOnly.swapLockRecovery).toBeNull();
    });
  });
});
