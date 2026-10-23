import { randomUUID } from "node:crypto";
import {
  botConversationListResponseSchema,
  botConversationSendRequestSchema,
  botConversationSendResponseSchema,
  type BotConversationRecord,
  type BotConversationSendDelivery,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import {
  openChatSubscribeWindowedServerFrameSchema,
  type ChatSubscribeWindowedClientFrame,
  type OpenChatWindowedSnapshot,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ChatIndexChange,
  ChatSkeletonChunk,
  OpenChatRangeResponse,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import {
  isIncompatibleCloseForMethod,
  type IStreamSession,
  type StreamFrameEnvelope,
} from "@traycer/protocol/host-transport/stream-session";
import type {
  OpenAssistantMessage,
  OpenMessage,
} from "@traycer/protocol/persistence/epic/open-harness-records";
import { TRANSCRIPT_RANGE_MAX_BYTES } from "@traycer/protocol/persistence/chat-transcript/read-range";
import {
  botHostUpdateError,
  findBot,
  type BotStreamClient,
  listBots,
  openLocalStreamClient,
  refuseUnlessBoundHere,
  toBotCliError,
  unreadableStreamError,
} from "../internal/bot-host";
import {
  callHostRpc,
  parseCanonicalHostResponse,
  parseUserInput,
  resolveEndpoint,
} from "../internal/host-rpc";
import { cliError, CLI_ERROR_CODES } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

/** How a `--wait` ended. */
export type BotReplyOutcome =
  | {
      readonly kind: "replied";
      readonly replyMessageId: string;
      /** Null when the reply row could not be read back. */
      readonly text: string | null;
    }
  | { readonly kind: "resolved-without-reply" }
  | { readonly kind: "timed-out" };

/**
 * `traycer bot post <bot> <text>` - a top-level post in the bot's channel
 * (`bot.conversation.send` with no thread). Every post opens a request and a
 * thread the bot answers in; the command prints both ids and whether the post
 * reached the bot now (`written`) or waits for the bot's host to come back
 * (`queued`).
 *
 * `--wait <duration>` then follows the post until the thread's verdict
 * resolves its request, for at most that long: the channel for the post's
 * resolution, and the thread for the reply's text.
 */
export function buildBotPostCommand(opts: {
  readonly bot: string;
  readonly text: string;
  readonly wait: string | null;
}): CommandFn {
  return sendToBot({ ...opts, threadId: null });
}

/**
 * `traycer bot reply <bot> <thread> <text>` - a message in one of the bot's
 * threads (`bot.conversation.send` with `threadId`). It opens a request of its
 * own, whose id the command prints; `--wait <duration>` follows the thread
 * until that request is resolved, and prints the reply.
 */
export function buildBotReplyCommand(opts: {
  readonly bot: string;
  readonly threadId: string;
  readonly text: string;
  readonly wait: string | null;
}): CommandFn {
  return sendToBot(opts);
}

/**
 * The send both commands share. The message goes to the bot's channel - its
 * first conversation, the one created with it - or to `threadId` in it. Only
 * the host the bot runs on can follow its threads, so on any other host
 * `--wait` is refused before anything is sent.
 */
function sendToBot(opts: {
  readonly bot: string;
  readonly threadId: string | null;
  readonly text: string;
  readonly wait: string | null;
}): CommandFn {
  return async () => {
    const waitMs = opts.wait === null ? null : parseWaitDuration(opts.wait);
    const bot = findBot(await listBots(), opts.bot);
    if (waitMs !== null) {
      const endpoint = await resolveEndpoint();
      refuseUnlessBoundHere(
        bot,
        endpoint.hostId,
        `--wait works only there. ${opts.threadId === null ? "Post" : "Reply"} without --wait to queue it.`,
      );
    }
    const conversationId = await channelOf(bot);
    const request = parseUserInput(botConversationSendRequestSchema, {
      botId: bot.botId,
      conversationId,
      text: opts.text,
      threadId: opts.threadId,
    });
    const sent = parseCanonicalHostResponse(
      "bot.conversation.send",
      botConversationSendResponseSchema,
      await toBotCliError(callHostRpc("bot.conversation.send", request)),
    );
    const delivery = describeDelivery(sent.delivery);
    const sentLine =
      opts.threadId === null
        ? `Posted to ${bot.title} (request ${sent.requestId}, thread ${sent.threadId}, ${delivery}).`
        : `Replied in ${bot.title}'s thread ${sent.threadId} (request ${sent.requestId}, ${delivery}).`;
    const sentData = {
      botId: bot.botId,
      conversationId,
      messageId: sent.messageId,
      requestId: sent.requestId,
      threadId: sent.threadId,
      delivery: sent.delivery,
    };
    if (waitMs === null) {
      return { data: sentData, human: sentLine, exitCode: 0 };
    }
    const { client } = await openLocalStreamClient();
    // A post's request is its row on the channel and its answer is on the
    // thread it opened; a thread message's request and answer are both on
    // the thread.
    const outcome = await waitForBotReply({
      client,
      botId: bot.botId,
      requestChatId: opts.threadId === null ? conversationId : sent.threadId,
      replyChatId: opts.threadId === null ? sent.threadId : null,
      requestId: sent.requestId,
      timeoutMs: waitMs,
    }).finally(() => {
      client.close("bot-wait-settled");
    });
    return {
      data: { ...sentData, outcome },
      human: `${sentLine}\n${describeOutcome(bot.title, opts.wait ?? "", outcome)}`,
      exitCode: outcome.kind === "timed-out" ? 1 : 0,
    };
  };
}

function describeDelivery(delivery: BotConversationSendDelivery): string {
  return delivery === "written"
    ? "delivered"
    : "queued until the bot's host is back";
}

function describeOutcome(
  title: string,
  wait: string,
  outcome: BotReplyOutcome,
): string {
  switch (outcome.kind) {
    case "replied":
      return outcome.text === null
        ? `${title} replied (message ${outcome.replyMessageId}).`
        : `${title} replied:\n${outcome.text}`;
    case "resolved-without-reply":
      return `${title} closed the request without a reply.`;
    case "timed-out":
      return `No reply from ${title} within ${wait}. The request stays open.`;
  }
}

/** The bot's channel: its first conversation by creation time. */
async function channelOf(bot: BotRecord): Promise<string> {
  const { conversations } = parseCanonicalHostResponse(
    "bot.conversation.list",
    botConversationListResponseSchema,
    await toBotCliError(
      callHostRpc("bot.conversation.list", { botId: bot.botId }),
    ),
  );
  const first = firstConversation(conversations);
  if (first === null) {
    throw cliError({
      code: CLI_ERROR_CODES.NOT_FOUND,
      message: `traycer: ${bot.title} has no channel yet - open it in the Traycer app first.`,
      details: null,
      exitCode: 1,
    });
  }
  return first.conversationId;
}

export function firstConversation(
  conversations: readonly BotConversationRecord[],
): BotConversationRecord | null {
  let first: BotConversationRecord | null = null;
  for (const conversation of conversations) {
    if (first === null || conversation.createdAt < first.createdAt) {
      first = conversation;
    }
  }
  return first;
}

const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/** The longest wait a single timer can hold (2^31 - 1 ms, about 24 days). */
const MAX_TIMER_MS = 2_147_483_647;

/** `30s`, `5m`, `2h`: a positive whole number and a unit. */
export function parseWaitDuration(value: string): number {
  const match = /^(\d+)([smh])$/.exec(value.trim());
  const ms =
    match === null ? Number.NaN : Number(match[1]) * DURATION_UNIT_MS[match[2]];
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_TIMER_MS) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        "traycer: --wait takes a duration such as 30s, 5m or 2h (at most 24 days).",
      details: null,
      exitCode: 1,
    });
  }
  return ms;
}

