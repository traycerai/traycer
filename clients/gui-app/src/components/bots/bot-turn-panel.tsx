import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { ChevronLeft, X } from "lucide-react";
import type {
  BotTurnKey,
  BotTurnRef,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { TranscriptRowLocator } from "@traycer/protocol/persistence/chat-transcript/locate-row";
import { assistantRowTurnKey } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { BotChatTranscript } from "@/components/bots/bot-chat-transcript";
import { useBotSessionMessages } from "@/hooks/bots/use-bot-session-messages";
import { ChannelPost } from "@/components/bots/bot-channel-post";
import { BotReadFailure } from "@/components/bots/bot-read-failure";
import {
  buildChatActivityTimeline,
  type ChatActivityTimelineItem,
} from "@/components/chat/chat-activity-groups";
import { formatUsd, pickElapsedVerb } from "@/lib/chat/turn-footer-format";
import { ChatContainerContext } from "@/components/chat/chat-container-context";
import { ChatBlockNavigationAnchor } from "@/components/chat/chat-navigation-highlight";
import { ChatTranscriptProvider } from "@/components/chat/chat-transcript-context";
import {
  AssistantSegment,
  PromotedSubagentItem,
} from "@/components/chat/chat-message-assistant-body";
import { distinctRenderKeys } from "@/components/chat/segment-render-keys";
import { ActivityGroupSegment } from "@/components/chat/segments/activity-group-segment";
import { useBotTurnLocateQuery } from "@/hooks/bots/use-bot-turn-locate-query";
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
import { A2AOpenStoreProvider } from "@/stores/chats/a2a-open-store";
import { ActivityGroupOpenStoreProvider } from "@/stores/chats/activity-group-open-store";
import { ChatOpenStoreScopeProvider } from "@/stores/chats/open-store-scope";
import { ChatFindForceStoreProvider } from "@/stores/chats/chat-find-force-store";
import {
  isWindowedTranscript,
  type ChatSessionState,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import type { HydratedSpan } from "@/stores/chats/transcript-window";
import type { ChatMessage } from "@/stores/composer/chat-store";

const NO_BACKGROUND_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set();
const NO_IDS: ReadonlyArray<string> = [];

/**
 * One turn of the bot, in the rail beside its channel: "How Tracy answered"
 * (Tracy Bots T86, decision 116). It takes the rail's one slot, a thread
 * included: the header then carries ‹ and a crumb naming the thread by its
 * post's first line, and either brings the thread back. Under the header,
 * the member's message the turn answered and what it did, how long it took
 * in the agent chat's words, the model and cost as the agent chat's turn
 * footer says them, and the turn's activity as the agent chat draws its
 * activity group; live while the turn runs - the turn is read again from
 * its bot's host while the panel shows it, a retry included. The footer
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
  const ref = useLiveTurnRef({ botId, hostId, opened: turn.ref });
  const [transcript, setTranscript] = useState(false);
  return (
    <section
      aria-label={`How ${botTitle} answered`}
      data-testid="bot-turn-panel"
      data-turn-id={ref.turnIds[0]}
      className="flex min-h-0 flex-1 flex-col"
    >
      <TurnPanelHeader
        botId={botId}
        hostId={hostId}
        botTitle={botTitle}
        channelId={channelId}
        turnRef={ref}
        back={turn.back}
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
            landOn={{ messageId: ref.userMessageId, visit: 0 }}
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

/**
 * The open turn as its bot's host names it now. The ref the rail opened is
 * what a receipt said at its click; the panel also reads the turn through
 * the same `bot.turn.locate` read the receipts use - keyed by the session
 * and the turn's first id, refetched when the bot's activity says a turn
 * started or settled - for as long as it shows the turn, ended or not: a
 * retry reopens an ended turn under a further id, and the panel follows it.
 * Of the two, the newer wins (`newerTurnRef`), so a receipt clicked again
 * after a retry replaces an end the read still holds, and the read's end
 * replaces the running ref the rail was opened with.
 */
function useLiveTurnRef(input: {
  readonly botId: string;
  readonly hostId: string;
  readonly opened: BotTurnRef;
}): BotTurnRef {
  const { botId, hostId, opened } = input;
  const client = useTabHostClient();
  const firstId = opened.turnIds[0];
  const turns = useMemo<ReadonlyArray<BotTurnKey>>(
    () => [{ chatId: opened.chatId, turnId: firstId }],
    [firstId, opened.chatId],
  );
  const located = useBotTurnLocateQuery({
    client,
    hostId,
    botId,
    messageIds: NO_IDS,
    requestIds: NO_IDS,
    turns,
  });
  const live =
    located.data?.turns.find(
      (ref) =>
        ref.chatId === opened.chatId &&
        ref.turnIds.some((id) => opened.turnIds.includes(id)),
    ) ?? null;
  return live === null ? opened : newerTurnRef(live, opened);
}

/**
 * Which of two refs of one turn is newer. A retry runs the turn again under
 * a further id, so more ids is newer; under the same ids the turn only goes
 * from running to ended, so an ended ref is newer than a running one. A tie
 * keeps the host's read (`live`).
 */
function newerTurnRef(live: BotTurnRef, opened: BotTurnRef): BotTurnRef {
  if (opened.turnIds.length !== live.turnIds.length) {
    return opened.turnIds.length > live.turnIds.length ? opened : live;
  }
  if (live.endedAt === null && opened.endedAt !== null) return opened;
  return live;
}

function TurnPanelHeader(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly botTitle: string;
  readonly channelId: string;
  readonly turnRef: BotTurnRef;
  readonly back: BotOpenTurn["back"];
  readonly onBack: (() => void) | null;
  readonly onClose: () => void;
}): ReactNode {
  const { botId, hostId, botTitle, channelId, turnRef, back, onBack, onClose } =
    props;
  const at = useMessageTime(turnRef.endedAt ?? turnRef.startedAt);
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
                testId="bot-turn-crumb"
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
export function ThreadCrumb(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly channelId: string;
  readonly anchorMessageId: string;
  readonly onBack: () => void;
  readonly testId: string;
}): ReactNode {
  const { botId, hostId, channelId, anchorMessageId, onBack, testId } = props;
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
            data-testid={testId}
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
  // Every id the turn ran under names some of its rows: a launch's
  // provisional id, the provider's, a retry's.
  const rows = useMemo(
    () =>
      messages.filter(
        (message) =>
          message.role === "assistant" &&
          message.turnId !== undefined &&
          turnRef.turnIds.includes(message.turnId),
      ),
    [messages, turnRef.turnIds],
  );
  const windowed = isWindowedTranscript(state);
  const settled = useHydrateTurn({
    handle,
    botId,
    turnRef,
    windowed,
    transcriptWindow: state.transcriptWindow,
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
  if (!state.snapshotLoaded || (rows.length === 0 && !settled)) {
    return <TurnLoading />;
  }
  // An ended turn none of whose rows the session holds any more: said, not
  // spun on. A running one with no row yet shows how long it has run, and
  // its rows as they arrive.
  if (rows.length === 0 && turnRef.endedAt !== null) {
    return (
      <>
        <TurnMeta turnRef={turnRef} rows={rows} />
        <p
          className="text-ui-sm text-muted-foreground"
          data-testid="bot-turn-not-found"
        >
          This answer's steps are no longer in its session.
        </p>
      </>
    );
  }
  return (
    // The bot is the session's container, as its transcript says: a browser
    // session the turn opened reads the bot's browser inventory.
    <ChatContainerContext.Provider value={botId}>
      <ChatTranscriptProvider value={{ chatId: turnRef.chatId, hostId }}>
        <TurnMeta turnRef={turnRef} rows={rows} />
        <TurnActivity
          rows={rows}
          backgroundItems={state.backgroundItems}
          instanceId={`bot-turn:${turnRef.turnIds[0]}`}
        />
      </ChatTranscriptProvider>
    </ChatContainerContext.Provider>
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
          {`${pickElapsedVerb(last?.id ?? turnRef.turnIds[0])} for ${formatWorkedFor(turnRef.endedAt - turnRef.startedAt)}`}
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

/**
 * The turn's activity, every item as the agent chat's turn draws it: its
 * activity groups, and the subagents and segments the timeline lifts out of
 * them (background commands, managed shells, artifacts, messages to other
 * agents, errors, questions). Its prose is left out: that is the reply the
 * channel already shows. A tool the session still runs in the background
 * reads as running, as it does in the agent chat. Nothing here acts on the
 * turn: no next-step chips, fork or recovery, which belong to the session's
 * own chat.
 */
function TurnActivity(props: {
  readonly rows: ReadonlyArray<ChatMessage>;
  readonly backgroundItems: ChatSessionState["backgroundItems"];
  readonly instanceId: string;
}): ReactNode {
  const { rows, backgroundItems, instanceId } = props;
  // Thinking hidden leaves the reasoning out, as the agent chat does, unless
  // the layout editor points at it.
  const thinkingShown = useRegionShown("thinking");
  const thinkingGhost = useRegionGhost("thinking");
  const running = rows.some((row) => row.runState !== null);
  const backgroundToolBlockIds = useMemo<ReadonlySet<string>>(() => {
    if (backgroundItems === undefined || backgroundItems.length === 0) {
      return NO_BACKGROUND_TOOL_BLOCK_IDS;
    }
    return new Set(
      backgroundItems
        .filter((item) => item.kind !== "subagent")
        .map((item) => item.blockId),
    );
  }, [backgroundItems]);
  const timeline = useMemo(
    () =>
      activityItemsOf(
        buildChatActivityTimeline(
          rows.flatMap((row) => row.segments),
          {
            turnState: running ? "active" : "complete",
            promotedToolBlockIds: backgroundToolBlockIds,
            hideReasoning: !(thinkingShown || thinkingGhost),
          },
        ),
      ),
    [backgroundToolBlockIds, rows, running, thinkingGhost, thinkingShown],
  );
  const keys = useMemo(
    () =>
      distinctRenderKeys(
        timeline.map((item) => ({
          id: item.id,
          kind: item.kind === "segment" ? item.segment.kind : item.kind,
        })),
      ),
    [timeline],
  );
  return (
    <ChatFindForceStoreProvider tileInstanceId={instanceId}>
      <ChatOpenStoreScopeProvider value={instanceId}>
        <A2AOpenStoreProvider store={null}>
          <ActivityGroupOpenStoreProvider store={null}>
            <div
              className="flex flex-col gap-2"
              data-testid="bot-turn-activity"
            >
              {timeline.map((item, index) => {
                const key = keys[index];
                if (item.kind === "activity_group") {
                  return <ActivityGroupSegment key={key} group={item.group} />;
                }
                if (item.kind === "promoted_subagent") {
                  return (
                    <PromotedSubagentItem
                      key={key}
                      id={item.id}
                      segment={item.segment}
                    />
                  );
                }
                return (
                  <ChatBlockNavigationAnchor key={key} blockId={item.id}>
                    <AssistantSegment
                      id={item.id}
                      segment={item.segment}
                      backgroundToolBlockIds={backgroundToolBlockIds}
                      nextStepActions={null}
                      forkAction={null}
                      interviewDeliveryRetry={null}
                      harnessId={null}
                      turnId={null}
                      settledNotice={null}
                      settledNoticeFindUnitId={null}
                      backgroundCard={null}
                    />
                  </ChatBlockNavigationAnchor>
                );
              })}
            </div>
          </ActivityGroupOpenStoreProvider>
        </A2AOpenStoreProvider>
      </ChatOpenStoreScopeProvider>
    </ChatFindForceStoreProvider>
  );
}

/** A turn's timeline without its plain prose; a browser session's row stays. */
function activityItemsOf(
  timeline: ReadonlyArray<ChatActivityTimelineItem>,
): ReadonlyArray<ChatActivityTimelineItem> {
  return timeline.filter(
    (item) =>
      item.kind !== "segment" ||
      item.segment.kind !== "text" ||
      item.segment.browserSession !== undefined,
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
  const key = `${turnRef.turnIds.join("\n")}\n${turnRef.userMessageId}`;
  const cached = byTurn.get(key);
  if (cached !== undefined) return cached;
  let start: number | null = null;
  const rows: number[] = [];
  for (let ordinal = 0; ordinal < skeleton.length; ordinal += 1) {
    const entry = skeleton[ordinal];
    if (entry === undefined) continue;
    if (entry.rowId === turnRef.userMessageId) start = ordinal;
    else {
      const turnKey = assistantRowTurnKey(entry.rowId);
      if (turnKey !== null && turnRef.turnIds.includes(turnKey)) {
        rows.push(ordinal);
      }
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
 * as long as the panel shows the turn. Returns whether hydrating can bring
 * no more of the turn's rows: the transcript is not windowed (every row is
 * here), the host said the session has no such message, the rows the
 * skeleton names are hydrated, or the whole skeleton is in and names none.
 */
function useHydrateTurn(input: {
  readonly handle: ChatSessionStoreHandle;
  readonly botId: string;
  readonly turnRef: BotTurnRef;
  readonly windowed: boolean;
  readonly transcriptWindow: ChatSessionState["transcriptWindow"];
}): boolean {
  const { handle, botId, turnRef, windowed, transcriptWindow } = input;
  const { skeleton, epoch, spans, skeletonComplete } = transcriptWindow;
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
  if (!windowed || answer.status === "missing") return true;
  if (known.rows.length > 0) {
    return known.rows.every((ordinal) => isHydrated(spans, ordinal));
  }
  return skeletonComplete;
}

function isHydrated(
  spans: ReadonlyArray<HydratedSpan>,
  ordinal: number,
): boolean {
  return spans.some(
    (span) =>
      ordinal >= span.fromOrdinal &&
      ordinal < span.fromOrdinal + span.rowIds.length,
  );
}
