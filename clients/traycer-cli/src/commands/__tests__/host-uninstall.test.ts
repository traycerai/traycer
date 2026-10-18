import { describe, expect, it } from "vitest";
import { noopLogger } from "../../logger";
import { CLI_ERROR_CODES, cliError } from "../../runner/errors";
import {
  serviceLabelFor,
  type ServiceStatus,
  type StopServiceOptions,
} from "../../service";
import type { PublishedProcessIdentityVerdict } from "../../store/process-identity";
import type { UninstallHostOptions } from "../../installer";
import {
  runHostUninstall,
  stopServiceBeforeRuntimePurge,
  type HostUninstallActuators,
  type RunHostUninstallDeps,
} from "../host-uninstall";

const NOT_INSTALLED_STATUS: ServiceStatus = {
  state: "not-installed",
  version: null,
  listenUrl: null,
  pid: null,
};

function commandDeps(args: {
  readonly stop: () => Promise<void>;
  readonly receivedOptions: UninstallHostOptions[];
  readonly status: () => Promise<ServiceStatus>;
  // Defaults to a published host that is positively dead, so the existing
  // cases read as a confirmed teardown; the cases that care override it.
  // "unpublished" models a host that never wrote pid.json at all.
  readonly liveness: PublishedProcessIdentityVerdict | "unpublished" | null;
  // Does a host publish pid metadata AFTER the teardown? Null models the
  // ordinary case (the teardown removed it); true models the supervisor's
  // relaunch loop having produced a successor in the probe window.
  readonly successorAfterTeardown: boolean | null;
  readonly publishedPid: number | null;
}): RunHostUninstallDeps {
  const liveness = args.liveness ?? "dead";
  let reads = 0;
  return {
    readPublishedHost: async () => {
      reads += 1;
      const gone = reads > 1 && args.successorAfterTeardown !== true;
      return liveness === "unpublished" || gone
        ? null
        : { pid: args.publishedPid ?? 4242, startIdentity: "start-identity" };
    },
    probeProcessExited: async () => {
      if (liveness === "unpublished") throw new Error("unreachable");
      return liveness;
    },
    createServiceController: () => ({
      uninstall: async () => undefined,
      stop: args.stop,
      status: args.status,
    }),
    uninstallHost: async (options) => {
      args.receivedOptions.push(options);
      return {
        removedRecord: null,
        removedInstallDir: true,
        removedStagedDir: true,
        purgedRuntime: options.purgeChannelRuntime,
      };
    },
  };
}

const COMMAND_CONTEXT = {
  environment: "dev" as const,
  logger: noopLogger,
  progress: () => undefined,
};

function testActuators(deps: RunHostUninstallDeps): HostUninstallActuators {
  return {
    uninstall: (controller, options) => controller.uninstall(options),
    stop: (controller, label, options) => controller.stop(label, options),
    verifyMutationCapability: async (): Promise<void> => undefined,
    discardAttemptRecord: null,
  };
}

/** The actuators of `testActuators`, plus a record of what `stop` was asked. */
function stopRecordingActuators(
  deps: RunHostUninstallDeps,
  stopOptions: StopServiceOptions[],
): HostUninstallActuators {
  const actuators = testActuators(deps);
  return {
    ...actuators,
    stop: (controller, label, options) => {
      stopOptions.push(options);
      return actuators.stop(controller, label, options);
    },
  };
}

describe("stopServiceBeforeRuntimePurge", () => {
  it("allows runtime purge after stop confirms the host exited", async () => {
    const label = serviceLabelFor("dev");

    await expect(
      stopServiceBeforeRuntimePurge(
        {
          environment: "dev",
          label,
          logger: noopLogger,
        },
        async () => undefined,
      ),
    ).resolves.toBe(true);
  });

  it("preserves runtime when stop cannot confirm the host exited", async () => {
    const label = serviceLabelFor("production");

    await expect(
      stopServiceBeforeRuntimePurge(
        {
          environment: "production",
          label,
          logger: noopLogger,
        },
        async () => {
          throw new Error("host still running");
        },
      ),
    ).resolves.toBe(false);
  });
});

