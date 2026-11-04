import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  BotConversationSendRequest,
  BotConversationSendResponse,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotOpenResponse } from "@traycer/protocol/host/bot/schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { MicrophoneAccessStatus } from "@traycer-clients/shared/platform/runner-host";
import { botPausedCopy } from "@/components/bots/bot-tab-open-state";
import { useBotActivity } from "@/hooks/bots/use-bot-activity";
import { useBotConversationListQuery } from "@/hooks/bots/use-bot-conversation-list-query";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import {
  useBotConversationSendMutation,
  useBotOpenMutation,
} from "@/hooks/bots/use-bot-mutations";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { dictationCaptureConstraints } from "@/hooks/composer/dictation-capture-constraints";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useNotificationMarkEntityRead } from "@/hooks/notifications/use-notification-mark-entity-read-mutation";
import { useVoiceAvailabilityQuery } from "@/hooks/voice/use-voice-availability-query";
import {
  useVoiceMicrophoneAccessMutation,
  useVoiceSessionEndMutation,
  useVoiceSessionMintMutation,
  useVoiceShellIndicatorMutation,
  useVoiceShellLiveMutation,
} from "@/hooks/voice/use-voice-session-mutations";
import { voiceQueryKeys } from "@/lib/query-keys";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { appLogger, describeLogError } from "@/lib/logger";
import { useChatSessionHandleForContainer } from "@/lib/registries/chat-session-registry";
import { watchAudioLevel, type AudioLevelWatch } from "@/lib/voice/audio-level";
import {
  CALL_HOLD_DELAY_MS,
  CALL_HOLD_LINE,
  MAX_SHORT_SESSIONS,
  REMINT_BEFORE_EXPIRY_MS,
  REMINT_CONTEXT_USAGE_RATIO,
  SHORT_SESSION_MS,
  callFailureLine,
  callUnreachableLine,
  channelConversation,
  isCallEndPhrase,
} from "@/lib/voice/call";
import { VoiceEngineError, type VoiceEngine } from "@/lib/voice/engine";
import {
  baselineReplyWatchExcept,
  createReplyWatchMemory,
  takeNewBotReplies,
  type ReplyRow,
} from "@/lib/voice/focused-replies";
import { createBrowserGptLiveEngine } from "@/lib/voice/gpt-live-engine";
import {
  confirmationWords,
  createSpeechScheduler,
  type SpeechScheduler,
} from "@/lib/voice/scheduler";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import {
  useVoiceSessionStore,
  type CallFocus,
  type CallTarget,
  type VoiceEndReason,
  type VoiceRefusal,
} from "@/stores/voice/voice-session-store";

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
  failure: "credits" | "unavailable" | null;
  cancelled: boolean;
  /** The account signed in when the attempt began. */
  readonly account: string | null;
}

/** What a send carries, besides the words: the call's channel. */
interface CallChannel {
  readonly botId: string;
  readonly hostId: string;
  readonly conversationId: string;
}

/**
 * Whether the end route can answer for this attempt: it goes out under whoever
 * is signed in now, and the server knows a session only to the account that
 * minted it. After a switch the vendor's close is what ends the session, and
 * the server's sideband settles its row.
 */
function endRouteAnswers(attempt: Attempt): boolean {
  const current = useAuthStore.getState().contextMetadata?.userId ?? null;
  return current === null || current === attempt.account;
}

/**
 * Owns the call for this window (Call Tracy, VC3): the microphone, the engine
 * behind the seam, the speech scheduler, the call's sends and the watch on
 * its thread. Mounted once, app-wide; the Call controls, the strip, the phone
 * view and the shortcut reach it through the store's `driver`.
 *
 * A call is a thread of one bot. Each thing the person says, closed by the
 * voice's own acknowledgement line (VC0: the first output transcript after
 * input), is one `bot.conversation.send` with `spoken: true`, verbatim: the
 * first opens the call's thread (`origin: "call"`), or goes into the thread
 * the call was started from; later ones go into the thread the first opened.
 * Each new reply row of the bot on that thread is appended for the voice to
 * say. Nothing is routed and nothing runs here but the send.
 *
 * Ending is a terminal latch, whatever the reason: the microphone stops
 * first, then the vendor's close and the end route, asynchronously; the
 * bot's turn is left running and its reply lands in the thread unspoken.
 * Desktop lifecycle (VT2): window close and blur keep the call; lock, sleep
 * and quit end it. The phone ends it when the app goes to the background
 * (VT7).
 */
