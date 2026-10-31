import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, type UseNavigateResult } from "@tanstack/react-router";
import type {
  BotConversationRecord,
  BotConversationSendResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { MicrophoneAccessStatus } from "@traycer-clients/shared/platform/runner-host";
import { useBotConversationListQuery } from "@/hooks/bots/use-bot-conversation-list-query";
import { useBotListChangedSubscriptionForApp } from "@/hooks/bots/use-bot-list-changed-subscription";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useBotConversationSendMutation } from "@/hooks/bots/use-bot-mutations";
import { useBotThreadListQuery } from "@/hooks/bots/use-bot-thread-list-query";
import { usePersonalEnvironment } from "@/hooks/environment/use-addressed-environment";
import { dictationCaptureConstraints } from "@/hooks/composer/dictation-capture-constraints";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useNotificationMarkEntityRead } from "@/hooks/notifications/use-notification-mark-entity-read-mutation";
import { announcementsOf, type Announcement } from "@/lib/voice/queue-sources";
import {
  useVoiceQueueOwner,
  VOICE_SWITCH_SETTLE_MS,
  type VoiceSwitch,
} from "@/hooks/voice/use-voice-queue-owner";
import { useVoiceAvailabilityQuery } from "@/hooks/voice/use-voice-availability-query";
import { useVoiceDirectory } from "@/hooks/voice/use-voice-directory";
import {
  useVoiceMicrophoneAccessMutation,
  useVoiceRouteMutation,
  useVoiceSessionEndMutation,
  useVoiceSessionMintMutation,
  useVoiceShellIndicatorMutation,
  useVoiceShellLiveMutation,
} from "@/hooks/voice/use-voice-session-mutations";
import { voiceQueryKeys } from "@/lib/query-keys";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { appLogger, describeLogError } from "@/lib/logger";
import { useChatSessionHandleForContainer } from "@/lib/registries/chat-session-registry";
import { activateTabIntent, navigateToTabIntent } from "@/lib/tab-navigation";
import { botTabIntent } from "@/lib/tab-navigation/intents";
import { mainBotOf } from "@/lib/bots/bot-main";
import { watchAudioLevel, type AudioLevelWatch } from "@/lib/voice/audio-level";
import { tupleHolds, type BoundTarget } from "@/lib/voice/directory";
import { VoiceEngineError, type VoiceEngine } from "@/lib/voice/engine";
import {
  baselineReplyWatchExcept,
  createReplyWatchMemory,
  replySpeechText,
  requestIdAnsweredIn,
  spokenReplyOf,
  takeNewBotReplies,
  type FocusedReply,
  type ReplyRecords,
  type ReplyRow,
  type ReplyWatchMemory,
} from "@/lib/voice/focused-replies";
import { createBrowserGptLiveEngine } from "@/lib/voice/gpt-live-engine";
import {
  parseRouterResponse,
  resolveRoute,
  routerRequestBody,
  type ControlVerb,
  type RoutedDecision,
} from "@/lib/voice/router";
import {
  createSayLoop,
  type AcceptedRequest,
  type ReplyPlace,
  type ReplyPlacement,
  type RouteRequest,
  type SayLoop,
} from "@/lib/voice/say-loop";
import {
  confirmationWords,
  createSpeechScheduler,
  type SpeechScheduler,
} from "@/lib/voice/scheduler";
import {
  MAX_SHORT_SESSIONS,
  REMINT_BEFORE_EXPIRY_MS,
  REMINT_CONTEXT_USAGE_RATIO,
  SHORT_SESSION_MS,
  remintInput,
} from "@/lib/voice/session-input";
import { useRunnerHost } from "@/providers/use-runner-host";
import {
  VoiceQueueSources,
  VoiceStoppedSources,
} from "@/components/layout/voice/voice-queue-feed";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useBotOpenThreadStore,
  useBotRail,
  type BotOpenThread,
  type BotRail,
} from "@/stores/bots/bot-open-thread-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import { lookupBotTab, useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { selectHostFocusedRef } from "@/stores/tabs/selectors";
import { useTabsStore } from "@/stores/tabs/store";
import {
  isUtteranceOpen,
  sameFocus,
  useVoiceSessionStore,
  type VoiceEndReason,
  type VoiceFocus,
} from "@/stores/voice/voice-session-store";

/**
 * A navigation by voice, until it settles: to another bot's tab, or to
 * another thread (or the channel) of the bot whose tab is active.
 */
interface VoiceNavigation {
  /** The bot whose tab was active when the voice moved; `null` for none. */
  readonly fromBotId: string | null;
  readonly toBotId: string;
  /** The anchor the voice opens in the target's rail; `null` for its channel. */
  readonly toAnchorMessageId: string | null;
  /**
   * `"pending"` while the tab's navigation is out; then whether it landed.
   * Written once, when the navigation settles.
   */
  outcome: "pending" | "landed" | "failed";
  /** The selection sync has seen the target showing; the departing view is left. */
  arrived: boolean;
  /**
   * What that tab's rail held then (the anchor of its open thread, `null`
   * for the channel): only that selection, still showing, is the voice's own.
   */
  readonly fromAnchorMessageId: string | null;
}

/**
 * One vendor session attempt: the engine and what the mint said about it.
 * Every engine event and every async stage checks that the attempt is still
 * the controller's and not cancelled before touching anything; an End, a
 * replacement or an unmount cancels it, and its vendor accounting (the
 * close, the end route) finishes on its own afterwards.
 */
interface Attempt {
  /** The store's engine generation this attempt is. */
  readonly generation: number;
  readonly engine: VoiceEngine;
  /** The server's id, owned the moment the mint answers. */
  sessionId: string | null;
  expiresAt: number;
  started: boolean;
  /** When the engine reported started; `0` until then. */
  startedAt: number;
  /** What the mint refused with, so a pre-start failure keeps its reason. */
  failure: VoiceEndReason | null;
  cancelled: boolean;
}

/**
 * Owns the voice session for this window (Tracy Bots voice, VT2): the
 * microphone, the engine behind the seam, the speech scheduler, the say loop
 * and the focused hear loop. Mounted once, app-wide; the Talk control and the
 * session strip reach it through the store's `driver`.
 *
 * Ending is a terminal latch, whatever the close reason: local capture stops
 * at once (the microphone tracks, the voice's playback), replacement timers
 * are cancelled, every engine event is fenced, and the vendor accounting
 * finishes asynchronously. Desktop lifecycle (Tanveer, 2026-10-29): window
 * close and blur keep the session (the shell hides a window whose voice is
 * live instead of destroying it); lock, sleep and quit end it, so an open
 * microphone never outlives the person at the machine.
 */
