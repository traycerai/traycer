import { describe, expect, it, vi, type Mock } from "vitest";
import {
  atServiceInstallEdge,
  atServiceSpawnEdge,
  atServiceSpawnEdgeReporting,
  isUnreportedSpawnEdgeRefusal,
  refusedSpawnEdgeError,
  runWithLeaseAtServiceSpawnEdge,
  type RefusedSpawnEdgeReport,
  type ServiceSpawnEdgeLease,
} from "../spawn-edge";
import { markRegistrationCommitted } from "../cli-invocation-record";
import {
  isServiceMutationAuthorityError,
  verifyServiceMutationAuthority,
  withServiceMutationAuthority,
} from "../mutation-authority";
import { CLI_ERROR_CODES } from "../../runner/errors";

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

function makeReport(): RefusedSpawnEdgeReport {
  return {
    code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
    operation: "service install for 'test.label'",
    leaves: "the state it leaves",
    recovery: "the recovery command",
  };
}

describe("atServiceSpawnEdge", () => {
  it("is a no-op outside an armed scope", async () => {
    await expect(atServiceSpawnEdge()).resolves.toBeUndefined();
  });
});

describe("atServiceInstallEdge", () => {
  it("is a no-op outside an armed scope: resolves, throws nothing, and calls no hook", async () => {
    const publish = vi.fn(async () => {
      throw new Error("publish must not run outside an armed scope");
    });

    await expect(atServiceInstallEdge()).resolves.toBeUndefined();

    expect(publish).not.toHaveBeenCalled();
  });

  it("inside an armed scope, publishes once and shares that one publication with later atServiceSpawnEdge() calls", async () => {
    const lease = makeLease();
    let publishCalls = 0;
    const publish = vi.fn(async () => {
      publishCalls += 1;
      return lease;
    });
    const start = async (): Promise<void> => {
      await atServiceInstallEdge();
      await atServiceSpawnEdge();
      await atServiceInstallEdge();
      await atServiceSpawnEdge();
    };

    await runWithLeaseAtServiceSpawnEdge(publish, start);

    expect(publishCalls).toBe(1);
  });
});

