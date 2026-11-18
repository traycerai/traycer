import { describe, expect, it, vi, type Mock } from "vitest";
import {
  atServiceSpawnEdge,
  runWithLeaseAtServiceSpawnEdge,
  withdrawServiceSpawnEdge,
  type ServiceSpawnEdgeLease,
} from "../spawn-edge";
import { markRegistrationCommitted } from "../cli-invocation-record";

// R3 §C: `withdrawServiceSpawnEdge()` - inside
// `runWithLeaseAtServiceSpawnEdge`, the call launches nothing after all:
// cancel the published lease instead of waiting for a spawn. Outside any
// scope, a no-op.
//
// RED-FIRST against the pre-R3 snapshot: `withdrawServiceSpawnEdge` does not
// exist there, so importing it is `undefined` and calling it throws
// "withdrawServiceSpawnEdge is not a function".

function makeLease(): ServiceSpawnEdgeLease & {
  readonly waitForSpawnMock: Mock<() => Promise<void>>;
  readonly cancelMock: Mock<() => Promise<void>>;
} {
  const waitForSpawnMock = vi.fn(async () => undefined);
  const cancelMock = vi.fn(async () => undefined);
  return {
    waitForSpawn: waitForSpawnMock,
    cancel: cancelMock,
    waitForSpawnMock,
    cancelMock,
  };
}

describe("withdrawServiceSpawnEdge", () => {
  it("test 30: after a withdraw, waitForSpawn is NEVER called and the lease is cancelled once; the call resolves", async () => {
    const lease = makeLease();
    const publish = vi.fn(async () => lease);
    const start = async (): Promise<void> => {
      await atServiceSpawnEdge();
      withdrawServiceSpawnEdge();
    };

    await expect(
      runWithLeaseAtServiceSpawnEdge(publish, start),
    ).resolves.toBeUndefined();

    expect(lease.waitForSpawnMock).not.toHaveBeenCalled();
    expect(lease.cancelMock).toHaveBeenCalledTimes(1);
  });

  it("control: without the withdraw, waitForSpawn IS called once", async () => {
    const lease = makeLease();
    const publish = vi.fn(async () => lease);
    const start = async (): Promise<void> => {
      await atServiceSpawnEdge();
    };

    await runWithLeaseAtServiceSpawnEdge(publish, start);

    expect(lease.waitForSpawnMock).toHaveBeenCalledTimes(1);
  });

  it("control: a withdraw called outside any scope does nothing and does not throw", () => {
    expect(() => withdrawServiceSpawnEdge()).not.toThrow();
  });

  // R5 §48: a `start` that withdrew and THEN threw a registration-committed
  // error still has no child coming - the withdraw already said so. The
  // catch block's `didServiceRegistrationCommit` branch does not consult the
  // withdrawal flag, so it waits for a spawn anyway.
  it("48: a withdraw followed by a registration-committed throw does NOT enter waitForSpawn, and cancels once", async () => {
    const lease = makeLease();
    const publish = vi.fn(async () => lease);
    const start = async (): Promise<void> => {
      await atServiceSpawnEdge();
      withdrawServiceSpawnEdge();
      throw markRegistrationCommitted(new Error("post-registration failure"));
    };

    await expect(
      runWithLeaseAtServiceSpawnEdge(publish, start),
    ).rejects.toThrow("post-registration failure");

    expect(lease.waitForSpawnMock).not.toHaveBeenCalled();
    expect(lease.cancelMock).toHaveBeenCalledTimes(1);
  });
});
