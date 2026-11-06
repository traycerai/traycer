import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { ChatMessages } from "@/components/chat/chat-messages";
import { useSubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import { TileFindScope } from "@/components/epic-canvas/tile-find/tile-find-scope";
import { useTileFindStore } from "@/stores/tile-find/tile-find-store";
import type { ChatMessage } from "@/stores/composer/chat-store";
import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import "@/index.css";

/**
 * The real `ChatMessages` wired to the real Find stack (`TileFindScope`,
 * `TileFindBar`, `useChatFindController`) for `chat-find-scroll-race.spec.ts`:
 * a real browser's `requestAnimationFrame`/`scrollIntoView` timing, not a
 * mocked `scrollToLocation`, is the only way to see the reveal/navigation
 * race (and its fix) actually land a real scroll and a real paint.
 *
 * Two needle occurrences live far apart in a tall transcript: one requires a
 * real scroll down from the top, the other a further scroll past it - a
 * find-next hop pressed as soon as the first match is revealed. Each needle
 * reply is itself one find UNIT (one text segment) made of many filler
 * paragraphs ahead of the one-sentence needle paragraph - taller than the
 * fixture's own viewport - so a reveal that merely scrolls the UNIT into
 * (partial) view, without landing the actual matched SENTENCE inside the
 * scroller, is a distinguishable, catchable failure.
 */
const EPIC_ID = "chat-find-scroll-model";
const TASK_ID = "chat-find-scroll-model-chat";
const INSTANCE_ID = "chat-find-scroll-tile";

const NEEDLE_NEAR_SENTENCE =
  "The glimmerfrost marker sits inside this sentence, near turn five.";
const NEEDLE_FAR_SENTENCE =
  "The glimmerfrost marker also sits inside this sentence, far below.";

const TURNS = 14;
const NEAR_TURN = 3;
const FAR_TURN = 10;
/** Paragraphs ahead of the needle sentence in a needle reply's one unit -
 *  enough to make that unit much taller than the fixture's 700px viewport
 *  (each filler paragraph renders well over 100px). */
const NEEDLE_UNIT_FILLER_PARAGRAPHS = 10;

function fillerParagraph(seed: number): string {
  return `Paragraph ${seed}. ${"The quick brown fox jumps over the lazy dog. ".repeat(6)}`;
}

function assistantMessage(
  index: number,
  needleSentence: string | null,
): ChatMessage {
  const id = `message-${index}`;
  const fillerCount =
    needleSentence === null ? 1 : NEEDLE_UNIT_FILLER_PARAGRAPHS;
  const paragraphs = Array.from({ length: fillerCount }, (_unused, paragraph) =>
    fillerParagraph(paragraph),
  );
  if (needleSentence !== null) paragraphs.push(needleSentence);
  return {
    ...makeMessage(index, "assistant"),
    segments: [
      {
        id: `${id}:text`,
        kind: "text" as const,
        markdown: paragraphs.join("\n\n"),
        isStreaming: false,
      },
    ],
    completedAt: index,
    persistentMessageId: id,
  };
}

function initialMessages(): ChatMessage[] {
  return Array.from({ length: TURNS * 2 }, (_unused, index) => {
    if (index % 2 === 0) {
      return {
        ...makeMessage(index, "user"),
        content: `Question ${index / 2}: ${"what about this? ".repeat(3)}`,
        persistentMessageId: `message-${index}`,
      };
    }
    const turn = (index - 1) / 2;
    if (turn === NEAR_TURN)
      return assistantMessage(index, NEEDLE_NEAR_SENTENCE);
    if (turn === FAR_TURN) return assistantMessage(index, NEEDLE_FAR_SENTENCE);
    return assistantMessage(index, null);
  });
}

declare global {
  interface Window {
    __chatFindScrollProbe?: {
      openFind: () => void;
    };
  }
}

// Exported (though nothing imports it) because `react(only-export-components)`
// requires at least one export from a file with a component for fast
// refresh - the same reason `chat-scroll-model.tsx`'s `Fixture` is exported.
export function Fixture() {
  const subagentDrillIn = useSubagentDrillIn(true);
  const messages = initialMessages();

  useLayoutEffect(() => {
    window.__chatFindScrollProbe = {
      // The fixture has no global Cmd+F keybinding wired (that lives in the
      // app shell, out of scope here); this is the one programmatic step -
      // the bar's own input, Enter and Next button are driven as real user
      // input from the spec from here on.
      openFind: () => {
        useTileFindStore.getState().openForTile(INSTANCE_ID);
      },
    };
  }, []);

  return (
    <div className="flex h-full w-full flex-col" data-testid="chat-pane">
      <TileFindScope
        node={{ instanceId: INSTANCE_ID, id: INSTANCE_ID, type: "chat" }}
        viewTabId="view-tab-1"
        tileId={INSTANCE_ID}
        epicId={EPIC_ID}
        isActive
      >
        <div className="flex min-h-0 flex-1 flex-col" data-active="true">
          <ChatMessages
            taskTitle="Chat find scroll model"
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
            instanceId={INSTANCE_ID}
            visible
            systemOverlayActive={false}
            scrollRequest={null}
            onScrollRequestSettled={null}
            composerOverlayHeight={0}
            subagentDrillIn={subagentDrillIn}
          />
        </div>
      </TileFindScope>
    </div>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(<Fixture />);
