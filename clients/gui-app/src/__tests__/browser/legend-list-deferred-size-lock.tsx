import {
  LegendList,
  type LegendListRef,
  type MaintainVisibleContentPositionConfig,
} from "@legendapp/list/react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { isRecord } from "@/lib/editor/prosemirror-json";

/**
 * The chat transcript's list (`LegendList`) holding sixty rows of 100px, with
 * the transcript's `maintainVisibleContentPosition` choice: the data channel
 * is on for a commit that changes the row keys and off for a content-only
 * commit. A structural commit arms the list's anchor lock; while it is held, a
 * row's size change is left for an animation frame.
 *
 * The scroller is `[data-testid=list]`, each row `[data-row=row-<n>]`. Each
 * `window.__*` function is the page's handle on one step; the spec
 * (`browser-tests/legend-list-deferred-size-lock.spec.ts`) composes them.
 *
 * `__resizeRow` changes a row's height on its element with no React commit,
 * so the list's ResizeObserver is the only one to hear of it. The observer
 * runs after a frame's animation-frame callbacks, so the frame the list defers
 * to is the next one, and scroll events are dispatched before that frame's
 * callbacks. `__arm` uses both to put a reader's scroll and a release between
 * the deferral and its frame without a timer: the measured row's
 * `onItemSizeChanged` queues a microtask, which runs once the measure has
 * deferred its pass and before the frame.
 */

/** What an armed run does once the measure has deferred its pass. */
type Release =
  | "none"
  | "content-commit"
  | "expire-lock"
  | "cancel-pending-scroll"
  | "unmount"
  | "replace-all"
  | "remove-anchor-row";

interface ArmPlan {
  /** The row whose size change starts the sequence. */
  readonly rowIndex: number;
  /** How far the reader scrolls up after the release; 0 for no scroll. */
  readonly readerDelta: number;
  readonly release: Release;
}

/** The list's anchor lock and deferred frame, read from its internal state. */
interface ListView {
  readonly lock: { readonly id: string } | null;
  /** Whether the deferred size pass ("mvcpRecalculate") waits for its frame. */
  readonly framePending: boolean;
}

declare global {
  interface Window {
    /** One structural commit: a row appended below the view. Arms the lock. */
    __structural?: () => void;
    /** One content-only commit: the last row's label changes, keys unchanged. */
    __contentCommit?: () => void;
    /** Sets one row's height on its element, with no React commit. */
    __resizeRow?: (index: number, height: number) => void;
    /** One-shot: runs `plan` when `plan.rowIndex`'s size change is measured. */
    __arm?: (plan: ArmPlan) => void;
    /** Scrolls the scroller up by `delta`; resolves on its next scroll event. */
    __readerScroll?: (delta: number) => Promise<void>;
    /** The lock and the deferred frame now; null when the list is gone. */
    __listView?: () => ListView | null;
    /** `__listView()` when the armed sequence started, after the deferral. */
    __armed?: ListView | null;
    /** True once the armed sequence has run its release. */
    __released?: boolean;
  }
}

interface Row {
  readonly id: string;
  readonly height: number;
  readonly label: string;
}

interface Rows {
  readonly rows: readonly Row[];
  /** Whether the commit that produced `rows` changed the row keys. */
  readonly structural: boolean;
}

const INITIAL_ROWS: readonly Row[] = Array.from({ length: 60 }, (_, index) => ({
  id: `row-${String(index)}`,
  height: 100,
  label: `row ${String(index)}`,
}));

const MVCP_WITH_DATA: MaintainVisibleContentPositionConfig<Row> = {
  data: true,
  size: true,
};
const MVCP_SIZE_ONLY: MaintainVisibleContentPositionConfig<Row> = {
  data: false,
  size: true,
};

function scrollerNode(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="list"]');
}

// The list keeps its internal state in a ref one of the scroll node's
// ancestors holds.
function listState(node: HTMLElement): Record<string, unknown> | null {
  const fiberKey = Object.keys(node).find((key) =>
    key.startsWith("__reactFiber$"),
  );
  if (fiberKey === undefined) return null;
  let fiber: unknown = Reflect.get(node, fiberKey);
  while (isRecord(fiber)) {
    let hook: unknown = fiber.memoizedState;
    while (isRecord(hook)) {
      const ref: unknown = hook.memoizedState;
      const current: unknown = isRecord(ref) ? ref.current : undefined;
      if (isRecord(current) && "scrollAdjustHandler" in current) {
        return current;
      }
      hook = hook.next;
    }
    fiber = fiber.return;
  }
  return null;
}

function readListView(): ListView | null {
  const node = scrollerNode();
  const state = node === null ? null : listState(node);
  if (state === null) return null;
  const lock: unknown = state.mvcpAnchorLock;
  const work: unknown = state.scheduledWork;
  return {
    lock:
      isRecord(lock) && typeof lock.id === "string" ? { id: lock.id } : null,
    framePending:
      isRecord(work) &&
      typeof work.has === "function" &&
      Reflect.apply(work.has, work, ["mvcpRecalculate"]) === true,
  };
}

