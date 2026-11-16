import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenFrameBearerSource } from "../../../../shared/auth/bearer-source";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAgentSendCommand } from "../agent-send";
import { runMonitor as runMonitorCommand, type MonitorArgs } from "../monitor";
import { config } from "../../config";
import { cliCredentialsPath } from "@traycer/protocol/config/paths";
import { buildProgramWithAgentRoles } from "../../index";
import { resolveHostAuth } from "../../internal/host-auth";
import { readHostPidMetadata } from "../../host/pid-metadata";
import {
  callAgentHostRpcWithDispatch,
  callHostRpcWithAgentCredential,
} from "../../internal/host-rpc";
import { createOutput } from "../../runner/output";
import type { CommandContext } from "../../runner/runner";
import { resolveRuntimeContext } from "../../runner/runtime";
import {
  neuterActions,
  parseCommand,
  resolveCommandPath,
} from "./command-parse-harness";

// Drive the monitor's recovery state machine with a mocked WsStreamClient and a
// mocked revalidator: each `subscribe()` returns a fake session whose
// onStatusChange/onServerFrame handlers the test invokes to simulate host
// frames. Protocol/transport coverage lives in the shared ws-stream-client tests.
type FakeSession = {
  statusChange:
    | ((status: string, reason: unknown, retryCause: unknown) => void)
    | null;
  serverFrame: ((envelope: unknown) => void) | null;
  closed: boolean;
};

type CapturedStreamClientOptions = {
  readonly endpoint: () => unknown;
  readonly bearer: () => OpenFrameBearerSource | null;
  readonly hostCredentialMint: unknown;
};

const {
  subscribeMock,
  getMethodSchemaVersionMock,
  revalidateMock,
  disposeMock,
  fetchMock,
  testHome,
  sessions,
  streamClientOptions,
  agentEnvironment,
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
      onStatusChange(
        h: (status: string, reason: unknown, retryCause: unknown) => void,
      ) {
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
    fetchMock: vi.fn(),
    testHome: { path: null as string | null },
    sessions,
    streamClientOptions,
    agentEnvironment: {
      capability: undefined as string | undefined,
      agentId: undefined as string | undefined,
      names: [] as string[],
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => testHome.path ?? actual.homedir() };
});

vi.mock("../../internal/agent-session-capability", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../internal/agent-session-capability")
    >();
  return {
    ...actual,
    PROCESS_AGENT_ENVIRONMENT: (name: string) => {
      agentEnvironment.names.push(name);
      if (name === "TRAYCER_AGENT_SESSION_CAPABILITY")
        return agentEnvironment.capability;
      return name === "TRAYCER_AGENT_ID" ? agentEnvironment.agentId : undefined;
    },
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
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
  noopLogger: loggerMock,
  describeErrorOrigin: (error: Error) => error.name,
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
vi.mock("../../store/credentials-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials-store")>();
  return {
    ...actual,
    createCliCredentialsStore: vi.fn(() => ({ dispose: disposeMock })),
    createStoreBackedRevalidator: vi.fn(() => ({
      revalidateCurrentContext: revalidateMock,
    })),
  };
});

vi.mock("../../internal/host-auth", () => ({
  resolveHostAuth: vi.fn(),
}));