/**
 * Follows the chat holding a request over `chat.subscribe` until the user row
 * holding `requestId` is resolved, or `timeoutMs` passes.
 *
 * Resolution is recorded on the user row (`conversationRequest.resolvedAt`,
 * and `resolvedByMessageId` naming the reply). A post's reply is written to
 * the thread the post opened (`replyChatId`), not to the channel holding the
 * post: once the channel says which reply resolved it, the thread is followed
 * for that reply's row, within what is left of the timeout, and a reply not
 * read back by then is reported by its id. Each follower keeps the part of
 * the windowed index it needs - epoch, revision, row count and the skeleton's
 * row ids and roles - so it can tell which rows it has read:
 *
 * - The snapshot's tail holds the newest rows, but it is bounded and can be
 *   empty, so a request or reply row outside it is found through the skeleton
 *   and read with `loadRange`, newest candidate first.
 * - A change arrives as an `indexChanged` naming the rows it touched; their
 *   bodies are read with `loadRange`.
 * - Any sign the index went stale - a skipped revision, rows appended past a
 *   gap, a reindex, a newer epoch, a range whose rows are not the ones asked
 *   for - asks for a fresh snapshot and forgets what was read, so nothing from
 *   a superseded index can settle the wait.
 *
 * A reconnect re-subscribes on its own; the host then sends a fresh snapshot
 * and skeleton, and the follower starts over within the person's timeout.
 */
