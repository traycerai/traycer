import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOT_ID_A,
  CONVERSATION_ID,
  REPLY_MESSAGE_ID,
  REQUEST_ID,
  THREAD_ID,
  chatSnapshotFrame,
  makeCtx,
  skeletonChunkFrame,
  skeletonEntry,
  userRow,
} from "./bot-test-support";
import {
  ANSWERS_AT_ONCE,
  STORED_SIGN_IN,
  WAIT,
  deferred,
  flush,
  openWorld,
  type HomeRef,
  type World,
} from "./expired-host-token-harness";
import { BOT_POST_LISTENER } from "./expired-host-token-members";
import { rpcCalls, seams } from "./expired-host-token-seams";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import type { CliRefusalEnding } from "../../internal/cli-host-tokens";
import { refusalEndingCliError } from "../../internal/host-door-words";
import {
  refusalEndingCommand,
  type BotStreamClient,
} from "../../internal/bot-host";
import { buildBotPostCommand, buildBotReplyCommand } from "../bot-post";
import { CliError } from "../../runner/errors";
import { createOutput } from "../../runner/output";
import {
  runCommand,
  type CommandFn,
  type CommandResult,
} from "../../runner/runner";
import type { RawRunnerFlags } from "../../runner/runtime";

/**
 * `bot post --wait` and `bot reply --wait`, ended by the sign-in gate while a
 * follower waits: the message was sent before the wait, so the command still
 * says so, and what it knows of the reply, before it ends with the gate's
 * error.
 */

const home = vi.hoisted((): HomeRef => ({ path: null }));
/** Every stream client the commands read on, in the order they were dialed. */
const streamClients = vi.hoisted((): unknown[] => []);
const exitCodes = vi.hoisted((): number[] => []);
/** Every ending the gate handed a command before a dial. */
const endingsBeforeDial = vi.hoisted((): unknown[] => []);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.path ?? actual.homedir() };
});
vi.mock("../../logger", async () =>
  (await import("./expired-host-token-seams")).loggerModule(),
);
vi.mock("../../internal/host-rpc", async (importOriginal) =>
  (await import("./expired-host-token-seams")).hostRpcModule(
    await importOriginal<typeof import("../../internal/host-rpc")>(),
  ),
);
// The real dial; the client it hands the command is kept, so a test can read
// the error the gate recorded for it.
vi.mock("../../internal/bot-host", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/bot-host")>();
  const withLocalBotStream: typeof actual.withLocalBotStream = (
    person,
    limit,
    refused,
    read,
  ) =>
    actual.withLocalBotStream(
      person,
      limit,
      (ending, endpoint) => {
        endingsBeforeDial.push(ending);
        return refused(ending, endpoint);
      },
      (client, endpoint, dial) => {
        streamClients.push(client);
        return read(client, endpoint, dial);
      },
    );
  return { ...actual, withLocalBotStream };
});
vi.mock("../../internal/sign-in-environments", async (importOriginal) =>
  (await import("./expired-host-token-seams")).signInEnvironmentsModule(
    await importOriginal<
      typeof import("../../internal/sign-in-environments")
    >(),
  ),
);
vi.mock(
  "@traycer-clients/shared/host-client/host-ownership",
  async (importOriginal) =>
    (await import("./expired-host-token-seams")).hostOwnershipModule(
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-ownership")
      >(),
    ),
);
vi.mock(
  "../../../../shared/host-transport/whatwg-stream-ws-factory",
  async () =>
    (await import("./expired-host-token-seams")).streamFactoryModule(),
);
// The runner records its exit code and leaves the test process running.
vi.mock("../../runner/exit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runner/exit")>()),
  finishAndExit: (code: number) => {
    exitCodes.push(code);
    return Promise.resolve();
  },
}));

let world: World;
let priorStderrIsTTY: PropertyDescriptor | undefined;

beforeEach(async () => {
  streamClients.length = 0;
  exitCodes.length = 0;
  endingsBeforeDial.length = 0;
  priorStderrIsTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  world = await openWorld(home, null);
});

afterEach(async () => {
  await world.close();
  Object.defineProperty(
    process.stderr,
    "isTTY",
    priorStderrIsTTY ?? { value: undefined, configurable: true },
  );
});

