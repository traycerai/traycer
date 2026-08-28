import { describe, expect, it } from "vitest";
import { noopLogger } from "../../logger";
import { serviceLabelFor, type ServiceStatus } from "../../service";
import type { PublishedProcessIdentityVerdict } from "../../store/process-identity";
import type { UninstallHostOptions } from "../../installer";
import {
  runHostUninstall,
  stopServiceBeforeRuntimePurge,
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

describe("stopServiceBeforeRuntimePurge", () => {
  it("allows runtime purge after stop confirms the host exited", async () => {
    const label = serviceLabelFor("dev");

    await expect(
      stopServiceBeforeRuntimePurge({
        controller: {
          stop: async (receivedLabel) => {
            expect(receivedLabel).toBe(label);
          },
        },
        environment: "dev",
        label,
        logger: noopLogger,
      }),
    ).resolves.toBe(true);
  });

  it("preserves runtime when stop cannot confirm the host exited", async () => {
    const label = serviceLabelFor("production");

    await expect(
      stopServiceBeforeRuntimePurge({
        controller: {
          stop: async () => {
            throw new Error("host still running");
          },
        },
        environment: "production",
        label,
        logger: noopLogger,
      }),
    ).resolves.toBe(false);
  });
});

describe("runHostUninstall", () => {
  it("forwards runtime purge permission after a confirmed stop", async () => {
    const receivedOptions: UninstallHostOptions[] = [];

    const result = await runHostUninstall(
      { all: true },
      COMMAND_CONTEXT,
      commandDeps({
        stop: async () => undefined,
        receivedOptions,
        status: async () => NOT_INSTALLED_STATUS,
        liveness: null,
        successorAfterTeardown: null,
        publishedPid: null,
      }),
    );

    expect(receivedOptions).toEqual([
      { environment: "dev", purgeChannelRuntime: true },
    ]);
    expect(result.data).toMatchObject({ purgedRuntime: true });
  });

  it("forwards runtime preservation after a failed stop", async () => {
    const receivedOptions: UninstallHostOptions[] = [];

    const result = await runHostUninstall(
      { all: true },
      COMMAND_CONTEXT,
      commandDeps({
        stop: async () => {
          throw new Error("host still running");
        },
        receivedOptions,
        status: async () => NOT_INSTALLED_STATUS,
        liveness: null,
        successorAfterTeardown: null,
        publishedPid: null,
      }),
    );

    expect(receivedOptions).toEqual([
      { environment: "dev", purgeChannelRuntime: false },
    ]);
    expect(result.data).toMatchObject({ purgedRuntime: false });
  });

  // The load-bearing one. A resolved `stop()` is NOT evidence the host
  // exited: on Linux and Windows every teardown call passes
  // `tolerateNonZeroExit: true`, and the runner resolves on any error under
  // that flag - including its own timeout. So `systemctl --user disable
  // --now` can time out, the unit file is removed, `stop()` returns, and a
  // host is still serving. Inferring shutdown from that resolution purged the
  // pid metadata and rotated the log of a LIVE host - exactly what the purge
  // gate exists to prevent - and reported it as stopped.
  it("withholds the purge and reports the host live when a resolved --all stop left one serving", async () => {
    const receivedOptions: UninstallHostOptions[] = [];

    const result = await runHostUninstall(
      { all: true },
      COMMAND_CONTEXT,
      commandDeps({
        stop: async () => undefined, // resolves, proving nothing
        receivedOptions,
        status: async () => NOT_INSTALLED_STATUS,
        liveness: "current",
        successorAfterTeardown: null,
        publishedPid: null,
      }),
    );

    expect(receivedOptions).toEqual([
      { environment: "dev", purgeChannelRuntime: false },
    ]);
    expect(result.data).toMatchObject({
      purgedRuntime: false,
      hostStillRunning: true,
    });
    expect(result.human ?? "").toContain("could not confirm the host stopped");
    expect(result.human ?? "").toContain("traycer host stop --force");
  });

  it("reads --all's registration back from the platform rather than assuming the deregister landed", async () => {
    const result = await runHostUninstall(
      { all: true },
      COMMAND_CONTEXT,
      commandDeps({
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
      }),
    );

    // `serviceUninstalled` is the VERIFIED fact, not the request. Desktop's
    // `parseUninstallResult` projects it straight to `deregisteredService`, so
    // leaving it true against a readback saying "still registered" published
    // the exact false outcome the readback had just caught.
    expect(result.data).toMatchObject({
      serviceUninstalled: false,
      deregisterRequested: true,
      serviceRegistrationRetained: true,
      retainedServiceState: "stopped",
      // A surviving registration is a restart source: `host start`
      // supervisors outlive their children and relaunch them, so the purge
      // that deletes pid metadata and rotates the log must not run.
      purgedRuntime: false,
    });
    expect(result.human ?? "").toContain("still registered");
    expect(result.human ?? "").not.toContain("deregistered OS service");
  });

  // An unanswerable readback is NOT agreement. `!== true` counted it as
  // agreement and printed "deregistered OS service" for a deregistration
  // nothing had confirmed.
  it("says the deregistration could not be verified when the readback throws", async () => {
    const result = await runHostUninstall(
      { all: true },
      COMMAND_CONTEXT,
      commandDeps({
        stop: async () => undefined,
        receivedOptions: [],
        status: async () => {
          throw new Error("launchctl unavailable");
        },
        liveness: null,
        successorAfterTeardown: null,
        publishedPid: null,
      }),
    );

    expect(result.data).toMatchObject({
      serviceUninstalled: false,
      deregisterRequested: true,
      serviceRegistrationRetained: null,
      purgedRuntime: false,
    });
    expect(result.human ?? "").toContain("could not verify");
    expect(result.human ?? "").not.toContain("deregistered OS service");
  });

  // The captured child dying does not mean the supervisor did not already
  // start its replacement while these probes were running - which on Windows
  // can take seconds. A successor publishing at the purge boundary is
  // positive evidence something is writing the files the purge destroys.
  it("withholds the purge when a successor published while the probes ran", async () => {
    const receivedOptions: UninstallHostOptions[] = [];

    const result = await runHostUninstall(
      { all: true },
      COMMAND_CONTEXT,
      commandDeps({
        stop: async () => undefined,
        receivedOptions,
        status: async () => NOT_INSTALLED_STATUS,
        liveness: "dead", // the CAPTURED child is positively gone
        successorAfterTeardown: true,
        publishedPid: null,
      }),
    );

    expect(receivedOptions).toEqual([
      { environment: "dev", purgeChannelRuntime: false },
    ]);
    expect(result.data).toMatchObject({ purgedRuntime: false });
  });

  // `readHostPidMetadata` accepts any JSON number; the identity helper answers
  // `dead` for anything non-integral or <= 0. A record carrying `pid: -5` was
  // therefore read as proof the host exited, and licensed the purge.
  it("treats an unusable published pid as unknown, never as death", async () => {
    const result = await runHostUninstall(
      { all: true },
      COMMAND_CONTEXT,
      commandDeps({
        stop: async () => undefined,
        receivedOptions: [],
        status: async () => NOT_INSTALLED_STATUS,
        liveness: "dead",
        successorAfterTeardown: null,
        publishedPid: -5,
      }),
    );

    expect(result.data).toMatchObject({
      purgedRuntime: false,
      hostStillRunning: null,
    });
  });

  it("reports liveness as null on --all when the probe itself cannot answer", async () => {
    const result = await runHostUninstall(
      { all: true },
      COMMAND_CONTEXT,
      commandDeps({
        stop: async () => undefined,
        receivedOptions: [],
        status: async () => NOT_INSTALLED_STATUS,
        liveness: "indeterminate",
        successorAfterTeardown: null,
        publishedPid: null,
      }),
    );

    expect(result.data).toMatchObject({
      hostStillRunning: null,
      purgedRuntime: false,
    });
  });

  it("reports the retained registration and running host a default uninstall leaves behind", async () => {
    const result = await runHostUninstall(
      { all: false },
      COMMAND_CONTEXT,
      commandDeps({
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
      }),
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
    const result = await runHostUninstall(
      { all: false },
      COMMAND_CONTEXT,
      commandDeps({
        stop: async () => undefined,
        receivedOptions: [],
        status: async () => NOT_INSTALLED_STATUS,
        liveness: null,
        successorAfterTeardown: null,
        publishedPid: null,
      }),
    );

    expect(result.data).toMatchObject({
      serviceRegistrationRetained: false,
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

    const result = await runHostUninstall(
      { all: false },
      COMMAND_CONTEXT,
      commandDeps({
        stop: async () => undefined,
        receivedOptions,
        status: async () => {
          throw new Error("launchctl unavailable");
        },
        liveness: null,
        successorAfterTeardown: null,
        publishedPid: null,
      }),
    );

    expect(receivedOptions).toEqual([
      { environment: "dev", purgeChannelRuntime: false },
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
  it("withholds the purge when the stop threw, even with nothing serving", async () => {
    const result = await runHostUninstall(
      { all: true },
      COMMAND_CONTEXT,
      commandDeps({
        stop: async () => {
          throw new Error("host denied the shutdown claim");
        },
        receivedOptions: [],
        status: async () => NOT_INSTALLED_STATUS,
        liveness: null,
        successorAfterTeardown: null,
        publishedPid: null,
      }),
    );

    expect(result.data).toMatchObject({
      serviceUninstalled: true,
      purgedRuntime: false,
      // The probe answered "nothing serving", so `false` is earned here. What
      // is NOT earned is the purge: the stop threw, so the host was never
      // asked to die and its runtime stays.
      hostStillRunning: false,
      serviceRegistrationRetained: false,
    });
  });

  // The other half of the same rule: a CONFIRMED stop is what gates the
  // runtime purge, so it is also the only evidence that justifies `false`.
  it("reports hostStillRunning: false on --all only once the stop is confirmed", async () => {
    const result = await runHostUninstall(
      { all: true },
      COMMAND_CONTEXT,
      commandDeps({
        stop: async () => undefined,
        receivedOptions: [],
        status: async () => NOT_INSTALLED_STATUS,
        liveness: null,
        successorAfterTeardown: null,
        publishedPid: null,
      }),
    );

    expect(result.data).toMatchObject({
      serviceUninstalled: true,
      purgedRuntime: true,
      hostStillRunning: false,
      serviceRegistrationRetained: false,
    });
  });
});
