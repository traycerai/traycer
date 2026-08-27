import { describe, expect, it } from "vitest";
import { noopLogger } from "../../logger";
import { serviceLabelFor, type ServiceStatus } from "../../service";
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
}): RunHostUninstallDeps {
  return {
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
      }),
    );

    expect(receivedOptions).toEqual([
      { environment: "dev", purgeChannelRuntime: false },
    ]);
    expect(result.data).toMatchObject({ purgedRuntime: false });
  });

  it("does not probe the service on --all: the end state is unconditional", async () => {
    let statusCalls = 0;

    await runHostUninstall(
      { all: true },
      COMMAND_CONTEXT,
      commandDeps({
        stop: async () => undefined,
        receivedOptions: [],
        status: async () => {
          statusCalls += 1;
          return NOT_INSTALLED_STATUS;
        },
      }),
    );

    expect(statusCalls).toBe(0);
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
      }),
    );

    expect(receivedOptions).toEqual([
      { environment: "dev", purgeChannelRuntime: false },
    ]);
    expect(result.exitCode).toBe(0);
    // NULL, not false. `false` is a claim about a registration and a process
    // this command never observed and never touched - an automation consumer
    // reading it would conclude the machine is clean when nothing checked.
    expect(result.data).toMatchObject({
      serviceRegistrationRetained: null,
      retainedServiceState: null,
      hostStillRunning: null,
    });
  });

  // `--all`'s stop is cooperative and best-effort: a host that denies or
  // outlives the claim is left running while the bytes are removed anyway.
  // Saying nothing is how an operator walks away believing it is down.
  it("says the host may still be running when --all's cooperative stop is not confirmed", async () => {
    const result = await runHostUninstall(
      { all: true },
      COMMAND_CONTEXT,
      commandDeps({
        stop: async () => {
          throw new Error("host denied the shutdown claim");
        },
        receivedOptions: [],
        status: async () => NOT_INSTALLED_STATUS,
      }),
    );

    expect(result.data).toMatchObject({
      serviceUninstalled: true,
      purgedRuntime: false,
      // NULL, not false. `--all` runs no probe, and its stop is best-effort -
      // an unconfirmed stop leaves a host that may still be serving. `false`
      // here made the machine envelope contradict the human summary below,
      // which already says so, and an automation reading it would proceed as
      // though the host were down.
      hostStillRunning: null,
      serviceRegistrationRetained: false,
    });
    expect(result.human ?? "").toContain("did not confirm shutdown");
    expect(result.human ?? "").toContain("traycer host stop --force");
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