/** One `--wait` run, and the follower that is waiting when the gate refuses. */
interface WaitCase {
  readonly title: string;
  readonly command: () => CommandFn;
  /** The chat whose follower is waiting when the gate refuses. */
  readonly waitingChat: string;
  /** All the host sends that follower. */
  readonly waitingFrames: readonly unknown[];
  /** The thread `bot.conversation.send` names; `null` for a channel answer. */
  readonly sendThreadId: string | null;
  /**
   * The first open is refused as retryable, so a command with one follower
   * opens a second time, and that open asks for a mint.
   */
  readonly retriesFirstOpen: boolean;
  /** The chats subscribed by the time the command ends. */
  readonly subscribed: readonly string[];
  /** What the command prints before it ends. */
  readonly printed: string;
  /** The ended command's `details`. */
  readonly details: Record<string, unknown>;
}

const SENT = {
  botId: BOT_ID_A,
  conversationId: CONVERSATION_ID,
  messageId: "msg-sent",
  requestId: REQUEST_ID,
  threadId: THREAD_ID,
  delivery: "written",
};
const POSTED_LINE = `Posted to Tracy (request ${REQUEST_ID}, thread ${THREAD_ID}, delivered).`;
const REPLIED_IN_LINE = `Replied in Tracy's thread ${THREAD_ID} (request ${REQUEST_ID}, delivered).`;

const postCommand = (): CommandFn =>
  buildBotPostCommand({ bot: BOT_ID_A, text: "ship it", wait: "30s" });

/** The channel has resolved the post; the thread's follower waits. */
const POST_REPLY_KNOWN: WaitCase = {
  title: "bot post --wait, the reply id known",
  command: postCommand,
  waitingChat: THREAD_ID,
  waitingFrames: [],
  sendThreadId: THREAD_ID,
  retriesFirstOpen: false,
  subscribed: [CONVERSATION_ID, THREAD_ID],
  printed: `${POSTED_LINE}\nTracy replied (message ${REPLY_MESSAGE_ID}).`,
  details: {
    ...SENT,
    outcome: {
      kind: "replied",
      replyMessageId: REPLY_MESSAGE_ID,
      text: null,
    },
  },
};

/** The channel's follower waits: no reply is known. */
const POST_FIRST_FOLLOW: WaitCase = {
  title: "bot post --wait, during the first follower",
  command: postCommand,
  waitingChat: CONVERSATION_ID,
  waitingFrames: [],
  sendThreadId: THREAD_ID,
  retriesFirstOpen: true,
  subscribed: [CONVERSATION_ID],
  printed: POSTED_LINE,
  details: SENT,
};

/** The thread's one follower waits. */
const REPLY_WAIT: WaitCase = {
  title: "bot reply --wait",
  command: () =>
    buildBotReplyCommand({
      bot: BOT_ID_A,
      threadId: THREAD_ID,
      text: "and the docs?",
      wait: "30s",
    }),
  waitingChat: THREAD_ID,
  waitingFrames: [],
  sendThreadId: THREAD_ID,
  retriesFirstOpen: true,
  subscribed: [THREAD_ID],
  printed: REPLIED_IN_LINE,
  details: SENT,
};

const CASES: readonly WaitCase[] = [
  POST_REPLY_KNOWN,
  POST_FIRST_FOLLOW,
  REPLY_WAIT,
];

type GateEnding = "sign-in-rejected" | "not-a-member";

function chatIdOf(params: unknown): unknown {
  return (params as { readonly chatId?: unknown }).chatId;
}

/** The shared post member's reads, with the thread the send names. */
function prepareSend(threadId: string | null): void {
  BOT_POST_LISTENER.prepare(world);
  const route = seams.rpc;
  seams.rpc = async (method, params) => {
    const answer = await route(method, params);
    return method === "bot.conversation.send"
      ? { ...(answer as object), threadId }
      : answer;
  };
}

/**
 * Starts `start` against a host that admits the held, expired token while
 * authn has not answered, and has the mint refused with `ending` once the
 * case's follower is waiting.
 */
