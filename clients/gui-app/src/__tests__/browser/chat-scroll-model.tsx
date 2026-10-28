import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatMessages } from "@/components/chat/chat-messages";
import { useSubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import { TileMinimapScope } from "@/components/epic-canvas/tile-minimap/tile-minimap-scope";
import type { ChatMessage } from "@/stores/composer/chat-store";
import {
  peekSavedChatTabState,
  restoreChatTabStateForMount,
} from "@/stores/chats/chat-tab-state-cache";
import { flushChatTabViewportHandoff } from "@/stores/chats/chat-tab-viewport-handoff";
import { useTileMinimapStore } from "@/stores/tile-minimap";
import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import {
  EPIC_ID,
  setInstanceLive,
  TASK_ID,
  type HideKind,
} from "./chat-scroll-model-support";
import "@/index.css";

/**
 * The real `ChatMessages` on the legacy line, for the counterexamples of
 * `formal/ChatScroll.tla`. `window.__chatScrollProbe` streams into the last
 * reply, hides the tile the two ways production does (`visibility:hidden` for
 * a retained in-pane chat, `display:none` for a top-level pane), remounts it
 * (the same tab instance, or a new one as a reopened tab is), picks a turn
 * through the same adapter the phone's Messages list calls, and reads the
 * scroll node, the controller's mode and the saved reading position.
 *
 * `?line=windowed` renders production's windowed line instead
 * (`chat-scroll-model-windowed.tsx`); the probe is the same
 * (`chat-scroll-model-support.ts`), and its windowed-only members throw here.
 */
const TURNS = 24;

function assistantMessage(index: number, paragraphs: number): ChatMessage {
  const id = `message-${index}`;
  return {
    ...makeMessage(index, "assistant"),
    segments: [
      {
        id: `${id}:text`,
        kind: "text" as const,
        markdown: Array.from(
          { length: paragraphs },
          (_unused, paragraph) =>
            `Reply ${index}, paragraph ${paragraph + 1}. ` +
            "The quick brown fox jumps over the lazy dog. ".repeat(6),
        ).join("\n\n"),
        isStreaming: false,
      },
    ],
    completedAt: index,
    persistentMessageId: id,
  };
}

/** `?tallAt=<i>&tallp=<n>`: the reply at message index `i` has `n` paragraphs.
 *  `?tail=<n>`: the last reply has `n` paragraphs. `?short=1`: every earlier
 *  reply has one, so the list's average row estimate stays small. */
function initialMessages(): ChatMessage[] {
  const params = new URLSearchParams(window.location.search);
  const tailParagraphs = Number(params.get("tail") ?? 0);
  const short = params.get("short") === "1";
  const tallAt = Number(params.get("tallAt") ?? -1);
  const tallParagraphs = Number(params.get("tallp") ?? 1);
  const lastIndex = TURNS * 2 - 1;
  return Array.from({ length: TURNS * 2 }, (_unused, index) => {
    if (index % 2 === 0) {
      return {
        ...makeMessage(index, "user"),
        content: `Question ${index / 2}: ${"what about this? ".repeat(1 + (index % 5))}`,
        persistentMessageId: `message-${index}`,
      };
    }
    if (index === lastIndex && tailParagraphs > 0) {
      return assistantMessage(index, tailParagraphs);
    }
    if (index === tallAt) return assistantMessage(index, tallParagraphs);
    return assistantMessage(index, short ? 1 : 1 + (index % 4));
  });
}

function windowedOnly(): never {
  throw new Error("windowed line only: open the fixture with ?line=windowed");
}

export function Fixture() {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [hideKind, setHideKind] = useState<HideKind>("none");
  const [instance, setInstance] = useState({ id: "tile-1", mount: 1 });
  const [blank, setBlank] = useState(false);
  const streamTimer = useRef<number | null>(null);
  const messagesRef = useRef(messages);
  useLayoutEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const subagentDrillIn = useSubagentDrillIn(true);

  useLayoutEffect(() => {
    setInstanceLive(instance.id, true);
  }, [instance.id]);

  useLayoutEffect(() => {
    const grow = (): void =>
      setMessages((current) => {
        const last = current.at(-1);
        if (last === undefined || last.role !== "assistant") return current;
        const segment = last.segments.at(0);
        if (segment === undefined || segment.kind !== "text") return current;
        return [
          ...current.slice(0, -1),
          {
            ...last,
            completedAt: null,
            segments: [
              {
                ...segment,
                markdown: `${segment.markdown} More streamed text arrives here.`,
                isStreaming: true,
              },
            ],
          },
        ];
      });
    const growParagraph = (): void =>
      setMessages((current) => {
        const last = current.at(-1);
        if (last === undefined || last.role !== "assistant") return current;
        const segment = last.segments.at(0);
        if (segment === undefined || segment.kind !== "text") return current;
        return [
          ...current.slice(0, -1),
          {
            ...last,
            completedAt: null,
            segments: [
              {
                ...segment,
                markdown: `${segment.markdown}\n\n${"A whole new streamed paragraph arrives here. ".repeat(8)}`,
                isStreaming: true,
              },
            ],
          },
        ];
      });
    const scrollNode = (): HTMLElement | null =>
      document.querySelector<HTMLElement>(
        '[data-testid="chat-messages-scroll"]',
      );
    window.__chatScrollProbe = {
      line: () => "legacy",
      grow,
      startStream: (intervalMs) => {
        if (streamTimer.current !== null) return;
        streamTimer.current = window.setInterval(grow, intervalMs);
      },
      startParagraphStream: (intervalMs) => {
        if (streamTimer.current !== null) return;
        streamTimer.current = window.setInterval(growParagraph, intervalMs);
      },
      stopStream: () => {
        if (streamTimer.current !== null) {
          window.clearInterval(streamTimer.current);
          streamTimer.current = null;
        }
      },
      appendTurn: () =>
        setMessages((current) => [
          ...current,
          {
            ...makeMessage(current.length, "user"),
            content: `Question ${current.length / 2}`,
            persistentMessageId: `message-${current.length}`,
          },
          assistantMessage(current.length + 1, 1),
        ]),
      appendCardTurn: () =>
        setMessages((current) => [
          ...current,
          {
            ...makeMessage(current.length, "user"),
            content: `Question ${current.length / 2}`,
            persistentMessageId: `message-${current.length}`,
          },
          {
            ...assistantMessage(current.length + 1, 1),
            segments: [
              {
                id: `message-${current.length + 1}:reasoning`,
                kind: "reasoning" as const,
                markdown: Array.from(
                  { length: 8 },
                  (_unused, line) =>
                    `Thinking step ${line + 1}. ${"Weighing the options one more time. ".repeat(6)}`,
                ).join("\n\n"),
                isStreaming: false,
                durationMs: 4000,
              },
              {
                id: `message-${current.length + 1}:text`,
                kind: "text" as const,
                markdown: "The answer after the thinking.",
                isStreaming: false,
              },
            ],
          },
        ]),
      appendTallCardTurn: () =>
        setMessages((current) => [
          ...current,
          {
            ...makeMessage(current.length, "user"),
            content: `Question ${current.length / 2}`,
            persistentMessageId: `message-${current.length}`,
          },
          {
            ...assistantMessage(current.length + 1, 1),
            segments: [
              {
                id: `message-${current.length + 1}:lead`,
                kind: "text" as const,
                markdown: Array.from(
                  { length: 5 },
                  (_unused, paragraph) =>
                    `Lead paragraph ${paragraph + 1}. ${"The quick brown fox jumps over the lazy dog. ".repeat(6)}`,
                ).join("\n\n"),
                isStreaming: false,
              },
              {
                id: `message-${current.length + 1}:reasoning`,
                kind: "reasoning" as const,
                markdown: Array.from(
                  { length: 8 },
                  (_unused, line) =>
                    `Thinking step ${line + 1}. ${"Weighing the options one more time. ".repeat(6)}`,
                ).join("\n\n"),
                isStreaming: false,
                durationMs: 4000,
              },
              {
                id: `message-${current.length + 1}:text`,
                kind: "text" as const,
                markdown: "The answer after the thinking.",
                isStreaming: false,
              },
            ],
          },
        ]),
      insertAboveInRow: (messageId, paragraphs) =>
        setMessages((current) =>
          current.map((message) => {
            if (message.persistentMessageId !== messageId) return message;
            const first = message.segments.findIndex(
              (segment) => segment.kind === "text",
            );
            if (first < 0) return message;
            const inserted = Array.from(
              { length: paragraphs },
              (_unused, paragraph) =>
                `Inserted paragraph ${paragraph + 1}. ${"A block that appears above the reader. ".repeat(8)}`,
            ).join("\n\n");
            return {
              ...message,
              segments: message.segments.map((candidate, index) =>
                index === first && candidate.kind === "text"
                  ? {
                      ...candidate,
                      markdown: `${inserted}\n\n${candidate.markdown}`,
                    }
                  : candidate,
              ),
            };
          }),
        ),
      hide: (kind) => setHideKind(kind),
      show: () => setHideKind("none"),
      remount: (sameInstance) => {
        setInstance((current) => {
          if (sameInstance) return { id: current.id, mount: current.mount + 1 };
          setInstanceLive(current.id, false);
          return { id: `tile-${current.mount + 1}`, mount: current.mount + 1 };
        });
      },
      pickItems: () => {
        const target =
          useTileMinimapStore.getState().targetsByTileInstanceId[instance.id];
        return (
          target?.adapter.getSnapshot().items.map((item) => item.key) ?? []
        );
      },
      pick: (index) => {
        const target =
          useTileMinimapStore.getState().targetsByTileInstanceId[instance.id];
        if (target === undefined) throw new Error("no minimap target");
        target.adapter.select(index);
      },
      geometry: () => {
        const node = scrollNode();
        if (node === null) return null;
        return {
          scrollTop: node.scrollTop,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
        };
      },
      mode: () => scrollNode()?.dataset.scrollMode ?? null,
      pillShown: () => {
        const pill = document.querySelector('[aria-label="Scroll to end"]');
        return pill !== null && pill.getAttribute("aria-hidden") !== "true";
      },
      rowTop: (messageId) => {
        const node = scrollNode();
        if (node === null) return null;
        const row = node.querySelector<HTMLElement>(
          `[data-message-id="${messageId}"]`,
        );
        if (row === null) return null;
        return (
          row.getBoundingClientRect().top - node.getBoundingClientRect().top
        );
      },
      readingRow: () => {
        const node = scrollNode();
        if (node === null) return null;
        const top = node.getBoundingClientRect().top;
        const rows = Array.from(
          node.querySelectorAll<HTMLElement>("[data-message-id]"),
        ).filter((row) => row.getBoundingClientRect().bottom > top + 1);
        rows.sort(
          (a, b) =>
            a.getBoundingClientRect().top - b.getBoundingClientRect().top,
        );
        const first = rows.at(0);
        if (first === undefined) return null;
        return {
          messageId: first.dataset.messageId ?? null,
          offset: first.getBoundingClientRect().top - top,
          placeholder: false,
        };
      },
      saved: () =>
        peekSavedChatTabState({
          tileInstanceId: instance.id,
          epicId: EPIC_ID,
          chatId: TASK_ID,
          hostId: null,
        }),
      instanceId: () => instance.id,
      isPlaceholder: (messageId) =>
        scrollNode()?.querySelector(`[data-message-id="${messageId}"]`) === null
          ? null
          : false,
      hydratedRange: () => null,
      ordinalOf: () => null,
      setHydrationLatency: windowedOnly,
      evictCold: windowedOnly,
      windowState: () => null,
      frameLog: () => [],
      typeDraft: windowedOnly,
      send: windowedOnly,
      hostAccept: windowedOnly,
      assistantStarts: windowedOnly,
      finishTurn: windowedOnly,
    };
    // Production's other remount paths, on the legacy line only: the tile
    // unmounts in one commit and mounts in a later one (eviction, close and
    // reopen), or a structural move flushes the live capture first.
    Object.assign(window.__chatScrollProbe, {
      remountLater: (sameInstance: boolean): void => {
        setBlank(true);
        if (!sameInstance) setInstanceLive(instance.id, false);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            setInstance((current) =>
              sameInstance
                ? { id: current.id, mount: current.mount + 1 }
                : { id: `tile-${current.mount + 1}`, mount: current.mount + 1 },
            );
            setBlank(false);
          }),
        );
      },
      remountMoved: (): void => {
        flushChatTabViewportHandoff([instance.id]);
        setInstance((current) => ({
          id: current.id,
          mount: current.mount + 1,
        }));
      },
      restoreForMount: () =>
        restoreChatTabStateForMount(
          {
            tileInstanceId: instance.id,
            epicId: EPIC_ID,
            chatId: TASK_ID,
            hostId: null,
          },
          messagesRef.current.map(
            (message) => message.persistentMessageId ?? "",
          ),
        ),
    });
  }, [instance.id]);

  const hidden = hideKind !== "none";
  return (
    <div className="flex h-full w-full flex-col">
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-chat-keyboard-scroll-scope=""
        data-active="true"
        style={{
          visibility: hideKind === "intact" ? "hidden" : undefined,
          display: hideKind === "collapse" ? "none" : undefined,
        }}
      >
        {blank ? null : (
          <TileMinimapScope tileInstanceId={instance.id}>
            <ChatMessages
              key={`${instance.id}:${String(instance.mount)}`}
              taskTitle="Chat scroll model"
              taskId={TASK_ID}
              epicId={EPIC_ID}
              hostId={null}
              messages={messages}
              transcriptWindow={null}
              onVisibleOrdinalRangeChange={() => undefined}
              onFindReadOrdinalChange={() => undefined}
              baselineEpoch={0}
              hydrationSequence={0}
              coldRewrittenMessageIds={new Set()}
              backgroundItems={undefined}
              getMessageActions={() => null}
              nextStepActions={null}
              instanceId={instance.id}
              visible={!hidden}
              systemOverlayActive={false}
              scrollRequest={null}
              onScrollRequestSettled={null}
              composerOverlayHeight={0}
              subagentDrillIn={subagentDrillIn}
            />
          </TileMinimapScope>
        )}
      </div>
    </div>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
const root = createRoot(container);
// Imported only on its own line: that module opens a session store at load.
if (new URLSearchParams(window.location.search).get("line") === "windowed") {
  void import("./chat-scroll-model-windowed").then(({ WindowedFixture }) => {
    root.render(<WindowedFixture />);
  });
} else {
  root.render(<Fixture />);
}
