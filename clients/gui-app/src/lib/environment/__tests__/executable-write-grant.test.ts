import { describe, expect, it, vi } from "vitest";
import type { ExecutableWriteGrantFetchResult } from "@traycer-clients/shared/host-client/executable-write-grant";
import {
  resolveExecutableWriteGrant,
  withExecutableWriteGrant,
  type ExecutableWriteGrantMinter,
} from "@/lib/environment/executable-write-grant";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";

const HOST_ID = "host-a";
const REUSE_MARGIN_MS = 60_000;

interface FakeMinter extends ExecutableWriteGrantMinter {
  readonly mintedFor: string[];
}

/** Answers the queued results in order, then the last one forever. */
function fakeMinter(
  ...results: readonly ExecutableWriteGrantFetchResult[]
): FakeMinter {
  const mintedFor: string[] = [];
  return {
    mintedFor,
    mintExecutableWriteGrant: (hostId) => {
      const result =
        results[Math.min(mintedFor.length, results.length - 1)] ??
        ({ kind: "not-bound" } as const);
      mintedFor.push(hostId);
      return Promise.resolve(result);
    },
    getCredentialGeneration: () => 0,
  };
}

function okGrant(
  grant: string,
  expiresInSeconds: number,
): ExecutableWriteGrantFetchResult {
  return { kind: "ok", grant, expiresInSeconds };
}

function boundHost(hostId: string) {
  return buildEnvironmentClient({
    hostId,
    handlers: {
      "environment.status": () =>
        environmentStatusFixture({ principal: { kind: "personal" } }),
    },
  });
}

