import { rmSync } from "node:fs";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  forceStopHostProcess,
  forceStopHostProcessReporting,
  requestCooperativeShutdown,
  requestCooperativeShutdownReporting,
} from "../desktop-agent-shutdown";
import { ownProcessStartIdentity } from "../../../store/process-identity";
import { hostHomeDir } from "../../../store/paths";
import {
  isServiceMutationAuthorityError,
  withServiceMutationAuthority,
} from "../../mutation-authority";

// HOME is redirected to a private temp dir BEFORE anything reads it:
// `store/paths` binds `homedir()` at module load, so without this the suite
// would resolve this machine's REAL `~/.traycer`.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: makeTempDir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = makeTempDir(
      joinPath(actual.tmpdir(), "traycer-desktop-agent-shutdown-test-home-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

beforeAll(() => {
  expect(osHome.current).not.toBe("");
  expect(hostHomeDir("production").startsWith(osHome.current)).toBe(true);
});

afterAll(() => {
  rmSync(osHome.current, { recursive: true, force: true });
});

// The cooperative flow's own contract: claim -> commit -> wait for REAL
// exit, with every failure mode mapped to a distinct outcome the caller
// can route on. The dangerous directions are pinned explicitly: a denied
// claim must never commit, unknown/unreachable must never read as
// "stopped", and "stopped" is only earned by an observed pid exit.

const MOCKS = vi.hoisted(() => ({
  readHostPidMetadata: vi.fn(),
  removeHostPidMetadata: vi.fn(),
  isProcessAlive: vi.fn(),
  callHostRpcAtEndpoint: vi.fn(),
  loggerWarn: vi.fn(),
  getPublishedProcessIdentityVerdict: vi.fn(),
  verifyProcessIdentityAsync: vi.fn(),
  matchLiveProcessStartIdentity: vi.fn(),
}));

vi.mock("../../../host/pid-metadata", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../host/pid-metadata")>();
  return {
    ...actual,
    readHostPidMetadata: MOCKS.readHostPidMetadata,
    // `forceStopHostProcess` removes pid.json on the host's behalf after a
    // confirmed SIGKILL - override it too so that path never touches a real
    // one, the same discipline `readHostPidMetadata` already gets here.
    removeHostPidMetadata: MOCKS.removeHostPidMetadata,
  };
});

// `getPublishedProcessIdentityVerdict` is the seam `incumbent-check.test.ts`
// stubs the identical way for the identical reason: it shells out to a real
// OS process probe, which has no place in a hermetic unit suite.
//
// `verifyProcessIdentityAsync` and `matchLiveProcessStartIdentity` are
// added here too - the async seam the cooperative leg's fix must route
// through instead of the sync `isProcessAlive`/`matchLiveProcessStartIdentity`
// probes, and the sync probes this file's mock of `store/cli-lock` stubs.
vi.mock("../../../store/process-identity", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../store/process-identity")>();
  return {
    ...actual,
    getPublishedProcessIdentityVerdict:
      MOCKS.getPublishedProcessIdentityVerdict,
    verifyProcessIdentityAsync: MOCKS.verifyProcessIdentityAsync,
    matchLiveProcessStartIdentity: MOCKS.matchLiveProcessStartIdentity,
  };
});

vi.mock("../../../store/cli-lock", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../store/cli-lock")>();
  return { ...actual, isProcessAlive: MOCKS.isProcessAlive };
});

vi.mock("../../../internal/host-rpc", () => ({
  callHostRpcAtEndpoint: MOCKS.callHostRpcAtEndpoint,
}));

// The real logger appends to the invoking user's actual ~/.traycer log.
vi.mock("../../../logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../logger")>();
  return {
    ...actual,
    createCliLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: MOCKS.loggerWarn,
      error: vi.fn(),
    }),
  };
});

const LIVE_METADATA = {
  pid: 4242,
  hostId: "host-under-test",
  version: "1.2.3",
  websocketUrl: "ws://127.0.0.1:51234/rpc",
  startedAt: "2026-07-12T00:00:00.000Z",
  layer0: null,
  // A pre-identity pid.json: every existing test in this file exercises the
  // liveness-gate fallback (`processStartIdentity === null`), NOT the
  // identity-verdict path - that path gets its own dedicated tests below
  // with a real identity string staged.
  processStartIdentity: null,
};