async function refusedWhileWaiting<T>(
  waitCase: WaitCase,
  ending: GateEnding,
  start: () => Promise<T>,
): Promise<T> {
  prepareSend(waitCase.sendThreadId);
  const served = world.host.serve;
  world.host.serve = (method, params) =>
    chatIdOf(params) === waitCase.waitingChat
      ? waitCase.waitingFrames
      : served(method, params);
  world.host.expired = ANSWERS_AT_ONCE("admit");
  if (waitCase.retriesFirstOpen)
    world.host.openAt.set(0, ANSWERS_AT_ONCE("retryable"));
  const run = start();
  // The mint ahead of the dial gets no answer; the next one waits.
  await vi.waitFor(() => expect(world.mint.requests).toHaveLength(1), WAIT);
  world.mint.respond("unavailable");
  world.mint.hold();
  await world.host.whenSubscribed(1);
  await vi.waitFor(() => expect(world.mint.requests).toHaveLength(2), WAIT);
  // The follower reads what it was sent before the refusal can land.
  await flush(50);
  world.mint.respond(ending);
  const result = await run;
  expect(
    world.host.subscribes.map((subscribe) => chatIdOf(subscribe.params)),
  ).toEqual(waitCase.subscribed);
  return result;
}

/** The error the gate recorded for the one client the command read on. */
function gateError(): CliError {
  expect(streamClients).toHaveLength(1);
  const recorded = refusalEndingCommand(streamClients[0] as BotStreamClient);
  if (recorded === null) expect.fail("the gate recorded no refusal");
  return recorded;
}

/** The command run directly: what it threw. */
function thrownBy(waitCase: WaitCase, ending: GateEnding): Promise<unknown> {
  return refusedWhileWaiting(waitCase, ending, () =>
    waitCase
      .command()(world.ctx)
      .then(
        () => null,
        (error: unknown) => error,
      ),
  );
}

const ENDINGS = [
  {
    ending: "sign-in-rejected",
    code: "E_AUTH_REJECTED",
    message:
      "The stored credential was rejected. Run `traycer login` to re-authenticate.",
  },
  {
    ending: "not-a-member",
    code: "E_TEAM_MEMBERSHIP_REQUIRED",
    message:
      "traycer: This computer belongs to a team. This account is not a member. Switch accounts to use Traycer here. Run `traycer login` to switch accounts.",
  },
] as const;

describe("the sign-in gate ends a --wait: what the command prints", () => {
  it.each(ENDINGS)(
    "T1 bot post --wait, reply id known, $ending: the sent line and the reply id, then the gate's error",
    async ({ ending, code, message }) => {
      const thrown = await thrownBy(POST_REPLY_KNOWN, ending);

      expect(thrown).toBeInstanceOf(CliError);
      expect(thrown).toMatchObject({ code, message, exitCode: 1 });
      gateError();
      expect(world.ctx.output.human).toHaveBeenCalledTimes(1);
      expect(world.ctx.output.human).toHaveBeenCalledWith(
        POST_REPLY_KNOWN.printed,
      );
    },
    30_000,
  );

  it.each([
    { name: "T2", waitCase: POST_FIRST_FOLLOW },
    { name: "T3", waitCase: REPLY_WAIT },
  ])(
    "$name $waitCase.title: the sent line alone, then the gate's error",
    async ({ waitCase }) => {
      const [{ ending, code, message }] = ENDINGS;
      const thrown = await thrownBy(waitCase, ending);

      expect(thrown).toBeInstanceOf(CliError);
      expect(thrown).toMatchObject({ code, message, exitCode: 1 });
      gateError();
      expect(world.ctx.output.human).toHaveBeenCalledTimes(1);
      expect(world.ctx.output.human).toHaveBeenCalledWith(waitCase.printed);
    },
    30_000,
  );
});

// ---- through the runner --------------------------------------------------- //

/** Every byte written to the two streams from here on. */
function captureStreams(): { stdout: string[]; stderr: string[] } {
  const written = { stdout: [] as string[], stderr: [] as string[] };
  const into =
    (chunks: string[]) =>
    (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      chunks.push(String(chunk));
      const callback = rest.at(-1);
      if (typeof callback === "function") callback();
      return true;
    };
  vi.spyOn(process.stdout, "write").mockImplementation(into(written.stdout));
  vi.spyOn(process.stderr, "write").mockImplementation(into(written.stderr));
  return written;
}

/** The command run by the real runner: what it threw on the way out. */
async function throughRunner(
  waitCase: WaitCase,
  flags: RawRunnerFlags,
): Promise<unknown> {
  const command = waitCase.command();
  let thrown: unknown = null;
  await refusedWhileWaiting(waitCase, "sign-in-rejected", () =>
    runCommand(async (ctx) => {
      try {
        return await command(ctx);
      } catch (error) {
        thrown = error;
        throw error;
      }
    }, flags),
  );
  return thrown;
}

