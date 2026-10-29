import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { ChevronLeft, X } from "lucide-react";
import type { BotTurnRef } from "@traycer/protocol/host/bot/conversation-schemas";
import type { TranscriptRowLocator } from "@traycer/protocol/persistence/chat-transcript/locate-row";
import { assistantRowTurnKey } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { BotChatTranscript } from "@/components/bots/bot-chat-transcript";
import { useBotSessionMessages } from "@/hooks/bots/use-bot-session-messages";
import { ChannelPost } from "@/components/bots/bot-channel-post";
import { BotReadFailure } from "@/components/bots/bot-read-failure";
import { buildChatActivityTimeline } from "@/components/chat/chat-activity-groups";
import { formatUsd, pickElapsedVerb } from "@/lib/chat/turn-footer-format";
import { ChatTranscriptProvider } from "@/components/chat/chat-transcript-context";
import { ActivityGroupSegment } from "@/components/chat/segments/activity-group-segment";
import { useRegionGhost } from "@/components/layout-editor/use-layout-region";
import { useChatLocateRowAnswer } from "@/hooks/chats/use-chat-locate-row";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useElapsedSeconds } from "@/hooks/use-elapsed-seconds";
import { firstLineOf } from "@/lib/bots/bot-trunk-model";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import { postTextOf } from "@/lib/bots/reply-row";
import { formatClockDuration, formatWorkedFor } from "@/lib/format-duration";
import { useRegionShown } from "@/lib/layout-overrides";
import { useChatSessionHandleForContainer } from "@/lib/registries/chat-session-registry";
import { useMessageTime } from "@/lib/relative-time";
import type {
  BotChatMessageRef,
  BotOpenTurn,
} from "@/stores/bots/bot-open-thread-store";
import { ActivityGroupOpenStoreProvider } from "@/stores/chats/activity-group-open-store";
import { ChatFindForceStoreProvider } from "@/stores/chats/chat-find-force-store";
import {
  isWindowedTranscript,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import type { ChatMessage } from "@/stores/composer/chat-store";

const NO_PROMOTED_BLOCKS: ReadonlySet<string> = new Set();

/**
 * One turn of the bot, in the rail beside its channel: "How Tracy answered"
 * (Tracy Bots T86, decision 116). It takes the rail's one slot, a thread
 * included: the header then carries ‹ and a crumb naming the thread by its
 * post's first line, and either brings the thread back. Under the header,
 * the member's message the turn answered and what it did, how long it took
 * in the agent chat's words, the model and cost as the agent chat's turn
 * footer says them, and the turn's activity as the agent chat draws its
 * activity group; live while the turn runs, fixed once it ends. The footer
 * names the session - the trunk's or a thread's - and opens its transcript
 * in the panel, landed on the turn. The turn links to nothing above it.
 */
export function BotTurnPanel(props: {
  readonly botId: string;
  /** The host serving the tab: the session is read through it. */
  readonly hostId: string;
  readonly botTitle: string;
  /** The bot's channel, where a displaced thread's post is. */
  readonly channelId: string;
  readonly turn: BotOpenTurn;
  readonly resolveMember: BotMemberResolver;
  /** Brings back the thread the turn displaced; `null` when it displaced none. */
  readonly onBack: (() => void) | null;
  readonly onClose: () => void;
}): ReactNode {
  const { botId, hostId, botTitle, channelId, turn, resolveMember } = props;
  const { ref } = turn;
  const [transcript, setTranscript] = useState(false);
  return (
    <section
      aria-label={`How ${botTitle} answered`}
      data-testid="bot-turn-panel"
      data-turn-id={ref.turnId}
      className="flex min-h-0 flex-1 flex-col"
    >
      <TurnPanelHeader
        botId={botId}
        hostId={hostId}
        botTitle={botTitle}
        channelId={channelId}
        turn={turn}
        onBack={props.onBack}
        onClose={props.onClose}
      />
      {transcript ? (
        <div
          className="flex min-h-0 flex-1 flex-col"
          data-testid="bot-turn-transcript"
        >
          <BotChatTranscript
            botId={botId}
            chatId={ref.chatId}
            hostId={hostId}
            title={botTitle}
            instanceId={`bot-turn-session:${ref.chatId}`}
            surface={null}
            resolveMember={resolveMember}
            showConnecting
            landOnMessageId={ref.userMessageId}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          {turn.question === null ? null : (
            <TurnQuestion
              botId={botId}
              hostId={hostId}
              question={turn.question}
            />
          )}
          {ref.summary === null ? null : (
            <p
              className="text-ui-sm text-foreground"
              data-testid="bot-turn-summary"
            >
              {ref.summary}
            </p>
          )}
          <TurnSession
            botId={botId}
            hostId={hostId}
            turnRef={ref}
            resolveMember={resolveMember}
          />
        </div>
      )}
      <footer className="flex shrink-0 items-center gap-2 border-t border-border/60 px-4 py-2 text-ui-xs text-muted-foreground">
        <span data-testid="bot-turn-session">
          {ref.threadId === null ? "Trunk session" : "Thread session"}
        </span>
        <Button
          type="button"
          variant="link"
          size="xs"
          className="ml-auto"
          data-testid="bot-turn-open-transcript"
          aria-pressed={transcript}
          onClick={() => setTranscript((open) => !open)}
        >
          {transcript ? "Back to this answer" : "Open the session transcript"}
        </Button>
      </footer>
    </section>
  );
}

function TurnPanelHeader(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly botTitle: string;
  readonly channelId: string;
  readonly turn: BotOpenTurn;
  readonly onBack: (() => void) | null;
  readonly onClose: () => void;
}): ReactNode {
  const { botId, hostId, botTitle, channelId, turn, onBack, onClose } = props;
  const at = useMessageTime(turn.ref.endedAt ?? turn.ref.startedAt);
  const back = turn.back;
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2.5">
      {onBack === null ? null : (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Back to the thread"
          data-testid="bot-turn-back"
          onClick={onBack}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className="truncate text-ui-md font-semibold text-foreground">
          {`How ${botTitle} answered`}
        </h2>
        <span className="flex min-w-0 items-center gap-1.5 text-ui-xs text-muted-foreground">
          {back === null || onBack === null ? null : (
            <>
              <ThreadCrumb
                botId={botId}
                hostId={hostId}
                channelId={channelId}
                anchorMessageId={back.anchorMessageId}
                onBack={onBack}
              />
              <span aria-hidden="true">·</span>
            </>
          )}
          <span className="shrink-0" data-testid="bot-turn-when">
            {`This answer · ${at}`}
          </span>
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Close"
        data-testid="bot-turn-close"
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </Button>
    </header>
  );
}

/** The displaced thread, named by its post's first line; it brings the thread back. */
function ThreadCrumb(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly channelId: string;
  readonly anchorMessageId: string;
  readonly onBack: () => void;
}): ReactNode {
  const { botId, hostId, channelId, anchorMessageId, onBack } = props;
  return (
    <ChannelPost
      botId={botId}
      hostId={hostId}
      conversationId={channelId}
      messageId={anchorMessageId}
      fetchCold
    >
      {(post) => {
        const line = firstLineOf(postTextOf(post));
        return (
          <button
            type="button"
            data-testid="bot-turn-crumb"
            onClick={onBack}
            className="min-w-0 truncate rounded-sm hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {line === null ? "Thread" : `Thread · ${line}`}
          </button>
        );
      }}
    </ChannelPost>
  );
}