beforeEach(() => {
  MOCKS.readHostPidMetadata.mockReset();
  MOCKS.removeHostPidMetadata.mockReset();
  MOCKS.isProcessAlive.mockReset();
  MOCKS.callHostRpcAtEndpoint.mockReset();
  MOCKS.loggerWarn.mockReset();
  MOCKS.getPublishedProcessIdentityVerdict.mockReset();
  MOCKS.verifyProcessIdentityAsync.mockReset();
  // A safe default so a test that forgets to stage this mock reads as "not
  // proven dead" rather than as `undefined` forever - unmocked, a poll that
  // never resolves "dead" runs out its REAL exit-grace timeout (~32s) before
  // reporting hung, which is what timed out these tests during the seam's
  // rollout rather than failing them cleanly.
  MOCKS.verifyProcessIdentityAsync.mockResolvedValue("alive-same");
  MOCKS.matchLiveProcessStartIdentity.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("requestCooperativeShutdown", () => {
  it("claims, commits, and reports stopped only after the pid is observed gone", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    // Alive for the pre-flight gone-check, gone on the first post-commit poll.
    MOCKS.verifyProcessIdentityAsync
      .mockResolvedValueOnce("alive-same")
      .mockResolvedValue("dead");
    MOCKS.callHostRpcAtEndpoint
      .mockResolvedValueOnce({ granted: { token: "tok-1" } })
      .mockResolvedValueOnce({ committed: true });

    const outcome = await requestCooperativeShutdown(
      "production",
      "restart",
      "shutdown",
    );

    expect(outcome).toEqual({ kind: "stopped" });
    expect(MOCKS.callHostRpcAtEndpoint).toHaveBeenCalledTimes(2);
    const [claimMethod, claimParams, claimEndpoint] =
      MOCKS.callHostRpcAtEndpoint.mock.calls[0];
    expect(claimMethod).toBe("lifecycle.claimShutdown");
    expect(claimParams).toMatchObject({
      ttl: expect.any(Number),
      intent: "shutdown",
    });
    // The transition id carries the operation for the host's audit trail.
    expect(claimParams.transitionId).toMatch(/^cli-restart-/);
    expect(claimEndpoint).toEqual({
      hostId: "host-under-test",
      websocketUrl: "ws://127.0.0.1:51234/rpc",
    });
    expect(MOCKS.callHostRpcAtEndpoint.mock.calls[1][0]).toBe(
      "lifecycle.commitShutdown",
    );
    expect(MOCKS.callHostRpcAtEndpoint.mock.calls[1][1]).toEqual({
      token: "tok-1",
    });
  });

  it("puts the caller's intent verbatim on the lifecycle.claimShutdown params - a 'restart' request must not become a 'shutdown' claim", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.verifyProcessIdentityAsync
      .mockResolvedValueOnce("alive-same")
      .mockResolvedValue("dead");
    MOCKS.callHostRpcAtEndpoint
      .mockResolvedValueOnce({ granted: { token: "tok-intent-restart" } })
      .mockResolvedValueOnce({ committed: true });

    await requestCooperativeShutdown("production", "restart", "restart");

    const [, restartClaimParams] = MOCKS.callHostRpcAtEndpoint.mock.calls[0];
    expect(restartClaimParams.intent).toBe("restart");

    MOCKS.callHostRpcAtEndpoint.mockReset();
    MOCKS.verifyProcessIdentityAsync.mockReset();
    MOCKS.verifyProcessIdentityAsync
      .mockResolvedValueOnce("alive-same")
      .mockResolvedValue("dead");
    MOCKS.callHostRpcAtEndpoint
      .mockResolvedValueOnce({ granted: { token: "tok-intent-shutdown" } })
      .mockResolvedValueOnce({ committed: true });

    // Positive control in the same test: a plain stop must still carry
    // "shutdown" - an implementation that hardcoded "restart" on the params
    // would pass the assertion above but fail this one.
    await requestCooperativeShutdown("production", "stop", "shutdown");

    const [, stopClaimParams] = MOCKS.callHostRpcAtEndpoint.mock.calls[0];
    expect(stopClaimParams.intent).toBe("shutdown");
    expect(stopClaimParams.intent).not.toBe(restartClaimParams.intent);
  });

  // Unreadable metadata and a proven-dead pid are DIFFERENT machines and must
  // not share an answer. Absence proves only that nothing published an
  // endpoint - a host that is still booting under a loaded agent looks
  // exactly like this. Reporting it as `no-host` let callers treat it as a
  // completed stop: `host stop` returned success over a host that kept
  // serving, and an install swapped bytes underneath it.
  it("reports no-metadata - never the proven-absent answer - when pid metadata cannot be read", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(null);
    const outcome = await requestCooperativeShutdown(
      "production",
      "stop",
      "shutdown",
    );
    expect(outcome).toEqual({ kind: "no-metadata" });
    expect(outcome).not.toEqual({ kind: "no-host" });
    expect(MOCKS.callHostRpcAtEndpoint).not.toHaveBeenCalled();
  });

  it("reports no-host without any RPC when the recorded pid is PROVEN dead", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.verifyProcessIdentityAsync.mockResolvedValue("dead");
    const outcome = await requestCooperativeShutdown(
      "production",
      "stop",
      "shutdown",
    );
    expect(outcome).toEqual({ kind: "no-host" });
    expect(MOCKS.callHostRpcAtEndpoint).not.toHaveBeenCalled();
  });

  it("reports unreachable without dialing when the advertised endpoint is not a local WebSocket", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue({
      ...LIVE_METADATA,
      websocketUrl: "https://example.com/rpc",
    });
    MOCKS.verifyProcessIdentityAsync.mockResolvedValue("alive-same");
    const outcome = await requestCooperativeShutdown(
      "production",
      "stop",
      "shutdown",
    );
    expect(outcome).toMatchObject({ kind: "unreachable" });
    expect(MOCKS.callHostRpcAtEndpoint).not.toHaveBeenCalled();
  });

  it("maps a denied claim to busy and never commits", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.verifyProcessIdentityAsync.mockResolvedValue("alive-same");
    MOCKS.callHostRpcAtEndpoint.mockResolvedValueOnce({ denied: "busy" });

    const outcome = await requestCooperativeShutdown(
      "production",
      "stop",
      "shutdown",
    );

    expect(outcome).toEqual({ kind: "busy" });
    expect(MOCKS.callHostRpcAtEndpoint).toHaveBeenCalledTimes(1);
  });

  it("maps an RPC failure to unreachable with the cause, never to stopped", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.verifyProcessIdentityAsync.mockResolvedValue("alive-same");
    MOCKS.callHostRpcAtEndpoint.mockRejectedValue(
      new Error("dial timeout after 5000ms"),
    );

    const outcome = await requestCooperativeShutdown(
      "production",
      "restart",
      "shutdown",
    );

    expect(outcome).toEqual({
      kind: "unreachable",
      cause: "dial timeout after 5000ms",
    });
    expect(MOCKS.loggerWarn).toHaveBeenCalled();
  });

  it("maps a commit denial (claim expired) to unreachable", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.verifyProcessIdentityAsync.mockResolvedValue("alive-same");
    MOCKS.callHostRpcAtEndpoint
      .mockResolvedValueOnce({ granted: { token: "tok-2" } })
      .mockResolvedValueOnce({ denied: "expired-or-unknown" });

    const outcome = await requestCooperativeShutdown(
      "production",
      "stop",
      "shutdown",
    );

    expect(outcome).toEqual({
      kind: "unreachable",
      cause: "commit denied (expired-or-unknown)",
    });
  });

  it("reports hung when the committed host outlives the exit grace", async () => {
    vi.useFakeTimers();
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    // Never dead: the gone-check passes and the exit-wait poll never
    // resolves, so the wait runs out its own timeout.
    MOCKS.verifyProcessIdentityAsync.mockResolvedValue("alive-same");
    MOCKS.callHostRpcAtEndpoint
      .mockResolvedValueOnce({ granted: { token: "tok-3" } })
      .mockResolvedValueOnce({ committed: true });

    const pending = requestCooperativeShutdown(
      "production",
      "stop",
      "shutdown",
    );
    // SHUTDOWN_FORCE_EXIT_MS (30s) + STOP_EXIT_GRACE_MARGIN_MS (2s), plus
    // slack for the final poll.
    await vi.advanceTimersByTimeAsync(40_000);

    await expect(pending).resolves.toEqual({ kind: "hung", pid: 4242 });
  });
});

