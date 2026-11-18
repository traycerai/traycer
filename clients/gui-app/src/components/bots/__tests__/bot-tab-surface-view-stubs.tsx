/**
 * What `bot-tab-surface.test.tsx` and `bot-tab-surface-header.test.tsx` share
 * besides the mocked boundaries in `bot-tab-surface-mocks.tsx`: the stubs that
 * stand in for the views the surface draws (the channel sidebar, the channel,
 * the bot's session, the Activity page, Threads and the channel settings
 * panel), each exposing the props the surface passes it, named as the real
 * module's export. Each file mocks a view with
 * `vi.mock("<view path>", () => import("./bot-tab-surface-view-stubs"))`.
 * It must not import `@/components/bots/bot-tab-surface` or any of those view
 * modules at run time (`import type` is fine): a mock factory loads it while
 * those modules are loading, so a run-time import would wait on itself.
 */
import { useContext, type ReactNode } from "react";
import type { BotTurnRef } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotChannelLanding } from "@/components/bots/bot-channel-view";
import type { BotOpenSession } from "@/components/bots/bot-session-view";
import type {
  BotOpenMemory,
  BotOpenThread,
  BotTurnOpen,
} from "@/stores/bots/bot-open-thread-store";
import { BotMentionsContext } from "@/components/bots/bot-mentions-context";
import { BotReplyingStrip } from "@/components/bots/bot-replying-strip";
import { TracyPlaybackSlot } from "@/components/bots/tracy-playback-slot";
import { useBotActivity } from "@/hooks/bots/use-bot-activity";
import { KEYBOARD_FOCUS_OWNER_PROPS } from "@/hooks/ui/use-keyboard-focus-layout";

export function BotChannelSidebar(props: {
  activeBotId: string | null;
  hostId: string;
  threadsView: {
    shown: boolean;
    onShow: () => void;
    onLeave: () => void;
  } | null;
  onChannelOpened: () => void;
}): ReactNode {
  return (
    <div
      data-testid="stub-sidebar"
      data-active-bot-id={props.activeBotId ?? "none"}
      data-host-id={props.hostId}
      data-threads-shown={String(props.threadsView?.shown ?? "none")}
    >
      <button
        type="button"
        data-testid="stub-sidebar-pick"
        onClick={props.onChannelOpened}
      />
      <button
        type="button"
        data-testid="stub-sidebar-threads"
        onClick={props.threadsView?.onShow}
      />
      <button
        type="button"
        data-testid="stub-sidebar-own-channel"
        onClick={props.threadsView?.onLeave}
      />
    </div>
  );
}

/** What the tab hands its content to mention (`BotMentionsContext`), as the stub channel sees it. */
function MentionsProbe(): ReactNode {
  const mentionable = useContext(BotMentionsContext);
  if (mentionable === null) return null;
  return (
    <output
      data-testid="stub-mentionable"
      data-bots={
        mentionable.bots === null
          ? "unread"
          : mentionable.bots.map((target) => target.name).join("|")
      }
      data-tasks={mentionable.tasks.map((target) => target.name).join("|")}
    />
  );
}

/** The channel's real typing line, over the bot's real activity reading. */
function ReplyingStripProbe(props: {
  botId: string;
  botTitle: string;
}): ReactNode {
  return (
    <BotReplyingStrip
      botTitle={props.botTitle}
      activity={useBotActivity(props.botId)?.trunk ?? null}
      turn={null}
      testId="stub-replying-strip"
    />
  );
}

/** The trunk's turn behind a reply in the channel. */
const REPLY_TURN: BotTurnRef = {
  chatId: "trunk-1",
  turnIds: ["turn-reply"],
  userMessageId: "prompt-reply",
  threadId: null,
  startedAt: 1_000,
  endedAt: 2_000,
  summary: null,
  messageIds: ["reply-1"],
  requestIds: [],
};

