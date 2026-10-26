import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { ChatMessages } from "@/components/chat/chat-messages";
import { useSubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import {
  applyIndexChange,
  applySkeletonChunk,
  applyWindowedSnapshot,
  emptyTranscriptWindow,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";
import "@/index.css";

/**
 * A SEND WHILE SCROLLED UP, through the real transcript folds into the real
 * `ChatMessages` list. Every row is an unhydrated placeholder whose height the
 * skeleton's byte count decides, so the rows are of many heights and only the
 * row KEYS tell LegendList which measurement belongs to which row.
 *
 * `window.__sendThroughVoid()` is one send as the host delivers it: a
 * `reindexed` index change that voids the window and adds a row, a
 * replacement chunk while the window is still invalidated, the snapshot that
 * clears it, and the full restream in chunks until the index is complete -
 * one fold per frame pair.
 * `window.__scrollRowTo(rowId, offset)` puts a row `offset` px below the
 * scroller's top, `window.__anchorOffset(rowId)` reads where it is now, and
 * `window.__geometry()` reads the scroll node. `body[data-following]` mirrors
 * the list's own `data-scroll-mode`, and `body[data-swallow-touchmove]`
 * withholds `touchmove` as iOS WebKit does once its native pan owns the touch.
 * `browser-tests/chat-send-void-rekey.spec.ts` drives it.
 */

const INITIAL_ROW_COUNT = 400;
const CHUNK_ROWS = 120;
const EPIC_ID = "chat-send-void-rekey";

function rowId(ordinal: number): string {
  return `row-${String(ordinal)}`;
}

/** A fresh object per call, as a redelivered chunk carries; same contents. */
function entryAt(ordinal: number): RowSkeletonEntry {
  return {
    rowId: rowId(ordinal),
    createdAt: 1000 + ordinal,
    role: ordinal % 3 === 0 ? "user" : "assistant",
    // 80 to 2000 bytes: placeholder heights from the floor to the cap.
    byteLength: 80 * (1 + ((ordinal * 37) % 25)),
    bodyDigest: `digest-${String(ordinal)}`,
  };
}

function entries(fromOrdinal: number, toOrdinal: number): RowSkeletonEntry[] {
  return Array.from({ length: toOrdinal - fromOrdinal }, (_unused, index) =>
    entryAt(fromOrdinal + index),
  );
}

function snapshot(
  window: TranscriptWindow,
  epoch: number,
  rowCount: number,
): TranscriptWindow {
  return applyWindowedSnapshot(
    window,
    {
      epoch,
      rowCount,
      // A full restream follows, from ordinal 0.
      indexRevision: null,
      tail: { fromOrdinal: rowCount, messages: [], events: [] },
    },
    null,
    null,
  );
}

function chunk(
  window: TranscriptWindow,
  fromOrdinal: number,
  rowCount: number,
): TranscriptWindow {
  const toOrdinal = Math.min(rowCount, fromOrdinal + CHUNK_ROWS);
  return applySkeletonChunk(window, {
    epoch: window.epoch,
    fromOrdinal,
    entries: entries(fromOrdinal, toOrdinal),
    isFinal: toOrdinal === rowCount,
  });
}

function opened(): TranscriptWindow {
  let window = snapshot(emptyTranscriptWindow(), 1, INITIAL_ROW_COUNT);
  for (let from = 0; from < INITIAL_ROW_COUNT; from += CHUNK_ROWS) {
    window = chunk(window, from, INITIAL_ROW_COUNT);
  }
  return window;
}

/** The folds one send delivers, in order, each applied to the last. */
function sendFolds(
  epoch: number,
  rowCount: number,
): ((window: TranscriptWindow) => TranscriptWindow)[] {
  const folds: ((window: TranscriptWindow) => TranscriptWindow)[] = [
    (window) =>
      applyIndexChange(window, {
        activeTurnId: null,
        epoch,
        rowCount,
        indexRevision: 1,
        changes: [{ type: "reindexed" }],
      }),
    (window) => chunk(window, 0, rowCount),
    (window) => snapshot(window, epoch, rowCount),
  ];
  for (let from = 0; from < rowCount; from += CHUNK_ROWS) {
    folds.push((window) => chunk(window, from, rowCount));
  }
  return folds;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function scrollNode(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-testid="chat-messages-scroll"]',
  );
}

/** Rows keep their ordinal through a send (it appends), so the ordinal finds
 *  the row whatever key the projection gave it. */
function rowElement(id: string): HTMLElement | null {
  const ordinal = id.slice("row-".length);
  return document.querySelector<HTMLElement>(
    `[data-testid="chat-transcript-placeholder-row"][data-ordinal="${ordinal}"]`,
  );
}

function anchorOffset(id: string): number | null {
  const node = scrollNode();
  const row = rowElement(id);
  if (node === null || row === null) return null;
  return row.getBoundingClientRect().top - node.getBoundingClientRect().top;
}

export function Fixture() {
  const [transcriptWindow, setTranscriptWindow] =
    useState<TranscriptWindow>(opened);
  const windowRef = useRef(transcriptWindow);
  const subagentDrillIn = useSubagentDrillIn(true);

  useLayoutEffect(() => {
    windowRef.current = transcriptWindow;
  }, [transcriptWindow]);

  useLayoutEffect(() => {
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
    const mirrorFollowing = (): void => {
      const mode = scrollNode()?.dataset.scrollMode;
      if (mode !== undefined) {
        document.body.dataset.following = String(mode === "following-end");
      }
    };
    const observer = new MutationObserver(mirrorFollowing);
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-scroll-mode"],
    });
    mirrorFollowing();

    let sends = 0;
    Object.assign(window, {
      __sendThroughVoid: async (): Promise<void> => {
        sends += 1;
        const folds = sendFolds(1 + sends, windowRef.current.rowCount + 1);
        for (const fold of folds) {
          setTranscriptWindow((current) => fold(current));
          await nextFrame();
          await nextFrame();
        }
      },
      __scrollRowTo: async (id: string, offset: number): Promise<void> => {
        const node = scrollNode();
        if (node === null) throw new Error("no scroll node");
        // A row outside the rendered window has no element: jump to its share
        // of the scroll range, page toward it until it renders, then place it.
        const ordinal = Number(id.slice("row-".length));
        node.scrollTop =
          (node.scrollHeight * ordinal) / windowRef.current.rowCount;
        for (let attempt = 0; attempt < 120; attempt += 1) {
          await nextFrame();
          await nextFrame();
          const current = anchorOffset(id);
          if (current !== null && Math.abs(current - offset) <= 1) return;
          if (current !== null) {
            node.scrollTop += current - offset;
            continue;
          }
          const top = node.getBoundingClientRect().top;
          const firstVisible = Array.from(
            document.querySelectorAll<HTMLElement>("[data-ordinal]"),
          ).find((element) => {
            const rect = element.getBoundingClientRect();
            return rect.bottom > top && rect.top < top + node.clientHeight;
          });
          const visibleOrdinal = Number(firstVisible?.dataset.ordinal ?? 0);
          node.scrollTop +=
            visibleOrdinal > ordinal ? -node.clientHeight : node.clientHeight;
        }
        throw new Error(`could not place ${id}`);
      },
      __anchorOffset: anchorOffset,
      __geometry: () => {
        const node = scrollNode();
        if (node === null) return null;
        return {
          scrollTop: node.scrollTop,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
        };
      },
    });
    return () => {
      observer.disconnect();
      document.removeEventListener("touchmove", swallowTouchMove, {
        capture: true,
      });
    };
  }, []);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatMessages
          taskTitle="Send through the transcript void"
          taskId={EPIC_ID}
          epicId={EPIC_ID}
          hostId={null}
          messages={[]}
          transcriptWindow={transcriptWindow}
          onVisibleOrdinalRangeChange={() => undefined}
          onFindReadOrdinalChange={() => undefined}
          baselineEpoch={0}
          hydrationSequence={0}
          coldRewrittenMessageIds={new Set()}
          backgroundItems={undefined}
          getMessageActions={() => null}
          nextStepActions={null}
          instanceId={EPIC_ID}
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

const container = document.querySelector("#root");
if (container === null) throw new Error("fixture root missing");
createRoot(container).render(<Fixture />);
