import { afterEach, describe, expect, it, vi } from "vitest";

// `probeHostHealth` gates whether `host update` rolls back a swap. Its one
// hard requirement is the binary-health / coordination-server(CS)-
// reachability separation: it must never make a network call that could be
// affected by a CS (or auth-service) blip. This suite exercises the
// success/failure/backoff matrix with injected fakes and separately pins
// the "no network calls beyond loopback TCP" guarantee by asserting the
// module never imports anything that could dial out.

const mocks = vi.hoisted(() => ({
  readHostPidMetadataMock: vi.fn(),
  isProcessAliveMock: vi.fn(),
}));

vi.mock("../../host/pid-metadata", async () => {
  const actual = await vi.importActual<
    typeof import("../../host/pid-metadata")
  >("../../host/pid-metadata");
  return {
    ...actual,
    readHostPidMetadata: mocks.readHostPidMetadataMock,
  };
});

vi.mock("../../store/cli-lock", async () => {
  const actual = await vi.importActual<typeof import("../../store/cli-lock")>(
    "../../store/cli-lock",
  );
  return {
    ...actual,
    isProcessAlive: mocks.isProcessAliveMock,
  };
});

import { probeHostHealth } from "../health-probe";

function sampleMetadata(
  overrides: Partial<{ pid: number; websocketUrl: string }>,
) {
  return {
    pid: overrides.pid ?? 4242,
    hostId: "host-1",
    version: "1.0.0",
    websocketUrl: overrides.websocketUrl ?? "ws://127.0.0.1:41000/rpc",
    startedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("probeHostHealth", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("reports healthy on the first attempt when pid is alive and TCP is reachable", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(sampleMetadata({}));
    const checkProcessAlive = vi.fn(() => true);
    const checkTcpReachable = vi.fn(async () => true);

    const result = await probeHostHealth({
      environment: "production",
      checkProcessAlive,
      checkTcpReachable,
      totalBudgetMs: 1_000,
      retryDelayMs: 5,
    });

    expect(result.healthy).toBe(true);
    expect(checkProcessAlive).toHaveBeenCalledWith(4242);
    expect(checkTcpReachable).toHaveBeenCalledWith("127.0.0.1", 41000);
    expect(mocks.readHostPidMetadataMock).toHaveBeenCalledTimes(1);
  });

  it("reports unhealthy immediately when no pid metadata exists", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(null);
    const result = await probeHostHealth({
      environment: "production",
      checkProcessAlive: vi.fn(() => true),
      checkTcpReachable: vi.fn(async () => true),
      totalBudgetMs: 0,
      retryDelayMs: 5,
    });
    expect(result.healthy).toBe(false);
    expect(result.detail).toContain("no host pid metadata");
  });

  it("reports unhealthy when the pid is not alive, without ever checking TCP", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(sampleMetadata({}));
    const checkTcpReachable = vi.fn(async () => true);
    const result = await probeHostHealth({
      environment: "production",
      checkProcessAlive: () => false,
      checkTcpReachable,
      totalBudgetMs: 0,
      retryDelayMs: 5,
    });
    expect(result.healthy).toBe(false);
    expect(result.detail).toContain("not alive");
    expect(checkTcpReachable).not.toHaveBeenCalled();
  });

  it("reports unhealthy when the TCP dial fails after the pid checks out", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(sampleMetadata({}));
    const result = await probeHostHealth({
      environment: "production",
      checkProcessAlive: () => true,
      checkTcpReachable: async () => false,
      totalBudgetMs: 0,
      retryDelayMs: 5,
    });
    expect(result.healthy).toBe(false);
    expect(result.detail).toContain("did not accept a TCP connection");
  });

  it("retries with backoff until healthy within the budget", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(sampleMetadata({}));
    let attempts = 0;
    const checkTcpReachable = vi.fn(async () => {
      attempts += 1;
      return attempts >= 3;
    });
    const result = await probeHostHealth({
      environment: "production",
      checkProcessAlive: () => true,
      checkTcpReachable,
      totalBudgetMs: 5_000,
      retryDelayMs: 1,
    });
    expect(result.healthy).toBe(true);
    expect(attempts).toBe(3);
  });

  it("gives up and reports the last failure detail once the budget is exhausted", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(sampleMetadata({}));
    const checkTcpReachable = vi.fn(async () => false);
    const result = await probeHostHealth({
      environment: "production",
      checkProcessAlive: () => true,
      checkTcpReachable,
      totalBudgetMs: 20,
      retryDelayMs: 5,
    });
    expect(result.healthy).toBe(false);
    expect(result.detail).toContain("did not accept a TCP connection");
    // Bounded: didn't spin forever - a handful of attempts within ~20ms budget.
    expect(checkTcpReachable.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(checkTcpReachable.mock.calls.length).toBeLessThan(20);
  });

  it("rejects a pid-metadata websocket URL that isn't a valid local endpoint", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(
      sampleMetadata({ websocketUrl: "ws://example.com/rpc" }),
    );
    const result = await probeHostHealth({
      environment: "production",
      checkProcessAlive: () => true,
      checkTcpReachable: async () => true,
      totalBudgetMs: 0,
      retryDelayMs: 5,
    });
    expect(result.healthy).toBe(false);
    expect(result.detail).toContain("invalid local websocket URL");
  });

  it("uses the real pid-liveness and loopback-TCP checks when no fakes are injected", async () => {
    // Exercises the default (non-injected) code path so it's covered by
    // something other than the always-faked tests above - a nonsense port
    // must fail to connect, proving the default `checkTcpReachable`
    // actually dials out rather than being a stub that always resolves.
    // `isProcessAlive` itself is mocked at the module boundary for this
    // whole file (see the `../../store/cli-lock` vi.mock above), so pin it
    // to "alive" here to isolate the assertion to the TCP path.
    mocks.isProcessAliveMock.mockReturnValue(true);
    mocks.readHostPidMetadataMock.mockResolvedValue(
      sampleMetadata({
        pid: process.pid,
        websocketUrl: "ws://127.0.0.1:1/rpc",
      }),
    );
    const result = await probeHostHealth({
      environment: "production",
      checkProcessAlive: null,
      checkTcpReachable: null,
      totalBudgetMs: 0,
      retryDelayMs: 5,
    });
    expect(result.healthy).toBe(false);
    expect(result.detail).toContain("did not accept a TCP connection");
  });
});

describe("probeHostHealth CS-reachability separation", () => {
  it("never imports anything that resolves auth credentials or dials the coordination server", async () => {
    // Static-analysis guard: the health-probe module's only local imports
    // are pid-metadata + cli-lock + node:net - never `internal/host-rpc`,
    // `internal/host-auth`, or any registry/fetch-based client. A future
    // change that pulls in an authenticated RPC path here would show up as
    // a new disallowed import rather than a silent behavioural change.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(__dirname, "..", "health-probe.ts"),
      "utf8",
    );
    const disallowed = [
      'from "../internal/host-rpc',
      'from "../internal/host-auth',
      'from "../registry',
      "fetch(",
    ];
    for (const token of disallowed) {
      expect(source).not.toContain(token);
    }
  });
});
