/**
 * The build without environments (`unreleased-features.ts`) authorizes
 * nothing: no host forwards its writes, so no grant is asked for or minted.
 */
vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

import { describe, expect, it, vi } from "vitest";
import {
  resolveExecutableWriteGrant,
  type ExecutableWriteGrantMinter,
} from "@/lib/environment/executable-write-grant";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";

describe("resolveExecutableWriteGrant without environments", () => {
  it("answers null for a bound host, sends no environment.status and never mints", async () => {
    const statusCalls = vi.fn();
    const { client } = buildEnvironmentClient({
      hostId: "host-a",
      handlers: {
        "environment.status": () => {
          statusCalls();
          return environmentStatusFixture({ principal: { kind: "personal" } });
        },
      },
    });
    const mintedFor: string[] = [];
    const minter: ExecutableWriteGrantMinter = {
      mintExecutableWriteGrant: (hostId) => {
        mintedFor.push(hostId);
        return Promise.resolve({
          kind: "ok",
          grant: "g1",
          expiresInSeconds: 600,
        });
      },
      getCredentialGeneration: () => 0,
    };

    await expect(
      resolveExecutableWriteGrant(minter, client, () => 0),
    ).resolves.toBeNull();
    expect(statusCalls).not.toHaveBeenCalled();
    expect(mintedFor).toEqual([]);
  });
});
