import { useEffect, useMemo, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatMessages,
  type ChatMessageScrollRequest,
  type ChatScrollRequestOutcome,
} from "@/components/chat/chat-messages";
import { useSubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
  ChatMessage as ChatMessageModel,
  MessageSegment,
} from "@/stores/composer/chat-store";
import type { OrdinalRange } from "@/stores/chats/transcript-window";
import "@/index.css";

const TURN_ID = "streaming-turn-parts";
const HISTORY_COUNT = 18;
const EMPTY_REWRITTEN_IDS: ReadonlySet<string> = new Set();

interface Geometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrollMode: string | null;
}

interface TurnPartsProbe {
  readonly ready: boolean;
  readonly appendPart: () => void;
  readonly currentLastPartKey: () => string;
  readonly geometry: () => Geometry | null;
}

declare global {
  interface Window {
    __turnParts?: TurnPartsProbe;
  }
}

function assistantTextSegment(
  id: string,
  markdown: string,
): Extract<MessageSegment, { kind: "text" }> {
  return { id, kind: "text", markdown, isStreaming: true };
}

function streamedBody(partIndex: number, revision: string): string {
  const sentence = `Part ${String(partIndex)} ${revision}: the assistant keeps writing while the chat reader holds a stable place in the transcript.`;
  const paragraph = Array.from({ length: 18 }, () => sentence).join(" ");
  return Array.from({ length: 3 }, () => paragraph).join("\n\n");
}

function message(input: {
  readonly id: string;
  readonly role: ChatMessageModel["role"];
  readonly content: string;
  readonly segments: ReadonlyArray<MessageSegment>;
  readonly createdAt: number;
}): ChatMessageModel {
  return {
    id: input.id,
    role: input.role,
    content: input.content,
    segments: input.segments,
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: input.createdAt,
    completedAt: null,
    showCompletionFooter: false,
    stopped: null,
    persistentMessageId: null,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}

function ChatMessagesHarness({
  messages,
}: {
  readonly messages: ReadonlyArray<ChatMessageModel>;
}): ReactElement {
  const subagentDrillIn = useSubagentDrillIn(true);
  const onVisibleOrdinalRangeChange = (_range: OrdinalRange | null): void =>
    undefined;
  const onFindReadOrdinalChange = (_ordinal: number | null): void => undefined;
  const scrollRequest: ChatMessageScrollRequest | null = null;
  const onScrollRequestSettled = (
    _requestId: number,
    _outcome: ChatScrollRequestOutcome,
  ): void => undefined;

  return (
    <ChatMessages
      taskTitle="Turn part stream"
      taskId="turn-part-stream-chat"
      epicId="turn-part-stream-epic"
      hostId={null}
      messages={messages}
      transcriptWindow={null}
      onVisibleOrdinalRangeChange={onVisibleOrdinalRangeChange}
      onFindReadOrdinalChange={onFindReadOrdinalChange}
      baselineEpoch={0}
      hydrationSequence={0}
      coldRewrittenMessageIds={EMPTY_REWRITTEN_IDS}
      backgroundItems={[]}
      getMessageActions={() => null}
      nextStepActions={null}
      instanceId="turn-part-stream-instance"
      visible
      systemOverlayActive={false}
      scrollRequest={scrollRequest}
      onScrollRequestSettled={onScrollRequestSettled}
      composerOverlayHeight={0}
      subagentDrillIn={subagentDrillIn}
    />
  );
}

function readGeometry(): Geometry | null {
  const node = document.querySelector<HTMLElement>(
    '[data-testid="chat-messages-scroll"]',
  );
  if (node === null) return null;
  return {
    scrollTop: node.scrollTop,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    scrollMode: node.dataset.scrollMode ?? null,
  };
}

export function Harness(): ReactElement {
  const history = useMemo(
    () =>
      Array.from({ length: HISTORY_COUNT }, (_unused, index) =>
        message({
          id: `history-${String(index)}`,
          role: "user",
          content: `Earlier chat message ${String(index)}.`,
          segments: [],
          createdAt: index,
        }),
      ),
    [],
  );
  const [segments, setSegments] = useState<ReadonlyArray<MessageSegment>>(() =>
    Array.from({ length: 3 }, (_unused, index) =>
      assistantTextSegment(
        `text-${String(index)}`,
        streamedBody(index, "initial"),
      ),
    ),
  );
  const assistant = useMemo(
    () =>
      message({
        id: TURN_ID,
        role: "assistant",
        content: "",
        segments,
        createdAt: HISTORY_COUNT,
      }),
    [segments],
  );
  const messages = useMemo(() => [...history, assistant], [assistant, history]);

  useEffect(() => {
    window.__turnParts = {
      ready: true,
      appendPart: () => {
        setSegments((current) => {
          const partIndex = current.length;
          const last = current.at(-1);
          if (last === undefined || last.kind !== "text") return current;
          const grown = {
            ...last,
            markdown: `${last.markdown}\n\n${streamedBody(partIndex - 1, "continued")}`,
          };
          return [
            ...current.slice(0, -1),
            grown,
            assistantTextSegment(
              `text-${String(partIndex)}`,
              streamedBody(partIndex, "appended"),
            ),
          ];
        });
      },
      currentLastPartKey: () =>
        segments.length === 1
          ? TURN_ID
          : `${TURN_ID}#text-${String(segments.length - 1)}`,
      geometry: readGeometry,
    };
    return () => {
      delete window.__turnParts;
    };
  }, [segments]);

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 w-full flex-col">
        <ChatMessagesHarness messages={messages} />
      </div>
    </TooltipProvider>
  );
}

const container = document.getElementById("root");
if (container !== null) createRoot(container).render(<Harness />);