export function VoiceSessionController(): ReactNode {
  const runnerHost = useRunnerHost();
  // The voice routes and the shell's two voice calls, as keyed mutations;
  // the controller awaits their promises and fences on the attempt, never
  // on a per-call callback. The mint runs inside the engine's SDP exchange
  // and is fenced the same way: ownership is checked after it answers.
  const { mutateAsync: mintAsync } = useVoiceSessionMintMutation();
  const { mutateAsync: endAsync } = useVoiceSessionEndMutation();
  const { mutateAsync: shellLiveAsync } = useVoiceShellLiveMutation();
  const { mutateAsync: shellIndicatorAsync } = useVoiceShellIndicatorMutation();
  const { mutateAsync: microphoneAccessAsync } =
    useVoiceMicrophoneAccessMutation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  /**
   * A navigation by voice to another bot, until its tab is the active one:
   * the selection sync does not read the tab it leaves as a move.
   */
  const voiceNavigationRef = useRef<VoiceNavigation | null>(null);
  /** Counts voice navigations, so a settling one can tell whether a later one superseded it. */
  const voiceNavigationSerialRef = useRef(0);
  /** Gives each question the voice asks its own scheduler id, to withdraw it by. */
  const askSerialRef = useRef(0);
  /** The strip's own actions by voice; set once the session's controls exist. */
  const controlRef = useRef<(verb: ControlVerb) => void>(() => undefined);
  // Whether this deployment offers voice, read once per window before Talk
  // is drawn; a dormant mint invalidates it, so the answer is read again.
  const availability = useVoiceAvailabilityQuery(true);
  const available = availability.data;
  useEffect(() => {
    if (available === undefined) return;
    useVoiceSessionStore
      .getState()
      .setAvailability(available ? "live" : "dormant");
  }, [available]);
  const appHostId = useEffectiveHostId();
  const appClient = useHostClient();
  const botsSupported = useHostMethodSupport(appHostId, "bot.list") === true;
  const bots = useBotListQuery(appClient, botsSupported);
  // The destination follows the list as it changes elsewhere (a main bot
  // created or archived on another window or host): this controller joins
  // the shared change subscription itself, under the same capability gate as
  // its list read, since with Show Tracy off and Home never opened nothing
  // else would keep the list current.
  useBotListChangedSubscriptionForApp(botsSupported);
  const phase = useVoiceSessionStore((state) => state.phase);
  const focus = useVoiceSessionStore((state) => state.focus);
  const focusClient = useHostClientForHostId(focus?.hostId ?? null);

  // Where a session goes with nothing selected: the personal environment's
  // main bot, read from the bot list itself (the record the fixed Tracy
  // entry resolves from too), so "Show Tracy" off takes nothing away from
  // the voice. Unknown while the list or the environment has not answered,
  // or with no main bot: then Talk is disabled and the start refuses, since a
  // session with nowhere to post would still be billed.
  const personal = usePersonalEnvironment(appClient, botsSupported);
  const mainBot = useMemo(() => {
    if (
      !personal.resolved ||
      personal.environmentId === null ||
      bots.data === undefined
    ) {
      return null;
    }
    return mainBotOf(bots.data, personal.environmentId);
  }, [bots.data, personal]);
  const mainBotRef = useRef(mainBot);
  useEffect(() => {
    mainBotRef.current = mainBot;
  }, [mainBot]);
  const selectedBotId = useTabsStore((state) => {
    const ref = selectHostFocusedRef(state);
    return ref !== null && ref.kind === "bot" ? ref.id : null;
  });
  const destinationKnown = selectedBotId !== null || mainBot !== null;
  useEffect(() => {
    useVoiceSessionStore.getState().setDestinationKnown(destinationKnown);
  }, [destinationKnown]);

  const botTitle = useCallback(
    (botId: string): string =>
      bots.data?.bots.find((bot) => bot.botId === botId)?.title ??
      lookupBotTab(useBotTabsStore.getState().tabs, botId)?.title ??
      "the bot",
    [bots.data],
  );
  const botTitleRef = useRef(botTitle);
  useEffect(() => {
    botTitleRef.current = botTitle;
  }, [botTitle]);

  // One scheduler per window, built from the first Talk and reset at each
  // session's end, mirroring its three facts into the store for the strip.
  // Held twice: the ref for the engine's events and the say loop, which run
  // outside render, and the state for the feed that renders with it.
  const attemptRef = useRef<Attempt | null>(null);
  const speechRef = useRef<SpeechScheduler | null>(null);
  const [speech, setSpeech] = useState<SpeechScheduler | null>(null);
  const ensureSpeech = useCallback((): SpeechScheduler => {
    const existing = speechRef.current;
    if (existing !== null) return existing;
    const created = createSpeechScheduler({
      append: (text, delegationId) => {
        const attempt = attemptRef.current;
        if (attempt === null || attempt.cancelled || !attempt.started) return;
        try {
          attempt.engine.appendCommentary(text, delegationId);
        } catch (error) {
          appLogger.warn("[voice] append failed", {
            error: describeLogError(error),
          });
        }
      },
      now: Date.now,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (handle) => {
        if (typeof handle === "number") window.clearTimeout(handle);
      },
    });
    created.subscribe((activity) =>
      useVoiceSessionStore.getState().setActivity(activity),
    );
    speechRef.current = created;
    setSpeech(created);
    return created;
  }, []);
  useEffect(
    () => () => {
      speechRef.current?.dispose();
      speechRef.current = null;
    },
    [],
  );

  // What each watched chat has shown, for the user session: a feed remount
  // re-baselines nothing. State, not a ref, because render hands a chat's
  // memory to its feed; the map itself is mutated in place.
  const [watchMemories] = useState(() => new Map<string, ReplyWatchMemory>());
  // A row the queue said is said for the focused feed too: returning to its
  // chat later never reads it again.
  const noteHeard = useCallback(
    (chatId: string, messageId: string) => {
      const memory = watchMemories.get(chatId);
      if (memory === undefined) return;
      memory.seen.add(messageId);
      memory.scheduled.add(messageId);
    },
    [watchMemories],
  );
  const voiceQueue = useVoiceQueueOwner({
    ensureSpeech,
    botList: bots.data,
    appHostId,
    botTitle,
    noteHeard,
  });
  const {
    beginQueue,
    isBeingRead,
    noteAnnouncement,
    noteChannel,
    noteFocused,
    resetQueue,
  } = voiceQueue;

  // ---- Posting ---------------------------------------------------------- //
  const send = useBotConversationSendMutation(focusClient);
  const conversations = useBotConversationListQuery(
    focusClient,
    focus?.botId ?? "",
    focus !== null,
  );
  // The focused bot's channel, named with the bot it is the channel of: the
  // conversation list can still be the previous bot's for a render after a
  // navigation by voice, and a send must never borrow it.
  const channel = useMemo(() => {
    if (focus === null || conversations.data === undefined) return null;
    const appConversationChatId =
      bots.data?.bots.find((bot) => bot.botId === focus.botId)
        ?.appConversationChatId ?? null;
    const rows = conversations.data.conversations.filter(
      (row) => row.botId === focus.botId,
    );
    const conversationId =
      channelConversation(rows, appConversationChatId)?.conversationId ?? null;
    return conversationId === null
      ? null
      : { botId: focus.botId, hostId: focus.hostId, conversationId };
  }, [bots.data, conversations.data, focus]);
  const channelId = conversationIdOf(channel);
  useEffect(() => {
    noteChannel(channelId);
  }, [channelId, noteChannel]);
  const viewerUserId = useAuthStore((state) => state.profile?.userId ?? null);
  const { mutateAsync: sendAsync } = send;
  const sendRef = useRef<
    (focus: VoiceFocus, text: string) => Promise<BotConversationSendResponse>
  >(() => Promise.reject(new Error("not ready")));
  const channelRef = useRef(channel);
  useEffect(() => {
    channelRef.current = channel;
    sendRef.current = async (target, text) => {
      if (
        channel === null ||
        channel.botId !== target.botId ||
        channel.hostId !== target.hostId
      ) {
        throw new Error("The bot's channel is not known yet.");
      }
      const channelId = channel.conversationId;
      // Where the thread panel's box sends: into the thread by its id, or
      // under an anchor nobody has replied under as the reply that opens
      // its thread. A top-level post names neither.
      return sendAsync({
        botId: target.botId,
        conversationId: channelId,
        text,
        threadId: target.threadId,
        announcementId:
          target.anchorThread === "unopened" ? target.anchorMessageId : null,
        redeliver: null,
        supersedes: null,
        answer: null,
      });
    };
  }, [channel, sendAsync]);
  const viewerRef = useRef(viewerUserId);
  useEffect(() => {
    viewerRef.current = viewerUserId;
  }, [viewerUserId]);

  // ---- Routing ---------------------------------------------------------- //
  // The router's directory, read while a session runs, and the router's one
  // call per utterance. A route that names a thread outside the focused bot
  // is checked against a directory read fresh, before anything navigates.
  const directory = useVoiceDirectory(
    appClient,
    appHostId,
    botsSupported && phase !== "idle",
  );
  const { mutateAsync: routeAsync } = useVoiceRouteMutation();
  const decideRef = useRef<(request: RouteRequest) => Promise<RoutedDecision>>(
    () => Promise.resolve({ kind: "refused", reason: "unavailable" }),
  );
  const recheckRef = useRef(directory.current);
  useEffect(() => {
    recheckRef.current = directory.current;
    decideRef.current = async (request) => {
      let snapshot = directory.current();
      const answer = await routeAsync(
        routerRequestBody(
          snapshot,
          {
            segments: request.segments,
            askedQuestion: request.askedQuestion,
          },
          Date.now(),
        ),
      );
      if (answer.kind !== "ok") {
        appLogger.warn("[voice] route did not answer", { kind: answer.kind });
        return { kind: "refused", reason: "unavailable" };
      }
      const result = parseRouterResponse(answer.body);
      const namedThread = result?.target.threadId ?? null;
      if (
        namedThread !== null &&
        !snapshot.threads.some(
          (thread) =>
            thread.threadId === namedThread &&
            thread.botId === snapshot.focus?.botId,
        )
      ) {
        snapshot = await directory.refresh();
      }
      return resolveRoute(result, snapshot, request.segments.length);
    };
  }, [directory, routeAsync]);

  // One say loop per user session: its request bindings and in-flight actions
  // carry the store's session token, so a late acceptance from an ended or
  // replaced session changes nothing.
  const sayLoopRef = useRef<SayLoop | null>(null);
  /** The focused feed's reconciliation of an accepted request against loaded rows. */
  const reconcileRef = useRef<(request: AcceptedRequest) => void>(
    () => undefined,
  );
  const sayLoop = useCallback((): SayLoop => {
    const existing = sayLoopRef.current;
    if (existing !== null) return existing;
    const created = createSayLoop({
      store: useVoiceSessionStore,
      send: (target, text) => sendRef.current(target, text),
      notify: (text, delegationId) =>
        ensureSpeech().enqueue({
          id: `notify:${delegationId ?? "none"}:${Date.now()}`,
          priority: "focused",
          text,
          delegationId,
          confirmWords: confirmationWords({
            botTitle: null,
            threadTitle: null,
            text,
          }),
          onDelivered: null,
          onGivenUp: null,
        }),
      ask: (text, delegationId, outcome) => {
        askSerialRef.current += 1;
        const id = `ask:${askSerialRef.current}`;
        const speech = ensureSpeech();
        speech.enqueue({
          id,
          priority: "ask",
          text,
          delegationId,
          confirmWords: confirmationWords({
            botTitle: null,
            threadTitle: null,
            text,
          }),
          onDelivered: outcome.onDelivered,
          onGivenUp: outcome.onGivenUp,
        });
        // Taken back whatever its stage: a question already appended is never
        // retried once its confirmation is gone.
        return () => speech.withdraw(id);
      },
      openThread: (target, response, text) => {
        if (response.threadId === null) return;
        useBotOpenThreadStore.getState().setRail(target.botId, {
          kind: "thread",
          anchorMessageId: response.messageId,
          announcement: false,
          anchorKind: null,
          sent: {
            threadId: response.threadId,
            requestId: response.requestId,
            text,
            senderUserId: viewerRef.current,
            sentAt: Date.now(),
            delivery: response.delivery,
          },
        });
      },
      botTitle: (botId) => botTitleRef.current(botId),
      onAccepted: (request) => reconcileRef.current(request),
      decide: (request) => decideRef.current(request),
      recheck: (tuple) => tupleHolds(recheckRef.current(), tuple),
      navigate: (target) => {
        const from = selectHostFocusedRef(useTabsStore.getState());
        const fromBotId = from !== null && from.kind === "bot" ? from.id : null;
        // Recorded for a move within the active bot too: its rail changes at
        // once, and the new anchor is the voice's, not the person's.
        const navigation: VoiceNavigation = {
          fromBotId,
          toBotId: target.tuple.botId,
          toAnchorMessageId:
            target.tuple.threadId === null
              ? null
              : target.focus.anchorMessageId,
          fromAnchorMessageId: railAnchorOf(fromBotId),
          outcome: "pending",
          arrived: false,
        };
        voiceNavigationRef.current = navigation;
        voiceNavigationSerialRef.current += 1;
        const serial = voiceNavigationSerialRef.current;
        // Decided the moment the navigation settles, before the tab
        // navigation puts a previous tab back for a failed one, so the
        // selection sync never reads that restore as the person's move.
        return openTarget(target, navigateRef.current, (settled) => {
          // A navigation a later one superseded can still settle as landed
          // (the tab navigation drops it without rejecting): it counts only
          // while it is the latest voice navigation and the tab shows what
          // it opened.
          const landed =
            settled &&
            serial === voiceNavigationSerialRef.current &&
            showsDestination(target);
          navigation.outcome = landed ? "landed" : "failed";
          return landed;
        });
      },
      think: (text, delegationId) => {
        const attempt = attemptRef.current;
        if (attempt === null || attempt.cancelled || !attempt.started) return;
        try {
          attempt.engine.appendThinking(text, delegationId);
        } catch (error) {
          appLogger.warn("[voice] thinking append failed", {
            error: describeLogError(error),
          });
        }
      },
      control: (verb) => controlRef.current(verb),
      schedule: (fn, ms) => {
        const handle = window.setTimeout(fn, ms);
        return () => window.clearTimeout(handle);
      },
      canSend: (target) => {
        const known = channelRef.current;
        return (
          known !== null &&
          known.botId === target.botId &&
          known.hostId === target.hostId
        );
      },
    });
    sayLoopRef.current = created;
    return created;
  }, [ensureSpeech]);

  // A post the voice navigated for waits for the bot's channel: once it is
  // known, the loop sends what waits.
  useEffect(() => {
    if (channel === null) return;
    void sayLoopRef.current?.onFocusResolved();
  }, [channel]);

  // ---- Session lifecycle ----------------------------------------------- //
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const levelWatchRef = useRef<AudioLevelWatch | null>(null);
  const expiryTimerRef = useRef<number | null>(null);
  const remintWhenClearRef = useRef<(() => void) | null>(null);
  const watchMemoryFor = useCallback(
    (chatId: string): ReplyWatchMemory => {
      const existing = watchMemories.get(chatId);
      if (existing !== undefined) return existing;
      const created = createReplyWatchMemory();
      watchMemories.set(chatId, created);
      return created;
    },
    [watchMemories],
  );
  // The re-mint path is declared below `connectEngine`, which the engine's
  // own events reach it from; the refs break the cycle.
  const remintRef = useRef<(attempt: Attempt) => Promise<void>>(() =>
    Promise.resolve(),
  );
  /** Consecutive replaced sessions that ended short-lived; a new Talk starts at none. */
  const shortSessionsRef = useRef(0);
  const requestRemintWhenClearRef = useRef<() => void>(() => undefined);
  const endRef = useRef<(reason: VoiceEndReason) => void>(() => undefined);

  /** What the shell's voice item shows for this window's live session. */
  const reportShellIndicator = useCallback(() => {
    const { muted, pausedForDictation } = useVoiceSessionStore.getState();
    void shellIndicatorAsync({ muted, pausedForDictation }).catch(
      (error: unknown) => {
        appLogger.warn("[voice] shell indicator failed", {
          error: describeLogError(error),
        });
      },
    );
  }, [shellIndicatorAsync]);

  const setShellVoiceLive = useCallback(
    (live: boolean) => {
      // The shell keeps an indicator only for a live window, so a session
      // going live reports it once the flag has landed.
      void shellLiveAsync(live)
        .then(() => {
          if (live) reportShellIndicator();
        })
        .catch((error: unknown) => {
          appLogger.warn("[voice] shell live flag failed", {
            error: describeLogError(error),
          });
        });
    },
    [reportShellIndicator, shellLiveAsync],
  );
  useEffect(
    () =>
      useVoiceSessionStore.subscribe((state, previous) => {
        if (state.phase !== "live") return;
        if (
          state.muted === previous.muted &&
          state.pausedForDictation === previous.pausedForDictation
        ) {
          return;
        }
        reportShellIndicator();
      }),
    [reportShellIndicator],
  );

  /** Stops local capture and playback at once; nothing async. */
  const releaseAudio = useCallback(() => {
    levelWatchRef.current?.stop();
    levelWatchRef.current = null;
    const audio = audioRef.current;
    if (audio !== null) {
      audio.pause();
      audio.srcObject = null;
      audioRef.current = null;
    }
    remoteStreamRef.current = null;
    const stream = micStreamRef.current;
    if (stream !== null) {
      for (const track of stream.getTracks()) track.stop();
      micStreamRef.current = null;
    }
  }, []);

  const clearTimers = useCallback(() => {
    if (expiryTimerRef.current !== null) {
      window.clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }
    remintWhenClearRef.current?.();
    remintWhenClearRef.current = null;
  }, []);

  /**
   * What the microphone carries and what the speaker plays, both switched
   * locally with no network wait. The microphone carries nothing while the
   * person muted it or while the voice is paused for dictation
   * (`pausedForDictation`); the voice's sound is silent while paused, so it
   * never reaches the dictation capture. The mute is the person's own and
   * outlives the pause.
   */
  const applyCapture = useCallback(() => {
    const { muted, pausedForDictation } = useVoiceSessionStore.getState();
    const stream = micStreamRef.current;
    if (stream !== null) {
      for (const track of stream.getAudioTracks()) {
        track.enabled = !muted && !pausedForDictation;
      }
    }
    const remote = remoteStreamRef.current;
    if (remote !== null) {
      for (const track of remote.getAudioTracks()) {
        track.enabled = !pausedForDictation;
      }
    }
  }, []);
  useEffect(
    () =>
      useVoiceSessionStore.subscribe((state, previous) => {
        if (state.pausedForDictation === previous.pausedForDictation) return;
        applyCapture();
        // Nothing is appended while paused: an item spoken into a silent
        // speaker would read as delivered from its transcript alone. The
        // item being spoken when the pause began goes back to wait, so its
        // silenced words confirm nothing and it is spoken again after
        // Resume. The engine takes appends again on Resume, once it has
        // started.
        if (state.pausedForDictation) speechRef.current?.suspendInFlight();
        const attempt = attemptRef.current;
        if (attempt !== null && attempt.started && !attempt.cancelled) {
          speechRef.current?.setReady(!state.pausedForDictation);
        }
        // Words said before dictation took the microphone and not closed
        // yet are let go: their boundary, if it comes, falls in the pause,
        // and the next request must not inherit them. A request already
        // sent finishes on its own.
        if (state.pausedForDictation) state.dropOpenSpan();
      }),
    [applyCapture],
  );

  /**
   * The vendor side of an attempt that is no longer the controller's: the
   * peer's close (confirmed or timed out) and then the server's end route,
   * for every attempt that was minted, started or not.
   */
  const settleAttempt = useCallback(
    async (attempt: Attempt): Promise<void> => {
      try {
        await attempt.engine.close();
      } catch (error) {
        appLogger.warn("[voice] engine close failed", {
          error: describeLogError(error),
        });
      }
      if (attempt.sessionId === null) return;
      // Best effort: the session is over for the person either way, and the
      // server finalizes an unended row from its sideband. A refusal is
      // the result's kind; a shell whose bridge throws (the desktop's main
      // handler failing) rejects, and is logged the same way.
      try {
        const result = await endAsync(attempt.sessionId);
        if (result.kind !== "ok") {
          appLogger.warn("[voice] end route did not answer", {
            kind: result.kind,
          });
        }
      } catch (error) {
        appLogger.warn("[voice] end route failed", {
          error: describeLogError(error),
        });
      }
    },
    [endAsync],
  );

  /**
   * Everything local a session leaves: capture, playback, timers, the
   * scheduler's items, the say loop and the feeds' memory. Synchronous, so
   * a page going away releases the microphone before it is gone.
   */
  const finishLocal = useCallback(
    (reason: VoiceEndReason | null) => {
      clearTimers();
      releaseAudio();
      resetQueue();
      speechRef.current?.reset();
      // What the loop scheduled (a confirmation's answer window) dies with
      // the session, so nothing of it reaches the next one.
      sayLoopRef.current?.dispose();
      sayLoopRef.current = null;
      watchMemories.clear();
      setShellVoiceLive(false);
      useVoiceSessionStore.getState().sessionEnded(reason);
    },
    [clearTimers, releaseAudio, resetQueue, setShellVoiceLive, watchMemories],
  );

  /**
   * The terminal latch: takes the attempt away so no event of it is heard
   * again, stops capture now, and lets the vendor accounting finish on its
   * own. Idempotent; a session that is not running has nothing to end.
   */
  const end = useCallback(
    (reason: VoiceEndReason) => {
      const store = useVoiceSessionStore.getState();
      const attempt = attemptRef.current;
      if (store.phase === "idle" && attempt === null) return;
      attemptRef.current = null;
      if (attempt !== null) attempt.cancelled = true;
      finishLocal(reason === "ended" ? null : reason);
      if (attempt !== null) void settleAttempt(attempt);
    },
    [finishLocal, settleAttempt],
  );
  useEffect(() => {
    endRef.current = end;
  }, [end]);

  /** Opens an engine on the current microphone; `input` is what it opens knowing. */
  const connectEngine = useCallback(
    async (input: string): Promise<boolean> => {
      const stream = micStreamRef.current;
      const micTrack = stream?.getAudioTracks()[0] ?? null;
      if (micTrack === null) return false;
      const attempt: Attempt = {
        generation: useVoiceSessionStore.getState().engineGeneration,
        engine: createBrowserGptLiveEngine(),
        sessionId: null,
        expiresAt: 0,
        started: false,
        startedAt: 0,
        failure: null,
        cancelled: false,
      };
      attemptRef.current = attempt;
      const owns = (): boolean =>
        attemptRef.current === attempt && !attempt.cancelled;
      const closedBeforeStart = (): VoiceEngineError =>
        new VoiceEngineError(
          "PEER_FAILED",
          "The voice session was ended before it started.",
        );
      try {
        await attempt.engine.connect({
          micTrack,
          exchangeSdp: async (offerSdp) => {
            if (!owns()) throw closedBeforeStart();
            const result = await mintAsync({ offerSdp, input });
            switch (result.kind) {
              case "ok":
                // Owned from this moment: an End during the rest of the
                // handshake still reaches the end route for it. One that
                // came while the mint was out already settled the attempt
                // without an id, so the id just minted is ended here.
                attempt.sessionId = result.session.voiceSessionId;
                attempt.expiresAt = result.session.expiresAt;
                if (!owns()) {
                  void endAsync(result.session.voiceSessionId).catch(
                    (error: unknown) => {
                      appLogger.warn("[voice] end route failed", {
                        error: describeLogError(error),
                      });
                    },
                  );
                  throw closedBeforeStart();
                }
                return result.session.answerSdp;
              case "dormant":
                // The fallback when the availability read was wrong or
                // stale: hide Talk now, and read the answer again.
                useVoiceSessionStore.getState().setAvailability("dormant");
                void queryClient.invalidateQueries({
                  queryKey: voiceQueryKeys.availabilityAll(),
                });
                attempt.failure = "unavailable";
                break;
              case "credits-exhausted":
                attempt.failure = "credits";
                break;
              case "unavailable":
              case "unauthorized":
              case "network-error":
                attempt.failure = "unavailable";
                break;
            }
            throw new VoiceEngineError(
              "EXCHANGE_FAILED",
              `voice session mint answered ${result.kind}`,
            );
          },
          onRemoteAudio: (remote) => {
            if (!owns()) return;
            levelWatchRef.current?.stop();
            const audio = audioRef.current ?? new Audio();
            audioRef.current = audio;
            audio.autoplay = true;
            audio.srcObject = remote;
            remoteStreamRef.current = remote;
            applyCapture();
            // Sound that cannot play is a session nobody can hear: it ends,
            // and says so, rather than confirming deliveries by transcript.
            void audio.play().catch((error: unknown) => {
              appLogger.warn("[voice] remote audio play failed", {
                error: describeLogError(error),
              });
              if (owns()) endRef.current("playback");
            });
            // The detector's word counts only while it is healthy: a
            // context that stays suspended or an analyser reading silence
            // from a sounding stream leaves the conservative hold in force.
            levelWatchRef.current = watchAudioLevel(
              remote,
              (speaking) => {
                if (owns()) speechRef.current?.noteOutputLevel(speaking);
              },
              (healthy) => {
                if (owns()) speechRef.current?.setLevelDetection(healthy);
              },
            );
          },
          events: {
            onInputTranscriptDelta: (text) => {
              if (!owns()) return;
              const current = useVoiceSessionStore.getState();
              // Dictation holds the microphone: a word that still arrives is
              // the person's draft, not a request.
              if (current.pausedForDictation) return;
              current.appendInputSegment(text, Date.now());
              current.pushCaptionLine({ direction: "input", text });
              ensureSpeech().noteInputTranscript();
            },
            onOutputTranscriptDelta: (text) => {
              if (!owns()) return;
              useVoiceSessionStore
                .getState()
                .pushCaptionLine({ direction: "output", text });
              ensureSpeech().noteOutputTranscript(text);
            },
            onDelegationCreated: (delegationId) => {
              if (!owns() || !attempt.started) return;
              if (useVoiceSessionStore.getState().pausedForDictation) return;
              ensureSpeech().noteDelegationCreated();
              void sayLoop().onDelegationCreated(delegationId);
            },
            onUsage: (usage) => {
              // Usage before the session started replaces nothing: a
              // replacement must retire a session that ran, or the
              // short-session budget cannot count it. The next report after
              // the start is read as usual, and the expiry timer bounds the
              // session regardless.
              if (!owns() || !attempt.started) return;
              if (
                usage.contextUsageRatio !== null &&
                usage.contextUsageRatio >= REMINT_CONTEXT_USAGE_RATIO
              ) {
                requestRemintWhenClearRef.current();
              }
            },
            onClosed: (reason) => {
              // A cancelled attempt is being settled by whoever cancelled
              // it; one that never started is finished by `connect`'s own
              // failure path, with the mint's reason intact.
              if (!owns() || !attempt.started) return;
              attemptRef.current = null;
              attempt.cancelled = true;
              // The vendor or the network ended a session that had time
              // left: a fresh one carries on with the same focus and words.
              // A session the server closed for credits refuses the re-mint
              // with 402, which ends it with the reason said.
              if (
                reason !== "app" &&
                Date.now() < attempt.expiresAt - REMINT_BEFORE_EXPIRY_MS
              ) {
                void remintRef.current(attempt);
                return;
              }
              finishLocal("connection");
              void settleAttempt(attempt);
            },
          },
        });
      } catch (error) {
        // An End or a replacement during the handshake has already finished
        // locally and is settling the attempt (its minted id included).
        if (attempt.cancelled) return false;
        attemptRef.current = null;
        attempt.cancelled = true;
        appLogger.warn("[voice] session connect failed", {
          error: describeLogError(error),
        });
        finishLocal(attempt.failure ?? "connection");
        void settleAttempt(attempt);
        return false;
      }
      if (!owns() || attempt.sessionId === null) return false;
      attempt.started = true;
      attempt.startedAt = Date.now();
      useVoiceSessionStore.getState().sessionLive({
        id: attempt.sessionId,
        expiresAt: attempt.expiresAt,
        engine: attempt.engine,
      });
      ensureSpeech().setReady(
        !useVoiceSessionStore.getState().pausedForDictation,
      );
      setShellVoiceLive(true);
      clearTimers();
      const untilRemint =
        attempt.expiresAt - REMINT_BEFORE_EXPIRY_MS - Date.now();
      expiryTimerRef.current = window.setTimeout(
        () => {
          expiryTimerRef.current = null;
          if (owns()) void remintRef.current(attempt);
        },
        Math.max(0, untilRemint),
      );
      return true;
    },
    [
      applyCapture,
      clearTimers,
      endAsync,
      ensureSpeech,
      finishLocal,
      mintAsync,
      queryClient,
      sayLoop,
      setShellVoiceLive,
      settleAttempt,
    ],
  );

  /**
   * Replaces the vendor session under the same focus, segments and queue,
   * one at a time: the old attempt is taken away and retired (its peer
   * closed, its end reported) BEFORE the microphone track is offered to a
   * new peer, so two sessions never carry the person's audio at once. The
   * scheduler keeps its items but forgets the old engine's facts, and the
   * new engine opens seeded with a summary of where the person is. Nothing
   * is replayed.
   */
  const remint = useCallback(
    async (old: Attempt): Promise<void> => {
      if (attemptRef.current === old) attemptRef.current = null;
      old.cancelled = true;
      clearTimers();
      const store = useVoiceSessionStore.getState();
      if (store.phase === "idle") {
        void settleAttempt(old);
        return;
      }
      // Every path here (the vendor's close, the expiry timer, the usage
      // threshold) counts the session it replaces: one that did not outlive
      // its own handshake ceiling gave the person nothing, and a run of them
      // is a vendor or server that is not coming back for now. Only a
      // session that ran longer resets the count; one that never started
      // ran not at all.
      const ran = old.started ? Date.now() - old.startedAt : 0;
      shortSessionsRef.current =
        ran < SHORT_SESSION_MS ? shortSessionsRef.current + 1 : 0;
      if (shortSessionsRef.current >= MAX_SHORT_SESSIONS) {
        finishLocal("connection");
        void settleAttempt(old);
        return;
      }
      ensureSpeech().handoff();
      // A new engine generation under the SAME user session: an action
      // whose send is still out completes as this session's work.
      store.engineReplacing();
      const generation = useVoiceSessionStore.getState().engineGeneration;
      await settleAttempt(old);
      // The person ended, or another replacement began, while the old one
      // closed: nothing to open.
      const now = useVoiceSessionStore.getState();
      if (
        now.phase !== "connecting" ||
        now.engineGeneration !== generation ||
        micStreamRef.current === null
      ) {
        return;
      }
      await connectEngine(
        remintInput({
          focus: now.focus,
          botTitle: botTitleRef.current,
          queue: now.queue,
        }),
      );
    },
    [clearTimers, connectEngine, ensureSpeech, finishLocal, settleAttempt],
  );

  const requestRemintWhenClear = useCallback(() => {
    if (remintWhenClearRef.current !== null) return;
    const current = ensureSpeech();
    const attempt = attemptRef.current;
    if (attempt === null) return;
    if (current.isClear()) {
      void remint(attempt);
      return;
    }
    const unsubscribe = current.subscribe(() => {
      if (!current.isClear()) return;
      unsubscribe();
      remintWhenClearRef.current = null;
      if (attemptRef.current === attempt) void remint(attempt);
    });
    remintWhenClearRef.current = unsubscribe;
  }, [remint, ensureSpeech]);

  useEffect(() => {
    remintRef.current = remint;
    requestRemintWhenClearRef.current = requestRemintWhenClear;
  }, [remint, requestRemintWhenClear]);

  const start = useCallback(async (): Promise<void> => {
    const store = useVoiceSessionStore.getState();
    if (store.phase !== "idle" || store.availability !== "live") return;
    // The session starts focused on the channel or thread the person has
    // open, or on the personal main bot when none is (V6), whose tab opens
    // then. With neither, nothing starts: no session is minted with nowhere
    // to post.
    const destination =
      readSelection() ?? openMainBot(mainBotRef.current, appHostId, navigate);
    if (destination === null) return;
    store.sessionConnecting();
    shortSessionsRef.current = 0;
    const { sessionToken: token, engineGeneration: generation } =
      useVoiceSessionStore.getState();
    store.setFocus(destination);
    // The first thing the session says is the briefing; what it covers is
    // queued and not offered again.
    const briefing = beginQueue();
    const stillStarting = (): boolean => {
      const now = useVoiceSessionStore.getState();
      return (
        now.phase === "connecting" &&
        now.sessionToken === token &&
        now.engineGeneration === generation
      );
    };
    let access: MicrophoneAccessStatus;
    try {
      access = await microphoneAccessAsync();
    } catch (error) {
      appLogger.warn("[voice] microphone access request failed", {
        error: describeLogError(error),
      });
      if (stillStarting()) finishLocal("microphone");
      return;
    }
    if (!stillStarting()) return;
    if (access === "denied") {
      finishLocal("microphone");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: dictationCaptureConstraints(),
      });
    } catch (error) {
      appLogger.warn("[voice] microphone open failed", {
        error: describeLogError(error),
      });
      if (stillStarting()) finishLocal("microphone");
      return;
    }
    // Ended while the permission prompt was up: the microphone just opened
    // is closed again before anything hears it.
    if (!stillStarting()) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    micStreamRef.current = stream;
    applyCapture();
    await connectEngine(briefing);
  }, [
    appHostId,
    applyCapture,
    beginQueue,
    connectEngine,
    finishLocal,
    microphoneAccessAsync,
    navigate,
  ]);

  const setMuted = useCallback(
    (muted: boolean) => {
      useVoiceSessionStore.getState().setMuted(muted);
      applyCapture();
    },
    [applyCapture],
  );

  useEffect(() => {
    controlRef.current = (verb) => {
      switch (verb) {
        case "end":
          end("ended");
          return;
        case "mute":
          setMuted(true);
          return;
        case "resume":
          setMuted(false);
          return;
        case "captions": {
          const store = useVoiceSessionStore.getState();
          store.setCaptions(!store.captions);
          return;
        }
      }
    };
  }, [end, setMuted]);

  useEffect(() => {
    const store = useVoiceSessionStore.getState();
    store.setDriver({
      start: () => {
        void start();
      },
      end: () => end("ended"),
      setMuted,
    });
    return () => {
      useVoiceSessionStore.getState().setDriver(null);
    };
  }, [end, setMuted, start]);

  // The shell's voice item, shown while this window is away: its Mute or
  // Unmute and its End act on this window's session as the strip's do.
  useEffect(() => {
    const subscription = runnerHost.onVoiceTrayAction((action) => {
      if (action.kind === "end") {
        end("ended");
        return;
      }
      if (useVoiceSessionStore.getState().phase === "live") {
        setMuted(action.muted);
      }
    });
    return () => subscription.dispose();
  }, [end, runnerHost, setMuted]);

  // Lock, sleep and the page going away all end the session through the
  // one latch: the store's tokens move first, so a microphone prompt still
  // open resolves into nothing, local capture and playback stop
  // synchronously, and the vendor accounting is best effort from a document
  // that may not outlive it. The shell's own close keeps a voice window
  // alive, so this is the lock, the quit and a reload, not an ordinary
  // close; the server finalizes the rest from its sideband.
  useEffect(() => {
    const subscription = runnerHost.onSystemSuspended(() => end("locked"));
    const onPageHide = (): void => end("ended");
    window.addEventListener("pagehide", onPageHide);
    return () => {
      subscription.dispose();
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [end, runnerHost]);

  // Unmount ends everything; the microphone never outlives the controller.
  // Through a ref, so a new `end` identity never ends a live session by
  // re-running the cleanup.
  useEffect(
    () => () => {
      endRef.current("ended");
    },
    [],
  );

  const running = phase !== "idle";
  return (
    <>
      {running ? (
        <VoiceSelectionSync
          voiceNavigationRef={voiceNavigationRef}
          onManualChange={() => sayLoop().onSelectionChanged()}
          onResolved={() => void sayLoopRef.current?.onFocusResolved()}
          voiceSwitch={voiceQueue.voiceSwitch}
        />
      ) : null}
      {running ? <VoiceQueueSources owner={voiceQueue} /> : null}
      <VoiceStoppedSources owner={voiceQueue} />
      {running && focus !== null && channelId !== null && speech !== null ? (
        <VoiceFocusedReplyFeed
          key={`${focus.botId}:${focus.threadId ?? channelId}`}
          focus={focus}
          channelId={channelId}
          client={focusClient}
          speaksAsThisBot={focus.botId === mainBot?.botId}
          botTitle={botTitle(focus.botId)}
          scheduler={speech}
          memory={watchMemoryFor(focus.threadId ?? channelId)}
          placementFor={(place) =>
            sayLoopRef.current?.placementFor(place) ?? { kind: "pending" }
          }
          registerReconcile={(reconcile) => {
            reconcileRef.current = reconcile;
          }}
          awaitedIn={(threadId) =>
            sayLoopRef.current?.awaitedIn(threadId) ?? "none"
          }
          isAwaiting={(requestId) =>
            sayLoopRef.current?.isAwaiting(requestId) ?? false
          }
          onScheduled={noteFocused}
          isBeingRead={isBeingRead}
          onAnnouncement={(announcement) =>
            noteAnnouncement({
              botId: focus.botId,
              hostId: focus.hostId,
              chatId: channelId,
              announcement,
            })
          }
        />
      ) : null}
    </>
  );
}

/**
 * Whether the app shows a routed destination now: its bot's tab is the
 * active one, with its rail on the thread named (or on no thread for the
 * channel).
 */
function showsDestination(target: BoundTarget): boolean {
  const active = selectHostFocusedRef(useTabsStore.getState());
  if (active === null || active.kind !== "bot") return false;
  if (active.id !== target.tuple.botId) return false;
  const expected =
    target.tuple.threadId === null ? null : target.focus.anchorMessageId;
  return railAnchorOf(target.tuple.botId) === expected;
}

/** The anchor of the thread open in `botId`'s rail; `null` for none. */
function railAnchorOf(botId: string | null): string | null {
  if (botId === null) return null;
  const { byBotId } = useBotOpenThreadStore.getState();
  const rail = Object.hasOwn(byBotId, botId) ? byBotId[botId] : null;
  return rail !== null && rail.kind === "thread" ? rail.anchorMessageId : null;
}

function conversationIdOf(
  channel: { readonly conversationId: string } | null,
): string | null {
  return channel === null ? null : channel.conversationId;
}

/**
 * The channel conversation among a bot's conversations: the one the bot
 * record names, else the earliest. Mirrors the channel view's own rule.
 */
function channelConversation(
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

/**
 * The default destination with no bot tab selected: the personal main bot's
 * channel, whose tab opens on this window's host (as the fixed entry opens
 * it) and comes to the front. `null` with no main bot known, or no host.
 */
function openMainBot(
  main: BotRecord | null,
  hostId: string | null,
  navigate: UseNavigateResult<string>,
): VoiceFocus | null {
  if (main === null || hostId === null) return null;
  useBotTabsStore
    .getState()
    .openBotTab({ botId: main.botId, hostId, title: main.title });
  navigateToTabIntent(navigate, botTabIntent(main.botId), undefined);
  return {
    botId: main.botId,
    hostId,
    threadId: null,
    anchorMessageId: null,
    anchorThread: null,
  };
}

/**
 * The voice's rail writes per bot, by serial: a rollback of a move that did
 * not land runs only for the latest one, so an older move never undoes a
 * newer one's rail, even when both wrote the same value.
 */
const voiceRailWrites = new Map<string, number>();

/**
 * Opens a routed destination as the person would: the bot's tab (on the
 * host it is bound to, or the target's), its rail on the thread named or
 * on the channel, and the tab brought to the front. Resolves with what
 * `decide` makes of the navigation's outcome, called as it settles: `false`
 * for a refusal, or a route navigation that failed (the tab navigation
 * puts the previous tab back right after). A move that does not land puts
 * the rail back too, while it still holds what was set here.
 */
function openTarget(
  target: BoundTarget,
  navigate: UseNavigateResult<string>,
  decide: (settled: boolean) => boolean,
): Promise<boolean> {
  const { botId, hostId, threadId } = target.tuple;
  const anchorMessageId = target.focus.anchorMessageId;
  const rails = useBotOpenThreadStore.getState();
  const previousRail = Object.hasOwn(rails.byBotId, botId)
    ? rails.byBotId[botId]
    : null;
  const rail: BotRail | null =
    threadId === null || anchorMessageId === null
      ? null
      : {
          kind: "thread",
          anchorMessageId,
          announcement: false,
          anchorKind: null,
          sent: null,
        };
  rails.setRail(botId, rail);
  const write = (voiceRailWrites.get(botId) ?? 0) + 1;
  voiceRailWrites.set(botId, write);
  useBotTabsStore
    .getState()
    .openBotTab({ botId, hostId, title: target.botTitle });
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (outcome: boolean): void => {
      if (settled) return;
      settled = true;
      const landed = decide(outcome);
      // A move that did not land puts the bot's rail back as it was, but
      // only while its write is still the latest the voice made to that
      // rail (a newer move's write, a channel's null included, owns it
      // then) and the person has not changed it since.
      if (!landed && voiceRailWrites.get(botId) === write) {
        const now = useBotOpenThreadStore.getState().byBotId;
        const current = Object.hasOwn(now, botId) ? now[botId] : null;
        if (current === rail) {
          useBotOpenThreadStore.getState().setRail(botId, previousRail);
        }
      }
      resolve(landed);
    };
    // The tab navigation reports a refusal, but not a route navigation
    // that fails after it accepted (it puts the previous tab back): the
    // first navigation it runs through this function is watched for that.
    const watched: UseNavigateResult<string> = (options) => {
      const run = navigate(options);
      run.then(
        () => settle(true),
        () => settle(false),
      );
      return run;
    };
    const accepted = activateTabIntent(watched, botTabIntent(botId), {
      onRejected: () => settle(false),
    });
    if (!accepted) settle(false);
  });
}