// The cooperative leg's liveness/identity checks must route through the
// ASYNC probe (`verifyProcessIdentityAsync`) end to end, never through the
// synchronous ones (`isProcessAlive` from `store/cli-lock`,
// `matchLiveProcessStartIdentity`) - those block the event loop on a
// platform probe (`ps`/`tasklist`) for as long as it takes, which is exactly
// what the async seam exists to avoid on this path.
describe("the supervisor teardown's cooperative leg never probes synchronously", () => {
  it("routes through verifyProcessIdentityAsync end to end with a pre-identity (processStartIdentity: null) record", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    // The gone-check (not gone) first, then the exit-wait poll (exited) -
    // ONE seam, two different call sites in sequence.
    MOCKS.verifyProcessIdentityAsync
      .mockResolvedValueOnce("alive-same")
      .mockResolvedValue("dead");
    MOCKS.callHostRpcAtEndpoint
      .mockResolvedValueOnce({ granted: { token: "tok-u8-null-identity" } })
      .mockResolvedValueOnce({ committed: true });

    const outcome = await requestCooperativeShutdown(
      "production",
      "restart",
      "shutdown",
    );

    expect(MOCKS.isProcessAlive).not.toHaveBeenCalled();
    expect(MOCKS.matchLiveProcessStartIdentity).not.toHaveBeenCalled();
    expect(MOCKS.verifyProcessIdentityAsync).toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "stopped" });
  });

  it("routes through verifyProcessIdentityAsync end to end with a valid recorded identity string", async () => {
    const identity = ownProcessStartIdentity();
    if (identity === null) {
      throw new Error(
        "test fixture: ownProcessStartIdentity() was null on this platform",
      );
    }
    MOCKS.readHostPidMetadata.mockResolvedValue({
      ...LIVE_METADATA,
      processStartIdentity: identity,
    });
    MOCKS.verifyProcessIdentityAsync
      .mockResolvedValueOnce("alive-same")
      .mockResolvedValue("dead");
    MOCKS.callHostRpcAtEndpoint
      .mockResolvedValueOnce({ granted: { token: "tok-u8-with-identity" } })
      .mockResolvedValueOnce({ committed: true });

    const outcome = await requestCooperativeShutdown(
      "production",
      "restart",
      "shutdown",
    );

    expect(MOCKS.isProcessAlive).not.toHaveBeenCalled();
    expect(MOCKS.matchLiveProcessStartIdentity).not.toHaveBeenCalled();
    expect(MOCKS.verifyProcessIdentityAsync).toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "stopped" });
  });
});