export async function waitForBotReply(input: {
  readonly client: BotStreamClient;
  readonly botId: string;
  /** The chat holding the request's user row: the channel, or a thread. */
  readonly requestChatId: string;
  /** The chat the reply is written to; `null` when it is `requestChatId`. */
  readonly replyChatId: string | null;
  readonly requestId: string;
  readonly timeoutMs: number;
}): Promise<BotReplyOutcome> {
  const deadline = Date.now() + input.timeoutMs;
  const onRequest = await follow({
    client: input.client,
    botId: input.botId,
    chatId: input.requestChatId,
    requestId: input.requestId,
    timeoutMs: input.timeoutMs,
    target: { kind: "request", replyElsewhere: input.replyChatId !== null },
  });
  if (onRequest.kind !== "resolved-by" || input.replyChatId === null) {
    return onRequest.kind === "resolved-by"
      ? {
          kind: "replied",
          replyMessageId: onRequest.replyMessageId,
          text: null,
        }
      : onRequest;
  }
  const { replyMessageId } = onRequest;
  const onReply = await follow({
    client: input.client,
    botId: input.botId,
    chatId: input.replyChatId,
    requestId: input.requestId,
    timeoutMs: Math.max(1, deadline - Date.now()),
    target: { kind: "reply", replyMessageId },
  });
  // The request is answered either way; only the text can be missing.
  return onReply.kind === "replied"
    ? onReply
    : { kind: "replied", replyMessageId, text: null };
}

/**
 * What one follower looks for: the request row (and, unless the reply is on
 * another chat, the reply that resolved it), or one known reply row.
 */
type FollowTarget =
  | { readonly kind: "request"; readonly replyElsewhere: boolean }
  | { readonly kind: "reply"; readonly replyMessageId: string };

/** A follower's end: an outcome, or the reply id to read from the thread. */
type FollowOutcome =
  | BotReplyOutcome
  | { readonly kind: "resolved-by"; readonly replyMessageId: string };

function follow(input: {
  readonly client: BotStreamClient;
  readonly botId: string;
  readonly chatId: string;
  readonly requestId: string;
  readonly timeoutMs: number;
  readonly target: FollowTarget;
}): Promise<FollowOutcome> {
  return new Promise<FollowOutcome>((resolve, reject) => {
    new ReplyFollower(input, resolve, reject).start();
  });
}

type RequestState =
  | { readonly kind: "unseen" }
  | { readonly kind: "open" }
  | { readonly kind: "resolved"; readonly by: string | null };

/** What the follower knows about one row of the current index. */
interface KnownRow {
  readonly rowId: string;
  readonly role: RowSkeletonEntry["role"];
}

interface OutstandingRange {
  readonly epoch: number;
  readonly toOrdinal: number;
}

class ReplyFollower {
  private settled = false;
  private timer: NodeJS.Timeout | null = null;
  private session: IStreamSession | null = null;

  // ---- the index, as of the last snapshot and the deltas since ---------- //
  private epoch: number | null = null;
  /** The last concrete revision; null until the first one is adopted. */
  private revision: number | null = null;
  private rowCount = 0;
  private readonly rows = new Map<number, KnownRow>();
  private skeletonComplete = false;
  /** Ordinals whose current bodies have been read. */
  private readonly read = new Set<number>();
  /**
   * Ordinals already fetched by the search, so a row the host serves as
   * incomplete is not asked for again until it changes.
   */
  private readonly searched = new Set<number>();
  private readonly outstanding = new Map<string, OutstandingRange>();
  /**
   * A `resnapshot` was sent and its rebuild (a snapshot announcing a fresh
   * index) has not arrived. Anything from the old index still on the wire
   * then finds no epoch to match, and asking again is skipped.
   */
  private awaitingRebuild = false;

  // ---- what the rows read so far say ------------------------------------ //
  /** Reply text by message id. */
  private readonly replies = new Map<string, string>();
  /**
   * The request row as last read: open, or resolved by a reply (or none). A
   * follower of a known reply starts, and starts over, at that reply.
   */
  private request: RequestState;
  /** One fresh snapshot is spent looking for a reply row before giving up. */
  private replyResnapshotSpent = false;