export function BotChannelView(props: {
  botId: string;
  hostId: string;
  boundHostId: string | null;
  botTitle: string;
  appConversationChatId: string | null;
  openThread: BotOpenThread | null;
  landOn: BotChannelLanding | null;
  trunkChatId: string;
  openMemory: BotOpenMemory | null;
  onOpenMemory: (open: BotOpenMemory | null) => void;
  onOpenTurn: BotTurnOpen;
  resolveMember: (
    userId: string,
  ) => { displayName: string | null; avatarUrl: string | null } | null;
  setupHistory: ReactNode;
  tiles: number | null;
}): ReactNode {
  return (
    <div
      data-testid="stub-channel"
      data-tiles={String(props.tiles)}
      data-host-id={props.hostId}
      data-bound-host-id={props.boundHostId ?? "none"}
      data-bot-title={props.botTitle}
      data-app-conversation-chat-id={props.appConversationChatId ?? "none"}
      data-open-thread={props.openThread?.anchorMessageId ?? "none"}
      data-land-on={props.landOn?.messageId ?? "none"}
      data-land-on-thread={props.landOn?.threadId ?? "none"}
      data-open-memory={String(props.openMemory !== null)}
      data-trunk-chat-id={props.trunkChatId}
      data-teammate-name={
        props.resolveMember("user-teammate")?.displayName ?? "unresolved"
      }
    >
      <button
        type="button"
        data-testid="stub-channel-open-memory"
        onClick={() => props.onOpenMemory({ back: null, focus: null })}
      />
      <button
        type="button"
        data-testid="stub-channel-open-turn"
        onClick={() => props.onOpenTurn(REPLY_TURN, null)}
      />
      {props.setupHistory}
      <MentionsProbe />
      <ReplyingStripProbe botId={props.botId} botTitle={props.botTitle} />
      {/* The two boxes' places in the real view: the channel's own, and one
          inside the thread panel, which the header tells apart by its marker. */}
      <div {...KEYBOARD_FOCUS_OWNER_PROPS}>
        <textarea aria-label="Channel box" />
      </div>
      <section data-bot-thread-panel="">
        <div {...KEYBOARD_FOCUS_OWNER_PROPS}>
          <textarea aria-label="Thread box" />
        </div>
      </section>
    </div>
  );
}

// The session view is driven in `bot-session-view.test.tsx`; here, what the
// tab hands it and what its links do to the tab.
export function BotSessionView(props: {
  session: BotOpenSession;
  onClose: () => void;
  onOpenChannel: (messageId: string | null) => void;
  onOpenThread: (threadId: string, messageId: string | null) => void;
}): ReactNode {
  return (
    <div
      data-testid="stub-session"
      data-chat-id={props.session.chatId}
      data-thread-id={props.session.threadId ?? "none"}
      data-land-on={props.session.landOn?.messageId ?? "none"}
      data-visit={String(props.session.landOn?.visit ?? "none")}
    >
      {/* The real session view holds the tab's playback slot in its header. */}
      <header>
        <TracyPlaybackSlot />
      </header>
      <button
        type="button"
        data-testid="stub-session-back"
        onClick={props.onClose}
      />
      <button
        type="button"
        data-testid="stub-session-channel"
        onClick={() => props.onOpenChannel(null)}
      />
      <button
        type="button"
        data-testid="stub-session-post"
        onClick={() => props.onOpenChannel("post-1")}
      />
      <button
        type="button"
        data-testid="stub-session-thread"
        onClick={() => props.onOpenThread("thread-1", null)}
      />
      <button
        type="button"
        data-testid="stub-session-thread-post"
        onClick={() => props.onOpenThread("thread-1", "thread-reply-9")}
      />
    </div>
  );
}

// The Activity page takes whether this host runs the bot, and the list the
// tab's count is read from: its rows are what the page would draw.
export function BotActivityPage(props: {
  boundHere: boolean;
  active: { rows: ReadonlyArray<{ task: { taskId: string } }> };
}): ReactNode {
  return (
    <div
      data-testid="stub-activity"
      data-is-this-host={String(props.boundHere)}
      data-row-ids={props.active.rows.map((row) => row.task.taskId).join(",")}
    />
  );
}

export function BotThreadsView(props: {
  hostId: string;
  channelTitle: string;
  onBack: () => void;
}): ReactNode {
  return (
    <div
      data-testid="stub-threads"
      data-host-id={props.hostId}
      data-channel-title={props.channelTitle}
    >
      {/* The real view holds the tab's playback slot in its desktop header. */}
      <header data-testid="stub-threads-header">
        <TracyPlaybackSlot />
      </header>
      <button
        type="button"
        data-testid="stub-threads-back"
        onClick={props.onBack}
      />
    </div>
  );
}

// The panel takes the bot, whether its environment is a person's own, its
// channel, its environment's bots and how to close, and nothing else: no prop
// says which host serves the tab, so no control can be gated on it. The stub lists the props it was given.
export function BotChannelSettingsPanel(props: {
  personal: boolean;
  channelId: string | null;
  onClose: () => void;
  onDeleted: () => void;
}): ReactNode {
  return (
    <div
      data-testid="stub-settings"
      data-personal={String(props.personal)}
      data-channel-id={props.channelId ?? "none"}
    >
      <button
        type="button"
        data-testid="stub-settings-close"
        onClick={props.onClose}
      />
      <button
        type="button"
        data-testid="stub-settings-deleted"
        onClick={props.onDeleted}
      />
    </div>
  );
}
