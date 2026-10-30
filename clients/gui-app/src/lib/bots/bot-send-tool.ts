import type {
  BotSendReceipt,
  ToolInputDetail,
} from "@traycer/protocol/persistence/epic/content-blocks";
import type { BotSurfaceKind } from "@traycer/protocol/persistence/epic/messages";
import type { OpenMessage } from "@traycer/protocol/persistence/epic/open-harness-records";
import {
  EMPTY_QUESTION_CARD_DRAFT,
  botQuestionCardSettlement,
  questionCardView,
  questionSettledLine,
} from "@/components/chat/question-card-view";
import type {
  ChatMessage,
  SegmentEndState,
} from "@/stores/composer/chat-store";

/** One question of a `traycer_ask` call, as the person reads it. */
export interface BotSendQuestion {
  readonly text: string;
  readonly options: ReadonlyArray<string>;
}

/**
 * What one of the bot's sends posted (Tracy Bots T93), read off the tool
 * call's persisted input: a reply, a question, or an announcement.
 * `conversationId` is where the call named it went - the channel, or the
 * session's thread - and `repliesTo` the channel post a trunk's reply or
 * question follows. An announcement always posts at the channel's top level.
 * `surface` is what in a task a reply or announcement pointed at (T89), by
 * kind; `null` for none. `receipt` is the post the send wrote, as the host
 * stamped it on the call (T94); `null` for a call from before it did.
 */
export type BotSend = { readonly receipt: BotSendReceipt | null } & (
  | {
      readonly kind: "reply";
      readonly conversationId: string | null;
      readonly repliesTo: string | null;
      readonly text: string;
      readonly options: ReadonlyArray<string>;
      readonly surface: BotSurfaceKind | null;
    }
  | {
      readonly kind: "ask";
      readonly conversationId: string | null;
      readonly repliesTo: string | null;
      readonly questions: ReadonlyArray<BotSendQuestion>;
    }
  | {
      readonly kind: "announce";
      readonly text: string;
      readonly surface: BotSurfaceKind | null;
    }
);

type BotSendKind = BotSend["kind"];

const SEND_TOOL_PATTERN = /(^|[_/.])traycer_(reply|ask|announce)$/;

/**
 * Which send a tool call is, by its name, whatever prefix the harness gave
 * the tool server (`mcp__traycer_a2a__traycer_reply`); `null` for any other
 * tool.
 */
function sendKindOf(toolName: string): BotSendKind | null {
  const match = SEND_TOOL_PATTERN.exec(
    toolName.toLowerCase().replaceAll("-", "_"),
  );
  if (match === null) return null;
  const kind = match[2];
  return kind === "reply" || kind === "ask" || kind === "announce"
    ? kind
    : null;
}

/** Whether a tool call is one of the bot's sends, which stand on their own rather than folding into an activity group. */
export function isBotSendToolName(toolName: string): boolean {
  return sendKindOf(toolName) !== null;
}

/**
 * The send a tool call's card paints, or `null` for a call that is not a
 * send, that has not completed (still running, failed, or cut off by a stop
 * or a steer: nothing may have been posted, and the agent chat's row says
 * where it stands), or whose input the block does not carry (a block from
 * before inputs were persisted).
 */
export function paintedBotSendOf(call: {
  readonly toolName: string;
  readonly inputDetail: ToolInputDetail | null;
  readonly error: string | null;
  readonly isStreaming: boolean;
  readonly endState: SegmentEndState;
  readonly botSendReceipt: BotSendReceipt | null;
}): BotSend | null {
  const kind = sendKindOf(call.toolName);
  if (kind === null || call.inputDetail?.kind !== "fields") return null;
  if (call.isStreaming || call.endState !== null) return null;
  if (call.error !== null && call.error.length > 0) return null;
  const fields = new Map(
    call.inputDetail.entries.map((entry) => [entry.key, entry.value]),
  );
  const conversationId = present(fields.get("conversationId"));
  const repliesTo = present(fields.get("repliesTo"));
  const receipt = call.botSendReceipt;
  if (kind === "ask") {
    const questions = questionsOf(fields.get("questions"));
    if (questions.length === 0) return null;
    return { kind, receipt, conversationId, repliesTo, questions };
  }
  const text = present(fields.get("text"));
  if (text === null) return null;
  const surface = surfaceKindOf(parsed(fields.get("surface")));
  if (kind === "announce") return { kind, receipt, text, surface };
  return {
    kind,
    receipt,
    conversationId,
    repliesTo,
    text,
    options: stringsOf(parsed(fields.get("options"))),
    surface,
  };
}

/**
 * The conversations the stamped questions of `messages` were asked in (T94),
 * sorted: where their states are read from.
 */
export function askedConversationIds(
  messages: ReadonlyArray<ChatMessage>,
): readonly string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const segment of message.segments) {
      if (segment.kind === "tool" && segment.botSendReceipt?.kind === "ask") {
        ids.add(segment.botSendReceipt.conversationId);
      }
    }
  }
  return [...ids].sort();
}

/** Whom a session's send cards name: the bot, as the asker, and the channel's members. */
export interface BotSendNames {
  readonly botTitle: string;
  readonly memberName: (userId: string) => string;
  readonly viewerUserId: string | null;
}

/**
 * What a question's card says of each question once the post it wrote is
 * read (T94): the line the channel's card shows for a settled one - answered
 * by whom, skipped, or settled by the bot - and `null` for one still open.
 * `null` while the post is not read, or names no question.
 */
export function sendQuestionStates(
  post: OpenMessage | null,
  names: BotSendNames,
): ReadonlyArray<string | null> | null {
  const question = post?.role === "assistant" ? post.question : undefined;
  if (question === undefined) return null;
  return question.questions.map((item) => {
    const view = questionCardView(
      botQuestionCardSettlement(
        item.settlement,
        names.memberName,
        names.viewerUserId,
      ),
      EMPTY_QUESTION_CARD_DRAFT,
    );
    return view.kind === "settled"
      ? questionSettledLine(view.settlement, names.botTitle)
      : null;
  });
}

/** A field's value, or `null` for a field left out or sent as `null`. */
function present(value: string | undefined): string | null {
  if (value === undefined || value === "null" || value.length === 0) {
    return null;
  }
  return value;
}

/** A field the input detail carries as JSON (an array); `null` when it does not parse. */
function parsed(value: string | undefined): unknown {
  if (value === undefined) return null;
  try {
    const json: unknown = JSON.parse(value);
    return json;
  } catch {
    return null;
  }
}

const SURFACE_KINDS: ReadonlySet<string> = new Set<BotSurfaceKind>([
  "question",
  "approval",
  "browser",
  "artifact",
]);

function isSurfaceKind(value: unknown): value is BotSurfaceKind {
  return typeof value === "string" && SURFACE_KINDS.has(value);
}

/** The kind of the surface a send's `surface` argument names; `null` for none or one this client does not know. */
function surfaceKindOf(value: unknown): BotSurfaceKind | null {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return null;
  }
  return isSurfaceKind(value.kind) ? value.kind : null;
}

function stringsOf(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function questionsOf(
  value: string | undefined,
): ReadonlyArray<BotSendQuestion> {
  const items = parsed(value);
  if (!Array.isArray(items)) return [];
  return items.flatMap((item: unknown): BotSendQuestion[] => {
    if (typeof item !== "object" || item === null) return [];
    const text = "text" in item ? item.text : null;
    if (typeof text !== "string" || text.length === 0) return [];
    const options = "options" in item ? stringsOf(item.options) : [];
    return [{ text, options }];
  });
}
