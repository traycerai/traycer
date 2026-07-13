import { describe, expect, it } from "vitest";
import { noopLogger } from "../../logger";
import { serviceLabelFor } from "../../service";
import { stopServiceBeforeRuntimePurge } from "../host-uninstall";

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