/**
 * The app's selection as a focus: the active bot tab and what its rail
 * holds, or `null` when no bot tab is active. Read once, outside React, at
 * session start.
 */
function readSelection(): VoiceFocus | null {
  const ref = selectHostFocusedRef(useTabsStore.getState());
  if (ref === null || ref.kind !== "bot") return null;
  const tab = lookupBotTab(useBotTabsStore.getState().tabs, ref.id);
  if (tab === null) return null;
  const { byBotId } = useBotOpenThreadStore.getState();
  const rail = Object.hasOwn(byBotId, ref.id) ? byBotId[ref.id] : null;
  const thread = rail !== null && rail.kind === "thread" ? rail : null;
  // The thread list is not read here: the selection sync, mounted with the
  // session, resolves the anchor against it.
  return focusOf(ref.id, tab.hostId, thread, null);
}

/**
 * Selection → focus, for as long as a session runs, a replacement included.
 * A manual change of channel or thread moves the focus and the generation; a
 * change that only resolves the thread behind an anchor the focus already
 * names (the thread list catching up with the rail) moves the focus alone. A
 * tab that is not a bot's leaves the focus where it was: the strip follows
 * the person across tasks, and their words still go to the last bot.
 */
function VoiceSelectionSync(props: {
  /** The voice's own navigation to another bot, while its tab has not come up. */
  readonly voiceNavigationRef: { current: VoiceNavigation | null };
  readonly onManualChange: () => void;
  /** The thread list resolved the anchor the focus already names. */
  readonly onResolved: () => void;
  readonly voiceSwitch: { current: VoiceSwitch | null };
}): null {
  const { voiceNavigationRef, onManualChange, onResolved, voiceSwitch } = props;
  const focusedRef = useTabsStore(selectHostFocusedRef);
  const activeBotId = focusedRef?.kind === "bot" ? focusedRef.id : null;
  const tab = useBotTabsStore((state) =>
    activeBotId === null ? null : lookupBotTab(state.tabs, activeBotId),
  );
  const rail = useBotRail(activeBotId ?? "");
  const thread = rail?.kind === "thread" ? rail : null;
  const client = useHostClientForHostId(tab?.hostId ?? null);
  const threads = useBotThreadListQuery(client, activeBotId ?? "", {
    enabled: activeBotId !== null && thread !== null && thread.sent === null,
  });
  const listed = threads.data?.threads ?? null;

  useEffect(() => {
    if (activeBotId === null || tab === null) return;
    const selection = focusOf(activeBotId, tab.hostId, thread, listed);
    const navigation = voiceNavigationRef.current;
    if (navigation !== null) {
      voiceNavigationRef.current = null;
      if (navigation.outcome === "pending") {
        // While the voice's navigation is out, the tab it is opening showing
        // the rail it opens, or the tab it is leaving still showing what it
        // showed when the voice moved and not yet left, is not a move: the
        // focus is written when the navigation settles. Anything else is
        // the person's, a return to the departing view after the target
        // showed included, and it is a move even when it lands back on the
        // focus as it stands.
        const anchor = thread?.anchorMessageId ?? null;
        if (
          activeBotId === navigation.toBotId &&
          anchor === navigation.toAnchorMessageId
        ) {
          navigation.arrived = true;
          voiceNavigationRef.current = navigation;
          return;
        }
        if (
          !navigation.arrived &&
          activeBotId === navigation.fromBotId &&
          anchor === navigation.fromAnchorMessageId
        ) {
          voiceNavigationRef.current = navigation;
          return;
        }
        applyMoveDuringNavigation(selection, onManualChange);
        return;
      }
    }
    // A switch the queue made (`switch` from Waiting or the router) keeps
    // the selections its own landing causes.
    if (followsVoiceSwitch(selection, voiceSwitch, listed)) return;
    applySelection(selection, onManualChange, onResolved);
  }, [
    activeBotId,
    listed,
    onManualChange,
    onResolved,
    tab,
    thread,
    voiceNavigationRef,
    voiceSwitch,
  ]);

  return null;
}

