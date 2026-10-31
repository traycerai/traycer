import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  BotRecord,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import { liveActivityOf, useBotActivity } from "@/hooks/bots/use-bot-activity";
import { useBotActivitySummary } from "@/hooks/bots/use-bot-activity-summary";
import { useBotSubscriptionForHost } from "@/hooks/bots/use-bot-subscription";
import { useEnvironmentMemberDirectory } from "@/hooks/bots/use-environment-members-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useNotificationMarkEntityRead } from "@/hooks/notifications/use-notification-mark-entity-read-mutation";
import {
  buildUsageSummaryRequest,
  useUsageSummaryForClient,
} from "@/hooks/usage-analytics/use-usage-summary-query";
import { useUsageSummarySupported } from "@/hooks/usage-analytics/use-usage-summary-support";
import type { VoiceAttention } from "@/hooks/voice/use-voice-attention";
import type {
  VoiceQueueOwner,
  VoiceReadMark,
  VoiceStatusRequest,
} from "@/hooks/voice/use-voice-queue-owner";
import {
  finishedTasksOf,
  finishedThisWeek,
  trackingTasksOf,
} from "@/lib/bots/bot-activity-model";
import {
  getChatSessionRegistry,
  useChatSessionHandleForContainer,
} from "@/lib/registries/chat-session-registry";
import { watchAnnouncements } from "@/lib/voice/announcement-watch";
import { composeBotStatus } from "@/lib/voice/bot-status";
import { stoppedAnswersOf, type ReplyRef } from "@/lib/voice/queue-sources";
import type { PendingHydration, VoiceQueue } from "@/lib/voice/voice-queue";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";

/**
 * How long a reference waits for its row in the records before it is left
 * to the bell: the thread's store opening, its snapshot loading, the row
 * landing after the notification that named it.
 */
export const HYDRATION_TIMEOUT_MS = 15_000;

/**
 * Everything the queue reads while a session runs: its sources, and the
 * reader of a `status` asked of one bot.
 */
export function VoiceQueueSources(props: {
  readonly owner: VoiceQueueOwner;
}): ReactNode {
  const { owner } = props;
  return (
    <>
      {owner.queue === null ? null : (
        <VoiceQueueFeed
          queue={owner.queue}
          attention={owner.attention}
          hostOf={owner.hostOf}
          bots={owner.bots}
          registerMark={owner.registerMark}
        />
      )}
      {owner.statusRequest === null ? null : (
        <VoiceBotStatusReader
          key={owner.statusRequest.seq}
          request={owner.statusRequest}
          onComposed={owner.onStatusComposed}
        />
      )}
    </>
  );
}

/**
 * The queue's sources while a session runs (Tracy Bots voice, VT4): the
 * attention tier's replies, each hydrated by id from the records of the
 * host that serves them; announcements from the channel stores this window
 * holds; the stopped answers of the bots whose tabs are open; and one read
 * marker per host an item lives on.
 */
function VoiceQueueFeed(props: {
  readonly queue: VoiceQueue;
  readonly attention: VoiceAttention;
  readonly hostOf: (ref: ReplyRef) => string;
  readonly bots: ReadonlyArray<BotRecord>;
  readonly registerMark: (hostId: string, mark: VoiceReadMark | null) => void;
}): ReactNode {
  const { queue, attention, hostOf, bots, registerMark } = props;
  const hostOfRef = useRef(hostOf);
  useEffect(() => {
    hostOfRef.current = hostOf;
  }, [hostOf]);

  // Every unread reply the attention tier names; one already known (queued,
  // hydrating, or said by the focused feed) changes nothing.
  useEffect(() => {
    queue.ingestReplies(attention.answers, (ref) => hostOfRef.current(ref));
  }, [attention.answers, queue]);

  const pending = useSyncExternalStore(
    queue.subscribePending,
    queue.pendingHydrations,
  );

  // Announcements: the bots' channels the bot records name.
  useEffect(() => {
    const channels = new Map<string, string>();
    for (const bot of bots) {
      if (bot.appConversationChatId !== null) {
        channels.set(bot.appConversationChatId, bot.botId);
      }
    }
    if (channels.size === 0) return;
    return watchAnnouncements({
      source: getChatSessionRegistry(),
      channelBot: (chatId) => channels.get(chatId) ?? null,
      onAnnouncement: (found) => queue.addAnnouncement(found),
    });
  }, [bots, queue]);

  const queueHosts = useVoiceSessionStore((state) =>
    uniqueHosts(state.queue.map((item) => item.hostId)),
  );

  return (
    <>
      {pending.map((hydration) => (
        <VoiceReplyHydrator
          key={hydration.ref.messageId}
          hydration={hydration}
          queue={queue}
          environmentId={
            bots.find((bot) => bot.botId === hydration.ref.botId)
              ?.environmentId ?? null
          }
        />
      ))}
      {queueHosts
        .split("\n")
        .flatMap((hostId) =>
          hostId.length === 0
            ? []
            : [
                <VoiceReadMarker
                  key={hostId}
                  hostId={hostId}
                  register={registerMark}
                />,
              ],
        )}
    </>
  );
}