// A stop that runs under a service-mutation scope must stop mattering the
// moment the capability is lost: an "unreachable" outcome would let the caller
// escalate to a forced kill it no longer has the authority for. Legacy callers
// run without a scope, which every test above relies on.
describe("requestCooperativeShutdown under service mutation authority", () => {
  const authority = { lost: false, verifyCalls: 0, loseOnCall: Infinity };

  beforeEach(() => {
    authority.lost = false;
    authority.verifyCalls = 0;
    authority.loseOnCall = Infinity;
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.isProcessAlive.mockReturnValue(true);
  });

  const verify = async (): Promise<void> => {
    authority.verifyCalls += 1;
    if (authority.lost || authority.verifyCalls >= authority.loseOnCall) {
      throw new Error("capability revoked");
    }
  };

  async function rejectionOf(work: Promise<unknown>): Promise<unknown> {
    try {
      await work;
    } catch (error) {
      return error;
    }
    throw new Error("expected the shutdown request to reject");
  }

  it("aborts before dialing when authority is already gone at the claim", async () => {
    // Call 1 is the scope's own entry check; call 2 is the one right before
    // `claimShutdown`.
    authority.loseOnCall = 2;

    const error = await rejectionOf(
      withServiceMutationAuthority(verify, () =>
        requestCooperativeShutdown("production", "stop", "shutdown"),
      ),
    );

    expect(isServiceMutationAuthorityError(error)).toBe(true);
    expect(MOCKS.callHostRpcAtEndpoint).not.toHaveBeenCalled();
  });

  it("releases a granted claim and never commits when authority is lost while the claim response is pending", async () => {
    const claim: { grant: (() => void) | null } = { grant: null };
    MOCKS.callHostRpcAtEndpoint.mockImplementation(async (method: string) => {
      if (method !== "lifecycle.claimShutdown") return undefined;
      await new Promise<void>((resolve) => {
        claim.grant = resolve;
      });
      return { granted: { token: "tok-revoked" } };
    });

    const pending = rejectionOf(
      withServiceMutationAuthority(verify, () =>
        requestCooperativeShutdown("production", "stop", "shutdown"),
      ),
    );
    await vi.waitFor(() => expect(claim.grant).not.toBeNull());
    authority.lost = true;
    claim.grant?.();

    const error = await pending;

    expect(isServiceMutationAuthorityError(error)).toBe(true);
    expect(
      MOCKS.callHostRpcAtEndpoint.mock.calls.map(([method]) => method),
    ).toEqual(["lifecycle.claimShutdown", "lifecycle.releaseShutdown"]);
    expect(MOCKS.callHostRpcAtEndpoint.mock.calls[1]?.[1]).toEqual({
      token: "tok-revoked",
    });
  });
});

