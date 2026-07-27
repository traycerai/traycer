import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorktreeDeleteCommand } from "../worktree-delete";
import { CliError, CLI_ERROR_CODES } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";
import type { StreamCloseReason } from "../../../../shared/host-transport/i-stream-session";
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

// Shared, hoisted so the module mock factory can reference them.
const hoisted = vi.hoisted(() => ({
  subscribeMock: vi.fn(),
  clientCloseMock: vi.fn(),
  sessionCloseMock: vi.fn(),
  ref: {
    statusHandler: null as
      ((status: string, reason: StreamCloseReason | null) => void) | null,
    frameHandler: null as ((envelope: unknown) => void) | null,
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

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.ref.statusHandler = null;
  hoisted.ref.frameHandler = null;
  resolveHostAuthMock.mockResolvedValue({
    token: "token",
    userId: "user",
    authnBaseUrl: "https://authn.example",
  });
  resolveEndpointMock.mockResolvedValue({
    hostId: "host-1",
    websocketUrl: "ws://127.0.0.1:9999/rpc",
  });
  hoisted.subscribeMock.mockImplementation(() => ({
    onServerFrame: (handler: (envelope: unknown) => void) => {
      hoisted.ref.frameHandler = handler;
    },
    onStatusChange: (
      handler: (status: string, reason: StreamCloseReason | null) => void,
    ) => {
      hoisted.ref.statusHandler = handler;
    },
    sendClientFrame: () => undefined,
    close: hoisted.sessionCloseMock,
  }));
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

describe("buildWorktreeDeleteCommand stream-drop safety", () => {
  it("fails non-zero on a drop before a terminal frame, with no re-subscribe", async () => {
    const pending = buildWorktreeDeleteCommand({
      worktreePath: "/wt/x",
      readonlySurface: false,
    })(ctx);

    // Let resolveHostAuth / resolveEndpoint settle and the subscribe register.
    await vi.waitFor(() => {
      expect(hoisted.ref.statusHandler).not.toBeNull();
    });

    // A recoverable transport drop surfaces as `reconnecting` (the shared
    // client would auto re-subscribe and re-send the destructive delete).
    hoisted.ref.statusHandler?.("reconnecting", null);

    await expect(pending).rejects.toMatchObject({
      code: CLI_ERROR_CODES.UNEXPECTED,
      exitCode: 1,
    });

    // Exactly one subscribe was sent; the drop tore the stream down instead of
    // reconnecting.
    expect(hoisted.subscribeMock).toHaveBeenCalledTimes(1);
    expect(hoisted.subscribeMock).toHaveBeenCalledWith(
      "worktree.deleteByPath",
      { worktreePath: "/wt/x", scripts: null },
    );
    expect(hoisted.sessionCloseMock).toHaveBeenCalled();
    expect(hoisted.clientCloseMock).toHaveBeenCalled();
  });
});

describe("buildWorktreeDeleteCommand terminal outcomes", () => {
  it("resolves deleted=true on a complete frame", async () => {
    const pending = buildWorktreeDeleteCommand({
      worktreePath: "/wt/x",
      readonlySurface: false,
    })(ctx);

    await vi.waitFor(() => {
      expect(hoisted.ref.frameHandler).not.toBeNull();
    });

    hoisted.ref.frameHandler?.({
      kind: "complete",
      deleted: true,
      hasBinaryPayload: false,
    });

    const result = await pending;
    expect(result.data).toEqual({ worktreePath: "/wt/x", deleted: true });
    expect(result.exitCode).toBe(0);
    expect(hoisted.sessionCloseMock).toHaveBeenCalled();
    expect(hoisted.clientCloseMock).toHaveBeenCalled();
  });

  it("resolves deleted=false with a non-zero exit on a complete frame reporting no deletion", async () => {
    const pending = buildWorktreeDeleteCommand({
      worktreePath: "/wt/x",
      readonlySurface: false,
    })(ctx);

    await vi.waitFor(() => {
      expect(hoisted.ref.frameHandler).not.toBeNull();
    });

    hoisted.ref.frameHandler?.({
      kind: "complete",
      deleted: false,
      hasBinaryPayload: false,
    });

    const result = await pending;
    expect(result.data).toEqual({ worktreePath: "/wt/x", deleted: false });
    expect(result.exitCode).toBe(1);
  });

  it("maps a failed frame to a CliError carrying the host's reason", async () => {
    const pending = buildWorktreeDeleteCommand({
      worktreePath: "/wt/x",
      readonlySurface: false,
    })(ctx);

    await vi.waitFor(() => {
      expect(hoisted.ref.frameHandler).not.toBeNull();
    });

    hoisted.ref.frameHandler?.({
      kind: "failed",
      reason: "worktree is busy",
      hasBinaryPayload: false,
    });

    await expect(pending).rejects.toMatchObject({
      code: CLI_ERROR_CODES.UNEXPECTED,
      exitCode: 1,
      message: expect.stringContaining("worktree is busy"),
    });
    expect(hoisted.sessionCloseMock).toHaveBeenCalled();
    expect(hoisted.clientCloseMock).toHaveBeenCalled();
  });

  it("maps an UNAUTHORIZED fatal close to an auth-rejected CliError", async () => {
    const pending = buildWorktreeDeleteCommand({
      worktreePath: "/wt/x",
      readonlySurface: false,
    })(ctx);

    await vi.waitFor(() => {
      expect(hoisted.ref.statusHandler).not.toBeNull();
    });

    hoisted.ref.statusHandler?.("closed", {
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

    await vi.waitFor(() => {
      expect(hoisted.ref.statusHandler).not.toBeNull();
    });

    hoisted.ref.statusHandler?.("closed", {
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