describe("runHostUninstall", () => {
  // The runtime purge is withheld UNCONDITIONALLY, even on the cleanest
  // possible teardown. Proving the captured child is dead does not prove
  // nothing is writing: `host start`'s supervisor outlives its child, writes
  // terminal and crash markers into host.log, and on Windows is not even
  // signalled by `schtasks /End`. Every readback available here is too weak to
  // close that gap, so the purge waits on a backend completion contract.
  it("never purges runtime, even when stop resolved and the child is positively dead", async () => {
    const receivedOptions: UninstallHostOptions[] = [];

    const deps = commandDeps({
      stop: async () => undefined,
      receivedOptions,
      status: async () => NOT_INSTALLED_STATUS,
      liveness: "dead",
      successorAfterTeardown: null,
      publishedPid: null,
    });
    const result = await runHostUninstall(
      { all: true, force: false },
      COMMAND_CONTEXT,
      deps,
      testActuators(deps),
    );

    expect(receivedOptions).toEqual([
      expect.objectContaining({
        environment: "dev",
        purgeChannelRuntime: false,
        verifyMutationCapability: expect.any(Function),
      }),
    ]);
    expect(result.data).toMatchObject({ purgedRuntime: false });
  });

  // NO platform can verify deregistration today - macOS's `launchctl print`
  // probe tolerates non-zero too, and an unloaded SMAppService record is
  // invisible to it. So the legacy `serviceUninstalled` keeps REQUEST
  // semantics (Desktop projects it to `deregisteredService`, and narrowing it
  // to a fact nothing establishes would have made that permanently false),
  // while the observed truth lives in `serviceRegistrationRetained` beside it
  // and the human copy is keyed on THAT.
  it("publishes the deregistration request alongside the observed readback", async () => {
    const deps = commandDeps({
      stop: async () => undefined,
      receivedOptions: [],
      status: async () => NOT_INSTALLED_STATUS,
      liveness: null,
      successorAfterTeardown: null,
      publishedPid: null,
    });
    const result = await runHostUninstall(
      { all: true, force: false },
      COMMAND_CONTEXT,
      deps,
      testActuators(deps),
    );

    // `not-installed` earns NULL, not false: Windows maps every
    // `schtasks /Query` failure to it, Linux re-reads the manifest this
    // command just deleted, and macOS's probe tolerates non-zero while an
    // unloaded SMAppService record is invisible to it. Unknown keeps the
    // request answer on the legacy field, which Desktop projects.
    expect(result.data).toMatchObject({
      deregisterRequested: true,
      serviceUninstalled: true,
      serviceRegistrationRetained: null,
    });
  });

  // A POSITIVE readback is a real observation, and it must veto the legacy
  // field - Desktop projects that to `deregisteredService`, whose contract is
  // "actually accomplished".
  it("vetoes the legacy deregistration field when the readback still finds it registered", async () => {
    const deps = commandDeps({
      stop: async () => undefined,
      receivedOptions: [],
      status: async () => ({
        state: "stopped",
        version: "1.2.3",
        listenUrl: null,
        pid: null,
      }),
      liveness: null,
      successorAfterTeardown: null,
      publishedPid: null,
    });
    const result = await runHostUninstall(
      { all: true, force: false },
      COMMAND_CONTEXT,
      deps,
      testActuators(deps),
    );

    expect(result.data).toMatchObject({
      deregisterRequested: true,
      serviceUninstalled: false,
      serviceRegistrationRetained: true,
    });
  });

  // Nothing was ever published, so there is no process to ask about. That is
  // NOT death - a host that started moments ago and has not written pid.json
  // looks identical - so liveness stays unknown.
  it("reports liveness as unknown when nothing was ever published", async () => {
    const deps = commandDeps({
      stop: async () => undefined,
      receivedOptions: [],
      status: async () => NOT_INSTALLED_STATUS,
      liveness: "unpublished",
      successorAfterTeardown: null,
      publishedPid: null,
    });
    const result = await runHostUninstall(
      { all: true, force: false },
      COMMAND_CONTEXT,
      deps,
      testActuators(deps),
    );

    expect(result.data).toMatchObject({
      hostStillRunning: null,
      purgedRuntime: false,
    });
  });

  it("keeps the install and the runtime after a failed stop, without --force", async () => {
    const receivedOptions: UninstallHostOptions[] = [];
    const stopOptions: StopServiceOptions[] = [];

    const deps = commandDeps({
      stop: async () => {
        throw new Error("host still running");
      },
      receivedOptions,
      status: async () => NOT_INSTALLED_STATUS,
      liveness: null,
      successorAfterTeardown: null,
      publishedPid: null,
    });

    await expect(
      runHostUninstall(
        { all: true, force: false },
        COMMAND_CONTEXT,
        deps,
        stopRecordingActuators(deps, stopOptions),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UNINSTALL_HOST_RUNNING,
      exitCode: 1,
    });
    expect(stopOptions).toEqual([{ force: false }]);
    expect(receivedOptions).toEqual([]);
  });

  it("with --force, forwards runtime preservation after a failed stop and still removes the install", async () => {
    const receivedOptions: UninstallHostOptions[] = [];
    const stopOptions: StopServiceOptions[] = [];

    const deps = commandDeps({
      stop: async () => {
        throw new Error("host still running");
      },
      receivedOptions,
      status: async () => NOT_INSTALLED_STATUS,
      liveness: null,
      successorAfterTeardown: null,
      publishedPid: null,
    });
    const result = await runHostUninstall(
      { all: true, force: true },
      COMMAND_CONTEXT,
      deps,
      stopRecordingActuators(deps, stopOptions),
    );

    expect(stopOptions).toEqual([{ force: true }]);
    expect(receivedOptions).toEqual([
      expect.objectContaining({
        environment: "dev",
        purgeChannelRuntime: false,
        verifyMutationCapability: expect.any(Function),
      }),
    ]);
    expect(result.data).toMatchObject({ purgedRuntime: false });
  });

  // traycer#1563 D3b: a wedged host ignores SIGTERM, so `--all`'s stop
  // throws and the probe still finds the process serving. Deleting the
  // install directory then leaves an orphan running from unlinked bytes,
  // still holding the lifecycle lock that makes every reinstall defer to it.
  // The install directory and record stay until the stop takes effect.
  it("keeps the install when the --all stop did not take effect and the host is still serving", async () => {
    const receivedOptions: UninstallHostOptions[] = [];

    const deps = commandDeps({
      stop: async () => {
        throw new Error(
          "host (pid=4242) did not exit within 32000ms of SIGTERM; stop did not take effect.",
        );
      },
      receivedOptions,
      status: async () => NOT_INSTALLED_STATUS,
      liveness: "current",
      successorAfterTeardown: true,
      publishedPid: null,
    });

    await expect(
      runHostUninstall(
        { all: true, force: false },
        COMMAND_CONTEXT,
        deps,
        testActuators(deps),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UNINSTALL_HOST_RUNNING,
      exitCode: 1,
      message: expect.stringContaining("--force"),
      details: {
        environment: "dev",
        hostStillRunning: true,
        removedInstallDir: false,
        serviceDeregistrationRequested: true,
      },
    });
    expect(receivedOptions).toEqual([]);
  });

  it("with --force, removes the install even though the host is still serving", async () => {
    const receivedOptions: UninstallHostOptions[] = [];
    const stopOptions: StopServiceOptions[] = [];

    const deps = commandDeps({
      stop: async () => {
        throw new Error(
          "host (pid=4242) did not exit within 32000ms of SIGTERM; stop did not take effect.",
        );
      },
      receivedOptions,
      status: async () => NOT_INSTALLED_STATUS,
      liveness: "current",
      successorAfterTeardown: true,
      publishedPid: null,
    });
    const result = await runHostUninstall(
      { all: true, force: true },
      COMMAND_CONTEXT,
      deps,
      stopRecordingActuators(deps, stopOptions),
    );

    expect(stopOptions).toEqual([{ force: true }]);
    expect(receivedOptions).toEqual([
      expect.objectContaining({
        environment: "dev",
        purgeChannelRuntime: false,
      }),
    ]);
    expect(result.data).toMatchObject({
      removedInstallDir: true,
      purgedRuntime: false,
      hostStillRunning: true,
    });
  });

  // The load-bearing one. A resolved `stop()` is NOT evidence the host
  // exited: on Linux and Windows every teardown call passes
  // `tolerateNonZeroExit: true`, and the runner resolves on any error under
  // that flag - including its own timeout. So `systemctl --user disable
  // --now` can time out, the unit file is removed, `stop()` returns, and a
  // host is still serving. Inferring shutdown from that resolution purged the
  // pid metadata and rotated the log of a LIVE host - exactly what the purge
  // gate exists to prevent - and reported it as stopped.
  it("keeps the install and reports the host live when a resolved --all stop left one serving, without --force", async () => {
    const receivedOptions: UninstallHostOptions[] = [];

    const deps = commandDeps({
      stop: async () => undefined, // resolves, proving nothing
      receivedOptions,
      status: async () => NOT_INSTALLED_STATUS,
      liveness: "current",
      successorAfterTeardown: null,
      publishedPid: null,
    });

    await expect(
      runHostUninstall(
        { all: true, force: false },
        COMMAND_CONTEXT,
        deps,
        testActuators(deps),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UNINSTALL_HOST_RUNNING,
      exitCode: 1,
      details: {
        environment: "dev",
        hostStillRunning: true,
        removedInstallDir: false,
        serviceDeregistrationRequested: true,
      },
    });
    expect(receivedOptions).toEqual([]);
  });

  it("with --force, withholds the purge and reports the host live when a resolved --all stop left one serving", async () => {
    const receivedOptions: UninstallHostOptions[] = [];
    const stopOptions: StopServiceOptions[] = [];

    const deps = commandDeps({
      stop: async () => undefined, // resolves, proving nothing
      receivedOptions,
      status: async () => NOT_INSTALLED_STATUS,
      liveness: "current",
      successorAfterTeardown: null,
      publishedPid: null,
    });
    const result = await runHostUninstall(
      { all: true, force: true },
      COMMAND_CONTEXT,
      deps,
      stopRecordingActuators(deps, stopOptions),
    );

    expect(stopOptions).toEqual([{ force: true }]);
    expect(receivedOptions).toEqual([
      expect.objectContaining({
        environment: "dev",
        purgeChannelRuntime: false,
        verifyMutationCapability: expect.any(Function),
      }),
    ]);
    expect(result.data).toMatchObject({
      purgedRuntime: false,
      hostStillRunning: true,
    });
    expect(result.human ?? "").toContain("STILL RUNNING");
    expect(result.human ?? "").toContain("traycer host stop --force");
  });

  // The host answered the stop and declined because it has work in progress:
  // it is busy, not wedged. Its own refusal is the one worth surfacing, since
  // it names the work and the `--force` that would end it.
  it("rethrows the host's own E_HOST_BUSY when the --all stop was declined for work in progress, keeping the install", async () => {
    const receivedOptions: UninstallHostOptions[] = [];
    const busy = cliError({
      code: CLI_ERROR_CODES.HOST_BUSY,
      message: "host stop: the host has work in progress",
      details: null,
      exitCode: 1,
    });
    const deps = commandDeps({
      stop: async () => {
        throw busy;
      },
      receivedOptions,
      status: async () => NOT_INSTALLED_STATUS,
      liveness: "current",
      successorAfterTeardown: null,
      publishedPid: null,
    });

    await expect(
      runHostUninstall(
        { all: true, force: false },
        COMMAND_CONTEXT,
        deps,
        testActuators(deps),
      ),
    ).rejects.toMatchObject({ code: "E_HOST_BUSY" });
    expect(receivedOptions).toEqual([]);
  });

  // The boundary read of the published record is the last evidence about
  // whether a host is still there. A record that cannot be read (a live host
  // mid-write, a permission error) is no evidence of absence; "nothing
  // published" is.
  it("keeps the install when the published record cannot be read at the boundary, without --force", async () => {
    const receivedOptions: UninstallHostOptions[] = [];
    const base = commandDeps({
      stop: async () => undefined,
      receivedOptions,
      status: async () => NOT_INSTALLED_STATUS,
      liveness: "dead",
      successorAfterTeardown: null,
      publishedPid: null,
    });
    let reads = 0;
    const deps: RunHostUninstallDeps = {
      ...base,
      readPublishedHost: async (environment) => {
        reads += 1;
        if (reads > 1) throw new Error("EACCES: permission denied");
        return base.readPublishedHost(environment);
      },
    };

    await expect(
      runHostUninstall(
        { all: true, force: false },
        COMMAND_CONTEXT,
        deps,
        testActuators(deps),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UNINSTALL_HOST_RUNNING,
      exitCode: 1,
      details: {
        environment: "dev",
        removedInstallDir: false,
        serviceDeregistrationRequested: true,
      },
    });
    expect(receivedOptions).toEqual([]);
  });

  it("with --force, removes the install although the published record cannot be read at the boundary", async () => {
    const receivedOptions: UninstallHostOptions[] = [];
    const base = commandDeps({
      stop: async () => undefined,
      receivedOptions,
      status: async () => NOT_INSTALLED_STATUS,
      liveness: "dead",
      successorAfterTeardown: null,
      publishedPid: null,
    });
    let reads = 0;
    const deps: RunHostUninstallDeps = {
      ...base,
      readPublishedHost: async (environment) => {
        reads += 1;
        if (reads > 1) throw new Error("EACCES: permission denied");
        return base.readPublishedHost(environment);
      },
    };
    const result = await runHostUninstall(
      { all: true, force: true },
      COMMAND_CONTEXT,
      deps,
      testActuators(deps),
    );

    expect(receivedOptions).toEqual([
      expect.objectContaining({
        environment: "dev",
        purgeChannelRuntime: false,
      }),
    ]);
    expect(result.data).toMatchObject({ removedInstallDir: true });
  });

  it("removes the install when the boundary read answers that nothing is published and the stop resolved", async () => {
    const receivedOptions: UninstallHostOptions[] = [];
    const deps = commandDeps({
      stop: async () => undefined,
      receivedOptions,
      status: async () => NOT_INSTALLED_STATUS,
      liveness: "unpublished",
      successorAfterTeardown: null,
      publishedPid: null,
    });
    const result = await runHostUninstall(
      { all: true, force: false },
      COMMAND_CONTEXT,
      deps,
      testActuators(deps),
    );

    expect(receivedOptions).toEqual([
      expect.objectContaining({
        environment: "dev",
        purgeChannelRuntime: false,
      }),
    ]);
    expect(result.data).toMatchObject({ removedInstallDir: true });
  });

  it("reads --all's registration back from the platform rather than assuming the deregister landed", async () => {
    const deps = commandDeps({
      stop: async () => undefined,
      receivedOptions: [],
      // `uninstall()` resolved, but the unit is still registered - the
      // Linux/Windows teardown calls tolerate their own failures.
      status: async () => ({
        state: "stopped",
        version: "1.2.3",
        listenUrl: null,
        pid: null,
      }),
      liveness: null,
      successorAfterTeardown: null,
      publishedPid: null,
    });
    const result = await runHostUninstall(
      { all: true, force: false },
      COMMAND_CONTEXT,
      deps,
      testActuators(deps),
    );

    // `serviceUninstalled` keeps REQUEST semantics (no platform can verify
    // absence), but a POSITIVE readback vetoes it - Desktop projects the field
    // straight to `deregisteredService`, so leaving it true against a readback
    // saying "still registered" published the exact false outcome the readback
    // had just caught.
    expect(result.data).toMatchObject({
      deregisterRequested: true,
      serviceUninstalled: false,
      serviceRegistrationRetained: true,
      retainedServiceState: "stopped",
      purgedRuntime: false,
    });
    expect(result.human ?? "").toContain("still registered");
    expect(result.human ?? "").not.toContain("deregistered OS service");
  });

  // An unanswerable readback is NOT agreement. `!== true` counted it as
  // agreement and printed "deregistered OS service" for a deregistration
  // nothing had confirmed.
  it("says the deregistration could not be verified when the readback throws", async () => {
    const deps = commandDeps({
      stop: async () => undefined,
      receivedOptions: [],
      status: async () => {
        throw new Error("launchctl unavailable");
      },
      liveness: null,
      successorAfterTeardown: null,
      publishedPid: null,
    });
    const result = await runHostUninstall(
      { all: true, force: false },
      COMMAND_CONTEXT,
      deps,
      testActuators(deps),
    );

    expect(result.data).toMatchObject({
      deregisterRequested: true,
      serviceRegistrationRetained: null,
      purgedRuntime: false,
    });
    expect(result.human ?? "").toContain("no platform can verify removal");
    expect(result.human ?? "").not.toContain("deregistered OS service");
  });

  // The captured child dying does not mean the supervisor did not already
  // start its replacement while these probes were running - which on Windows
  // can take seconds. A successor publishing at the purge boundary is
  // positive evidence something is writing the files the purge destroys.
  it("withholds the purge when a successor published while the probes ran", async () => {
    const receivedOptions: UninstallHostOptions[] = [];

    const deps = commandDeps({
      stop: async () => undefined,
      receivedOptions,
      status: async () => NOT_INSTALLED_STATUS,
      liveness: "dead", // the CAPTURED child is positively gone
      successorAfterTeardown: true,
      publishedPid: null,
    });
    const result = await runHostUninstall(
      { all: true, force: false },
      COMMAND_CONTEXT,
      deps,
      testActuators(deps),
    );

    expect(receivedOptions).toEqual([
      expect.objectContaining({
        environment: "dev",
        purgeChannelRuntime: false,
        verifyMutationCapability: expect.any(Function),
      }),
    ]);
    expect(result.data).toMatchObject({ purgedRuntime: false });
  });

  // `readHostPidMetadata` accepts any JSON number; the identity helper answers
  // `dead` for anything non-integral or <= 0. A record carrying `pid: -5` was
  // therefore read as proof the host exited, and licensed the purge.
  it("treats an unusable published pid as unknown, never as death", async () => {
    const deps = commandDeps({
      stop: async () => undefined,
      receivedOptions: [],
      status: async () => NOT_INSTALLED_STATUS,
      liveness: "dead",
      successorAfterTeardown: null,
      publishedPid: -5,
    });
    const result = await runHostUninstall(
      { all: true, force: true },
      COMMAND_CONTEXT,
      deps,
      testActuators(deps),
    );

    expect(result.data).toMatchObject({
      purgedRuntime: false,
      hostStillRunning: null,
    });
  });

  it("reports liveness as null on --all when the probe itself cannot answer", async () => {
    const deps = commandDeps({
      stop: async () => undefined,
      receivedOptions: [],
      status: async () => NOT_INSTALLED_STATUS,
      liveness: "indeterminate",
      successorAfterTeardown: null,
      publishedPid: null,
    });
    const result = await runHostUninstall(
      { all: true, force: true },
      COMMAND_CONTEXT,
      deps,
      testActuators(deps),
    );

    expect(result.data).toMatchObject({
      hostStillRunning: null,
      purgedRuntime: false,
    });
  });

  it("reports the retained registration and running host a default uninstall leaves behind", async () => {
    const deps = commandDeps({
      stop: async () => undefined,
      receivedOptions: [],
      status: async () => ({
        state: "running",
        version: "1.2.3",
        listenUrl: "ws://127.0.0.1:1234",
        pid: 4242,
      }),
      liveness: "current",
      successorAfterTeardown: null,
      publishedPid: null,
    });
    const result = await runHostUninstall(
      { all: false, force: false },
      COMMAND_CONTEXT,
      deps,
      testActuators(deps),
    );

    expect(result.data).toMatchObject({
      serviceUninstalled: false,
      serviceRegistrationRetained: true,
      retainedServiceState: "running",
      hostStillRunning: true,
    });
    expect(result.human).toContain("still registered");
    expect(result.human).toContain("traycer host uninstall --all");
  });

  it("stays quiet about the service when nothing is registered", async () => {
    const deps = commandDeps({
      stop: async () => undefined,
      receivedOptions: [],
      status: async () => NOT_INSTALLED_STATUS,
      liveness: null,
      successorAfterTeardown: null,
      publishedPid: null,
    });
    const result = await runHostUninstall(
      { all: false, force: false },
      COMMAND_CONTEXT,
      deps,
      testActuators(deps),
    );

    expect(result.data).toMatchObject({
      serviceRegistrationRetained: null,
      retainedServiceState: "not-installed",
      hostStillRunning: false,
    });
    expect(result.human).not.toContain("still registered");
  });

  // The probe exists to DESCRIBE the end state. A platform that cannot answer
  // it (no launchctl, a systemd user manager that was never started) must not
  // turn a completed removal into a failed command.
  it("completes the uninstall when the service probe throws", async () => {
    const receivedOptions: UninstallHostOptions[] = [];

    const deps = commandDeps({
      stop: async () => undefined,
      receivedOptions,
      status: async () => {
        throw new Error("launchctl unavailable");
      },
      liveness: null,
      successorAfterTeardown: null,
      publishedPid: null,
    });
    const result = await runHostUninstall(
      { all: false, force: false },
      COMMAND_CONTEXT,
      deps,
      testActuators(deps),
    );

    expect(receivedOptions).toEqual([
      expect.objectContaining({
        environment: "dev",
        purgeChannelRuntime: false,
        verifyMutationCapability: expect.any(Function),
      }),
    ]);
    expect(result.exitCode).toBe(0);
    // NULL for registration: `false` would be a claim about something this
    // command never observed. Liveness is a SEPARATE instrument and answered
    // fine, so it keeps its observed value rather than being dragged to null.
    expect(result.data).toMatchObject({
      serviceRegistrationRetained: null,
      retainedServiceState: null,
      hostStillRunning: false,
    });
  });

  // Both halves are required for the purge. A stop that THREW means the host
  // was never asked/consented to die, so even a probe that finds nothing
  // serving does not license deleting its runtime - the process may simply
  // not be publishing yet.
  it("keeps the install when the stop threw, even with nothing serving, without --force", async () => {
    const receivedOptions: UninstallHostOptions[] = [];

    const deps = commandDeps({
      stop: async () => {
        throw new Error("host denied the shutdown claim");
      },
      receivedOptions,
      status: async () => NOT_INSTALLED_STATUS,
      liveness: null,
      successorAfterTeardown: null,
      publishedPid: null,
    });

    await expect(
      runHostUninstall(
        { all: true, force: false },
        COMMAND_CONTEXT,
        deps,
        testActuators(deps),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UNINSTALL_HOST_RUNNING,
      exitCode: 1,
      // Nothing was observed serving, so the host is not claimed to be live.
      details: {
        environment: "dev",
        hostStillRunning: null,
        removedInstallDir: false,
        serviceDeregistrationRequested: true,
      },
    });
    expect(receivedOptions).toEqual([]);
  });

  it("with --force, withholds the purge when the stop threw, even with nothing serving", async () => {
    const deps = commandDeps({
      stop: async () => {
        throw new Error("host denied the shutdown claim");
      },
      receivedOptions: [],
      status: async () => NOT_INSTALLED_STATUS,
      liveness: null,
      successorAfterTeardown: null,
      publishedPid: null,
    });
    const result = await runHostUninstall(
      { all: true, force: true },
      COMMAND_CONTEXT,
      deps,
      testActuators(deps),
    );

    expect(result.data).toMatchObject({
      deregisterRequested: true,
      purgedRuntime: false,
      // NULL after `--all`. `gone` there rests on a boundary metadata read
      // that returns null for four different reasons - a pre-publication
      // successor, Windows having deleted the metadata during its own
      // teardown, an EACCES, or malformed JSON - none of which is death.
      hostStillRunning: null,
      serviceRegistrationRetained: null,
    });
  });

  // The other half of the same rule: a CONFIRMED stop is what gates the
  // runtime purge, so it is also the only evidence that justifies `false`.
  it("reports liveness as unknown after --all unless a probe positively finds one", async () => {
    const deps = commandDeps({
      stop: async () => undefined,
      receivedOptions: [],
      status: async () => NOT_INSTALLED_STATUS,
      liveness: null,
      successorAfterTeardown: null,
      publishedPid: null,
    });
    const result = await runHostUninstall(
      { all: true, force: false },
      COMMAND_CONTEXT,
      deps,
      testActuators(deps),
    );

    expect(result.data).toMatchObject({
      deregisterRequested: true,
      purgedRuntime: false,
      hostStillRunning: null,
      serviceRegistrationRetained: null,
    });
  });
});