// `forceStopHostProcess`'s own contract: kill the pid directly (SIGTERM,
// then SIGKILL after the exit grace) with no RPC involved at any point, and
// map every outcome the way `requestCooperativeShutdown` does for the
// outcomes they share (`no-metadata`/`no-host`/`stopped`/`hung`), plus the
// two kill-failure shapes unique to signalling: ESRCH (already gone) versus
// anything else (must propagate, never read as a false "stopped").
describe("forceStopHostProcess", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports no-metadata without signalling anything when pid.json cannot be read", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(null);
    const killSpy = vi.spyOn(process, "kill");

    const outcome = await forceStopHostProcess("production", "stop");

    expect(outcome).toEqual({ kind: "no-metadata" });
    expect(MOCKS.isProcessAlive).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    // There is no pid.json to purge, and no-metadata is not one of the two
    // outcomes the wrapper purges on anyway.
    expect(MOCKS.removeHostPidMetadata).not.toHaveBeenCalled();
  });

  it("reports no-host without signalling when the recorded pid is PROVEN dead, and purges the stale pid.json", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.isProcessAlive.mockReturnValue(false);
    const killSpy = vi.spyOn(process, "kill");

    const outcome = await forceStopHostProcess("production", "stop");

    expect(outcome).toEqual({ kind: "no-host" });
    expect(killSpy).not.toHaveBeenCalled();
    // A stale pid.json naming a dead pid is exactly the state the desktop
    // health monitor reads as "crashed" once its own endpoint probe fails -
    // metadata present + endpoint dead = resurrect. Purge it.
    expect(MOCKS.removeHostPidMetadata).toHaveBeenCalledWith("production");
  });

  it("reports stopped when SIGTERM alone is honored, without ever escalating to SIGKILL", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    // The pre-identity pre-flight gate is still the sync `isProcessAlive` -
    // alive, so the signal proceeds. The post-SIGTERM exit wait
    // (`waitForCooperativeExit`, shared with the cooperative leg) is the
    // ASYNC seam: gone on its first poll.
    MOCKS.isProcessAlive.mockReturnValueOnce(true);
    MOCKS.verifyProcessIdentityAsync.mockResolvedValue("dead");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const outcome = await forceStopHostProcess("production", "stop");

    expect(outcome).toEqual({ kind: "stopped" });
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
    // The purge is class-complete on the OUTCOME, not on how "stopped" was
    // reached: a graceful SIGTERM exit still leaves a race where the host's
    // own unlink and this check interleave, so the wrapper purges (best
    // effort, idempotent) on every "stopped"/"no-host" outcome regardless of
    // which signal actually landed.
    expect(MOCKS.removeHostPidMetadata).toHaveBeenCalledWith("production");
  });

  it("escalates to SIGKILL once SIGTERM is survived through the full exit grace, and reports stopped when SIGKILL lands", async () => {
    vi.useFakeTimers();
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    let sigkillSent = false;
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((_pid, signal) => {
        if (signal === "SIGKILL") sigkillSent = true;
        return true;
      });
    // Alive right up until SIGKILL actually lands - proves SIGTERM's own
    // wait ran to its full timeout rather than exiting early. The pre-flight
    // gate stays the sync `isProcessAlive`; both exit waits (post-SIGTERM,
    // post-SIGKILL) share the ASYNC `waitForCooperativeExit` seam.
    MOCKS.isProcessAlive.mockImplementation(() => !sigkillSent);
    MOCKS.verifyProcessIdentityAsync.mockImplementation(async () =>
      sigkillSent ? "dead" : "alive-same",
    );

    const pending = forceStopHostProcess("production", "stop");
    // SHUTDOWN_FORCE_EXIT_MS (30s) + STOP_EXIT_GRACE_MARGIN_MS (2s), plus
    // slack for the final poll - same margin the cooperative "hung" case
    // above uses for the identical wait helper.
    await vi.advanceTimersByTimeAsync(40_000);

    await expect(pending).resolves.toEqual({ kind: "stopped" });
    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenNthCalledWith(1, 4242, "SIGTERM");
    expect(killSpy).toHaveBeenNthCalledWith(2, 4242, "SIGKILL");
    // SIGKILL never lets the host's own shutdown handler unlink pid.json -
    // the CLI must finish that contract itself, or a dead pid with pid.json
    // still present reads as a crash to the desktop's health watchdog and
    // gets auto-respawned, undoing the stop the user just forced.
    expect(MOCKS.removeHostPidMetadata).toHaveBeenCalledWith("production");
    // The null-identity fallback skips revalidation entirely, before SIGTERM
    // AND before SIGKILL - a pre-identity pid.json never calls the verdict.
    expect(MOCKS.getPublishedProcessIdentityVerdict).not.toHaveBeenCalled();
  });

  it("still reports stopped even when removing pid.json after a confirmed SIGKILL fails", async () => {
    // Best-effort: the stop itself already succeeded (the process is
    // observed gone), so a failure tidying up pid.json must not turn a
    // successful forced stop into an error.
    vi.useFakeTimers();
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    let sigkillSent = false;
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") sigkillSent = true;
      return true;
    });
    MOCKS.isProcessAlive.mockImplementation(() => !sigkillSent);
    MOCKS.verifyProcessIdentityAsync.mockImplementation(async () =>
      sigkillSent ? "dead" : "alive-same",
    );
    MOCKS.removeHostPidMetadata.mockRejectedValue(
      new Error("EACCES: permission denied"),
    );

    const pending = forceStopHostProcess("production", "stop");
    await vi.advanceTimersByTimeAsync(40_000);

    await expect(pending).resolves.toEqual({ kind: "stopped" });
  });

  it("reports hung when the process survives BOTH SIGTERM and SIGKILL through their exit graces", async () => {
    vi.useFakeTimers();
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.isProcessAlive.mockReturnValue(true);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const pending = forceStopHostProcess("production", "stop");
    // Two full exit-grace waits back to back (SIGTERM's, then SIGKILL's).
    await vi.advanceTimersByTimeAsync(80_000);

    await expect(pending).resolves.toEqual({ kind: "hung", pid: 4242 });
    expect(killSpy).toHaveBeenCalledTimes(2);
    // The pid was never confirmed gone, so the CLI must not touch pid.json -
    // that would tell the world the host stopped when it did not.
    expect(MOCKS.removeHostPidMetadata).not.toHaveBeenCalled();
  });

  it("reads an ESRCH from process.kill as already-exited, without waiting", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.isProcessAlive.mockReturnValueOnce(true); // pre-flight only
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });

    const outcome = await forceStopHostProcess("production", "stop");

    expect(outcome).toEqual({ kind: "stopped" });
    expect(MOCKS.isProcessAlive).toHaveBeenCalledTimes(1);
    expect(MOCKS.removeHostPidMetadata).toHaveBeenCalledWith("production");
  });

  it("propagates any kill failure OTHER than ESRCH instead of reporting a false stop", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.isProcessAlive.mockReturnValue(true);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });

    await expect(forceStopHostProcess("production", "stop")).rejects.toThrow(
      "not permitted",
    );
  });

  // Identity-before-signal: a pid.json that survived a crash can name a
  // RECYCLED pid, so once a start identity is recorded, liveness alone is no
  // longer enough to justify a signal - see the identical rule in
  // `getPublishedProcessIdentityVerdict`'s own doc comment. These pin the
  // three verdicts that reach `forceStopHostProcess`, plus the fallback for
  // pid.json files written before the field existed.
  describe("process identity verification", () => {
    const IDENTITY_METADATA = {
      ...LIVE_METADATA,
      processStartIdentity: "darwin:1699999999.123456",
    };

    it("a pre-identity pid.json (processStartIdentity: null) falls back to the plain liveness gate, and never calls the identity verdict", async () => {
      MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
      MOCKS.isProcessAlive.mockReturnValue(false);

      const outcome = await forceStopHostProcess("production", "stop");

      expect(outcome).toEqual({ kind: "no-host" });
      expect(MOCKS.getPublishedProcessIdentityVerdict).not.toHaveBeenCalled();
      expect(MOCKS.removeHostPidMetadata).toHaveBeenCalledWith("production");
    });

    it("identity 'current' lets the pid be signalled, exactly like a proven-alive legacy pid.json", async () => {
      MOCKS.readHostPidMetadata.mockResolvedValue(IDENTITY_METADATA);
      MOCKS.getPublishedProcessIdentityVerdict.mockResolvedValue("current");
      // Gone on the first post-SIGTERM poll - the ASYNC exit-wait seam, not
      // the (unused here) sync `isProcessAlive`.
      MOCKS.verifyProcessIdentityAsync.mockResolvedValue("dead");
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      const outcome = await forceStopHostProcess("production", "stop");

      expect(MOCKS.getPublishedProcessIdentityVerdict).toHaveBeenCalledWith(
        4242,
        "darwin:1699999999.123456",
      );
      expect(outcome).toEqual({ kind: "stopped" });
      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
      expect(MOCKS.removeHostPidMetadata).toHaveBeenCalledWith("production");
    });

    it("identity 'mismatch' proves the pid was recycled: no-host, and NO signal is ever sent - but the stale pid.json IS purged", async () => {
      MOCKS.readHostPidMetadata.mockResolvedValue(IDENTITY_METADATA);
      MOCKS.getPublishedProcessIdentityVerdict.mockResolvedValue("mismatch");
      const killSpy = vi.spyOn(process, "kill");

      const outcome = await forceStopHostProcess("production", "stop");

      expect(outcome).toEqual({ kind: "no-host" });
      expect(killSpy).not.toHaveBeenCalled();
      // The legacy liveness gate is bypassed entirely once an identity is
      // recorded - it must not run a second, contradictory check.
      expect(MOCKS.isProcessAlive).not.toHaveBeenCalled();
      // A recycled-pid impostor is exactly the resurrection risk: the
      // record still names a pid, the endpoint behind it is dead, and the
      // desktop health monitor would read that combination as a crash.
      expect(MOCKS.removeHostPidMetadata).toHaveBeenCalledWith("production");
    });

    it("identity 'dead' also reports no-host without signalling - the other half of the dead-or-mismatch branch", async () => {
      MOCKS.readHostPidMetadata.mockResolvedValue(IDENTITY_METADATA);
      MOCKS.getPublishedProcessIdentityVerdict.mockResolvedValue("dead");
      const killSpy = vi.spyOn(process, "kill");

      const outcome = await forceStopHostProcess("production", "stop");

      expect(outcome).toEqual({ kind: "no-host" });
      expect(killSpy).not.toHaveBeenCalled();
      expect(MOCKS.removeHostPidMetadata).toHaveBeenCalledWith("production");
    });

    it("identity 'indeterminate' forbids signalling: reports identity-unverified rather than guessing, and does NOT purge", async () => {
      MOCKS.readHostPidMetadata.mockResolvedValue(IDENTITY_METADATA);
      MOCKS.getPublishedProcessIdentityVerdict.mockResolvedValue(
        "indeterminate",
      );
      const killSpy = vi.spyOn(process, "kill");

      const outcome = await forceStopHostProcess("production", "stop");

      // The error directions are not symmetric: a refused force stop is
      // retryable, but a SIGKILL delivered to a recycled pid's unrelated
      // occupant is not - so "cannot tell" must never fall through to a
      // signal.
      expect(outcome).toEqual({ kind: "identity-unverified", pid: 4242 });
      expect(killSpy).not.toHaveBeenCalled();
      // "Cannot tell" must not purge either - a live, unverifiable occupant
      // may still be the real host, and removing pid.json out from under it
      // is its own resurrection risk if the real host later exits cleanly.
      expect(MOCKS.removeHostPidMetadata).not.toHaveBeenCalled();
    });

    // The FIRST identity check only proves the occupant was ours at the
    // moment before SIGTERM. The host can exit in the last instants of the
    // ~32s exit grace and the OS can hand the pid to a stranger before the
    // final liveness poll observes it - so the same invariant has to be
    // re-proven immediately before the irreversible SIGKILL, not assumed to
    // still hold from ~32s earlier.
    describe("pre-SIGKILL revalidation", () => {
      it("second call 'mismatch': the host already exited after SIGTERM - stopped, SIGKILL is NEVER sent, and the stale pid.json IS purged", async () => {
        vi.useFakeTimers();
        MOCKS.readHostPidMetadata.mockResolvedValue(IDENTITY_METADATA);
        MOCKS.getPublishedProcessIdentityVerdict
          .mockResolvedValueOnce("current") // pre-SIGTERM check
          .mockResolvedValueOnce("mismatch"); // pre-SIGKILL revalidation
        // Alive throughout the SIGTERM wait, so it survives to the
        // revalidation point instead of exiting cleanly first - the exit
        // wait is the ASYNC seam here, since an identity-bearing record never
        // consults the sync `isProcessAlive` fallback.
        MOCKS.verifyProcessIdentityAsync.mockResolvedValue("alive-same");
        const killSpy = vi
          .spyOn(process, "kill")
          .mockImplementation(() => true);

        const pending = forceStopHostProcess("production", "stop");
        await vi.advanceTimersByTimeAsync(40_000);

        await expect(pending).resolves.toEqual({ kind: "stopped" });
        expect(MOCKS.getPublishedProcessIdentityVerdict).toHaveBeenCalledTimes(
          2,
        );
        expect(killSpy).toHaveBeenCalledTimes(1);
        expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
        // The purge is keyed on the FINAL outcome, not on which signal (if
        // any) actually landed: "stopped" here means the host exited on its
        // own after SIGTERM, and the wrapper purges on every "stopped"/
        // "no-host" outcome regardless of how it was reached.
        expect(MOCKS.removeHostPidMetadata).toHaveBeenCalledWith("production");
      });

      it("second call 'indeterminate': the escalation is refused too - identity-unverified, no SIGKILL sent", async () => {
        vi.useFakeTimers();
        MOCKS.readHostPidMetadata.mockResolvedValue(IDENTITY_METADATA);
        MOCKS.getPublishedProcessIdentityVerdict
          .mockResolvedValueOnce("current")
          .mockResolvedValueOnce("indeterminate");
        MOCKS.verifyProcessIdentityAsync.mockResolvedValue("alive-same");
        const killSpy = vi
          .spyOn(process, "kill")
          .mockImplementation(() => true);

        const pending = forceStopHostProcess("production", "stop");
        await vi.advanceTimersByTimeAsync(40_000);

        await expect(pending).resolves.toEqual({
          kind: "identity-unverified",
          pid: 4242,
        });
        expect(killSpy).toHaveBeenCalledTimes(1);
        expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
        expect(MOCKS.removeHostPidMetadata).not.toHaveBeenCalled();
      });

      it("second call 'current': the escalation proceeds and SIGKILL is sent", async () => {
        vi.useFakeTimers();
        MOCKS.readHostPidMetadata.mockResolvedValue(IDENTITY_METADATA);
        // Both the pre-SIGTERM check and the pre-SIGKILL revalidation answer
        // "current" - the occupant is proven to still be the host at each
        // gate.
        MOCKS.getPublishedProcessIdentityVerdict.mockResolvedValue("current");
        let sigkillSent = false;
        const killSpy = vi
          .spyOn(process, "kill")
          .mockImplementation((_pid, signal) => {
            if (signal === "SIGKILL") sigkillSent = true;
            return true;
          });
        MOCKS.verifyProcessIdentityAsync.mockImplementation(async () =>
          sigkillSent ? "dead" : "alive-same",
        );

        const pending = forceStopHostProcess("production", "stop");
        await vi.advanceTimersByTimeAsync(40_000);

        await expect(pending).resolves.toEqual({ kind: "stopped" });
        // Both gates were actually consulted with the SAME recorded
        // identity - the first before SIGTERM, the second before SIGKILL.
        expect(MOCKS.getPublishedProcessIdentityVerdict).toHaveBeenCalledTimes(
          2,
        );
        expect(
          MOCKS.getPublishedProcessIdentityVerdict,
        ).toHaveBeenNthCalledWith(1, 4242, "darwin:1699999999.123456");
        expect(
          MOCKS.getPublishedProcessIdentityVerdict,
        ).toHaveBeenNthCalledWith(2, 4242, "darwin:1699999999.123456");
        expect(killSpy).toHaveBeenCalledTimes(2);
        expect(killSpy).toHaveBeenNthCalledWith(1, 4242, "SIGTERM");
        expect(killSpy).toHaveBeenNthCalledWith(2, 4242, "SIGKILL");
        expect(MOCKS.removeHostPidMetadata).toHaveBeenCalledWith("production");
      });
    });
  });

  // Instance-matched purge: the wrapper's purge fires only when a FRESH
  // re-read of pid.json (taken AFTER the outcome settles) still names the
  // exact instance the signals were aimed at (same pid, same
  // processStartIdentity). A supervisor relaunched mid-stop can snapshot the
  // pre-existing stop intent as already served and publish a REPLACEMENT
  // pid.json in the window between the signal and this re-read -
  // unconditionally unlinking would delete the replacement's record,
  // leaving that host running but undiscoverable. `readHostPidMetadata` is
  // mocked with `mockResolvedValueOnce` per call here: the FIRST call is
  // `signalHostForForcedStop`'s own read (which becomes `actedOn`), the
  // SECOND is the wrapper's post-outcome re-read - exactly two calls total
  // regardless of how many identity checks ran in between, since metadata is
  // read once at the top and reused for the rest of the signal flow.
  describe("instance-matched purge", () => {
    it("does NOT purge when the re-read pid.json names a DIFFERENT pid (a replacement instance published mid-stop) - outcome is still stopped", async () => {
      MOCKS.readHostPidMetadata
        .mockResolvedValueOnce(LIVE_METADATA) // signalHostForForcedStop's read -> actedOn
        .mockResolvedValueOnce({ ...LIVE_METADATA, pid: 9999 }); // wrapper's re-read: a replacement
      MOCKS.isProcessAlive.mockReturnValueOnce(true);
      MOCKS.verifyProcessIdentityAsync.mockResolvedValue("dead");
      vi.spyOn(process, "kill").mockImplementation(() => true);

      const outcome = await forceStopHostProcess("production", "stop");

      expect(outcome).toEqual({ kind: "stopped" });
      expect(MOCKS.removeHostPidMetadata).not.toHaveBeenCalled();
    });

    it("does NOT purge when the re-read pid.json keeps the same pid but a DIFFERENT processStartIdentity (the pid was recycled into a new instance) - outcome is still stopped", async () => {
      MOCKS.readHostPidMetadata
        .mockResolvedValueOnce(LIVE_METADATA)
        .mockResolvedValueOnce({
          ...LIVE_METADATA,
          processStartIdentity: "darwin:1700000000.000000",
        });
      MOCKS.isProcessAlive.mockReturnValueOnce(true);
      MOCKS.verifyProcessIdentityAsync.mockResolvedValue("dead");
      vi.spyOn(process, "kill").mockImplementation(() => true);

      const outcome = await forceStopHostProcess("production", "stop");

      expect(outcome).toEqual({ kind: "stopped" });
      expect(MOCKS.removeHostPidMetadata).not.toHaveBeenCalled();
    });

    it("does NOT purge when the record vanished before the re-read (the host's own shutdown handler already unlinked it) - outcome is still stopped", async () => {
      MOCKS.readHostPidMetadata
        .mockResolvedValueOnce(LIVE_METADATA)
        .mockResolvedValueOnce(null);
      MOCKS.isProcessAlive.mockReturnValueOnce(true);
      MOCKS.verifyProcessIdentityAsync.mockResolvedValue("dead");
      vi.spyOn(process, "kill").mockImplementation(() => true);

      const outcome = await forceStopHostProcess("production", "stop");

      expect(outcome).toEqual({ kind: "stopped" });
      expect(MOCKS.removeHostPidMetadata).not.toHaveBeenCalled();
    });

    it("DOES purge when the re-read pid.json still names the exact same instance (same pid, same processStartIdentity) - the ordinary confirmed-stop case", async () => {
      MOCKS.readHostPidMetadata
        .mockResolvedValueOnce(LIVE_METADATA)
        .mockResolvedValueOnce({ ...LIVE_METADATA });
      MOCKS.isProcessAlive.mockReturnValueOnce(true);
      MOCKS.verifyProcessIdentityAsync.mockResolvedValue("dead");
      vi.spyOn(process, "kill").mockImplementation(() => true);

      const outcome = await forceStopHostProcess("production", "stop");

      expect(outcome).toEqual({ kind: "stopped" });
      expect(MOCKS.removeHostPidMetadata).toHaveBeenCalledWith("production");
    });
  });
});

