import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMonitor } from "../monitor";
import { resolveHostAuth } from "../../internal/host-auth";
import { readHostPidMetadata } from "../../host/pid-metadata";
import { callHostRpc } from "../../internal/host-rpc";

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

const {
  subscribeMock,
  getMethodSchemaVersionMock,
  revalidateMock,
  disposeMock,
  sessions,
  streamClientOptions,
} = vi.hoisted(() => {
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
  // Defaults to the latest negotiated minor (@1.3) the monitor itself
  // targets - every existing test in this file exercises a fully-current
  // host, so this preserves prior behavior. Mixed-version negotiation is
  // covered by its own dedicated tests, which override this per-test.
  const getMethodSchemaVersionMock = vi.fn(() => ({ major: 1, minor: 3 }));
  return {
    subscribeMock,
    getMethodSchemaVersionMock,
    revalidateMock: vi.fn(),
    disposeMock: vi.fn(),
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
    getMethodSchemaVersion = getMethodSchemaVersionMock;
  },
}));

// The monitor's revalidator now comes from the store-backed factory (§7); the
// recovery state machine under test is agnostic to how the revalidator refreshes,
// so a mocked `revalidateCurrentContext` drives it exactly as before. The store
// is a `dispose`-only stub (the monitor disposes it on exit).
vi.mock("../../store/credentials-store", () => ({
  createCliCredentialsStore: vi.fn(() => ({ dispose: disposeMock })),
  createStoreBackedRevalidator: vi.fn(() => ({
    revalidateCurrentContext: revalidateMock,
  })),
}));

vi.mock("../../internal/host-auth", () => ({
  resolveHostAuth: vi.fn(),
}));

vi.mock("../../internal/host-rpc", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-rpc")>();
  return {
    ...actual,
    callHostRpc: vi.fn(),
  };
});

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
const callHostRpcMock = vi.mocked(callHostRpc);

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
  disposeMock.mockClear();
  callHostRpcMock.mockReset();
  callHostRpcMock.mockResolvedValue({});
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
    processStartIdentity: null,
    // Mirrors the real reader, which now always reports the host's Layer 0
    // verdict. `null` = this fixture's host recorded no attempt.
    layer0: null,
    layer0Slot: null,
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
    // The per-run store is disposed when the monitor loop terminates (finally).
    expect(disposeMock).toHaveBeenCalledTimes(1);
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
      processStartIdentity: null,
      layer0: null,
      layer0Slot: null,
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

describe("role awareness frames (negotiated @1.1)", () => {
  it("prints one compact [traycer roles] line per event, for both claim and relinquish", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await flush(0);

    const claim = {
      claimId: "33333333-3333-4333-8333-333333333333",
      agentId: "peer-1",
      role: "Planner",
      scope: "auth migration",
      claimedAt: 10,
    };
    sessions[0].serverFrame?.({
      kind: "role-awareness",
      hasBinaryPayload: false,
      event: { kind: "role-claimed", epicId: "e1", claim, at: 20 },
    });
    sessions[0].serverFrame?.({
      kind: "role-awareness",
      hasBinaryPayload: false,
      event: { kind: "role-relinquished", epicId: "e1", claim, at: 30 },
    });

    const lines = stdoutSpy.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain(
      '[traycer roles] agent peer-1 claimed role "Planner" (scope: auth migration)\n',
    );
    expect(lines).toContain(
      '[traycer roles] agent peer-1 relinquished role "Planner" (scope: auth migration)\n',
    );

    stdoutSpy.mockRestore();
    void result;
  });

  it("drops a malformed role-awareness frame without printing", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await flush(0);

    // `claim` violates the wire schema (empty role), so the frame must not
    // reach the printer - the monitor drops what it cannot trust.
    sessions[0].serverFrame?.({
      kind: "role-awareness",
      hasBinaryPayload: false,
      event: {
        kind: "role-claimed",
        epicId: "e1",
        claim: {
          claimId: "33333333-3333-4333-8333-333333333333",
          agentId: "peer-1",
          role: "",
          scope: "auth migration",
          claimedAt: 10,
        },
        at: 20,
      },
    });

    const lines = stdoutSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes("[traycer roles]"))).toEqual(
      [],
    );

    stdoutSpy.mockRestore();
    void result;
  });
});