/** Ends the lock's lifetime now, as if it had not been refreshed for 300 ms. */
function expireLock(node: HTMLElement): void {
  const lock: unknown = listState(node)?.mvcpAnchorLock;
  if (!isRecord(lock)) throw new Error("no anchor lock to expire");
  Reflect.set(lock, "expiresAt", 0);
}

let root: Root | null = null;

export function Harness() {
  const [{ rows, structural }, setRows] = useState<Rows>({
    rows: INITIAL_ROWS,
    structural: false,
  });
  const listRef = useRef<LegendListRef>(null);
  const nextId = useRef(INITIAL_ROWS.length);
  const plan = useRef<ArmPlan | null>(null);
  const afterMeasure = useRef<((armed: ArmPlan) => void) | null>(null);

  useEffect(() => {
    const contentCommit = (): void => {
      flushSync(() => {
        setRows((current) => ({
          rows: current.rows.map((row, index) =>
            index === current.rows.length - 1
              ? { ...row, label: `${row.label}!` }
              : row,
          ),
          structural: false,
        }));
      });
    };
    const replaceRows = (
      next: (current: readonly Row[]) => readonly Row[],
    ): void => {
      flushSync(() => {
        setRows((current) => ({ rows: next(current.rows), structural: true }));
      });
    };
    afterMeasure.current = (armed) => {
      const node = scrollerNode();
      if (node === null) throw new Error("no scroller");
      const view = readListView();
      window.__armed = view;
      switch (armed.release) {
        case "none":
          break;
        case "content-commit":
          // Registered after the list's own scroll listener, so the commit
          // follows the list's re-layout for the reader's scroll.
          node.addEventListener(
            "scroll",
            () => {
              queueMicrotask(() => {
                contentCommit();
                window.__released = true;
              });
            },
            { once: true },
          );
          break;
        case "expire-lock":
          expireLock(node);
          break;
        case "cancel-pending-scroll":
          listRef.current?.cancelPendingScroll();
          break;
        case "replace-all":
          replaceRows(() =>
            INITIAL_ROWS.map((row) => ({ ...row, id: `fresh-${row.id}` })),
          );
          break;
        case "remove-anchor-row": {
          const anchorId = view?.lock?.id;
          if (anchorId === undefined) throw new Error("no anchor lock");
          replaceRows((current) =>
            current.filter((row) => row.id !== anchorId),
          );
          break;
        }
        case "unmount":
          root?.unmount();
          root = null;
          break;
      }
      if (armed.readerDelta > 0) node.scrollTop -= armed.readerDelta;
      if (armed.release !== "content-commit") window.__released = true;
    };
    window.__structural = () => {
      replaceRows((current) => {
        const id = `row-${String(nextId.current)}`;
        nextId.current += 1;
        return [...current, { id, height: 100, label: id }];
      });
    };
    window.__contentCommit = contentCommit;
    window.__resizeRow = (index, height) => {
      const row = document.querySelector<HTMLElement>(
        `[data-row="row-${String(index)}"]`,
      );
      if (row === null) throw new Error(`row ${String(index)} is not mounted`);
      row.style.height = `${String(height)}px`;
    };
    window.__arm = (armed) => {
      window.__armed = null;
      window.__released = false;
      plan.current = armed;
    };
    window.__readerScroll = (delta) =>
      new Promise((resolve) => {
        const node = scrollerNode();
        if (node === null) throw new Error("no scroller");
        node.addEventListener("scroll", () => resolve(), { once: true });
        node.scrollTop -= delta;
      });
    window.__listView = readListView;
    return () => {
      afterMeasure.current = null;
    };
  }, []);

  return (
    <LegendList<Row>
      ref={listRef}
      data={rows}
      keyExtractor={(row) => row.id}
      renderItem={({ item }) => (
        <div
          data-row={item.id}
          style={{
            height: item.height,
            boxSizing: "border-box",
            borderBottom: "1px solid #ccc",
            padding: 8,
          }}
        >
          {item.label}
        </div>
      )}
      estimatedItemSize={100}
      drawDistance={500}
      maintainVisibleContentPosition={
        structural ? MVCP_WITH_DATA : MVCP_SIZE_ONLY
      }
      onItemSizeChanged={(info) => {
        const armed = plan.current;
        if (
          armed === null ||
          info.itemKey !== `row-${String(armed.rowIndex)}`
        ) {
          return;
        }
        plan.current = null;
        queueMicrotask(() => afterMeasure.current?.(armed));
      }}
      style={{ height: 400 }}
      data-testid="list"
    />
  );
}

const container = document.getElementById("root");
if (container !== null) {
  root = createRoot(container);
  root.render(<Harness />);
}