// `StopServiceOptions.onHostAddressed`, reported from the engine's OWN reads:
// the install lifecycle's restore after a refused swap owes the machine a
// host only if this stop took one down, and neither `externally-managed` nor
// a `void` resolution can say so. It fires once a live, current host is about
// to be claimed or signalled - never for a missing record, a dead pid, or an
// identity the engine refuses to signal.
describe("onHostAddressed", () => {
  afterEach(() => {
    // `process.kill` spies accumulate across tests otherwise.
    vi.restoreAllMocks();
  });

  it("cooperative: fires once, after the liveness read and before the claim, for a live host", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.verifyProcessIdentityAsync
      .mockResolvedValueOnce("alive-same")
      .mockResolvedValue("dead");
    const onHostAddressed = vi.fn();
    MOCKS.callHostRpcAtEndpoint.mockImplementation(async (method: string) => {
      // The report precedes the first RPC.
      expect(onHostAddressed).toHaveBeenCalledTimes(1);
      return method === "lifecycle.claimShutdown"
        ? { granted: { token: "tok-1" } }
        : { committed: true };
    });

    const outcome = await requestCooperativeShutdownReporting(
      "production",
      "stop",
      "shutdown",
      onHostAddressed,
    );

    expect(outcome).toEqual({ kind: "stopped" });
    expect(onHostAddressed).toHaveBeenCalledTimes(1);
  });

  it("cooperative: still fires when the claim then fails - the host was addressed whatever the RPC did", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.verifyProcessIdentityAsync.mockResolvedValue("alive-same");
    MOCKS.callHostRpcAtEndpoint.mockRejectedValue(new Error("dial failed"));
    const onHostAddressed = vi.fn();

    const outcome = await requestCooperativeShutdownReporting(
      "production",
      "stop",
      "shutdown",
      onHostAddressed,
    );

    expect(outcome).toMatchObject({ kind: "unreachable" });
    expect(onHostAddressed).toHaveBeenCalledTimes(1);
  });

  it("cooperative: does not fire for a missing record or a dead pid", async () => {
    const onHostAddressed = vi.fn();
    MOCKS.readHostPidMetadata.mockResolvedValue(null);
    await expect(
      requestCooperativeShutdownReporting(
        "production",
        "stop",
        "shutdown",
        onHostAddressed,
      ),
    ).resolves.toEqual({ kind: "no-metadata" });

    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.verifyProcessIdentityAsync.mockResolvedValue("dead");
    await expect(
      requestCooperativeShutdownReporting(
        "production",
        "stop",
        "shutdown",
        onHostAddressed,
      ),
    ).resolves.toEqual({ kind: "no-host" });

    expect(onHostAddressed).not.toHaveBeenCalled();
  });

  it("forced: fires once the pid is verified live, before SIGTERM", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.isProcessAlive.mockReturnValueOnce(true);
    MOCKS.verifyProcessIdentityAsync.mockResolvedValue("dead");
    const onHostAddressed = vi.fn();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      expect(onHostAddressed).toHaveBeenCalledTimes(1);
      return true;
    });

    const outcome = await forceStopHostProcessReporting(
      "production",
      "stop",
      onHostAddressed,
    );

    expect(outcome).toEqual({ kind: "stopped" });
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(onHostAddressed).toHaveBeenCalledTimes(1);
  });

  it("forced: does not fire for a dead pid, which is never signalled", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.isProcessAlive.mockReturnValue(false);
    const killSpy = vi.spyOn(process, "kill");
    const onHostAddressed = vi.fn();

    const outcome = await forceStopHostProcessReporting(
      "production",
      "stop",
      onHostAddressed,
    );

    expect(outcome).toEqual({ kind: "no-host" });
    expect(killSpy).not.toHaveBeenCalled();
    expect(onHostAddressed).not.toHaveBeenCalled();
  });
});