  constructor(
    private readonly input: {
      readonly client: BotStreamClient;
      readonly botId: string;
      readonly chatId: string;
      readonly requestId: string;
      readonly timeoutMs: number;
      readonly target: FollowTarget;
    },
    private readonly resolve: (outcome: FollowOutcome) => void,
    private readonly reject: (error: unknown) => void,
  ) {
    this.request = this.initialRequest();
  }

  private initialRequest(): RequestState {
    return this.input.target.kind === "reply"
      ? { kind: "resolved", by: this.input.target.replyMessageId }
      : { kind: "unseen" };
  }

  start(): void {
    const session = this.input.client.subscribe("chat.subscribe", {
      epicId: this.input.botId,
      chatId: this.input.chatId,
      resume: null,
    });
    this.session = session;
    this.timer = setTimeout(() => {
      this.finish(() => this.resolve({ kind: "timed-out" }));
    }, this.input.timeoutMs);
    session.onServerFrame((envelope) => {
      // A frame already in flight when the wait ended asks for nothing more.
      if (this.settled) return;
      this.onFrame(envelope);
    });
    session.onStatusChange((status, reason) => {
      // A drop re-subscribes on its own and the new snapshot starts over;
      // the person's timeout bounds the wait either way.
      if (
        status !== "closed" ||
        reason === null ||
        reason.kind !== "fatalError"
      )
        return;
      if (
        this.input.client.getMethodSupport("chat.subscribe") ===
          "unsupported" ||
        isIncompatibleCloseForMethod(reason, "chat.subscribe")
      ) {
        this.finish(() => this.reject(botHostUpdateError()));
        return;
      }
      this.finish(() =>
        this.reject(
          cliError({
            code: CLI_ERROR_CODES.HOST_UNREACHABLE,
            message: `traycer: stopped waiting for the answer - ${reason.details.reason}. The message was sent; the request stays open.`,
            details: null,
            exitCode: 1,
          }),
        ),
      );
    });
  }

