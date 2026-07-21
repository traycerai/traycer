import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMonitor } from "../monitor";
import { resolveHostAuth } from "../../internal/host-auth";
import { readHostPidMetadata } from "../../host/pid-metadata";

// Drive the monitor's recovery state machine with a mocked WsStreamClient and a
// mocked revalidator: each `subscribe()` returns a fake session whose
// onStatusChange/onServerFrame handlers the test invokes to simulate host
// frames. Protocol/transport coverage lives in the shared ws-stream-client tests.
type FakeSession = {
  statusChange: ((status: string, reason: unknown) => void) | null;
  serverFrame: ((envelope: unknown) => void) | null;
  closed: boolean;
};

type CapturedStreamClientOptions = {
  readonly endpoint: () => unknown;
};

const { subscribeMock, revalidateMock, sessions, streamClientOptions } =
  vi.hoisted(() => {
    const sessions: FakeSession[] = [];
    const streamClientOptions: CapturedStreamClientOptions[] = [];
    const subscribeMock = vi.fn(() => {
      const session: FakeSession = {
        statusChange: null,
        serverFrame: null,
        closed: false,
      };
      const handle = {
        onStatusChange(h: (status: string, reason: unknown) => void) {
          session.statusChange = h;
        },
        onServerFrame(h: (envelope: unknown) => void) {
          session.serverFrame = h;
        },
        close() {
          session.closed = true;
        },
      };
      sessions.push(session);
      return handle;
    });
    return {
      subscribeMock,
      revalidateMock: vi.fn(),
      sessions,
      streamClientOptions,
    };
  });

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// The recovery assertions use console diagnostics, not persistent logging.
// Stub the CLI logger so this state-machine test never appends to ~/.traycer.
vi.mock("../../logger", () => ({
  createCliLogger: () => loggerMock,
}));

vi.mock("../../../../shared/host-transport/ws-stream-client", () => ({
  WsStreamClient: class {
    constructor(options: CapturedStreamClientOptions) {
      streamClientOptions.push(options);
    }

    subscribe = subscribeMock;
  },
}));

vi.mock("../../../../shared/auth/bearer-revalidator", () => ({
  createBearerRevalidator: vi.fn(() => ({
    revalidateCurrentContext: revalidateMock,
  })),
}));

vi.mock("../../internal/host-auth", () => ({
  resolveHostAuth: vi.fn(),
  cliBearerStore: { read: vi.fn(), write: vi.fn(), clear: vi.fn() },
}));

vi.mock("../../host/pid-metadata", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/pid-metadata")>();
  return {
    ...actual,
    readHostPidMetadata: vi.fn(),
  };
});

const resolveAuthMock = vi.mocked(resolveHostAuth);
const pidMock = vi.mocked(readHostPidMetadata);

function unauthorizedFatal() {
  return {
    kind: "fatalError" as const,
    details: {
      code: "UNAUTHORIZED" as const,
      reason: "invalid or expired token",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function incompatibleFatal() {
  return {
    kind: "fatalError" as const,
    details: {
      code: "INCOMPATIBLE" as const,
      reason: "version mismatch",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

// Flush pending microtasks + any due fake timers.
async function flush(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  sessions.length = 0;
  streamClientOptions.length = 0;
  subscribeMock.mockClear();
  revalidateMock.mockReset();
  resolveAuthMock.mockResolvedValue({
    token: "tok-1",
    authnBaseUrl: "https://authn.test",
    userId: "u1",
  });
  pidMock.mockResolvedValue({
    pid: 1,
    hostId: "d1",
    version: "1.0.0",
    websocketUrl: "ws://127.0.0.1:9/rpc",
    startedAt: "2026-01-01T00:00:00.000Z",
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("runMonitor recovery", () => {
  it("re-subscribes after a refresh that rotated the bearer (UNAUTHORIZED)", async () => {
    revalidateMock.mockResolvedValue("rotated");
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await flush(0);
    expect(subscribeMock).toHaveBeenCalledTimes(1);

    sessions[0].statusChange?.("closed", unauthorizedFatal());
    await flush(0);

    expect(revalidateMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledTimes(2);
    expect(sessions[0].closed).toBe(true);
    void result;
  });

  it("terminates when the refresh is rejected (session expired)", async () => {
    revalidateMock.mockResolvedValue("rejected");
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await flush(0);

    sessions[0].statusChange?.("closed", unauthorizedFatal());
    await flush(0);

    expect(await result).toBeInstanceOf(Error);
    expect((await result).message).toMatch(/session expired/);
    expect(subscribeMock).toHaveBeenCalledTimes(1);
  });

  it("terminates immediately on a non-auth fatal (INCOMPATIBLE) without refreshing", async () => {
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await flush(0);

    sessions[0].statusChange?.("closed", incompatibleFatal());
    await flush(0);

    expect((await result).message).toMatch(/host closed the stream/);
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("ignores invalid host metadata endpoints instead of caching them", async () => {
    pidMock.mockResolvedValue({
      pid: 1,
      hostId: "d1",
      version: "1.0.0",
      websocketUrl: "ws://attacker.example:9/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await flush(0);

    expect(streamClientOptions).toHaveLength(1);
    const options = streamClientOptions[0];
    expect(options).toBeDefined();
    if (options === undefined) {
      throw new Error("stream client options were not captured");
    }
    expect(options.endpoint()).toBeNull();
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    void result;
  });

  it("retries (does not terminate) on a transient network-error refresh", async () => {
    revalidateMock.mockResolvedValue("network-error");
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await flush(0);

    sessions[0].statusChange?.("closed", unauthorizedFatal());
    await flush(0);
    // No immediate re-subscribe and not terminated - a retry is scheduled.
    expect(subscribeMock).toHaveBeenCalledTimes(1);

    await flush(5_000);
    expect(subscribeMock).toHaveBeenCalledTimes(2);
    void result;
  });

  it("gives up after too many consecutive refreshes without the stream becoming healthy", async () => {
    revalidateMock.mockResolvedValue("rotated");
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await flush(0);

    // Each cycle: fatal UNAUTHORIZED → rotated → re-subscribe, with no 'open'
    // in between so the health reset never fires. MAX is 3, so the 4th rotated
    // refresh trips the guard; drive a couple extra (no-ops once settled).
    for (let i = 0; i < 5; i += 1) {
      sessions[sessions.length - 1].statusChange?.(
        "closed",
        unauthorizedFatal(),
      );
      await flush(0);
    }

    expect((await result).message).toMatch(
      /session rejected after \d+ refreshes/,
    );
  });
});
