import { useState, type ReactNode } from "react";
import { ChevronLeft, X } from "lucide-react";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotMemory,
  BotMemoryEntry,
  BotMemoryTagUsage,
} from "@traycer/protocol/host/bot/schemas";
import { conversationRequestMessageId } from "@traycer/protocol/persistence/epic/messages";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChannelPost } from "@/components/bots/bot-channel-post";
import { BotReadFailure } from "@/components/bots/bot-read-failure";
import {
  useBotMemory,
  type BotMemoryReading,
} from "@/hooks/bots/use-bot-memory";
import {
  confirmedSinceWritten,
  fullnessOf,
  initialMemoryMarks,
  memorySections,
  nextMemoryMarks,
  type MemoryMarks,
} from "@/lib/bots/bot-memory-model";
import { firstLineOf } from "@/lib/bots/bot-trunk-model";
import { postTextOf } from "@/lib/bots/reply-row";
import { useMessageTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";

/** Where an entry's "where" link takes the person. */
export interface BotMemoryNavigation {
  /** Opens the thread hung off this channel post, in the rail's slot. */
  readonly openThread: (anchorMessageId: string) => void;
  /** Shows the channel, on this message when one is named. */
  readonly showInChannel: (messageId: string | null) => void;
}

export interface BotMemoryPanelProps {
  readonly botId: string;
  readonly hostId: string;
  readonly environmentId: string;
  readonly botTitle: string;
  readonly channelId: string;
  readonly trunkChatId: string;
  /** The bot's threads, to find the one an entry was written in; `null` while unread. */
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
  /** Another bot of the environment by its id, for a shared entry's writer. */
  readonly botNameOf: (botId: string) => string | null;
  readonly back: BotOpenThread | null;
  /** Brings back the thread the pane displaced; `null` when it displaced none. */
  readonly onBack: (() => void) | null;
  readonly onClose: () => void;
  readonly navigation: BotMemoryNavigation;
}

/**
 * "What Tracy knows" (Tracy Bots T87, decision 119): the entries the bot
 * reads before every reply, in the rail beside its channel, read-only - a
 * person changes one by telling the bot. Its own entries newest-confirmed
 * first, each with when and where it was written and when it was last
 * confirmed; the ones shared with every bot below, with the bot that wrote
 * each; a find box; and how full its own memory is. Live: an entry written
 * while the pane is open is marked new. It takes the rail's one slot, a thread included, whose crumb in
 * the header brings it back.
 */
export function BotMemoryPanel(props: BotMemoryPanelProps): ReactNode {
  const { botId, hostId, environmentId, botTitle } = props;
  const reading = useBotMemory({
    hostId,
    botId,
    environmentId,
    enabled: true,
  });
  return (
    <section
      aria-label={`What ${botTitle} knows`}
      data-testid="bot-memory-panel"
      className="flex min-h-0 flex-1 flex-col"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2.5">
        {props.onBack === null ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back to the thread"
            data-testid="bot-memory-back"
            onClick={props.onBack}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate text-ui-md font-semibold text-foreground">
            {`What ${botTitle} knows`}
          </h2>
          {props.back === null || props.onBack === null ? null : (
            <span className="flex min-w-0 text-ui-xs text-muted-foreground">
              <ThreadCrumb
                botId={botId}
                hostId={hostId}
                channelId={props.channelId}
                anchorMessageId={props.back.anchorMessageId}
                onBack={props.onBack}
              />
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          data-testid="bot-memory-close"
          onClick={props.onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      <MemoryBody {...props} reading={reading} />
    </section>
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
            data-testid="bot-memory-crumb"
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

/** The pane under its header, as the reading stands. */
function MemoryBody(
  props: BotMemoryPanelProps & { readonly reading: BotMemoryReading },
): ReactNode {
  const { reading, botTitle } = props;
  switch (reading.kind) {
    case "ready":
      return <MemoryList {...props} memory={reading.memory} />;
    case "failed":
      return (
        <div className="p-4">
          <BotReadFailure
            message={`Couldn't load what ${botTitle} knows.`}
            onRetry={reading.retry}
            testId="bot-memory-error"
          />
        </div>
      );
    case "unsupported":
      return (
        <p
          role="status"
          className="m-4 text-ui-sm text-muted-foreground"
          data-testid="bot-memory-unsupported"
        >
          {`What ${botTitle} knows can't be shown here.`}
        </p>
      );
    case "loading":
      return (
        <div
          className="flex flex-1 items-center justify-center py-10 text-muted-foreground"
          aria-busy="true"
          data-testid="bot-memory-loading"
        >
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        </div>
      );
  }
}

type ListProps = BotMemoryPanelProps & {
  readonly memory: BotMemory;
};

function MemoryList(props: ListProps): ReactNode {
  const { memory, botId, botTitle } = props;
  const [query, setQuery] = useState("");
  const marks = useMemoryMarks(memory.entries);
  const { own, shared } = memorySections(memory, botId, query);
  const searching = query.trim().length > 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <p className="px-4 pt-3 text-ui-xs text-muted-foreground">
        {`${botTitle} wrote these and reads them before every reply. To change one, tell ${botTitle} in the channel.`}
      </p>
      <div className="px-4 pt-3">
        <Input
          type="search"
          value={query}
          placeholder="Find in memories"
          aria-label="Find in memories"
          data-testid="bot-memory-find"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <MemorySection
        title={`${botTitle}'s own`}
        note={null}
        count={own.length}
        testId="bot-memory-own"
      >
        {own.length === 0 ? (
          <EmptyLine
            text={
              searching
                ? "No memory matches."
                : `${botTitle} hasn't remembered anything yet.`
            }
          />
        ) : (
          own.map((entry) => (
            <MemoryRow
              key={entry.id}
              {...props}
              entry={entry}
              marks={marks}
              shared={false}
            />
          ))
        )}
      </MemorySection>
      {shared.length === 0 && searching ? null : (
        <MemorySection
          title="Shared with every bot"
          note="tidied by the main bot"
          count={shared.length}
          testId="bot-memory-shared"
        >
          {shared.length === 0 ? (
            <EmptyLine text="Nothing shared yet." />
          ) : (
            shared.map((entry) => (
              <MemoryRow
                key={entry.id}
                {...props}
                entry={entry}
                marks={marks}
                shared
              />
            ))
          )}
        </MemorySection>
      )}
      <MemoryMeter botTitle={botTitle} usage={memory.own} />
    </div>
  );
}

/**
 * The marks of the entries the pane has seen change since it opened, moved
 * on as each reading arrives.
 */
function useMemoryMarks(entries: readonly BotMemoryEntry[]): MemoryMarks {
  const [state, setState] = useState(() => ({
    entries,
    marks: initialMemoryMarks(entries),
  }));
  if (state.entries !== entries) {
    const next = { entries, marks: nextMemoryMarks(state.marks, entries) };
    setState(next);
    return next.marks;
  }
  return state.marks;
}

function MemorySection(props: {
  readonly title: string;
  readonly note: string | null;
  readonly count: number;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section
      aria-label={props.title}
      data-testid={props.testId}
      className="pt-4"
    >
      <h3 className="flex items-baseline gap-2 px-4 pb-1 text-ui-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {props.title}
        <span className="font-normal tracking-normal normal-case">
          {props.note === null ? props.count : `${props.count} · ${props.note}`}
        </span>
      </h3>
      <ul className="flex flex-col">{props.children}</ul>
    </section>
  );
}

function EmptyLine(props: { readonly text: string }): ReactNode {
  return (
    <li className="border-t border-border/60 px-4 py-2 text-ui-sm text-muted-foreground">
      {props.text}
    </li>
  );
}

/**
 * One entry: its text, then when it was confirmed and when and where it was
 * written - or that it was never confirmed since - and for a shared entry
 * the bot that wrote it. An entry written while the pane is open says it is
 * new.
 */
function MemoryRow(
  props: ListProps & {
    readonly entry: BotMemoryEntry;
    readonly marks: MemoryMarks;
    readonly shared: boolean;
  },
): ReactNode {
  const { entry, marks } = props;
  const isNew = marks.added.has(entry.id);
  const writer = props.shared ? writerOf(props, entry.writtenBy.botId) : null;
  return (
    <li
      data-testid="bot-memory-entry"
      data-entry-id={entry.id}
      data-new={isNew ? "true" : undefined}
      className={cn(
        "border-t border-border/60 px-4 py-2 text-ui-sm",
        isNew && "bg-foreground/5",
      )}
    >
      <p className="break-words whitespace-pre-wrap text-foreground">
        {entry.text}
      </p>
      <p
        className="mt-0.5 text-ui-xs text-muted-foreground"
        data-testid="bot-memory-entry-meta"
      >
        {isNew ? (
          <span className="font-semibold text-primary">New · </span>
        ) : null}
        {!isNew &&
        confirmedSinceWritten(entry) &&
        entry.confirmedAt !== null ? (
          <>
            <Stamp prefix="Confirmed " at={entry.confirmedAt} />
            {" · "}
            <Stamp prefix="written " at={entry.at} />
          </>
        ) : (
          <Stamp prefix="Written " at={entry.at} />
        )}
        {writer === null ? null : ` by ${writer}`}
        <EntryWhere {...props} />
        {isNew || confirmedSinceWritten(entry)
          ? null
          : " · never confirmed since"}
      </p>
    </li>
  );
}

/** The bot that wrote a shared entry, by name; `null` when none is known. */
function writerOf(props: ListProps, botId: string | null): string | null {
  if (botId === null) return null;
  return botId === props.botId ? props.botTitle : props.botNameOf(botId);
}

/** "Oct 23, 3:12 PM" after its prefix, or that the time is unknown. */
function Stamp(props: {
  readonly prefix: string;
  readonly at: number | null;
}): ReactNode {
  if (props.at === null) return `${props.prefix}at an unknown time`;
  return <KnownStamp prefix={props.prefix} at={props.at} />;
}

function KnownStamp(props: {
  readonly prefix: string;
  readonly at: number;
}): ReactNode {
  const time = useMessageTime(props.at);
  return `${props.prefix}${time}`;
}

/**
 * Where the bot learned the entry, as a link there: the member's post it was
 * answering in the channel, the thread it was written in, or the channel
 * when the post is unknown; a shared entry's too, when this bot wrote it.
 * Nothing for a chat this bot no longer has, or another bot's.
 */
function EntryWhere(
  props: ListProps & { readonly entry: BotMemoryEntry },
): ReactNode {
  const { entry, navigation } = props;
  const { chatId, requestId } = entry.writtenBy;
  if (chatId === null || entry.writtenBy.botId !== props.botId) return null;
  if (chatId === props.trunkChatId) {
    if (requestId === null) {
      return (
        <WhereLink
          label="in the channel"
          onClick={() => navigation.showInChannel(null)}
        />
      );
    }
    const messageId = conversationRequestMessageId(requestId);
    return (
      <ChannelPost
        botId={props.botId}
        hostId={props.hostId}
        conversationId={props.channelId}
        messageId={messageId}
        fetchCold={false}
      >
        {(post) => {
          const line = firstLineOf(postTextOf(post));
          return (
            <WhereLink
              label={
                line === null
                  ? "from a message in the channel"
                  : `from "${line}"`
              }
              onClick={() => navigation.showInChannel(messageId)}
            />
          );
        }}
      </ChannelPost>
    );
  }
  const thread =
    props.threads?.find((candidate) => candidate.sessionChatId === chatId) ??
    null;
  const anchor = thread?.anchor ?? null;
  if (anchor === null) return null;
  return (
    <ChannelPost
      botId={props.botId}
      hostId={props.hostId}
      conversationId={props.channelId}
      messageId={anchor.messageId}
      fetchCold={false}
    >
      {(post) => {
        const line = firstLineOf(postTextOf(post));
        return (
          <WhereLink
            label={line === null ? "in a thread" : `in thread "${line}"`}
            onClick={() => navigation.openThread(anchor.messageId)}
          />
        );
      }}
    </ChannelPost>
  );
}

function WhereLink(props: {
  readonly label: string;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <>
      {" "}
      <button
        type="button"
        data-testid="bot-memory-where"
        onClick={props.onClick}
        className="max-w-full truncate rounded-sm align-bottom text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      >
        {props.label}
      </button>
    </>
  );
}

/**
 * How full the bot's own memory is, as a meter and in words, and the one
 * sentence on what happens when it fills.
 */
function MemoryMeter(props: {
  readonly botTitle: string;
  readonly usage: BotMemoryTagUsage;
}): ReactNode {
  const { botTitle, usage } = props;
  const fullness = fullnessOf(usage);
  const over = usage.chars > usage.ceiling;
  const percent = Math.round(Math.min(1, usage.chars / usage.ceiling) * 100);
  const count =
    fullness === null ? "none yet." : `${usage.entries}, ${fullness}.`;
  return (
    <div className="mt-auto flex flex-col gap-1.5 px-4 pt-4 pb-3">
      <div
        role="meter"
        aria-label={`${botTitle}'s own memories`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        data-testid="bot-memory-meter"
        className="h-1 w-full overflow-hidden rounded-full bg-foreground/10"
      >
        <div
          className={cn("h-full", over ? "bg-warning" : "bg-primary")}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p
        className="text-ui-xs text-muted-foreground"
        data-testid="bot-memory-meter-line"
      >
        {`${botTitle}'s own memories: ${count} When it fills, ${botTitle} is asked to tidy them, removing the ones that no longer hold; nothing is dropped on its own.`}
      </p>
    </div>
  );
}
