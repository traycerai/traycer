import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callHostRpcAtEndpoint, toAgentCliError } from "../host-rpc";
import { resolveHostAuth } from "../host-auth";
import { HostRpcError } from "../../../../shared/host-transport/host-messenger";
import { CLI_ERROR_CODES } from "../../runner/errors";
import type { HostTokenTable } from "../../../../shared/auth/host-token-store";

const state = vi.hoisted(() => {
  const requests = vi.fn();
  const mintOutcomes: Array<unknown> = [];
  let table: HostTokenTable = new Map();
  const revalidate = vi.fn();
  const dispose = vi.fn();
  const mint = vi.fn(async () => {
    const next = mintOutcomes.shift();
    if (next !== undefined) return next;
    return {
      kind: "ok" as const,
      token: {
        token: `host-${mint.mock.calls.length}`,
        expiresAtMs: Date.now() + 3_600_000,
      },
    };
  });
  return {
    requests,
    mintOutcomes,
    mint,
    revalidate,
    dispose,
    get table() {
      return table;
    },
    set table(value: HostTokenTable) {
      table = value;
    },
  };
});

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock(
  "../../../../shared/host-transport/ws-rpc-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../shared/host-transport/ws-rpc-client")
      >();
    return {
      ...actual,
      WsRpcClient: class {
        constructor() {}
        request = state.requests;
        releaseIdleLocalSessions = vi.fn();
      },
    };
  },
);

vi.mock("@traycer-clients/shared/auth/host-token-file", () => ({
  createHostTokenFilePersistence: () => ({
    load: async () => state.table,
    update: async (change: (table: HostTokenTable) => HostTokenTable) => {
      state.table = change(state.table);
      return state.table;
    },
  }),
}));

vi.mock("@traycer-clients/shared/host-transport/remote/grant-client", () => ({
  mintHostTokenViaHttp: state.mint,
}));

vi.mock("../host-auth", () => ({ resolveHostAuth: vi.fn() }));
vi.mock("../../store/credentials-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials-store")>();
  return {
    ...actual,
    createCliCredentialsStore: vi.fn(() => ({ dispose: state.dispose })),
    createStoreBackedRevalidator: vi.fn(() => ({
      revalidateCurrentContext: state.revalidate,
    })),
  };
});
vi.mock("../logger", () => ({
  createCliLogger: () => logger,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
}));

const resolveAuthMock = vi.mocked(resolveHostAuth);
const refusedToken = (
  doorReason: "token_expired" | "not_admitted",
): HostRpcError =>
  new HostRpcError({
    code: "UNAUTHORIZED",
    message: "host refused the credential",
    requestId: "request-1",
    method: "agent.list",
    fatalDetails: {
      code: "UNAUTHORIZED",
      reason: "host refused the credential",
      incompatibleMethods: null,
      upgradeGuidance: null,
      doorReason,
    },
  });

const endpoint = { hostId: "host-1", websocketUrl: "ws://127.0.0.1:9/rpc" };
const params = {
  epicId: "epic-1",
  senderAgentId: "agent-1",
  scope: "user" as const,
};

beforeEach(() => {
  state.mintOutcomes.length = 0;
  state.table = new Map();
  state.requests.mockReset();
  state.mint.mockClear();
  state.revalidate.mockReset();
  state.dispose.mockClear();
  resolveAuthMock.mockResolvedValue({
    token: "signin",
    authnBaseUrl: "https://authn.test",
    userId: "user-1",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("callHostRpc host-token mint recovery", () => {
  it("reports the rejected-credential line when the post-refresh mint is also refused", async () => {
    state.mintOutcomes.push(
      { kind: "sign-in-rejected" },
      { kind: "sign-in-rejected" },
    );
    state.revalidate.mockResolvedValue("rotated");

    await expect(
      toAgentCliError(callHostRpcAtEndpoint("agent.list", params, endpoint)),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message:
        "The stored credential was rejected. Run `traycer login` to re-authenticate.",
      exitCode: 1,
    });
    expect(state.mint).toHaveBeenCalledTimes(2);
    expect(state.revalidate).toHaveBeenCalledTimes(1);
    expect(state.requests).not.toHaveBeenCalled();
  });

  it("reports the rejected-credential line when the sign-in refresh itself is refused", async () => {
    state.mintOutcomes.push({ kind: "sign-in-rejected" });
    state.revalidate.mockResolvedValue("rejected");

    await expect(
      toAgentCliError(callHostRpcAtEndpoint("agent.list", params, endpoint)),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message:
        "The stored credential was rejected. Run `traycer login` to re-authenticate.",
      exitCode: 1,
    });
    expect(state.mint).toHaveBeenCalledTimes(1);
    expect(state.revalidate).toHaveBeenCalledTimes(1);
    expect(state.requests).not.toHaveBeenCalled();
  });

  it("reports authn unreachable, never the rejected line, when sign-in refresh cannot reach authn", async () => {
    state.mintOutcomes.push({ kind: "sign-in-rejected" });
    state.revalidate.mockResolvedValue("network-error");

    await expect(
      toAgentCliError(callHostRpcAtEndpoint("agent.list", params, endpoint)),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
      message: "",
      exitCode: 1,
    });
    expect(state.mint).toHaveBeenCalledTimes(1);
    expect(state.revalidate).toHaveBeenCalledTimes(1);
    expect(state.requests).not.toHaveBeenCalled();
  });

  it.each(["token_expired", "not_admitted"] as const)(
    "does not send a third request when the replacement token is refused again for %s",
    async (doorReason) => {
      state.requests
        .mockRejectedValueOnce(refusedToken(doorReason))
        .mockRejectedValueOnce(refusedToken(doorReason));

      const error = await toAgentCliError(
        callHostRpcAtEndpoint("agent.list", params, endpoint),
      ).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(state.mint).toHaveBeenCalledTimes(2);
      expect(state.requests).toHaveBeenCalledTimes(2);
      expect(error).not.toMatchObject({
        message:
          "The stored credential was rejected. Run `traycer login` to re-authenticate.",
      });
    },
  );
});
