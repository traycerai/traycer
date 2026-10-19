import { afterEach, describe, expect, it } from "vitest";
import {
  __setAsyncProcessLivenessReaderForTest,
  __setAsyncProcessStartIdentityReaderForTest,
} from "../process-identity";
import {
  restartTargetStillCurrent,
  type RestartTargetHost,
  type RestartTargetPublished,
} from "../restart-target";

const TARGET: RestartTargetHost = {
  pid: 4242,
  startIdentity: "linux:boot-a 4242",
};
const REPLACEMENT_PID = 5151;
const REPLACEMENT_IDENTITY = "linux:boot-a 5151";

afterEach(() => {
  __setAsyncProcessLivenessReaderForTest(null);
  __setAsyncProcessStartIdentityReaderForTest(null);
});

async function stillCurrent(
  published: RestartTargetPublished,
  observed: {
    readonly liveness: "alive" | "dead" | "indeterminate";
    readonly observedIdentity: string | null;
  },
): Promise<boolean> {
  __setAsyncProcessLivenessReaderForTest(async () => observed.liveness);
  __setAsyncProcessStartIdentityReaderForTest(
    async () => observed.observedIdentity,
  );
  return restartTargetStillCurrent(TARGET, published);
}

describe("restartTargetStillCurrent", () => {
  const liveReplacement = {
    liveness: "alive",
    observedIdentity: REPLACEMENT_IDENTITY,
  } as const;

  it("lets the restart act when no host is published", async () => {
    await expect(
      stillCurrent({ kind: "absent" }, liveReplacement),
    ).resolves.toBe(true);
  });

  it("refuses when the published record cannot be read", async () => {
    await expect(
      stillCurrent({ kind: "unreadable" }, liveReplacement),
    ).resolves.toBe(false);
  });

  it("lets the restart act when the published host is the confirmed one", async () => {
    await expect(
      stillCurrent(
        {
          kind: "published",
          pid: TARGET.pid,
          startIdentity: TARGET.startIdentity,
        },
        { liveness: "alive", observedIdentity: TARGET.startIdentity },
      ),
    ).resolves.toBe(true);
  });

  it("refuses a different live host published in place of the confirmed one", async () => {
    await expect(
      stillCurrent(
        {
          kind: "published",
          pid: REPLACEMENT_PID,
          startIdentity: REPLACEMENT_IDENTITY,
        },
        liveReplacement,
      ),
    ).resolves.toBe(false);
  });

  it("refuses a live host published under the confirmed pid with another start identity", async () => {
    await expect(
      stillCurrent(
        {
          kind: "published",
          pid: TARGET.pid,
          startIdentity: REPLACEMENT_IDENTITY,
        },
        liveReplacement,
      ),
    ).resolves.toBe(false);
  });

  it("lets the restart act when the published host is gone", async () => {
    await expect(
      stillCurrent(
        {
          kind: "published",
          pid: REPLACEMENT_PID,
          startIdentity: REPLACEMENT_IDENTITY,
        },
        { liveness: "dead", observedIdentity: null },
      ),
    ).resolves.toBe(true);
  });

  it("lets the restart act when the published pid now belongs to another process", async () => {
    await expect(
      stillCurrent(
        {
          kind: "published",
          pid: REPLACEMENT_PID,
          startIdentity: REPLACEMENT_IDENTITY,
        },
        { liveness: "alive", observedIdentity: "linux:boot-a 7777" },
      ),
    ).resolves.toBe(true);
  });

  it("refuses a live host published without a start identity", async () => {
    await expect(
      stillCurrent(
        { kind: "published", pid: REPLACEMENT_PID, startIdentity: null },
        { liveness: "alive", observedIdentity: REPLACEMENT_IDENTITY },
      ),
    ).resolves.toBe(false);
  });

  it("refuses a published host whose liveness cannot be determined", async () => {
    await expect(
      stillCurrent(
        {
          kind: "published",
          pid: REPLACEMENT_PID,
          startIdentity: REPLACEMENT_IDENTITY,
        },
        { liveness: "indeterminate", observedIdentity: null },
      ),
    ).resolves.toBe(false);
  });
});
