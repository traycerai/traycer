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
    expect(result.data).toMatchObject({
      serviceRegistrationRetained: false,
      retainedServiceState: null,
    });
  });
});
