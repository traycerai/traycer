import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  callHostRpc,
  callHostRpcFastFail,
  canonicalResponseSchemaFor,
  parseCanonicalHostResponse,
  toAgentCliError,
} from "../host-rpc";
import { resolveHostAuth } from "../host-auth";
import { readHostPidMetadata } from "../../host/pid-metadata";
import { HostRpcError } from "../../../../shared/host-transport/host-messenger";
import { createCliCredentialsStore } from "../../store/credentials-store";
import type { CredentialsMutationStore } from "@traycer/protocol/config/credentials-mutation";
import { CLI_ERROR_CODES } from "../../runner/errors";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { getLatestContract } from "@traycer/protocol/framework/versioned-rpc";
import type {
  StreamMethodVersionRegistry,
  UncheckedStreamMethodVersionRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import type { ZodType } from "zod";
import {
  agentGetProviderProfileRateLimitsResponseSchema,
  agentGetProviderProfileRateLimitsResponseSchemaV5,
} from "@traycer/protocol/host/agent/profiles";
import { worktreeListAllForHostResponseSchemaV16 } from "@traycer/protocol/host";
import { listTerminalsResponseSchemaV23 } from "@traycer/protocol/host/terminal/unary-schemas";
import { worktreeDeleteByPathServerFrameSchemaV11 } from "@traycer/protocol/host/worktree-delete-stream";

/**
 * Mirrors `getLatestContract`'s traversal (highest major -> its
 * `latestMinor`) for a stream method registry - there is no shared helper
 * because `hostStreamRpcRegistry`'s validated shape carries no
 * `downgradePathsFromLatest`, so it fails `getLatestContract`'s
 * `MethodVersionRegistry` constraint outright.
 */
function latestStreamServerFrameSchema<
  Registry extends UncheckedStreamMethodVersionRegistry,
>(registry: StreamMethodVersionRegistry<Registry>): ZodType {
  const highestMajor = Math.max(
    ...Object.keys(registry)
      .map(Number)
      .filter((candidate) => Number.isInteger(candidate)),
  );
  const majorLine = registry[highestMajor];
  return majorLine.versions[majorLine.latestMinor].contract.serverFrameSchema;
}

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

vi.mock(
  "../../../../shared/host-transport/ws-rpc-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../shared/host-transport/ws-rpc-client")
      >();
    return {
      // Only `WsRpcClient` is replaced; the real
      // `HOST_POST_OPEN_ATTESTATION_WINDOW_MS` stays, so the constructor
      // assertion below reads the value the CLI actually ships.
      ...actual,
      WsRpcClient: class {
        constructor(options: unknown) {
          rpcClientConstructorMock(options);
        }

        request = requestMock;
      },
    };
  },
);

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
  signOutIfToken: vi.fn(),
  drainQuarantine: vi.fn(),
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
    processStartIdentity: null,
    // Mirrors the real reader, which now always reports the host's Layer 0
    // verdict. `null` = this fixture's host recorded no attempt.
    layer0: null,
    layer0Slot: null,
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

  it("dials with an attestation window that outlasts the host's post-openAck deadline", async () => {
    requestMock.mockResolvedValue({ agents: [] });

    await callHostRpc(METHOD, {
      epicId: "e",
      senderAgentId: "agent-1",
      scope: "user",
    });

    // The CLI gives up on a response after 15s, but a stalled host only attests
    // that it never dispatched the request once its own 30s post-`openAck`
    // timer finally runs - measured at 35.7-40.8s in issue #726, and up to
    // ~45s for the profiled stall class. Without a window that outlasts that,
    // the CLI closes the socket early and the recoverable stall surfaces as an
    // ambiguous, non-retryable failure.
    expect(rpcClientConstructorMock).toHaveBeenCalledTimes(1);
    const options: unknown = rpcClientConstructorMock.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      frameTimeoutMs: 15_000,
      hostAttestationWindowMs: 50_000,
    });
  });

  it("fast-fail dials with a zero attestation window so a miss fails at the 15s response deadline", async () => {
    requestMock.mockResolvedValue({ agents: [] });

    await callHostRpcFastFail(METHOD, {
      epicId: "e",
      senderAgentId: "agent-1",
      scope: "user",
    });

    // Latency-bound IDE hooks never redial, so waiting for an attestation they
    // cannot act on would only inflate time-to-failure. The policy therefore
    // opts out of the window entirely while keeping the same 15s frame budget.
    expect(rpcClientConstructorMock).toHaveBeenCalledTimes(1);
    const options: unknown = rpcClientConstructorMock.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      frameTimeoutMs: 15_000,
      hostAttestationWindowMs: 0,
    });
  });

  it("rejects invalid host metadata endpoints before constructing the WS client", async () => {
    pidMock.mockResolvedValue({
      pid: process.pid,
      hostId: "d1",
      version: "1.0.0",
      websocketUrl: "ws://attacker.example:9/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: null,
      layer0: null,
      layer0Slot: null,
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

  it("maps oversized agent messages to invalid argument", async () => {
    await expect(
      toAgentCliError(
        Promise.reject(
          new HostRpcError({
            code: "MESSAGE_TOO_LARGE",
            message: "Message exceeds the maximum size.",
            requestId: "r1",
            method: "agent.sendMessage",
            fatalDetails: null,
          }),
        ),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "traycer: Message exceeds the maximum size.",
      details: null,
    });
  });
});

const COMMANDS_DIR = join(__dirname, "..", "..", "commands");

describe("canonicalResponseSchemaFor", () => {
  it("returns exactly the registry's latest contract response schema for a spread of methods", () => {
    const methods: ReadonlyArray<keyof typeof hostRpcRegistry & string> = [
      "worktree.listAllForHost",
      "terminal.list",
      "agent.getProviderProfileRateLimits",
      "agent.list",
    ];
    for (const method of methods) {
      expect(canonicalResponseSchemaFor(method)).toBe(
        getLatestContract(hostRpcRegistry[method], undefined).responseSchema,
      );
    }
  });

  it("agrees with the concrete canonical schemas the fixed call sites parse against", () => {
    expect(canonicalResponseSchemaFor("worktree.listAllForHost")).toBe(
      worktreeListAllForHostResponseSchemaV16,
    );
    expect(canonicalResponseSchemaFor("terminal.list")).toBe(
      listTerminalsResponseSchemaV23,
    );
    expect(
      canonicalResponseSchemaFor("agent.getProviderProfileRateLimits"),
    ).toBe(agentGetProviderProfileRateLimitsResponseSchemaV5);
  });
});

describe("parseCanonicalHostResponse", () => {
  it("returns the parsed data on the canonical-pairing happy path", () => {
    const value = {
      rateLimits: { provider: "codex", available: false, reason: "timeout" },
      usageUpdatedAt: null,
    };
    const parsed = parseCanonicalHostResponse(
      "agent.getProviderProfileRateLimits",
      agentGetProviderProfileRateLimitsResponseSchemaV5,
      value,
    );
    expect(parsed).toEqual(value);
  });

  // This is the one case the type system cannot catch: `...Schema` (no
  // version suffix) is the LIVE-line alias, redefined onto each new major as
  // the previous one freezes. It is STRUCTURALLY IDENTICAL to `...SchemaV5`
  // today, so it satisfies `ZodType<ResponseOfMethod<...>>` and compiles at
  // the call site - but it is a DIFFERENT object, free to stop tracking
  // canonical the moment a v6 line ships. Only the runtime identity check in
  // `assertCanonicalResponseSchema` catches that drift; a type-level
  // assertion would pass this call unchanged.
  it("throws when handed a schema that is structurally identical to canonical but not the same object (the runtime backstop)", () => {
    const value = {
      rateLimits: { provider: "codex", available: false, reason: "timeout" },
      usageUpdatedAt: null,
    };
    // Sanity: the base alias really does accept the same payload as V5 today -
    // otherwise this test would be catching a type/shape bug, not the
    // identity backstop it exists to prove.
    expect(
      agentGetProviderProfileRateLimitsResponseSchema.safeParse(value).success,
    ).toBe(true);
    expect(() =>
      parseCanonicalHostResponse(
        "agent.getProviderProfileRateLimits",
        agentGetProviderProfileRateLimitsResponseSchema,
        value,
      ),
    ).toThrow(/non-canonical response schema/);
  });
});

describe("parseHostResponse creep guard", () => {
  // Empty, as intended: #1508 carved out `workspace-list.ts` and
  // `worktree-create.ts` while PR #1505 held them, and #1505 converted both to
  // `parseCanonicalHostResponse` on landing. Do not add to it without
  // justification - use `parseCanonicalHostResponse` instead. A call site that
  // genuinely means a specific historical version (monitor.ts's frame decode)
  // lives outside this directory.
  const ALLOWLIST = new Set<string>([]);

  it("no command calls the un-canonical parseHostResponse", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(COMMANDS_DIR)) {
      if (!file.endsWith(".ts") || ALLOWLIST.has(file)) continue;
      const source = readFileSync(join(COMMANDS_DIR, file), "utf8");
      if (/\bparseHostResponse\(/.test(source)) offenders.push(file);
    }
    expect(
      offenders,
      `${offenders.join(", ")} call parseHostResponse() directly. Use ` +
        "parseCanonicalHostResponse(method, schema, value) instead - naming " +
        "the method lets the compiler and the runtime identity check both " +
        "prove the schema is canonical. If this call site genuinely needs a " +
        "specific historical version (like monitor.ts's frame decode), " +
        "justify it in this test's allowlist instead of failing silently.",
    ).toEqual([]);
  });
});

describe("canonical stream frame pairing (worktree.deleteByPath)", () => {
  it("worktreeDeleteByPathServerFrameSchemaV11 is the canonical serverFrameSchema for worktree.deleteByPath", () => {
    expect(
      latestStreamServerFrameSchema(
        hostStreamRpcRegistry["worktree.deleteByPath"],
      ),
    ).toBe(worktreeDeleteByPathServerFrameSchemaV11);
  });

  // The v1.0 -> v1.1 diff on this method is an OPTIONAL field
  // (`worktreeBusyHoldersWireFieldSchema` is `.optional().catch(undefined)`)
  // added to one arm of a discriminated union, not a new required field on
  // the whole response. A `ZodType<...>` compile-time constraint would not
  // reject the v1.0 schema in that shape, so this identity check (mirroring
  // `canonicalResponseSchemaFor`'s unary-registry traversal, but over
  // `hostStreamRpcRegistry`) is the only thing that would have caught this
  // specific skew.
  it("scans commands/*.ts for hand-picked ServerFrameSchemaV<N> usage outside the negotiated-dispatch allowlist", () => {
    // `monitor.ts` parses agentInboxSubscribeServerFrameSchemaV10/V11/V12 (plus
    // the base envelope) ON PURPOSE - that is per-connection negotiated-version
    // dispatch (try newest, fall back), not a stale call site. `worktree-delete.ts`
    // names `worktreeDeleteByPathServerFrameSchemaV11` explicitly, verified
    // canonical by the assertion above.
    const ALLOWLIST = new Set(["monitor.ts", "worktree-delete.ts"]);
    const versionedFrameSchemaPattern = /[A-Za-z]+ServerFrameSchemaV\d+/;
    const offenders: string[] = [];
    for (const file of readdirSync(COMMANDS_DIR)) {
      if (!file.endsWith(".ts") || ALLOWLIST.has(file)) continue;
      const source = readFileSync(join(COMMANDS_DIR, file), "utf8");
      if (versionedFrameSchemaPattern.test(source)) offenders.push(file);
    }
    expect(
      offenders,
      `${offenders.join(", ")} reference a versioned *ServerFrameSchemaV<N> ` +
        "directly. Confirm it is the registry's canonical latest for that " +
        "stream method (see the identity assertion above) or justify the " +
        "addition in this allowlist.",
    ).toEqual([]);
  });
});
