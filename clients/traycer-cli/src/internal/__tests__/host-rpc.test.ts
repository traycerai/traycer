import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostDoorReason } from "@traycer/protocol/framework/door-reason";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  callAgentHostRpcWithDispatch,
  callHostRpc,
  callHostRpcAtEndpoint,
  callHostRpcAtResolvedEndpoint,
  callHostRpcFastFail,
  callHostRpcWithDispatch,
  canonicalResponseSchemaFor,
  parseCanonicalHostResponse,
  PLAIN_DISPATCH,
  toAgentCliError,
} from "../host-rpc";
import { buildAgentSendCommand } from "../../commands/agent-send";
import { resolveHostAuth } from "../host-auth";
import { hostTokenFailureCliError } from "../host-door-words";
import { readHostPidMetadata } from "../../host/pid-metadata";
import {
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
} from "../../../../shared/host-transport/host-messenger";
import { RetryEpisodeOutcomeUnknownError } from "../../../../shared/host-transport/retrying-messenger";
import { createCliCredentialsStore } from "../../store/credentials-store";
import type { CredentialsMutationStore } from "@traycer/protocol/config/credentials-mutation";
import { CLI_ERROR_CODES, EXPECTED_CLI_ERROR_CODES } from "../../runner/errors";
import { config } from "../../config";
import {
  createHostTokenFilePersistence,
  hostTokensPath,
} from "@traycer-clients/shared/auth/host-token-file";
import type { HostRequestOptions } from "../../../../shared/host-transport/host-messenger";
import { createOutput } from "../../runner/output";
import type { CommandContext } from "../../runner/runner";
import { resolveRuntimeContext } from "../../runner/runtime";
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
  agentGetProviderProfileRateLimitsResponseSchemaV7,
  agentGetProviderProfileRateLimitsResponseSchemaV8,
} from "@traycer/protocol/host/agent/profiles";
import { worktreeListAllForHostResponseSchemaV16 } from "@traycer/protocol/host";
import { listTerminalsResponseSchemaV23 } from "@traycer/protocol/host/terminal/unary-schemas";
import { worktreeDeleteByPathServerFrameSchemaV13 } from "@traycer/protocol/host/worktree-delete-stream";
import {
  hostNotificationsCloudFeedSubscribeServerFrameSchemaV18,
  hostNotificationsSubscribeServerFrameSchemaV18,
} from "@traycer/protocol/host/notifications/host-notifications";
import {
  simulatorSessionsServerFrameSchemaV11,
  simulatorStreamServerFrameSchemaV10,
} from "@traycer/protocol/host/simulator/stream-contracts";

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
const {
  requestMock,
  rpcClientConstructorMock,
  releaseIdleMock,
  testHome,
  fetchMock,
  agentEnvironment,
  openCliHostSessionMock,
} = vi.hoisted(() => ({
  requestMock: vi.fn(),
  rpcClientConstructorMock: vi.fn(),
  releaseIdleMock: vi.fn(),
  testHome: { path: null as string | null },
  fetchMock: vi.fn(),
  agentEnvironment: {
    capability: undefined as string | undefined,
    agentId: undefined as string | undefined,
    names: [] as string[],
  },
  openCliHostSessionMock: vi.fn(),
}));
const presentedHostTokens = vi.hoisted(() => [] as string[]);

vi.mock("../agent-session-capability", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../agent-session-capability")>();
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

vi.mock("../cli-host-tokens", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli-host-tokens")>();
  return {
    ...actual,
    openCliHostSession: (
      ...args: Parameters<typeof actual.openCliHostSession>
    ) => {
      openCliHostSessionMock(...args);
      return actual.openCliHostSession(...args);
    },
  };
});

vi.mock(
  "@traycer-clients/shared/host-client/minimum-host-version",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/minimum-host-version")
      >();
    return { ...actual, MINIMUM_HOST_VERSION: "2.0.0" };
  },
);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => testHome.path ?? actual.homedir() };
});

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

        request = (
          method: string,
          params: unknown,
          options: HostRequestOptions,
        ) => {
          presentedHostTokens.push(options.authority.bearer.getBearerToken());
          return requestMock(method, params, options);
        };
        requestWithResponseTimeout = (
          method: string,
          params: unknown,
          _responseTimeoutMs: number,
          options: HostRequestOptions,
        ) => {
          presentedHostTokens.push(options.authority.bearer.getBearerToken());
          return requestMock(method, params, options);
        };
        releaseIdleLocalSessions = releaseIdleMock;
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

function agentSendCommand(): Promise<unknown> {
  const runtime = resolveRuntimeContext(
    { json: false, quiet: false, noProgress: false, noBootstrap: false },
    {},
  );
  const output = createOutput(runtime);
  const context: CommandContext = {
    runtime,
    output,
    progress: (info) => output.progress(info),
  };
  return buildAgentSendCommand({
    epicId: "epic-1",
    senderAgentId: "agent-1",
    to: "agent-2",
    message: "capability probe",
    expectReply: false,
    responseId: null,
    workspace: null,
  })(context);
}

