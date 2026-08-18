import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorktreeDeleteCommand } from "../worktree-delete";
import { CliError, CLI_ERROR_CODES } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";
import type { ProgressInfo } from "../../runner/output";
import type { StreamCloseReason } from "../../../../shared/host-transport/i-stream-session";
import type { StreamMethodSupport } from "../../../../shared/host-transport/ws-stream-client";
import { resolveHostAuth } from "../../internal/host-auth";
import { resolveEndpoint } from "../../internal/host-rpc";

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../logger", () => ({
  createCliLogger: () => loggerMock,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
  noopLogger: loggerMock,
}));

type FakeSession = {
  readonly method: string;
  readonly params: unknown;
  statusHandler:
    ((status: string, reason: StreamCloseReason | null) => void) | null;
  frameHandler: ((envelope: unknown) => void) | null;
};

// Shared, hoisted so the module mock factory can reference them.
const hoisted = vi.hoisted(() => ({
  subscribeMock: vi.fn(),
  clientCloseMock: vi.fn(),
  sessionCloseMock: vi.fn(),
  state: {
    sessions: [] as FakeSession[],
    // What the transport's compatibility check would say about the batch
    // method. Flipped per test to simulate an older host.
    methodSupport: "supported" as StreamMethodSupport,
  },
}));

vi.mock("../../../../shared/host-transport/ws-stream-client", () => ({
  // A real function (not an arrow) so `new WsStreamClient(...)` constructs; a
  // constructor returning an object yields that object.
  WsStreamClient: vi.fn(function WsStreamClientMock() {
    return {
      subscribe: hoisted.subscribeMock,
      close: hoisted.clientCloseMock,
      isClosed: () => false,
      notifyBearerRotated: () => undefined,
      reconnectAll: () => undefined,
      getMethodSupport: () => hoisted.state.methodSupport,
    };
  }),
}));

vi.mock("../../internal/host-auth", () => ({
  resolveHostAuth: vi.fn(),
}));

vi.mock("../../internal/host-rpc", async () => {
  const actual = await vi.importActual<
    typeof import("../../internal/host-rpc")
  >("../../internal/host-rpc");
  return { ...actual, resolveEndpoint: vi.fn() };
});

const resolveHostAuthMock = vi.mocked(resolveHostAuth);
const resolveEndpointMock = vi.mocked(resolveEndpoint);

const ctx = {} as CommandContext;

/**
 * A JSON-mode context, so relayed lifecycle/output lines land on the NDJSON
 * `progress` channel where a test can read them instead of on stderr.
 */
function jsonCtx(recorded: ProgressInfo[]): CommandContext {
  const noop = (): void => undefined;
  return {
    runtime: {
      json: true,
      quiet: false,
      noProgress: false,
      noBootstrap: true,
      nonInteractive: true,
      environment: "production",
      logger: loggerMock,
    },
    output: {
      progress: noop,
      human: noop,
      humanRequired: noop,
      emitResult: noop,
      emitError: noop,
    },
    progress: (info: ProgressInfo) => recorded.push(info),
  };
}

/** The `start`-mode batch session, i.e. the first subscribe of a run. */
function commandSession(): FakeSession {
  const session = hoisted.state.sessions[0];
  if (session === undefined) throw new Error("no command session opened");
  return session;
}