describe("resolveExecutableWriteGrant", () => {
  it("answers null for a client with no active host, without asking the host or minting", async () => {
    const statusCalls = vi.fn();
    const { spine } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () => {
          statusCalls();
          return environmentStatusFixture({});
        },
      },
    });
    const minter = fakeMinter(okGrant("g1", 600));
    await expect(
      resolveExecutableWriteGrant(minter, spine, () => 0),
    ).resolves.toBeNull();
    expect(statusCalls).not.toHaveBeenCalled();
    expect(minter.mintedFor).toEqual([]);
  });

  it("answers null and mints nothing when environment.status fails (a host without environments)", async () => {
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () => {
          throw new Error("unsupported on this host");
        },
      },
    });
    const minter = fakeMinter(okGrant("g1", 600));
    await expect(
      resolveExecutableWriteGrant(minter, client, () => 0),
    ).resolves.toBeNull();
    expect(minter.mintedFor).toEqual([]);
  });

  it("answers null and mints nothing when the host has no principal yet", async () => {
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({ principal: null }),
      },
    });
    const minter = fakeMinter(okGrant("g1", 600));
    await expect(
      resolveExecutableWriteGrant(minter, client, () => 0),
    ).resolves.toBeNull();
    expect(minter.mintedFor).toEqual([]);
  });

  it("mints for the active host and answers the grant", async () => {
    const { client } = boundHost(HOST_ID);
    const minter = fakeMinter(okGrant("g1", 600));
    await expect(
      resolveExecutableWriteGrant(minter, client, () => 0),
    ).resolves.toBe("g1");
    expect(minter.mintedFor).toEqual([HOST_ID]);
  });

  it("reuses the grant inside the window: a second call mints nothing", async () => {
    const { client } = boundHost(HOST_ID);
    const minter = fakeMinter(okGrant("g1", 600), okGrant("g2", 600));
    let now = 1_000;
    const clock = () => now;
    await expect(
      resolveExecutableWriteGrant(minter, client, clock),
    ).resolves.toBe("g1");
    now += 60_000;
    await expect(
      resolveExecutableWriteGrant(minter, client, clock),
    ).resolves.toBe("g1");
    expect(minter.mintedFor).toEqual([HOST_ID]);
  });

  it("re-mints once expiresIn minus the reuse margin has passed, and not a millisecond before", async () => {
    const { client } = boundHost(HOST_ID);
    const minter = fakeMinter(okGrant("g1", 600), okGrant("g2", 600));
    const start = 1_000;
    const reuseUntil = start + 600 * 1_000 - REUSE_MARGIN_MS;
    let now = start;
    const clock = () => now;
    await resolveExecutableWriteGrant(minter, client, clock);
    now = reuseUntil - 1;
    await expect(
      resolveExecutableWriteGrant(minter, client, clock),
    ).resolves.toBe("g1");
    expect(minter.mintedFor).toHaveLength(1);
    now = reuseUntil;
    await expect(
      resolveExecutableWriteGrant(minter, client, clock),
    ).resolves.toBe("g2");
    expect(minter.mintedFor).toHaveLength(2);
  });

  it("never reuses a grant whose lifetime is no longer than the margin", async () => {
    const { client } = boundHost(HOST_ID);
    const minter = fakeMinter(okGrant("g1", 30), okGrant("g2", 30));
    const clock = () => 5_000;
    await expect(
      resolveExecutableWriteGrant(minter, client, clock),
    ).resolves.toBe("g1");
    await expect(
      resolveExecutableWriteGrant(minter, client, clock),
    ).resolves.toBe("g2");
    expect(minter.mintedFor).toHaveLength(2);
  });

  it.each([
    ["unauthorized", { kind: "unauthorized" } as const],
    ["not-bound", { kind: "not-bound" } as const],
    ["network-error", { kind: "network-error", detail: "boom" } as const],
  ])(
    "answers null for a %s mint, and caches nothing",
    async (_kind, failed) => {
      const { client } = boundHost(HOST_ID);
      const minter = fakeMinter(failed, okGrant("g1", 600));
      await expect(
        resolveExecutableWriteGrant(minter, client, () => 0),
      ).resolves.toBeNull();
      await expect(
        resolveExecutableWriteGrant(minter, client, () => 0),
      ).resolves.toBe("g1");
      expect(minter.mintedFor).toHaveLength(2);
    },
  );

  it("a grant whose mint resolves after the credential changed is neither sent nor kept", async () => {
    const { client } = boundHost(HOST_ID);
    let generation = 0;
    let rotateDuringMint = true;
    const mintedFor: string[] = [];
    const minter: ExecutableWriteGrantMinter = {
      mintExecutableWriteGrant: (hostId) => {
        mintedFor.push(hostId);
        if (rotateDuringMint) generation += 1;
        return Promise.resolve({
          kind: "ok",
          grant: `grant-${mintedFor.length}`,
          expiresInSeconds: 600,
        });
      },
      getCredentialGeneration: () => generation,
    };
    await expect(
      resolveExecutableWriteGrant(minter, client, () => 0),
    ).resolves.toBeNull();
    rotateDuringMint = false;
    await expect(
      resolveExecutableWriteGrant(minter, client, () => 0),
    ).resolves.toBe("grant-2");
    expect(mintedFor).toEqual([HOST_ID, HOST_ID]);
  });

  it("keeps one cache entry per host", async () => {
    const hostA = boundHost("host-a");
    const hostB = boundHost("host-b");
    const minter = fakeMinter(okGrant("ga", 600), okGrant("gb", 600));
    await expect(
      resolveExecutableWriteGrant(minter, hostA.client, () => 0),
    ).resolves.toBe("ga");
    await expect(
      resolveExecutableWriteGrant(minter, hostB.client, () => 0),
    ).resolves.toBe("gb");
    await expect(
      resolveExecutableWriteGrant(minter, hostA.client, () => 0),
    ).resolves.toBe("ga");
    expect(minter.mintedFor).toEqual(["host-a", "host-b"]);
  });

  it("keeps one cache per minter: a new session never sends the last one's grant", async () => {
    const { client } = boundHost(HOST_ID);
    const first = fakeMinter(okGrant("from-first-session", 600));
    const second = fakeMinter(okGrant("from-second-session", 600));
    await resolveExecutableWriteGrant(first, client, () => 0);
    await expect(
      resolveExecutableWriteGrant(second, client, () => 0),
    ).resolves.toBe("from-second-session");
    expect(second.mintedFor).toEqual([HOST_ID]);
  });
});

describe("withExecutableWriteGrant", () => {
  const request = { key: "API_URL", executableWriteGrant: null };

  it("returns the very same request, untouched, without a minter (signed out)", async () => {
    const { client } = boundHost(HOST_ID);
    await expect(withExecutableWriteGrant(null, client, request)).resolves.toBe(
      request,
    );
  });

  it("fills executableWriteGrant with the minted grant and keeps every other field", async () => {
    const { client } = boundHost(HOST_ID);
    const minter = fakeMinter(okGrant("g1", 600));
    const completed = await withExecutableWriteGrant(minter, client, request);
    expect(completed).toEqual({ key: "API_URL", executableWriteGrant: "g1" });
    // The caller's request is not mutated.
    expect(request.executableWriteGrant).toBeNull();
  });

  it("leaves the grant null when none can be minted, so the write still goes", async () => {
    const { client } = boundHost(HOST_ID);
    const minter = fakeMinter({ kind: "network-error", detail: "down" });
    await expect(
      withExecutableWriteGrant(minter, client, request),
    ).resolves.toEqual({ key: "API_URL", executableWriteGrant: null });
  });
});
