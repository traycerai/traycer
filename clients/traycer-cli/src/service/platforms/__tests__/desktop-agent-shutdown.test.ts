import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestCooperativeShutdown } from "../desktop-agent-shutdown";

// The cooperative flow's own contract: claim -> commit -> wait for REAL
// exit, with every failure mode mapped to a distinct outcome the caller
// can route on. The dangerous directions are pinned explicitly: a denied
// claim must never commit, unknown/unreachable must never read as
// "stopped", and "stopped" is only earned by an observed pid exit.

const MOCKS = vi.hoisted(() => ({
  readHostPidMetadata: vi.fn(),
  isProcessAlive: vi.fn(),
  callHostRpcAtEndpoint: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("../../../host/pid-metadata", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../host/pid-metadata")>();
  return { ...actual, readHostPidMetadata: MOCKS.readHostPidMetadata };
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
};

beforeEach(() => {
  MOCKS.readHostPidMetadata.mockReset();
  MOCKS.isProcessAlive.mockReset();
  MOCKS.callHostRpcAtEndpoint.mockReset();
  MOCKS.loggerWarn.mockReset();
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
