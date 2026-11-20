import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostTokenTable } from "../../../../shared/auth/host-token-store";
import { runMonitor } from "../monitor";
import { resolveHostAuth } from "../../internal/host-auth";
import { readHostPidMetadata } from "../../host/pid-metadata";
import { CLI_ERROR_CODES } from "../../runner/errors";

type FakeSession = {
  statusChange: ((status: string, reason: unknown) => void) | null;
  closed: boolean;
};
type SchedulerOptions = { readonly revalidate: () => Promise<unknown> };
type StreamOptions = {
  readonly bearer: () => { getBearerToken: () => string } | null;
  readonly door: { admitted: () => void };
};

const state = vi.hoisted(() => {
  const sessions: FakeSession[] = [];
  const streamOptions: StreamOptions[] = [];
  const schedulerOptions: SchedulerOptions[] = [];
  const minted: Array<unknown> = [];
  let table: HostTokenTable = new Map();
  let rejectPersistence = false;
  const subscribe = vi.fn(() => {
    const session: FakeSession = { statusChange: null, closed: false };
    sessions.push(session);
    return {
      onStatusChange(handler: (status: string, reason: unknown) => void) {
        session.statusChange = handler;
      },
      onServerFrame() {},
      close() {
        session.closed = true;
      },
    };
  });
  const mint = vi.fn(async () => {
    const outcome = minted.shift();
    if (outcome === undefined) {
      return {
        kind: "ok" as const,
        token: {
          token: `host-${mint.mock.calls.length}`,
          expiresAtMs: Date.now() + 3_600_000,
        },
      };
    }
    return outcome;
  });
  const revalidate = vi.fn();
  const notifyBearerRotated = vi.fn();
  return {
    sessions,
    streamOptions,
    schedulerOptions,
    minted,
    subscribe,
    mint,
    revalidate,
    notifyBearerRotated,
    get table() {
      return table;
    },
    set table(value: HostTokenTable) {
      table = value;
    },
    get rejectPersistence() {
      return rejectPersistence;
    },
    set rejectPersistence(value: boolean) {
      rejectPersistence = value;
    },
  };
});

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../../../shared/host-transport/ws-stream-client", () => ({
  WsStreamClient: class {
    constructor(options: StreamOptions) {
      state.streamOptions.push(options);
    }
    subscribe = state.subscribe;
    getMethodSchemaVersion = vi.fn(() => ({ major: 1, minor: 3 }));
    notifyBearerRotated = state.notifyBearerRotated;
    close = vi.fn();
  },
}));

vi.mock(
  "../../../../shared/auth/token-refresh-scheduler",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../shared/auth/token-refresh-scheduler")
      >();
    return {
      ...actual,
      createProactiveRefreshScheduler: (options: SchedulerOptions) => {
        state.schedulerOptions.push(options);
        return { start: vi.fn(), stop: vi.fn(), notifyResumed: vi.fn() };
      },
    };
  },
);

vi.mock("@traycer-clients/shared/auth/host-token-file", () => ({
  createHostTokenFilePersistence: () => ({
    load: async () => state.table,
    update: async (change: (table: HostTokenTable) => HostTokenTable) => {
      if (state.rejectPersistence)
        throw new Error("simulated token persistence failure");
      state.table = change(state.table);
      return state.table;
    },
  }),
}));

vi.mock("@traycer-clients/shared/host-transport/remote/grant-client", () => ({
  mintHostTokenViaHttp: state.mint,
}));

vi.mock("../../logger", () => ({
  createCliLogger: () => logger,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
  noopLogger: logger,
  describeErrorOrigin: (error: Error) => error.name,
}));

vi.mock("../../store/credentials-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials-store")>();
  return {
    ...actual,
    createCliCredentialsStore: vi.fn(() => ({ dispose: vi.fn() })),
    createStoreBackedRevalidator: vi.fn(() => ({
      revalidateCurrentContext: state.revalidate,
    })),
  };
});

