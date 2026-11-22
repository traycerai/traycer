import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import type { HostTokenTable } from "@traycer-clients/shared/auth/host-token-store";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAME_TIMEOUT_MS } from "../../internal/host-rpc";
import {
  openLocalStreamClient,
  readBotSnapshot,
} from "../../internal/bot-host";
import { CLI_ERROR_CODES } from "../../runner/errors";
import { buildWorktreeDeleteCommand } from "../worktree-delete";
import { waitForBotReply } from "../bot-post";
import {
  assistantRow,
  BOT_ID_A,
  botRecord,
  botSnapshotFrame,
  chatSnapshotFrame,
  CONVERSATION_ID,
  makeCtx,
  REPLY_MESSAGE_ID,
  REQUEST_ID,
  userRow,
} from "./bot-test-support";

/**
 * Each command here runs its real code over the real stream client, against a
 * released computer that first refuses the placeholder bare and then admits
 * the person's sign-in. A `reconnecting` before the first `open` is the stream
 * finding its credential; after the first `open` it is a drop.
 */

const USER_ID = "pre-open-user";
const SIGN_IN = "pre-open-sign-in";
const WAIT = { timeout: 2_000, interval: 10 };

const harness = vi.hoisted(() => {
  class ScriptSocket {
    readonly sent: string[] = [];
    readonly dialStarted = Promise.resolve();
    onopen: ((event: { readonly type: "open" }) => void) | null = null;
    onmessage:
      | ((
          event:
            | { readonly type: "text"; readonly data: string }
            | { readonly type: "binary"; readonly data: Uint8Array },
        ) => void)
      | null = null;
    onerror: ((event: { readonly message: string }) => void) | null = null;
    onclose:
      | ((event: {
          readonly code: number;
          readonly reason: string;
          readonly wasClean: boolean;
        }) => void)
      | null = null;

    send(data: string | Uint8Array): void {
      if (typeof data === "string") this.sent.push(data);
    }

    close(_code: number, _reason: string): void {}

    fireOpen(): void {
      this.onopen?.({ type: "open" });
    }

    fireFrame(frame: unknown): void {
      this.onmessage?.({ type: "text", data: JSON.stringify(frame) });
    }

    drop(): void {
      this.onclose?.({ code: 1006, reason: "drop", wasClean: false });
    }
  }

  return {
    ScriptSocket,
    sockets: [] as InstanceType<typeof ScriptSocket>[],
    state: {
      hostId: "",
      hostTokenTable: new Map() as HostTokenTable,
      /** What authn answers a host-only token mint with. */
      grantResponse: (): Promise<Response> =>
        new Promise<Response>(() => undefined),
    },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
});

vi.mock("../../internal/host-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-auth")>();
  return {
    ...actual,
    resolveHostAuth: async () => ({
      token: SIGN_IN,
      authnBaseUrl: "https://authn.test",
      userId: USER_ID,
    }),
  };
});

vi.mock("../../logger", () => ({
  createCliLogger: () => harness.logger,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
  noopLogger: harness.logger,
}));

vi.mock("../../host/pid-metadata", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/pid-metadata")>();
  return {
    ...actual,
    readHostPidMetadata: async () => ({
      pid: 1,
      hostId: harness.state.hostId,
      version: "test",
      websocketUrl: "ws://127.0.0.1:9/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: null,
      processStartIdentityRead: "absent",
      layer0: null,
      layer0Slot: null,
    }),
  };
});

vi.mock("../../store/credentials-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials-store")>();
  return {
    ...actual,
    createCliCredentialsStore: () => ({ dispose: () => undefined }),
    createStoreBackedRevalidator: () => ({
      revalidateCurrentContext: async () => "network-error" as const,
    }),
  };
});

vi.mock("../../auth/host-credential-mint", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../auth/host-credential-mint")>();
  return { ...actual, createCliHostCredentialMintFlow: () => null };
});

vi.mock(
  "@traycer-clients/shared/auth/host-token-file",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/auth/host-token-file")
      >();
    return {
      ...actual,
      createHostTokenFilePersistence: () => ({
        load: async () => harness.state.hostTokenTable,
        update: async (
          change: (table: HostTokenTable) => HostTokenTable,
        ): Promise<HostTokenTable> => {
          harness.state.hostTokenTable = change(harness.state.hostTokenTable);
          return harness.state.hostTokenTable;
        },
      }),
    };
  },
);

vi.mock("../../../../shared/host-transport/whatwg-stream-ws-factory", () => ({
  createWhatwgStreamWebSocketFactory: () => ({
    create: () => {
      const socket = new harness.ScriptSocket();
      harness.sockets.push(socket);
      return socket;
    },
  }),
}));

vi.mock("../../runner/std-write", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../runner/std-write")>();
  return { ...actual, writeStderr: () => undefined };
});

type Socket = InstanceType<typeof harness.ScriptSocket>;

let hostCount = 0;

