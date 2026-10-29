import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createRoot } from "react-dom/client";
import { useChatTimelineFollowLatch } from "@/components/chat/chat-timeline-follow-latch";
import "@/index.css";

/**
 * The chat transcript's bottom-follow (`useChatTimelineFollowLatch`) wired
 * over a LegendList exactly as `chat-timeline.tsx` wires it, with plain text
 * rows, in a phone-sized scroller. `window.__appendRow()` adds a row,
 * `window.__growLastRow()` streams text into the last one,
 * `window.__geometry()` reads the scroll node, `window.__readingRow()` the
 * row under its top edge, `body[data-following]`
 * mirrors the latch's follow intent, and `body[data-swallow-touchmove]`
 * withholds `touchmove` from the list, as iOS WebKit does once its native pan
 * owns the touch. `browser-tests/chat-follow-latch-touch.spec.ts` drives it.
 */
interface Row {
  readonly id: string;
  readonly text: string;
}

function makeRow(index: number): Row {
  const sentences = 1 + (index % 7);
  return {
    id: `row-${String(index)}`,
    text: Array.from(
      { length: sentences },
      (_, i) =>
        `Row ${String(index)} sentence ${String(i + 1)}: the quick brown fox jumps over the lazy dog and keeps running.`,
    ).join(" "),
  };
}

const INITIAL_ROWS: readonly Row[] = Array.from({ length: 40 }, (_, i) =>
  makeRow(i),
);

export function Harness() {
  const [rows, setRows] = useState<readonly Row[]>(INITIAL_ROWS);
  const listRef = useRef<LegendListRef | null>(null);
  const onFollowIntentChange = useCallback((isFollowing: boolean) => {
    document.body.dataset.following = String(isFollowing);
  }, []);
  const latch = useChatTimelineFollowLatch(listRef, true, rows.length > 0, {
    onFollowIntentChange,
    onReaderGesture: undefined,
    isCorrectionSuppressed: undefined,
    resolveSuppressedEndLanding: undefined,
    isReattachSuppressed: undefined,
  });

  useLayoutEffect(() => {
    latch.followEndIfPermitted();
  }, [rows, latch]);

  useEffect(() => {
    document.body.dataset.following = "true";
    // iOS WebKit stops delivering `touchmove` to the page once its native pan
    // or fling owns the touch. Simulate that: swallow every `touchmove` at the
    // capture phase before the list's own listener sees it.
    const swallowTouchMove = (event: Event): void => {
      if (document.body.dataset.swallowTouchmove === "true") {
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener("touchmove", swallowTouchMove, {
      capture: true,
      passive: true,
    });
    Object.assign(window, {
      __appendRow: () =>
        setRows((current) => [...current, makeRow(current.length)]),
      __growLastRow: () =>
        setRows((current) => {
          const last = current[current.length - 1];
          return [
            ...current.slice(0, -1),
            { ...last, text: `${last.text} More streamed text arrives here.` },
          ];
        }),
      __geometry: () => {
        const node = listRef.current?.getScrollableNode();
        if (!node) return null;
        return {
          scrollTop: node.scrollTop,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
        };
      },
      // The row under the scroller's top edge, by geometry: the list recycles
      // its containers, so document order is not screen order.
      __readingRow: () => {
        const node = listRef.current?.getScrollableNode();
        if (!node) return null;
        const edge = node.getBoundingClientRect().top;
        let reading: { id: string; top: number } | null = null;
        for (const row of node.querySelectorAll<HTMLElement>("[data-row]")) {
          const box = row.getBoundingClientRect();
          if (box.height === 0 || box.bottom <= edge) continue;
          const top = box.top - edge;
          if (reading === null || top < reading.top) {
            reading = { id: row.dataset.row ?? "", top };
          }
        }
        return reading;
      },
    });
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const scrollNode = listRef.current?.getScrollableNode();
      latch.noteReaderGesture({
        direction: "indeterminate",
        freezeInFlightScroll: true,
        publishesReaderPosition: event.target === scrollNode,
      });
    },
    [latch],
  );

  return (
    <div
      data-testid="scroller-host"
      style={{ height: "100%", width: "100%" }}
      onPointerDown={handlePointerDown}
    >
      <LegendList<Row>
        ref={listRef}
        data={rows}
        keyExtractor={(row) => row.id}
        renderItem={({ item }) => (
          <div
            data-row={item.id}
            style={{ padding: 12, borderBottom: "1px solid #ccc" }}
          >
            {item.text}
          </div>
        )}
        estimatedItemSize={90}
        initialScrollAtEnd
        maintainScrollAtEndThreshold={0}
        maintainVisibleContentPosition={{ data: false, size: true }}
        onItemSizeChanged={() => latch.followEndIfPermitted()}
        onScroll={() => latch.observeLiveGeometry()}
        onMetricsChange={() => latch.followEndIfPermitted()}
        className="h-full overflow-x-hidden overflow-y-auto overscroll-y-contain [overflow-anchor:none]"
        style={{ height: "100%" }}
      />
    </div>
  );
}

const container = document.getElementById("root");
if (container !== null) {
  createRoot(container).render(<Harness />);
}
