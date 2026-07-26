import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  CompetingRegistrationRetirement,
  ServiceController,
  ServiceLabel,
} from "../index";
import {
  createServiceInstallLifecycle,
  type BootstrapServiceOptions,
  type ServiceInstallLifecycleState,
} from "../install-lifecycle";

const mocks = vi.hoisted(() => ({
  createServiceControllerMock: vi.fn(),
  serviceLabelForMock: vi.fn(),
  resolveServiceCliInvocationMock: vi.fn(),
  readRegisteredCliInvocationMock: vi.fn(),
  cliLoggerWarnMock: vi.fn(),
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
    retireCompetingRegistration,
  };
  return {
    controller,
    install,
    start,
    restart,
    stop,
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
): Promise<{
  readonly state: ServiceInstallLifecycleState;
  readonly harness: ControllerHarness;
}> {
  const harness = makeController(priorState);
  mocks.createServiceControllerMock.mockReturnValue(harness.controller);
  const handle = createServiceInstallLifecycle({
    environment: "production",
    bootstrap: options,
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
      const { state, harness } = await runLifecycle(priorState, bootstrap);

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
    const { state, harness } = await runLifecycle("not-installed", null);

    expect(state.postSwapAction).toBe("none");
    expect(harness.install).not.toHaveBeenCalled();
    expect(mocks.resolveServiceCliInvocationMock).not.toHaveBeenCalled();
  });

  it("installs a not-installed service when bootstrap options are provided", async () => {
    const { state, harness } = await runLifecycle("not-installed", bootstrap);

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
    const { state, harness } = await runLifecycle("stopped", null);

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

    const { state, harness } = await runLifecycle("running", null);

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

  it("leaves an externally-managed (SMAppService-owned) registration itself untouched, even with bootstrap options", async () => {
    // Desktop owns this label. Any stop / manifest rewrite / bootstrap from
    // the CLI would either corrupt the BTM registration or run into
    // installService's SMAppService refusal - the swapped bytes go live at
    // Desktop's next register cycle instead.
    const { state, harness } = await runLifecycle(
      "externally-managed",
      bootstrap,
    );

    expect(state.priorState).toBe("externally-managed");
    expect(state.postSwapAction).toBe("none");
    expect(state.postSwapError).toBeNull();
    expect(harness.install).not.toHaveBeenCalled();
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.restart).not.toHaveBeenCalled();
    expect(mocks.resolveServiceCliInvocationMock).not.toHaveBeenCalled();
    if (process.platform !== "win32") {
      // win32 always stops in beforeSwap (stray-process cleanup before the
      // dir swap); everywhere else an externally-managed host must not be
      // killed by a CLI update.
      expect(harness.stop).not.toHaveBeenCalled();
    }
  });

  // The repair half: leaving Desktop's registration alone must NOT mean
  // leaving a competing CLI-label registration alone. This is the one
  // routine flow that reaches a machine poisoned during the v1.1.7 window,
  // and a refusal alone can never clean up what already exists.
  it("retires a competing CLI registration on the externally-managed path", async () => {
    const { harness } = await runLifecycle("externally-managed", bootstrap);

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
    });
    await handle.lifecycle.beforeSwap();

    await expect(handle.lifecycle.afterSwap()).resolves.toBeUndefined();
    expect(handle.state.postSwapAction).toBe("none");
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
      const { harness } = await runLifecycle(priorState, bootstrap);

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

      const { state, harness } = await runLifecycle("running", null);

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

    const { state, harness } = await runLifecycle("running", bootstrap);

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
