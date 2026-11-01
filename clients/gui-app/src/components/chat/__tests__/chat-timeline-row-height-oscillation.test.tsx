/**
 * A transcript row whose measured height flips between two values never lets
 * LegendList's measure -> re-render cycle settle. Every size the list applies
 * reaches `onItemSizeChanged`, the consumer hands the row back with new content
 * (as a streaming turn does), the row's container re-renders and is measured
 * again, all inside one synchronous chain of layout effects. Unbounded, React
 * throws "Maximum update depth exceeded" and the tile crashes; the patched list
 * pins the row's size for the chain and `ChatTimeline` names the row in one
 * warning instead. Releasing the chain measures the pinned row once more, so a
 * row that only flipped a few times lands on its real size.
 */
import { cleanup, render } from "@testing-library/react";
import { createRef, useState, type RefObject } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { ChatTimeline } from "@/components/chat/chat-timeline";
import { appLogger, type AppLogFields } from "@/lib/logger";
import { transcriptListRows } from "@/stores/chats/transcript-list-rows";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { makeMessages } from "./chat-message-fixtures";
import {
  installLegendListTestClock,
  installLegendListViewportMetrics,
  restoreLegendListTestClock,
  settleLegendList,
} from "./legend-list-test-environment";

const OSCILLATING_HEIGHTS: readonly [number, number] = [120, 180];
const SHORT_HEIGHT = OSCILLATING_HEIGHTS[0];
const TALL_HEIGHT = OSCILLATING_HEIGHTS[1];
const OSCILLATION_WARNING = "[transcript] a row's height never settled";

function isRowShell(candidate: Element): boolean {
  return (
    candidate.hasAttribute("data-message-id") ||
    candidate.hasAttribute("data-index")
  );
}

/** The row a LegendList container draws, matched the way the shared viewport
 *  shim matches it: the container itself, or its first child, is the row
 *  shell. The scroll and content containers never qualify. */
function rowShellOf(element: HTMLElement): Element | null {
  if (isRowShell(element)) return element;
  const child = element.firstElementChild;
  return child !== null && isRowShell(child) ? child : null;
}

function rowMessageIdOf(element: HTMLElement): string | null {
  const shell = rowShellOf(element);
  if (shell === null) return null;
  return (
    shell.getAttribute("data-message-id") ??
    shell
      .querySelector<HTMLElement>("[data-message-id]")
      ?.getAttribute("data-message-id") ??
    null
  );
}

/** A row's height follows what it shows, as real layout does. */
function heightForText(text: string): number {
  return text.includes("tall") ? TALL_HEIGHT : SHORT_HEIGHT;
}

/** Layers a reshape over the viewport shim's measurements. */
function reshapeMeasurements(
  reshape: (element: HTMLElement, rect: DOMRect) => DOMRect,
): void {
  // The viewport shim already spies this method; spying again returns its spy.
  const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
  const measure = spy.getMockImplementation();
  if (measure === undefined) {
    throw new Error("the viewport shim does not measure elements");
  }
  spy.mockImplementation(function (this: HTMLElement) {
    return reshape(this, measure.call(this));
  });
}

function withSize(rect: DOMRect, width: number, height: number): DOMRect {
  return DOMRect.fromRect({ x: rect.x, y: rect.y, width, height });
}

function oscillationWarnings(
  calls: ReadonlyArray<readonly [string, AppLogFields]>,
): ReadonlyArray<readonly [string, AppLogFields]> {
  return calls.filter(([message]) => message.startsWith(OSCILLATION_WARNING));
}

function requireList(listRef: RefObject<LegendListRef | null>): LegendListRef {
  const list = listRef.current;
  if (list === null) throw new Error("LegendList ref did not mount");
  return list;
}

function TranscriptTimeline({
  messages,
  listRef,
  onItemSizeChanged,
}: {
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly onItemSizeChanged: (() => void) | undefined;
}) {
  return (
    <ChatTimeline
      rows={transcriptListRows({
        window: null,
        rendered: messages,
        splitLongTurns: true,
      })}
      taskTitle="row height oscillation"
      backgroundToolBlockIds={new Set()}
      getMessageActions={() => null}
      nextStepActions={null}
      listRef={listRef}
      className="h-full"
      onItemSizeChanged={onItemSizeChanged}
    />
  );
}

/** A consumer that answers every measured size change by handing the
 *  streaming row back with new content. */
function FeedbackTimeline({
  messages,
  streamingMessageId,
  listRef,
}: {
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly streamingMessageId: string;
  readonly listRef: RefObject<LegendListRef | null>;
}) {
  const [revision, setRevision] = useState(0);
  return (
    <TranscriptTimeline
      messages={messages.map((message) =>
        message.id === streamingMessageId
          ? { ...message, content: `${message.content} ${revision}` }
          : message,
      )}
      listRef={listRef}
      onItemSizeChanged={() => {
        setRevision((current) => current + 1);
      }}
    />
  );
}