async function waitForSessions(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(hoisted.state.sessions.length).toBeGreaterThanOrEqual(count);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.state.sessions = [];
  hoisted.state.methodSupport = "supported";
  resolveHostAuthMock.mockResolvedValue({
    token: "token",
    userId: "user",
    authnBaseUrl: "https://authn.example",
  });
  resolveEndpointMock.mockResolvedValue({
    hostId: "host-1",
    websocketUrl: "ws://127.0.0.1:9999/rpc",
  });
  hoisted.subscribeMock.mockImplementation(
    (method: string, params: unknown) => {
      const session: FakeSession = {
        method,
        params,
        statusHandler: null,
        frameHandler: null,
      };
      hoisted.state.sessions.push(session);
      return {
        onServerFrame: (handler: (envelope: unknown) => void) => {
          session.frameHandler = handler;
        },
        onStatusChange: (
          handler: (status: string, reason: StreamCloseReason | null) => void,
        ) => {
          session.statusHandler = handler;
        },
        sendClientFrame: () => undefined,
        close: hoisted.sessionCloseMock,
      };
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildWorktreeDeleteCommand readonly guard", () => {
  it("refuses in the readonly surface before any auth/endpoint/stream work", async () => {
    await expect(
      buildWorktreeDeleteCommand({
        worktreePath: "/wt/x",
        readonlySurface: true,
      })(ctx),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.FORBIDDEN });

    expect(resolveHostAuthMock).not.toHaveBeenCalled();
    expect(resolveEndpointMock).not.toHaveBeenCalled();
    expect(hoisted.subscribeMock).not.toHaveBeenCalled();
  });
});

describe("buildWorktreeDeleteCommand input validation", () => {
  it("rejects an empty --path before any network call", async () => {
    await expect(
      buildWorktreeDeleteCommand({
        worktreePath: "   ",
        readonlySurface: false,
      })(ctx),
    ).rejects.toBeInstanceOf(CliError);
    await expect(
      buildWorktreeDeleteCommand({
        worktreePath: "",
        readonlySurface: false,
      })(ctx),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });

    expect(resolveHostAuthMock).not.toHaveBeenCalled();
    expect(resolveEndpointMock).not.toHaveBeenCalled();
  });
});

describe("buildWorktreeDeleteCommand command shape", () => {
  it("opens ONE start-mode command carrying a uuid and the single target", async () => {
    const pending = buildWorktreeDeleteCommand({
      worktreePath: "/wt/x",
      readonlySurface: false,
    })(ctx);

    await waitForSessions(1);
    const session = commandSession();
    expect(session.method).toBe("worktree.deleteBatchByPath");
    expect(session.params).toMatchObject({
      mode: "start",
      source: "cli",
      targets: [{ worktreePath: "/wt/x", scripts: null }],
    });
    // A validated UUID, minted once per invocation - the host rejects an open
    // string, and a shared constant would collapse distinct commands onto one
    // single-flight entry.
    expect(
      (session.params as { readonly commandId: string }).commandId,
    ).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    session.frameHandler?.({
      kind: "target.complete",
      worktreePath: "/wt/x",
      deleted: true,
      hasBinaryPayload: false,
    });
    await pending;
  });

  it("preserves the relayed phase and output lines", async () => {
    const recorded: ProgressInfo[] = [];
    const pending = buildWorktreeDeleteCommand({
      worktreePath: "/wt/x",
      readonlySurface: false,
    })(jsonCtx(recorded));

    await waitForSessions(1);
    const session = commandSession();
    session.frameHandler?.({
      kind: "target.started",
      worktreePath: "/wt/x",
      hasTeardown: true,
      hasBinaryPayload: false,
    });
    session.frameHandler?.({
      kind: "target.phase",
      worktreePath: "/wt/x",
      phase: "teardown",
      hasBinaryPayload: false,
    });
    session.frameHandler?.({
      kind: "target.output",
      worktreePath: "/wt/x",
      channel: "stderr",
      chunk: "tearing down\n",
      hasBinaryPayload: false,
    });
    session.frameHandler?.({
      kind: "target.complete",
      worktreePath: "/wt/x",
      deleted: true,
      hasBinaryPayload: false,
    });

    await pending;
    expect(recorded).toEqual([
      {
        stage: "worktree-delete",
        message: "starting delete (running teardown script)",
        percent: null,
        bytes: null,
        totalBytes: null,
        workUnits: null,
      },
      {
        stage: "worktree-delete",
        message: "phase: teardown",
        percent: null,
        bytes: null,
        totalBytes: null,
        workUnits: null,
      },
      {
        stage: "worktree-delete:stderr",
        message: "tearing down\n",
        percent: null,
        bytes: null,
        totalBytes: null,
        workUnits: null,
      },
    ]);
  });
});