describe("runHostUninstall - a published process that is not proven gone (traycer#1563)", () => {
  interface PublishedRecord {
    readonly pid: number;
    readonly startIdentity: string | null;
  }
  interface Scenario {
    readonly name: string;
    // What each successive read of the published record answers; the last
    // answer repeats.
    readonly reads: ReadonlyArray<PublishedRecord | null>;
    // What the identity probe answers per pid.
    readonly probe: (pid: number) => Promise<PublishedProcessIdentityVerdict>;
  }

  function scenarioDeps(
    scenario: Scenario,
    receivedOptions: UninstallHostOptions[],
  ): RunHostUninstallDeps {
    const base = commandDeps({
      stop: async () => undefined,
      receivedOptions,
      status: async () => NOT_INSTALLED_STATUS,
      liveness: "dead",
      successorAfterTeardown: null,
      publishedPid: null,
    });
    let reads = 0;
    return {
      ...base,
      readPublishedHost: async () => {
        const index = Math.min(reads, scenario.reads.length - 1);
        reads += 1;
        return scenario.reads[index] ?? null;
      },
      probeProcessExited: (pid) => scenario.probe(pid),
    };
  }

  const KEEPS_THE_INSTALL: readonly Scenario[] = [
    {
      name: "a published successor whose identity probe is indeterminate",
      reads: [
        { pid: 4242, startIdentity: "first" },
        { pid: 5151, startIdentity: "second" },
      ],
      probe: async (pid) => (pid === 4242 ? "dead" : "indeterminate"),
    },
    {
      name: "a published successor whose identity probe throws",
      reads: [
        { pid: 4242, startIdentity: "first" },
        { pid: 5151, startIdentity: "second" },
      ],
      probe: async (pid) => {
        if (pid === 4242) return "dead";
        throw new Error("ps: operation not permitted");
      },
    },
    {
      name: "the captured host unknown, with nothing published at the boundary",
      reads: [{ pid: 4242, startIdentity: "first" }, null],
      probe: async () => "indeterminate",
    },
    {
      name: "the captured host's probe throwing, with nothing published at the boundary",
      reads: [{ pid: 4242, startIdentity: "first" }, null],
      probe: async () => {
        throw new Error("ps: operation not permitted");
      },
    },
    {
      name: "a legacy record with no start identity that cannot be told apart",
      reads: [{ pid: 4242, startIdentity: null }, null],
      probe: async () => "indeterminate",
    },
    // The entry capture A and the boundary successor B are different
    // processes: a dead B says nothing about A.
    {
      name: "a captured host still serving behind a dead successor",
      reads: [
        { pid: 111, startIdentity: "a" },
        { pid: 222, startIdentity: "b" },
      ],
      probe: async (pid) => (pid === 111 ? "current" : "dead"),
    },
    {
      name: "a captured host whose probe is indeterminate behind a dead successor",
      reads: [
        { pid: 111, startIdentity: "a" },
        { pid: 222, startIdentity: "b" },
      ],
      probe: async (pid) => (pid === 111 ? "indeterminate" : "dead"),
    },
    {
      name: "a captured host whose probe throws behind a dead successor",
      reads: [
        { pid: 111, startIdentity: "a" },
        { pid: 222, startIdentity: "b" },
      ],
      probe: async (pid) => {
        if (pid === 111) throw new Error("ps: operation not permitted");
        return "dead";
      },
    },
    {
      name: "an unusable published pid, which names no process",
      reads: [{ pid: -5, startIdentity: "first" }, null],
      probe: async () => "dead",
    },
  ];

  for (const scenario of KEEPS_THE_INSTALL) {
    it(`keeps the install with E_HOST_UNINSTALL_HOST_RUNNING for ${scenario.name}, without --force`, async () => {
      const receivedOptions: UninstallHostOptions[] = [];
      const deps = scenarioDeps(scenario, receivedOptions);

      await expect(
        runHostUninstall(
          { all: true, force: false },
          COMMAND_CONTEXT,
          deps,
          testActuators(deps),
        ),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_UNINSTALL_HOST_RUNNING,
        exitCode: 1,
        details: { removedInstallDir: false },
      });
      expect(receivedOptions).toEqual([]);
    });

    it(`with --force, removes the install for ${scenario.name}`, async () => {
      const receivedOptions: UninstallHostOptions[] = [];
      const deps = scenarioDeps(scenario, receivedOptions);

      const result = await runHostUninstall(
        { all: true, force: true },
        COMMAND_CONTEXT,
        deps,
        testActuators(deps),
      );

      expect(receivedOptions).toHaveLength(1);
      expect(result.data).toMatchObject({ removedInstallDir: true });
    });
  }

  const STILL_UNINSTALLS: readonly Scenario[] = [
    {
      name: "nothing published at entry or at the boundary",
      reads: [null, null],
      probe: async () => "indeterminate",
    },
    {
      name: "a published process proven gone",
      reads: [{ pid: 4242, startIdentity: "first" }, null],
      probe: async () => "dead",
    },
    {
      name: "a published pid that now belongs to another process",
      reads: [{ pid: 4242, startIdentity: "first" }, null],
      probe: async () => "mismatch",
    },
    {
      name: "a captured host and a different successor, both proven gone",
      reads: [
        { pid: 111, startIdentity: "a" },
        { pid: 222, startIdentity: "b" },
      ],
      probe: async () => "dead",
    },
    {
      name: "the same published process read again at the boundary, proven gone",
      reads: [
        { pid: 111, startIdentity: "a" },
        { pid: 111, startIdentity: "a" },
      ],
      probe: async () => "dead",
    },
    // A later probe of the SAME process (pid and start identity) is newer
    // evidence about it and replaces the earlier verdict.
    {
      name: "the same published process, first indeterminate and then proven gone at the boundary",
      reads: [
        { pid: 111, startIdentity: "a" },
        { pid: 111, startIdentity: "a" },
      ],
      probe: (() => {
        let calls = 0;
        return async (): Promise<PublishedProcessIdentityVerdict> => {
          calls += 1;
          return calls === 1 ? "indeterminate" : "dead";
        };
      })(),
    },
    {
      name: "a published successor proven gone",
      reads: [
        { pid: 4242, startIdentity: "first" },
        { pid: 5151, startIdentity: "second" },
      ],
      probe: async () => "dead",
    },
  ];

  for (const scenario of STILL_UNINSTALLS) {
    it(`still uninstalls without --force for ${scenario.name}`, async () => {
      const receivedOptions: UninstallHostOptions[] = [];
      const deps = scenarioDeps(scenario, receivedOptions);

      const result = await runHostUninstall(
        { all: true, force: false },
        COMMAND_CONTEXT,
        deps,
        testActuators(deps),
      );

      expect(receivedOptions).toHaveLength(1);
      expect(result.data).toMatchObject({ removedInstallDir: true });
    });
  }
});