/**
 * Whether a selection is the landing of a switch the voice made, not the
 * person's move. Only what the switch itself causes is the voice's: until
 * the bot's tab spends the landing, the rail it already held (the same
 * anchor, or its channel); once it has, the target thread, by its id or by
 * the anchor the thread list gives it (the rail the landing opens, while it
 * resolves). The selection it lands on is written to the focus and ends the
 * switch. Anything else (another bot, another anchor, a selection after the
 * wait) ends the switch at once and is the person's.
 */
function followsVoiceSwitch(
  selection: VoiceFocus,
  voiceSwitch: { current: VoiceSwitch | null },
  listed: ReadonlyArray<BotThreadSummary> | null,
): boolean {
  const pending = voiceSwitch.current;
  if (pending === null) return false;
  voiceSwitch.current = null;
  if (
    selection.botId !== pending.botId ||
    Date.now() - pending.at > VOICE_SWITCH_SETTLE_MS
  ) {
    return false;
  }
  const store = useVoiceSessionStore.getState();
  if (pending.threadId === null) {
    if (selection.anchorMessageId === null) {
      store.setFocus(selection);
      return true;
    }
  } else if (selection.threadId === pending.threadId) {
    store.setFocus(selection);
    return true;
  } else {
    const targetAnchor =
      listed?.find((thread) => thread.threadId === pending.threadId)?.anchor
        ?.messageId ?? null;
    if (
      selection.anchorMessageId !== null &&
      selection.anchorMessageId === targetAnchor
    ) {
      store.setFocus({
        ...selection,
        threadId: pending.threadId,
        anchorThread: null,
      });
      return true;
    }
  }
  const landing = Object.hasOwn(
    useBotTabLandingStore.getState().byBotId,
    pending.botId,
  );
  if (landing && selection.anchorMessageId === pending.fromAnchor) {
    voiceSwitch.current = pending;
    return true;
  }
  return false;
}

