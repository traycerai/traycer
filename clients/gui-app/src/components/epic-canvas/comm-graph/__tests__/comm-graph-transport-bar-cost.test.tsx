/**
 * WHAT A STEP OF PLAYBACK COSTS THE BAR.
 *
 * The track draws one marker per captured row, each a Radix tooltip whose label
 * is a markdown parse - and the bar re-renders on every step, because moving the
 * playhead is what a step DOES. So an epic with a couple of thousand rows in it
 * re-parsed a couple of thousand messages per tick, for markers that had not
 * moved since the frame before.
 *
 * That is the other half of "even at 4x, the graph is filling super slow": the
 * speed ladder answers how often a step happens, and this answers what one
 * costs. Raising the ladder without this would only have asked the bar to do
 * the same work more often.
 *
 * COUNTED THROUGH `markdownToPlainText`, which is the expensive half of a
 * marker's label and is reached only from there in this component, so its call
 * count is a direct reading of work the bar did rather than a proxy for it.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import { commGraphCursorForEvent } from "@/lib/comm-graph/comm-graph-timeline";
import { CommGraphTransportBar } from "@/components/epic-canvas/comm-graph/comm-graph-transport-bar";
import { useCommGraphTimelineStore } from "@/stores/epics/comm-graph-timeline-store";

const plainTextCalls = vi.fn();

vi.mock("@/lib/markdown/markdown-to-plain-text", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/markdown/markdown-to-plain-text")
    >();
  return {
    ...actual,
    markdownToPlainText: (text: string): string => {
      plainTextCalls();
      return actual.markdownToPlainText(text);
    },
  };
});

const EPIC = "epic-bar-cost";
const ROWS = 40;

function event(id: number): CommGraphEvent {
  return {
    hostId: "host-a",
    id,
    timestamp: id * 1_000,
    kind: "a2a_message",
    senderAgentId: "a",
    receiverAgentId: "b",
    responseId: "r1",
    inReplyTo: null,
    expectReply: false,
    messageText: `**row ${id}** with some _markdown_ in it`,
    noticeReason: null,
    originKind: null,
    originChatId: null,
    originRefId: null,
  };
}

const EVENTS: ReadonlyArray<CommGraphEvent> = Array.from(
  { length: ROWS },
  (_unused, index) => event(index + 1),
);

describe("what a playback step costs the transport bar", () => {
  beforeEach(() => {
    plainTextCalls.mockClear();
    useCommGraphTimelineStore.setState({ stateByEpicId: {} });
  });

  afterEach(() => {
    cleanup();
    useCommGraphTimelineStore.setState({ stateByEpicId: {} });
  });

  it("parses each row's label once, however many times the playhead moves", () => {
    render(<CommGraphTransportBar epicId={EPIC} events={EVENTS} />);
    // The first paint reads every row: that is the work this is about NOT
    // repeating, so it has to actually happen first.
    const afterFirstPaint = plainTextCalls.mock.calls.length;
    expect(afterFirstPaint).toBeGreaterThanOrEqual(ROWS);

    // Ten steps of playback, driven the way the tick drives them.
    for (let step = 0; step < 10; step += 1) {
      act(() => {
        useCommGraphTimelineStore
          .getState()
          .setCursor(EPIC, commGraphCursorForEvent(EVENTS[step]));
      });
    }

    // Not one more parse. Unmemoized this was ten more passes over every row.
    expect(plainTextCalls.mock.calls.length).toBe(afterFirstPaint);
  });

  it("still reads a row that has only just landed", () => {
    // The control. "Never parse again" would also satisfy the case above, and
    // would mean a row arriving live got no tooltip at all.
    const { rerender } = render(
      <CommGraphTransportBar epicId={EPIC} events={EVENTS} />,
    );
    const afterFirstPaint = plainTextCalls.mock.calls.length;

    rerender(
      <CommGraphTransportBar
        epicId={EPIC}
        events={[...EVENTS, event(ROWS + 1)]}
      />,
    );

    expect(plainTextCalls.mock.calls.length).toBeGreaterThan(afterFirstPaint);
  });
});
