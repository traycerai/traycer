import { describe, expect, it } from "vitest";
import { noopLogger } from "../../logger";
import { serviceLabelFor } from "../../service";
import type { UninstallHostOptions } from "../../installer";
import {
  runHostUninstall,
  stopServiceBeforeRuntimePurge,
  type HostUninstallActuators,
  type RunHostUninstallDeps,
} from "../host-uninstall";

function commandDeps(args: {
  readonly stop: () => Promise<void>;
  readonly receivedOptions: UninstallHostOptions[];
}): RunHostUninstallDeps {
  return {
    createServiceController: () => ({
      uninstall: async () => undefined,
      stop: args.stop,
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
  it("forwards runtime purge permission after a confirmed stop", async () => {
    const receivedOptions: UninstallHostOptions[] = [];

    const deps = commandDeps({
      stop: async () => undefined,
      receivedOptions,
    });
    const result = await runHostUninstall(
      { all: true },
      COMMAND_CONTEXT,
      deps,
      testActuators(deps),
    );

    expect(receivedOptions).toEqual([
      expect.objectContaining({
        environment: "dev",
        purgeChannelRuntime: true,
        verifyMutationCapability: expect.any(Function),
      }),
    ]);
    expect(result.data).toMatchObject({ purgedRuntime: true });
  });

  it("forwards runtime preservation after a failed stop", async () => {
    const receivedOptions: UninstallHostOptions[] = [];

    const deps = commandDeps({
      stop: async () => {
        throw new Error("host still running");
      },
      receivedOptions,
    });
    const result = await runHostUninstall(
      { all: true },
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
});
