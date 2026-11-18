import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatMessages } from "@/components/chat/chat-messages";
import { useSubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import type { ChatMessage } from "@/stores/composer/chat-store";
import {
  emptyTranscriptWindow,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";
import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import "@/index.css";

type Phase = "unnamed" | "named-past-row-count";

const SPAN_ROWS = 3;
const WORKING_ROW_ID = "assistant:turn-x";

const SPAN_MESSAGES: ReadonlyArray<ChatMessage> = Array.from(
  { length: SPAN_ROWS },
  (_unused, index) => {
    const id = `message-${index}`;
    return {
      ...makeMessage(index, "user"),
      persistentMessageId: id,
    };
  },
);
const WORKING_ROW: ChatMessage = {
  ...makeMessage(SPAN_ROWS, "assistant"),
  id: WORKING_ROW_ID,
  statusLabel: "Streaming",
  runState: "running",
};
const MESSAGES: ReadonlyArray<ChatMessage> = [...SPAN_MESSAGES, WORKING_ROW];

function skeletonEntry(rowId: string, index: number) {
  return {
    rowId,
    role: rowId === WORKING_ROW_ID ? ("assistant" as const) : ("user" as const),
    createdAt: index,
    byteLength: 100,
    bodyDigest: `digest-${index}`,
  };
}

function windowFor(phase: Phase): TranscriptWindow {
  const rowIds = SPAN_MESSAGES.map((message) => message.id);
  const skeletonIds =
    phase === "unnamed" ? rowIds : [...rowIds, WORKING_ROW_ID];
  return {
    ...emptyTranscriptWindow(),
    rowCount: SPAN_ROWS,
    skeleton: skeletonIds.map(skeletonEntry),
    skeletonComplete: false,
    skeletonStreamCoveredThrough: 0,
    spans: [
      {
        fromOrdinal: 0,
        rowIds,
        rowContext: {},
        messageIds: [],
        eventIds: [],
        contextBytes: 0,
      },
    ],
    staleSpans: [],
    invalidated: false,
  };
}
const WINDOWS: Record<Phase, TranscriptWindow> = {
  unnamed: windowFor("unnamed"),
  "named-past-row-count": windowFor("named-past-row-count"),
};

export function Fixture() {
  const [phase, setPhase] = useState<Phase>("unnamed");
  const subagentDrillIn = useSubagentDrillIn(true);
  useLayoutEffect(() => {
    window.__workingRowTailProbe = { setPhase };
  }, []);
  return (
    <div className="flex h-full w-full flex-col">
      <div>Phase: {phase}</div>
      <div className="min-h-0 flex-1">
        <ChatMessages
          taskTitle="Working row tail probe"
          taskId="windowed-working-row-tail"
          epicId="windowed-working-row-tail"
          hostId={null}
          payerHostId={null}
          messages={MESSAGES}
          transcriptWindow={WINDOWS[phase]}
          onVisibleOrdinalRangeChange={() => undefined}
          onFindReadOrdinalChange={() => undefined}
          baselineEpoch={0}
          hydrationSequence={0}
          coldRewrittenMessageIds={new Set()}
          backgroundItems={undefined}
          getMessageActions={() => null}
          nextStepActions={null}
          instanceId="windowed-working-row-tail"
          visible
          systemOverlayActive={false}
          scrollRequest={null}
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
    __workingRowTailProbe: {
      setPhase: (phase: Phase) => void;
    };
  }
}

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(<Fixture />);