  private finish(act: () => void): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.session?.close();
    act();
  }

  private onFrame(envelope: StreamFrameEnvelope): void {
    const parsed =
      openChatSubscribeWindowedServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      // Only the frames that carry the index or rows matter here; any other
      // frame this CLI cannot read is not one it is waiting for.
      if (ROW_BEARING_FRAME_KINDS.has(envelope.kind)) {
        this.finish(() => this.reject(unreadableStreamError()));
      }
      return;
    }
    const frame = parsed.data;
    switch (frame.kind) {
      case "snapshot":
        this.onSnapshot(frame.snapshot);
        break;
      case "skeletonChunk":
        this.onSkeletonChunk(frame.chunk);
        break;
      case "indexChanged":
        this.onIndexChanged(frame);
        break;
      case "range":
        this.onRange(frame.range);
        break;
      default:
        return;
    }
    this.advance();
  }

  private onSnapshot(snapshot: OpenChatWindowedSnapshot): void {
    if (snapshot.indexRevision === null) {
      // The host holds no index for this subscriber and streams a fresh
      // skeleton next - a reconnect, a host rebuild, or the answer to a
      // `resnapshot`: start over, and let this snapshot's rows say again
      // where the request stands (it may have been resolved meanwhile).
      this.awaitingRebuild = false;
      this.startOver(snapshot.transcriptEpoch);
    } else if (snapshot.transcriptEpoch !== this.epoch) {
      // Also every snapshot still on the wire while a requested rebuild is
      // pending (the epoch is forgotten then); `requestResnapshot` asks once.
      this.requestResnapshot();
      return;
    } else if (
      this.revision !== null &&
      snapshot.indexRevision > this.revision
    ) {
      // Same epoch, a revision this follower never saw a delta for.
      this.requestResnapshot();
      return;
    } else if (this.revision === null) {
      // The first concrete revision after a rebuild is the new baseline.
      this.revision = snapshot.indexRevision;
    }
    this.rowCount = snapshot.rowCount;
    const tail = snapshot.tail;
    for (
      let ordinal = tail.fromOrdinal;
      ordinal < snapshot.rowCount;
      ordinal++
    ) {
      this.read.add(ordinal);
    }
    this.readMessages(tail.messages);
  }

  private onSkeletonChunk(chunk: ChatSkeletonChunk): void {
    if (chunk.epoch !== this.epoch) return;
    chunk.entries.forEach((entry, index) => {
      this.rows.set(chunk.fromOrdinal + index, {
        rowId: entry.rowId,
        role: entry.role,
      });
    });
    if (chunk.isFinal) this.skeletonComplete = true;
  }

  private onIndexChanged(frame: {
    readonly epoch: number;
    readonly rowCount: number;
    readonly indexRevision: number;
    readonly changes: readonly ChatIndexChange[];
  }): void {
    if (this.epoch === null || frame.epoch < this.epoch) return;
    if (
      frame.epoch > this.epoch ||
      frame.changes.some((change) => change.type === "reindexed")
    ) {
      this.requestResnapshot();
      return;
    }
    // With no revision held (just after a rebuild) the frame's revision is
    // the new baseline; otherwise it must be the next one.
    if (this.revision !== null) {
      // A duplicate or a straggler from before what this follower holds.
      if (frame.indexRevision <= this.revision) return;
      if (frame.indexRevision !== this.revision + 1) {
        this.requestResnapshot();
        return;
      }
    }
    const appended = frame.changes.reduce(
      (total, change) =>
        change.type === "appended" ? total + change.entries.length : total,
      0,
    );
    // The appended rows sit at the end of the frame's own count; a base past
    // the rows this follower holds means an append frame was lost.
    const appendBase = frame.rowCount - appended;
    if (appendBase > this.rowCount) {
      this.requestResnapshot();
      return;
    }
    this.revision = frame.indexRevision;
    let next = appendBase;
    for (const change of frame.changes) {
      if (change.type === "appended") {
        for (const entry of change.entries) {
          this.rows.set(next, { rowId: entry.rowId, role: entry.role });
          this.read.delete(next);
          this.searched.delete(next);
          next += 1;
        }
      } else if (change.type === "updated") {
        for (const { ordinal, entry } of change.entries) {
          this.rows.set(ordinal, { rowId: entry.rowId, role: entry.role });
          this.read.delete(ordinal);
          this.searched.delete(ordinal);
        }
      }
    }
    this.rowCount = frame.rowCount;
    const span = touchedOrdinals(frame.changes, frame.rowCount);
    if (span !== null) this.loadRange(span.from, span.to);
  }

  private onRange(range: OpenChatRangeResponse): void {
    const asked = this.outstanding.get(range.requestId);
    // Not a range this index asked for: superseded, so not applied.
    if (asked === undefined) return;
    this.outstanding.delete(range.requestId);
    if (range.epoch !== asked.epoch || range.epoch !== this.epoch) return;
    // Row identity: every served row must be the row this index holds at
    // that ordinal, or the bodies belong to some other index.
    const mismatch = range.rowIds.some((rowId, index) => {
      const known = this.rows.get(range.fromOrdinal + index);
      return known !== undefined && known.rowId !== rowId;
    });
    if (mismatch) {
      this.requestResnapshot();
      return;
    }
    const incomplete = new Set(range.incompleteRowIds ?? []);
    range.rowIds.forEach((rowId, index) => {
      if (!incomplete.has(rowId)) this.read.add(range.fromOrdinal + index);
    });
    this.readMessages(range.messages);
    if (range.truncatedAtOrdinal !== undefined) {
      this.loadRange(range.truncatedAtOrdinal, asked.toOrdinal);
    }
  }

  private readMessages(messages: readonly OpenMessage[]): void {
    for (const message of messages) {
      if (message.role === "assistant") {
        this.replies.set(message.messageId, replyText(message));
        continue;
      }
      if (this.input.target.kind === "reply") continue;
      const request = message.conversationRequest;
      if (request === undefined || request.requestId !== this.input.requestId)
        continue;
      this.request =
        request.resolvedAt === null
          ? { kind: "open" }
          : { kind: "resolved", by: request.resolvedByMessageId };
    }
  }

  /** Settles if it can; otherwise reads the next row it needs, if any. */
  private advance(): void {
    if (this.settled) return;
    const request = this.request;
    if (request.kind === "resolved") {
      if (request.by === null) {
        this.finish(() => this.resolve({ kind: "resolved-without-reply" }));
        return;
      }
      const replyMessageId = request.by;
      const text = this.replies.get(replyMessageId);
      if (text !== undefined) {
        this.finish(() =>
          this.resolve({ kind: "replied", replyMessageId, text }),
        );
        return;
      }
      // The reply is the thread's row: the thread's follower reads it.
      if (
        this.input.target.kind === "request" &&
        this.input.target.replyElsewhere
      ) {
        this.finish(() =>
          this.resolve({ kind: "resolved-by", replyMessageId }),
        );
        return;
      }
    }
    // The open request waits for its next delta; nothing to look for.
    if (request.kind === "open") return;
    // A range in flight may hold what is missing: wait for it.
    if (this.outstanding.size > 0 || !this.skeletonComplete) return;
    const wanted: KnownRow["role"] =
      request.kind === "unseen" ? "user" : "assistant";
    const candidate = this.newestUnread(wanted);
    if (candidate !== null) {
      this.searched.add(candidate);
      this.loadRange(candidate, candidate);
      return;
    }
    if (request.kind === "resolved" && request.by !== null) {
      // Every reply-shaped row has been read and none is the one named. Look
      // once more from a fresh snapshot, then report the reply by its id.
      if (!this.replyResnapshotSpent) {
        this.replyResnapshotSpent = true;
        this.requestResnapshot();
        return;
      }
      const replyMessageId = request.by;
      this.finish(() =>
        this.resolve({ kind: "replied", replyMessageId, text: null }),
      );
    }
    // An unseen request row with nothing left to read waits for a delta.
  }

  private newestUnread(role: KnownRow["role"]): number | null {
    for (let ordinal = this.rowCount - 1; ordinal >= 0; ordinal--) {
      const row = this.rows.get(ordinal);
      if (
        row !== undefined &&
        row.role === role &&
        !this.read.has(ordinal) &&
        !this.searched.has(ordinal)
      ) {
        return ordinal;
      }
    }
    return null;
  }

  private loadRange(fromOrdinal: number, toOrdinal: number): void {
    if (this.epoch === null) return;
    const requestId = randomUUID();
    this.outstanding.set(requestId, {
      epoch: this.epoch,
      toOrdinal,
    });
    this.send({
      kind: "loadRange",
      hasBinaryPayload: false,
      epicId: this.input.botId,
      chatId: this.input.chatId,
      request: {
        requestId,
        epoch: this.epoch,
        fromOrdinal,
        toOrdinal,
        maxBytes: TRANSCRIPT_RANGE_MAX_BYTES,
      },
    });
  }

  /**
   * Asks for a fresh snapshot and forgets everything read from the index it
   * replaces, so only the new index can settle the wait.
   */
  private requestResnapshot(): void {
    if (this.awaitingRebuild) return;
    this.awaitingRebuild = true;
    this.startOver(null);
    this.send({
      kind: "resnapshot",
      hasBinaryPayload: false,
      epicId: this.input.botId,
      chatId: this.input.chatId,
    });
  }

  /**
   * Forgets the index and everything read from it - the rows, the replies and
   * where the request stood - so only rows from the next index count. The
   * one fresh snapshot spent on a missing reply stays spent.
   */
  private startOver(epoch: number | null): void {
    this.replies.clear();
    this.request = this.initialRequest();
    this.epoch = epoch;
    this.revision = null;
    this.rowCount = 0;
    this.rows.clear();
    this.skeletonComplete = false;
    this.read.clear();
    this.searched.clear();
    this.outstanding.clear();
  }

  private send(frame: ChatSubscribeWindowedClientFrame): void {
    this.session?.sendClientFrame(frame, null);
  }
}

const ROW_BEARING_FRAME_KINDS: ReadonlySet<string> = new Set([
  "snapshot",
  "skeletonChunk",
  "range",
  "indexChanged",
]);

/**
 * The inclusive ordinal span an `indexChanged` touched: every `updated`
 * ordinal and the appended rows, which sit at the end of the index.
 */
export function touchedOrdinals(
  changes: readonly ChatIndexChange[],
  rowCount: number,
): { readonly from: number; readonly to: number } | null {
  const ordinals: number[] = [];
  let appended = 0;
  for (const change of changes) {
    if (change.type === "updated") {
      for (const entry of change.entries) ordinals.push(entry.ordinal);
    } else if (change.type === "appended") {
      appended += change.entries.length;
    }
  }
  if (appended > 0) {
    ordinals.push(rowCount - appended, rowCount - 1);
  }
  if (ordinals.length === 0) return null;
  return {
    from: Math.max(0, Math.min(...ordinals)),
    to: Math.max(...ordinals),
  };
}

function replyText(message: OpenAssistantMessage): string {
  return message.blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}
