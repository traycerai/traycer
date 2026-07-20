import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ServiceController, ServiceLabel } from "../index";
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
}));

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
}

function makeController(initialState: HarnessServiceState): ControllerHarness {
  const currentState = initialState;
  const install = vi.fn(async () => undefined);
  const start = vi.fn(async () => undefined);
  const restart = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
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
  };
  return {
    controller,
    install,
    start,
    restart,
    stop,
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

  it("leaves an externally-managed (SMAppService-owned) registration completely untouched, even with bootstrap options", async () => {
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