describe("buildWorktreeDeleteCommand stream-drop safety", () => {
  it("fails non-zero on a drop before a terminal frame, with no re-subscribe", async () => {
    const pending = buildWorktreeDeleteCommand({
      worktreePath: "/wt/x",
      readonlySurface: false,
    })(ctx);

    await waitForSessions(1);
    const session = commandSession();
    // Reaching `open` is the moment the subscribe frame hit a live socket.
    session.statusHandler?.("open", null);
    // A recoverable transport drop surfaces as `reconnecting`.
    session.statusHandler?.("reconnecting", null);

    await expect(pending).rejects.toMatchObject({
      code: CLI_ERROR_CODES.UNEXPECTED,
      exitCode: 1,
      message: expect.stringContaining("may or may not have been removed"),
    });

    // The drop tore the run down. The batch client swaps to `observe` inside
    // the `reconnecting` transition, so if anything WAS re-sent it can only
    // have been an observe - never a second authorization to delete.
    expect(
      hoisted.state.sessions.every(
        (opened) =>
          opened.method === "worktree.deleteBatchByPath" &&
          ((opened.params as { readonly mode: string }).mode === "observe" ||
            opened === session),
      ),
    ).toBe(true);
    expect(
      hoisted.state.sessions.filter(
        (opened) =>
          (opened.params as { readonly mode: string }).mode === "start",
      ),
    ).toHaveLength(1);
    expect(hoisted.sessionCloseMock).toHaveBeenCalled();
    expect(hoisted.clientCloseMock).toHaveBeenCalled();
  });
});

describe("buildWorktreeDeleteCommand terminal outcomes", () => {
  it("resolves deleted=true on a target.complete frame", async () => {
    const pending = buildWorktreeDeleteCommand({
      worktreePath: "/wt/x",
      readonlySurface: false,
    })(ctx);

    await waitForSessions(1);
    commandSession().frameHandler?.({
      kind: "target.complete",
      worktreePath: "/wt/x",
      deleted: true,
      hasBinaryPayload: false,
    });

    const result = await pending;
    expect(result.data).toEqual({ worktreePath: "/wt/x", deleted: true });
    expect(result.exitCode).toBe(0);
    expect(hoisted.sessionCloseMock).toHaveBeenCalled();
    expect(hoisted.clientCloseMock).toHaveBeenCalled();
  });

  it("resolves deleted=false with a non-zero exit when the host removed nothing", async () => {
    const pending = buildWorktreeDeleteCommand({
      worktreePath: "/wt/x",
      readonlySurface: false,
    })(ctx);

    await waitForSessions(1);
    commandSession().frameHandler?.({
      kind: "target.complete",
      worktreePath: "/wt/x",
      deleted: false,
      hasBinaryPayload: false,
    });

    const result = await pending;
    expect(result.data).toEqual({ worktreePath: "/wt/x", deleted: false });
    expect(result.exitCode).toBe(1);
  });

  it("maps a target.failed frame to a CliError carrying the host's reason", async () => {
    const pending = buildWorktreeDeleteCommand({
      worktreePath: "/wt/x",
      readonlySurface: false,
    })(ctx);

    await waitForSessions(1);
    commandSession().frameHandler?.({
      kind: "target.failed",
      worktreePath: "/wt/x",
      reason: "worktree is busy",
      hasBinaryPayload: false,
    });

    await expect(pending).rejects.toMatchObject({
      code: CLI_ERROR_CODES.UNEXPECTED,
      exitCode: 1,
      message: expect.stringContaining("worktree is busy"),
    });
  });

  it("maps a command.failed frame to a CliError carrying the host's reason", async () => {
    const pending = buildWorktreeDeleteCommand({
      worktreePath: "/wt/x",
      readonlySurface: false,
    })(ctx);

    await waitForSessions(1);
    commandSession().frameHandler?.({
      kind: "command.failed",
      reason: "Lost track of this delete when the connection dropped.",
      hasBinaryPayload: false,
    });

    await expect(pending).rejects.toMatchObject({
      code: CLI_ERROR_CODES.UNEXPECTED,
      exitCode: 1,
      message: expect.stringContaining("Lost track of this delete"),
    });
  });

  it("falls back to the command counts when only the command terminal arrives", async () => {
    // What an observer that attached to an already-settled command sees: no
    // per-target frames are replayed, so the counts are the whole answer.
    const pending = buildWorktreeDeleteCommand({
      worktreePath: "/wt/x",
      readonlySurface: false,
    })(ctx);

    await waitForSessions(1);
    commandSession().frameHandler?.({
      kind: "command.complete",
      requestedCount: 1,
      deletedCount: 1,
      failedCount: 0,
      hasBinaryPayload: false,
    });

    const result = await pending;
    expect(result.data).toEqual({ worktreePath: "/wt/x", deleted: true });
    expect(result.exitCode).toBe(0);
  });

  it("maps an UNAUTHORIZED fatal close to an auth-rejected CliError", async () => {
    const pending = buildWorktreeDeleteCommand({
      worktreePath: "/wt/x",
      readonlySurface: false,
    })(ctx);

    await waitForSessions(1);
    commandSession().statusHandler?.("closed", {
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason: "bearer rejected",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });

    await expect(pending).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      exitCode: 1,
    });
  });

  it("maps an INCOMPATIBLE fatal close to a host-incompatible CliError", async () => {
    const pending = buildWorktreeDeleteCommand({
      worktreePath: "/wt/x",
      readonlySurface: false,
    })(ctx);

    await waitForSessions(1);
    commandSession().statusHandler?.("closed", {
      kind: "fatalError",
      details: {
        code: "INCOMPATIBLE",
        reason: "protocol version skew",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });

    await expect(pending).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
      exitCode: 1,
    });
  });
});