export function CallController(): ReactNode {
  const runnerHost = useRunnerHost();
  const { mutateAsync: mintAsync } = useVoiceSessionMintMutation();
  const { mutateAsync: endAsync } = useVoiceSessionEndMutation();
  const { mutateAsync: shellLiveAsync } = useVoiceShellLiveMutation();
  const { mutateAsync: shellIndicatorAsync } = useVoiceShellIndicatorMutation();
  const { mutateAsync: microphoneAccessAsync } =
    useVoiceMicrophoneAccessMutation();
  const queryClient = useQueryClient();
  // Whether this deployment offers voice, read once per window before Call
  // is drawn; a dormant mint invalidates it, so the answer is read again.
  const availability = useVoiceAvailabilityQuery(true);
  const available = availability.data;
  useEffect(() => {
    if (available === undefined) return;
    useVoiceSessionStore
      .getState()
      .setAvailability(available ? "live" : "dormant");
  }, [available]);

  // The bot surface's host serves every bot's channel; a call is carried by
  // it, the window's host while no surface is open.
  const appHostId = useEffectiveHostId();
  const appClient = useHostClient();
  const surfaceHostId = useTracySurfaceStore((state) =>
    state.open ? state.hostId : null,
  );
  const callHostId = surfaceHostId ?? appHostId;
  const callHostIdRef = useRef(callHostId);
  useEffect(() => {
    callHostIdRef.current = callHostId;
  }, [callHostId]);
  const surfaceClient = useHostClientForHostId(surfaceHostId);
  const { mutateAsync: openBotAsync } = useBotOpenMutation(surfaceClient);

  const botsSupported = useHostMethodSupport(appHostId, "bot.list") === true;
  const bots = useBotListQuery(appClient, botsSupported);
  const environments = useEnvironmentListQuery(surfaceClient, true);
  const botTitle = useCallback(
    (botId: string): string =>
      bots.data?.bots.find((bot) => bot.botId === botId)?.title ?? "the bot",
    [bots.data],
  );
  const environmentLabel = useCallback(
    (botId: string): string => {
      const environmentId =
        bots.data?.bots.find((bot) => bot.botId === botId)?.environmentId ?? "";
      return (
        environments.data?.environments.find(
          (environment) => environment.environmentId === environmentId,
        )?.label ?? environmentId
      );
    },
    [bots.data, environments.data],
  );
  const namesRef = useRef({ botTitle, environmentLabel });
  useEffect(() => {
    namesRef.current = { botTitle, environmentLabel };
  }, [botTitle, environmentLabel]);

  const phase = useVoiceSessionStore((state) => state.phase);
  const focus = useVoiceSessionStore((state) => state.focus);
  const focusClient = useHostClientForHostId(focus?.hostId ?? null);

  // One scheduler per window, built at the first call and reset at each
  // call's end. Held twice: the ref for the engine's events, which run
  // outside render, and the state for the thread watch that renders with it.
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

  /** A line of the app's own, said once at the next quiet moment. */
  const lineSerialRef = useRef(0);
  const sayLine = useCallback(
    (kind: string, text: string, onSettled: (() => void) | null): string => {
      lineSerialRef.current += 1;
      const id = `${kind}:${lineSerialRef.current}`;
      ensureSpeech().enqueue({
        id,
        priority: "focused",
        text,
        delegationId: null,
        confirmWords: confirmationWords({
          botTitle: null,
          threadTitle: null,
          text,
        }),
        onDelivered: onSettled,
        onGivenUp: onSettled,
      });
      return id;
    },
    [ensureSpeech],
  );

  // ---- Sending ---------------------------------------------------------- //
  const { mutateAsync: sendAsync } =
    useBotConversationSendMutation(focusClient);
  const sendRef = useRef(sendAsync);
  useEffect(() => {
    sendRef.current = sendAsync;
  }, [sendAsync]);
  const conversations = useBotConversationListQuery(
    focusClient,
    focus?.botId ?? "",
    focus !== null,
  );
  // The called bot's channel, named with the bot it is the channel of: the
  // list can still be another bot's for a render after a new call.
  const channel = useMemo((): CallChannel | null => {
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
  const channelRef = useRef(channel);

  /**
   * What the person said and is not sent yet, oldest first. Sends go one at
   * a time: the first opens the call's thread, and the next needs its id.
   */
  const outboxRef = useRef<string[]>([]);
  /** The call (its token) whose send is out; `null` with none out. */
  const sendingRef = useRef<number | null>(null);
  /**
   * The call is closing on a queued send: the microphone is off, nothing more
   * is sent, and the unreachable line is being said before the end.
   */
  const closingRef = useRef(false);
  /** The thread this call's first send opened; its first snapshot is all arrivals. */
  const [openedThreadId, setOpenedThreadId] = useState<string | null>(null);
  const pumpRef = useRef<() => void>(() => undefined);
  const unreachableRef = useRef<() => void>(() => undefined);
  const failedSendRef = useRef<() => void>(() => undefined);

  const pump = useCallback(() => {
    if (sendingRef.current !== null || closingRef.current) return;
    const store = useVoiceSessionStore.getState();
    const call = store.focus;
    const known = channelRef.current;
    // Words said before the channel is known wait for it.
    if (call === null || known === null || known.botId !== call.botId) return;
    const text = outboxRef.current.shift();
    if (text === undefined) return;
    const token = store.sessionToken;
    const threadId = call.threadId;
    const request: BotConversationSendRequest = {
      botId: call.botId,
      conversationId: known.conversationId,
      text,
      threadId,
      announcementId: null,
      redeliver: null,
      supersedes: null,
      answer: null,
      spoken: true,
      ...(threadId === null ? { origin: "call" as const } : {}),
    };
    sendingRef.current = token;
    const settleSend = (): boolean => {
      if (sendingRef.current === token) sendingRef.current = null;
      return useVoiceSessionStore.getState().sessionToken === token;
    };
    sendRef.current(request).then(
      (response: BotConversationSendResponse) => {
        if (!settleSend()) return;
        if (response.delivery === "queued") {
          unreachableRef.current();
          return;
        }
        if (threadId === null && response.threadId !== null) {
          setOpenedThreadId(response.threadId);
          useVoiceSessionStore.getState().bindThread(response.threadId);
        }
        pumpRef.current();
      },
      (error: unknown) => {
        appLogger.warn("[voice] call send failed", {
          error: describeLogError(error),
        });
        if (!settleSend()) return;
        failedSendRef.current();
        pumpRef.current();
      },
    );
  }, []);
  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);
  // Words that waited for the channel go once it is known.
  useEffect(() => {
    channelRef.current = channel;
    pump();
  }, [channel, pump]);

  // ---- Call lifecycle --------------------------------------------------- //
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const levelWatchRef = useRef<AudioLevelWatch | null>(null);
  const expiryTimerRef = useRef<number | null>(null);
  const remintWhenClearRef = useRef<(() => void) | null>(null);
  // The re-mint path is declared below `connectEngine`, which the engine's
  // own events reach it from; the refs break the cycle.
  const remintRef = useRef<(attempt: Attempt) => Promise<void>>(() =>
    Promise.resolve(),
  );
  /** Consecutive replaced sessions that ended short-lived; a new call starts at none. */
  const shortSessionsRef = useRef(0);
  const requestRemintWhenClearRef = useRef<() => void>(() => undefined);
  const endRef = useRef<(reason: VoiceEndReason) => void>(() => undefined);
  /** What the person said, at the boundary: an end phrase, or a send. */
  const utteranceRef = useRef<(said: string) => void>(() => undefined);
  /** From a dial until its first engine goes live: nothing can end yet. */
  const firstOpeningRef = useRef(false);

  /** What the shell's voice item shows for this window's live call. */
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
   * What the microphone carries and what the speaker plays, switched locally
   * with no network wait. The microphone carries nothing while the person
   * muted it, while the voice is paused for dictation, under push-to-talk
   * while the talk button is not held, or while the call closes on a queued
   * send; the voice's sound is silent while paused for dictation.
   */
  const applyCapture = useCallback(() => {
    const { muted, pausedForDictation, pushToTalk, talkHeld } =
      useVoiceSessionStore.getState();
    const stream = micStreamRef.current;
    if (stream !== null) {
      for (const track of stream.getAudioTracks()) {
        track.enabled =
          !closingRef.current &&
          !muted &&
          !pausedForDictation &&
          (!pushToTalk || talkHeld);
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
        // item being spoken goes back to wait, and is said again on Resume.
        if (state.pausedForDictation) speechRef.current?.suspendInFlight();
        const attempt = attemptRef.current;
        if (attempt !== null && attempt.started && !attempt.cancelled) {
          speechRef.current?.setReady(!state.pausedForDictation);
        }
        // Words said before dictation took the microphone are let go: their
        // boundary, if it comes, falls in the pause.
        if (state.pausedForDictation) state.dropOpenSpan();
      }),
    [applyCapture],
  );

  // The phone's talk button and its push-to-talk switch write the store; the
  // microphone follows at once.
  useEffect(
    () =>
      useVoiceSessionStore.subscribe((state, previous) => {
        if (
          state.muted === previous.muted &&
          state.pushToTalk === previous.pushToTalk &&
          state.talkHeld === previous.talkHeld
        ) {
          return;
        }
        applyCapture();
      }),
    [applyCapture],
  );

  /**
   * The vendor side of an attempt that is no longer the controller's: the
   * peer's close and then the server's end route, for every attempt that was
   * minted, unless another account has taken over the window since.
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
      if (attempt.sessionId === null || !endRouteAnswers(attempt)) return;
      // Best effort: the call is over for the person either way, and the
      // server finalizes an unended row from its sideband.
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
   * Everything local a call leaves: capture first, then playback, timers,
   * the scheduler's items and the words not sent. Synchronous, so a page
   * going away releases the microphone before it is gone.
   */
  const releaseLocal = useCallback(() => {
    releaseAudio();
    clearTimers();
    speechRef.current?.reset();
    outboxRef.current = [];
    closingRef.current = false;
    setShellVoiceLive(false);
  }, [clearTimers, releaseAudio, setShellVoiceLive]);
  const finishLocal = useCallback(
    (reason: VoiceEndReason | null) => {
      releaseLocal();
      useVoiceSessionStore.getState().sessionEnded(reason);
    },
    [releaseLocal],
  );
  /** The same, for a dial that never became a call. */
  const refuseLocal = useCallback(
    (refusal: VoiceRefusal, pausedCopy: string | null) => {
      releaseLocal();
      useVoiceSessionStore.getState().sessionRefused(refusal, pausedCopy);
    },
    [releaseLocal],
  );

  /**
   * The terminal latch: takes the attempt away so no event of it is heard
   * again, stops the microphone now, and lets the vendor accounting finish on
   * its own. The bot's turn is left running. Idempotent.
   */
  const end = useCallback(
    (reason: VoiceEndReason) => {
      const store = useVoiceSessionStore.getState();
      const attempt = attemptRef.current;
      if (store.phase === "idle" && attempt === null) return;
      attemptRef.current = null;
      if (attempt !== null) attempt.cancelled = true;
      if (reason === "ended") finishLocal(null);
      // Whatever stops the first opening before it goes live ends nothing:
      // the call never began.
      else if (firstOpeningRef.current) {
        refuseLocal(reason === "playback" ? "playback" : "unavailable", null);
      } else finishLocal(reason);
      if (attempt !== null) void settleAttempt(attempt);
    },
    [finishLocal, refuseLocal, settleAttempt],
  );
  useEffect(() => {
    endRef.current = end;
  }, [end]);

  // A queued send ends the call: the microphone goes off at once, nothing
  // more is sent, and the call ends once the voice has said why (or given up
  // saying it). The message stays queued, as a typed one does.
  useEffect(() => {
    unreachableRef.current = () => {
      if (closingRef.current) return;
      closingRef.current = true;
      outboxRef.current = [];
      useVoiceSessionStore.getState().dropOpenSpan();
      applyCapture();
      const call = useVoiceSessionStore.getState().focus;
      const token = useVoiceSessionStore.getState().sessionToken;
      sayLine(
        "unreachable",
        callUnreachableLine(namesRef.current.botTitle(call?.botId ?? "")),
        () => {
          if (useVoiceSessionStore.getState().sessionToken !== token) return;
          endRef.current("unreachable");
        },
      );
    };
    failedSendRef.current = () => {
      const call = useVoiceSessionStore.getState().focus;
      sayLine(
        "send-failed",
        callFailureLine(namesRef.current.botTitle(call?.botId ?? "")),
        null,
      );
    };
    utteranceRef.current = (said) => {
      if (closingRef.current) return;
      if (isCallEndPhrase(said)) {
        endRef.current("ended");
        return;
      }
      outboxRef.current.push(said);
      pumpRef.current();
    };
  }, [applyCapture, sayLine]);

  /** Opens an engine on the current microphone. A call's mint carries no input. */
  const connectEngine = useCallback(async (): Promise<boolean> => {
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
      account: useAuthStore.getState().contextMetadata?.userId ?? null,
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
          const result = await mintAsync({ offerSdp, input: "" });
          switch (result.kind) {
            case "ok":
              // Owned from this moment: an End during the rest of the
              // handshake still reaches the end route for it. One that came
              // while the mint was out already settled the attempt without
              // an id, so the id just minted is ended here.
              attempt.sessionId = result.session.voiceSessionId;
              attempt.expiresAt = result.session.expiresAt;
              if (!owns()) {
                if (endRouteAnswers(attempt)) {
                  void endAsync(result.session.voiceSessionId).catch(
                    (error: unknown) => {
                      appLogger.warn("[voice] end route failed", {
                        error: describeLogError(error),
                      });
                    },
                  );
                }
                throw closedBeforeStart();
              }
              return result.session.answerSdp;
            case "dormant":
              // The fallback when the availability read was wrong or stale:
              // hide Call now, and read the answer again.
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
          // Sound that cannot play is a call nobody can hear: it ends, and
          // says so, rather than confirming deliveries by transcript.
          void audio.play().catch((error: unknown) => {
            appLogger.warn("[voice] remote audio play failed", {
              error: describeLogError(error),
            });
            if (owns()) endRef.current("playback");
          });
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
            if (!owns() || closingRef.current) return;
            const current = useVoiceSessionStore.getState();
            // Dictation holds the microphone: a word that still arrives is
            // the person's draft, not something said on the call.
            if (current.pausedForDictation) return;
            current.appendInput(text);
            current.pushCaptionLine({ direction: "input", text });
            ensureSpeech().noteInputTranscript();
          },
          onOutputTranscriptDelta: (text) => {
            if (!owns()) return;
            const current = useVoiceSessionStore.getState();
            current.pushCaptionLine({ direction: "output", text });
            ensureSpeech().noteOutputTranscript(text);
            // The utterance boundary (VC0): the voice's acknowledgement
            // begins, so what the person said since the last one is one
            // message, as said.
            if (!attempt.started) return;
            const said = current.takeOpenSpan();
            if (said !== null) utteranceRef.current(said);
          },
          // The persona never needs a delegation answered, and the app
          // never answers one: replies are appended under none (VC0).
          onDelegationCreated: () => undefined,
          onUsage: (usage) => {
            // Usage before the session started replaces nothing: a
            // replacement must retire a session that ran.
            if (!owns() || !attempt.started) return;
            if (
              usage.contextUsageRatio !== null &&
              usage.contextUsageRatio >= REMINT_CONTEXT_USAGE_RATIO
            ) {
              requestRemintWhenClearRef.current();
            }
          },
          onClosed: (reason) => {
            // A cancelled attempt is being settled by whoever cancelled it;
            // one that never started is finished by `connect`'s own failure
            // path, with the mint's reason intact.
            if (!owns() || !attempt.started) return;
            attemptRef.current = null;
            attempt.cancelled = true;
            // The vendor or the network ended a session that had time left:
            // a fresh one carries the call on. A session the server closed
            // for credits refuses the re-mint with 402, which ends the call
            // with the reason said.
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
      // The first opening never was a call, so nothing ended. A replacement
      // is the live call ending: credits say so, and anything else is the
      // connection it was running on.
      if (firstOpeningRef.current)
        refuseLocal(attempt.failure ?? "unavailable", null);
      else
        finishLocal(attempt.failure === "credits" ? "credits" : "connection");
      void settleAttempt(attempt);
      return false;
    }
    if (!owns() || attempt.sessionId === null) return false;
    attempt.started = true;
    attempt.startedAt = Date.now();
    firstOpeningRef.current = false;
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
  }, [
    applyCapture,
    clearTimers,
    endAsync,
    ensureSpeech,
    finishLocal,
    mintAsync,
    queryClient,
    refuseLocal,
    setShellVoiceLive,
    settleAttempt,
  ]);

  /**
   * Replaces the vendor session under the same call, one at a time: the old
   * attempt is retired BEFORE the microphone track is offered to a new peer,
   * so two sessions never carry the person's audio at once. The scheduler
   * keeps its items but forgets the old engine's facts.
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
      // A run of sessions that did not outlive their own handshake ceiling
      // is a vendor or server that is not coming back for now.
      const ran = old.started ? Date.now() - old.startedAt : 0;
      shortSessionsRef.current =
        ran < SHORT_SESSION_MS ? shortSessionsRef.current + 1 : 0;
      if (shortSessionsRef.current >= MAX_SHORT_SESSIONS) {
        finishLocal("connection");
        void settleAttempt(old);
        return;
      }
      ensureSpeech().handoff();
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
      await connectEngine();
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

  /**
   * Whether the dial may go on to the microphone: `bot.open` answered and the
   * bot is not paused. A paused bot is refused with its tab's own line; an
   * open that fails is refused as unavailable. `false` too once the dial was
   * ended or replaced meanwhile.
   */
  const admitBot = useCallback(
    async (botId: string, stillStarting: () => boolean): Promise<boolean> => {
      let opened: BotOpenResponse;
      try {
        opened = await openBotAsync({ botId });
      } catch (error) {
        appLogger.warn("[voice] bot open before a call failed", {
          error: describeLogError(error),
        });
        if (stillStarting()) refuseLocal("unavailable", null);
        return false;
      }
      if (!stillStarting()) return false;
      if (opened.outcome.kind !== "paused") return true;
      refuseLocal(
        "paused",
        botPausedCopy(
          opened.outcome.reason,
          namesRef.current.environmentLabel(botId),
        ).text,
      );
      return false;
    },
    [openBotAsync, refuseLocal],
  );

  /**
   * The dial: the bot is asked whether a host can run it now (`bot.open`,
   * as its tab asks), and a paused bot is refused with the tab's own line
   * before the microphone is asked for. Then the microphone, then the mint.
   */
  const start = useCallback(
    async (target: CallTarget): Promise<void> => {
      const store = useVoiceSessionStore.getState();
      if (store.phase !== "idle" || store.availability !== "live") return;
      const hostId = callHostIdRef.current;
      if (hostId === null) return;
      const call: CallFocus = {
        botId: target.botId,
        hostId,
        threadId: target.threadId,
      };
      store.sessionConnecting(call, namesRef.current.botTitle(target.botId));
      firstOpeningRef.current = true;
      shortSessionsRef.current = 0;
      closingRef.current = false;
      outboxRef.current = [];
      sendingRef.current = null;
      setOpenedThreadId(null);
      const { sessionToken: token, engineGeneration: generation } =
        useVoiceSessionStore.getState();
      const stillStarting = (): boolean => {
        const now = useVoiceSessionStore.getState();
        return (
          now.phase === "connecting" &&
          now.sessionToken === token &&
          now.engineGeneration === generation
        );
      };
      if (!(await admitBot(target.botId, stillStarting))) return;
      let access: MicrophoneAccessStatus;
      try {
        access = await microphoneAccessAsync();
      } catch (error) {
        appLogger.warn("[voice] microphone access request failed", {
          error: describeLogError(error),
        });
        if (stillStarting()) refuseLocal("microphone", null);
        return;
      }
      if (!stillStarting()) return;
      if (access === "denied") {
        refuseLocal("microphone-denied", null);
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
        if (stillStarting()) {
          refuseLocal(
            isPermissionRefusal(error) ? "microphone-denied" : "microphone",
            null,
          );
        }
        return;
      }
      // Ended while the permission prompt was up: the microphone just opened
      // is closed again before anything hears it.
      if (!stillStarting()) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      micStreamRef.current = stream;
      watchCapture(stream, () => {
        if (micStreamRef.current === stream) end("interrupted");
      });
      applyCapture();
      await connectEngine();
    },
    [
      admitBot,
      applyCapture,
      connectEngine,
      end,
      microphoneAccessAsync,
      refuseLocal,
    ],
  );

  const setMuted = useCallback(
    (muted: boolean) => {
      useVoiceSessionStore.getState().setMuted(muted);
      applyCapture();
    },
    [applyCapture],
  );

  useEffect(() => {
    const store = useVoiceSessionStore.getState();
    store.setDriver({
      start: (target) => {
        void start(target);
      },
      end: () => end("ended"),
      setMuted,
    });
    return () => {
      useVoiceSessionStore.getState().setDriver(null);
    };
  }, [end, setMuted, start]);

  // The shell's voice item, shown while this window is away: its Mute or
  // Unmute and its End act on this window's call as the strip's do.
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

  // Lock, sleep, the app going to the background, an interruption and the
  // page going away all end the call through the one latch. The cause is
  // what the person reads on return.
  useEffect(() => {
    const subscription = runnerHost.onSystemSuspended((cause) => end(cause));
    const onPageHide = (): void => end("ended");
    window.addEventListener("pagehide", onPageHide);
    return () => {
      subscription.dispose();
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [end, runnerHost]);

  // A call is minted and billed under one account. A switch leaves the shell
  // standing, so the switch ends the call here.
  const authStatus = useAuthStore((state) => state.status);
  const authUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const onIdentityTransition = useCallback(
    (transition: AuthIdentityTransition) => {
      if (transition.kind === "userSwitched") end("account");
    },
    [end],
  );
  useAuthIdentityTransition(authStatus, authUserId, onIdentityTransition);

  // Unmount ends everything; the microphone never outlives the controller.
  useEffect(
    () => () => {
      endRef.current("ended");
    },
    [],
  );

  if (phase === "idle" || focus === null || focus.threadId === null) {
    return null;
  }
  if (speech === null) return null;
  return (
    <CallThreadWatch
      key={`${focus.botId}:${focus.threadId}`}
      botId={focus.botId}
      hostId={focus.hostId}
      threadId={focus.threadId}
      opened={openedThreadId === focus.threadId}
      botTitle={botTitle(focus.botId)}
      client={focusClient}
      scheduler={speech}
    />
  );
}

/**
 * Calls `onLost` when the OS takes the microphone away from a live capture:
 * the track ends, or it is muted (a call, Siri, another app's recording)
 * while the page is on screen. Our own mute is `enabled`, which raises
 * neither event.
 */
function watchCapture(stream: MediaStream, onLost: () => void): void {
  const track = stream.getAudioTracks().at(0);
  if (track === undefined) return;
  track.addEventListener("ended", onLost, { once: true });
  track.addEventListener("mute", () => {
    if (document.visibilityState === "visible") onLost();
  });
}

/** A `getUserMedia` refusal: the person (or the OS on their behalf) said no. */
function isPermissionRefusal(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotAllowedError";
}

/** The slice of the chat store the watch reads. */
interface ReplyWatchState {
  readonly snapshotLoaded: boolean;
  readonly messages: ReadonlyArray<ReplyRow>;
}

/**
 * The call's thread, while the call is live: each new reply row of the bot is
 * appended for the voice to say (chunked, confirmed by its content and
 * retried by the scheduler), and the thread is marked read once it is said.
 * A thread the call's first send opened is all arrivals; a thread the call
 * joined takes its first snapshot as history.
 *
 * The bot's turn on the thread holds the floor: past `CALL_HOLD_DELAY_MS`
 * of replying, one hold line, and nothing more until a reply lands; a turn
 * that fails or parks gets one failure line, and the call stays open.
 */
function CallThreadWatch(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly threadId: string;
  readonly opened: boolean;
  readonly botTitle: string;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly scheduler: SpeechScheduler;
}): null {
  const { botId, hostId, threadId, opened, botTitle, client, scheduler } =
    props;
  const handle = useChatSessionHandleForContainer(
    botId,
    threadId,
    hostId,
    true,
  );
  const { mutate: markRead } = useNotificationMarkEntityRead(client);
  const markReadRef = useRef(markRead);
  useEffect(() => {
    markReadRef.current = markRead;
  }, [markRead]);

  // ---- The hold ---------------------------------------------------------- //
  const activity = useBotActivity(botId);
  const session =
    activity !== null && Object.hasOwn(activity.threads, threadId)
      ? activity.threads[threadId]
      : null;
  // A thread absent from the reading is idle; no reading at all is unknown.
  const turnState =
    activity === null ? null : (session?.state ?? ("idle" as const));
  const turnRequest = session?.requestId ?? null;
  const holdTimerRef = useRef<number | null>(null);
  /** The hold line queued and not appended yet, so a reply can take its place. */
  const holdItemRef = useRef<string | null>(null);
  const lineSerialRef = useRef(0);
  const turnRef = useRef<{
    readonly state: string | null;
    readonly requestId: string | null;
  } | null>(null);

  const sayLine = useCallback(
    (kind: string, text: string): string => {
      lineSerialRef.current += 1;
      const id = `${kind}:${threadId}:${lineSerialRef.current}`;
      scheduler.enqueue({
        id,
        priority: "focused",
        text,
        delegationId: null,
        confirmWords: confirmationWords({
          botTitle: null,
          threadTitle: null,
          text,
        }),
        onDelivered: null,
        onGivenUp: null,
      });
      return id;
    },
    [scheduler, threadId],
  );
  const clearHold = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);
  /** Starts the wait for one hold line, from now. */
  const armHold = useCallback(() => {
    clearHold();
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      holdItemRef.current = sayLine("hold", CALL_HOLD_LINE);
    }, CALL_HOLD_DELAY_MS);
  }, [clearHold, sayLine]);
  const armHoldRef = useRef(armHold);
  useEffect(() => {
    armHoldRef.current = armHold;
  }, [armHold]);
  useEffect(() => clearHold, [clearHold]);

  useEffect(() => {
    const previous = turnRef.current;
    turnRef.current = { state: turnState, requestId: turnRequest };
    if (turnState === "replying") {
      if (previous?.state !== "replying" || previous.requestId !== turnRequest)
        armHold();
      return;
    }
    clearHold();
    const stopped = turnState === "failed" || turnState === "parked";
    // A turn already stopped when the call joined its thread, or when the
    // first reading came, is not news.
    const changed =
      previous !== null &&
      previous.state !== null &&
      (previous.state !== turnState || previous.requestId !== turnRequest);
    if (stopped && changed) {
      sayLine("failed", callFailureLine(botTitle));
    }
  }, [armHold, botTitle, clearHold, sayLine, turnRequest, turnState]);

  // ---- The replies -------------------------------------------------------- //
  useEffect(() => {
    if (handle === null) return undefined;
    const memory = createReplyWatchMemory();
    const speak = (messageId: string, text: string): void => {
      // A reply landed: a hold line still waiting is not said, and the turn,
      // if it runs on, waits a full delay again before another.
      const hold = holdItemRef.current;
      if (hold !== null) {
        scheduler.remove(hold);
        holdItemRef.current = null;
      }
      if (turnRef.current?.state === "replying") armHoldRef.current();
      scheduler.enqueue({
        id: `reply:${messageId}`,
        priority: "focused",
        text,
        delegationId: null,
        confirmWords: confirmationWords({
          botTitle: null,
          threadTitle: null,
          text,
        }),
        onDelivered: () =>
          markReadRef.current({ epicId: botId, chatId: threadId }),
        onGivenUp: null,
      });
    };
    const watch = (state: ReplyWatchState): void => {
      if (!state.snapshotLoaded) return;
      if (!memory.baselined) {
        const arrived = baselineReplyWatchExcept(
          memory,
          state.messages,
          () => opened,
        );
        for (const reply of arrived) speak(reply.messageId, reply.text);
        return;
      }
      for (const reply of takeNewBotReplies(state.messages, memory)) {
        speak(reply.messageId, reply.text);
      }
    };
    watch(handle.store.getState());
    return handle.store.subscribe(watch);
  }, [botId, handle, opened, scheduler, threadId]);

  return null;
}