function fatalDoorError(args: {
  readonly code: "UNAUTHORIZED" | "FORBIDDEN";
  readonly doorReason: HostDoorReason;
  readonly message: string;
  readonly method: string;
}): HostRpcError {
  return new HostRpcError({
    code: args.code,
    message: args.message,
    requestId: "door-refusal",
    method: args.method,
    fatalDetails: {
      code: args.code,
      reason: args.message,
      incompatibleMethods: null,
      upgradeGuidance: null,
      doorReason: args.doorReason,
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  requestMock.mockReset();
  fetchMock.mockReset();
  rotateMock.mockReset();
  presentedHostTokens.length = 0;
  agentEnvironment.capability = undefined;
  agentEnvironment.agentId = undefined;
  agentEnvironment.names.length = 0;
  openCliHostSessionMock.mockReset();
  testHome.path = await mkdtemp(join(tmpdir(), "traycer-cli-host-rpc-"));
  fetchMock.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          session_grant: `host-token-${fetchMock.mock.calls.length}`,
          session_grant_expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  resolveAuthMock.mockResolvedValue({
    token: "tok-1",
    authnBaseUrl: "https://authn.test",
    userId: "u1",
  });
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
  createStoreMock.mockReturnValue(fakeStore);
});

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  const home = testHome.path;
  testHome.path = null;
  if (home !== null) await rm(home, { recursive: true, force: true });
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
        // `host.status`-style CLI unary calls are reads: a `null` key asserts
        // no deduplication property, matching the production call site.
        idempotencyKey: null,
        authority: expect.objectContaining({
          endpoint: {
            hostId: "d1",
            websocketUrl: "ws://127.0.0.1:9/rpc",
          },
          bearer: expect.objectContaining({
            identity: { userId: "u1" },
          }),
          abortSignal: expect.any(AbortSignal),
        }),
      }),
    );
    expect(rotateMock).not.toHaveBeenCalled();
    // The per-run store is always disposed on the success path (finally), so a
    // `commit-failed` continuation timer can't outlive the command.
    expect(fakeStore.dispose).toHaveBeenCalledTimes(1);
    expect(releaseIdleMock).toHaveBeenCalledTimes(1);
  });

  it("opens with the stored host-only token without asking authn", async () => {
    const persistence = createHostTokenFilePersistence({
      environment: config.environment,
      lockWaitMs: 1_000,
      lockPollIntervalMs: 10,
    });
    await persistence.update((table) => {
      const users = new Map(table);
      users.set(
        "u1",
        new Map([
          [
            "d1",
            { token: "held-host-token", expiresAtMs: Date.now() + 60_000 },
          ],
        ]),
      );
      return users;
    });
    requestMock.mockResolvedValue({ agents: [] });

    await callHostRpcAtEndpoint(
      METHOD,
      { epicId: "e", senderAgentId: "agent-1", scope: "user" },
      { hostId: "d1", websocketUrl: "ws://127.0.0.1:9/rpc" },
    );

    expect(presentedHostTokens).toEqual(["held-host-token"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mints once and saves a private host-only token when none is held", async () => {
    requestMock.mockResolvedValue({ agents: [] });

    await callHostRpcAtEndpoint(
      METHOD,
      { epicId: "e", senderAgentId: "agent-1", scope: "user" },
      { hostId: "d1", websocketUrl: "ws://127.0.0.1:9/rpc" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(presentedHostTokens).toEqual(["host-token-1"]);
    const path = hostTokensPath(config.environment);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const saved = await readFile(path, "utf8");
    expect(JSON.parse(saved)).toMatchObject({
      version: 1,
      users: { u1: { d1: { token: "host-token-1" } } },
    });
    expect(saved).not.toContain("tok-1");
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

  it("a unary agent command sends only the session capability and never logs it", async () => {
    const capability = "opaque-agent-session-capability";
    agentEnvironment.capability = capability;
    requestMock.mockResolvedValue({ responseId: null });

    const result = await agentSendCommand();

    expect(result).toMatchObject({ exitCode: 0 });
    expect(presentedHostTokens).toEqual([capability]);
    expect(agentEnvironment.names).toEqual([
      "TRAYCER_AGENT_SESSION_CAPABILITY",
    ]);
    expect(resolveAuthMock).not.toHaveBeenCalled();
    expect(openCliHostSessionMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const loggerCalls = [
      ...loggerMock.debug.mock.calls,
      ...loggerMock.info.mock.calls,
      ...loggerMock.warn.mock.calls,
      ...loggerMock.error.mock.calls,
    ];
    expect(JSON.stringify(loggerCalls)).not.toContain(capability);
  });

  it("a not_admitted capability refusal keeps the host's generic line without recovery", async () => {
    agentEnvironment.capability = "opaque-agent-capability";
    requestMock.mockRejectedValue(
      fatalDoorError({
        code: "UNAUTHORIZED",
        doorReason: "not_admitted",
        message: "The agent session is not admitted.",
        method: "agent.sendMessage",
      }),
    );

    const error = await agentSendCommand().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message: "The agent session is not admitted.",
    });
    if (!(error instanceof Error)) throw new Error("expected a mapped error");
    expect(error.message).not.toContain("traycer login");
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveAuthMock).not.toHaveBeenCalled();
    expect(openCliHostSessionMock).not.toHaveBeenCalled();
  });

  it("a VERB_NOT_ALLOWED capability refusal keeps its unexpected host message", async () => {
    agentEnvironment.capability = "opaque-agent-capability";
    requestMock.mockRejectedValue(
      new HostRpcError({
        code: "VERB_NOT_ALLOWED",
        message: "agent.sendMessage is not allowed for this session",
        requestId: "verb-refusal",
        method: "agent.sendMessage",
        fatalDetails: null,
      }),
    );

    const error = await agentSendCommand().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: CLI_ERROR_CODES.UNEXPECTED,
      message: "agent.sendMessage is not allowed for this session",
    });
    if (!(error instanceof Error)) throw new Error("expected a mapped error");
    expect(error.message).not.toContain("traycer login");
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveAuthMock).not.toHaveBeenCalled();
    expect(openCliHostSessionMock).not.toHaveBeenCalled();
  });

  it("without the agent capability, a unary command uses the signed-out path", async () => {
    resolveAuthMock.mockResolvedValue(null);

    const error = await agentSendCommand().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
      message: "traycer: not signed in - run `traycer login` to authenticate.",
    });
    expect(agentEnvironment.names).toEqual([
      "TRAYCER_AGENT_SESSION_CAPABILITY",
      "TRAYCER_AGENT_ID",
    ]);
    expect(requestMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a capabilityless agent command reads neither sign-in nor host token", async () => {
    agentEnvironment.agentId = "agent-session";

    const error = await agentSendCommand().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
      message: "traycer: not signed in - run `traycer login` to authenticate.",
    });
    expect(agentEnvironment.names).toEqual([
      "TRAYCER_AGENT_SESSION_CAPABILITY",
      "TRAYCER_AGENT_ID",
    ]);
    expect(resolveAuthMock).not.toHaveBeenCalled();
    expect(openCliHostSessionMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a superseded host-token mint to fixed access-unconfirmed copy", () => {
    const error = hostTokenFailureCliError({ kind: "superseded" });

    expect(error).toMatchObject({
      code: CLI_ERROR_CODES.FORBIDDEN,
      message:
        "traycer: We can't confirm access to this computer right now. Try the command again.",
    });
  });

  it("refuses a below-floor host before dialing and dials a host at the floor", async () => {
    pidMock.mockResolvedValueOnce({
      pid: 1,
      hostId: "d1",
      version: "1.9.9",
      websocketUrl: "ws://127.0.0.1:9/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: null,
      processStartIdentityRead: "absent",
      layer0: null,
      layer0Slot: null,
    });
    const belowFloor = await agentSendCommand().catch(
      (caught: unknown) => caught,
    );

    expect(belowFloor).toMatchObject({
      code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
      message:
        "The host is out of date. Reinstall the latest host with 'traycer host update'.",
    });
    if (!(belowFloor instanceof Error))
      throw new Error("expected the older-host error");
    expect(belowFloor.message).not.toContain("traycer login");
    expect(rpcClientConstructorMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
    expect(openCliHostSessionMock).not.toHaveBeenCalled();

    requestMock.mockResolvedValue({ responseId: null });
    await agentSendCommand();

    expect(pidMock).toHaveBeenCalledTimes(2);
    expect(rpcClientConstructorMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  const listParams = {
    epicId: "e",
    senderAgentId: "agent-1",
    scope: "user",
  } satisfies Parameters<typeof callHostRpc>[1];
  it.each([
    ["callHostRpc", () => callHostRpc(METHOD, listParams), null],
    [
      "callHostRpcFastFail",
      () => callHostRpcFastFail(METHOD, listParams),
      null,
    ],
    [
      "callHostRpcWithDispatch",
      () => callHostRpcWithDispatch(METHOD, listParams, PLAIN_DISPATCH),
      null,
    ],
    ["a capabilityless agent command", agentSendCommand, "agent-session"],
  ] as const)(
    "%s with no sign-in tells a below-floor host as out of date, never a sign-in",
    async (_name, call, agentId) => {
      resolveAuthMock.mockResolvedValue(null);
      agentEnvironment.agentId = agentId ?? undefined;
      pidMock.mockResolvedValueOnce({
        pid: 1,
        hostId: "d1",
        version: "1.9.9",
        websocketUrl: "ws://127.0.0.1:9/rpc",
        startedAt: "2026-01-01T00:00:00.000Z",
        processStartIdentity: null,
        processStartIdentityRead: "absent",
        layer0: null,
        layer0Slot: null,
      });

      const error = await call().catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
        message:
          "The host is out of date. Reinstall the latest host with 'traycer host update'.",
      });
      expect(resolveAuthMock).not.toHaveBeenCalled();
      expect(rpcClientConstructorMock).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid host metadata endpoints before constructing the WS client", async () => {
    pidMock.mockResolvedValue({
      pid: process.pid,
      hostId: "d1",
      version: "1.0.0",
      websocketUrl: "ws://attacker.example:9/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: null,
      processStartIdentityRead: "absent",
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

  it.each(["token_expired", "not_admitted"] as const)(
    "mints one replacement after a %s door refusal",
    async (doorReason) => {
      requestMock
        .mockRejectedValueOnce(
          new HostRpcError({
            code: "UNAUTHORIZED",
            message: "expired",
            requestId: "r1",
            method: METHOD,
            fatalDetails: {
              code: "UNAUTHORIZED",
              reason: "expired",
              incompatibleMethods: null,
              upgradeGuidance: null,
              doorReason,
            },
          }),
        )
        .mockResolvedValueOnce({ agents: [] });

      const result = await callHostRpc(METHOD, {
        epicId: "e",
        senderAgentId: "agent-1",
        scope: "user",
      });

      expect(result).toEqual({ agents: [] });
      expect(rotateMock).not.toHaveBeenCalled();
      expect(requestMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(presentedHostTokens).toEqual(["host-token-1", "host-token-2"]);
    },
  );

  it.each(["token_expired", "not_admitted"] as const)(
    "does not send a third call after a replacement token is refused for %s",
    async (doorReason) => {
      const refusal = (requestId: string): HostRpcError =>
        new HostRpcError({
          code: "UNAUTHORIZED",
          message: "expired",
          requestId,
          method: METHOD,
          fatalDetails: {
            code: "UNAUTHORIZED",
            reason: "expired",
            incompatibleMethods: null,
            upgradeGuidance: null,
            doorReason,
          },
        });
      requestMock
        .mockRejectedValueOnce(refusal("r1"))
        .mockRejectedValueOnce(refusal("r2"));

      const error = await toAgentCliError(
        callHostRpc(METHOD, {
          epicId: "e",
          senderAgentId: "agent-1",
          scope: "user",
        }),
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message:
          doorReason === "not_admitted"
            ? "traycer: This account cannot access this computer. Switch accounts to use it."
            : "expired",
      });
      if (!(error instanceof Error)) throw new Error("expected a mapped error");
      expect(error.message).not.toContain("traycer login");
      expect(rotateMock).not.toHaveBeenCalled();
      expect(requestMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(presentedHostTokens).toEqual(["host-token-1", "host-token-2"]);
    },
  );

  it.each([
    {
      code: "UNAUTHORIZED",
      doorReason: "keys_unavailable",
      hostReason: "Host verification keys are not available.",
      line: "traycer: This computer needs to connect once before it can verify access. Check its connection, then retry.",
      attempts: 1,
    },
    {
      code: "FORBIDDEN",
      doorReason: "clock_skew",
      hostReason: "The host clock is outside the allowed window.",
      line: "traycer: This computer's date or time appears incorrect. Enable automatic date and time on that computer, then retry.",
      attempts: 1,
    },
    {
      code: "TEAM_MEMBERSHIP_REQUIRED",
      doorReason: "enrolment_broken",
      hostReason: "The computer's team enrollment needs repair.",
      line: "traycer: This computer's connection to the team needs repair. Ask a team administrator to restore it.",
      attempts: 1,
    },
    {
      code: "FORBIDDEN",
      doorReason: "membership_removed",
      hostReason: "The account was removed from the team.",
      line: "traycer: You no longer have access to this team's computer. Ask a team administrator if this is unexpected.",
      attempts: 1,
    },
    {
      code: "UNAUTHORIZED",
      doorReason: "not_admitted",
      hostReason: "The account is not admitted to this computer.",
      line: "traycer: This account cannot access this computer. Switch accounts to use it.",
      attempts: 2,
    },
    {
      code: "TEAM_MEMBERSHIP_REQUIRED",
      doorReason: "host_claimed",
      hostReason: "This computer was claimed by another member.",
      line: "traycer: This computer was claimed by another member.",
      attempts: 1,
    },
  ] as const)(
    "maps the host-token $doorReason door refusal to its exact line under $code",
    async ({ code, doorReason, hostReason, line, attempts }) => {
      const refusal = (requestId: string) =>
        new HostRpcError({
          code: code === "TEAM_MEMBERSHIP_REQUIRED" ? "FORBIDDEN" : code,
          message: hostReason,
          requestId,
          method: METHOD,
          fatalDetails: {
            code,
            reason: hostReason,
            incompatibleMethods: null,
            upgradeGuidance: null,
            doorReason,
          },
        });
      requestMock.mockRejectedValueOnce(refusal("r1"));
      if (attempts === 2) requestMock.mockRejectedValueOnce(refusal("r2"));

      const error = await toAgentCliError(
        callHostRpcAtEndpoint(
          METHOD,
          { epicId: "e", senderAgentId: "agent-1", scope: "user" },
          { hostId: "d1", websocketUrl: "ws://127.0.0.1:9/rpc" },
        ),
      ).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message: line,
      });
      if (!(error instanceof Error)) throw new Error("expected a mapped error");
      expect(error.message).not.toContain("access denied for this epic");
      expect(error.message).not.toContain("traycer login");
      expect(requestMock).toHaveBeenCalledTimes(attempts);
    },
  );

  it.each(["UNAUTHORIZED", "TEAM_MEMBERSHIP_REQUIRED"] as const)(
    "maps a reasonless non-retryable %s refusal to the older-host line",
    async (code) => {
      requestMock.mockRejectedValue(
        new HostRpcError({
          code: code === "TEAM_MEMBERSHIP_REQUIRED" ? "FORBIDDEN" : code,
          message: "legacy host refusal",
          requestId: "r1",
          method: METHOD,
          fatalDetails: {
            code,
            reason: "legacy host refusal",
            incompatibleMethods: null,
            upgradeGuidance: null,
            retryable: false,
          },
        }),
      );

      await expect(
        toAgentCliError(
          callHostRpcAtEndpoint(
            METHOD,
            { epicId: "e", senderAgentId: "agent-1", scope: "user" },
            { hostId: "d1", websocketUrl: "ws://127.0.0.1:9/rpc" },
          ),
        ),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
        message:
          "The host is out of date. Reinstall the latest host with 'traycer host update'.",
      });
      expect(requestMock).toHaveBeenCalledTimes(1);
    },
  );

  it("uses the access-unconfirmed line for retryable membership lookup failures", async () => {
    requestMock.mockRejectedValue(
      new HostRpcError({
        code: "FORBIDDEN",
        message: "membership check is temporarily unavailable",
        requestId: "r1",
        method: METHOD,
        fatalDetails: {
          code: "TEAM_MEMBERSHIP_UNAVAILABLE",
          reason: "membership check is temporarily unavailable",
          incompatibleMethods: null,
          upgradeGuidance: null,
          retryable: true,
        },
      }),
    );

    const error = await toAgentCliError(
      callHostRpc(METHOD, {
        epicId: "e",
        senderAgentId: "agent-1",
        scope: "user",
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: CLI_ERROR_CODES.TEAM_MEMBERSHIP_UNAVAILABLE,
      message:
        "traycer: We can't confirm access to this computer right now. Try the command again.",
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes the sign-in once when authn rejects a mint, then mints again", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_grant: "host-token-after-refresh",
            session_grant_expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    rotateMock.mockResolvedValue({
      outcome: "applied",
      credentials: {
        token: "tok-2",
        refreshToken: "tok-2-refresh",
        savedAt: "2026-01-01T00:00:00.000Z",
        user: { id: "u1", email: "a@b.c", name: "A" },
      },
      rejection: null,
      diskPressure: "clear",
    });
    requestMock.mockResolvedValue({ agents: [] });

    const result = await callHostRpcAtEndpoint(
      METHOD,
      { epicId: "e", senderAgentId: "agent-1", scope: "user" },
      { hostId: "d1", websocketUrl: "ws://127.0.0.1:9/rpc" },
    );

    expect(result).toEqual({ agents: [] });
    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(rotateMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedUserId: "u1", expectedToken: "tok-1" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(presentedHostTokens).toEqual(["host-token-after-refresh"]);
  });

  it("reports a refused sign-in refresh as not signed in", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    rotateMock.mockResolvedValue({
      outcome: "refresh-rejected-credential",
      credentials: null,
      rejection: null,
      diskPressure: null,
    });

    await expect(
      toAgentCliError(
        callHostRpcAtEndpoint(
          METHOD,
          { epicId: "e", senderAgentId: "agent-1", scope: "user" },
          { hostId: "d1", websocketUrl: "ws://127.0.0.1:9/rpc" },
        ),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
      message: "traycer: not signed in - run `traycer login` to authenticate.",
    });
    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("reports signed out when an expired host token's mint and sign-in refresh are refused", async () => {
    const persistence = createHostTokenFilePersistence({
      environment: config.environment,
      lockWaitMs: 1_000,
      lockPollIntervalMs: 10,
    });
    await persistence.update((table) => {
      const users = new Map(table);
      users.set(
        "u1",
        new Map([
          [
            "d1",
            { token: "held-host-token", expiresAtMs: Date.now() + 60_000 },
          ],
        ]),
      );
      return users;
    });
    requestMock.mockRejectedValue(
      new HostRpcError({
        code: "UNAUTHORIZED",
        message: "expired",
        requestId: "r1",
        method: METHOD,
        fatalDetails: {
          code: "UNAUTHORIZED",
          reason: "expired",
          incompatibleMethods: null,
          upgradeGuidance: null,
          doorReason: "token_expired",
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    rotateMock.mockResolvedValue({
      outcome: "refresh-rejected-credential",
      credentials: null,
      rejection: null,
      diskPressure: null,
    });

    await expect(
      toAgentCliError(
        callHostRpcAtEndpoint(
          METHOD,
          { epicId: "e", senderAgentId: "agent-1", scope: "user" },
          { hostId: "d1", websocketUrl: "ws://127.0.0.1:9/rpc" },
        ),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
      message: "traycer: not signed in - run `traycer login` to authenticate.",
    });
    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports signed out when a not_admitted refusal's fresh mint and sign-in refresh are refused", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_grant: "initial-host-token",
            session_grant_expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response("", { status: 401 }));
    requestMock.mockRejectedValue(
      fatalDoorError({
        code: "UNAUTHORIZED",
        doorReason: "not_admitted",
        message: "The account is not admitted to this computer.",
        method: METHOD,
      }),
    );
    rotateMock.mockResolvedValue({
      outcome: "refresh-rejected-credential",
      credentials: null,
      rejection: null,
      diskPressure: null,
    });

    await expect(
      toAgentCliError(
        callHostRpcAtEndpoint(
          METHOD,
          { epicId: "e", senderAgentId: "agent-1", scope: "user" },
          { hostId: "d1", websocketUrl: "ws://127.0.0.1:9/rpc" },
        ),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
      message: "traycer: not signed in - run `traycer login` to authenticate.",
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rotateMock).toHaveBeenCalledTimes(1);
  });

  it("reports signed out when a session_revoked refusal's sign-in refresh is refused", async () => {
    requestMock.mockRejectedValue(
      new HostRpcError({
        code: "UNAUTHORIZED",
        message: "The session was revoked.",
        requestId: "session-revoked",
        method: METHOD,
        fatalDetails: {
          code: "UNAUTHORIZED",
          reason: "The session was revoked.",
          incompatibleMethods: null,
          upgradeGuidance: null,
          doorReason: "session_revoked",
        },
      }),
    );
    rotateMock.mockResolvedValue({
      outcome: "refresh-rejected-credential",
      credentials: null,
      rejection: null,
      diskPressure: null,
    });

    await expect(
      toAgentCliError(
        callHostRpcAtEndpoint(
          METHOD,
          { epicId: "e", senderAgentId: "agent-1", scope: "user" },
          { hostId: "d1", websocketUrl: "ws://127.0.0.1:9/rpc" },
        ),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
      message: "traycer: not signed in - run `traycer login` to authenticate.",
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rotateMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "a team-membership refusal",
      status: 403,
      body: { code: "team_membership_required" },
      code: CLI_ERROR_CODES.TEAM_MEMBERSHIP_REQUIRED,
      message: /team.*member/i,
    },
    {
      name: "an unadmitted host",
      status: 404,
      body: { message: "private server detail" },
      code: CLI_ERROR_CODES.FORBIDDEN,
      message:
        "traycer: This account cannot access this computer. Switch accounts to use it.",
    },
    {
      name: "a frozen sandbox",
      status: 402,
      body: { code: "sandbox_frozen", message: "private server detail" },
      code: CLI_ERROR_CODES.HOST_UNREACHABLE,
      message: "traycer: This sandbox is out of credits.",
    },
    {
      name: "an unavailable authn response",
      status: 503,
      body: { message: "private server detail" },
      code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
      message:
        "traycer: We can't confirm access to this computer right now. Try the command again.",
    },
  ])("does not expose server details for $name", async (item) => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(item.body), {
        status: item.status,
        headers: { "content-type": "application/json" },
      }),
    );

    const failure = await callHostRpcAtEndpoint(
      METHOD,
      { epicId: "e", senderAgentId: "agent-1", scope: "user" },
      { hostId: "d1", websocketUrl: "ws://127.0.0.1:9/rpc" },
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: item.code, message: item.message });
    expect(String(failure)).not.toContain("private server detail");
    expect(String(failure)).not.toContain("run `traycer login`");
    expect(requestMock).not.toHaveBeenCalled();
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

  // The host answers these with a typed wire code for a state of the person's
  // own machine or workspace, and its message names the remedy. Each used to
  // fall through to UNEXPECTED, which the runner captures as a CLI defect
  // (TRAYCER-CLI-7). The mapped code must also be one the runner leaves
  // uncaptured, so each case checks both.
  it.each([
    {
      wire: "WORKTREE_MISSING" as const,
      cli: CLI_ERROR_CODES.WORKTREE_MISSING,
      message:
        "A bound folder is missing on disk: /gone. Restore it, re-bind to another folder, or remove it to continue.",
    },
    {
      wire: "WORKSPACE_BINDING_REQUIRED" as const,
      cli: CLI_ERROR_CODES.WORKSPACE_BINDING_REQUIRED,
      message:
        "Unable to resolve this agent's workspace selection. Choose a workspace before sending a message.",
    },
    {
      wire: "E_HOST_STORAGE_FULL" as const,
      cli: CLI_ERROR_CODES.HOST_STORAGE_FULL,
      message:
        "The host machine is out of disk space. Free some space on it, then try again.",
    },
    {
      // A transcript read whose only copy is behind a cloud that gave no
      // verdict: not a not-found, and not a CLI defect.
      wire: "E_CLOUD_UNREACHABLE" as const,
      cli: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
      message:
        "agent.getTranscript: cannot read agent 'a1' because the cloud could not be reached, so its published copy could not be read. Check this machine's network and try again.",
    },
    {
      // The host's own egress budget refused the call: retryable, like a
      // cloud that gave no verdict.
      wire: "E_CLOUD_REQUEST_REFUSED" as const,
      cli: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
      message:
        "cloud request refused by the host egress budget (breaker-open, family=bots)",
    },
    {
      // Sent for a reply on a thread that belongs to another pair
      // (RESPONSE_ID_MISMATCH): the caller's own input.
      wire: "E_INVALID_ARGUMENT" as const,
      cli: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        "agent.sendMessage: RESPONSE_ID_MISMATCH - 'r1' belongs to a different (sender, receiver) pair.",
    },
  ])(
    "maps the host's $wire refusal to an expected CLI code and keeps its message",
    async ({ wire, cli, message }) => {
      const mapped = await toAgentCliError(
        Promise.reject(
          new HostRpcError({
            code: wire,
            message,
            requestId: "r1",
            method: "agent.sendMessage",
            fatalDetails: null,
          }),
        ),
      ).catch((error: unknown) => error);
      expect(mapped).toMatchObject({
        code: cli,
        message: `traycer: ${message}`,
        details: null,
        exitCode: 1,
      });
      expect(EXPECTED_CLI_ERROR_CODES.has(cli)).toBe(true);
    },
  );

  // The host sends a request that names a managed profile it cannot use as a
  // 400 `RPC_ERROR` with one of four fixed messages (the person's own
  // selection, TRAYCER-CLI-4W). They end as the expected INVALID_ARGUMENT, with
  // the same output the host's `E_INVALID_ARGUMENT` gets.
  it.each([
    'No profile "p-1" is registered for provider "claude-code".',
    'Profile "p-1" for provider "claude-code" was removed and can no longer be used.',
    'Profile "p-1" for provider "claude-code" is still completing setup and cannot be used yet.',
    'Provider "cursor" does not support managed profiles.',
  ])(
    "maps an RPC_ERROR carrying the profile-selection refusal %s to an expected INVALID_ARGUMENT",
    async (message) => {
      const mapped = await toAgentCliError(
        Promise.reject(
          new HostRpcError({
            code: "RPC_ERROR",
            message,
            requestId: "r1",
            method: "agent.sendMessage",
            fatalDetails: null,
          }),
        ),
      ).catch((error: unknown) => error);
      expect(mapped).toMatchObject({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message: `traycer: ${message}`,
        details: null,
        exitCode: 1,
      });
      expect(
        EXPECTED_CLI_ERROR_CODES.has(CLI_ERROR_CODES.INVALID_ARGUMENT),
      ).toBe(true);
    },
  );

  // Control: an RPC_ERROR whose message is not a profile-selection refusal
  // stays UNEXPECTED and captured, so a host-side request-validation defect
  // is still reported.
  it("keeps an RPC_ERROR with a params-validation message as a captured UNEXPECTED", async () => {
    const mapped = await toAgentCliError(
      Promise.reject(
        new HostRpcError({
          code: "RPC_ERROR",
          message: "Invalid params for agent.sendMessage: profile: Required",
          requestId: "r1",
          method: "agent.sendMessage",
          fatalDetails: null,
        }),
      ),
    ).catch((error: unknown) => error);
    expect(mapped).toMatchObject({
      code: CLI_ERROR_CODES.UNEXPECTED,
      message: "Invalid params for agent.sendMessage: profile: Required",
    });
    expect(EXPECTED_CLI_ERROR_CODES.has(CLI_ERROR_CODES.UNEXPECTED)).toBe(
      false,
    );
  });

  // TRAYCER-CLI-P: a provider the person turned off in Settings -> Providers.
  // The host refuses a run or launch on it with HTTP 403 and the typed
  // `PROVIDER_DISABLED` code. It is the person's own setting, so the mapped
  // code is an expected one the runner leaves uncaptured, and the host's
  // message (which names the provider and the setting) is kept exactly as the
  // fall-through printed it, with no prefix added. `--json`
  // carries the new code in place of `E_UNEXPECTED`.
  it("maps the host's PROVIDER_DISABLED refusal to E_PROVIDER_DISABLED and keeps its message", async () => {
    const message = "Kilo Code is disabled. Enable it in Settings → Providers.";
    const mapped = await toAgentCliError(
      Promise.reject(
        new HostRpcError({
          code: "PROVIDER_DISABLED",
          message,
          requestId: "r1",
          method: "agent.sendMessage",
          fatalDetails: null,
        }),
      ),
    ).catch((error: unknown) => error);
    expect(mapped).toMatchObject({
      code: "E_PROVIDER_DISABLED",
      message,
      details: null,
      exitCode: 1,
    });
    expect(EXPECTED_CLI_ERROR_CODES.has("E_PROVIDER_DISABLED")).toBe(true);
  });

  // The team-transfer refusals reach the CLI as typed wire codes through
  // `callHostRpc`. Each ends as its own expected CLI code with a fixed,
  // actionable message: the host's raw text may name the caller's account, so
  // it is never passed through to the message, the details or the log.
  it.each([
    {
      wire: "E_ENVIRONMENT_NOT_A_MEMBER" as const,
      cli: CLI_ERROR_CODES.ENVIRONMENT_NOT_A_MEMBER,
      message: "Join the team before adding this computer.",
    },
    {
      wire: "E_ENVIRONMENT_SEAT_NOT_ACCEPTED" as const,
      cli: CLI_ERROR_CODES.ENVIRONMENT_SEAT_NOT_ACCEPTED,
      message: "Accept your team invitation before adding this computer.",
    },
    {
      wire: "E_ENVIRONMENT_SEAT_WITHOUT_WRITE" as const,
      cli: CLI_ERROR_CODES.ENVIRONMENT_SEAT_WITHOUT_WRITE,
      message: "Ask a team admin for permission to add computers.",
    },
    {
      wire: "E_HOST_IS_SANDBOX" as const,
      cli: CLI_ERROR_CODES.HOST_IS_SANDBOX,
      message:
        "A sandbox cannot be given to a team. Run this command on the computer you want to add.",
    },
    {
      wire: "E_HOST_IN_ANOTHER_TEAM" as const,
      cli: CLI_ERROR_CODES.HOST_IN_ANOTHER_TEAM,
      message:
        "Claim this computer from its current team before adding it to another.",
    },
  ])(
    "maps the host's $wire refusal to an expected CLI code with a fixed message that omits the host's text",
    async ({ wire, cli, message }) => {
      const hostText =
        "refused for user 11111111-2222-3333-4444-555555555555 (someone@example.test) on team 99999999-8888-7777-6666-555555555555";
      requestMock.mockRejectedValue(
        new HostRpcError({
          code: wire,
          message: hostText,
          requestId: "r1",
          method: METHOD,
          fatalDetails: null,
        }),
      );

      const mapped = await toAgentCliError(
        callHostRpc(METHOD, {
          epicId: "e",
          senderAgentId: "agent-1",
          scope: "user",
        }),
      ).catch((error: unknown) => error);

      expect(mapped).toMatchObject({
        code: cli,
        message,
        details: null,
        exitCode: 1,
      });
      expect(EXPECTED_CLI_ERROR_CODES.has(cli)).toBe(true);
      const surfaced = JSON.stringify([mapped, loggerMock.warn.mock.calls]);
      expect(surfaced).not.toContain("11111111-2222");
      expect(surfaced).not.toContain("someone@example.test");
      expect(surfaced).not.toContain("99999999-8888");
    },
  );

  // The arm keys on the typed wire code, never on the host's wording: the same
  // sentence arriving as an untyped `RPC_ERROR` stays a captured defect.
  it("keeps an untyped RPC_ERROR as UNEXPECTED even when its text reads like a disabled provider", async () => {
    await expect(
      toAgentCliError(
        Promise.reject(
          new HostRpcError({
            code: "RPC_ERROR",
            message:
              "Kilo Code is disabled. Enable it in Settings → Providers.",
            requestId: "r1",
            method: "agent.sendMessage",
            fatalDetails: null,
          }),
        ),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.UNEXPECTED,
      message: "Kilo Code is disabled. Enable it in Settings → Providers.",
      details: null,
    });
    expect(EXPECTED_CLI_ERROR_CODES.has(CLI_ERROR_CODES.UNEXPECTED)).toBe(
      false,
    );
  });

  // A PLAIN `HostTransportFailureError` is the one shape the transport builds
  // after the request frame went out with nothing making a replay safe
  // (`requestSent && !requestReplaySafe`): the host may have carried the call
  // out and answered into a connection that was already gone. It must NOT
  // share HOST_UNREACHABLE, whose meaning is that nothing happened and the
  // command can simply be run again - that reading is what made callers resend
  // a message the host had already delivered. The transport's own message is
  // kept and the guidance is appended to it.
  it("maps a plain HostTransportFailureError to HOST_REQUEST_OUTCOME_UNKNOWN and says the request was sent", async () => {
    await expect(
      toAgentCliError(
        Promise.reject(
          new HostTransportFailureError({
            code: "RPC_ERROR",
            message: "WebSocket frame timed out after 15000ms",
            requestId: "r1",
            method: METHOD,
            fatalDetails: null,
          }),
        ),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message:
        "traycer: WebSocket frame timed out after 15000ms - the request was sent and the host may have carried it out; check before sending it again.",
      details: null,
      exitCode: 1,
    });
  });

  // RetryableTransportError is a subclass of HostTransportFailureError, and it
  // is the transport's own statement that sending again is safe - either
  // nothing was dispatched or the host is deduplicating a negotiated key. That
  // is precisely what HOST_UNREACHABLE means, so it stays there and must not
  // follow its parent class to the unknown-outcome code.
  it("keeps a RetryableTransportError on HOST_UNREACHABLE, where a retry is safe", async () => {
    await expect(
      toAgentCliError(
        Promise.reject(
          new RetryableTransportError({
            code: "RPC_ERROR",
            message: "WebSocket frame timed out after 15000ms",
            requestId: "r1",
            method: METHOD,
            fatalDetails: null,
            replaySafetyFromKey: true,
          }),
        ),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UNREACHABLE,
      message: "WebSocket frame timed out after 15000ms",
      details: null,
      exitCode: 1,
    });
  });

  // An abort answers the question on its own flag rather than by its class:
  // stopping the wait does not recall a request the host may already be
  // running, while an abort before any send leaves nothing behind.
  it("splits an aborted request by mayHaveDispatched", async () => {
    await expect(
      toAgentCliError(
        Promise.reject(
          new HostRequestAbortedError({
            message: "Host request authority was aborted while open",
            requestId: "r1",
            method: METHOD,
            mayHaveDispatched: true,
          }),
        ),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      exitCode: 1,
    });
    await expect(
      toAgentCliError(
        Promise.reject(
          new HostRequestAbortedError({
            message: "Host request authority was aborted before dispatch",
            requestId: "r1",
            method: METHOD,
            mayHaveDispatched: false,
          }),
        ),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UNREACHABLE,
      exitCode: 1,
    });
  });

  // Control: a plain HostRpcError with the SAME wire code (RPC_ERROR) that is
  // NOT a transport failure - i.e. the host answered - must still classify as
  // UNEXPECTED. This is the case the class-based check above must not widen.
  it("still maps a plain HostRpcError with code RPC_ERROR to UNEXPECTED", async () => {
    await expect(
      toAgentCliError(
        Promise.reject(
          new HostRpcError({
            code: "RPC_ERROR",
            message: "agent not found",
            requestId: "r1",
            method: METHOD,
            fatalDetails: null,
          }),
        ),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.UNEXPECTED,
      message: "agent not found",
      details: null,
    });
  });

  // A refusal that ended a retry episode after an earlier attempt may have
  // reached the host arrives wrapped in an unknown-outcome transport failure.
  // Its code still says what to do: an access denial, sanitized, not "host
  // unreachable" with the wrapper's text.
  it("maps a refusal that ended a retry episode by the refusal's code", async () => {
    await expect(
      toAgentCliError(
        Promise.reject(
          new RetryEpisodeOutcomeUnknownError(
            new HostRpcError({
              code: "FORBIDDEN",
              message:
                "user 00000000-0000-0000-0000-000000000000 has no role on task",
              requestId: "r2",
              method: METHOD,
              fatalDetails: null,
            }),
          ),
        ),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.FORBIDDEN,
      message:
        "traycer: access denied for this epic - check TRAYCER_EPIC_ID and that you're signed in to the account that owns it. An earlier attempt may have gone through. Check before repeating it.",
      details: null,
    });
  });
});

const COMMANDS_DIR = join(__dirname, "..", "..", "commands");

describe("callHostRpcAtResolvedEndpoint", () => {
  it("sends on the endpoint and sign-in it is handed, with the dispatch's key and floor", async () => {
    requestMock.mockResolvedValue({ agents: [] });
    const params = {
      epicId: "e",
      senderAgentId: "agent-1",
      scope: "user" as const,
    };
    const floor = {
      method: "epic.create",
      version: { major: 1, minor: 1 },
    };
    await callHostRpcAtResolvedEndpoint(
      METHOD,
      params,
      { hostId: "preflighted", websocketUrl: "ws://127.0.0.1:7/rpc" },
      { token: "tok-p", authnBaseUrl: "https://authn.test", userId: "u-p" },
      {
        responseTimeoutMs: null,
        requiredHostMethodVersion: floor,
        signal: null,
        failFast: false,
        reauthenticate: "always",
        idempotencyKey: "task-1",
      },
    );
    // Nothing is re-resolved: a host restarted after the caller's preflight
    // fails this call rather than receiving it under a fresh read.
    expect(resolveAuthMock).not.toHaveBeenCalled();
    expect(pidMock).not.toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalledWith(
      METHOD,
      params,
      expect.objectContaining({
        idempotencyKey: "task-1",
        requiredHostMethodVersion: floor,
        authority: expect.objectContaining({
          endpoint: {
            hostId: "preflighted",
            websocketUrl: "ws://127.0.0.1:7/rpc",
          },
          bearer: expect.objectContaining({ identity: { userId: "u-p" } }),
        }),
      }),
    );
  });
});

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
    // v8.0, not v7.0: the 1.5.1 tags shipped the v7.0 line, so it is frozen
    // against `providerRateLimitsSchemaV151` and v8.0 is open over the live
    // union (the Kimi arm) - the same move traycerai/traycer#1808 made for
    // `cli-v1.3.0`. This pin moving is the intended consequence of a freeze -
    // what must NOT happen is the call site staying on v7.0 while this pin
    // moves, which is why the two are asserted apart.
    expect(
      canonicalResponseSchemaFor("agent.getProviderProfileRateLimits"),
    ).toBe(agentGetProviderProfileRateLimitsResponseSchemaV8);
    // And the line the release froze is now demonstrably NOT canonical.
    expect(
      canonicalResponseSchemaFor("agent.getProviderProfileRateLimits"),
    ).not.toBe(agentGetProviderProfileRateLimitsResponseSchemaV7);
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
      agentGetProviderProfileRateLimitsResponseSchemaV8,
      value,
    );
    expect(parsed).toEqual(value);
  });

  // This is the one case the type system cannot catch: `...Schema` (no version
  // suffix) ranges over the same live `providerRateLimitsSchema` as the head
  // `...SchemaV6`, so it is STRUCTURALLY IDENTICAL to canonical, satisfies
  // `ZodType<ResponseOfMethod<...>>`, and compiles at any call site - while
  // being a DIFFERENT object that is canonical for nothing.
  //
  // That is precisely the drift a freeze creates, and it is not hypothetical:
  // `cli-v1.3.0` froze the v5.0 line and the call site in
  // `agent-profile-rate-limits.ts` was still pinned to `...SchemaV5`, which
  // would have strict-decoded a v6.0 response and silently dropped
  // `antigravity`. Only the runtime identity check in
  // `assertCanonicalResponseSchema` catches it; a type-level assertion passes
  // both the stale pin and this call unchanged.
  //
  // Keeping the base alias distinct from the head is therefore deliberate -
  // it is this test's only falsifying fixture. If a future change collapses
  // them, this test has nothing left to prove and must be given a fresh
  // structurally-identical object rather than deleted.
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
  it("worktreeDeleteByPathServerFrameSchemaV13 is the canonical serverFrameSchema for worktree.deleteByPath", () => {
    expect(
      latestStreamServerFrameSchema(
        hostStreamRpcRegistry["worktree.deleteByPath"],
      ),
    ).toBe(worktreeDeleteByPathServerFrameSchemaV13);
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
    // names `worktreeDeleteByPathServerFrameSchemaV13` explicitly, verified
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

describe("canonical stream frame pairing (simulator streams)", () => {
  // The shared `simulator-*-stream-client.ts` wrappers parse with these two
  // explicit versioned schemas (sessions `V11`, stream `V10`); a later minor
  // that leaves them behind would silently strip its new keys
  // (`protocol/README.md`, "Opening a new minor on a stream"), so the pin is
  // held here by identity.
  it("simulatorSessionsServerFrameSchemaV11 is the canonical serverFrameSchema for simulator.sessions", () => {
    expect(
      latestStreamServerFrameSchema(
        hostStreamRpcRegistry["simulator.sessions"],
      ),
    ).toBe(simulatorSessionsServerFrameSchemaV11);
  });

  it("simulatorStreamServerFrameSchemaV10 is the canonical serverFrameSchema for simulator.stream", () => {
    expect(
      latestStreamServerFrameSchema(hostStreamRpcRegistry["simulator.stream"]),
    ).toBe(simulatorStreamServerFrameSchemaV10);
  });
});

describe("canonical stream frame pairing (notification feeds)", () => {
  it("hostNotificationsSubscribeServerFrameSchemaV18 is the canonical serverFrameSchema for host.notifications.feed.subscribe", () => {
    expect(
      latestStreamServerFrameSchema(
        hostStreamRpcRegistry["host.notifications.feed.subscribe"],
      ),
    ).toBe(hostNotificationsSubscribeServerFrameSchemaV18);
  });

  it("hostNotificationsCloudFeedSubscribeServerFrameSchemaV18 is the canonical serverFrameSchema for host.notifications.cloudFeed.subscribe", () => {
    expect(
      latestStreamServerFrameSchema(
        hostStreamRpcRegistry["host.notifications.cloudFeed.subscribe"],
      ),
    ).toBe(hostNotificationsCloudFeedSubscribeServerFrameSchemaV18);
  });
});
