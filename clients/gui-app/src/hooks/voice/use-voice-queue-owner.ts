import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type {
  BotListResponse,
  BotRecord,
} from "@traycer/protocol/host/bot/schemas";
import {
  useVoiceAttention,
  type VoiceAttention,
} from "@/hooks/voice/use-voice-attention";
import { appLogger } from "@/lib/logger";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { botTabIntent } from "@/lib/tab-navigation/intents";
import {
  composeBriefing,
  VOICE_SESSION_INPUT_MAX_CHARS,
} from "@/lib/voice/briefing";
import type { ReplyRef, StoppedAnswer } from "@/lib/voice/queue-sources";
import { confirmationWords, type SpeechScheduler } from "@/lib/voice/scheduler";
import { createVoiceQueue, type VoiceQueue } from "@/lib/voice/voice-queue";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import { lookupBotTab, useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";

/** The marking call for one host, as the read markers register it. */
export type VoiceReadMark = (entity: {
  readonly epicId: string;
  readonly chatId: string;
}) => void;

/** A `status` asked of one bot, once. */
export interface VoiceStatusRequest {
  readonly seq: number;
  readonly botId: string;
  readonly hostId: string;
  readonly botTitle: string;
  readonly delegationId: string | null;
  /** The user session asked in; an answer composed after it ended says nothing. */
  readonly sessionToken: number;
  /** The engine the delegation belongs to. */
  readonly engineGeneration: number;
}

/** A switch the voice made, until the selection lands on it. */
export interface VoiceSwitch {
  readonly botId: string;
  readonly threadId: string | null;
  /**
   * The anchor of the thread the bot's rail held when the switch was made
   * (`null`: its channel): what the tab shows until it spends the landing.
   */
  readonly fromAnchor: string | null;
  readonly at: number;
}

/**
 * How long a voice switch waits for the bot's tab to land on its thread;
 * until then the selections the landing passes through (the channel, an
 * earlier rail) are the voice's, not the person's.
 */
export const VOICE_SWITCH_SETTLE_MS = 10_000;

const NO_BOTS: ReadonlyArray<BotRecord> = [];
const NO_STATUS_REQUESTS: ReadonlyArray<VoiceStatusRequest> = [];

/** A `status` accepted, and its prose once composed; appended in the order asked. */
interface StatusSlot {
  readonly request: VoiceStatusRequest;
  text: string | null;
}

/** What the controller and the queue's sources share. */
export interface VoiceQueueOwner {
  /** `null` until the first session starts. */
  readonly queue: VoiceQueue | null;
  readonly attention: VoiceAttention;
  readonly hostOf: (ref: ReplyRef) => string;
  readonly bots: ReadonlyArray<BotRecord>;
  readonly registerMark: (hostId: string, mark: VoiceReadMark | null) => void;
  readonly voiceSwitch: { current: VoiceSwitch | null };
  /** Every `status` accepted and not yet composed, oldest first: each gets its own reader. */
  readonly statusRequests: ReadonlyArray<VoiceStatusRequest>;
  readonly onStatusComposed: (
    request: VoiceStatusRequest,
    text: string,
  ) => void;
  /**
   * A session starts: what the attention tier holds now is queued without
   * an offer, and the briefing of it is returned for the mint's `input`.
   */
  readonly beginQueue: () => string;
  /** The session ended: the queue, a pending status and a switch are forgotten. */
  readonly resetQueue: () => void;
  /** The focused bot's channel as the controller resolves it. */
  readonly noteChannel: (channelId: string | null) => void;
  /** The focused feed will say this row: the queue does not offer it too. */
  readonly noteFocused: (messageId: string) => void;
  /**
   * The queue holds this row's saying (a Read in progress, or the person
   * heard it or set it aside): the focused feed never says it.
   */
  readonly keepsFromFocus: (messageId: string) => boolean;
  /** The focused feed passed an announcement over: the queue keeps it, unsaid. */
  readonly noteAnnouncement: VoiceQueue["addAnnouncement"];
  /**
   * A bot's stopped answers as its stream says now, kept whether or not a
   * session runs (the opening briefing names them) and handed to the queue
   * while one does.
   */
  readonly noteStopped: (facts: StoppedFacts) => void;
  /** The bot's tab closed: its reading is no longer kept. */
  readonly forgetStopped: (botId: string) => void;
  /**
   * The bot's stream closed for good, or the bot is gone (never merely a
   * reading not come yet): no reading will come again, so its stopped
   * answers leave the live queue too (their pending reads and offers
   * withdrawn), besides the kept reading.
   */
  readonly dropStopped: (botId: string) => void;
}

/** One bot's stopped answers, as `syncStopped` takes them less the time. */
export interface StoppedFacts {
  readonly botId: string;
  readonly hostId: string;
  readonly channelChatId: string;
  readonly stopped: ReadonlyArray<StoppedAnswer>;
}

/**
 * The voice queue's owner in the session controller (Tracy Bots voice,
 * VT4): builds the queue over the controller's speech scheduler, installs
 * the queue's executor in the store (`runVoiceQueueVerb`), carries out
 * `switch` and `status`, and composes the briefing a session opens with.
 */
export function useVoiceQueueOwner(input: {
  readonly ensureSpeech: () => SpeechScheduler;
  /** The app host's bot list; `undefined` while it has not answered. */
  readonly botList: BotListResponse | undefined;
  readonly appHostId: string | null;
  readonly botTitle: (botId: string) => string;
  /** A row said through the queue: the focused feed's memory of its chat takes it as said. */
  readonly noteHeard: (chatId: string, messageId: string) => void;
}): VoiceQueueOwner {
  const { ensureSpeech, botList, appHostId, botTitle, noteHeard } = input;
  const bots = botList?.bots ?? NO_BOTS;
  const navigate = useNavigate();
  const attention = useVoiceAttention();
  const attentionRef = useRef(attention);
  const botTitleRef = useRef(botTitle);
  useEffect(() => {
    attentionRef.current = attention;
    botTitleRef.current = botTitle;
  }, [attention, botTitle]);
  /** The focused bot's channel, once known: a focus on it with no thread is this chat. */
  const channelIdRef = useRef<string | null>(null);
  const noteChannel = useCallback((channelId: string | null) => {
    channelIdRef.current = channelId;
  }, []);
  const marksRef = useRef(new Map<string, VoiceReadMark>());
  const registerMark = useCallback(
    (hostId: string, mark: VoiceReadMark | null) => {
      if (mark === null) marksRef.current.delete(hostId);
      else marksRef.current.set(hostId, mark);
    },
    [],
  );
  const voiceSwitch = useRef<VoiceSwitch | null>(null);
  const isFocused = useCallback((botId: string, chatId: string): boolean => {
    const current = useVoiceSessionStore.getState().focus;
    if (current === null || current.botId !== botId) return false;
    return (current.threadId ?? channelIdRef.current) === chatId;
  }, []);
  // A reply's records are read on the host the bot's tab is bound to, else
  // the bot's own host, else the one the row happened on.
  const hostOf = useCallback(
    (ref: ReplyRef): string =>
      lookupBotTab(useBotTabsStore.getState().tabs, ref.botId)?.hostId ??
      bots.find((bot) => bot.botId === ref.botId)?.boundHostId ??
      ref.originHostId ??
      appHostId ??
      "",
    [appHostId, bots],
  );
  const hostOfRef = useRef(hostOf);
  useEffect(() => {
    hostOfRef.current = hostOf;
  }, [hostOf]);

  // `switch`: the bot's tab opens on the thread (or its channel) the way a
  // tapped notification lands it, and that is the focus at once; the
  // selections the landing passes through are the voice's, not a move.
  const switchTo = useCallback(
    (target: {
      readonly botId: string;
      readonly hostId: string | null;
      readonly threadId: string | null;
      readonly messageId: string | null;
    }) => {
      const tabs = useBotTabsStore.getState();
      const existing = lookupBotTab(tabs.tabs, target.botId);
      const hostId = existing?.hostId ?? target.hostId ?? appHostId;
      if (hostId === null) return;
      if (existing === null) {
        tabs.openBotTab({
          botId: target.botId,
          hostId,
          title: botTitleRef.current(target.botId),
        });
      }
      const rail = Object.hasOwn(
        useBotOpenThreadStore.getState().byBotId,
        target.botId,
      )
        ? useBotOpenThreadStore.getState().byBotId[target.botId]
        : null;
      voiceSwitch.current = {
        botId: target.botId,
        threadId: target.threadId,
        fromAnchor: rail?.kind === "thread" ? rail.anchorMessageId : null,
        at: Date.now(),
      };
      useVoiceSessionStore.getState().setFocus({
        botId: target.botId,
        hostId,
        threadId: target.threadId,
        anchorMessageId: null,
        anchorThread: null,
      });
      useBotTabLandingStore.getState().request(target.botId, {
        kind: "thread",
        threadId: target.threadId,
        messageId: target.messageId,
      });
      navigateToTabIntent(navigate, botTabIntent(target.botId), undefined);
    },
    [appHostId, navigate],
  );
  const switchRef = useRef(switchTo);
  useEffect(() => {
    switchRef.current = switchTo;
  }, [switchTo]);

  const queueRef = useRef<VoiceQueue | null>(null);
  const [queue, setQueue] = useState<VoiceQueue | null>(null);
  const ensureQueue = useCallback((): VoiceQueue => {
    const existing = queueRef.current;
    if (existing !== null) return existing;
    const created = createVoiceQueue({
      scheduler: {
        enqueue: (item) => ensureSpeech().enqueue(item),
        withdraw: (itemId) => ensureSpeech().withdraw(itemId),
      },
      publish: (items) => useVoiceSessionStore.getState().setQueue(items),
      botTitle: (botId) => botTitleRef.current(botId),
      markRead: ({ hostId, botId, chatId }) => {
        const mark = marksRef.current.get(hostId);
        if (mark === undefined) {
          appLogger.warn("[voice] no read marker for the item's host", {});
          return;
        }
        mark({ epicId: botId, chatId });
      },
      switchTo: (target) => switchRef.current(target),
      noteHeard,
      isFocused,
      attention: () => attentionRef.current,
    });
    queueRef.current = created;
    setQueue(created);
    return created;
  }, [ensureSpeech, isFocused, noteHeard]);

  // `status`: one bot's readings gathered by a reader mounted for each ask,
  // composed once, and appended under the request it answers. Every
  // accepted ask is answered, in the order asked: a later one composed
  // first waits for the ones before it.
  const [statusRequests, setStatusRequests] =
    useState<ReadonlyArray<VoiceStatusRequest>>(NO_STATUS_REQUESTS);
  const statusOrderRef = useRef<StatusSlot[]>([]);
  const statusSeqRef = useRef(0);
  const appendStatus = useCallback(
    (request: VoiceStatusRequest, text: string) => {
      const now = useVoiceSessionStore.getState();
      if (now.phase === "idle" || now.sessionToken !== request.sessionToken) {
        return;
      }
      ensureSpeech().enqueue({
        id: `status:${request.seq}`,
        priority: "focused",
        text,
        // A delegation belongs to one engine: one replaced meanwhile is gone.
        delegationId:
          now.engineGeneration === request.engineGeneration
            ? request.delegationId
            : null,
        confirmWords: confirmationWords({
          botTitle: request.botTitle,
          threadTitle: null,
          text,
        }),
        onDelivered: null,
        onGivenUp: null,
      });
    },
    [ensureSpeech],
  );
  const onStatusComposed = useCallback(
    (request: VoiceStatusRequest, text: string) => {
      setStatusRequests((current) =>
        current.filter((candidate) => candidate.seq !== request.seq),
      );
      const order = statusOrderRef.current;
      const slot = order.find(
        (candidate) => candidate.request.seq === request.seq,
      );
      if (slot === undefined) return;
      slot.text = text;
      for (;;) {
        const head = order.at(0);
        if (head === undefined || head.text === null) return;
        order.shift();
        appendStatus(head.request, head.text);
      }
    },
    [appendStatus],
  );

  // The queue's executor: `runVoiceQueueVerb` reaches it, for the router's
  // spoken verbs and the Waiting control's buttons alike.
  useEffect(() => {
    useVoiceSessionStore.getState().setQueueDriver({
      noteSwitched: (itemId) => ensureQueue().noteSwitched(itemId),
      run: (verb) => {
        if (verb.kind !== "status") return ensureQueue().run(verb);
        const now = useVoiceSessionStore.getState();
        const botId = verb.botId ?? now.focus?.botId ?? null;
        if (botId === null) return "nothing";
        const hostId =
          lookupBotTab(useBotTabsStore.getState().tabs, botId)?.hostId ??
          (now.focus?.botId === botId ? now.focus.hostId : null) ??
          appHostId;
        if (hostId === null) return "nothing";
        statusSeqRef.current += 1;
        const request: VoiceStatusRequest = {
          seq: statusSeqRef.current,
          botId,
          hostId,
          botTitle: botTitleRef.current(botId),
          delegationId: verb.delegationId,
          sessionToken: now.sessionToken,
          engineGeneration: now.engineGeneration,
        };
        statusOrderRef.current.push({ request, text: null });
        setStatusRequests((current) => [...current, request]);
        return "appended";
      },
    });
    return () => {
      useVoiceSessionStore.getState().setQueueDriver(null);
    };
  }, [appHostId, ensureQueue]);

  const stoppedRef = useRef(new Map<string, StoppedFacts>());
  const noteStopped = useCallback((facts: StoppedFacts) => {
    stoppedRef.current.set(facts.botId, facts);
    const live = useVoiceSessionStore.getState().phase !== "idle";
    if (live) queueRef.current?.syncStopped({ ...facts, seenAt: Date.now() });
  }, []);
  const forgetStopped = useCallback((botId: string) => {
    stoppedRef.current.delete(botId);
  }, []);
  const dropStopped = useCallback((botId: string) => {
    const kept = stoppedRef.current.get(botId);
    stoppedRef.current.delete(botId);
    // The recovery path: a reading with nothing stopped takes the bot's
    // stopped items out, withdrawing what was about to be said of them.
    queueRef.current?.syncStopped({
      botId,
      hostId: kept?.hostId ?? "",
      channelChatId: kept?.channelChatId ?? "",
      stopped: [],
      seenAt: Date.now(),
    });
  }, []);

  const beginQueue = useCallback((): string => {
    const briefed = attentionRef.current;
    const queue = ensureQueue();
    queue.begin(briefed.answers, (ref) => hostOfRef.current(ref));
    // What the bots' streams already say stopped is in the queue, and so in
    // the briefing, from the first word.
    const now = Date.now();
    for (const facts of stoppedRef.current.values()) {
      queue.syncStopped({ ...facts, seenAt: now });
    }
    return composeBriefing({
      answers: briefed.answers,
      prompts: briefed.prompts,
      items: queue.items(),
      botTitle: (botId) => botTitleRef.current(botId),
      settledIds: queue.settledPromptIds(),
      maxChars: VOICE_SESSION_INPUT_MAX_CHARS,
    });
  }, [ensureQueue]);

  const resetQueue = useCallback(() => {
    queueRef.current?.reset();
    setStatusRequests(NO_STATUS_REQUESTS);
    statusOrderRef.current = [];
    voiceSwitch.current = null;
  }, []);

  const noteFocused = useCallback((messageId: string) => {
    queueRef.current?.noteFocused(messageId);
  }, []);
  const keepsFromFocus = useCallback(
    (messageId: string): boolean =>
      queueRef.current?.keepsFromFocus(messageId) ?? false,
    [],
  );
  const noteAnnouncement = useCallback<VoiceQueue["addAnnouncement"]>(
    (found) => queueRef.current?.addAnnouncement(found),
    [],
  );

  return {
    queue,
    attention,
    hostOf,
    bots,
    registerMark,
    voiceSwitch,
    statusRequests,
    onStatusComposed,
    beginQueue,
    resetQueue,
    noteChannel,
    noteFocused,
    keepsFromFocus,
    noteAnnouncement,
    noteStopped,
    forgetStopped,
    dropStopped,
  };
}
