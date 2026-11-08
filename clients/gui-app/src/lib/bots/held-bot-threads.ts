import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  BotThreadListResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

/** A thread the window holds, with the bot whose channel it hangs off. */
export interface HeldBotThread {
  readonly botId: string;
  readonly thread: BotThreadSummary;
}

const THREAD_LIST_METHOD = "bot.thread.list";

/**
 * The threads every bot's thread list read so far holds, whichever host
 * answered it: their ids lower-cased and sorted, each beside its thread and
 * bot. Built once per query client and shared by every chip, and rebuilt on
 * the first read after a thread list is read, re-read or dropped: a message
 * holding many id-shaped tokens resolves each against this instead of walking
 * the query cache once per token, as the task chips do.
 */
interface HeldBotThreads {
  entries: ReadonlyArray<
    readonly [lowerCased: string, held: HeldBotThread]
  > | null;
  readonly listeners: Set<() => void>;
}

const heldBotThreadsByClient = new WeakMap<QueryClient, HeldBotThreads>();

// One entry per listed thread and bot, so a snapshot read from the same cached
// answer is the same object and a subscriber renders only when it moves.
const heldEntries = new WeakMap<BotThreadSummary, Map<string, HeldBotThread>>();

/**
 * The one thread the window holds that `referenceId` names (Tracy Bots T160):
 * its id, else the one id it begins. `null` when it names none, or begins
 * several. A thread no list here holds is not looked up.
 */
export function findHeldBotThread(
  queryClient: QueryClient,
  referenceId: string,
): HeldBotThread | null {
  const held = heldBotThreadsFor(queryClient);
  held.entries ??= scanHeldBotThreads(queryClient);
  const entries = held.entries;
  const normalized = referenceId.toLowerCase();
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle][0] < normalized) low = middle + 1;
    else high = middle;
  }
  // An id sorts before every id it begins, so the thread it names in full
  // comes first. One thread listed twice (two hosts answered) is one thread.
  let found: HeldBotThread | null = null;
  for (let index = low; index < entries.length; index += 1) {
    const [lowerCased, entry] = entries[index];
    if (!lowerCased.startsWith(normalized)) break;
    if (lowerCased === normalized) return entry;
    if (found !== null && found.thread.threadId !== entry.thread.threadId) {
      return null;
    }
    found = entry;
  }
  return found;
}

/**
 * Calls `onChange` when a bot's thread list is read, re-read or dropped: what
 * {@link findHeldBotThread} reads may have moved. Returns the unsubscribe.
 */
export function subscribeToHeldBotThreads(
  queryClient: QueryClient,
  onChange: () => void,
): () => void {
  const held = heldBotThreadsFor(queryClient);
  const listener = (): void => {
    onChange();
  };
  held.listeners.add(listener);
  return () => {
    held.listeners.delete(listener);
  };
}

/**
 * One query-cache listener per client, installed with its index and kept for
 * the client's life, so no reader sees an index built before a change it did
 * not hear about: the listener drops the index inside the cache event itself,
 * before anything can read again.
 */
function heldBotThreadsFor(queryClient: QueryClient): HeldBotThreads {
  const known = heldBotThreadsByClient.get(queryClient);
  if (known !== undefined) return known;
  const held: HeldBotThreads = { entries: null, listeners: new Set() };
  queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type !== "added" &&
      event.type !== "removed" &&
      event.type !== "updated"
    ) {
      return;
    }
    const queryKey: unknown = event.query.queryKey;
    if (!Array.isArray(queryKey)) return;
    if (!hostQueryKeys.matchesMethodOnAnyHost(queryKey, THREAD_LIST_METHOD)) {
      return;
    }
    // A list added before its answer holds no thread until that answer lands.
    if (event.type === "added" && event.query.state.data === undefined) return;
    held.entries = null;
    for (const listener of held.listeners) listener();
  });
  heldBotThreadsByClient.set(queryClient, held);
  return held;
}

function scanHeldBotThreads(
  queryClient: QueryClient,
): ReadonlyArray<readonly [string, HeldBotThread]> {
  const entries: Array<readonly [string, HeldBotThread]> = [];
  for (const query of queryClient.getQueryCache().findAll({
    predicate: (query) =>
      hostQueryKeys.matchesMethodOnAnyHost(query.queryKey, THREAD_LIST_METHOD),
  })) {
    const botId = threadListBotId(query.queryKey);
    const response = queryClient.getQueryData<BotThreadListResponse>(
      query.queryKey,
    );
    if (botId === null || response === undefined) continue;
    for (const thread of response.threads) {
      entries.push([thread.threadId.toLowerCase(), heldEntry(botId, thread)]);
    }
  }
  return entries.sort(([a], [b]) => compareCodeUnits(a, b));
}

/** The order `<` reads strings in, which the prefix search relies on. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** The bot a thread list was read for: its params follow the method in the key. */
function threadListBotId(queryKey: QueryKey): string | null {
  const params = queryKey[queryKey.indexOf(THREAD_LIST_METHOD) + 1];
  if (typeof params !== "object" || params === null) return null;
  if (!("botId" in params) || typeof params.botId !== "string") return null;
  return params.botId;
}

function heldEntry(botId: string, thread: BotThreadSummary): HeldBotThread {
  let byBot = heldEntries.get(thread);
  if (byBot === undefined) {
    byBot = new Map();
    heldEntries.set(thread, byBot);
  }
  let entry = byBot.get(botId);
  if (entry === undefined) {
    entry = { botId, thread };
    byBot.set(botId, entry);
  }
  return entry;
}
