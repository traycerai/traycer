import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import type { HostTokenTable } from "@traycer-clients/shared/auth/host-token-store";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAME_TIMEOUT_MS } from "../../internal/host-rpc";
import {
  BOT_SNAPSHOT_DEADLINE_MS,
  openLocalStreamClient,
  readBotSnapshot,
} from "../../internal/bot-host";
import { CLI_ERROR_CODES } from "../../runner/errors";
import { buildWorktreeDeleteCommand } from "../worktree-delete";
import { waitForBotReply } from "../bot-post";
import { buildBotListCommand } from "../bot-list";
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
const HELD_TOKEN = "pre-open-held-host-token";
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
      /** What refreshing the stored sign-in answers. */
      refresh: "network-error" as "network-error" | "rotated" | "rejected",
      /** What authn answers a host-only token mint with. */
      grantResponse: (): Promise<Response> =>
        new Promise<Response>(() => undefined),
    },
    /** The host's unary answers `traycer bot list` asks for before it opens its reads. */
    callHostRpc: vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
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

vi.mock("../../internal/host-rpc", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-rpc")>();
  return { ...actual, callHostRpc: harness.callHostRpc };
});

vi.mock(
  "@traycer-clients/shared/host-client/host-ownership",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-ownership")
      >();
    return {
      ...actual,
      readHostOwnershipViaHttp: async () => ({ kind: "not-found" as const }),
    };
  },
);

