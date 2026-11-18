import type { Page } from "@playwright/test";

/**
 * What a reader sees break when the transcript list's size bookkeeping goes
 * wrong, sampled on every animation frame from the list's own state:
 *
 * - a running size average (`averageSizes`) at or below zero, which gives
 *   every unmeasured row a zero or negative height;
 * - two mounted rows inside the viewport whose vertical extents intersect, or
 *   whose top order disagrees with their order in the transcript;
 * - a content height (`totalSize`) below the sum of the heights the list has
 *   already measured (`sizesKnown`).
 *
 * The list keeps its state in a React context a mounted row can reach through
 * its fiber (the same route `chat-scroll-p6-proof.spec.ts` takes to the
 * list's state ref). A frame the context cannot be found for is not sampled.
 */

/** Overlap of two rows' vertical extents that is more than subpixel layout. */
const OVERLAP_PX = 1;

export interface OverlapReport {
  readonly frames: number;
  readonly negativeAverageFrames: number;
  readonly overlapFrames: number;
  readonly shortContentFrames: number;
  /** The first sampled frame of each kind, in full; `null` when none. */
  readonly firstNegativeAverage: string | null;
  readonly firstOverlap: string | null;
  readonly firstShortContent: string | null;
}

declare global {
  interface Window {
    /** Written by `startOverlapWatch`; stops the sampling and reports. */
    __chatScrollOverlapStop?: () => OverlapReport;
  }
}

