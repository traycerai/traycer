import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";
import { ChatTimeline } from "@/components/chat/chat-timeline";
import { transcriptListRows } from "@/stores/chats/transcript-list-rows";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { makeMessage } from "./chat-message-fixtures";
import {
  installLegendListTestClock,
  installLegendListViewportMetrics,
  restoreLegendListTestClock,
  setLegendListMessageRowHeightOverrides,
  settleLegendList,
} from "./legend-list-test-environment";

/**
 * Estimated-height recovery regression at the real, unmocked
 * `ChatTimeline` + `@legendapp/list` seam. 250 alternating user/assistant rows, reader parked 5 rows from the
 * tail (`initialScrollIndex`), then a synthetic append commit followed by a
 * same-key content-update commit - the same two-commit shape
 * `chat-timeline.tsx`'s own `resolveChatTimelineMvcp` selects between:
 *
 * 1. Append: a tall quoted user row + a short pending-assistant row (new
 *    keys). `keySequenceChanged = true` -> `{data: true, size: true}`.
 * 2. Content update: same keys, the pending row's content changes in place.
 *    `keySequenceChanged = false` -> `{data: false, size: true}`.
 *
 * The quote is overridden to 15x the flat 90px row default (1350px) -
 * `legend-list-test-environment.ts`'s `ITEM_HEIGHT_PX` - a synthetic
 * threshold-crossing magnitude chosen to reliably breach the library's
 * cached-estimate-to-average ratio guard, not a reproduction of the
 * original reported short quote. A short quote alone need not cross this
 * threshold; this test pins the demonstrated estimate-recovery defect.
 *
 * Limitation: the shared `scrollBy` shim in `legend-list-test-environment.ts`
 * applies a delta directly to `scrollTop` and does not model a real
 * scroller's clamping at its content bounds, so a compensating adjustment
 * this test observes as applied may behave differently near the top/bottom
 * of an actual DOM scroller.
 */

const TOTAL_MESSAGE_COUNT = 250;
const PARK_INDEX = TOTAL_MESSAGE_COUNT - 5;
/** `legend-list-test-environment.ts`'s `ITEM_HEIGHT_PX` - the flat height
 *  every message row without an explicit override renders at in this
 *  harness. */
const ROW_HEIGHT_PX = 90;
const QUOTE_HEIGHT_PX = ROW_HEIGHT_PX * 15;
const PENDING_ASSISTANT_ROW_HEIGHT_PX = 40;
const QUOTE_MESSAGE_ID = `message-${TOTAL_MESSAGE_COUNT}`;
const PENDING_ASSISTANT_MESSAGE_ID = `message-${TOTAL_MESSAGE_COUNT + 1}`;

function makeAlternatingMessages(count: number): ChatMessageModel[] {
  return Array.from({ length: count }, (_unused, index) =>
    makeMessage(index, index % 2 === 0 ? "user" : "assistant"),
  );
}

function renderTimeline(messages: ReadonlyArray<ChatMessageModel>) {
  const listRef = createRef<LegendListRef | null>();
  const jsx = (msgs: ReadonlyArray<ChatMessageModel>) => (
    <div style={{ height: 700, width: 800 }}>
      <ChatTimeline
        rows={transcriptListRows({ window: null, rendered: msgs })}
        taskTitle="Quoted-reply send"
        backgroundToolBlockIds={new Set()}
        getMessageActions={() => null}
        nextStepActions={null}
        listRef={listRef}
        className="h-full"
        initialScrollAtEnd={false}
        initialScrollIndex={{
          index: PARK_INDEX,
          viewOffset: 0,
          viewPosition: 0,
        }}
      />
    </div>
  );
  const result = render(jsx(messages));
  return {
    ...result,
    listRef,
    rerenderMessages: (msgs: ReadonlyArray<ChatMessageModel>) => {
      result.rerender(jsx(msgs));
    },
  };
}

/** The reader's fixed-scrollTop view of a specific row: its absolute
 *  position minus the current scroll offset. If content above it moves
 *  while the scroller's own scrollTop does not follow, this value changes
 *  even though nothing the reader did caused a scroll. */
function viewportOffsetOf(list: LegendListRef, key: string): number {
  const state = list.getState();
  const position = state.positionByKey(key);
  if (position === undefined) {
    throw new Error(`${key} is not a known row`);
  }
  return position - state.scroll;
}