describe("buildWorktreeDeleteCommand older-host fallback", () => {
  it("runs the released single-target stream once the host proves it lacks the command method", async () => {
    hoisted.state.methodSupport = "unsupported";
    const pending = buildWorktreeDeleteCommand({
      worktreePath: "/wt/x",
      readonlySurface: false,
    })(ctx);

    await waitForSessions(1);
    // The transport marks support on the openAck and then closes the session -
    // BEFORE the subscribe frame, so the host was never asked to delete.
    commandSession().statusHandler?.("closed", {
      kind: "fatalError",
      details: {
        code: "INCOMPATIBLE",
        reason: "host does not offer worktree.deleteBatchByPath",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });

    await waitForSessions(2);
    const legacy = hoisted.state.sessions[1]!;
    expect(legacy.method).toBe("worktree.deleteByPath");
    expect(legacy.params).toEqual({ worktreePath: "/wt/x", scripts: null });

    legacy.frameHandler?.({
      kind: "complete",
      deleted: true,
      hasBinaryPayload: false,
    });

    const result = await pending;
    expect(result.data).toEqual({ worktreePath: "/wt/x", deleted: true });
    expect(result.exitCode).toBe(0);
    expect(hoisted.clientCloseMock).toHaveBeenCalled();
  });

  it("does not fall back after a fatal close that is not an unsupported method", async () => {
    const pending = buildWorktreeDeleteCommand({
      worktreePath: "/wt/x",
      readonlySurface: false,
    })(ctx);

    await waitForSessions(1);
    commandSession().statusHandler?.("closed", {
      kind: "fatalError",
      details: {
        code: "INTERNAL",
        reason: "host blew up",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });

    await expect(pending).rejects.toMatchObject({
      code: CLI_ERROR_CODES.UNEXPECTED,
    });
    // Exactly one subscribe: a delete that may have half-happened is never
    // re-issued on the older method.
    expect(hoisted.state.sessions).toHaveLength(1);
  });
});
