import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

/**
 * The chat transcript's list (`LegendList`, `maintainVisibleContentPosition`)
 * holding eighty rows of 100px. `window.__growRow(index, by)` grows one row,
 * which the list measures and, for a row above the view, compensates with a
 * scroll adjust. `window.__pendingLog` is every value the list's pending
 * adjust term (`scrollAdjustPending`) has taken, in order: the term an adjust
 * waits in while a touch scroll owns the scroller. The scroller is
 * `[data-testid=list]`; each row is `[data-row=row-<index>]`.
 * `browser-tests/legend-list-touch-fling-adjust.spec.ts` drives it with touch
 * input and scroll reports.
 */
declare global {
  interface Window {
    __growRow?: (index: number, by: number) => void;
    __pendingLog?: number[];
  }
}

interface Row {
  readonly id: string;
  readonly height: number;
}

const ROWS: readonly Row[] = Array.from({ length: 80 }, (_, index) => ({
  id: `row-${String(index)}`,
  height: 100,
}));

export function Harness() {
  const [rows, setRows] = useState<readonly Row[]>(ROWS);
  const listRef = useRef<LegendListRef>(null);
  useEffect(() => {
    window.__growRow = (index, by) => {
      setRows((current) =>
        current.map((row, i) =>
          i === index ? { ...row, height: row.height + by } : row,
        ),
      );
    };
    const log: number[] = [];
    window.__pendingLog = log;
    const unlisten = listRef.current
      ?.getState()
      .listen("scrollAdjustPending", (value) => {
        if (typeof value === "number") log.push(value);
      });
    return () => {
      unlisten?.();
      Reflect.deleteProperty(window, "__growRow");
      Reflect.deleteProperty(window, "__pendingLog");
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
          {item.id}
        </div>
      )}
      estimatedItemSize={100}
      maintainVisibleContentPosition
      style={{ height: 400 }}
      data-testid="list"
    />
  );
}

const container = document.getElementById("root");
if (container !== null) {
  createRoot(container).render(<Harness />);
}
