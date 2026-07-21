import { describe, expect, it } from "vitest";
import { noopLogger } from "../../logger";
import { serviceLabelFor } from "../../service";
import type { UninstallHostOptions } from "../../installer";
import {
  runHostUninstall,
  stopServiceBeforeRuntimePurge,
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
      }),
    );

    expect(receivedOptions).toEqual([
      { environment: "dev", purgeChannelRuntime: false },
    ]);
    expect(result.data).toMatchObject({ purgedRuntime: false });
  });
});