/** "Answering "<the message's first line>"", read from the chat it was written in. */
function TurnQuestion(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly question: BotChatMessageRef;
}): ReactNode {
  const { botId, hostId, question } = props;
  return (
    <ChannelPost
      botId={botId}
      hostId={hostId}
      conversationId={question.chatId}
      messageId={question.messageId}
      fetchCold
    >
      {(post) => {
        const line = firstLineOf(postTextOf(post));
        return line === null ? null : (
          <p
            className="text-ui-sm font-semibold text-foreground"
            data-testid="bot-turn-question"
          >
            {`Answering "${line}"`}
          </p>
        );
      }}
    </ChannelPost>
  );
}

/** The turn as the session's transcript holds it; a spinner while it connects. */
function TurnSession(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly turnRef: BotTurnRef;
  readonly resolveMember: BotMemberResolver;
}): ReactNode {
  const { botId, hostId, turnRef, resolveMember } = props;
  const handle = useChatSessionHandleForContainer(
    botId,
    turnRef.chatId,
    hostId,
    true,
  );
  if (handle === null) return <TurnLoading />;
  return (
    <TurnSessionBody
      handle={handle}
      botId={botId}
      hostId={hostId}
      turnRef={turnRef}
      resolveMember={resolveMember}
    />
  );
}

