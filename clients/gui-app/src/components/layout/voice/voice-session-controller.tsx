import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import type {
  BotConversationRecord,
  BotConversationSendResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { MicrophoneAccessStatus } from "@traycer-clients/shared/platform/runner-host";
import { useBotConversationListQuery } from "@/hooks/bots/use-bot-conversation-list-query";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useBotConversationSendMutation } from "@/hooks/bots/use-bot-mutations";
import { useBotThreadListQuery } from "@/hooks/bots/use-bot-thread-list-query";
import { dictationCaptureConstraints } from "@/hooks/composer/dictation-capture-constraints";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useNotificationMarkEntityRead } from "@/hooks/notifications/use-notification-mark-entity-read-mutation";
import {
  useAuthService,
  useHostClient,
  type HostRpcRegistry,
} from "@/lib/host";
import { appLogger, describeLogError } from "@/lib/logger";
import { useChatSessionHandleForContainer } from "@/lib/registries/chat-session-registry";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { botTabIntent } from "@/lib/tab-navigation/intents";
import { watchAudioLevel } from "@/lib/voice/audio-level";
import { VoiceEngineError, type VoiceEngine } from "@/lib/voice/engine";
import {
  replySpeechText,
  seenMessageIds,
  takeNewBotReplies,
} from "@/lib/voice/focused-replies";
import { createBrowserGptLiveEngine } from "@/lib/voice/gpt-live-engine";
import { createSayLoop, type SayLoop } from "@/lib/voice/say-loop";
import {
  confirmationWords,
  createSpeechScheduler,
  type SpeechScheduler,
} from "@/lib/voice/scheduler";
import {
  FIRST_SESSION_INPUT,
  REMINT_BEFORE_EXPIRY_MS,
  REMINT_CONTEXT_USAGE_RATIO,
  remintInput,
} from "@/lib/voice/session-input";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useBotOpenThreadStore,
  useBotRail,
  type BotOpenThread,
} from "@/stores/bots/bot-open-thread-store";
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
 * Owns the voice session for this window (Tracy Bots voice, VT2): the
 * microphone, the engine behind the seam, the speech scheduler, the say loop
 * and the focused hear loop. Mounted once, app-wide; the Talk control and the
 * session strip reach it through the store's `driver`.
 *
 * Desktop lifecycle (Tanveer, 2026-10-29): window close and blur keep the
 * session; lock, sleep and quit end it, so an open microphone never outlives
 * the person at the machine. The shell's `onSystemSuspended` is the lock and
 * sleep edge; a page going away closes the engine, which ends the vendor
 * session, and the server finalizes the rest from its own side.
 */