describe("runWithLeaseAtServiceSpawnEdge", () => {
  it("publishes exactly once when `start` reaches several edges, and before the first spawn call", async () => {
    const lease = makeLease();
    let publishCalls = 0;
    const callLog: string[] = [];
    const publish = vi.fn(async () => {
      publishCalls += 1;
      callLog.push("publish");
      return lease;
    });
    const start = async (): Promise<void> => {
      await atServiceSpawnEdge();
      callLog.push("spawn-call-1");
      await atServiceSpawnEdge();
      callLog.push("spawn-call-2");
      await atServiceSpawnEdge();
      callLog.push("spawn-call-3");
    };

    await runWithLeaseAtServiceSpawnEdge(publish, start);

    expect(publishCalls).toBe(1);
    // Every edge after the first awaits the SAME publication rather than
    // re-publishing, and `publish` genuinely resolves before the first
    // spawn-triggering call is reached, not merely once combined with three
    // edges reached.
    expect(callLog).toEqual([
      "publish",
      "spawn-call-1",
      "spawn-call-2",
      "spawn-call-3",
    ]);
    expect(lease.waitForSpawnMock).toHaveBeenCalledTimes(1);
    expect(lease.cancelMock).toHaveBeenCalledTimes(1);
  });

  it("publish resolves before the first spawn-triggering call runs", async () => {
    const order: string[] = [];
    const lease = makeLease();
    const publish = vi.fn(async () => {
      order.push("publish");
      return lease;
    });
    const start = async (): Promise<void> => {
      await atServiceSpawnEdge();
      order.push("spawn-trigger");
    };

    await runWithLeaseAtServiceSpawnEdge(publish, start);

    expect(order).toEqual(["publish", "spawn-trigger"]);
  });

  it("a successful `start` that reaches no edge publishes, waits and cancels nothing, and just returns", async () => {
    const publish = vi.fn(async () => {
      throw new Error("publish must not run when no edge is reached");
    });
    const start = vi.fn(async () => undefined);

    await expect(
      runWithLeaseAtServiceSpawnEdge(publish, start),
    ).resolves.toBeUndefined();

    expect(publish).not.toHaveBeenCalled();
  });

  it("no edge reached: an error propagates by identity, with no publish, wait, or cancel", async () => {
    const publish = vi.fn(async () => {
      throw new Error("publish must not run when no edge is reached");
    });
    const actuatorError = new Error("plain actuator failure");
    const start = vi.fn(async () => {
      throw actuatorError;
    });

    await expect(runWithLeaseAtServiceSpawnEdge(publish, start)).rejects.toBe(
      actuatorError,
    );

    expect(publish).not.toHaveBeenCalled();
  });

  it("a rejected publication rejects the edge, the spawn call after it never runs, and cancel is not called", async () => {
    const publishError = new Error("publish transport failed");
    const publish = vi.fn(async () => {
      throw publishError;
    });
    const callLog: string[] = [];
    const start = async (): Promise<void> => {
      // Not caught: the real controller call awaits the edge unconditionally
      // and its own spawn-triggering call is simply never reached.
      await atServiceSpawnEdge();
      callLog.push("spawn-call-after-rejected-edge");
    };

    await expect(runWithLeaseAtServiceSpawnEdge(publish, start)).rejects.toBe(
      publishError,
    );

    expect(callLog).toEqual([]);
  });

  it("a rejected publication rejects a LATER edge too, with the same identity, and cancel is not called", async () => {
    const publishError = new Error("publish transport failed");
    const publish = vi.fn(async () => {
      throw publishError;
    });
    const seen: unknown[] = [];
    const start = async (): Promise<void> => {
      // The macOS bootstrap-reload race reaches several edges in one `start`;
      // model that by catching the first edge's rejection myself (so the
      // second edge is actually reached) and rethrowing it unchanged.
      await atServiceSpawnEdge().catch((error: unknown) => seen.push(error));
      await atServiceSpawnEdge().catch((error: unknown) => seen.push(error));
      throw publishError;
    };

    await expect(runWithLeaseAtServiceSpawnEdge(publish, start)).rejects.toBe(
      publishError,
    );

    expect(seen).toEqual([publishError, publishError]);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("publish succeeded but the post-publish authority check failed: cancel IS called", async () => {
    const lease = makeLease();
    const publish = vi.fn(async () => lease);
    const authorityError = new Error("mutation authority was lost");
    let verifyCalls = 0;
    const verify = async (): Promise<void> => {
      verifyCalls += 1;
      // Three verify calls surround one edge now: #1 is
      // `withServiceMutationAuthority`'s own entry check, #2 is the edge's
      // PRE-publish check, #3 is its POST-publish re-check. Failing here
      // pins the post-publish one.
      if (verifyCalls === 3) throw authorityError;
    };

    await expect(
      withServiceMutationAuthority(verify, () =>
        runWithLeaseAtServiceSpawnEdge(publish, () => atServiceSpawnEdge()),
      ),
    ).rejects.toBe(authorityError);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(lease.cancelMock).toHaveBeenCalledTimes(1);
    expect(lease.waitForSpawnMock).not.toHaveBeenCalled();
  });

  it("the hook's own verify calls: 2 for one edge, still 2 for three edges (memoized publish), 0 for no edge reached", async () => {
    async function hookVerifyCallCount(
      start: () => Promise<void>,
    ): Promise<number> {
      let calls = 0;
      const verify = async (): Promise<void> => {
        calls += 1;
      };
      const lease = makeLease();
      const publish = vi.fn(async () => lease);
      await withServiceMutationAuthority(verify, () =>
        runWithLeaseAtServiceSpawnEdge(publish, start),
      );
      // Call #1 on every path is `withServiceMutationAuthority`'s own entry
      // check, made before `start` ever runs; subtracting it isolates what
      // the hook itself called.
      return calls - 1;
    }

    expect(await hookVerifyCallCount(() => atServiceSpawnEdge())).toBe(2);
    expect(
      await hookVerifyCallCount(async () => {
        await atServiceSpawnEdge();
        await atServiceSpawnEdge();
        await atServiceSpawnEdge();
      }),
    ).toBe(2);
    expect(await hookVerifyCallCount(async () => undefined)).toBe(0);
  });

  it("the pre-publish authority check failing: publish never runs, the rejection is an authority error, and neither wait nor cancel runs", async () => {
    const lease = makeLease();
    const publish = vi.fn(async () => lease);
    const authorityError = new Error("mutation authority was lost");
    let verifyCalls = 0;
    const verify = async (): Promise<void> => {
      verifyCalls += 1;
      // #1 is the entry check; #2 is the edge's PRE-publish check.
      if (verifyCalls === 2) throw authorityError;
    };

    const rejection: unknown = await withServiceMutationAuthority(verify, () =>
      runWithLeaseAtServiceSpawnEdge(publish, () => atServiceSpawnEdge()),
    ).catch((cause: unknown) => cause);

    expect(isServiceMutationAuthorityError(rejection)).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    expect(lease.waitForSpawnMock).not.toHaveBeenCalled();
    expect(lease.cancelMock).not.toHaveBeenCalled();
  });

  it("a markRegistrationCommitted error after an edge: waitForSpawn runs, then the same error is rethrown", async () => {
    const lease = makeLease();
    const publish = vi.fn(async () => lease);
    const committedError = markRegistrationCommitted(
      new Error("registered, but the record could not be committed"),
    );
    const start = async (): Promise<void> => {
      await atServiceSpawnEdge();
      throw committedError;
    };

    await expect(runWithLeaseAtServiceSpawnEdge(publish, start)).rejects.toBe(
      committedError,
    );

    expect(lease.waitForSpawnMock).toHaveBeenCalledTimes(1);
    expect(lease.cancelMock).toHaveBeenCalledTimes(1);
  });

  it("a wait that rejects does not replace the committed-registration error", async () => {
    const lease = makeLease();
    lease.waitForSpawnMock.mockImplementation(async () => {
      throw new Error("spawn wait transport failed");
    });
    const publish = vi.fn(async () => lease);
    const committedError = markRegistrationCommitted(
      new Error(
        "registered, but the lifecycle generation could not be written",
      ),
    );
    const start = async (): Promise<void> => {
      await atServiceSpawnEdge();
      throw committedError;
    };

    await expect(runWithLeaseAtServiceSpawnEdge(publish, start)).rejects.toBe(
      committedError,
    );

    expect(lease.waitForSpawnMock).toHaveBeenCalledTimes(1);
    expect(lease.cancelMock).toHaveBeenCalledTimes(1);
  });

  it("cancel rejecting does not replace the actuator error", async () => {
    const lease = makeLease();
    lease.cancelMock.mockImplementation(async () => {
      throw new Error("cancel transport failed");
    });
    const publish = vi.fn(async () => lease);
    const actuatorError = new Error("ordinary actuator failure");
    const start = async (): Promise<void> => {
      await atServiceSpawnEdge();
      throw actuatorError;
    };

    await expect(runWithLeaseAtServiceSpawnEdge(publish, start)).rejects.toBe(
      actuatorError,
    );

    // An ordinary (non-committed) error never waits for the spawn.
    expect(lease.waitForSpawnMock).not.toHaveBeenCalled();
    expect(lease.cancelMock).toHaveBeenCalledTimes(1);
  });
});

describe("isUnreportedSpawnEdgeRefusal", () => {
  it("is true for a plain Error refusal that reached an armed edge", async () => {
    const refusal = new Error("plain refusal");
    const publish = vi.fn(async () => {
      throw refusal;
    });

    const rejection: unknown = await runWithLeaseAtServiceSpawnEdge(
      publish,
      () => atServiceSpawnEdge(),
    ).catch((cause: unknown) => cause);

    expect(rejection).toBe(refusal);
    expect(isUnreportedSpawnEdgeRefusal(refusal)).toBe(true);
  });

  it("is false for an authority error - even one that comes OUT of `publish` itself, after the edge's own pre-publish check already passed", async () => {
    // Failing at the pre-publish check (#2) would never reach the
    // `!isServiceMutationAuthorityError(refusal)` guard this pin exists to
    // cover - that guard only runs once `publish()` itself has thrown. So
    // the authority loss is made to come FROM `publish`, at its own verify
    // call (#3: #1 is the entry check, #2 the edge's pre-publish check).
    const authorityError = new Error("mutation authority was lost");
    let verifyCalls = 0;
    const verify = async (): Promise<void> => {
      verifyCalls += 1;
      if (verifyCalls === 3) throw authorityError;
    };
    const publish = vi.fn(async () => {
      await verifyServiceMutationAuthority();
      return null;
    });

    const rejection: unknown = await withServiceMutationAuthority(verify, () =>
      runWithLeaseAtServiceSpawnEdge(publish, () => atServiceSpawnEdge()),
    ).catch((cause: unknown) => cause);

    expect(rejection).toBe(authorityError);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(isUnreportedSpawnEdgeRefusal(rejection)).toBe(false);
  });

  it("is false for a non-object refusal such as a string", () => {
    expect(isUnreportedSpawnEdgeRefusal("plain string refusal")).toBe(false);
  });

  it("is false for the reporter's CliError", async () => {
    const refusal = new Error("plain refusal");
    const publish = vi.fn(async () => {
      throw refusal;
    });

    const rejection: unknown = await runWithLeaseAtServiceSpawnEdge(
      publish,
      () => atServiceSpawnEdgeReporting(makeReport()),
    ).catch((cause: unknown) => cause);

    expect(rejection).not.toBe(refusal);
    expect(isUnreportedSpawnEdgeRefusal(rejection)).toBe(false);
  });
});

describe("refusedSpawnEdgeError", () => {
  it("produces a CliError whose details is exactly { cause: <string> }", () => {
    const refusal = new Error("plain refusal");

    const error = refusedSpawnEdgeError(refusal, makeReport());

    expect(error.code).toBe(CLI_ERROR_CODES.SERVICE_INSTALL_FAILED);
    expect(error.exitCode).toBe(1);
    expect(error.message).toBe(
      "service install for 'test.label': the host-start grant could not be published (plain refusal), so no start was requested. the state it leaves the recovery command",
    );
    expect(error.details).toEqual({ cause: "plain refusal" });
  });

  it("stringifies a non-Error refusal for `cause`", () => {
    const error = refusedSpawnEdgeError("plain string refusal", makeReport());

    expect(error.details).toEqual({ cause: "plain string refusal" });
    expect(error.message).toContain("plain string refusal");
  });
});

describe("atServiceSpawnEdgeReporting", () => {
  it("a plain refusal inside an armed scope rejects with the exact CliError message, details = { cause }", async () => {
    const refusal = new Error("proof write failed");
    const publish = vi.fn(async () => {
      throw refusal;
    });

    const rejection: unknown = await runWithLeaseAtServiceSpawnEdge(
      publish,
      () => atServiceSpawnEdgeReporting(makeReport()),
    ).catch((cause: unknown) => cause);

    expect(rejection).not.toBe(refusal);
    expect(rejection).toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message:
        "service install for 'test.label': the host-start grant could not be published (proof write failed), so no start was requested. the state it leaves the recovery command",
      exitCode: 1,
      details: { cause: "proof write failed" },
    });
  });

  it("an authority-loss refusal is rethrown BY IDENTITY, never wrapped", async () => {
    const authorityError = new Error("mutation authority was lost");
    let verifyCalls = 0;
    const verify = async (): Promise<void> => {
      verifyCalls += 1;
      // #1 is the entry check; #2 is the edge's pre-publish check, which is
      // as far as this test needs to reach.
      if (verifyCalls === 2) throw authorityError;
    };
    const publish = vi.fn(async () => null);

    await expect(
      withServiceMutationAuthority(verify, () =>
        runWithLeaseAtServiceSpawnEdge(publish, () =>
          atServiceSpawnEdgeReporting(makeReport()),
        ),
      ),
    ).rejects.toBe(authorityError);

    expect(publish).not.toHaveBeenCalled();
  });

  it("outside any armed scope, resolves and throws nothing", async () => {
    await expect(
      atServiceSpawnEdgeReporting(makeReport()),
    ).resolves.toBeUndefined();
  });
});
