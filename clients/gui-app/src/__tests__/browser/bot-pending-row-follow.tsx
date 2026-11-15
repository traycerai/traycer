import { useState, useSyncExternalStore, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { ChatMessages } from "@/components/chat/chat-messages";
import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import {
  ChatBotPresentationContext,
  type ChatBotPresentation,
} from "@/components/chat/chat-bot-presentation-context";
import { useSubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import "@/index.css";

/**
 * A BOT'S CHANNEL WITH THE MEMBER'S OWN PENDING ROW (Tracy Bots T249).
 *
 * The real `ChatMessages` list over a long channel of member posts. The
 * fixture plays the transcript the app builds: the pending row is a member
 * row appended after the session's rows, and the host's stored row has the
 * SAME id and sits where the host wrote it, possibly with a teammate's row
 * after it. `window.__pendingDriver` appends, stores and probes; nothing of
 * the list's follow or anchor behaviour is reimplemented here.
 */
const NO_REWRITTEN: ReadonlySet<string> = new Set();
const PENDING_ID = "conversation-request:pending-1";
const PENDING_TEXT = "PENDING-OWN-ROW the nightly is green?";

const PRESENTATION: ChatBotPresentation = {
  botTitle: "Release Bot",
  threadLine: null,
  openThread: null,
  openAnnouncementThread: null,
  threadAnchorKinds: [],
  chooseOption: null,
  reply: null,
  questions: null,
  failedRequest: null,
  failedRecovery: null,
  replyReceipt: null,
  requestReceipt: null,
};

function post(id: string, text: string, minute: number): ChatMessageModel {
  return {
    ...makeMessage(minute, "user"),
    createdAt: 1_000_000 + minute * 60_000,
    persistentMessageId: id,
    senderLabel: "Tess Teammate",
    senderUserId: "user-teammate",
    content: text,
    segments: [
      { id: `${id}:text`, kind: "text", markdown: text, isStreaming: false },
    ],
  };
}

const EARLIER: ReadonlyArray<ChatMessageModel> = Array.from(
  { length: 40 },
  (_unused, index) =>
    post(
      `post-${String(index)}`,
      `Earlier post ${String(index)}: a line long enough to take real height in the channel column.`,
      index,
    ),
);

interface PendingDriver {
  ready: boolean;
  /** The person pressed Send: the pending row is appended after the rows. */
  appendPending: () => void;
  /** The host's row arrives (same id), with a teammate's row after it. */
  storeBeforeLateRow: () => void;
  probe: () => {
    readonly scrollTop: number;
    readonly scrollHeight: number;
    readonly clientHeight: number;
    readonly distance: number;
    readonly rowsWithPendingText: number;
    readonly pendingTop: number | null;
    readonly anchorId: string | null;
    readonly anchorTop: number | null;
  };
}

interface DriverWindow extends Window {
  __pendingDriver?: PendingDriver;
}
const driverWindow: DriverWindow = window;

let messages: ReadonlyArray<ChatMessageModel> = EARLIER;
const listeners = new Set<() => void>();
function setMessages(next: ReadonlyArray<ChatMessageModel>): void {
  messages = next;
  for (const listener of listeners) listener();
}

function scrollNode(): HTMLElement {
  const node = document.querySelector<HTMLElement>(
    '[data-testid="chat-messages-scroll"]',
  );
  if (node === null) throw new Error("the list has no scroll node");
  return node;
}

/** The first row whose top is at or below the scroll node's top: what the reader is looking at. */
function anchorRow(): HTMLElement | null {
  const top = scrollNode().getBoundingClientRect().top;
  for (const row of document.querySelectorAll<HTMLElement>(
    '[data-testid="bot-member-row"]',
  )) {
    if (row.getBoundingClientRect().top >= top) return row;
  }
  return null;
}

const driver: PendingDriver = {
  ready: false,
  appendPending: () => {
    setMessages([...EARLIER, post(PENDING_ID, PENDING_TEXT, 100)]);
  },
  storeBeforeLateRow: () => {
    setMessages([
      ...EARLIER,
      post(PENDING_ID, PENDING_TEXT, 100),
      post("post-late", "A teammate wrote after it.", 101),
    ]);
  },
  probe: () => {
    const node = scrollNode();
    const anchor = anchorRow();
    const pending = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="bot-member-row"]'),
    ).filter((row) => row.textContent.includes("PENDING-OWN-ROW"));
    return {
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      distance: node.scrollHeight - node.clientHeight - node.scrollTop,
      rowsWithPendingText: pending.length,
      pendingTop: pending.at(0)?.getBoundingClientRect().top ?? null,
      anchorId: anchor?.textContent ?? null,
      anchorTop: anchor?.getBoundingClientRect().top ?? null,
    };
  },
};

driverWindow.__pendingDriver = driver;

export function Channel(): ReactElement {
  const subagentDrillIn = useSubagentDrillIn(true);
  const rows = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => messages,
  );
  const [ready] = useState(() => {
    queueMicrotask(() => {
      driver.ready = true;
    });
    return true;
  });
  void ready;
  return (
    <TooltipProvider>
      <ChatBotPresentationContext.Provider value={PRESENTATION}>
        <div className="flex h-screen min-h-0 w-full flex-col bg-background text-foreground">
          <ChatMessages
            taskTitle="Release Bot"
            taskId="channel-pending"
            epicId="bot-pending"
            hostId={null}
            messages={rows}
            transcriptWindow={null}
            onVisibleOrdinalRangeChange={() => undefined}
            onFindReadOrdinalChange={() => undefined}
            baselineEpoch={0}
            hydrationSequence={0}
            coldRewrittenMessageIds={NO_REWRITTEN}
            backgroundItems={[]}
            getMessageActions={() => null}
            nextStepActions={null}
            instanceId="bot-pending-row-follow"
            visible
            systemOverlayActive={false}
            scrollRequest={null}
            onScrollRequestSettled={() => undefined}
            composerOverlayHeight={0}
            subagentDrillIn={subagentDrillIn}
          />
        </div>
      </ChatBotPresentationContext.Provider>
    </TooltipProvider>
  );
}

const container = document.getElementById("root");
if (container !== null) createRoot(container).render(<Channel />);
