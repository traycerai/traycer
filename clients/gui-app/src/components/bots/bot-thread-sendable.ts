import type {
  BotThreadAnchors,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { OpenMessage } from "@traycer/protocol/persistence/epic/open-harness-records";
import { threadOpenOf } from "@/lib/bots/bot-trunk-model";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";

/**
 * Whether the open thread's box takes a send. The anchor's row says which
 * row the thread hangs off once the channel has it, whatever opened the
 * thread (a memory's link and a session's "Open thread" name the anchor
 * only): a row of the bot takes a send only while the bot's binding names
 * it among the rows a thread roots on. An open that names its kind, or was
 * made from its row (a box under a question, a proposal or a direct post),
 * and a post being sent go by what they say. A thread opened by its anchor
 * alone takes none until the channel's row or the thread list says a
 * member wrote the anchor.
 */
export function anchorSendable(input: {
  readonly open: BotOpenThread | null;
  readonly listed: BotThreadSummary | null;
  readonly post: OpenMessage | null;
  readonly threadAnchorKinds: readonly string[];
}): boolean {
  const { open, post } = input;
  const kind =
    post === null ? (open?.anchorKind ?? null) : threadOpenOf(post).anchorKind;
  if (kind !== null) return input.threadAnchorKinds.includes(kind);
  if (post !== null) return true;
  if (open !== null && (open.sent !== null || open.announcement)) return true;
  const anchor = input.listed?.anchor ?? null;
  return anchor !== null && anchor.senderUserId !== null;
}

/**
 * The rows of the bot its bound host opens their own thread under, as its
 * thread list said them (`anchors`). Said for the binding it said them under:
 * a host that predates them says nothing, and a list read under an earlier
 * binding - cached, or answered after the bot moved - says nothing for this
 * one until it is read again.
 */
export function boundThreadAnchorKinds(
  anchors: BotThreadAnchors | null,
  boundHostId: string | null,
  boundHostEpoch: number,
): readonly string[] {
  return anchors !== null &&
    anchors.hostId === boundHostId &&
    anchors.epoch === boundHostEpoch
    ? anchors.kinds
    : NO_KINDS;
}

const NO_KINDS: readonly string[] = [];