/**
 * The rail as a focus. The open thread's id is known from the send that
 * opened it, else looked up by its anchor in the thread list once that
 * answers (`null` while it has not): a listed thread is the destination; an
 * anchor the list has no thread for is unopened when the rail opens on a row
 * nobody has replied under (an announcement, a question), where the panel's
 * box sends the first reply, and unresolved otherwise, since a thread a row
 * opened is listed before anything is posted into it.
 */
function focusOf(
  botId: string,
  hostId: string,
  thread: BotOpenThread | null,
  listed: ReadonlyArray<BotThreadSummary> | null,
): VoiceFocus {
  const channel: VoiceFocus = {
    botId,
    hostId,
    threadId: null,
    anchorMessageId: null,
    anchorThread: null,
  };
  if (thread === null) return channel;
  const anchored = { ...channel, anchorMessageId: thread.anchorMessageId };
  if (thread.sent !== null) {
    return { ...anchored, threadId: thread.sent.threadId };
  }
  if (listed === null) return { ...anchored, anchorThread: "resolving" };
  const match = listed.find(
    (candidate) => candidate.anchor?.messageId === thread.anchorMessageId,
  );
  if (match !== undefined) return { ...anchored, threadId: match.threadId };
  return {
    ...anchored,
    anchorThread: thread.announcement ? "unopened" : "resolving",
  };
}

