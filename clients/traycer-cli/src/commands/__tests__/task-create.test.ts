/**
 * `traycer task create`: the request it states to `epic.create`, the refusals
 * that create nothing, and the `--idempotency-key` record that keeps a retried
 * or doubled run from starting a second Task.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEpicRequestSchemaV13 } from "@traycer/protocol/host/epic/unary-schemas";
import { markMayHaveReachedHost } from "@traycer/protocol/host-transport/remote/rpc-types";
import { buildTaskCreateCommand } from "../task-create";
import { resolveHostAuth } from "../../internal/host-auth";
import {
  callHostRpcAtResolvedEndpoint,
  resolveEndpoint,
} from "../../internal/host-rpc";
import {
  HostMethodVersionUnsatisfiedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
} from "../../../../shared/host-transport/host-messenger";
import { RetryEpisodeOutcomeUnknownError } from "../../../../shared/host-transport/retrying-messenger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";
import { noopLogger } from "../../logger";
import {
  taskCreateKeyRecordPath,
  writeTaskCreateKey,
} from "../../store/task-create-keys";

const keysDir = vi.hoisted(() => ({ current: "" }));

vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return { ...actual, cliTaskCreateKeysDir: () => keysDir.current };
});

vi.mock("../../internal/host-auth", () => ({ resolveHostAuth: vi.fn() }));

// The real send path, kept so a test can run a create through the real
// retrying and auth-aware messengers with only the socket mocked.
const realSend = vi.hoisted(() => ({
  call: null as
    | null
    | typeof import("../../internal/host-rpc").callHostRpcAtResolvedEndpoint,
}));

vi.mock("../../internal/host-rpc", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-rpc")>();
  realSend.call = actual.callHostRpcAtResolvedEndpoint;
  return {
    ...actual,
    resolveEndpoint: vi.fn(),
    callHostRpcAtResolvedEndpoint: vi.fn(),
  };
});

const socketRequest = vi.hoisted(() => vi.fn());

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
        request = socketRequest;
      },
    };
  },
);

const storeRotate = vi.hoisted(() => vi.fn());

vi.mock("../../store/credentials-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials-store")>();
  return {
    ...actual,
    createCliCredentialsStore: () => ({
      dispose: () => undefined,
      rotate: storeRotate,
    }),
  };
});

vi.mock("../../logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logger")>();
  return { ...actual, createCliLogger: () => actual.noopLogger };
});

vi.mock("../../store/task-create-keys", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/task-create-keys")>();
  return { ...actual, writeTaskCreateKey: vi.fn(actual.writeTaskCreateKey) };
});

const authMock = vi.mocked(resolveHostAuth);
const endpointMock = vi.mocked(resolveEndpoint);
const rpcMock = vi.mocked(callHostRpcAtResolvedEndpoint);
const writeKeyMock = vi.mocked(writeTaskCreateKey);

const AUTH = { token: "tok", authnBaseUrl: "https://authn.test", userId: "u1" };
const ENDPOINT = { hostId: "host-1", websocketUrl: "ws://127.0.0.1:9/rpc" };
const CREATED = { roomInfo: null, task: null, initialTurnStarted: false };

function ctx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: noopLogger,
    },
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

interface Flags {
  readonly title: string | null;
  readonly message: string;
  readonly workspaces: readonly string[];
  readonly repos: readonly string[];
  readonly harness: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly permissionMode: string | null;
  readonly profile: string | null;
  readonly idempotencyKey: string | null;
}

const FLAGS: Flags = {
  title: null,
  message: "Summarise last night's failures",
  workspaces: [],
  repos: [],
  harness: "claude",
  model: "claude-sonnet-4-5",
  reasoningEffort: null,
  permissionMode: null,
  profile: null,
  idempotencyKey: null,
};

function run(overrides: Partial<Flags>) {
  return buildTaskCreateCommand({ ...FLAGS, ...overrides })(ctx());
}

async function rejection(promise: Promise<unknown>): Promise<CliError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  if (!(error instanceof CliError)) {
    throw new Error(`expected a CliError, got ${String(error)}`);
  }
  return error;
}

function sentRequest(call: number) {
  return createEpicRequestSchemaV13.parse(rpcMock.mock.calls[call][1]);
}

async function recordFiles(): Promise<string[]> {
  return readdir(keysDir.current).catch(() => []);
}

beforeEach(async () => {
  keysDir.current = await mkdtemp(join(tmpdir(), "task-create-cmd-"));
  vi.stubEnv("TRAYCER_AGENT_ID", "");
  vi.stubEnv("TRAYCER_EPIC_ID", "");
  authMock.mockResolvedValue(AUTH);
  endpointMock.mockResolvedValue(ENDPOINT);
  rpcMock.mockResolvedValue(CREATED);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  // A one-attempt send leaves a queued socket answer unread.
  socketRequest.mockReset();
  storeRotate.mockReset();
  await rm(keysDir.current, { recursive: true, force: true });
});

describe("task create: the request", () => {
  it("states one person-owned Task with a seeded first agent and message, on the preflighted host", async () => {
    const result = await run({
      title: "Nightly triage",
      workspaces: ["/srv/app", "/srv/lib"],
      repos: ["acme/app"],
      reasoningEffort: "high",
      profile: "profile-7",
    });

    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [method, , endpoint, auth, dispatch] = rpcMock.mock.calls[0];
    expect(method).toBe("epic.create");
    expect(endpoint).toEqual(ENDPOINT);
    expect(auth).toEqual(AUTH);
    const request = sentRequest(0);
    expect(request.owner).toBeNull();
    expect(request.epic).toMatchObject({
      title: "Nightly triage",
      initialUserPrompt: "Summarise last night's failures",
      createdBy: "u1",
    });
    expect(request.repoIdentifiers).toEqual([{ owner: "acme", repo: "app" }]);
    expect(request.workspaces).toEqual([
      { workspacePath: "/srv/app" },
      { workspacePath: "/srv/lib" },
    ]);
    const chat = request.chat;
    if (chat === null || chat === undefined) throw new Error("no chat seed");
    expect(chat).toMatchObject({
      parentId: null,
      hostId: "host-1",
      workspaceMode: "inherit",
      worktreeIntent: null,
    });
    expect(chat.initialMessage).toMatchObject({
      sender: { type: "user", userId: "u1" },
      accountContext: { type: "PERSONAL" },
      sentFromHostId: "host-1",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Summarise last night's failures" },
            ],
          },
        ],
      },
      settings: {
        harnessId: "claude",
        model: "claude-sonnet-4-5",
        permissionMode: "full_access",
        reasoningEffort: "high",
        agentMode: "regular",
        profileId: "profile-7",
      },
    });
    // Refused before any frame by a host whose create is not the local-first
    // one, sent as one transport attempt, and keyed by the Task id it mints.
    expect(dispatch).toEqual({
      responseTimeoutMs: null,
      requiredHostMethodVersion: {
        method: "epic.create",
        version: { major: 1, minor: 1 },
      },
      signal: null,
      failFast: true,
      reauthenticate: "before-request",
      idempotencyKey: request.epic.id,
    });
    expect(result).toEqual({
      data: {
        taskId: request.epic.id,
        agentId: chat.chatId,
        alreadyCreated: false,
      },
      human: `${request.epic.id} ${chat.chatId}`,
      exitCode: 0,
    });
  });

  it("creates a folderless first agent when no folder is named, on the ambient profile", async () => {
    await run({});
    const chat = sentRequest(0).chat;
    expect(chat?.workspaceMode).toBe("folderless");
    expect(chat?.initialMessage?.settings.profileId).toBeNull();
    expect(sentRequest(0).epic.title).toBe("");
  });

  it("sends the ambient login for --profile ambient", async () => {
    await run({ profile: "ambient" });
    expect(sentRequest(0).chat?.initialMessage?.settings.profileId).toBeNull();
  });

  it("writes no key record without --idempotency-key", async () => {
    await run({});
    expect(await recordFiles()).toEqual([]);
  });
});

describe("task create: refusals that create nothing", () => {
  it.each(["TRAYCER_AGENT_ID", "TRAYCER_EPIC_ID"])(
    "refuses inside an agent session (%s set) before reading the sign-in",
    async (variable) => {
      vi.stubEnv(variable, "agent-or-task-1");
      const error = await rejection(run({}));
      expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
      expect(error.message).toContain("traycer_create_task");
      expect(authMock).not.toHaveBeenCalled();
      expect(rpcMock).not.toHaveBeenCalled();
    },
  );

  it("requires --harness and --model", async () => {
    expect((await rejection(run({ harness: null }))).code).toBe(
      CLI_ERROR_CODES.INVALID_ARGUMENT,
    );
    expect((await rejection(run({ model: null }))).code).toBe(
      CLI_ERROR_CODES.INVALID_ARGUMENT,
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("refuses a relative --workspace and a --repo that is not owner/repo", async () => {
    expect((await rejection(run({ workspaces: ["srv/app"] }))).code).toBe(
      CLI_ERROR_CODES.INVALID_ARGUMENT,
    );
    for (const repo of ["acme", "acme/app/extra", "/app", "acme/"]) {
      expect((await rejection(run({ repos: [repo] }))).code).toBe(
        CLI_ERROR_CODES.INVALID_ARGUMENT,
      );
    }
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("refuses an empty message", async () => {
    expect((await rejection(run({ message: "  " }))).code).toBe(
      CLI_ERROR_CODES.INVALID_ARGUMENT,
    );
  });

  it("stops at the missing sign-in before resolving the host or writing a record", async () => {
    authMock.mockResolvedValue(null);
    const error = await rejection(run({ idempotencyKey: "slot-1" }));
    expect(error.code).toBe(CLI_ERROR_CODES.AUTH_NO_CREDENTIALS);
    expect(endpointMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
    expect(await recordFiles()).toEqual([]);
  });
});

describe("task create: a host too old for the local-first create", () => {
  it("says to update the host, and clears the key so a retry after the update creates", async () => {
    rpcMock.mockRejectedValueOnce(
      new HostMethodVersionUnsatisfiedError({
        requirement: { method: "epic.create", version: { major: 1, minor: 1 } },
        negotiated: { major: 1, minor: 0 },
        requestId: "req-1",
        method: "epic.create",
        hostId: "host-1",
      }),
    );
    const error = await rejection(run({ idempotencyKey: "slot-1" }));
    expect(error.code).toBe(CLI_ERROR_CODES.HOST_INCOMPATIBLE);
    expect(error.message).toContain("traycer host update");
    expect(await recordFiles()).toEqual([]);

    const result = await run({ idempotencyKey: "slot-1" });
    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(result.exitCode).toBe(0);
  });
});

describe("task create --idempotency-key", () => {
  it("returns the first run's ids with alreadyCreated for a second run of the same key", async () => {
    const first = await run({ idempotencyKey: "slot-1" });
    const second = await run({ idempotencyKey: "slot-1" });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(second.data).toEqual({
      ...(first.data as Record<string, unknown>),
      alreadyCreated: true,
    });
    expect(second.exitCode).toBe(0);
  });

  it("gives two concurrent runs of one key one Task: the second waits on the lock and reads done", async () => {
    let answer = (): void => undefined;
    rpcMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(CREATED);
        }),
    );
    const first = run({ idempotencyKey: "slot-1" });
    await vi.waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    const second = run({ idempotencyKey: "slot-1" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    answer();
    const [a, b] = await Promise.all([first, second]);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(b.data).toEqual({
      ...(a.data as Record<string, unknown>),
      alreadyCreated: true,
    });
  });

  it("refuses the same key with different inputs, sending nothing", async () => {
    await run({ idempotencyKey: "slot-1" });
    const error = await rejection(
      run({ idempotencyKey: "slot-1", message: "Something else" }),
    );
    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("exits non-zero naming the ids and the record for an intent with no done, without a send", async () => {
    const path = taskCreateKeyRecordPath(keysDir.current, "u1", "slot-1");
    await writeTaskCreateKey(path, {
      state: "intent",
      taskId: "task-crashed",
      agentId: "chat-crashed",
      fingerprint: "unused",
      writtenAt: Date.now(),
    });
    const error = await rejection(run({ idempotencyKey: "slot-1" }));
    expect(error.code).toBe(CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN);
    expect(error.message).toContain("task-crashed");
    expect(error.message).toContain("chat-crashed");
    expect(error.message).toContain(path);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("creates past a record older than 24 hours", async () => {
    const path = taskCreateKeyRecordPath(keysDir.current, "u1", "slot-1");
    await writeTaskCreateKey(path, {
      state: "intent",
      taskId: "task-old",
      agentId: "chat-old",
      fingerprint: "unused",
      writtenAt: Date.now() - 25 * 60 * 60 * 1000,
    });
    const result = await run({ idempotencyKey: "slot-1" });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({ alreadyCreated: false });
  });

  it("writes no record when the host is not running, so the retry after it starts creates", async () => {
    endpointMock.mockRejectedValueOnce(
      new CliError({
        code: CLI_ERROR_CODES.HOST_NOT_RUNNING,
        message: "traycer: host not running",
        details: null,
        exitCode: 1,
      }),
    );
    const error = await rejection(run({ idempotencyKey: "slot-1" }));
    expect(error.code).toBe(CLI_ERROR_CODES.HOST_NOT_RUNNING);
    expect(await recordFiles()).toEqual([]);
    expect((await run({ idempotencyKey: "slot-1" })).exitCode).toBe(0);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("clears the key on the typed local-store refusal, so the retry after recovery creates", async () => {
    rpcMock.mockResolvedValueOnce({
      roomInfo: null,
      refusal: {
        kind: "local-store-unavailable",
        message: "Another Traycer host holds this store.",
        remedy: "Stop the other host, then try again.",
      },
    });
    const error = await rejection(run({ idempotencyKey: "slot-1" }));
    expect(error.message).toContain("Another Traycer host holds this store.");
    expect(error.message).toContain("Stop the other host, then try again.");
    expect(await recordFiles()).toEqual([]);
    expect((await run({ idempotencyKey: "slot-1" })).exitCode).toBe(0);
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it("dispatches on the preflighted host and clears the key on a failure proven to precede the frame", async () => {
    rpcMock.mockRejectedValueOnce(
      new RetryableTransportError({
        code: "RPC_ERROR",
        message: "dial failed",
        requestId: "req-1",
        method: "epic.create",
        fatalDetails: null,
        replaySafetyFromKey: false,
      }),
    );
    const error = await rejection(run({ idempotencyKey: "slot-1" }));
    expect(error.code).toBe(CLI_ERROR_CODES.HOST_UNREACHABLE);
    expect(endpointMock).toHaveBeenCalledTimes(1);
    expect(rpcMock.mock.calls[0][2]).toEqual(ENDPOINT);
    expect(await recordFiles()).toEqual([]);
  });

  it.each([
    [
      "a host error after the resolver may have committed",
      new HostRpcError({
        code: "RPC_ERROR",
        message: "response failed validation",
        requestId: "req-1",
        method: "epic.create",
        fatalDetails: null,
      }),
    ],
    [
      "a lost response",
      new HostTransportFailureError({
        code: "RPC_ERROR",
        message: "connection closed",
        requestId: "req-1",
        method: "epic.create",
        fatalDetails: null,
      }),
    ],
    [
      "a retry episode whose earlier attempt was sent",
      new RetryEpisodeOutcomeUnknownError(
        new HostMethodVersionUnsatisfiedError({
          requirement: {
            method: "epic.create",
            version: { major: 1, minor: 1 },
          },
          negotiated: { major: 1, minor: 0 },
          requestId: "req-2",
          method: "epic.create",
          hostId: "host-1",
        }),
      ),
    ],
  ])(
    "keeps the intent after %s, and the retry refuses",
    async (_label, cause) => {
      rpcMock.mockRejectedValueOnce(cause);
      await rejection(run({ idempotencyKey: "slot-1" }));
      const [file] = await recordFiles();
      const written = JSON.parse(
        await readFile(join(keysDir.current, file), "utf8"),
      ) as { state: string; taskId: string };
      expect(written.state).toBe("intent");
      expect(written.taskId).toBe(sentRequest(0).epic.id);

      const retry = await rejection(run({ idempotencyKey: "slot-1" }));
      expect(retry.code).toBe(CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN);
      expect(retry.message).toContain(sentRequest(0).epic.id);
      expect(rpcMock).toHaveBeenCalledTimes(1);
    },
  );

  it("sends nothing when the intent cannot be written", async () => {
    writeKeyMock.mockRejectedValueOnce(new Error("EROFS"));
    await expect(run({ idempotencyKey: "slot-1" })).rejects.toThrow();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("names the created Task and the record when the done record cannot be written", async () => {
    writeKeyMock
      .mockImplementationOnce(
        (
          await vi.importActual<typeof import("../../store/task-create-keys")>(
            "../../store/task-create-keys",
          )
        ).writeTaskCreateKey,
      )
      .mockRejectedValueOnce(new Error("ENOSPC"));
    const error = await rejection(run({ idempotencyKey: "slot-1" }));
    const sent = sentRequest(0);
    expect(error.message).toContain(sent.epic.id);
    expect(error.message).toContain(
      taskCreateKeyRecordPath(keysDir.current, "u1", "slot-1"),
    );
    expect(error.details).toMatchObject({ taskId: sent.epic.id });
  });

  it("does not tell the user to delete a done record the failed write already made visible", async () => {
    const { writeTaskCreateKey: realWrite } = await vi.importActual<
      typeof import("../../store/task-create-keys")
    >("../../store/task-create-keys");
    // The atomic write renames the done record into place, then fails the
    // folder fsync, as EIO or ENOSPC can.
    writeKeyMock
      .mockImplementationOnce(realWrite)
      .mockImplementationOnce(async (path, record) => {
        await realWrite(path, record);
        throw new Error("EIO");
      });
    const error = await rejection(run({ idempotencyKey: "slot-1" }));
    const sent = sentRequest(0);
    expect(error.message).toContain(sent.epic.id);
    expect(error.message).not.toMatch(/delete/i);
    expect(error.details).toMatchObject({ taskId: sent.epic.id });

    const path = taskCreateKeyRecordPath(keysDir.current, "u1", "slot-1");
    const written = JSON.parse(await readFile(path, "utf8")) as {
      state: string;
    };
    expect(written.state).toBe("done");
    const rerun = await run({ idempotencyKey: "slot-1" });
    expect(rerun.data).toMatchObject({
      taskId: sent.epic.id,
      alreadyCreated: true,
    });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("clears an intent the failed write already made visible, so the rerun creates", async () => {
    const { writeTaskCreateKey: realWrite } = await vi.importActual<
      typeof import("../../store/task-create-keys")
    >("../../store/task-create-keys");
    // The atomic write renames the intent into place, then fails the folder
    // fsync: the command stops before any send.
    writeKeyMock.mockImplementationOnce(async (path, record) => {
      await realWrite(path, record);
      throw new Error("EIO");
    });
    await expect(run({ idempotencyKey: "slot-1" })).rejects.toThrow("EIO");
    expect(rpcMock).not.toHaveBeenCalled();
    expect(await recordFiles()).toEqual([]);

    const rerun = await run({ idempotencyKey: "slot-1" });
    expect(rerun.data).toMatchObject({ alreadyCreated: false });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("does not tell the user to delete a record it cannot read back after a failed done write", async () => {
    const { writeTaskCreateKey: realWrite } = await vi.importActual<
      typeof import("../../store/task-create-keys")
    >("../../store/task-create-keys");
    writeKeyMock
      .mockImplementationOnce(realWrite)
      .mockImplementationOnce(async (path) => {
        await writeFile(path, "{torn");
        throw new Error("EIO");
      });
    const error = await rejection(run({ idempotencyKey: "slot-1" }));
    expect(error.message).toContain(sentRequest(0).epic.id);
    expect(error.message).not.toMatch(/delete/i);
  });
});

describe("task create: a refusal answered after an earlier send", () => {
  it("keeps the intent when the send's first attempt may have committed and a retry is refused", async () => {
    const send = realSend.call;
    if (send === null) throw new Error("real send path not captured");
    rpcMock.mockImplementationOnce(send);
    // Attempt A went out under the negotiated key and its answer was lost:
    // the host may have committed the Task. A retry, if one is made, finds
    // the host's store unavailable and answers the typed refusal as data.
    socketRequest
      .mockRejectedValueOnce(
        new RetryableTransportError({
          code: "RPC_ERROR",
          message: "connection closed after the request was sent",
          requestId: "req-a",
          method: "epic.create",
          fatalDetails: null,
          replaySafetyFromKey: true,
        }),
      )
      .mockResolvedValueOnce({
        roomInfo: null,
        refusal: {
          kind: "local-store-unavailable",
          message: "Another Traycer host holds this store.",
          remedy: "Stop the other host, then try again.",
        },
      });

    await rejection(run({ idempotencyKey: "slot-1" }));

    const path = taskCreateKeyRecordPath(keysDir.current, "u1", "slot-1");
    const written = JSON.parse(await readFile(path, "utf8")) as {
      state: string;
    };
    expect(written.state).toBe("intent");
    const retry = await rejection(run({ idempotencyKey: "slot-1" }));
    expect(retry.code).toBe(CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN);
  });

  it("refreshes an expired sign-in the host refused before the request frame, and creates", async () => {
    const send = realSend.call;
    if (send === null) throw new Error("real send path not captured");
    rpcMock.mockImplementationOnce(send);
    storeRotate.mockResolvedValueOnce({
      outcome: "applied",
      credentials: { token: "tok-2" },
    });
    // The host refused the open frame's bearer: nothing was dispatched.
    socketRequest
      .mockRejectedValueOnce(
        new HostRpcError({
          code: "UNAUTHORIZED",
          message: "bearer expired",
          requestId: "req-a",
          method: "epic.create",
          fatalDetails: {
            code: "UNAUTHORIZED",
            reason: "bearer expired",
            incompatibleMethods: null,
            upgradeGuidance: null,
          },
        }),
      )
      .mockResolvedValueOnce(CREATED);

    const result = await run({ idempotencyKey: "slot-1" });

    expect(result.data).toMatchObject({ alreadyCreated: false });
    expect(socketRequest).toHaveBeenCalledTimes(2);
    expect(storeRotate).toHaveBeenCalledTimes(1);
    const path = taskCreateKeyRecordPath(keysDir.current, "u1", "slot-1");
    const written = JSON.parse(await readFile(path, "utf8")) as {
      state: string;
    };
    expect(written.state).toBe("done");
  });

  it("keeps the intent when a sent attempt ends UNAUTHORIZED, and sends nothing after a refreshed sign-in", async () => {
    const send = realSend.call;
    if (send === null) throw new Error("real send path not captured");
    rpcMock.mockImplementationOnce(send);
    storeRotate.mockResolvedValueOnce({
      outcome: "applied",
      credentials: { token: "tok-2" },
    });
    // The session went fatal UNAUTHORIZED with the request pending, so the
    // host may have committed the Task. A send after a refreshed sign-in
    // would find the store unavailable and answer the typed refusal.
    const unauthorized = new HostRpcError({
      code: "UNAUTHORIZED",
      message: "session expired with the request pending",
      requestId: "req-a",
      method: "epic.create",
      fatalDetails: null,
    });
    markMayHaveReachedHost(unauthorized);
    socketRequest.mockRejectedValueOnce(unauthorized).mockResolvedValueOnce({
      roomInfo: null,
      refusal: {
        kind: "local-store-unavailable",
        message: "Another Traycer host holds this store.",
        remedy: "Stop the other host, then try again.",
      },
    });

    const error = await rejection(run({ idempotencyKey: "slot-1" }));

    const path = taskCreateKeyRecordPath(keysDir.current, "u1", "slot-1");
    expect(error.message).toContain(path);
    expect(socketRequest).toHaveBeenCalledTimes(1);
    const written = JSON.parse(await readFile(path, "utf8")) as {
      state: string;
    };
    expect(written.state).toBe("intent");
  });
});

describe("task create: input errors name the flag, never echo the value", () => {
  it.each([
    ["--workspace", { workspaces: ["relative/private-token\n[INFO] forged"] }],
    ["--repo", { repos: ["acme/private-token/x\n[INFO] forged"] }],
  ] as const)("does not echo a raw %s value", async (flag, overrides) => {
    const error = await rejection(run(overrides));
    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(error.message).toContain(flag);
    expect(error.message).not.toContain("private-token");
    expect(error.message).not.toContain("\n");
  });
});