vi.mock("../../internal/host-auth", () => ({ resolveHostAuth: vi.fn() }));
vi.mock("../../host/pid-metadata", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/pid-metadata")>();
  return { ...actual, readHostPidMetadata: vi.fn() };
});

const resolveAuthMock = vi.mocked(resolveHostAuth);
const pidMock = vi.mocked(readHostPidMetadata);

function unauthorizedFatal(doorReason: "token_expired" | "not_admitted") {
  return {
    kind: "fatalError" as const,
    details: {
      code: "UNAUTHORIZED" as const,
      reason: "expired",
      incompatibleMethods: null,
      upgradeGuidance: null,
      doorReason,
    },
  };
}

async function startMonitor() {
  const result = runMonitor({ agentId: "agent-1", epicId: "epic-1" }).then(
    () => ({ error: null }),
    (error: unknown) => ({ error }),
  );
  await vi.waitFor(() => expect(state.sessions).toHaveLength(1));
  const options = state.streamOptions[0];
  if (options === undefined)
    throw new Error("stream client options were not captured");
  return { result, options };
}

async function waitForMintCount(count: number) {
  await vi.waitFor(() => expect(state.mint).toHaveBeenCalledTimes(count));
}

beforeEach(() => {
  vi.useFakeTimers();
  state.sessions.length = 0;
  state.streamOptions.length = 0;
  state.schedulerOptions.length = 0;
  state.minted.length = 0;
  state.table = new Map();
  state.rejectPersistence = false;
  state.subscribe.mockClear();
  state.mint.mockClear();
  state.revalidate.mockReset();
  state.notifyBearerRotated.mockClear();
  resolveAuthMock.mockResolvedValue({
    token: "signin",
    authnBaseUrl: "https://authn.test",
    userId: "user-1",
  });
  pidMock.mockResolvedValue({
    pid: 1,
    hostId: "host-1",
    version: "1.0.0",
    websocketUrl: "ws://127.0.0.1:9/rpc",
    startedAt: "2026-01-01T00:00:00.000Z",
    processStartIdentity: null,
    processStartIdentityRead: "absent",
    layer0: null,
    layer0Slot: null,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("runMonitor host-token renewal", () => {
  it("reports a rejected sign-in when the proactive post-refresh mint answers 401 and does not push a bearer", async () => {
    state.revalidate.mockResolvedValue("rotated");
    state.minted.push({ kind: "sign-in-rejected" });
    const { result } = await startMonitor();
    const scheduler = state.schedulerOptions[0];
    if (scheduler === undefined)
      throw new Error("scheduler options were not captured");

    await scheduler.revalidate();

    const settled = await result;
    expect(settled.error).toMatchObject({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message:
        "The stored credential was rejected. Run `traycer login` to re-authenticate.",
      exitCode: 1,
    });
    expect(state.notifyBearerRotated).not.toHaveBeenCalled();
  });

  it("keeps the monitor running without reporting or pushing when proactive renewal cannot reach authn", async () => {
    state.revalidate.mockResolvedValue("rotated");
    state.minted.push({ kind: "unavailable", detail: "network" });
    const { result } = await startMonitor();
    const scheduler = state.schedulerOptions[0];
    if (scheduler === undefined)
      throw new Error("scheduler options were not captured");

    await scheduler.revalidate();

    expect(await Promise.race([result, Promise.resolve("running")])).toBe(
      "running",
    );
    expect(state.notifyBearerRotated).not.toHaveBeenCalled();
  });

  it("pushes the bearer after a successful proactive renewal", async () => {
    state.revalidate.mockResolvedValue("rotated");
    const { result } = await startMonitor();
    const scheduler = state.schedulerOptions[0];
    if (scheduler === undefined)
      throw new Error("scheduler options were not captured");

    await scheduler.revalidate();

    expect(state.notifyBearerRotated).toHaveBeenCalledTimes(1);
    expect(await Promise.race([result, Promise.resolve("running")])).toBe(
      "running",
    );
  });

  it("treats a rejected persistence write during proactive renewal as transient", async () => {
    state.revalidate.mockResolvedValue("rotated");
    state.rejectPersistence = true;
    const { result } = await startMonitor();
    const scheduler = state.schedulerOptions[0];
    if (scheduler === undefined)
      throw new Error("scheduler options were not captured");

    await expect(scheduler.revalidate()).resolves.toBe("rotated");

    expect(state.notifyBearerRotated).not.toHaveBeenCalled();
    expect(await Promise.race([result, Promise.resolve("running")])).toBe(
      "running",
    );
  });

  it("retries after a rejected persistence write during reactive token recovery", async () => {
    state.rejectPersistence = true;
    const { result, options } = await startMonitor();
    options.bearer();
    await waitForMintCount(1);
    state.rejectPersistence = false;
    state.sessions[0]?.statusChange?.(
      "closed",
      unauthorizedFatal("not_admitted"),
    );
    state.rejectPersistence = true;
    await waitForMintCount(2);

    expect(await Promise.race([result, Promise.resolve("running")])).toBe(
      "running",
    );
    expect(state.notifyBearerRotated).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(state.sessions).toHaveLength(2));
    expect(await Promise.race([result, Promise.resolve("running")])).toBe(
      "running",
    );
  });

  it.each([
    ["not-admitted", { kind: "not-admitted" }, CLI_ERROR_CODES.FORBIDDEN],
    [
      "sandbox-frozen",
      { kind: "sandbox-frozen" },
      CLI_ERROR_CODES.HOST_UNREACHABLE,
    ],
  ] as const)(
    "ends on initial %s refusal with the ruled empty message",
    async (_name, failure, code) => {
      state.minted.push(failure);
      const { result, options } = await startMonitor();
      options.bearer();
      await waitForMintCount(1);

      expect(await result).toMatchObject({
        error: { code, message: "", exitCode: 1 },
      });
    },
  );

  it("ends on an initial mint rejected after an accepted sign-in refresh", async () => {
    state.minted.push(
      { kind: "sign-in-rejected" },
      { kind: "sign-in-rejected" },
    );
    state.revalidate.mockResolvedValue("rotated");
    const { result, options } = await startMonitor();
    options.bearer();
    await waitForMintCount(2);

    expect(await result).toMatchObject({
      error: {
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message:
          "The stored credential was rejected. Run `traycer login` to re-authenticate.",
        exitCode: 1,
      },
    });
  });

  it("ends on a not-admitted recovery mint refusal without sign-in advice", async () => {
    state.minted.push(
      {
        kind: "ok",
        token: { token: "host-1", expiresAtMs: Date.now() + 60_000 },
      },
      { kind: "not-admitted" },
    );
    const { result, options } = await startMonitor();
    options.bearer();
    await waitForMintCount(1);
    state.sessions[0]?.statusChange?.(
      "closed",
      unauthorizedFatal("not_admitted"),
    );
    await waitForMintCount(2);

    expect(await result).toMatchObject({
      error: { code: CLI_ERROR_CODES.FORBIDDEN, message: "", exitCode: 1 },
    });
  });

  it("earns another fresh token after an admitted open resets recovery", async () => {
    const { result, options } = await startMonitor();
    options.bearer();
    await waitForMintCount(1);
    state.sessions[0]?.statusChange?.(
      "closed",
      unauthorizedFatal("token_expired"),
    );
    await waitForMintCount(2);
    await vi.waitFor(() => expect(state.sessions).toHaveLength(2));

    options.door.admitted();
    state.sessions[1]?.statusChange?.(
      "closed",
      unauthorizedFatal("token_expired"),
    );
    await waitForMintCount(3);
    await vi.waitFor(() => expect(state.sessions).toHaveLength(3));

    expect(await Promise.race([result, Promise.resolve("running")])).toBe(
      "running",
    );
    expect(state.mint).toHaveBeenCalledTimes(3);
  });
});