function TurnSessionBody(props: {
  readonly handle: ChatSessionStoreHandle;
  readonly botId: string;
  readonly hostId: string;
  readonly turnRef: BotTurnRef;
  readonly resolveMember: BotMemberResolver;
}): ReactNode {
  const { handle, botId, hostId, turnRef, resolveMember } = props;
  const { state, messages } = useBotSessionMessages({
    handle,
    botId,
    chatId: turnRef.chatId,
    viewTabId: `bot-turn:${turnRef.chatId}`,
    resolveMember,
  });
  const rows = useMemo(
    () =>
      messages.filter(
        (message) =>
          message.role === "assistant" && message.turnId === turnRef.turnId,
      ),
    [messages, turnRef.turnId],
  );
  const windowed = isWindowedTranscript(state);
  const missing = useHydrateTurn({
    handle,
    botId,
    turnRef,
    windowed,
    skeleton: state.transcriptWindow.skeleton,
    epoch: state.transcriptWindow.epoch,
  });
  if (state.fatalClose !== null) {
    return (
      <BotReadFailure
        message="Couldn't load how this answer was made."
        onRetry={state.retry}
        testId="bot-turn-error"
      />
    );
  }
  if (!state.snapshotLoaded || (rows.length === 0 && windowed && !missing)) {
    return <TurnLoading />;
  }
  return (
    <ChatTranscriptProvider value={{ chatId: turnRef.chatId, hostId }}>
      <TurnMeta turnRef={turnRef} rows={rows} />
      <TurnActivity rows={rows} instanceId={`bot-turn:${turnRef.turnId}`} />
    </ChatTranscriptProvider>
  );
}

/**
 * How long the turn took, in the agent chat's footer's words ("Pondered for
 * 1m 20s"), or how long it has run; and the model with its reasoning and
 * the turn's cost, as the agent chat's turn footer shows them.
 */
function TurnMeta(props: {
  readonly turnRef: BotTurnRef;
  readonly rows: ReadonlyArray<ChatMessage>;
}): ReactNode {
  const { turnRef, rows } = props;
  const last = rows.at(-1) ?? null;
  const meta = rows.findLast(
    (row) => row.assistantMeta !== null,
  )?.assistantMeta;
  const model =
    meta === undefined || meta === null
      ? null
      : [meta.providerLabel, meta.modelLabel, meta.reasoningEffortLabel]
          .filter((part): part is string => part !== null && part.length > 0)
          .join(" · ");
  const cost =
    meta === undefined ||
    meta === null ||
    meta.costUsd === null ||
    meta.costUsd <= 0
      ? null
      : formatUsd(meta.costUsd);
  return (
    <p
      className="flex flex-wrap gap-x-3 gap-y-0.5 text-ui-xs text-muted-foreground"
      data-testid="bot-turn-meta"
    >
      {turnRef.endedAt === null ? (
        <TurnRunningFor startedAt={turnRef.startedAt} />
      ) : (
        <span>
          {`${pickElapsedVerb(last?.id ?? turnRef.turnId)} for ${formatWorkedFor(turnRef.endedAt - turnRef.startedAt)}`}
        </span>
      )}
      {model === null || model.length === 0 ? null : <span>{model}</span>}
      {cost === null ? null : <span className="tabular-nums">{cost}</span>}
    </p>
  );
}

function TurnRunningFor(props: { readonly startedAt: number }): ReactNode {
  const seconds = useElapsedSeconds(props.startedAt, 0, null);
  return (
    <span className="tabular-nums">{`Working for ${formatClockDuration(seconds)}`}</span>
  );
}

/** The turn's activity, as the agent chat draws its activity group. */
function TurnActivity(props: {
  readonly rows: ReadonlyArray<ChatMessage>;
  readonly instanceId: string;
}): ReactNode {
  const { rows, instanceId } = props;
  // Thinking hidden leaves the reasoning out, as the agent chat does, unless
  // the layout editor points at it.
  const thinkingShown = useRegionShown("thinking");
  const thinkingGhost = useRegionGhost("thinking");
  const running = rows.some((row) => row.runState !== null);
  const timeline = useMemo(
    () =>
      buildChatActivityTimeline(
        rows.flatMap((row) => row.segments),
        {
          turnState: running ? "active" : "complete",
          promotedToolBlockIds: NO_PROMOTED_BLOCKS,
          hideReasoning: !(thinkingShown || thinkingGhost),
        },
      ),
    [rows, running, thinkingGhost, thinkingShown],
  );
  return (
    <ChatFindForceStoreProvider tileInstanceId={instanceId}>
      <ActivityGroupOpenStoreProvider store={null}>
        <div className="flex flex-col gap-2" data-testid="bot-turn-activity">
          {timeline.map((item) =>
            item.kind === "activity_group" ? (
              <ActivityGroupSegment key={item.id} group={item.group} />
            ) : null,
          )}
        </div>
      </ActivityGroupOpenStoreProvider>
    </ChatFindForceStoreProvider>
  );
}

