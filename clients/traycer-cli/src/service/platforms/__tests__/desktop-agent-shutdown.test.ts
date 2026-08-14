import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forceStopHostProcess,
  requestCooperativeShutdown,
} from "../desktop-agent-shutdown";

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
vi.mock("../../../store/process-identity", () => ({
  getPublishedProcessIdentityVerdict: MOCKS.getPublishedProcessIdentityVerdict,
}));

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
});

afterEach(() => {
  vi.useRealTimers();
});

describe("requestCooperativeShutdown", () => {
  it("claims, commits, and reports stopped only after the pid is observed gone", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    // Alive for the pre-flight check, gone on the first post-commit poll.
    MOCKS.isProcessAlive.mockReturnValueOnce(true).mockReturnValue(false);
    MOCKS.callHostRpcAtEndpoint
      .mockResolvedValueOnce({ granted: { token: "tok-1" } })
      .mockResolvedValueOnce({ committed: true });

    const outcome = await requestCooperativeShutdown("production", "restart");

    expect(outcome).toEqual({ kind: "stopped" });
    expect(MOCKS.callHostRpcAtEndpoint).toHaveBeenCalledTimes(2);
    const [claimMethod, claimParams, claimEndpoint] =
      MOCKS.callHostRpcAtEndpoint.mock.calls[0];
    expect(claimMethod).toBe("lifecycle.claimShutdown");
    expect(claimParams).toMatchObject({ ttl: expect.any(Number) });
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

  // Unreadable metadata and a proven-dead pid are DIFFERENT machines and must
  // not share an answer. Absence proves only that nothing published an
  // endpoint - a host that is still booting under a loaded agent looks
  // exactly like this. Reporting it as `no-host` let callers treat it as a
  // completed stop: `host stop` returned success over a host that kept
  // serving, and an install swapped bytes underneath it.
  it("reports no-metadata - never the proven-absent answer - when pid metadata cannot be read", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(null);
    const outcome = await requestCooperativeShutdown("production", "stop");
    expect(outcome).toEqual({ kind: "no-metadata" });
    expect(outcome).not.toEqual({ kind: "no-host" });
    expect(MOCKS.callHostRpcAtEndpoint).not.toHaveBeenCalled();
  });

  it("reports no-host without any RPC when the recorded pid is PROVEN dead", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.isProcessAlive.mockReturnValue(false);
    const outcome = await requestCooperativeShutdown("production", "stop");
    expect(outcome).toEqual({ kind: "no-host" });
    expect(MOCKS.callHostRpcAtEndpoint).not.toHaveBeenCalled();
  });

  it("reports unreachable without dialing when the advertised endpoint is not a local WebSocket", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue({
      ...LIVE_METADATA,
      websocketUrl: "https://example.com/rpc",
    });
    MOCKS.isProcessAlive.mockReturnValue(true);
    const outcome = await requestCooperativeShutdown("production", "stop");
    expect(outcome).toMatchObject({ kind: "unreachable" });
    expect(MOCKS.callHostRpcAtEndpoint).not.toHaveBeenCalled();
  });

  it("maps a denied claim to busy and never commits", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.isProcessAlive.mockReturnValue(true);
    MOCKS.callHostRpcAtEndpoint.mockResolvedValueOnce({ denied: "busy" });

    const outcome = await requestCooperativeShutdown("production", "stop");

    expect(outcome).toEqual({ kind: "busy" });
    expect(MOCKS.callHostRpcAtEndpoint).toHaveBeenCalledTimes(1);
  });

  it("maps an RPC failure to unreachable with the cause, never to stopped", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.isProcessAlive.mockReturnValue(true);
    MOCKS.callHostRpcAtEndpoint.mockRejectedValue(
      new Error("dial timeout after 5000ms"),
    );

    const outcome = await requestCooperativeShutdown("production", "restart");

    expect(outcome).toEqual({
      kind: "unreachable",
      cause: "dial timeout after 5000ms",
    });
    expect(MOCKS.loggerWarn).toHaveBeenCalled();
  });

  it("maps a commit denial (claim expired) to unreachable", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.isProcessAlive.mockReturnValue(true);
    MOCKS.callHostRpcAtEndpoint
      .mockResolvedValueOnce({ granted: { token: "tok-2" } })
      .mockResolvedValueOnce({ denied: "expired-or-unknown" });

    const outcome = await requestCooperativeShutdown("production", "stop");

    expect(outcome).toEqual({
      kind: "unreachable",
      cause: "commit denied (expired-or-unknown)",
    });
  });

  it("reports hung when the committed host outlives the exit grace", async () => {
    vi.useFakeTimers();
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.isProcessAlive.mockReturnValue(true);
    MOCKS.callHostRpcAtEndpoint
      .mockResolvedValueOnce({ granted: { token: "tok-3" } })
      .mockResolvedValueOnce({ committed: true });

    const pending = requestCooperativeShutdown("production", "stop");
    // SHUTDOWN_FORCE_EXIT_MS (30s) + STOP_EXIT_GRACE_MARGIN_MS (2s), plus
    // slack for the final poll.
    await vi.advanceTimersByTimeAsync(40_000);

    await expect(pending).resolves.toEqual({ kind: "hung", pid: 4242 });
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
  });

  it("reports no-host without signalling when the recorded pid is PROVEN dead", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    MOCKS.isProcessAlive.mockReturnValue(false);
    const killSpy = vi.spyOn(process, "kill");

    const outcome = await forceStopHostProcess("production", "stop");

    expect(outcome).toEqual({ kind: "no-host" });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("reports stopped when SIGTERM alone is honored, without ever escalating to SIGKILL", async () => {
    MOCKS.readHostPidMetadata.mockResolvedValue(LIVE_METADATA);
    // Alive for the pre-flight check, gone on the first post-SIGTERM poll -
    // same shape as requestCooperativeShutdown's "stopped" case above.
    MOCKS.isProcessAlive.mockReturnValueOnce(true).mockReturnValue(false);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const outcome = await forceStopHostProcess("production", "stop");

    expect(outcome).toEqual({ kind: "stopped" });
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
    // pid.json is the HOST's own file to remove on a graceful SIGTERM exit -
    // only a SIGKILL that skipped the shutdown handler needs the CLI to
    // finish that contract on the host's behalf.
    expect(MOCKS.removeHostPidMetadata).not.toHaveBeenCalled();
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
    // wait ran to its full timeout rather than exiting early.
    MOCKS.isProcessAlive.mockImplementation(() => !sigkillSent);

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
    });

    it("identity 'current' lets the pid be signalled, exactly like a proven-alive legacy pid.json", async () => {
      MOCKS.readHostPidMetadata.mockResolvedValue(IDENTITY_METADATA);
      MOCKS.getPublishedProcessIdentityVerdict.mockResolvedValue("current");
      // Gone on the first post-SIGTERM poll.
      MOCKS.isProcessAlive.mockReturnValue(false);
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      const outcome = await forceStopHostProcess("production", "stop");

      expect(MOCKS.getPublishedProcessIdentityVerdict).toHaveBeenCalledWith(
        4242,
        "darwin:1699999999.123456",
      );
      expect(outcome).toEqual({ kind: "stopped" });
      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
    });

    it("identity 'mismatch' proves the pid was recycled: no-host, and NO signal is ever sent", async () => {
      MOCKS.readHostPidMetadata.mockResolvedValue(IDENTITY_METADATA);
      MOCKS.getPublishedProcessIdentityVerdict.mockResolvedValue("mismatch");
      const killSpy = vi.spyOn(process, "kill");

      const outcome = await forceStopHostProcess("production", "stop");

      expect(outcome).toEqual({ kind: "no-host" });
      expect(killSpy).not.toHaveBeenCalled();
      // The legacy liveness gate is bypassed entirely once an identity is
      // recorded - it must not run a second, contradictory check.
      expect(MOCKS.isProcessAlive).not.toHaveBeenCalled();
    });

    it("identity 'dead' also reports no-host without signalling - the other half of the dead-or-mismatch branch", async () => {
      MOCKS.readHostPidMetadata.mockResolvedValue(IDENTITY_METADATA);
      MOCKS.getPublishedProcessIdentityVerdict.mockResolvedValue("dead");
      const killSpy = vi.spyOn(process, "kill");

      const outcome = await forceStopHostProcess("production", "stop");

      expect(outcome).toEqual({ kind: "no-host" });
      expect(killSpy).not.toHaveBeenCalled();
    });

    it("identity 'indeterminate' forbids signalling: reports identity-unverified rather than guessing", async () => {
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
    });
  });
});