describe("Quoted-reply send: tall-quote two-commit reproduction", () => {
  beforeEach(() => {
    installLegendListViewportMetrics();
    installLegendListTestClock();
  });

  afterEach(() => {
    cleanup();
    restoreLegendListTestClock();
  });

  it("holds the parked reader's position across both the send's data commit and the same-key commit that follows it", async () => {
    const baseMessages = makeAlternatingMessages(TOTAL_MESSAGE_COUNT);
    const { container, listRef, rerenderMessages } =
      renderTimeline(baseMessages);
    await settleLegendList();

    const list = listRef.current;
    if (list === null) {
      throw new Error("ChatTimeline/LegendList did not mount");
    }

    const anchorKey = `message-${PARK_INDEX}`;
    // Preconditions, checked rather than assumed: there is a real mounted
    // view to anchor on, and the anchor row specifically is in it - an
    // empty/no-anchor view would make every assertion below vacuous.
    expect(list.getState().start).toBeLessThanOrEqual(list.getState().end);
    expect(
      container.querySelector(`[data-message-id="${anchorKey}"]`),
    ).not.toBeNull();

    const scrollNode = list.getScrollableNode();
    const before = {
      domScrollTop: scrollNode.scrollTop,
      offset: viewportOffsetOf(list, anchorKey),
      scroll: list.getState().scroll,
    };

    // Commit 1 - the send: new row keys, a tall quote. `ChatTimeline`
    // computes `keySequenceChanged = true` for this commit, so it is the
    // compensable `{data: true, size: true}` config.
    const sendMessages: ChatMessageModel[] = [
      ...baseMessages,
      {
        ...makeMessage(TOTAL_MESSAGE_COUNT, "user"),
        content: "Quoted line one\nQuoted line two\nQuoted line three",
      },
      {
        ...makeMessage(TOTAL_MESSAGE_COUNT + 1, "assistant"),
        content: "",
        runState: "running",
      },
    ];
    setLegendListMessageRowHeightOverrides(
      new Map([
        [QUOTE_MESSAGE_ID, QUOTE_HEIGHT_PX],
        [PENDING_ASSISTANT_MESSAGE_ID, PENDING_ASSISTANT_ROW_HEIGHT_PX],
      ]),
    );
    act(() => {
      rerenderMessages(sendMessages);
    });
    await settleLegendList();

    const afterCommit1 = {
      domScrollTop: scrollNode.scrollTop,
      offset: viewportOffsetOf(list, anchorKey),
      scroll: list.getState().scroll,
    };

    expect(afterCommit1.offset).toBeCloseTo(before.offset, 0);
    {
      const stateDelta = afterCommit1.scroll - before.scroll;
      const domDelta = afterCommit1.domScrollTop - before.domScrollTop;
      expect(domDelta).toBeCloseTo(stateDelta, 0);
    }

    // Commit 2 - the accepted-message/first-token pass: same keys, the
    // pending assistant row's content changes in place. `keySequenceChanged
    // = false` -> `{data: false, size: true}`, the config this whole
    // harness exists to exercise.
    const tokenMessages: ChatMessageModel[] = sendMessages.map((message) =>
      message.id === PENDING_ASSISTANT_MESSAGE_ID
        ? { ...message, content: "Working on it" }
        : { ...message },
    );
    act(() => {
      rerenderMessages(tokenMessages);
    });
    await settleLegendList();

    const afterCommit2 = {
      domScrollTop: scrollNode.scrollTop,
      offset: viewportOffsetOf(list, anchorKey),
      scroll: list.getState().scroll,
    };

    // The regression assertion. Currently FAILS unpatched: on the original,
    // ungated bundles this offset moves by ~16,913px (170 -> 17083.25) while
    // the scroll container's own `scrollTop` moves by only -540px - the
    // ratio guard reassigns the unmeasured rows above the reader off the
    // shifted average during commit 2's recompute, and this commit's
    // `{data: false}` config disables the channel that would otherwise
    // compensate it. The fix does not arm an anchor lock for this commit -
    // it compensates through the existing size-channel-style path instead.
    expect(afterCommit2.offset).toBeCloseTo(before.offset, 0);

    const commit2StateDelta = afterCommit2.scroll - afterCommit1.scroll;
    const commit2DomDelta =
      afterCommit2.domScrollTop - afterCommit1.domScrollTop;

    // Not vacuous: a real correction was needed on this commit (observed
    // -540px on the original bundles), not zero.
    expect(Math.abs(commit2StateDelta)).toBeGreaterThan(ROW_HEIGHT_PX * 2);

    // Proves a real compensating scroll happened in the DOM, not only in
    // the library's own bookkeeping.
    expect(commit2DomDelta).toBeCloseTo(commit2StateDelta, 0);
  });
});
