/**
 * A transcript row whose measured height flips between two values never lets
 * LegendList's measure -> re-render cycle settle. Every size the list applies
 * reaches `onItemSizeChanged`, the consumer hands the row back with new content
 * (as a streaming turn does), the row's container re-renders and is measured
 * again, all inside one synchronous chain of layout effects. Unbounded, React
 * throws "Maximum update depth exceeded" and the tile crashes; the patched list
 * pins the row's size for the chain and `ChatTimeline` names the row in one
 * warning instead.
 */
import { cleanup, render } from "@testing-library/react";
import { createRef, useState, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";
import { ChatTimeline } from "@/components/chat/chat-timeline";
import { appLogger } from "@/lib/logger";
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

function isRowShell(candidate: Element): boolean {
  return (
    candidate.hasAttribute("data-message-id") ||
    candidate.hasAttribute("data-index")
  );
}

function rowShellOf(element: HTMLElement): Element | null {
  if (isRowShell(element)) return element;
  const child = element.firstElementChild;
  return child !== null && isRowShell(child) ? child : null;
}

/** The message a LegendList row container draws, matched the way the shared
 *  viewport shim matches it: the container itself, or its first child, is the
 *  row shell. The scroll and content containers never qualify. */
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

/** Makes one row report the two heights in turn, one per read. */
function oscillateRowHeight(messageId: string): void {
  // The viewport shim already spies this method; spying again returns its spy.
  const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
  const measure = spy.getMockImplementation();
  if (measure === undefined) {
    throw new Error("the viewport shim does not measure elements");
  }
  let reads = 0;
  spy.mockImplementation(function (this: HTMLElement) {
    const rect = measure.call(this);
    if (rowMessageIdOf(this) !== messageId) return rect;
    const height = OSCILLATING_HEIGHTS[reads % OSCILLATING_HEIGHTS.length];
    reads += 1;
    return DOMRect.fromRect({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height,
    });
  });
}

/** A consumer that answers every measured size change by handing the
 *  streaming row back with new content. */
function StreamingTimeline({
  messages,
  streamingMessageId,
  listRef,
}: {
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly streamingMessageId: string;
  readonly listRef: RefObject<LegendListRef | null>;
}) {
  const [revision, setRevision] = useState(0);
  const rendered = messages.map((message) =>
    message.id === streamingMessageId
      ? { ...message, content: `${message.content} ${revision}` }
      : message,
  );
  return (
    <ChatTimeline
      rows={transcriptListRows({
        window: null,
        rendered,
        splitLongTurns: true,
      })}
      taskTitle="row height oscillation"
      backgroundToolBlockIds={new Set()}
      getMessageActions={() => null}
      nextStepActions={null}
      listRef={listRef}
      className="h-full"
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
    oscillateRowHeight(target.id);
    const warn = vi.spyOn(appLogger, "warn");
    const listRef = createRef<LegendListRef | null>();

    const view = render(
      <StreamingTimeline
        messages={messages}
        streamingMessageId={target.id}
        listRef={listRef}
      />,
    );
    await settleLegendList();

    expect(
      view.container.querySelector(`[data-message-id="${target.id}"]`),
    ).not.toBeNull();
    const oscillationWarnings = warn.mock.calls.filter(([message]) =>
      message.startsWith("[transcript] a row's height never settled"),
    );
    expect(oscillationWarnings).toHaveLength(1);
    const [, fields] = oscillationWarnings[0];
    expect(fields).toEqual({
      itemKey: target.id,
      messageId: target.id,
      rowKind: "user",
      sizes: [...OSCILLATING_HEIGHTS],
    });
    expect(OSCILLATING_HEIGHTS).toContain(
      listRef.current?.getState().sizes.get(target.id),
    );
  });
});