const HUMAN_FLAGS: RawRunnerFlags = {
  json: false,
  quiet: false,
  noProgress: false,
  noBootstrap: false,
};

describe.each(CASES)("the sign-in gate ends $title", (waitCase) => {
  it.each([
    { terminal: "not a TTY", isTty: false },
    { terminal: "a TTY", isTty: true },
  ])(
    "throws its own copy of the gate's error with the sent data, and stderr ($terminal) is the gate's error's",
    async ({ isTty }) => {
      Object.defineProperty(process.stderr, "isTTY", {
        value: isTty,
        configurable: true,
      });
      const written = captureStreams();
      const thrown = await throughRunner(waitCase, HUMAN_FLAGS);
      const stderr = written.stderr.join("");
      const gate = gateError();

      // What the gate's own error prints, through the same formatter.
      const from = written.stderr.length;
      createOutput(makeCtx().runtime).emitError(
        gate.code,
        gate.message,
        gate.details,
      );
      const expectedStderr = written.stderr.slice(from).join("");

      if (!(thrown instanceof CliError)) expect.fail("no CliError was thrown");
      expect.soft(thrown.code).toBe(gate.code);
      expect.soft(thrown.message).toBe(gate.message);
      expect.soft(thrown.exitCode).toBe(gate.exitCode);
      expect.soft(exitCodes).toEqual([gate.exitCode]);
      expect(expectedStderr).not.toBe("");
      expect.soft(stderr).toBe(expectedStderr);
      // Strict: a key present with an `undefined` value is not an absent key.
      expect.soft(thrown.details).toStrictEqual(waitCase.details);
      expect.soft(thrown).not.toBe(gate);
      expect.soft(gate.details).toBeNull();
    },
    30_000,
  );

  it("--json: the error envelope carries exactly those details", async () => {
    const written = captureStreams();
    const priorDebug = console.debug;
    try {
      await throughRunner(waitCase, { ...HUMAN_FLAGS, json: true });
    } finally {
      console.debug = priorDebug;
    }
    const gate = gateError();
    const results = written.stdout
      .join("")
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.type === "result");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "error" });
    expect(results[0]?.error).toEqual({
      code: gate.code,
      message: gate.message,
      details: waitCase.details,
    });
    expect(exitCodes).toEqual([gate.exitCode]);
  }, 30_000);
});

// ---- T4: the gate ends the command before the dial ------------------------ //

const TERMINALS = [
  { terminal: "not a TTY", isTty: false },
  { terminal: "a TTY", isTty: true },
];

describe.each([POST_FIRST_FOLLOW, REPLY_WAIT])(
  "T4 the sign-in gate ends a --wait before any dial, after the send: $title",
  (waitCase) => {
    it.each(TERMINALS)(
      "prints the sent line, then throws the gate's error with the sent data; stderr ($terminal) is the gate's error's",
      async ({ isTty }) => {
        Object.defineProperty(process.stderr, "isTTY", {
          value: isTty,
          configurable: true,
        });
        const written = captureStreams();
        prepareSend(waitCase.sendThreadId);
        const command = waitCase.command();
        let thrown: unknown = null;
        const printed: unknown[][] = [];
        const run = runCommand(async (ctx) => {
          const human = vi.spyOn(ctx.output, "human");
          try {
            return await command(ctx);
          } catch (error) {
            thrown = error;
            throw error;
          } finally {
            printed.push(...human.mock.calls);
          }
        }, HUMAN_FLAGS);
        // The mint ahead of the dial is the one the sign-in service refuses.
        await vi.waitFor(
          () => expect(world.mint.requests).toHaveLength(1),
          WAIT,
        );
        world.mint.respond("sign-in-rejected");
        await run;
        const stderr = written.stderr.join("");

        expect(
          rpcCalls.filter((method) => method === "bot.conversation.send"),
        ).toHaveLength(1);
        expect(world.host.opens).toHaveLength(0);
        expect(streamClients).toHaveLength(0);
        expect(endingsBeforeDial).toHaveLength(1);
        const gate = refusalEndingCliError(
          endingsBeforeDial[0] as CliRefusalEnding,
        );
        const from = written.stderr.length;
        createOutput(makeCtx().runtime).emitError(
          gate.code,
          gate.message,
          gate.details,
        );
        const expectedStderr = written.stderr.slice(from).join("");

        if (!(thrown instanceof CliError))
          expect.fail("no CliError was thrown");
        expect.soft(thrown.code).toBe(gate.code);
        expect.soft(thrown.message).toBe(gate.message);
        expect.soft(thrown.exitCode).toBe(gate.exitCode);
        expect.soft(exitCodes).toEqual([gate.exitCode]);
        expect(expectedStderr).not.toBe("");
        expect.soft(stderr).toBe(expectedStderr);
        expect.soft(printed).toEqual([[waitCase.printed]]);
        // Strict: a key present with an `undefined` value is not an absent key.
        expect.soft(thrown.details).toStrictEqual(waitCase.details);
      },
      30_000,
    );
  },
);