/**
 * The person's own move while a voice navigation is out. The focus still
 * names where the voice departed from, so a return there would read as no
 * change: it is a move all the same (the generation moves, and an open
 * utterance is interrupted). Anything else is applied as usual.
 */
function applyMoveDuringNavigation(
  selection: VoiceFocus,
  onManualChange: () => void,
): void {
  const store = useVoiceSessionStore.getState();
  const current = store.focus;
  const returned =
    current !== null &&
    current.botId === selection.botId &&
    current.hostId === selection.hostId &&
    current.anchorMessageId === selection.anchorMessageId;
  const wasOpen = isUtteranceOpen(store);
  if (returned) store.selectionReturned();
  else store.selectionChanged(selection);
  if (wasOpen) onManualChange();
}

/**
 * Writes the app's selection to the focus. A selection of the anchor the
 * focus already names is not a move: the thread list resolving what is
 * behind it (its thread's id, or that nobody has replied under it) moves the
 * focus alone, and a list still behind a send that already named the thread
 * (the reply that opened a thread under a row, which the rail stays on)
 * changes nothing. Anything else is the person's, moves the generation, and
 * interrupts an open utterance.
 */
function applySelection(
  selection: VoiceFocus,
  onManualChange: () => void,
  onResolved: () => void,
): void {
  const store = useVoiceSessionStore.getState();
  const current = store.focus;
  if (sameFocus(current, selection)) return;
  const sameAnchor =
    current !== null &&
    current.botId === selection.botId &&
    current.hostId === selection.hostId &&
    current.anchorMessageId !== null &&
    current.anchorMessageId === selection.anchorMessageId;
  if (sameAnchor) {
    if (current.threadId === null || selection.threadId !== null) {
      store.setFocus(selection);
      if (selection.anchorThread !== "resolving") onResolved();
    }
    return;
  }
  const wasOpen = isUtteranceOpen(store);
  store.selectionChanged(selection);
  if (wasOpen) onManualChange();
}