export function VoiceSessionController(): ReactNode {
  const runnerHost = useRunnerHost();
  const auth = useAuthService();
  const navigate = useNavigate();
  const appHostId = useEffectiveHostId();
  const appClient = useHostClient();
  const botsSupported = useHostMethodSupport(appHostId, "bot.list") === true;
  const bots = useBotListQuery(appClient, botsSupported);
  const phase = useVoiceSessionStore((state) => state.phase);
  const focus = useVoiceSessionStore((state) => state.focus);
  const fixedBotId = useBotTabsStore((state) => state.fixedBotId);
  const focusClient = useHostClientForHostId(focus?.hostId ?? null);

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
  const engineRef = useRef<VoiceEngine | null>(null);
  const speechRef = useRef<SpeechScheduler | null>(null);
  const [speech, setSpeech] = useState<SpeechScheduler | null>(null);
  const ensureSpeech = useCallback((): SpeechScheduler => {
    const existing = speechRef.current;
    if (existing !== null) return existing;
    const created = createSpeechScheduler({
      append: (text, delegationId) => {
        try {
          engineRef.current?.appendCommentary(text, delegationId);
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

  // ---- Posting ---------------------------------------------------------- //
  const send = useBotConversationSendMutation(focusClient);
  const conversations = useBotConversationListQuery(
    focusClient,
    focus?.botId ?? "",
    focus !== null,
  );
  const channelId = useMemo(() => {
    if (focus === null || conversations.data === undefined) return null;
    const appConversationChatId =
      bots.data?.bots.find((bot) => bot.botId === focus.botId)
        ?.appConversationChatId ?? null;
    return (
      channelConversation(
        conversations.data.conversations,
        appConversationChatId,
      )?.conversationId ?? null
    );
  }, [bots.data, conversations.data, focus]);
  const viewerUserId = useAuthStore((state) => state.profile?.userId ?? null);
  const { mutateAsync: sendAsync } = send;
  const sendRef = useRef<
    (focus: VoiceFocus, text: string) => Promise<BotConversationSendResponse>
  >(() => Promise.reject(new Error("not ready")));
  useEffect(() => {
    sendRef.current = async (target, text) => {
      if (channelId === null) {
        throw new Error("The bot's channel is not known yet.");
      }
      return sendAsync({
        botId: target.botId,
        conversationId: channelId,
        text,
        threadId: target.threadId,
        announcementId: null,
        redeliver: null,
        supersedes: null,
        answer: null,
      });
    };
  }, [channelId, sendAsync]);
  const viewerRef = useRef(viewerUserId);
  useEffect(() => {
    viewerRef.current = viewerUserId;
  }, [viewerUserId]);

  const sayLoopRef = useRef<SayLoop | null>(null);
  const sayLoop = useCallback((): SayLoop => {
    const existing = sayLoopRef.current;
    if (existing !== null) return existing;
    const created = createSayLoop({
      store: useVoiceSessionStore,
      send: (target, text) => sendRef.current(target, text),
      notify: (text, delegationId) =>
        ensureSpeech().enqueue({
          id: `notify:${delegationId}:${Date.now()}`,
          priority: "focused",
          text,
          delegationId,
          confirmWords: confirmationWords({
            botTitle: null,
            threadTitle: null,
            text,
          }),
          onDelivered: null,
        }),
      ask: (text) =>
        ensureSpeech().enqueue({
          id: `ask:${Date.now()}`,
          priority: "ask",
          text,
          delegationId: null,
          confirmWords: confirmationWords({
            botTitle: null,
            threadTitle: null,
            text,
          }),
          onDelivered: null,
        }),
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
    });
    sayLoopRef.current = created;
    return created;
  }, [ensureSpeech]);

  // ---- Session lifecycle ----------------------------------------------- //
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopLevelWatchRef = useRef<(() => void) | null>(null);
  const expiryTimerRef = useRef<number | null>(null);
  const remintWhenClearRef = useRef<(() => void) | null>(null);
  const endingRef = useRef<VoiceEndReason | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  // The re-mint paths are declared below `connectEngine`, which the engine's
  // own events call them from; the refs break the cycle.
  const remintRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const requestRemintWhenClearRef = useRef<() => void>(() => undefined);

  const releaseAudio = useCallback(() => {
    stopLevelWatchRef.current?.();
    stopLevelWatchRef.current = null;
    const audio = audioRef.current;
    if (audio !== null) {
      audio.pause();
      audio.srcObject = null;
      audioRef.current = null;
    }
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

  const finishSession = useCallback(
    (reason: VoiceEndReason | null) => {
      clearTimers();
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      engineRef.current = null;
      endingRef.current = null;
      releaseAudio();
      speechRef.current?.reset();
      sayLoopRef.current = null;
      if (sessionId !== null) {
        void auth.endVoiceSession(sessionId).then((result) => {
          if (result.kind !== "ok") {
            appLogger.warn("[voice] end route did not answer", {
              kind: result.kind,
            });
          }
        });
      }
      useVoiceSessionStore.getState().sessionEnded(reason);
    },
    [auth, clearTimers, releaseAudio],
  );

  /** Opens an engine on the current microphone; `input` is what it opens knowing. */
  const connectEngine = useCallback(
    async (input: string): Promise<boolean> => {
      const stream = micStreamRef.current;
      const micTrack = stream?.getAudioTracks()[0] ?? null;
      if (micTrack === null) return false;
      const engine = createBrowserGptLiveEngine();
      engineRef.current = engine;
      // Written by the exchange callback below, read after `connect` settles.
      const minted: {
        id: string | null;
        expiresAt: number;
        failure: VoiceEndReason | null;
      } = { id: null, expiresAt: 0, failure: null };
      const store = useVoiceSessionStore.getState();
      try {
        await engine.connect({
          micTrack,
          exchangeSdp: async (offerSdp) => {
            const result = await auth.mintVoiceSession({ offerSdp, input });
            switch (result.kind) {
              case "ok":
                minted.id = result.session.voiceSessionId;
                minted.expiresAt = result.session.expiresAt;
                return result.session.answerSdp;
              case "dormant":
                store.setAvailability("dormant");
                minted.failure = "unavailable";
                break;
              case "credits-exhausted":
                minted.failure = "credits";
                break;
              case "unavailable":
              case "unauthorized":
              case "network-error":
                minted.failure = "unavailable";
                break;
            }
            throw new VoiceEngineError(
              "EXCHANGE_FAILED",
              `voice session mint answered ${result.kind}`,
            );
          },
          onRemoteAudio: (remote) => {
            if (engineRef.current !== engine) return;
            stopLevelWatchRef.current?.();
            const audio = audioRef.current ?? new Audio();
            audioRef.current = audio;
            audio.autoplay = true;
            audio.srcObject = remote;
            void audio.play().catch((error: unknown) => {
              appLogger.warn("[voice] remote audio play failed", {
                error: describeLogError(error),
              });
            });
            stopLevelWatchRef.current = watchAudioLevel(remote, (speaking) =>
              speechRef.current?.noteOutputLevel(speaking),
            );
          },
          events: {
            onInputTranscriptDelta: (text) => {
              if (engineRef.current !== engine) return;
              const current = useVoiceSessionStore.getState();
              current.appendInputSegment(text, Date.now());
              current.pushCaptionLine({ direction: "input", text });
              ensureSpeech().noteInputTranscript();
            },
            onOutputTranscriptDelta: (text) => {
              if (engineRef.current !== engine) return;
              useVoiceSessionStore
                .getState()
                .pushCaptionLine({ direction: "output", text });
              ensureSpeech().noteOutputTranscript(text);
            },
            onDelegationCreated: (delegationId) => {
              if (engineRef.current !== engine) return;
              ensureSpeech().noteDelegationCreated();
              void sayLoop().onDelegationCreated(delegationId);
            },
            onUsage: (usage) => {
              if (engineRef.current !== engine) return;
              if (
                usage.contextUsageRatio !== null &&
                usage.contextUsageRatio >= REMINT_CONTEXT_USAGE_RATIO
              ) {
                requestRemintWhenClearRef.current();
              }
            },
            onClosed: (reason) => {
              if (engineRef.current !== engine) return;
              if (reason === "app") {
                finishSession(endingRef.current);
                return;
              }
              // The vendor or the network ended a session that had time
              // left: a fresh one carries on with the same focus and words.
              // A session the server closed for credits refuses the re-mint
              // with 402, which ends it with the reason said.
              if (Date.now() < minted.expiresAt - REMINT_BEFORE_EXPIRY_MS) {
                void remintRef.current();
                return;
              }
              finishSession("connection");
            },
          },
        });
      } catch (error) {
        if (engineRef.current !== engine) return false;
        engineRef.current = null;
        appLogger.warn("[voice] session connect failed", {
          error: describeLogError(error),
        });
        finishSession(minted.failure ?? "connection");
        return false;
      }
      if (engineRef.current !== engine || minted.id === null) return false;
      sessionIdRef.current = minted.id;
      useVoiceSessionStore.getState().sessionLive({
        id: minted.id,
        expiresAt: minted.expiresAt,
        engine,
      });
      clearTimers();
      const untilRemint =
        minted.expiresAt - REMINT_BEFORE_EXPIRY_MS - Date.now();
      expiryTimerRef.current = window.setTimeout(
        () => {
          expiryTimerRef.current = null;
          void remintRef.current();
        },
        Math.max(0, untilRemint),
      );
      return true;
    },
    [auth, clearTimers, finishSession, sayLoop, ensureSpeech],
  );

  /**
   * Replaces the vendor session under the same focus, segments and queue:
   * the old engine is closed and its end reported, the new one opens seeded
   * with a summary of where the person is. Nothing is replayed.
   */
  const remint = useCallback(async (): Promise<void> => {
    const old = engineRef.current;
    const oldId = sessionIdRef.current;
    if (old === null) return;
    clearTimers();
    engineRef.current = null;
    sessionIdRef.current = null;
    old.close();
    if (oldId !== null) void auth.endVoiceSession(oldId);
    const state = useVoiceSessionStore.getState();
    state.sessionConnecting();
    state.setPendingDelegation(null);
    await connectEngine(
      remintInput({
        focus: state.focus,
        botTitle: botTitleRef.current,
        queue: state.queue,
      }),
    );
  }, [auth, clearTimers, connectEngine]);

  const requestRemintWhenClear = useCallback(() => {
    if (remintWhenClearRef.current !== null) return;
    const current = ensureSpeech();
    if (current.isClear()) {
      void remint();
      return;
    }
    const unsubscribe = current.subscribe(() => {
      if (!current.isClear()) return;
      unsubscribe();
      remintWhenClearRef.current = null;
      void remint();
    });
    remintWhenClearRef.current = unsubscribe;
  }, [remint, ensureSpeech]);

  useEffect(() => {
    remintRef.current = remint;
    requestRemintWhenClearRef.current = requestRemintWhenClear;
  }, [remint, requestRemintWhenClear]);

  const start = useCallback(async (): Promise<void> => {
    const store = useVoiceSessionStore.getState();
    if (store.phase !== "idle" || store.availability === "dormant") return;
    store.sessionConnecting();
    // The session starts focused on the channel or thread the person has
    // open, or on personal Tracy when none is (V6); Tracy's tab opens then.
    const selected = readSelection();
    if (selected !== null) {
      store.setFocus(selected);
    } else if (fixedBotId !== null) {
      const tab = lookupBotTab(useBotTabsStore.getState().tabs, fixedBotId);
      if (tab !== null) {
        store.setFocus({
          botId: fixedBotId,
          hostId: tab.hostId,
          threadId: null,
          anchorMessageId: null,
        });
        navigateToTabIntent(navigate, botTabIntent(fixedBotId), undefined);
      }
    }
    let access: MicrophoneAccessStatus;
    try {
      access = await runnerHost.requestMicrophoneAccess();
    } catch (error) {
      appLogger.warn("[voice] microphone access request failed", {
        error: describeLogError(error),
      });
      finishSession("microphone");
      return;
    }
    if (access === "denied") {
      finishSession("microphone");
      return;
    }
    try {
      micStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: dictationCaptureConstraints(),
      });
    } catch (error) {
      appLogger.warn("[voice] microphone open failed", {
        error: describeLogError(error),
      });
      finishSession("microphone");
      return;
    }
    if (useVoiceSessionStore.getState().phase !== "connecting") {
      releaseAudio();
      return;
    }
    await connectEngine(FIRST_SESSION_INPUT);
  }, [
    connectEngine,
    finishSession,
    fixedBotId,
    navigate,
    releaseAudio,
    runnerHost,
  ]);

  const end = useCallback(
    (reason: VoiceEndReason) => {
      const store = useVoiceSessionStore.getState();
      if (store.phase === "idle") return;
      const engine = engineRef.current;
      if (engine === null) {
        finishSession(reason === "ended" ? null : reason);
        return;
      }
      endingRef.current = reason === "ended" ? null : reason;
      store.sessionEnding();
      engine.close();
    },
    [finishSession],
  );

  const setMuted = useCallback((muted: boolean) => {
    const stream = micStreamRef.current;
    if (stream !== null) {
      for (const track of stream.getAudioTracks()) track.enabled = !muted;
    }
    useVoiceSessionStore.getState().setMuted(muted);
  }, []);

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

  // Lock and sleep end the session; the page going away closes the engine,
  // which tells the vendor, while the server finalizes from its sideband.
  useEffect(() => {
    const subscription = runnerHost.onSystemSuspended(() => end("locked"));
    const onPageHide = (): void => {
      engineRef.current?.close();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      subscription.dispose();
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [end, runnerHost]);

  // Unmount ends everything; the microphone never outlives the controller.
  // Through a ref, so a new `finishSession` identity never ends a live
  // session by re-running the cleanup.
  const finishSessionRef = useRef(finishSession);
  useEffect(() => {
    finishSessionRef.current = finishSession;
  }, [finishSession]);
  useEffect(
    () => () => {
      engineRef.current?.close();
      finishSessionRef.current(null);
    },
    [],
  );

  const live = phase === "live";
  return (
    <>
      {live ? (
        <VoiceSelectionSync
          onManualChange={() => sayLoopRef.current?.onSelectionChanged()}
        />
      ) : null}
      {live && focus !== null && channelId !== null && speech !== null ? (
        <VoiceFocusedReplyFeed
          key={`${focus.botId}:${focus.threadId ?? channelId}`}
          focus={focus}
          chatId={focus.threadId ?? channelId}
          client={focusClient}
          speaksAsThisBot={focus.botId === fixedBotId}
          botTitle={botTitle(focus.botId)}
          scheduler={speech}
        />
      ) : null}
    </>
  );
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
  return {
    botId: ref.id,
    hostId: tab.hostId,
    threadId: thread?.sent?.threadId ?? null,
    anchorMessageId: thread?.anchorMessageId ?? null,
  };
}

/**
 * Selection → focus, while the session is live. A manual change of channel
 * or thread moves the focus and the generation; a change that only resolves
 * the thread behind an anchor the focus already names (the thread list
 * catching up with the rail) moves the focus alone. A tab that is not a
 * bot's leaves the focus where it was: the strip follows the person across
 * tasks, and their words still go to the last bot.
 */
function VoiceSelectionSync(props: {
  readonly onManualChange: () => void;
}): null {
  const { onManualChange } = props;
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
  const anchorMessageId = thread?.anchorMessageId ?? null;
  const threadId = threadIdOf(thread, threads.data?.threads ?? null);

  useEffect(() => {
    if (activeBotId === null || tab === null) return;
    applySelection(
      { botId: activeBotId, hostId: tab.hostId, threadId, anchorMessageId },
      onManualChange,
    );
  }, [activeBotId, anchorMessageId, onManualChange, tab, threadId]);

  return null;
}

/**
 * The open thread's id: known from the send that opened it, else looked up
 * by its anchor in the thread list once that answers; `null` meanwhile.
 */
function threadIdOf(
  thread: BotOpenThread | null,
  threads: ReadonlyArray<BotThreadSummary> | null,
): string | null {
  if (thread === null) return null;
  if (thread.sent !== null) return thread.sent.threadId;
  return (
    threads?.find(
      (candidate) => candidate.anchor?.messageId === thread.anchorMessageId,
    )?.threadId ?? null
  );
}

/**
 * Writes the app's selection to the focus. The thread list resolving the id
 * behind an anchor the focus already names is not a move; anything else is
 * the person's, moves the generation, and interrupts an open utterance.
 */
function applySelection(
  selection: VoiceFocus,
  onManualChange: () => void,
): void {
  const store = useVoiceSessionStore.getState();
  const current = store.focus;
  if (sameFocus(current, selection)) return;
  const resolvedOnly =
    current !== null &&
    current.botId === selection.botId &&
    current.anchorMessageId === selection.anchorMessageId &&
    current.threadId === null &&
    selection.threadId !== null;
  if (resolvedOnly) {
    store.setFocus(selection);
    return;
  }
  const wasOpen = isUtteranceOpen(store);
  store.selectionChanged(selection);
  if (wasOpen) onManualChange();
}

/**
 * The hear loop's focused source: a new row of the bot on the focused
 * thread's (or channel's) chat store becomes the focused item, appended
 * under the current delegation when the scheduler finds a clear moment, and
 * the thread is marked read once the voice is confirmed to have said it,
 * with the entity-level call looking makes. Keyed by chat, so a focus move
 * starts a fresh watch whose history is never spoken.
 */
function VoiceFocusedReplyFeed(props: {
  readonly focus: VoiceFocus;
  readonly chatId: string;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly speaksAsThisBot: boolean;
  readonly botTitle: string;
  readonly scheduler: SpeechScheduler;
}): null {
  const { focus, chatId, client, speaksAsThisBot, botTitle, scheduler } = props;
  const handle = useChatSessionHandleForContainer(
    focus.botId,
    chatId,
    focus.hostId,
    true,
  );
  const { mutate: markRead } = useNotificationMarkEntityRead(client);
  const markReadRef = useRef(markRead);
  useEffect(() => {
    markReadRef.current = markRead;
  }, [markRead]);

  useEffect(() => {
    if (handle === null) return;
    const seen = seenMessageIds(handle.store.getState().messages);
    return handle.store.subscribe((state) => {
      for (const reply of takeNewBotReplies(state.messages, seen)) {
        const text = replySpeechText({
          botTitle,
          speaksAsThisBot,
          content: reply.text,
        });
        scheduler.enqueue({
          id: `reply:${reply.messageId}`,
          priority: "focused",
          text,
          delegationId: useVoiceSessionStore.getState().pendingDelegationId,
          confirmWords: confirmationWords({
            botTitle,
            threadTitle: null,
            text: reply.text,
          }),
          onDelivered: () =>
            markReadRef.current({ epicId: focus.botId, chatId }),
        });
      }
    });
  }, [botTitle, chatId, focus.botId, handle, scheduler, speaksAsThisBot]);

  return null;
}