// ---- T5: the resolution is read, the reply's row is not -------------------- //

/** `chatId` holds the request resolved by a reply, and not that reply's row. */
function resolvedWithoutReplyRow(chatId: string): unknown {
  return chatSnapshotFrame({
    botId: BOT_ID_A,
    conversationId: chatId,
    epoch: 1,
    rowCount: 1,
    indexRevision: null,
    tailFromOrdinal: 0,
    messages: [
      userRow({
        messageId: "msg-sent",
        requestId: REQUEST_ID,
        resolvedAt: 5_000,
        resolvedByMessageId: REPLY_MESSAGE_ID,
      }),
    ],
  });
}

const REPLIED_OUTCOME = {
  kind: "replied",
  replyMessageId: REPLY_MESSAGE_ID,
  text: null,
};

const UNREAD_REPLIES: readonly WaitCase[] = [
  {
    ...REPLY_WAIT,
    title: "bot reply --wait",
    waitingFrames: [resolvedWithoutReplyRow(THREAD_ID)],
    printed: `${REPLIED_IN_LINE}\nTracy replied (message ${REPLY_MESSAGE_ID}).`,
    details: { ...SENT, outcome: REPLIED_OUTCOME },
  },
  {
    ...POST_FIRST_FOLLOW,
    title: "bot post --wait, answered in the channel",
    sendThreadId: null,
    waitingFrames: [resolvedWithoutReplyRow(CONVERSATION_ID)],
    printed: `Posted to Tracy (request ${REQUEST_ID}, answered in the channel, delivered).\nTracy replied (message ${REPLY_MESSAGE_ID}).`,
    details: { ...SENT, threadId: null, outcome: REPLIED_OUTCOME },
  },
];

describe("T5 the sign-in gate ends a --wait that read the resolution, not the reply's row", () => {
  it.each(UNREAD_REPLIES)(
    "$title: names the reply, in the printed line and in the error's details",
    async (waitCase) => {
      const thrown = await thrownBy(waitCase, "sign-in-rejected");
      const gate = gateError();

      if (!(thrown instanceof CliError)) expect.fail("no CliError was thrown");
      expect.soft(thrown.code).toBe(gate.code);
      expect.soft(thrown.message).toBe(gate.message);
      expect.soft(thrown.exitCode).toBe(gate.exitCode);
      expect.soft(world.ctx.output.human).toHaveBeenCalledTimes(1);
      expect
        .soft(world.ctx.output.human)
        .toHaveBeenCalledWith(waitCase.printed);
      expect.soft(thrown.details).toStrictEqual(waitCase.details);
    },
    30_000,
  );
});

// ---- T7: the reply is still known after the follower starts over ---------- //

/** The whole index of `chatId`: the request's row, and no reply row. */
function skeletonWithoutReplyRow(chatId: string): unknown {
  return skeletonChunkFrame({
    botId: BOT_ID_A,
    conversationId: chatId,
    epoch: 1,
    fromOrdinal: 0,
    entries: [skeletonEntry("msg-sent", "user")],
    isFinal: true,
  });
}

