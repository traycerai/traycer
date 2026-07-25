import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callHostRpc, toAgentCliError } from "../host-rpc";
import { resolveHostAuth } from "../host-auth";
import { readHostPidMetadata } from "../../host/pid-metadata";
import { HostRpcError } from "../../../../shared/host-transport/host-messenger";
import { createCliCredentialsStore } from "../../store/credentials-store";
import type { CredentialsMutationStore } from "@traycer/protocol/config/credentials-mutation";
import { CLI_ERROR_CODES } from "../../runner/errors";

// Mock the WS transport + the credentials-store FACTORY; exercise the real
// store-backed revalidator + withCommitRetry + shared auth-aware wrapper so this
// verifies the CLI wiring (auth resolution, on-401 → locked `rotate` → lease
// rotate → retry) end-to-end without a socket. The rotate spend itself (the
// locked WAL commit) is covered in the protocol `credentials-mutation` tests.
//
// `requestMock` is declared via `vi.hoisted` so it exists when the hoisted
// `vi.mock` factory below captures it. `WsRpcClient` is mocked as a class so
// `new WsRpcClient(...)` is constructable; every instance shares `requestMock`.
const { requestMock, rpcClientConstructorMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  rpcClientConstructorMock: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// The transport tests assert errors directly. Persistent diagnostics are not
// part of their contract and must not touch the live CLI log.
vi.mock("../../logger", () => ({
  createCliLogger: () => loggerMock,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
}));

vi.mock("../../../../shared/host-transport/ws-rpc-client", () => ({
  WsRpcClient: class {
    constructor(options: unknown) {
      rpcClientConstructorMock(options);
    }

    request = requestMock;
  },
}));

vi.mock("../host-auth", () => ({
  resolveHostAuth: vi.fn(),
}));

// Mock only the store FACTORY; the real store-backed revalidator + withCommitRetry
// run, so `rotate`'s outcome (driven per-test) flows through the actual on-401
// mapping and lease rotation.
vi.mock("../../store/credentials-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials-store")>();
  return { ...actual, createCliCredentialsStore: vi.fn() };
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
const createStoreMock = vi.mocked(createCliCredentialsStore);

// The on-401 revalidator drives `store.rotate`; the rest of the store surface is
// unused by host-rpc, so stub it and steer `rotate` per-test.
const rotateMock = vi.fn();
const fakeStore: CredentialsMutationStore = {
  read: vi.fn(),
  rotate: rotateMock,
  signIn: vi.fn(),
  signOut: vi.fn(),
  updateProfile: vi.fn(),
  guardedSignIn: vi.fn(),
  migrateFirstWrite: vi.fn(),
  hasPendingContinuation: vi.fn(() => false),
  dispose: vi.fn(),
};

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
  createStoreMock.mockReturnValue(fakeStore);
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
    expect(requestMock).toHaveBeenCalledWith(
      METHOD,
      params,
      expect.objectContaining({
        endpoint: {
          hostId: "d1",
          websocketUrl: "ws://127.0.0.1:9/rpc",
        },
        bearer: expect.objectContaining({
          identity: { userId: "u1" },
        }),
        abortSignal: expect.any(AbortSignal),
      }),
    );
    expect(rotateMock).not.toHaveBeenCalled();
    // The per-run store is always disposed on the success path (finally), so a
    // `commit-failed` continuation timer can't outlive the command.
    expect(fakeStore.dispose).toHaveBeenCalledTimes(1);
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

  it("rotates the bearer and retries once on UNAUTHORIZED", async () => {
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
    // The locked rotate mints a fresh pair; the real revalidator rotates the
    // lease to it, and the auth-aware wrapper retries once against the new bearer.
    rotateMock.mockResolvedValue({
      outcome: "applied",
      credentials: {
        token: "tok-2",
        refreshToken: "tok-2-refresh",
        authnBaseUrl: "https://authn.test",
        savedAt: "2026-01-01T00:00:00.000Z",
        user: { id: "u1", email: "a@b.c", name: "A" },
      },
    });

    const result = await callHostRpc(METHOD, {
      epicId: "e",
      senderAgentId: "agent-1",
      scope: "user",
    });

    expect(result).toEqual({ agents: [] });
    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(rotateMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedUserId: "u1", expectedToken: "tok-1" }),
    );
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces UNAUTHORIZED without retrying when the rotate refresh is rejected", async () => {
    requestMock.mockRejectedValue(
      new HostRpcError({
        code: "UNAUTHORIZED",
        message: "expired",
        requestId: "r1",
        method: METHOD,
        fatalDetails: null,
      }),
    );
    // A dead refresh token leaves the lease untouched, so the wrapper does not
    // retry and the UNAUTHORIZED surfaces.
    rotateMock.mockResolvedValue({
      outcome: "refresh-rejected",
      credentials: null,
    });

    await expect(
      callHostRpc(METHOD, {
        epicId: "e",
        senderAgentId: "agent-1",
        scope: "user",
      }),
    ).rejects.toBeInstanceOf(HostRpcError);
    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("does not rotate on a non-UNAUTHORIZED error", async () => {
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
    expect(rotateMock).not.toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalledTimes(1);
    // The store is disposed on the throw path too (finally), not just success.
    expect(fakeStore.dispose).toHaveBeenCalledTimes(1);
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
