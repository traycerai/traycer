import { describe, expect, it } from "vitest";
import { noopLogger } from "../../logger";
import { hostPidMetadataPath } from "../../store/paths";
import { removeHostPidMetadataForPurge } from "../uninstall";

describe("removeHostPidMetadataForPurge", () => {
  it("continues when locked pid metadata cannot be removed", async () => {
    const receivedPaths: string[] = [];

    await expect(
      removeHostPidMetadataForPurge("dev", noopLogger, async (path) => {
        receivedPaths.push(path);
        throw Object.assign(new Error("file is locked"), { code: "EBUSY" });
      }),
    ).resolves.toBeUndefined();

    expect(receivedPaths).toEqual([hostPidMetadataPath("dev")]);
  });
});