vi.mock("../../internal/sign-in-environments", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../internal/sign-in-environments")
    >();
  return {
    ...actual,
    readSignInEnvironments: async () => [
      {
        environmentId: "env-personal",
        ownerKind: "organization" as const,
        ownerId: "owner-personal",
        label: "Personal",
      },
    ],
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
      revalidateCurrentContext: async () => harness.state.refresh,
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
  harness.state.refresh = "network-error";
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

const NOT_A_MEMBER_SENTENCE =
  "traycer: This computer belongs to a team. This account is not a member. Switch accounts to use Traycer here. Run `traycer login` to switch accounts.";

const OLDER_HOST_SENTENCE =
  "The host is out of date. Reinstall the latest host with 'traycer host update'.";

/** The reasons a released host gives for refusing a credential. */
const RELEASED_REASONS = [
  "Authenticated user does not own this host",
  "Host is not provisioned - run `traycer login` on the host machine to authorize it",
  "Token has been revoked",
] as const;

/** A released host's refusal: bare, with no door reason, naming its own reason. */
function releasedRefusalWith(reason: string): Record<string, unknown> {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

/**
 * Refuses every OPEN the stream writes, as a released host does, until the
 * command settles: the host-only token, the placeholder and the sign-in.
 */
async function refuseEveryOpenBare(
  reason: string,
  settled: Promise<unknown>,
): Promise<void> {
  const handled = new Set<Socket>();
  for (let step = 0; step < 40; step += 1) {
    const done = await Promise.race([
      settled.then(() => true),
      Promise.resolve(false),
    ]);
    if (done) return;
    await vi.advanceTimersByTimeAsync(500);
    for (const socket of harness.sockets) {
      if (handled.has(socket) || socket.onopen === null) continue;
      handled.add(socket);
      socket.fireOpen();
      await vi.advanceTimersByTimeAsync(0);
      socket.fireFrame(releasedRefusalWith(reason));
    }
  }
}

/** A current team host's host-only token, held and unexpired: the first OPEN carries it and no mint starts. */
function holdUsableHostToken(): void {
  harness.state.hostTokenTable = new Map([
    [
      USER_ID,
      new Map([
        [
          harness.state.hostId,
          { token: HELD_TOKEN, expiresAtMs: Date.now() + 60 * 60 * 1000 },
        ],
      ]),
    ],
  ]);
}

/** A current team host names why it refuses a non-member; a refusal with no reason is an older host's. */
function teamAdmissionRefusal(
  code: "TEAM_MEMBERSHIP_UNAVAILABLE" | "TEAM_MEMBERSHIP_REQUIRED",
  retryable: boolean,
  doorReason: "not_admitted" | "membership_removed" | null,
): Record<string, unknown> {
  return {
    kind: "fatalError",
    details: {
      code,
      reason: "team admission",
      retryable,
      incompatibleMethods: null,
      upgradeGuidance: null,
      ...(doorReason === null ? {} : { doorReason }),
    },
  };
}

/** The host refuses this socket's OPEN with a team admission failure. */
async function refuseOpenWith(
  index: number,
  refusal: Record<string, unknown>,
): Promise<void> {
  const socket = await socketAt(index);
  socket.fireOpen();
  await vi.advanceTimersByTimeAsync(0);
  expect(openToken(socket)).toBe(HELD_TOKEN);
  socket.fireFrame(refusal);
}

/** The host admits this socket's OPEN carrying `token`, serving every method but `manifestOmitting`. */
async function ackOpenCarrying(
  index: number,
  token: string,
  manifestOmitting: string | null,
): Promise<void> {
  const socket = await socketAt(index);
  socket.fireOpen();
  await vi.advanceTimersByTimeAsync(0);
  const open = framesOfKind(socket, "open")[0];
  if (open === undefined) throw new Error("open frame missing");
  expect(open.token).toBe(token);
  socket.fireFrame({
    kind: "openAck",
    manifest: withoutMethod(open.manifest, manifestOmitting),
    optionalManifest: open.optionalManifest,
  });
  await vi.advanceTimersByTimeAsync(0);
}

/** As {@link ackOpenCarrying}; resolves with the subscribe frame the command then sends. */
async function admitOpenCarrying(
  index: number,
  token: string,
): Promise<Record<string, unknown>> {
  await ackOpenCarrying(index, token, null);
  const socket = await socketAt(index);
  await vi.waitFor(
    () => expect(framesOfKind(socket, "subscribe")).toHaveLength(1),
    WAIT,
  );
  const subscribe = framesOfKind(socket, "subscribe")[0];
  if (subscribe === undefined) throw new Error("subscribe frame missing");
  return subscribe;
}

/** The manifest this client sent, minus one method: a host that does not serve it. */
function withoutMethod(manifest: unknown, method: string | null): unknown {
  if (method === null) return manifest;
  if (typeof manifest !== "object" || manifest === null)
    throw new Error("manifest was not an object");
  return Object.fromEntries(
    Object.entries(manifest).filter(([name]) => name !== method),
  );
}

async function stillWaiting<T>(settled: Promise<T>): Promise<void> {
  expect(await Promise.race([settled, Promise.resolve("waiting")])).toBe(
    "waiting",
  );
}

/** Every socket the stream dials within `totalMs` is refused the same way, as a host still unable to reach the cloud would. */
async function refuseEveryOpenFor(
  totalMs: number,
  refusal: Record<string, unknown>,
): Promise<void> {
  const stepMs = 500;
  const refused = new Set<Socket>();
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
    for (const socket of harness.sockets) {
      if (refused.has(socket) || socket.onopen === null) continue;
      refused.add(socket);
      socket.fireOpen();
      await vi.advanceTimersByTimeAsync(0);
      socket.fireFrame(refusal);
    }
  }
}

const TEAM_UNAVAILABLE_SENTENCE =
  "could not reach the cloud to check team membership";

/** A current personal host names `owner_sign_in` to the probe: the person's own sign-in is invited. */
function ownerSignInRefusal(): Record<string, unknown> {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "current personal host invited sign-in",
      doorReason: "owner_sign_in",
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function notAdmittedRefusal(): Record<string, unknown> {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "the host has not admitted this sign-in",
      doorReason: "not_admitted",
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

/** A mint authn takes and has not answered: the test answers it when it chooses. */
interface HeldMint {
  readonly answer: (response: Response) => void;
  readonly requested: () => boolean;
}

function holdMint(): HeldMint {
  const held: {
    resolve: (response: Response) => void;
    asked: boolean;
  } = { resolve: () => undefined, asked: false };
  harness.state.grantResponse = () =>
    new Promise<Response>((resolve) => {
      held.asked = true;
      held.resolve = resolve;
    });
  return {
    answer: (response) => held.resolve(response),
    requested: () => held.asked,
  };
}

/**
 * No token is held and the mint is pending. The probe gets `owner_sign_in`,
 * and the invited sign-in's OPEN is written: this resolves with that socket,
 * before any `openAck` or refusal of it.
 */
async function writeInvitedSignInOpen(mint: HeldMint): Promise<Socket> {
  const probe = await socketAt(0);
  probe.fireOpen();
  await vi.advanceTimersByTimeAsync(0);
  expect(openToken(probe)).toBe(NO_HOST_TOKEN_PROBE);
  await vi.waitFor(() => expect(mint.requested()).toBe(true), WAIT);
  probe.fireFrame(ownerSignInRefusal());
  const invited = await socketAt(1);
  invited.fireOpen();
  await vi.advanceTimersByTimeAsync(0);
  expect(openToken(invited)).toBe(SIGN_IN);
  return invited;
}

const MINT_HAS_NO_ROW = (): Response => new Response("no row", { status: 404 });

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

describe("a mint's not-admitted against a current personal host's invited sign-in", () => {
  const TARGET_COMPLETE = {
    kind: "target.complete",
    worktreePath: "/wt/x",
    deleted: true,
    hasBinaryPayload: false,
  };

  it("lets the delete go on when the mint's 404 lands after the invited OPEN and before its ack", async () => {
    const mint = holdMint();
    const settled = settledOf(
      buildWorktreeDeleteCommand({ worktreePath: "/wt/x" })(makeCtx()),
    );
    await writeInvitedSignInOpen(mint);

    mint.answer(MINT_HAS_NO_ROW());
    await vi.advanceTimersByTimeAsync(0);
    await stillWaiting(settled);
    const subscribe = await admitSignIn(1);
    expect(subscribe.method).toBe("worktree.deleteBatchByPath");
    (await socketAt(1)).fireFrame(TARGET_COMPLETE);

    const outcome = await settled;
    expect(outcome.error).toBeNull();
    expect(outcome.value?.data).toEqual({
      worktreePath: "/wt/x",
      deleted: true,
    });
  });

  it("lets the bot read go on when the mint's 404 lands after the invited OPEN and before its ack", async () => {
    const mint = holdMint();
    const { client } = await openLocalStreamClient();
    const settled = settledOf(readBotSnapshot(client, BOT_ID_A));
    await writeInvitedSignInOpen(mint);

    mint.answer(MINT_HAS_NO_ROW());
    await vi.advanceTimersByTimeAsync(0);
    await stillWaiting(settled);
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

  it("ends the delete with the mint's line when the invited sign-in is refused and then the 404 lands", async () => {
    const mint = holdMint();
    const settled = settledOf(
      buildWorktreeDeleteCommand({ worktreePath: "/wt/x" })(makeCtx()),
    );
    const invited = await writeInvitedSignInOpen(mint);

    invited.fireFrame(notAdmittedRefusal());
    await vi.advanceTimersByTimeAsync(0);
    mint.answer(MINT_HAS_NO_ROW());

    expect((await settled).error).toMatchObject({
      code: CLI_ERROR_CODES.FORBIDDEN,
    });
  });

  it("ends the bot read with the mint's line when the invited sign-in is refused and then the 404 lands", async () => {
    const mint = holdMint();
    const { client } = await openLocalStreamClient();
    const settled = settledOf(readBotSnapshot(client, BOT_ID_A));
    const invited = await writeInvitedSignInOpen(mint);

    invited.fireFrame(notAdmittedRefusal());
    await vi.advanceTimersByTimeAsync(0);
    mint.answer(MINT_HAS_NO_ROW());

    expect((await settled).error).toMatchObject({
      code: CLI_ERROR_CODES.FORBIDDEN,
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

  it("gets the answer when the mint's 404 lands after the invited OPEN and before its ack", async () => {
    const mint = holdMint();
    const { client, settled } = await startWait();
    await writeInvitedSignInOpen(mint);

    mint.answer(MINT_HAS_NO_ROW());
    await vi.advanceTimersByTimeAsync(0);
    await stillWaiting(settled);
    const subscribe = await admitSignIn(1);
    expect(subscribe.method).toBe("chat.subscribe");
    (await socketAt(1)).fireFrame(answeredSnapshot());

    expect((await settled).value).toMatchObject({ kind: "replied" });
    client.close("test complete");
  });

  it("ends with the mint's line when the invited sign-in is refused and then the 404 lands", async () => {
    const mint = holdMint();
    const { client, settled } = await startWait();
    const invited = await writeInvitedSignInOpen(mint);

    invited.fireFrame(notAdmittedRefusal());
    await vi.advanceTimersByTimeAsync(0);
    mint.answer(MINT_HAS_NO_ROW());

    expect((await settled).error).toMatchObject({
      code: CLI_ERROR_CODES.FORBIDDEN,
    });
    client.close("test complete");
  });
});

/**
 * A current team host answers an otherwise valid host-token OPEN with a
 * retryable `TEAM_MEMBERSHIP_UNAVAILABLE` while its own cloud check is down.
 * Nothing was sent past the OPEN, so the stream redials and a command that is
 * still before its first open waits for that, within its own deadline.
 */
describe("a one-shot command against a team host that cannot yet check membership", () => {
  const TARGET_COMPLETE = {
    kind: "target.complete",
    worktreePath: "/wt/x",
    deleted: true,
    hasBinaryPayload: false,
  };

  beforeEach(() => {
    holdUsableHostToken();
  });

  it("deletes once the next reconnect is admitted, though the first OPEN was refused retryably", async () => {
    const settled = settledOf(
      buildWorktreeDeleteCommand({ worktreePath: "/wt/x" })(makeCtx()),
    );

    await refuseOpenWith(
      0,
      teamAdmissionRefusal("TEAM_MEMBERSHIP_UNAVAILABLE", true, null),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await stillWaiting(settled);
    const subscribe = await admitOpenCarrying(1, HELD_TOKEN);
    expect(subscribe.method).toBe("worktree.deleteBatchByPath");
    (await socketAt(1)).fireFrame(TARGET_COMPLETE);

    const outcome = await settled;
    expect(outcome.error).toBeNull();
    expect(outcome.value?.data).toEqual({
      worktreePath: "/wt/x",
      deleted: true,
    });
  });

  it("deletes through the older single-target stream once its next reconnect is admitted", async () => {
    const settled = settledOf(
      buildWorktreeDeleteCommand({ worktreePath: "/wt/x" })(makeCtx()),
    );

    // The host serves no batch delete: the first admitted OPEN says so, and the
    // command opens the single-target stream on a socket of its own.
    await ackOpenCarrying(0, HELD_TOKEN, "worktree.deleteBatchByPath");
    await refuseOpenWith(
      1,
      teamAdmissionRefusal("TEAM_MEMBERSHIP_UNAVAILABLE", true, null),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await stillWaiting(settled);
    const subscribe = await admitOpenCarrying(2, HELD_TOKEN);
    expect(subscribe.method).toBe("worktree.deleteByPath");
    (await socketAt(2)).fireFrame({
      kind: "complete",
      deleted: true,
      hasBinaryPayload: false,
    });

    const outcome = await settled;
    expect(outcome.error).toBeNull();
    expect(outcome.value?.data).toEqual({
      worktreePath: "/wt/x",
      deleted: true,
    });
  });

  it("reads the bot once the next reconnect is admitted", async () => {
    const { client } = await openLocalStreamClient();
    const settled = settledOf(readBotSnapshot(client, BOT_ID_A));

    await refuseOpenWith(
      0,
      teamAdmissionRefusal("TEAM_MEMBERSHIP_UNAVAILABLE", true, null),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await stillWaiting(settled);
    const subscribe = await admitOpenCarrying(1, HELD_TOKEN);
    expect(subscribe.method).toBe("bot.subscribe");
    (await socketAt(1)).fireFrame(
      botSnapshotFrame(botRecord({ botId: BOT_ID_A }), [], 0),
    );

    const outcome = await settled;
    expect(outcome.error).toBeNull();
    expect(outcome.value?.bot.botId).toBe(BOT_ID_A);
    client.close("test complete");
  });

  it("ends the delete with the team-membership sentence when its deadline passes while the host still cannot check", async () => {
    const settled = settledOf(
      buildWorktreeDeleteCommand({ worktreePath: "/wt/x" })(makeCtx()),
    );

    await refuseEveryOpenFor(
      FRAME_TIMEOUT_MS - 2_000,
      teamAdmissionRefusal("TEAM_MEMBERSHIP_UNAVAILABLE", true, null),
    );
    await stillWaiting(settled);
    await refuseEveryOpenFor(
      4_000,
      teamAdmissionRefusal("TEAM_MEMBERSHIP_UNAVAILABLE", true, null),
    );

    expect((await settled).error).toMatchObject({
      code: CLI_ERROR_CODES.TEAM_MEMBERSHIP_UNAVAILABLE,
      message: expect.stringContaining(TEAM_UNAVAILABLE_SENTENCE),
    });
  });

  it("ends the older single-target delete with the team-membership sentence when its deadline passes", async () => {
    const settled = settledOf(
      buildWorktreeDeleteCommand({ worktreePath: "/wt/x" })(makeCtx()),
    );

    await ackOpenCarrying(0, HELD_TOKEN, "worktree.deleteBatchByPath");
    await refuseEveryOpenFor(
      FRAME_TIMEOUT_MS - 2_000,
      teamAdmissionRefusal("TEAM_MEMBERSHIP_UNAVAILABLE", true, null),
    );
    await stillWaiting(settled);
    await refuseEveryOpenFor(
      4_000,
      teamAdmissionRefusal("TEAM_MEMBERSHIP_UNAVAILABLE", true, null),
    );

    expect((await settled).error).toMatchObject({
      code: CLI_ERROR_CODES.TEAM_MEMBERSHIP_UNAVAILABLE,
      message: expect.stringContaining(TEAM_UNAVAILABLE_SENTENCE),
    });
  });

  it("ends the bot read with the team-membership sentence when its deadline passes while the host still cannot check", async () => {
    const { client } = await openLocalStreamClient();
    const settled = settledOf(readBotSnapshot(client, BOT_ID_A));

    await refuseEveryOpenFor(
      BOT_SNAPSHOT_DEADLINE_MS - 2_000,
      teamAdmissionRefusal("TEAM_MEMBERSHIP_UNAVAILABLE", true, null),
    );
    await stillWaiting(settled);
    await refuseEveryOpenFor(
      4_000,
      teamAdmissionRefusal("TEAM_MEMBERSHIP_UNAVAILABLE", true, null),
    );

    expect((await settled).error).toMatchObject({
      code: CLI_ERROR_CODES.TEAM_MEMBERSHIP_UNAVAILABLE,
      message: expect.stringContaining(TEAM_UNAVAILABLE_SENTENCE),
    });
    client.close("test complete");
  });

  // A refusal no retry can answer ends the command at once, with the team's line.
  it.each(["not_admitted", "membership_removed"] as const)(
    "ends the delete at once with the team-membership line on a non-retryable TEAM_MEMBERSHIP_REQUIRED naming %s",
    async (doorReason) => {
      const settled = settledOf(
        buildWorktreeDeleteCommand({ worktreePath: "/wt/x" })(makeCtx()),
      );

      await refuseOpenWith(
        0,
        teamAdmissionRefusal("TEAM_MEMBERSHIP_REQUIRED", false, doorReason),
      );

      expect((await settled).error).toMatchObject({
        code: CLI_ERROR_CODES.TEAM_MEMBERSHIP_REQUIRED,
        message: NOT_A_MEMBER_SENTENCE,
        exitCode: 1,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.sockets).toHaveLength(1);
    },
  );

  it.each(["not_admitted", "membership_removed"] as const)(
    "ends the bot read at once with the team-membership line on a non-retryable TEAM_MEMBERSHIP_REQUIRED naming %s",
    async (doorReason) => {
      const { client } = await openLocalStreamClient();
      const settled = settledOf(readBotSnapshot(client, BOT_ID_A));

      await refuseOpenWith(
        0,
        teamAdmissionRefusal("TEAM_MEMBERSHIP_REQUIRED", false, doorReason),
      );

      expect((await settled).error).toMatchObject({
        code: CLI_ERROR_CODES.TEAM_MEMBERSHIP_REQUIRED,
        message: NOT_A_MEMBER_SENTENCE,
        exitCode: 1,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.sockets).toHaveLength(1);
      client.close("test complete");
    },
  );

  // A guard: a refusal with no reason is an older host's, on c8b3e988 too.
  it("keeps a reasonless TEAM_MEMBERSHIP_REQUIRED on the older-host route", async () => {
    const settled = settledOf(
      buildWorktreeDeleteCommand({ worktreePath: "/wt/x" })(makeCtx()),
    );

    await refuseOpenWith(
      0,
      teamAdmissionRefusal("TEAM_MEMBERSHIP_REQUIRED", false, null),
    );

    expect((await settled).error).toMatchObject({
      message: OLDER_HOST_SENTENCE,
      exitCode: 1,
    });
  });
});

/**
 * A released host answers every OPEN bare: UNAUTHORIZED with its own reason and
 * no door reason, the person's valid sign-in included. The command ends with
 * the line its own code gives that refusal.
 */
describe("a released host that refuses the person's valid sign-in bare", () => {
  it.each(RELEASED_REASONS)(
    "ends the delete with the credential-rejected line: %s",
    async (reason) => {
      harness.state.refresh = "rotated";
      const settled = settledOf(
        buildWorktreeDeleteCommand({ worktreePath: "/wt/x" })(makeCtx()),
      );

      await refuseEveryOpenBare(reason, settled);

      expect((await settled).error).toMatchObject({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message:
          "traycer: host rejected the credential for worktree delete - run `traycer login` and retry.",
        exitCode: 1,
      });
    },
  );

  it.each(RELEASED_REASONS)(
    "ends the bot read with the host's reason: %s",
    async (reason) => {
      const { client } = await openLocalStreamClient();
      const settled = settledOf(readBotSnapshot(client, BOT_ID_A));

      await refuseEveryOpenBare(reason, settled);

      expect((await settled).error).toMatchObject({
        code: CLI_ERROR_CODES.HOST_UNREACHABLE,
        message: `traycer: could not read the bot from this host - ${reason}. Try again.`,
        exitCode: 1,
      });
      client.close("test complete");
    },
  );

  // Guards: a host that named a reason in this process is never handed the sign-in, so
  // its bare refusal of the host-only token is an older host's.
  it("still prints the older-host line for the delete's bare token refusal from a host that named a reason in this process", async () => {
    holdUsableHostToken();
    processReleasedHosts.refusedNamingReason(harness.state.hostId);
    const settled = settledOf(
      buildWorktreeDeleteCommand({ worktreePath: "/wt/x" })(makeCtx()),
    );

    await refuseOpenWith(0, releasedRefusalWith("released-host-token-refusal"));

    expect((await settled).error).toMatchObject({
      message: OLDER_HOST_SENTENCE,
      exitCode: 1,
    });
  });

  it("still prints the older-host line for the bot read's bare token refusal from a host that named a reason in this process", async () => {
    holdUsableHostToken();
    processReleasedHosts.refusedNamingReason(harness.state.hostId);
    const { client } = await openLocalStreamClient();
    const settled = settledOf(readBotSnapshot(client, BOT_ID_A));

    await refuseOpenWith(0, releasedRefusalWith("released-host-token-refusal"));

    expect((await settled).error).toMatchObject({
      message: OLDER_HOST_SENTENCE,
      exitCode: 1,
    });
    client.close("test complete");
  });
});

describe("traycer bot list against a computer whose mint refusal ends the command", () => {
  // A guard: a refusal that ends the command's mint marks each bot it could
  // not read, as c8b3e988 did.
  it("marks each bot it could not read, as c8b3e988 did", async () => {
    harness.state.grantResponse = () =>
      Promise.resolve(
        new Response(JSON.stringify({ code: "team_membership_required" }), {
          status: 403,
        }),
      );
    harness.callHostRpc.mockImplementation(async () => ({
      bots: [botRecord({ botId: BOT_ID_A, title: "Tracy" })],
      mainBotIds: null,
    }));

    const settled = settledOf(buildBotListCommand()(makeCtx()));
    await vi.advanceTimersByTimeAsync(0);

    const outcome = await settled;
    expect(outcome.error).toBeNull();
    expect(outcome.value?.exitCode).toBe(1);
    expect(outcome.value?.data).toMatchObject({
      environments: [{ bots: [{ botId: BOT_ID_A, readFailed: true }] }],
    });
    expect(outcome.value?.human).toContain("could not read Tracy");
  });
});