/** The distinct hosts, joined: a stable string the store selector can compare. */
function uniqueHosts(hostIds: ReadonlyArray<string>): string {
  return Array.from(new Set(hostIds)).sort().join("\n");
}

/**
 * Reads one reference's row from the records: the chat it names, on the
 * host that serves it, through the same handle the thread panel reads rows
 * from. The row found is the queue's; none within the timeout leaves the
 * reference to the bell.
 */
function VoiceReplyHydrator(props: {
  readonly hydration: PendingHydration;
  readonly queue: VoiceQueue;
  /** The environment of the bot, whose member directory names a teammate; `null` when unknown. */
  readonly environmentId: string | null;
}): null {
  const { hydration, queue, environmentId } = props;
  const { ref, hostId } = hydration;
  const handle = useChatSessionHandleForContainer(
    ref.botId,
    ref.chatId,
    hostId,
    true,
  );
  // A teammate's row is named by the directory the bot's channel names its
  // members from; until it answers, or on a host without it, the line says
  // "a teammate".
  const client = useHostClientForHostId(hostId);
  const membersSupported =
    useHostMethodSupport(hostId, "environment.members") === true;
  const directory = useEnvironmentMemberDirectory(
    client,
    environmentId,
    membersSupported && environmentId !== null,
  );
  const resolveRef = useRef(directory.resolve);
  useEffect(() => {
    resolveRef.current = directory.resolve;
  }, [directory.resolve]);
  useEffect(() => {
    const timer = window.setTimeout(
      () => queue.hydrated(ref.messageId, null, null),
      HYDRATION_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [queue, ref.messageId]);
  useEffect(() => {
    if (handle === null) return;
    // Whoever wrote the row: the kind decides how it is read.
    const look = (): void => {
      const row = handle.store
        .getState()
        .messages.find((message) => message.messageId === ref.messageId);
      if (row === undefined) return;
      const author =
        row.role === "user" && row.sender.type === "user"
          ? (resolveRef.current(row.sender.userId)?.displayName ?? null)
          : null;
      queue.hydrated(ref.messageId, row, author);
    };
    look();
    return handle.store.subscribe(look);
  }, [handle, queue, ref.messageId]);
  return null;
}

/**
 * The stopped answers of the bots whose tabs are open, read whether or not a
 * session runs, so the briefing a session opens with already names them.
 * Each bot's reading goes to the queue's owner, which keeps the latest and
 * hands it to the queue while a session runs.
 */
export function VoiceStoppedSources(props: {
  readonly owner: VoiceQueueOwner;
}): ReactNode {
  const { owner } = props;
  const botTabs = useBotTabsStore((state) => state.tabs);
  return (
    <>
      {Object.values(botTabs).map((tab) => (
        <VoiceStoppedWatch
          key={tab.botId}
          botId={tab.botId}
          hostId={tab.hostId}
          channelChatId={
            owner.bots.find((bot) => bot.botId === tab.botId)
              ?.appConversationChatId ?? tab.botId
          }
          noteStopped={owner.noteStopped}
          forgetStopped={owner.forgetStopped}
        />
      ))}
    </>
  );
}

/**
 * A bot's failed and parked answers, as its stream says (`bot.subscribe`,
 * read through the bot's tab host like every reading of what a bot does).
 */
function VoiceStoppedWatch(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly channelChatId: string;
  readonly noteStopped: VoiceQueueOwner["noteStopped"];
  readonly forgetStopped: (botId: string) => void;
}): null {
  const { botId, hostId, channelChatId, noteStopped, forgetStopped } = props;
  const activity = useBotActivity(botId);
  useEffect(() => {
    // No reading (the stream closed for good, or the bot is gone): what was
    // read before no longer stands, and unknown is not idle, so nothing is
    // seeded from it either.
    if (activity === null) {
      forgetStopped(botId);
      return;
    }
    noteStopped({
      botId,
      hostId,
      channelChatId,
      stopped: stoppedAnswersOf(activity),
    });
  }, [activity, botId, channelChatId, forgetStopped, hostId, noteStopped]);
  useEffect(() => () => forgetStopped(botId), [botId, forgetStopped]);
  return null;
}

/** Registers the entity-level read for one host, on that host's own client. */
function VoiceReadMarker(props: {
  readonly hostId: string;
  readonly register: (hostId: string, mark: VoiceReadMark | null) => void;
}): null {
  const { hostId, register } = props;
  const client = useHostClientForHostId(hostId);
  const { mutate } = useNotificationMarkEntityRead(client);
  useEffect(() => {
    register(hostId, (entity) => mutate(entity));
    return () => register(hostId, null);
  }, [hostId, mutate, register]);
  return null;
}

/** How long `status` waits for the bot's readings before it says what it has. */
export const STATUS_READ_TIMEOUT_MS = 4_000;
/** The usage window `status` reports, in days. */
export const STATUS_COST_WINDOW_DAYS = 7;

/**
 * Gathers what `status` says about a bot, from the readings the app already
 * makes: the bot's stream (`bot.subscribe`), its Activity data and the usage
 * summary its settings open. Composes once, when they have answered or the
 * wait is over, and hands the prose back.
 */
function VoiceBotStatusReader(props: {
  readonly request: VoiceStatusRequest;
  readonly onComposed: (request: VoiceStatusRequest, text: string) => void;
}): null {
  const { request, onComposed } = props;
  const subscription = useBotSubscriptionForHost({
    botId: request.botId,
    hostId: request.hostId,
    enabled: true,
  });
  // A stream closed for good, or a bot deleted, keeps its last snapshot in
  // the cache: that reading is not current, so nothing of it is said.
  const closed = subscription.error !== null || subscription.deleted;
  const snapshot = closed ? null : subscription.snapshot;
  const tasks = snapshot?.tasks ?? NO_TASKS;
  const activity = liveActivityOf(subscription);
  const summary = useBotActivitySummary({
    botId: request.botId,
    trunkChatId: snapshot?.bot.trunkChatId ?? "",
    tasks,
    activity,
    threads: null,
  });
  const client = useHostClientForHostId(request.hostId);
  const usageSupported = useUsageSummarySupported(request.hostId);
  const [usageRequest] = useState(() =>
    buildUsageSummaryRequest({
      windowDays: STATUS_COST_WINDOW_DAYS,
      epicId: request.botId,
      plane: null,
    }),
  );
  const usage = useUsageSummaryForClient(
    client,
    usageRequest,
    usageSupported,
    false,
  );
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setTimedOut(true),
      STATUS_READ_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, []);
  const composedRef = useRef(false);
  const usageSettled =
    !usageSupported || usage.data !== undefined || usage.isError;
  const ready =
    timedOut || ((snapshot !== null || closed) && usageSettled);
  useEffect(() => {
    if (!ready || composedRef.current) return;
    composedRef.current = true;
    const now = Date.now();
    onComposed(
      request,
      composeBotStatus({
        botTitle: request.botTitle,
        activity,
        tasks: trackingTasksOf(tasks).length,
        working: summary.running.length > 0,
        finishedThisWeek: finishedThisWeek(finishedTasksOf(tasks), now).length,
        costUsd: usage.data?.summary.totals.knownCostUsd ?? null,
        costWindowDays: STATUS_COST_WINDOW_DAYS,
      }),
    );
  }, [
    activity,
    onComposed,
    ready,
    request,
    summary.running,
    tasks,
    usage.data,
  ]);
  return null;
}

const NO_TASKS: ReadonlyArray<BotTaskEntry> = [];