/**
 * The hear loop's focused source: a new row of the bot on the focused
 * thread's (or channel's) chat store becomes the focused item, appended
 * under the delegation of the request it answers (none for a request of a
 * replaced engine) when the scheduler finds a clear moment, and the thread
 * is marked read once the voice is confirmed to have said it, with the
 * entity-level call looking makes.
 *
 * Two records are read and watched: the focused chat's rows, and the
 * channel's, because the host opens a post's thread with no row of its own
 * and resolves the opening request on the channel's post after the reply
 * exists. A reply is placed by the request the records already name, else by
 * the thread an accepted post opened (never by the requests awaiting at the
 * channel's top level alone: the channel carries the bot's announcements
 * too); one the records do not place yet is
 * scheduled under no delegation and re-labelled when they do, before it is
 * appended.
 *
 * Hydration is not arrival: the baseline is the first loaded snapshot, so a
 * cold store's history is never spoken, EXCEPT the answers this session is
 * waiting for, which count as arrivals wherever they turn up, and whenever
 * the acceptance that names them comes back (`reconcile`): the exact request
 * is matched against rows already loaded, and nothing already scheduled is
 * spoken twice. The memory outlives this component (the controller keeps it
 * per chat for the user session), so a remount across a replacement speaks
 * what landed in the gap and nothing older.
 */
