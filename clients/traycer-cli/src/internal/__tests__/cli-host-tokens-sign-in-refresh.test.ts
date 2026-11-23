import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MutableBearerLease } from "../../../../shared/auth/bearer-source";
import type { HostTokenTable } from "../../../../shared/auth/host-token-store";
import type { HostTokenMintOutcome } from "../../../../shared/auth/host-token-source";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import { createCliHostTokens } from "../cli-host-tokens";

// The real token path (`createCliHostTokens`: its single-flight mints, its
// recovery and its sign-in judge) against a fake authn, whose first mint is held
// and answered by the test, and a fake credentials refresh that counts its
// rotations and rotates the lease as the credentials store does.

const USER_ID = "user-1";
const SIGN_IN_A = "sign-in-a";

const harness = vi.hoisted(() => ({
  /** Every mint request authn was sent, the first held until the test answers it. */
  mints: [] as Array<{
    readonly hostId: string;
    readonly signIn: string;
    readonly signal: AbortSignal;
    readonly answer: (outcome: HostTokenMintOutcome) => void;
  }>,
  table: new Map() as HostTokenTable,
}));

vi.mock("@traycer-clients/shared/auth/host-token-file", () => ({
  createHostTokenFilePersistence: () => ({
    load: async () => harness.table,
    update: async (change: (table: HostTokenTable) => HostTokenTable) => {
      harness.table = change(harness.table);
      return harness.table;
    },
  }),
}));

vi.mock(
  "@traycer-clients/shared/host-transport/remote/grant-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/grant-client")
      >();
    return {
      ...actual,
      mintHostTokenViaHttp: (
        _authnBaseUrl: string,
        hostId: string,
        signIn: string,
        signal: AbortSignal,
      ): Promise<HostTokenMintOutcome> =>
        new Promise<HostTokenMintOutcome>((resolve) => {
          const held = harness.mints.length === 0;
          harness.mints.push({ hostId, signIn, signal, answer: resolve });
          if (!held)
            resolve({
              kind: "ok",
              token: {
                token: `host-token-${harness.mints.length}`,
                expiresAtMs: Date.now() + 3_600_000,
              },
            });
        }),
    };
  },
);

let hostCount = 0;
let hostId = "";

beforeEach(() => {
  harness.mints.splice(0);
  harness.table = new Map();
  hostCount += 1;
  // A host process's flights and memory are kept per host id.
  hostId = `55555555-5555-4555-8555-${String(hostCount).padStart(12, "0")}`;
  processReleasedHosts.forgetAll();
});

afterEach(() => {
  processReleasedHosts.forgetAll();
});

/** The credentials refresh: each call is one rotation, and rotates the lease to the next sign-in. */
function countingRefresh(lease: MutableBearerLease): {
  readonly refresh: () => Promise<"rotated">;
  readonly rotations: () => number;
  readonly rotatedTo: (rotation: number) => string;
} {
  let rotations = 0;
  const rotatedTo = (rotation: number): string => `sign-in-rotated-${rotation}`;
  return {
    refresh: async () => {
      rotations += 1;
      lease.rotate(rotatedTo(rotations));
      return "rotated";
    },
    rotations: () => rotations,
    rotatedTo,
  };
}

describe("a mint refusal's recovery refreshes only the sign-in it was refused for", () => {
  it("ends holding the sign-in a foreground recovery saved, with exactly one rotation, when the background mint's refusal of the earlier sign-in arrives late", async () => {
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const credentials = countingRefresh(lease);
    const tokens = createCliHostTokens({
      lease,
      refresh: credentials.refresh,
      signal: null,
    });
    await tokens.whenLoaded();
    // A background mint is sent on sign-in A.
    const background = tokens.hostBearerFor(hostId, true);
    await vi.waitFor(() => expect(harness.mints).toHaveLength(1));
    expect(harness.mints[0]?.signIn).toBe(SIGN_IN_A);

    // A foreground recovery then refreshes and saves B.
    await expect(tokens.refreshSignIn()).resolves.toBe("rotated");
    expect(lease.getBearerToken()).toBe(credentials.rotatedTo(1));

    // The background mint's refusal of A arrives late.
    harness.mints[0]?.answer({ kind: "sign-in-rejected" });
    await background;

    expect(credentials.rotations()).toBe(1);
    expect(lease.getBearerToken()).toBe(credentials.rotatedTo(1));
    for (const mint of harness.mints)
      expect([SIGN_IN_A, credentials.rotatedTo(1)]).toContain(mint.signIn);
  });
});