vi.mock("../../internal/host-rpc", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-rpc")>();
  return {
    ...actual,
    callAgentHostRpcWithDispatch: vi.fn(),
    callHostRpcWithAgentCredential: vi.fn(),
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
const callAgentHostRpcWithDispatchMock = vi.mocked(
  callAgentHostRpcWithDispatch,
);
const callHostRpcWithAgentCredentialMock = vi.mocked(
  callHostRpcWithAgentCredential,
);
const activeMonitorRuns = new Set<Promise<void>>();
let firstHostTokenFetchAt: number | null = null;

function runMonitor(args: MonitorArgs): Promise<void> {
  const pending = runMonitorCommand(args);
  const settled = pending.then(
    () => undefined,
    () => undefined,
  );
  activeMonitorRuns.add(settled);
  void settled.then(() => activeMonitorRuns.delete(settled));
  return pending;
}

function makeCommandContext(): CommandContext {
  const runtime = resolveRuntimeContext(
    {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
    },
    {},
  );
  const output = createOutput(runtime);
  return {
    runtime,
    output,
    progress: (info) => output.progress(info),
  };
}

function unauthorizedFatal() {
  return {
    kind: "fatalError" as const,
    details: {
      code: "UNAUTHORIZED" as const,
      reason: "invalid or expired token",
      incompatibleMethods: null,
      upgradeGuidance: null,
      doorReason: "token_expired",
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

async function waitForSessions(count: number): Promise<void> {
  await vi.waitFor(() => expect(sessions).toHaveLength(count), {
    timeout: 10_000,
  });
}

async function advanceFakeTime(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function expectAckCall(params: unknown): void {
  const calls = callHostRpcWithAgentCredentialMock.mock.calls.map(
    ([method, callParams]) => [method, callParams] as const,
  );
  expect(calls).toContainEqual(["agent.inbox.ack", params]);
}

function expectNoAckCall(): void {
  expect(
    callHostRpcWithAgentCredentialMock.mock.calls.some(
      ([method]) => method === "agent.inbox.ack",
    ),
  ).toBe(false);
}

beforeEach(async () => {
  testHome.path = await mkdtemp(join(tmpdir(), "traycer-cli-monitor-"));
  vi.useFakeTimers();
  sessions.length = 0;
  streamClientOptions.length = 0;
  agentEnvironment.capability = undefined;
  agentEnvironment.agentId = undefined;
  agentEnvironment.names.length = 0;
  subscribeMock.mockClear();
  revalidateMock.mockReset();
  disposeMock.mockClear();
  fetchMock.mockReset();
  firstHostTokenFetchAt = null;
  fetchMock.mockImplementation(async () => {
    if (firstHostTokenFetchAt === null)
      firstHostTokenFetchAt = performance.now();
    return new Response(
      JSON.stringify({
        session_grant: `monitor-host-token-${fetchMock.mock.calls.length}`,
        session_grant_expires_in: 3600,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  callAgentHostRpcWithDispatchMock.mockReset();
  callAgentHostRpcWithDispatchMock.mockResolvedValue({});
  callHostRpcWithAgentCredentialMock.mockReset();
  callHostRpcWithAgentCredentialMock.mockResolvedValue({});
  resolveAuthMock.mockResolvedValue({
    token: "tok-1",
    authnBaseUrl: "https://authn.test",
    userId: "u1",
  });
  resolveAuthMock.mockClear();
  pidMock.mockResolvedValue({
    pid: 1,
    hostId: "d1",
    version: "2.0.0",
    websocketUrl: "ws://127.0.0.1:9/rpc",
    startedAt: "2026-01-01T00:00:00.000Z",
    processStartIdentity: null,
    processStartIdentityRead: "absent",
    // Mirrors the real reader, which now always reports the host's Layer 0
    // verdict. `null` = this fixture's host recorded no attempt.
    layer0: null,
    layer0Slot: null,
  });
});

afterEach(async () => {
  const cleanupStartedAt = performance.now();
  const pendingAtCleanup = activeMonitorRuns.size;
  if (activeMonitorRuns.size > 0) {
    await vi.waitFor(
      () => {
        expect(sessions.length > 0 || activeMonitorRuns.size === 0).toBe(true);
      },
      { timeout: 10_000 },
    );
    for (const session of sessions) {
      session.statusChange?.("closed", incompatibleFatal(), null);
    }
    await Promise.all([...activeMonitorRuns]);
  }
  const lockPath = `${cliCredentialsPath(config.environment)}.lock`;
  const lockPresentAtCleanup = existsSync(lockPath);
  if (lockPresentAtCleanup) {
    await vi.waitFor(() => expect(existsSync(lockPath)).toBe(false), {
      timeout: 10_000,
    });
  }
  console.info(
    `[timing] monitor cleanup-at=${performance.now().toFixed(1)} elapsed=${(performance.now() - cleanupStartedAt).toFixed(1)}ms pending-at-entry=${pendingAtCleanup} token-lock-at-entry=${lockPresentAtCleanup}`,
  );
  vi.clearAllTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  const home = testHome.path;
  testHome.path = null;
  if (home !== null) await rm(home, { recursive: true, force: true });
}, 15_000);

describe("runMonitor recovery", () => {
  it("opens the inbox stream with the host-only token", async () => {
    const startedAt = performance.now();
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await waitForSessions(1);
    const options = streamClientOptions[0];
    expect(options).toBeDefined();
    if (options === undefined)
      throw new Error("stream options were not captured");
    expect(options.bearer()).toBeNull();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), {
      timeout: 10_000,
    });
    await vi.waitFor(
      () =>
        expect(options.bearer()?.getBearerToken()).toBe("monitor-host-token-1"),
      { timeout: 10_000 },
    );
    const fetchAt = firstHostTokenFetchAt;
    if (fetchAt === null) throw new Error("host-token fetch timestamp missing");
    console.info(
      `[timing] monitor token-ready-at=${performance.now().toFixed(1)} fetch-at=${fetchAt.toFixed(1)} elapsed-from-start=${(performance.now() - startedAt).toFixed(1)}ms`,
    );
    sessions[0]?.statusChange?.("closed", incompatibleFatal(), null);
    expect(await result).toMatchObject({
      message: "traycer monitor: host closed the stream: version mismatch",
    });
  }, 15_000);

  it("refuses an agent session without a capability before auth or stream creation", async () => {
    agentEnvironment.agentId = "agent-from-fake-environment";

    const error = await runMonitor({ agentId: "a1", epicId: "e1" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      message:
        "traycer monitor: not signed in — run `traycer login` to authenticate.",
    });
    expect(agentEnvironment.names).toEqual([
      "TRAYCER_AGENT_SESSION_CAPABILITY",
      "TRAYCER_AGENT_ID",
    ]);
    expect(resolveAuthMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pidMock).not.toHaveBeenCalled();
    expect(streamClientOptions).toHaveLength(0);
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it("keeps an accepted acknowledgement on the capability captured at monitor open", async () => {
    const openedCapability = "00000000-0000-4000-8000-000000000001";
    agentEnvironment.capability = openedCapability;
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
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch(
      (caught: unknown) => caught,
    );

    try {
      await waitForSessions(1);
      const options = streamClientOptions[0];
      if (options === undefined)
        throw new Error("stream options were not captured");
      expect(options.bearer()?.getBearerToken()).toBe(openedCapability);
      expect(options.hostCredentialMint).toBeNull();
      expect(resolveAuthMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      sessions[0]?.serverFrame?.({
        kind: "message",
        hasBinaryPayload: false,
        item: {
          reply: { expectsReply: false },
          fromAgentId: "peer-1",
          senderTitle: null,
          senderHarnessId: null,
          epicId: "e1",
          prompt: "accepted before the next generation",
          enqueuedAt: 123,
          eventId: "evt-captured-generation",
        },
      });
      await vi.waitFor(() => expect(writeCallbacks).toHaveLength(1));

      agentEnvironment.capability = "00000000-0000-4000-8000-000000000002";
      writeCallbacks[0]?.(undefined);
      await vi.waitFor(() =>
        expect(callHostRpcWithAgentCredentialMock).toHaveBeenCalledTimes(1),
      );

      expectAckCall({
        epicId: "e1",
        agentId: "a1",
        eventIds: ["evt-captured-generation"],
      });
      const credential = callHostRpcWithAgentCredentialMock.mock.calls[0]?.[2];
      if (credential?.kind !== "capability")
        throw new Error("acknowledgement did not use the captured capability");
      expect(credential.capability.bearer.getBearerToken()).toBe(
        openedCapability,
      );
      expect(agentEnvironment.names).toEqual([
        "TRAYCER_AGENT_SESSION_CAPABILITY",
      ]);
      expect(resolveAuthMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(revalidateMock).not.toHaveBeenCalled();

      sessions[0]?.statusChange?.("closed", incompatibleFatal(), null);
      expect(await result).toMatchObject({
        message: "traycer monitor: host closed the stream: version mismatch",
      });
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("ends a capability refusal without sign-in recovery or a fresh subscription", async () => {
    agentEnvironment.capability = "00000000-0000-4000-8000-000000000004";
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch(
      (caught: unknown) => caught,
    );
    await waitForSessions(1);

    sessions[0]?.statusChange?.(
      "closed",
      {
        kind: "fatalError",
        details: {
          code: "UNAUTHORIZED",
          reason: "agent session not admitted",
          incompatibleMethods: null,
          upgradeGuidance: null,
          doorReason: "not_admitted",
        },
      },
      null,
    );

    expect(await result).toMatchObject({
      message:
        "traycer monitor: host closed the stream: agent session not admitted",
    });
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(sessions).toHaveLength(1);
    expect(agentEnvironment.names).toEqual([
      "TRAYCER_AGENT_SESSION_CAPABILITY",
    ]);
    expect(resolveAuthMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
    expect(callHostRpcWithAgentCredentialMock).not.toHaveBeenCalled();
  });

  it("ends on a reconnecting retry cause without renewing or rebinding its capability", async () => {
    agentEnvironment.capability = "00000000-0000-4000-8000-000000000003";
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch(
      (caught: unknown) => caught,
    );
    await waitForSessions(1);

    sessions[0]?.statusChange?.("reconnecting", null, {
      code: "STREAM_SUBSCRIBE_TIMEOUT",
      reason: "stream subscribe timed out",
      incompatibleMethods: null,
      upgradeGuidance: null,
      retryable: true,
    });

    expect(await result).toMatchObject({
      message:
        "traycer monitor: host closed the stream: stream subscribe timed out",
    });
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(sessions).toHaveLength(1);
    expect(streamClientOptions).toHaveLength(1);
    expect(agentEnvironment.names).toEqual([
      "TRAYCER_AGENT_SESSION_CAPABILITY",
    ]);
    expect(resolveAuthMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
    expect(callHostRpcWithAgentCredentialMock).not.toHaveBeenCalled();
  });

  it("ends with the team-membership line when authn refuses its first host-token mint", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: "team_membership_required" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch(
      (error: unknown) => error,
    );
    await waitForSessions(1);
    const options = streamClientOptions[0];
    if (options === undefined)
      throw new Error("stream options were not captured");
    expect(options.bearer()).toBeNull();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const error = await result;
    expect(error).toMatchObject({
      message:
        "traycer: This computer belongs to a team. This account is not a member. Switch accounts to use Traycer here. Run `traycer login` to switch accounts.",
    });
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(sessions).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the stream alive when authn cannot be reached for a host-token mint", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch(
      (error: unknown) => error,
    );
    await waitForSessions(1);
    const options = streamClientOptions[0];
    if (options === undefined)
      throw new Error("stream options were not captured");
    options.bearer();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    sessions[0]?.statusChange?.("closed", incompatibleFatal(), null);

    const error = await result;
    expect(error).toMatchObject({
      message: "traycer monitor: host closed the stream: version mismatch",
    });
    expect(subscribeMock).toHaveBeenCalledTimes(1);
  });

  it("prints sign-in advice only when authn also refuses the sign-in refresh", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    revalidateMock.mockResolvedValue("rejected");
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await waitForSessions(1);

    sessions[0].statusChange?.("closed", unauthorizedFatal(), null);

    expect((await result).message).toBe(
      "The stored credential was rejected. Run `traycer login` to re-authenticate.",
    );
    expect(revalidateMock).toHaveBeenCalledTimes(1);
  });

  it.each(["UNAUTHORIZED", "TEAM_MEMBERSHIP_REQUIRED"] as const)(
    "prints the older-host upgrade line for a reasonless %s refusal",
    async (code) => {
      const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch(
        (e) => e,
      );
      await waitForSessions(1);
      sessions[0].statusChange?.(
        "closed",
        {
          kind: "fatalError",
          details: {
            code,
            reason: "legacy host refusal",
            incompatibleMethods: null,
            upgradeGuidance: null,
            retryable: false,
          },
        },
        null,
      );
      expect((await result).message).toBe(
        "The host is out of date. Reinstall the latest host with 'traycer host update'.",
      );
    },
  );

  it("terminates immediately on a non-auth fatal (INCOMPATIBLE) without refreshing", async () => {
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await waitForSessions(1);

    sessions[0].statusChange?.("closed", incompatibleFatal(), null);

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
      processStartIdentityRead: "absent",
      layer0: null,
      layer0Slot: null,
    });

    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await waitForSessions(1);

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
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await waitForSessions(1);

    sessions[0].statusChange?.("closed", unauthorizedFatal(), null);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // No immediate re-subscribe and not terminated - a retry is scheduled.
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(revalidateMock).not.toHaveBeenCalled();

    await advanceFakeTime(5_000);
    await waitForSessions(2);
    void result;
  });

  it("ends after a fresh host token is refused again as expired", async () => {
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await waitForSessions(1);
    const options = streamClientOptions[0];
    if (options === undefined)
      throw new Error("stream options were not captured");
    expect(options.bearer()).toBeNull();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(options.bearer()?.getBearerToken()).toBe("monitor-host-token-1"),
    );

    sessions[0]?.statusChange?.("closed", unauthorizedFatal(), null);
    await waitForSessions(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sessions[0]?.closed).toBe(true);
    sessions[1]?.statusChange?.("closed", unauthorizedFatal(), null);

    expect((await result).message).toBe(
      "traycer monitor: host closed the stream: invalid or expired token",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(subscribeMock).toHaveBeenCalledTimes(2);
  });
});

describe("role awareness frames (negotiated @1.1)", () => {
  it("prints one compact [traycer roles] line per event, for both claim and relinquish", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await waitForSessions(1);

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
    await waitForSessions(1);

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
    await waitForSessions(1);

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

  it("names a user-stopped inactivity notice without attributing the stop to the user", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await waitForSessions(1);

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
        reason: "user-stopped",
        detail: null,
        droppedReceivers: null,
        stopInitiator: null,
        noticedAt: 123,
      },
    });

    const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("was stopped before it could reply");
    expect(output).not.toContain("stopped by the user");

    stdoutSpy.mockRestore();
    void result;
  });

  it("keeps human-initiated stops attributed to the user", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await waitForSessions(1);

    emitCancelledNotice({ type: "user" });

    const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("was stopped by the user");
    expect(output).not.toContain("traycer agent send --to");

    stdoutSpy.mockRestore();
    void result;
  });
});

describe("follow-up inactivity notices (negotiated @1.3)", () => {
  const nonCancellationReasons = [
    { reason: "turn-ended", detail: null },
    { reason: "exited", detail: null },
    { reason: "quiet", detail: null },
    { reason: "user-stopped", detail: null },
    { reason: "errored", detail: "rate limited" },
  ] as const;
  const commandProgram = buildProgramWithAgentRoles(false);
  neuterActions(commandProgram);
  commandProgram.exitOverride();
  commandProgram.configureOutput({
    writeErr: () => undefined,
    writeOut: () => undefined,
  });

  it.each(nonCancellationReasons)(
    "emits a runnable expected-reply command for $reason",
    async ({ reason, detail }) => {
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch(
        (e) => e,
      );
      try {
        await waitForSessions(1);

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
            reason,
            detail,
            droppedReceivers: null,
            stopInitiator: null,
            noticedAt: 123,
          },
        });

        const output = stdoutSpy.mock.calls
          .map((call) => String(call[0]))
          .join("");
        const sendLine = output
          .split("\n")
          .find((line) => line.includes("traycer agent send --to"));
        expect(sendLine).toBeDefined();
        if (sendLine === undefined) {
          throw new Error("expected inactivity notice follow-up command");
        }
        const commandMatch =
          /^\[traycer inbox\] the request is still open; a follow-up can be sent with: traycer agent send --to ([^\s]+)( --expect-reply)? --message "([^"]+)"(?: --response-id ([^\s]+))?$/.exec(
            sendLine,
          );
        expect(commandMatch).not.toBeNull();
        if (commandMatch === null) {
          throw new Error("expected parseable inactivity follow-up command");
        }
        const receiverId = commandMatch[1];
        const expectReply = commandMatch[2] === " --expect-reply";
        const prompt = commandMatch[3];
        const responseId = commandMatch[4] ?? null;
        if (receiverId === undefined || prompt === undefined) {
          throw new Error(
            "inactivity follow-up command was missing an argument",
          );
        }
        expect(receiverId).toBe("receiver-1");
        expect(expectReply).toBe(true);
        expect(responseId).toBeNull();
        expect(sendLine).not.toContain("--response-id");

        const commandStart = sendLine.indexOf("traycer agent send ");
        expect(commandStart).toBeGreaterThanOrEqual(0);
        const emittedCommand = sendLine.slice(commandStart);
        const commandArgv = (emittedCommand.match(/"[^"]*"|\S+/g) ?? []).map(
          (token) =>
            token.startsWith('"') && token.endsWith('"')
              ? token.slice(1, -1)
              : token,
        );
        const commandTokens = commandArgv.slice(1);
        const commandPath = resolveCommandPath(commandProgram, commandTokens);
        expect(commandPath.map((command) => command.name())).toEqual([
          "traycer",
          "agent",
          "send",
        ]);
        const send = commandPath[commandPath.length - 1];
        if (send === undefined) {
          throw new Error("agent send command was not registered");
        }
        const parsed = await parseCommand(commandProgram, commandTokens, {
          strict: true,
        });
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
          throw new Error("emitted inactivity follow-up command did not parse");
        }
        const selected = send.opts<Record<string, unknown>>();
        expect({
          args: send.args,
          to: selected.to,
          message: selected.message,
          expectReply: selected.expectReply,
          responseId: selected.responseId,
        }).toEqual({
          args: [],
          to: "receiver-1",
          message: "<follow-up>",
          expectReply: true,
          responseId: undefined,
        });

        const selectedTo = selected.to;
        const selectedMessage = selected.message;
        const selectedExpectReply = selected.expectReply;
        const selectedResponseId = selected.responseId;
        if (
          typeof selectedTo !== "string" ||
          typeof selectedMessage !== "string" ||
          typeof selectedExpectReply !== "boolean" ||
          (selectedResponseId !== undefined &&
            typeof selectedResponseId !== "string")
        ) {
          throw new Error("parsed agent send options had unexpected types");
        }
        const returnedResponseId = "response-follow-up";
        callAgentHostRpcWithDispatchMock.mockResolvedValue({
          responseId: returnedResponseId,
        });
        const command = buildAgentSendCommand({
          epicId: "e1",
          senderAgentId: "a1",
          to: selectedTo,
          message: selectedMessage,
          expectReply: selectedExpectReply,
          responseId: selectedResponseId ?? null,
          workspace: null,
        });
        const commandResult = await command(makeCommandContext());

        expect(commandResult.data).toEqual({
          responseId: returnedResponseId,
        });
        expect(commandResult.human).toContain(
          `responseId: ${returnedResponseId}`,
        );
        // The dispatch is asserted with the request, not beside it: the
        // receiving agent's chat session has to be opened before the host
        // answers, and the transport's 15s default expires mid-open on a
        // loaded machine. A send that lost its own response deadline would
        // report a failure for a message the host went on to deliver.
        expect(callAgentHostRpcWithDispatchMock).toHaveBeenCalledWith(
          "agent.sendMessage",
          expect.objectContaining({
            senderAgentId: "a1",
            epicId: "e1",
            receiverAgentId: "receiver-1",
            prompt: "<follow-up>",
            expectReply: true,
            responseId: null,
            workspace: null,
          }),
          {
            responseTimeoutMs: 60_000,
            requiredHostMethodVersion: null,
            signal: null,
            failFast: false,
            reauthenticate: "always",
            idempotencyKey: null,
          },
        );
        expect(output).toContain("omit --response-id for this follow-up");
        expect(output).toContain(
          "Repeated --expect-reply sends from you to the same recipient reuse its still-open thread",
        );
      } finally {
        stdoutSpy.mockRestore();
        void result;
      }
    },
  );

  it("keeps awaiting-input informational while the human gate is active", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    try {
      await waitForSessions(1);

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
          reason: "awaiting-input",
          detail: "needs approval",
          droppedReceivers: null,
          stopInitiator: null,
          noticedAt: 123,
        },
      });

      const output = stdoutSpy.mock.calls
        .map((call) => String(call[0]))
        .join("");
      expect(output).toContain(
        "is blocked waiting on a human — it needs approval — and will not reply until someone responds",
      );
      expect(output).toContain(
        "Sending a follow-up now would queue behind the user's input and re-trigger this notice",
      );
      expect(output).toContain(
        "Wait for the receiver's reply or the user's answer to wake you",
      );
      expect(output).toContain(
        "If you are working for another agent, tell it you're blocked",
      );
      expect(output).toContain(
        "Omit --response-id for your own follow-ups; the displayed responseId is not an incoming reply ID",
      );
      expect(output).toContain(
        "traycer agent transcript --agent-id receiver-1",
      );
      expect(output).not.toContain("traycer agent send");
    } finally {
      stdoutSpy.mockRestore();
      void result;
    }
  });
});