function VoiceFocusedReplyFeed(props: {
  readonly focus: VoiceFocus;
  readonly channelId: string;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly speaksAsThisBot: boolean;
  readonly botTitle: string;
  readonly scheduler: SpeechScheduler;
  readonly memory: ReplyWatchMemory;
  readonly placementFor: (place: ReplyPlace) => ReplyPlacement;
  readonly awaitedIn: (threadId: string | null) => "opened" | "joined" | "none";
  readonly isAwaiting: (requestId: string) => boolean;
  /** Hands the controller this feed's reconciliation for the loop's acceptances. */
  readonly registerReconcile: (
    reconcile: (request: AcceptedRequest) => void,
  ) => void;
  /** A row this feed will say: the queue does not offer it too. */
  readonly onScheduled: (messageId: string) => void;
  /** Whether the queue is reading this row for the person already. */
  readonly isBeingRead: (messageId: string) => boolean;
  /** An announcement that landed on the focused channel: the queue keeps it. */
  readonly onAnnouncement: (announcement: Announcement) => void;
}): null {
  const {
    focus,
    channelId,
    client,
    speaksAsThisBot,
    botTitle,
    scheduler,
    memory,
    placementFor,
    awaitedIn,
    isAwaiting,
    registerReconcile,
    onScheduled,
    isBeingRead,
    onAnnouncement,
  } = props;
  const chatId = focus.threadId ?? channelId;
  const handle = useChatSessionHandleForContainer(
    focus.botId,
    chatId,
    focus.hostId,
    true,
  );
  const channelHandle = useChatSessionHandleForContainer(
    focus.botId,
    channelId,
    focus.hostId,
    true,
  );
  const { mutate: markRead } = useNotificationMarkEntityRead(client);
  const markReadRef = useRef(markRead);
  useEffect(() => {
    markReadRef.current = markRead;
  }, [markRead]);
  const placeRef = useRef({ placementFor, awaitedIn, isAwaiting });
  useEffect(() => {
    placeRef.current = { placementFor, awaitedIn, isAwaiting };
  }, [awaitedIn, isAwaiting, placementFor]);
  const registerReconcileRef = useRef(registerReconcile);
  useEffect(() => {
    registerReconcileRef.current = registerReconcile;
  }, [registerReconcile]);
  const onScheduledRef = useRef(onScheduled);
  const onAnnouncementRef = useRef(onAnnouncement);
  const isBeingReadRef = useRef(isBeingRead);
  useEffect(() => {
    onScheduledRef.current = onScheduled;
    onAnnouncementRef.current = onAnnouncement;
    isBeingReadRef.current = isBeingRead;
  }, [isBeingRead, onAnnouncement, onScheduled]);

  useEffect(() => {
    if (handle === null || channelHandle === null) return;
    const threadId = focus.threadId;
    const records = (): ReplyRecords => ({
      threadRows: threadId === null ? [] : handle.store.getState().messages,
      channelRows: channelHandle.store.getState().messages,
    });
    /**
     * Replies scheduled before they could be placed: the records did not tie
     * them to a request, or the request's acceptance had not come back.
     * Kept until a binding exists (or is known not to), so an acceptance
     * can still re-label a queued item.
     */
    const unplaced = new Map<string, string>();
    // Rows taken for announcements as they landed, still open to
    // reconsideration: an answer to a typed post can land before the post's
    // request names it, and is the post's answer once it does. Read then,
    // once, as a focused reply. Kept in the chat's memory, which outlives
    // this feed.
    const provisional = memory.provisional;
    const reconsider = (
      rows: ReadonlyArray<ReplyRow>,
      where: ReplyRecords,
    ): void => {
      if (provisional.size === 0) return;
      const stillAnnounced = new Set(
        announcementsOf(rows, 0).map((found) => found.messageId),
      );
      for (const messageId of provisional) {
        if (stillAnnounced.has(messageId)) continue;
        provisional.delete(messageId);
        const row = rows.find((candidate) => candidate.messageId === messageId);
        if (row?.role !== "assistant") continue;
        const text = spokenReplyOf(row);
        if (text.length > 0) speak({ messageId, text }, where);
      }
    };
    const place = (
      replyMessageId: string,
      where: ReplyRecords,
    ): ReplyPlacement =>
      placeRef.current.placementFor({
        botId: focus.botId,
        hostId: focus.hostId,
        threadId,
        requestId: requestIdAnsweredIn(where, replyMessageId),
      });
    const speak = (reply: FocusedReply, where: ReplyRecords): void => {
      if (memory.scheduled.has(reply.messageId)) return;
      memory.scheduled.add(reply.messageId);
      // A Read the person asked of this row is already queued or being
      // said, under its own delegation: it stays the queue's, which settles
      // it (heard, read) as any read; saying it here too would withdraw it
      // and repeat the words under no request.
      if (isBeingReadRef.current(reply.messageId)) return;
      onScheduledRef.current(reply.messageId);
      const itemId = `reply:${reply.messageId}`;
      const placement = place(reply.messageId, where);
      if (placement.kind === "pending") unplaced.set(reply.messageId, itemId);
      const delegationId =
        placement.kind === "placed" ? placement.delegationId : null;
      scheduler.enqueue({
        id: itemId,
        priority: "focused",
        text: replySpeechText({
          botTitle,
          speaksAsThisBot,
          content: reply.text,
        }),
        delegationId,
        confirmWords: confirmationWords({
          botTitle,
          threadTitle: null,
          text: reply.text,
        }),
        onDelivered: () => markReadRef.current({ epicId: focus.botId, chatId }),
        onGivenUp: null,
      });
    };
    // Records that arrived, or an acceptance that came back, after a reply
    // was scheduled may place it now: the item is re-labelled while it still
    // waits to be appended. Only by the EXACT request the records name: the
    // one fallback (the thread a post opened) describes what was awaited
    // when the row ARRIVED and ran then; a retained row must never take a
    // request's binding on the strength of being awaited alone (a channel
    // announcement answers no request at all). One the records still do not
    // name stays here.
    const placeLater = (where: ReplyRecords): void => {
      for (const [replyMessageId, itemId] of unplaced) {
        const requestId = requestIdAnsweredIn(where, replyMessageId);
        if (requestId === null) continue;
        const placement = placeRef.current.placementFor({
          botId: focus.botId,
          hostId: focus.hostId,
          threadId,
          requestId,
        });
        if (placement.kind === "pending") continue;
        unplaced.delete(replyMessageId);
        if (placement.delegationId !== null) {
          scheduler.relabel(itemId, placement.delegationId);
        }
      }
    };
    // The records now tie a row of the bot to a request this session awaits:
    // it is its answer, wherever it came from. A row the baseline took for
    // history (its request row loaded with no resolution yet, or the
    // acceptance naming the request not back yet) is spoken the moment the
    // request records resolve to it, once; one already scheduled is not.
    const speakAwaited = (where: ReplyRecords): void => {
      for (const row of handle.store.getState().messages) {
        if (row.role !== "assistant" || memory.scheduled.has(row.messageId)) {
          continue;
        }
        const requestId = requestIdAnsweredIn(where, row.messageId);
        if (requestId === null || !placeRef.current.isAwaiting(requestId)) {
          continue;
        }
        const text = spokenReplyOf(row);
        if (text.length > 0) speak({ messageId: row.messageId, text }, where);
      }
    };
    /** The records changed: place what waits, and speak what they now answer. */
    const settle = (where: ReplyRecords): void => {
      speakAwaited(where);
      placeLater(where);
    };
    // A watch that already has a baseline carries on; a fresh one takes the
    // first loaded snapshot as history, less the answers awaited here.
    const watch = (state: ReplyWatchState): void => {
      if (!state.snapshotLoaded) return;
      const where = records();
      if (!memory.baselined) {
        // In a thread an accepted post opened, every bot row is its answer;
        // elsewhere only a row the records tie to an awaited request is.
        const awaitedHere = placeRef.current.awaitedIn(threadId);
        const awaited = baselineReplyWatchExcept(
          memory,
          state.messages,
          (row) => {
            if (awaitedHere === "none") return false;
            if (awaitedHere === "opened") return true;
            const requestId = requestIdAnsweredIn(where, row.messageId);
            return requestId !== null && placeRef.current.isAwaiting(requestId);
          },
        );
        for (const reply of awaited) speak(reply, where);
        return;
      }
      const fresh = takeNewBotReplies(state.messages, memory);
      // At a channel's top level, a row of the bot that answers nothing is an
      // announcement: briefing only (V3), never said as it lands.
      const announced =
        threadId === null && fresh.length > 0
          ? new Map(
              announcementsOf(state.messages, 0).map((found) => [
                found.messageId,
                found,
              ]),
            )
          : null;
      for (const reply of fresh) {
        const announcement = announced?.get(reply.messageId);
        if (announcement === undefined) {
          speak(reply, where);
        } else {
          provisional.add(reply.messageId);
          onAnnouncementRef.current(announcement);
        }
      }
      reconsider(state.messages, where);
      settle(where);
    };
    // An acceptance came back: a row already loaded (and baselined, or seen
    // while the send was out) that the records tie to a request now awaited
    // is spoken.
    const reconcile = (request: AcceptedRequest): void => {
      if (request.botId !== focus.botId || request.hostId !== focus.hostId) {
        return;
      }
      if (request.threadId !== threadId) return;
      settle(records());
    };
    registerReconcileRef.current(reconcile);
    watch(handle.store.getState());
    const unsubscribeFocused = handle.store.subscribe(watch);
    const unsubscribeChannel =
      threadId === null
        ? () => undefined
        : channelHandle.store.subscribe(() => settle(records()));
    return () => {
      unsubscribeFocused();
      unsubscribeChannel();
      registerReconcileRef.current(() => undefined);
    };
  }, [
    botTitle,
    channelHandle,
    chatId,
    focus.botId,
    focus.hostId,
    focus.threadId,
    handle,
    memory,
    scheduler,
    speaksAsThisBot,
  ]);

  return null;
}

/** The slice of the chat store the watch reads. */
interface ReplyWatchState {
  readonly snapshotLoaded: boolean;
  readonly messages: ReadonlyArray<ReplyRow>;
}