export async function startOverlapWatch(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__chatScrollOverlapStop?.();
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null;
    const numberOf = (value: unknown): number | null =>
      typeof value === "number" ? value : null;

    interface ListContext {
      readonly values: Map<unknown, unknown>;
      readonly viewRefs: Map<unknown, unknown>;
      readonly state: Record<string, unknown>;
    }
    const asContext = (value: unknown): ListContext | null => {
      if (!isRecord(value)) return null;
      const { values, viewRefs, state } = value;
      if (values instanceof Map && viewRefs instanceof Map && isRecord(state)) {
        return { values, viewRefs, state };
      }
      return null;
    };
    const elementOf = (ref: unknown): HTMLElement | null => {
      if (!isRecord(ref)) return null;
      const current = ref.current;
      return current instanceof HTMLElement && current.isConnected
        ? current
        : null;
    };
    const containers = (context: ListContext): Map<unknown, HTMLElement> => {
      const found = new Map<unknown, HTMLElement>();
      for (const [id, ref] of context.viewRefs) {
        const element = elementOf(ref);
        if (element !== null) found.set(id, element);
      }
      return found;
    };
    const findContext = (): ListContext | null => {
      const row = document.querySelector<HTMLElement>(
        '[data-testid="chat-messages-scroll"] [data-row-key], [data-testid="chat-messages-scroll"] [data-testid="chat-transcript-placeholder-row"]',
      );
      if (row === null) return null;
      const fiberKey = Object.keys(row).find((key) =>
        key.startsWith("__reactFiber$"),
      );
      if (fiberKey === undefined) return null;
      let fiber: unknown = Reflect.get(row, fiberKey);
      while (isRecord(fiber)) {
        const props = fiber.memoizedProps;
        const context = isRecord(props) ? asContext(props.value) : null;
        if (context !== null) return context;
        fiber = fiber.return;
      }
      return null;
    };

    let context: ListContext | null = null;
    let running = true;
    let frames = 0;
    let negativeAverageFrames = 0;
    let overlapFrames = 0;
    let shortContentFrames = 0;
    let firstNegativeAverage: string | null = null;
    let firstOverlap: string | null = null;
    let firstShortContent: string | null = null;

    const negativeAverages = (state: Record<string, unknown>): string[] => {
      const averages = state.averageSizes;
      if (!isRecord(averages)) return [];
      const negative: string[] = [];
      for (const [type, entry] of Object.entries(averages)) {
        if (!isRecord(entry)) continue;
        const avg = numberOf(entry.avg);
        const num = numberOf(entry.num);
        if (avg !== null && num !== null && num > 0 && avg <= 0) {
          negative.push(`${type}=${avg.toFixed(0)}/${String(num)}`);
        }
      }
      return negative;
    };

    interface Row {
      readonly key: string;
      readonly index: number;
      readonly top: number;
      readonly height: number;
      readonly viewportTop: number;
    }
    const mountedRows = (list: ListContext, scrollNode: HTMLElement): Row[] => {
      const nodeTop = scrollNode.getBoundingClientRect().top;
      const rows: Row[] = [];
      for (const [id, element] of containers(list)) {
        const key = list.values.get(`containerItemKey${String(id)}`);
        const index = numberOf(
          list.values.get(`containerItemIndex${String(id)}`),
        );
        const position = numberOf(
          list.values.get(`containerPosition${String(id)}`),
        );
        // A recycled container parked off screen carries a huge negative
        // position; it is not a row on screen.
        if (
          typeof key !== "string" ||
          index === null ||
          position === null ||
          position <= -1e6 ||
          element.offsetHeight === 0
        ) {
          continue;
        }
        rows.push({
          key,
          index,
          top: element.offsetTop,
          height: element.offsetHeight,
          viewportTop: element.getBoundingClientRect().top - nodeTop,
        });
      }
      return rows;
    };

    const describeRow = (row: Row): string =>
      `${row.key}[idx=${String(row.index)} top=${row.top.toFixed(0)} h=${String(row.height)}]`;

    const visibleProblem = (rows: readonly Row[], clientHeight: number) => {
      const visible = rows
        .filter(
          (row) =>
            row.viewportTop < clientHeight && row.viewportTop + row.height > 0,
        )
        .sort((a, b) => a.index - b.index);
      for (let i = 1; i < visible.length; i += 1) {
        const above = visible[i - 1];
        const below = visible[i];
        if (below.top + 0.5 < above.top) {
          return `order ${describeRow(above)} then ${describeRow(below)}`;
        }
      }
      // Rows far apart in the transcript can be stacked too: compare every
      // pair, not just neighbours.
      for (let i = 0; i < visible.length; i += 1) {
        for (let j = i + 1; j < visible.length; j += 1) {
          const a = visible[i];
          const b = visible[j];
          const overlap =
            Math.min(a.top + a.height, b.top + b.height) -
            Math.max(a.top, b.top);
          if (overlap > OVERLAP_PX) {
            return `overlap ${overlap.toFixed(0)}px ${describeRow(a)} and ${describeRow(b)}`;
          }
        }
      }
      return null;
    };

    const sumOf = (sizes: unknown): number | null => {
      if (!(sizes instanceof Map)) return null;
      let sum = 0;
      for (const size of sizes.values()) {
        const n = numberOf(size);
        if (n !== null) sum += n;
      }
      return sum;
    };

    const tick = (): void => {
      if (!running) return;
      requestAnimationFrame(tick);
      const scrollNode = document.querySelector<HTMLElement>(
        '[data-testid="chat-messages-scroll"]',
      );
      if (scrollNode === null || scrollNode.clientHeight === 0) return;
      if (context === null || containers(context).size === 0) {
        context = findContext();
      }
      if (context === null) return;
      const list = context;
      frames += 1;
      const where = `scrollTop=${scrollNode.scrollTop.toFixed(0)} scrollHeight=${String(scrollNode.scrollHeight)} clientHeight=${String(scrollNode.clientHeight)}`;

      const negative = negativeAverages(list.state);
      if (negative.length > 0) {
        negativeAverageFrames += 1;
        firstNegativeAverage ??= `frame ${String(frames)} averages ${negative.join(" ")} ${where}`;
      }

      const problem = visibleProblem(
        mountedRows(list, scrollNode),
        scrollNode.clientHeight,
      );
      if (problem !== null) {
        overlapFrames += 1;
        firstOverlap ??= `frame ${String(frames)} ${problem} ${where}`;
      }

      const totalSize = numberOf(list.values.get("totalSize"));
      const measured = sumOf(list.state.sizesKnown);
      if (totalSize !== null && measured !== null && totalSize + 1 < measured) {
        shortContentFrames += 1;
        firstShortContent ??= `frame ${String(frames)} totalSize=${totalSize.toFixed(0)} below measured ${measured.toFixed(0)} ${where}`;
      }
    };
    requestAnimationFrame(tick);

    window.__chatScrollOverlapStop = () => {
      running = false;
      return {
        frames,
        negativeAverageFrames,
        overlapFrames,
        shortContentFrames,
        firstNegativeAverage,
        firstOverlap,
        firstShortContent,
      };
    };
  });
}

export async function stopOverlapWatch(page: Page): Promise<OverlapReport> {
  const report = await page.evaluate(() => {
    const stop = window.__chatScrollOverlapStop;
    return stop === undefined ? null : stop();
  });
  if (report === null) throw new Error("no overlap watch was started");
  return report;
}
