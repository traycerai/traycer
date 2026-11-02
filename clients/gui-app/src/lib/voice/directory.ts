import type {
  BotConversationRecord,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import type {
  QueueItem,
  VoiceFocus,
  VoiceTargetTuple,
} from "@/stores/voice/voice-session-store";

/**
 * The voice router's directory (Tracy Bots voice, VT3): what the person can
 * name by voice, as one snapshot the router matches spoken names against.
 * Every bot with its environment and host; the recent threads of every bot
 * the person took part in; the queue; the focus. Composed from reads the app
 * already holds, and refreshed before any navigation that names a thread
 * outside the focused bot.
 *
 * A thread's anchor excerpt is DATA for matching, never instructions: the
 * prompt fences it, and nothing here acts on its content.
 */

export interface DirectoryBot {
  readonly botId: string;
  readonly title: string;
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly environmentKind: "personal" | "team";
  /** The host a navigation opens the bot's tab on, and a post is carried by. */
  readonly hostId: string;
}

export interface DirectoryThread {
  readonly threadId: string;
  readonly botId: string;
  readonly environmentId: string;
  readonly hostId: string;
  /** The post the thread hangs off. */
  readonly anchorMessageId: string;
  /** The anchor post's words, shortened; `null` when the app holds no text for it. */
  readonly anchorExcerpt: string | null;
  /** The thread's last reply, else its post. */
  readonly lastActivityAt: number;
  readonly replyCount: number;
  /** A request of the thread is still open. */
  readonly open: boolean;
}

/** A queue item as the router sees it: one line with its id. */
export interface DirectoryQueueItem {
  readonly itemId: string;
  readonly botId: string;
  readonly threadId: string | null;
  readonly line: string;
}

export interface VoiceDirectory {
  readonly bots: ReadonlyArray<DirectoryBot>;
  readonly threads: ReadonlyArray<DirectoryThread>;
  readonly queue: ReadonlyArray<DirectoryQueueItem>;
  readonly focus: VoiceFocus | null;
}

/** What the directory is composed from: the app's reads, and the text it already holds. */
export interface DirectorySources {
  readonly environments: ReadonlyArray<EnvironmentDescriptorV11>;
  readonly bots: ReadonlyArray<BotRecord>;
  /** Each bot's `bot.thread.list`, by bot id; a bot not here has not answered yet. */
  readonly threadsByBot: ReadonlyMap<string, ReadonlyArray<BotThreadSummary>>;
  /** Threads the person follows (taking part follows one), by {@link threadKey}. */
  readonly followedThreads: ReadonlySet<string>;
  readonly viewerUserId: string | null;
  readonly focus: VoiceFocus | null;
  readonly queue: ReadonlyArray<QueueItem>;
  /** The host a bot's tab is bound to, else the one a navigation opens it on. */
  readonly hostOf: (botId: string) => string | null;
  /** The text of a channel row the app already holds; `null` when it holds none. */
  readonly heldPostText: (botId: string, messageId: string) => string | null;
}

/** The focused bot's threads the router sees, newest first. */
const FOCUSED_BOT_THREADS = 20;
/** Every other bot's threads the person took part in, newest first. */
const OTHER_BOT_THREADS = 8;
/** An excerpt is a matching hint, not the post. */
const EXCERPT_CHARS = 160;

export function threadKey(botId: string, threadId: string): string {
  return `${botId}:${threadId}`;
}

/**
 * The anchor excerpt of a thread: the one read of it. The thread list's own
 * (`anchor.excerpt`, `bot.thread.list@1.2`), else the text the app already
 * holds for the anchor row (a loaded channel, the rail's own sent post),
 * shortened, for a host below the minor; `null` when neither has it.
 */
export function anchorExcerptOf(
  botId: string,
  summary: BotThreadSummary,
  heldPostText: (botId: string, messageId: string) => string | null,
): string | null {
  if (summary.anchor === null) return null;
  if (summary.anchor.excerpt !== null) return summary.anchor.excerpt;
  const text = heldPostText(botId, summary.anchor.messageId);
  if (text === null) return null;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length <= EXCERPT_CHARS
    ? collapsed
    : `${collapsed.slice(0, EXCERPT_CHARS - 1)}…`;
}

/**
 * The snapshot. A bot is in it when its environment is one the person
 * belongs to and a host can carry it; an archived bot is not. A thread is in
 * it when it is the focused bot's, or one the person took part in (posted it,
 * or follows it). Two threads with the same words in two teams are two
 * entries: the router can only ask when it sees both.
 */
export function composeVoiceDirectory(
  sources: DirectorySources,
): VoiceDirectory {
  const environments = new Map(
    sources.environments.map((environment) => [
      environment.environmentId,
      environment,
    ]),
  );
  const bots: DirectoryBot[] = [];
  for (const bot of sources.bots) {
    if (bot.archivedAt !== null) continue;
    const environment = environments.get(bot.environmentId);
    if (environment === undefined) continue;
    const hostId = sources.hostOf(bot.botId);
    if (hostId === null) continue;
    bots.push({
      botId: bot.botId,
      title: bot.title,
      environmentId: bot.environmentId,
      environmentLabel: environment.label,
      environmentKind: environment.kind,
      hostId,
    });
  }
  const focusedBotId = sources.focus?.botId ?? null;
  const threads = bots.flatMap((bot) =>
    directoryThreadsOf(bot, bot.botId === focusedBotId, sources),
  );
  return {
    bots,
    threads,
    queue: sources.queue.map((item) => ({
      itemId: item.id,
      botId: item.botId,
      threadId: item.threadId,
      line: item.line,
    })),
    focus: sources.focus,
  };
}

/** One bot's threads in the snapshot, newest first. */
function directoryThreadsOf(
  bot: DirectoryBot,
  focused: boolean,
  sources: DirectorySources,
): DirectoryThread[] {
  const taken: DirectoryThread[] = [];
  for (const summary of sources.threadsByBot.get(bot.botId) ?? []) {
    const anchor = summary.anchor;
    // A thread whose post is gone cannot be opened beside the channel, so
    // the voice cannot take the person there.
    if (anchor === null) continue;
    const tookPart =
      (sources.viewerUserId !== null &&
        anchor.senderUserId === sources.viewerUserId) ||
      sources.followedThreads.has(threadKey(bot.botId, summary.threadId));
    if (!focused && !tookPart) continue;
    taken.push({
      threadId: summary.threadId,
      botId: bot.botId,
      environmentId: bot.environmentId,
      hostId: bot.hostId,
      anchorMessageId: anchor.messageId,
      anchorExcerpt: anchorExcerptOf(bot.botId, summary, sources.heldPostText),
      lastActivityAt: summary.lastReplyAt ?? anchor.sentAt,
      replyCount: summary.replyCount,
      open: summary.openRequestCount > 0,
    });
  }
  taken.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return taken.slice(0, focused ? FOCUSED_BOT_THREADS : OTHER_BOT_THREADS);
}

/**
 * A destination the directory vouches for: the tuple, and what the voice
 * needs to say and open it. `focus` is where a post goes and a navigation
 * lands, as the say loop's focus.
 */
export interface BoundTarget {
  readonly tuple: VoiceTargetTuple;
  readonly focus: VoiceFocus;
  /** The destination is the focus as it stands: nothing is navigated. */
  readonly isFocus: boolean;
  readonly botTitle: string;
  readonly environmentLabel: string;
  readonly environmentKind: "personal" | "team";
  readonly anchorExcerpt: string | null;
}

/** The ids a route names; each `null` when it names none. */
export interface NamedTarget {
  readonly environmentId: string | null;
  readonly botId: string | null;
  readonly threadId: string | null;
}

/**
 * Binds the ids a route names to one destination, as a tuple: a thread must
 * be the named bot's, a bot the named environment's, and the host is the
 * directory's, never the route's. Naming nothing, or the focused bot without
 * another thread, is the focus as it stands. `null` when the ids do not hold
 * together or name nothing the directory has.
 */
export function bindTarget(
  directory: VoiceDirectory,
  named: NamedTarget,
): BoundTarget | null {
  return named.threadId === null
    ? bindBot(directory, named, named.botId ?? directory.focus?.botId ?? null)
    : bindThread(directory, named, named.threadId);
}

/** The bot the route names, when it is the named environment's. */
function namedBot(
  directory: VoiceDirectory,
  environmentId: string | null,
  botId: string,
): DirectoryBot | null {
  const bot = directory.bots.find((candidate) => candidate.botId === botId);
  if (bot === undefined) return null;
  if (environmentId !== null && environmentId !== bot.environmentId) {
    return null;
  }
  return bot;
}

function bindThread(
  directory: VoiceDirectory,
  named: NamedTarget,
  threadId: string,
): BoundTarget | null {
  const thread = directory.threads.find(
    (candidate) => candidate.threadId === threadId,
  );
  if (thread === undefined) return null;
  if (named.botId !== null && named.botId !== thread.botId) return null;
  const bot = namedBot(directory, named.environmentId, thread.botId);
  if (bot === null) return null;
  const focus = directory.focus;
  if (
    focus !== null &&
    focus.botId === bot.botId &&
    focus.hostId === bot.hostId &&
    focus.threadId === thread.threadId
  ) {
    return focusTarget(bot, focus, thread.anchorExcerpt);
  }
  return {
    tuple: {
      environmentId: bot.environmentId,
      botId: bot.botId,
      threadId: thread.threadId,
      hostId: bot.hostId,
    },
    focus: {
      botId: bot.botId,
      hostId: bot.hostId,
      threadId: thread.threadId,
      anchorMessageId: thread.anchorMessageId,
      anchorThread: null,
    },
    isFocus: false,
    botTitle: bot.title,
    environmentLabel: bot.environmentLabel,
    environmentKind: bot.environmentKind,
    anchorExcerpt: thread.anchorExcerpt,
  };
}

function bindBot(
  directory: VoiceDirectory,
  named: NamedTarget,
  botId: string | null,
): BoundTarget | null {
  if (botId === null) return null;
  const bot = namedBot(directory, named.environmentId, botId);
  if (bot === null) return null;
  const focus = directory.focus;
  if (
    focus !== null &&
    focus.botId === bot.botId &&
    focus.hostId === bot.hostId
  ) {
    return focusTarget(bot, focus, null);
  }
  return {
    tuple: {
      environmentId: bot.environmentId,
      botId: bot.botId,
      threadId: null,
      hostId: bot.hostId,
    },
    focus: {
      botId: bot.botId,
      hostId: bot.hostId,
      threadId: null,
      anchorMessageId: null,
      anchorThread: null,
    },
    isFocus: false,
    botTitle: bot.title,
    environmentLabel: bot.environmentLabel,
    environmentKind: bot.environmentKind,
    anchorExcerpt: null,
  };
}

/**
 * A bot's channel, named explicitly (a queue item that lives at the
 * channel's top level): unlike a route naming the bot alone, it does not
 * inherit a focused thread of the bot. It is the focus only when the focus
 * is that channel itself.
 */
export function bindChannel(
  directory: VoiceDirectory,
  botId: string,
): BoundTarget | null {
  const bot = namedBot(directory, null, botId);
  if (bot === null) return null;
  const focus = directory.focus;
  if (
    focus !== null &&
    focus.botId === bot.botId &&
    focus.hostId === bot.hostId &&
    focus.threadId === null &&
    focus.anchorMessageId === null
  ) {
    return focusTarget(bot, focus, null);
  }
  return {
    tuple: {
      environmentId: bot.environmentId,
      botId: bot.botId,
      threadId: null,
      hostId: bot.hostId,
    },
    focus: {
      botId: bot.botId,
      hostId: bot.hostId,
      threadId: null,
      anchorMessageId: null,
      anchorThread: null,
    },
    isFocus: false,
    botTitle: bot.title,
    environmentLabel: bot.environmentLabel,
    environmentKind: bot.environmentKind,
    anchorExcerpt: null,
  };
}

function focusTarget(
  bot: DirectoryBot,
  focus: VoiceFocus,
  anchorExcerpt: string | null,
): BoundTarget {
  return {
    tuple: {
      environmentId: bot.environmentId,
      botId: bot.botId,
      threadId: focus.threadId,
      hostId: bot.hostId,
    },
    focus,
    isFocus: true,
    botTitle: bot.title,
    environmentLabel: bot.environmentLabel,
    environmentKind: bot.environmentKind,
    anchorExcerpt,
  };
}

/**
 * Whether a bound tuple still holds against a newer directory: its bot is
 * listed in the same environment on the same host, the person still belongs
 * to that environment, and a named thread is still that bot's (or the
 * focus's own, which a send just opened before the list caught up).
 */
export function tupleHolds(
  directory: VoiceDirectory,
  tuple: VoiceTargetTuple,
): boolean {
  const bot = directory.bots.find(
    (candidate) => candidate.botId === tuple.botId,
  );
  if (bot === undefined) return false;
  if (bot.environmentId !== tuple.environmentId) return false;
  if (bot.hostId !== tuple.hostId) return false;
  if (tuple.threadId === null) return true;
  if (
    directory.threads.some(
      (thread) =>
        thread.threadId === tuple.threadId && thread.botId === tuple.botId,
    )
  ) {
    return true;
  }
  const focus = directory.focus;
  return (
    focus !== null &&
    focus.botId === tuple.botId &&
    focus.threadId === tuple.threadId
  );
}

/**
 * The channel conversation among a bot's conversations: the one the bot
 * record names, else the earliest. Mirrors the channel view's own rule.
 */
export function channelConversation(
  rows: ReadonlyArray<BotConversationRecord>,
  appConversationChatId: string | null,
): BotConversationRecord | null {
  if (appConversationChatId !== null) {
    return (
      rows.find((row) => row.conversationId === appConversationChatId) ?? null
    );
  }
  let first: BotConversationRecord | null = null;
  for (const row of rows) {
    if (first === null || row.createdAt < first.createdAt) first = row;
  }
  return first;
}