describe("mixed-version inbox message frames", () => {
  it("parses and prints an old-host (@1.0-negotiated) message frame with no eventId, and never calls agent.inbox.ack for it", async () => {
    getMethodSchemaVersionMock.mockReturnValueOnce({ major: 1, minor: 0 });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await waitForSessions(1);

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
    await vi.waitFor(() => expect(stdoutSpy).toHaveBeenCalled());

    const lines = stdoutSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("hello from an old host"))).toBe(
      true,
    );
    expectNoAckCall();

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
          | (() => void)
          | undefined;
        cb?.();
        return true;
      });
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await waitForSessions(1);

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
    await vi.waitFor(() =>
      expectAckCall({
        epicId: "e1",
        agentId: "a1",
        eventIds: ["evt-1"],
      }),
    );

    const lines = stdoutSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("hello from a new host"))).toBe(
      true,
    );
    expectAckCall({
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
          | (() => void)
          | undefined;
        cb?.();
        return true;
      });
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await waitForSessions(1);

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
    await vi.waitFor(() =>
      expectAckCall({
        epicId: "e1",
        agentId: "a1",
        eventIds: ["evt-4", "evt-5"],
      }),
    );

    expect(callHostRpcWithAgentCredentialMock).toHaveBeenCalledTimes(1);
    expectAckCall({
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
          | (() => void)
          | undefined;
        cb?.();
        return true;
      });
    callHostRpcWithAgentCredentialMock
      .mockRejectedValueOnce(new Error("temporary host outage"))
      .mockRejectedValueOnce(new Error("temporary host outage"))
      .mockResolvedValueOnce({});
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await waitForSessions(1);

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
    await vi.waitFor(() =>
      expect(callHostRpcWithAgentCredentialMock).toHaveBeenCalledTimes(1),
    );

    expect(callHostRpcWithAgentCredentialMock).toHaveBeenCalledTimes(1);
    expectAckCall({
      epicId: "e1",
      agentId: "a1",
      eventIds: ["evt-retry"],
    });

    await advanceFakeTime(1_000);
    await vi.waitFor(() =>
      expect(callHostRpcWithAgentCredentialMock).toHaveBeenCalledTimes(2),
    );

    await advanceFakeTime(1_999);

    await advanceFakeTime(1);
    await vi.waitFor(() =>
      expect(callHostRpcWithAgentCredentialMock).toHaveBeenCalledTimes(3),
    );
    expectAckCall({
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
          | ((error: Error) => void)
          | undefined;
        cb?.(new Error("EPIPE: broken pipe"));
        return true;
      });
    const result = runMonitor({ agentId: "a1", epicId: "e1" }).catch((e) => e);
    await waitForSessions(1);

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
    await vi.waitFor(() => {
      expect(stdoutSpy).toHaveBeenCalledTimes(1);
      expectNoAckCall();
    });

    expectNoAckCall();

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
    await waitForSessions(1);

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
    await vi.waitFor(() => expect(stdoutSpy).toHaveBeenCalledTimes(1));
    expect(callHostRpcWithAgentCredentialMock).not.toHaveBeenCalled();

    // Advance past `writeStdoutForAck`'s bounded fallback - it must resolve
    // `false` (not ack), never treat the still-incomplete write as success.
    await advanceFakeTime(10_000);

    expectNoAckCall();

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
    await waitForSessions(1);

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
    await vi.waitFor(() => expect(writeCallbacks).toHaveLength(1));
    await advanceFakeTime(10_000);
    expect(callHostRpcWithAgentCredentialMock).not.toHaveBeenCalled();

    writeCallbacks[0]?.(undefined);
    await vi.waitFor(() =>
      expectAckCall({
        epicId: "e1",
        agentId: "a1",
        eventIds: ["evt-late-write"],
      }),
    );

    stdoutSpy.mockRestore();
    void result;
  });
});