describe("stop initiator notices (negotiated @1.3)", () => {
  function emitCancelledNotice(
    stopInitiator:
      | { readonly type: "user" }
      | {
          readonly type: "agent";
          readonly agentId: string;
          readonly agentTitle: string | null;
        },
  ): void {
    sessions[0].serverFrame?.({
      kind: "notice",
      hasBinaryPayload: false,
      notice: {
        kind: "inactivity",
        senderAgentId: "a1",
        responseId: "response-1",
        receiverAgentId: "receiver-1",
        receiverTitle: "Worker",
        receiverHarnessId: "codex",
        epicId: "e1",
        reason: "receiver-cancelled",
        detail: null,
        droppedReceivers: null,
        stopInitiator,
        noticedAt: 123,
      },
    });
  }

  it("names the agent responsible for a stop", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await flush(0);

    emitCancelledNotice({
      type: "agent",
      agentId: "5b8d8768-1d43-42ef-bd99-d57a066e86f2",
      agentTitle: "Review",
    });

    const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain(
      "was stopped by agent Review (5b8d8768-1d43-42ef-bd99-d57a066e86f2)",
    );
    expect(output).not.toContain("stopped by the user");

    stdoutSpy.mockRestore();
    void result;
  });

  it("keeps human-initiated stops attributed to the user", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await flush(0);

    emitCancelledNotice({ type: "user" });

    const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("was stopped by the user");

    stdoutSpy.mockRestore();
    void result;
  });
});