describe("T7 the sign-in gate ends a --wait while the follower waits for the one fresh snapshot it asked for", () => {
  it.each(UNREAD_REPLIES)(
    "$title: still names the reply the request row named",
    async (waitCase) => {
      // Each `resnapshot` the host reads, and whether the refusal was still to
      // come then. The host never answers one.
      const resnapshots: { readonly refusalStillOut: boolean }[] = [];
      const heard = world.host.heard.bind(world.host);
      vi.spyOn(world.host, "heard").mockImplementation((socket, frame) => {
        if (frame.kind === "resnapshot")
          resnapshots.push({ refusalStillOut: world.mint.isOut() });
        heard(socket, frame);
      });
      const chatId = waitCase.waitingChat;
      const thrown = await thrownBy(
        {
          ...waitCase,
          waitingFrames: [
            resolvedWithoutReplyRow(chatId),
            skeletonWithoutReplyRow(chatId),
          ],
        },
        "sign-in-rejected",
      );
      const gate = gateError();

      expect(resnapshots).toEqual([{ refusalStillOut: true }]);
      if (!(thrown instanceof CliError)) expect.fail("no CliError was thrown");
      expect.soft(thrown.code).toBe(gate.code);
      expect.soft(thrown.message).toBe(gate.message);
      expect.soft(thrown.exitCode).toBe(gate.exitCode);
      expect.soft(thrown).not.toBe(gate);
      expect.soft(world.ctx.output.human).toHaveBeenCalledTimes(1);
      expect
        .soft(world.ctx.output.human)
        .toHaveBeenCalledWith(waitCase.printed);
      // Strict: a key present with an `undefined` value is not an absent key.
      expect.soft(thrown.details).toStrictEqual(waitCase.details);
    },
    30_000,
  );
});

// ---- T6: the dial after a refused expired token succeeds ------------------- //

const ANSWERED = `${POSTED_LINE}\nTracy replied:\nAll shipped.`;

/** `bot post --wait` until the mint ahead of its first dial got no answer. */
async function startedOnUnavailableMint(): Promise<{
  readonly run: Promise<CommandResult>;
}> {
  const run = postCommand()(world.ctx);
  await vi.waitFor(() => expect(world.mint.requests).toHaveLength(1), WAIT);
  world.mint.respond("unavailable");
  world.mint.hold();
  return { run };
}

function expectOneSuccess(result: CommandResult): void {
  expect(result.human).toBe(ANSWERED);
  expect(result.exitCode).toBe(0);
  expect(world.ctx.output.human).not.toHaveBeenCalled();
}

describe("T6 bot post --wait: the first dial ends unadmitted on token_expired, and the redial's wait succeeds", () => {
  it("returns the success once, prints nothing itself and throws nothing", async () => {
    prepareSend(THREAD_ID);
    const { run } = await startedOnUnavailableMint();
    const result = await run;

    expect(streamClients).toHaveLength(2);
    expect(world.host.opens.map((open) => open.token)).toEqual([
      world.expiredHeld,
      NO_HOST_TOKEN_PROBE,
      STORED_SIGN_IN,
      NO_HOST_TOKEN_PROBE,
      STORED_SIGN_IN,
    ]);
    expectOneSuccess(result);
  }, 30_000);

  it("reports only the redial's end when the gate had ended the first dial's read", async () => {
    // The gate can end a dial that is then dialed again only while the client
    // outlives the host's `token_expired`: here the host marks it retryable.
    // The client's next open is never answered, and the gate ends that dial
    // on the next mint's answer.
    prepareSend(THREAD_ID);
    world.host.openAt.set(0, ANSWERS_AT_ONCE("token-expired-retryable"));
    world.host.openAt.set(1, { answer: "admit", after: deferred().promise });
    world.host.openAt.set(2, ANSWERS_AT_ONCE("admit"));
    world.host.openAt.set(3, ANSWERS_AT_ONCE("admit"));
    const { run } = await startedOnUnavailableMint();
    await vi.waitFor(() => expect(world.host.opens).toHaveLength(2), WAIT);
    await vi.waitFor(() => expect(world.mint.requests).toHaveLength(2), WAIT);
    world.mint.respond("not-a-member");
    // Whatever the redial asks of the mint gets no answer.
    world.mint.hold();
    const result = await run;

    expect(streamClients).toHaveLength(2);
    expect(
      refusalEndingCommand(streamClients[0] as BotStreamClient),
    ).not.toBeNull();
    expect(
      refusalEndingCommand(streamClients[1] as BotStreamClient),
    ).toBeNull();
    expectOneSuccess(result);
  }, 30_000);
});
