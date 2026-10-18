import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatMessages,
  type ChatMessageScrollRequest,
} from "@/components/chat/chat-messages";
import { useSubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import type { ChatMessage } from "@/stores/composer/chat-store";
import {
  emptyTranscriptWindow,
  type HydratedSpan,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";
import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import "@/index.css";

const TOTAL_ROWS = 600;
const EDITED_ROW = 584;
const HYDRATED_FROM = EDITED_ROW - 15;
const ORIGINAL_MESSAGES = Array.from(
  { length: EDITED_ROW - HYDRATED_FROM + 1 },
  (_unused, offset) => {
    const index = HYDRATED_FROM + offset;
    const id = `message-${index}`;
    const role = index % 2 === 0 ? "user" : "assistant";
    const message = makeMessage(index, role);
    return {
      ...message,
      content:
        role === "user"
          ? `User message ${index}. `.repeat(index % 5 === 0 ? 24 : 2)
          : "",
      segments:
        role === "assistant"
          ? [
              {
                id: `${id}:text`,
                kind: "text" as const,
                markdown: `Assistant message ${index}. `.repeat(400),
                isStreaming: false,
              },
            ]
          : [],
      persistentMessageId: id,
    };
  },
);
const EDITED_MESSAGE: ChatMessage = {
  ...makeMessage(EDITED_ROW, "user"),
  id: "edited-message",
  content: "Edited message",
  persistentMessageId: "edited-message",
};
const REINDEXED_MESSAGES = ORIGINAL_MESSAGES.slice(0, -1);
const HYDRATED_MESSAGES = [...REINDEXED_MESSAGES, EDITED_MESSAGE];

function messagesFor(
  phase: "initial" | "reindexed" | "hydrated",
): ReadonlyArray<ChatMessage> {
  if (phase === "initial") return ORIGINAL_MESSAGES;
  if (phase === "reindexed") return REINDEXED_MESSAGES;
  return HYDRATED_MESSAGES;
}

function spanFor(messages: ReadonlyArray<ChatMessage>): HydratedSpan {
  return {
    fromOrdinal: HYDRATED_FROM,
    rowIds: messages.map((message) => message.id),
    rowContext: {},
    messageIds: [],
    eventIds: [],
    contextBytes: 0,
  };
}

function windowFor(
  phase: "initial" | "reindexed" | "hydrated",
): TranscriptWindow {
  let rowCount = EDITED_ROW + 1;
  if (phase === "initial") rowCount = TOTAL_ROWS;
  if (phase === "reindexed") rowCount = EDITED_ROW;
  const span = spanFor(messagesFor(phase));
  return {
    ...emptyTranscriptWindow(),
    rowCount,
    skeleton: Array.from({ length: rowCount }, (_unused, index) => {
      if (phase === "reindexed" && index < HYDRATED_FROM) return undefined;
      const id =
        phase === "hydrated" && index === EDITED_ROW
          ? "edited-message"
          : `message-${index}`;
      return {
        rowId: id,
        role: index % 2 === 0 ? "user" : "assistant",
        createdAt: index,
        byteLength: 100,
        bodyDigest: `digest-${index}`,
      };
    }),
    skeletonComplete: phase !== "reindexed",
    skeletonStreamCoveredThrough: phase === "reindexed" ? 0 : rowCount,
    spans: phase === "reindexed" ? [] : [span],
    staleSpans: phase === "reindexed" ? [spanFor(REINDEXED_MESSAGES)] : [],
    invalidated: phase === "reindexed",
  };
}
const WINDOWS = {
  initial: windowFor("initial"),
  reindexed: windowFor("reindexed"),
  hydrated: windowFor("hydrated"),
};

export function Fixture() {
  const [phase, setPhase] = useState<"initial" | "reindexed" | "hydrated">(
    "initial",
  );
  const [scrollRequest, setScrollRequest] =
    useState<ChatMessageScrollRequest | null>(null);
  const nextScrollRequestId = useRef(0);
  const subagentDrillIn = useSubagentDrillIn(true);
  useLayoutEffect(() => {
    window.__windowedEditScrollProbe = {
      setPhase,
      issueEndRequest: () => {
        nextScrollRequestId.current += 1;
        setScrollRequest({
          kind: "end",
          requestId: nextScrollRequestId.current,
          animated: false,
        });
        return Promise.resolve();
      },
      scrollToEditedRow: () => {
        nextScrollRequestId.current += 1;
        setScrollRequest({
          kind: "message",
          messageId: "message-584",
          blockId: null,
          requestId: nextScrollRequestId.current,
        });
        return Promise.resolve();
      },
      snapshot: () => {
        const node = document.querySelector<HTMLElement>(
          '[data-testid="chat-messages-scroll"]',
        );
        return {
          phase,
          scrollTop: node?.scrollTop ?? null,
          scrollHeight: node?.scrollHeight ?? null,
          clientHeight: node?.clientHeight ?? null,
          visibleMessageIds: Array.from(
            document.querySelectorAll("[data-message-id]"),
          )
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              const parent = node?.getBoundingClientRect();
              return (
                parent !== undefined &&
                rect.bottom > parent.top &&
                rect.top < parent.bottom
              );
            })
            .map((element) => element.getAttribute("data-message-id")),
        };
      },
    };
  }, [phase]);
  return (
    <div className="flex h-full w-full flex-col">
      <div>Phase: {phase}</div>
      <div className="min-h-0 flex-1">
        <ChatMessages
          taskTitle="Windowed edit scroll probe"
          taskId="windowed-edit-scroll"
          epicId="windowed-edit-scroll"
          hostId={null}
          messages={messagesFor(phase)}
          transcriptWindow={WINDOWS[phase]}
          onVisibleOrdinalRangeChange={() => undefined}
          onFindReadOrdinalChange={() => undefined}
          baselineEpoch={0}
          hydrationSequence={0}
          coldRewrittenMessageIds={new Set()}
          backgroundItems={undefined}
          getMessageActions={() => null}
          nextStepActions={null}
          instanceId="windowed-edit-scroll"
          visible
          systemOverlayActive={false}
          scrollRequest={scrollRequest}
          onScrollRequestSettled={null}
          composerOverlayHeight={0}
          subagentDrillIn={subagentDrillIn}
        />
      </div>
    </div>
  );
}

declare global {
  interface Window {
    __windowedEditScrollProbe: {
      setPhase: (phase: "initial" | "reindexed" | "hydrated") => void;
      issueEndRequest: () => Promise<void>;
      scrollToEditedRow: () => Promise<void>;
      snapshot: () => {
        phase: string;
        scrollTop: number | null;
        scrollHeight: number | null;
        clientHeight: number | null;
        visibleMessageIds: (string | null)[];
      };
    };
  }
}

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(<Fixture />);
