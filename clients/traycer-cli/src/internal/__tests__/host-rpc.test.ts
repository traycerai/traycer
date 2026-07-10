import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callHostRpc, toAgentCliError } from "../host-rpc";
import { cliBearerStore, resolveHostAuth } from "../host-auth";
import { readHostPidMetadata } from "../../host/pid-metadata";
import { HostRpcError } from "../../../../shared/host-transport/host-messenger";
import { refreshAuthTokenViaHttp } from "../../../../shared/auth/auth-validation";
import { CLI_ERROR_CODES } from "../../runner/errors";

// Mock the WS transport + the network refresh; exercise the real shared
// auth-aware wrapper + bearer revalidator so this verifies the CLI wiring
// (auth resolution, refresh-on-401 → rotate → retry) end-to-end without a
// socket. Protocol-level coverage lives in the shared transport tests.
//
// `requestMock` is declared via `vi.hoisted` so it exists when the hoisted
// `vi.mock` factory below captures it. `WsRpcClient` is mocked as a class so
// `new WsRpcClient(...)` is constructable; every instance shares `requestMock`.
const { requestMock, rpcClientConstructorMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  rpcClientConstructorMock: vi.fn(),
}));

vi.mock("../../../../shared/host-transport/ws-rpc-client", () => ({
  WsRpcClient: class {
    constructor(options: unknown) {
      rpcClientConstructorMock(options);
    }

    request = requestMock;
  },
}));

vi.mock("../../../../shared/auth/auth-validation", () => ({
  refreshAuthTokenViaHttp: vi.fn(),
}));

vi.mock("../host-auth", () => ({
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
const refreshMock = vi.mocked(refreshAuthTokenViaHttp);
const pidMock = vi.mocked(readHostPidMetadata);
const storeRead = vi.mocked(cliBearerStore.read);
const storeWrite = vi.mocked(cliBearerStore.write);

const METHOD = "agent.list";

beforeEach(() => {
  vi.clearAllMocks();
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
  // store.read returns the current token by default → revalidator refreshes
  // (rather than adopting a sibling token).
  storeRead.mockResolvedValue({
    token: "tok-1",
    refreshToken: "tok-1-refresh",
    userId: "u1",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("callHostRpc", () => {
  it("throws a friendly error when not signed in", async () => {
    resolveAuthMock.mockResolvedValue(null);
    await expect(
      callHostRpc(METHOD, {
        epicId: "e",
        senderAgentId: "agent-1",
        scope: "user",
      }),
    ).rejects.toThrow(/traycer login/);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("delegates to the shared client and returns the result", async () => {
    requestMock.mockResolvedValue({ agents: [] });
    const params = {
      epicId: "e",
      senderAgentId: "agent-1",
      scope: "user" as const,
    };
    const result = await callHostRpc(METHOD, params);
    expect(result).toEqual({ agents: [] });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(METHOD, params);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("rejects invalid host metadata endpoints before constructing the WS client", async () => {
    pidMock.mockResolvedValue({
      pid: process.pid,
      hostId: "d1",
      version: "1.0.0",
      websocketUrl: "ws://attacker.example:9/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(
      callHostRpc(METHOD, {
        epicId: "e",
        senderAgentId: "agent-1",
        scope: "user",
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_RUNNING,
    });
    expect(rpcClientConstructorMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("refreshes the bearer and retries once on UNAUTHORIZED", async () => {
    requestMock
      .mockRejectedValueOnce(
        new HostRpcError({
          code: "UNAUTHORIZED",
          message: "expired",
          requestId: "r1",
          method: METHOD,
          fatalDetails: null,
        }),
      )
      .mockResolvedValueOnce({ agents: [] });
    refreshMock.mockResolvedValue({
      kind: "refreshed",
      token: "tok-2",
      refreshToken: "tok-2-refresh",
    });

    const result = await callHostRpc(METHOD, {
      epicId: "e",
      senderAgentId: "agent-1",
      scope: "user",
    });

    expect(result).toEqual({ agents: [] });
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(storeWrite).toHaveBeenCalledWith({
      token: "tok-2",
      refreshToken: "tok-2-refresh",
    });
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces UNAUTHORIZED without retrying when the refresh is rejected", async () => {
    requestMock.mockRejectedValue(
      new HostRpcError({
        code: "UNAUTHORIZED",
        message: "expired",
        requestId: "r1",
        method: METHOD,
        fatalDetails: null,
      }),
    );
    refreshMock.mockResolvedValue({ kind: "rejected" });

    await expect(
      callHostRpc(METHOD, {
        epicId: "e",
        senderAgentId: "agent-1",
        scope: "user",
      }),
    ).rejects.toBeInstanceOf(HostRpcError);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on a non-UNAUTHORIZED error", async () => {
    requestMock.mockRejectedValue(
      new HostRpcError({
        code: "FORBIDDEN",
        message: "nope",
        requestId: "r1",
        method: METHOD,
        fatalDetails: null,
      }),
    );
    await expect(
      callHostRpc(METHOD, {
        epicId: "e",
        senderAgentId: "agent-1",
        scope: "user",
      }),
    ).rejects.toBeInstanceOf(HostRpcError);
    expect(refreshMock).not.toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("maps per-feature host unsupported errors distinctly from incompatibility", async () => {
    await expect(
      toAgentCliError(
        Promise.reject(
          new HostRpcError({
            code: "E_HOST_UNSUPPORTED",
            message:
              "This host does not support 'agent.future'. Upgrade the host to use this feature.",
            requestId: "r1",
            method: "agent.future",
            fatalDetails: null,
          }),
        ),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UNSUPPORTED,
      message:
        "traycer: This host does not support 'agent.future'. Upgrade the host to use this feature.",
      details: {
        hostShouldUpgrade: true,
        method: "agent.future",
      },
    });
  });
});