beforeEach(() => {
  vi.useFakeTimers();
  harness.sockets.splice(0);
  harness.state.hostTokenTable = new Map();
  harness.state.grantResponse = () => new Promise<Response>(() => undefined);
  // A named reason is remembered per computer for the whole process.
  hostCount += 1;
  harness.state.hostId = `22222222-2222-4222-8222-${String(hostCount).padStart(12, "0")}`;
  processReleasedHosts.forgetAll();
  vi.stubGlobal(
    "fetch",
    async (
      input: RequestInfo | URL,
      init: RequestInit | undefined,
    ): Promise<Response> => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      );
      if (
        (init?.method ?? "GET") === "POST" &&
        url.pathname.endsWith("/session-grant")
      )
        return harness.state.grantResponse();
      return new Response("not found", { status: 404 });
    },
  );
});

afterEach(() => {
  processReleasedHosts.forgetAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function readObject(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("frame was not an object");
  return Object.fromEntries(Object.entries(value));
}

function framesOfKind(socket: Socket, kind: string): Record<string, unknown>[] {
  return socket.sent
    .map((raw) => readObject(raw))
    .filter((frame) => frame.kind === kind);
}

function openToken(socket: Socket): unknown {
  return framesOfKind(socket, "open")[0]?.token;
}

async function socketAt(index: number): Promise<Socket> {
  await vi.waitFor(
    () => expect(harness.sockets.length).toBeGreaterThan(index),
    WAIT,
  );
  const socket = harness.sockets[index];
  if (socket === undefined) throw new Error("socket missing");
  await vi.waitFor(() => expect(socket.onopen).not.toBeNull(), WAIT);
  return socket;
}

/** The host answers the placeholder as a released computer does: bare, naming nothing. */
async function refuseProbeBare(index: number): Promise<void> {
  const probe = await socketAt(index);
  probe.fireOpen();
  await vi.advanceTimersByTimeAsync(0);
  expect(openToken(probe)).toBe(NO_HOST_TOKEN_PROBE);
  probe.fireFrame({
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "released-host-token-refusal",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

/** The host admits the sign-in; resolves with the subscribe frame the command then sends. */
async function admitSignIn(index: number): Promise<Record<string, unknown>> {
  const socket = await socketAt(index);
  socket.fireOpen();
  await vi.advanceTimersByTimeAsync(0);
  const open = framesOfKind(socket, "open")[0];
  if (open === undefined) throw new Error("open frame missing");
  expect(open.token).toBe(SIGN_IN);
  socket.fireFrame({
    kind: "openAck",
    manifest: open.manifest,
    optionalManifest: open.optionalManifest,
  });
  await vi.waitFor(
    () => expect(framesOfKind(socket, "subscribe")).toHaveLength(1),
    WAIT,
  );
  const subscribe = framesOfKind(socket, "subscribe")[0];
  if (subscribe === undefined) throw new Error("subscribe frame missing");
  return subscribe;
}

function settledOf<T>(
  pending: Promise<T>,
): Promise<{ readonly value: T | null; readonly error: unknown }> {
  return pending.then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error }),
  );
}

describe("traycer worktree delete against a released computer", () => {
  const TARGET_COMPLETE = {
    kind: "target.complete",
    worktreePath: "/wt/x",
    deleted: true,
    hasBinaryPayload: false,
  };

  it("waits out the stream finding its credential and deletes", async () => {
    const pending = buildWorktreeDeleteCommand({ worktreePath: "/wt/x" })(
      makeCtx(),
    );
    const settled = settledOf(pending);

    await refuseProbeBare(0);
    const subscribe = await admitSignIn(1);
    expect(subscribe.method).toBe("worktree.deleteBatchByPath");
    (await socketAt(1)).fireFrame(TARGET_COMPLETE);

    const outcome = await settled;
    expect(outcome.error).toBeNull();
    expect(outcome.value?.data).toEqual({
      worktreePath: "/wt/x",
      deleted: true,
    });
    expect(harness.sockets.map(openToken)).toEqual([
      NO_HOST_TOKEN_PROBE,
      SIGN_IN,
    ]);
  });

  it("ends as a drop when no credential is found within the response deadline", async () => {
    const settled = settledOf(
      buildWorktreeDeleteCommand({ worktreePath: "/wt/x" })(makeCtx()),
    );

    await refuseProbeBare(0);
    await vi.advanceTimersByTimeAsync(FRAME_TIMEOUT_MS - 1_000);
    expect(await Promise.race([settled, Promise.resolve("waiting")])).toBe(
      "waiting",
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect((await settled).error).toMatchObject({
      message: expect.stringContaining("may or may not have been removed"),
    });
  });

  it("still fails at once on a drop after the stream opened, and sends the delete once", async () => {
    const settled = settledOf(
      buildWorktreeDeleteCommand({ worktreePath: "/wt/x" })(makeCtx()),
    );

    await refuseProbeBare(0);
    await admitSignIn(1);
    (await socketAt(1)).drop();

    expect((await settled).error).toMatchObject({
      message: expect.stringContaining("may or may not have been removed"),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const deletes = harness.sockets.flatMap((socket) =>
      framesOfKind(socket, "subscribe"),
    );
    expect(deletes).toHaveLength(1);
  });
});

describe("a bot read against a released computer", () => {
  it("waits out the stream finding its credential and reads the bot", async () => {
    const { client } = await openLocalStreamClient();
    const settled = settledOf(readBotSnapshot(client, BOT_ID_A));

    await refuseProbeBare(0);
    const subscribe = await admitSignIn(1);
    expect(subscribe.method).toBe("bot.subscribe");
    (await socketAt(1)).fireFrame(
      botSnapshotFrame(botRecord({ botId: BOT_ID_A }), [], 0),
    );

    const outcome = await settled;
    expect(outcome.error).toBeNull();
    expect(outcome.value?.bot.botId).toBe(BOT_ID_A);
    client.close("test complete");
  });

  it("still fails at once on a drop after the stream opened", async () => {
    const { client } = await openLocalStreamClient();
    const settled = settledOf(readBotSnapshot(client, BOT_ID_A));

    await refuseProbeBare(0);
    await admitSignIn(1);
    (await socketAt(1)).drop();

    expect((await settled).error).toMatchObject({
      code: CLI_ERROR_CODES.HOST_UNREACHABLE,
      message: expect.stringContaining("could not read the bot"),
    });
    client.close("test complete");
  });

  it("fails with the mint's line when a refusal that ends the command arrives", async () => {
    harness.state.grantResponse = () =>
      Promise.resolve(
        new Response(JSON.stringify({ code: "team_membership_required" }), {
          status: 403,
        }),
      );
    const { client } = await openLocalStreamClient();
    const settled = settledOf(readBotSnapshot(client, BOT_ID_A));

    await vi.advanceTimersByTimeAsync(0);

    expect((await settled).error).toMatchObject({
      code: CLI_ERROR_CODES.TEAM_MEMBERSHIP_REQUIRED,
    });
    client.close("test complete");
  });
});

describe("a bot post's reply wait against a released computer", () => {
  const REPLY_TEXT = "the answer";

  function startWait() {
    return openLocalStreamClient().then(({ client }) => ({
      client,
      settled: settledOf(
        waitForBotReply({
          client,
          botId: BOT_ID_A,
          requestChatId: CONVERSATION_ID,
          replyChatId: null,
          requestId: REQUEST_ID,
          timeoutMs: 60_000,
        }),
      ),
    }));
  }

  /** The conversation already holds the answer: the request resolved by a reply row. */
  function answeredSnapshot() {
    const rows = [
      userRow({
        messageId: "msg-sent",
        requestId: REQUEST_ID,
        resolvedAt: 5_000,
        resolvedByMessageId: REPLY_MESSAGE_ID,
      }),
      assistantRow({ messageId: REPLY_MESSAGE_ID, texts: [REPLY_TEXT] }),
    ];
    return chatSnapshotFrame({
      botId: BOT_ID_A,
      conversationId: CONVERSATION_ID,
      epoch: 1,
      rowCount: rows.length,
      indexRevision: null,
      tailFromOrdinal: 0,
      messages: rows,
    });
  }

  it("gets the answer once the host admits the sign-in, though the mint answered not-admitted first", async () => {
    harness.state.grantResponse = () =>
      Promise.resolve(new Response("no row", { status: 404 }));
    const { client, settled } = await startWait();

    await refuseProbeBare(0);
    const subscribe = await admitSignIn(1);
    expect(subscribe.method).toBe("chat.subscribe");
    (await socketAt(1)).fireFrame(answeredSnapshot());

    const outcome = await settled;
    expect(outcome.error).toBeNull();
    expect(outcome.value).toEqual({
      kind: "replied",
      replyMessageId: REPLY_MESSAGE_ID,
      text: REPLY_TEXT,
    });
    client.close("test complete");
  });

  it("re-subscribes after a drop and still gets the answer", async () => {
    const { client, settled } = await startWait();

    await refuseProbeBare(0);
    await admitSignIn(1);
    (await socketAt(1)).drop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await Promise.race([settled, Promise.resolve("waiting")])).toBe(
      "waiting",
    );
    // The redial starts over: the placeholder, a bare refusal, the sign-in.
    await refuseProbeBare(2);
    await admitSignIn(3);
    (await socketAt(3)).fireFrame(answeredSnapshot());

    expect((await settled).value).toMatchObject({ kind: "replied" });
    client.close("test complete");
  });

  it("rejects at once with the mint's line when a refusal ends the command", async () => {
    harness.state.grantResponse = () =>
      Promise.resolve(
        new Response(JSON.stringify({ code: "team_membership_required" }), {
          status: 403,
        }),
      );
    const { client, settled } = await startWait();

    await vi.advanceTimersByTimeAsync(0);

    expect((await settled).error).toMatchObject({
      code: CLI_ERROR_CODES.TEAM_MEMBERSHIP_REQUIRED,
    });
    client.close("test complete");
  });
});