function TurnLoading(): ReactNode {
  return (
    <div
      className="flex flex-1 items-center justify-center py-10 text-muted-foreground"
      aria-busy="true"
      data-testid="bot-turn-loading"
    >
      <AgentSpinningDots
        className={undefined}
        testId={undefined}
        variant={undefined}
      />
    </div>
  );
}

/** Where a turn's rows are in its session's transcript, as the skeleton names them. */
interface TurnOrdinals {
  /** The session's message that started the turn; `null` while the skeleton has not named it. */
  readonly start: number | null;
  /** The turn's own rows. */
  readonly rows: ReadonlyArray<number>;
}

const skeletonTurnCache = new WeakMap<
  readonly (RowSkeletonEntry | undefined)[],
  Map<string, TurnOrdinals>
>();

function turnOrdinalsOf(
  skeleton: readonly (RowSkeletonEntry | undefined)[],
  turnRef: BotTurnRef,
): TurnOrdinals {
  let byTurn = skeletonTurnCache.get(skeleton);
  if (byTurn === undefined) {
    byTurn = new Map();
    skeletonTurnCache.set(skeleton, byTurn);
  }
  const key = `${turnRef.turnId}\n${turnRef.userMessageId}`;
  const cached = byTurn.get(key);
  if (cached !== undefined) return cached;
  let start: number | null = null;
  const rows: number[] = [];
  for (let ordinal = 0; ordinal < skeleton.length; ordinal += 1) {
    const entry = skeleton[ordinal];
    if (entry === undefined) continue;
    if (entry.rowId === turnRef.userMessageId) start = ordinal;
    else if (assistantRowTurnKey(entry.rowId) === turnRef.turnId) {
      rows.push(ordinal);
    }
  }
  const found: TurnOrdinals = { start, rows };
  byTurn.set(key, found);
  return found;
}

/**
 * An old turn is not in the window the session hydrates by default (its
 * tail): the turn's rows - where the skeleton names them, else the row the
 * host locates its message at and the one after it - are held hydrated for
 * as long as the panel shows the turn. Returns whether the host said the
 * session has no such message, after which nothing more arrives.
 */
function useHydrateTurn(input: {
  readonly handle: ChatSessionStoreHandle;
  readonly botId: string;
  readonly turnRef: BotTurnRef;
  readonly windowed: boolean;
  readonly skeleton: readonly (RowSkeletonEntry | undefined)[];
  readonly epoch: number;
}): boolean {
  const { handle, botId, turnRef, windowed, skeleton, epoch } = input;
  const client = useTabHostClient();
  const hold = useStore(handle.store, (s) => s.holdTranscriptOrdinal);
  const known = turnOrdinalsOf(skeleton, turnRef);
  const target = useMemo<TranscriptRowLocator | null>(
    () =>
      windowed && known.start === null
        ? { kind: "message", messageId: turnRef.userMessageId }
        : null,
    [known.start, turnRef.userMessageId, windowed],
  );
  const answer = useChatLocateRowAnswer({
    client,
    epicId: botId,
    chatId: turnRef.chatId,
    target,
    epoch,
  });
  const start =
    known.start ?? (answer.status === "found" ? answer.ordinal : null);
  const held = new Set(known.rows);
  if (start !== null) {
    held.add(start);
    if (known.rows.length === 0) held.add(start + 1);
  }
  const heldKey = [...held].sort((a, b) => a - b).join(",");
  useEffect(() => {
    if (!windowed || heldKey.length === 0) return undefined;
    const releases = heldKey.split(",").map((ordinal) => hold(Number(ordinal)));
    return () => {
      for (const release of releases) release();
    };
  }, [heldKey, hold, windowed]);
  return (
    known.start === null &&
    known.rows.length === 0 &&
    answer.status === "missing"
  );
}