describe("mixed-version inbox message frames", () => {
  it("parses and prints an old-host (@1.0-negotiated) message frame with no eventId, and never calls agent.inbox.ack for it", async () => {
    getMethodSchemaVersionMock.mockReturnValueOnce({ major: 1, minor: 0 });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await flush(0);

    // The @1.0 wire shape has no `eventId` field at all - parsing this
    // against the latest (@1.2) schema, which requires it, would fail
    // outright and silently drop the message. Parsing against the
    // NEGOTIATED minor must succeed.
    sessions[0].serverFrame?.({
      kind: "message",
      hasBinaryPayload: false,
      item: {
        reply: { expectsReply: false },
        fromAgentId: "peer-1",
        senderTitle: null,
        senderHarnessId: null,
        epicId: "e1",
        prompt: "hello from an old host",
        enqueuedAt: 123,
      },
    });
    await flush(0);

    const lines = stdoutSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("hello from an old host"))).toBe(
      true,
    );
    expect(callHostRpcMock).not.toHaveBeenCalledWith(
      "agent.inbox.ack",
      expect.anything(),
    );

    stdoutSpy.mockRestore();
    void result;
  });

  it("prints a new-host (@1.2-negotiated) message frame and acks only after the stdout write is CONFIRMED", async () => {
    // Exercises the ack path, which now awaits `writeStdoutForAck`'s own
    // per-write outcome (see `std-write.ts`) rather than the module-wide
    // `flushStdio()` chain - so the mock must actually invoke the write's
    // completion callback, not just return `true`.
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((..._args: unknown[]) => {
        const cb = _args.find((arg) => typeof arg === "function") as
          (() => void) | undefined;
        cb?.();
        return true;
      });
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await flush(0);

    sessions[0].serverFrame?.({
      kind: "message",
      hasBinaryPayload: false,
      item: {
        reply: { expectsReply: false },
        fromAgentId: "peer-1",
        senderTitle: null,
        senderHarnessId: null,
        epicId: "e1",
        prompt: "hello from a new host",
        enqueuedAt: 123,
        eventId: "evt-1",
      },
    });
    // The write is issued synchronously; `writeStdoutForAck`'s own outcome
    // promise is now DECOUPLED from any other pending write's completion
    // (unlike the old `flushStdio()`-gated ack, which wailted on the whole
    // module-level tail and could be poisoned by an unrelated earlier
    // write) - so a couple of microtask ticks are enough for both the print
    // and the ack to land, no fake-timer fallback needed.
    await flush(0);
    await flush(0);

    const lines = stdoutSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("hello from a new host"))).toBe(
      true,
    );
    expect(callHostRpcMock).toHaveBeenCalledWith("agent.inbox.ack", {
      epicId: "e1",
      agentId: "a1",
      eventIds: ["evt-1"],
    });

    stdoutSpy.mockRestore();
    void result;
  });

  it("batches concurrently confirmed inbox messages into one bounded acknowledgement", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((..._args: unknown[]) => {
        const cb = _args.find((arg) => typeof arg === "function") as
          (() => void) | undefined;
        cb?.();
        return true;
      });
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await flush(0);

    for (const eventId of ["evt-4", "evt-5"]) {
      sessions[0].serverFrame?.({
        kind: "message",
        hasBinaryPayload: false,
        item: {
          reply: { expectsReply: false },
          fromAgentId: "peer-1",
          senderTitle: null,
          senderHarnessId: null,
          epicId: "e1",
          prompt: eventId,
          enqueuedAt: 123,
          eventId,
        },
      });
    }
    await flush(0);
    await flush(0);

    expect(callHostRpcMock).toHaveBeenCalledTimes(1);
    expect(callHostRpcMock).toHaveBeenCalledWith("agent.inbox.ack", {
      epicId: "e1",
      agentId: "a1",
      eventIds: ["evt-4", "evt-5"],
    });

    stdoutSpy.mockRestore();
    void result;
  });

  it("retries a failed inbox acknowledgement without dropping its event ID", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((..._args: unknown[]) => {
        const cb = _args.find((arg) => typeof arg === "function") as
          (() => void) | undefined;
        cb?.();
        return true;
      });
    callHostRpcMock
      .mockRejectedValueOnce(new Error("temporary host outage"))
      .mockRejectedValueOnce(new Error("temporary host outage"))
      .mockResolvedValueOnce({});
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await flush(0);

    sessions[0].serverFrame?.({
      kind: "message",
      hasBinaryPayload: false,
      item: {
        reply: { expectsReply: false },
        fromAgentId: "peer-1",
        senderTitle: null,
        senderHarnessId: null,
        epicId: "e1",
        prompt: "retry me",
        enqueuedAt: 123,
        eventId: "evt-retry",
      },
    });
    await flush(0);
    await flush(0);

    expect(callHostRpcMock).toHaveBeenCalledTimes(1);
    expect(callHostRpcMock).toHaveBeenLastCalledWith("agent.inbox.ack", {
      epicId: "e1",
      agentId: "a1",
      eventIds: ["evt-retry"],
    });

    await flush(1_000);
    expect(callHostRpcMock).toHaveBeenCalledTimes(2);

    await flush(1_999);
    expect(callHostRpcMock).toHaveBeenCalledTimes(2);

    await flush(1);
    await flush(0);
    expect(callHostRpcMock).toHaveBeenCalledTimes(3);
    expect(callHostRpcMock).toHaveBeenLastCalledWith("agent.inbox.ack", {
      epicId: "e1",
      agentId: "a1",
      eventIds: ["evt-retry"],
    });

    stdoutSpy.mockRestore();
    void result;
  });

  it("does NOT ack a new-host (@1.2-negotiated) message frame when the stdout write errors", async () => {
    // The exact defect the amended go/no-go review found: an ack must never
    // fire for text that was never successfully written. Simulates a write
    // whose completion callback reports an error (e.g. EPIPE).
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((..._args: unknown[]) => {
        const cb = _args.find((arg) => typeof arg === "function") as
          ((error: Error) => void) | undefined;
        cb?.(new Error("EPIPE: broken pipe"));
        return true;
      });
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await flush(0);

    sessions[0].serverFrame?.({
      kind: "message",
      hasBinaryPayload: false,
      item: {
        reply: { expectsReply: false },
        fromAgentId: "peer-1",
        senderTitle: null,
        senderHarnessId: null,
        epicId: "e1",
        prompt: "hello into a broken pipe",
        enqueuedAt: 123,
        eventId: "evt-2",
      },
    });
    await flush(0);
    await flush(0);

    expect(callHostRpcMock).not.toHaveBeenCalledWith(
      "agent.inbox.ack",
      expect.anything(),
    );

    stdoutSpy.mockRestore();
    void result;
  });

  it("does NOT ack a new-host (@1.2-negotiated) message frame when the write never confirms (bounded timeout)", async () => {
    // The write's completion callback is captured but deliberately never
    // invoked - `writeStdoutForAck` must fall back to its own bounded
    // timeout and report failure, not treat non-completion as success.
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await flush(0);

    sessions[0].serverFrame?.({
      kind: "message",
      hasBinaryPayload: false,
      item: {
        reply: { expectsReply: false },
        fromAgentId: "peer-1",
        senderTitle: null,
        senderHarnessId: null,
        epicId: "e1",
        prompt: "hello into a stalled write",
        enqueuedAt: 123,
        eventId: "evt-3",
      },
    });
    await flush(0);
    expect(callHostRpcMock).not.toHaveBeenCalled();

    // Advance past `writeStdoutForAck`'s bounded fallback - it must resolve
    // `false` (not ack), never treat the still-incomplete write as success.
    await flush(10_000);

    expect(callHostRpcMock).not.toHaveBeenCalledWith(
      "agent.inbox.ack",
      expect.anything(),
    );

    stdoutSpy.mockRestore();
    void result;
  });

  it("acks when a stdout write confirms successfully after the bounded timeout", async () => {
    const writeCallbacks: Array<(error: Error | undefined) => void> = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((...args: unknown[]) => {
        const writeCallback = args.find(
          (arg): arg is (error: Error | undefined) => void =>
            typeof arg === "function",
        );
        if (writeCallback !== undefined) writeCallbacks.push(writeCallback);
        return true;
      });
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await flush(0);

    sessions[0].serverFrame?.({
      kind: "message",
      hasBinaryPayload: false,
      item: {
        reply: { expectsReply: false },
        fromAgentId: "peer-1",
        senderTitle: null,
        senderHarnessId: null,
        epicId: "e1",
        prompt: "slow but successful stdout",
        enqueuedAt: 123,
        eventId: "evt-late-write",
      },
    });
    await flush(10_000);
    expect(callHostRpcMock).not.toHaveBeenCalled();

    writeCallbacks[0]?.(undefined);
    await flush(0);
    await flush(0);

    expect(callHostRpcMock).toHaveBeenCalledWith("agent.inbox.ack", {
      epicId: "e1",
      agentId: "a1",
      eventIds: ["evt-late-write"],
    });

    stdoutSpy.mockRestore();
    void result;
  });
});