describe("ChatTimeline row height oscillation", () => {
  beforeEach(() => {
    installLegendListViewportMetrics();
    installLegendListTestClock();
  });

  afterEach(() => {
    cleanup();
    restoreLegendListTestClock();
  });

  it("pins a row whose height never settles and names it in one warning", async () => {
    const messages = makeMessages(5);
    const target = messages[2];
    let reads = 0;
    reshapeMeasurements((element, rect) => {
      if (rowMessageIdOf(element) !== target.id) return rect;
      const height = OSCILLATING_HEIGHTS[reads % OSCILLATING_HEIGHTS.length];
      reads += 1;
      return withSize(rect, rect.width, height);
    });
    const warn = vi.spyOn(appLogger, "warn");
    onTestFinished(() => {
      warn.mockRestore();
    });
    const listRef = createRef<LegendListRef | null>();

    const view = render(
      <FeedbackTimeline
        messages={messages}
        streamingMessageId={target.id}
        listRef={listRef}
      />,
    );
    await settleLegendList();

    expect(
      view.container.querySelector(`[data-message-id="${target.id}"]`),
    ).not.toBeNull();
    const warnings = oscillationWarnings(warn.mock.calls);
    expect(warnings).toHaveLength(1);
    const [, fields] = warnings[0];
    expect(fields).toEqual({
      itemKey: target.id,
      messageId: target.id,
      rowKind: "user",
      sizes: [...OSCILLATING_HEIGHTS],
    });
    expect(OSCILLATING_HEIGHTS).toContain(
      requireList(listRef).getState().sizes.get(target.id),
    );
  });

  it("lands a row that flipped back within one pass on its final height once the pass ends", async () => {
    const messages = makeMessages(5);
    const targetIndex = 2;
    const target = messages[targetIndex];
    reshapeMeasurements((element, rect) =>
      rowMessageIdOf(element) === target.id
        ? withSize(rect, rect.width, heightForText(element.textContent))
        : rect,
    );
    const warn = vi.spyOn(appLogger, "warn");
    onTestFinished(() => {
      warn.mockRestore();
    });
    const listRef = createRef<LegendListRef | null>();
    const streamed = (content: string): ReadonlyArray<ChatMessageModel> =>
      messages.map((message) =>
        message.id === target.id ? { ...message, content } : message,
      );
    const timeline = (content: string) => (
      <TranscriptTimeline
        messages={streamed(content)}
        listRef={listRef}
        onItemSizeChanged={undefined}
      />
    );

    const view = render(timeline("short reply"));
    await settleLegendList();
    const list = requireList(listRef);
    expect(list.getState().sizes.get(target.id)).toBe(SHORT_HEIGHT);
    const settledContentLength = list.getState().contentLength;

    // Three deltas of the streaming row inside one task, the last of which
    // returns it to the height it started the task at: the list rejects that
    // last measurement, and the DOM stops changing on it.
    view.rerender(timeline("short reply, revised"));
    view.rerender(timeline("tall reply"));
    view.rerender(timeline("short reply, final"));
    expect(oscillationWarnings(warn.mock.calls)).toHaveLength(1);
    expect(list.getState().sizes.get(target.id)).toBe(TALL_HEIGHT);

    await settleLegendList();

    const state = list.getState();
    expect(state.sizes.get(target.id)).toBe(SHORT_HEIGHT);
    expect(state.positionAtIndex(targetIndex + 1)).toBe(
      (state.positionAtIndex(targetIndex) ?? Number.NaN) + SHORT_HEIGHT,
    );
    expect(state.contentLength).toBe(settledContentLength);
  });
});

type Row = { readonly id: string; readonly text: string };

const NARROW_LIST_CLASS = "narrow-cross-axis-list";
const NARROW_ROW_WIDTH = 300;
const WIDE_ROW_WIDTH = 900;

/** The cross-axis floor the list gives its content, which it raises from its
 *  rows' measured widths when the list itself has no width to offer. */
function contentMinWidth(list: LegendListRef): string {
  const scroller = list.getScrollableNode();
  if (!(scroller instanceof HTMLElement)) {
    throw new Error("LegendList scrollable node is not mounted");
  }
  const content = [...scroller.querySelectorAll<HTMLElement>("div")].find(
    (element) => element.style.minWidth !== "",
  );
  return content?.style.minWidth ?? "";
}

describe("LegendList pinned row measurement", () => {
  beforeEach(() => {
    installLegendListViewportMetrics();
    installLegendListTestClock();
  });

  afterEach(() => {
    cleanup();
    restoreLegendListTestClock();
  });

  it("still widens the content for a pinned row's wider measurement", async () => {
    reshapeMeasurements((element, rect) => {
      if (element.classList.contains(NARROW_LIST_CLASS)) {
        return withSize(rect, 0, rect.height);
      }
      const shell = rowShellOf(element);
      if (shell === null) return rect;
      const text = shell.textContent;
      return withSize(
        rect,
        text.includes("wide") ? WIDE_ROW_WIDTH : NARROW_ROW_WIDTH,
        heightForText(text),
      );
    });
    const listRef = createRef<LegendListRef | null>();
    const rows = (targetText: string): Row[] =>
      Array.from({ length: 5 }, (_unused, index) => ({
        id: `row-${index}`,
        text: index === 2 ? targetText : `row ${index}`,
      }));
    const list = (targetText: string) => (
      <LegendList<Row>
        ref={listRef}
        className={NARROW_LIST_CLASS}
        data={rows(targetText)}
        estimatedItemSize={90}
        keyExtractor={(item) => item.id}
        recycleItems={false}
        renderItem={({ item }) => <div data-index={item.id}>{item.text}</div>}
      />
    );

    const view = render(list("short"));
    await settleLegendList();
    const mounted = requireList(listRef);
    expect(contentMinWidth(mounted)).toBe(`${NARROW_ROW_WIDTH}px`);

    view.rerender(list("short, revised"));
    view.rerender(list("tall"));
    // Rejected on the scrolling axis (back to a height this pass already
    // saw), while carrying the widest row the list has measured.
    view.rerender(list("short and wide"));
    expect(mounted.getState().sizes.get("row-2")).toBe(TALL_HEIGHT);

    expect(contentMinWidth(mounted)).toBe(`${WIDE_ROW_WIDTH}px`);
  });
});
