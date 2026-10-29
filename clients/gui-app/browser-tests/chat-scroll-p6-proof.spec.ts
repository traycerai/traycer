import { expect, test, type Page } from "@playwright/test";
import { PICK_OFFSET_PX } from "./support/chat-scroll-oracle";
import { fixture, nextFrames } from "./support/fixtures";

/**
 * P6 and P6b, as claims a painted frame can decide.
 *
 * P6: a wheel while a reopened chat's restore command waits in the list for
 * its layout to settle. The list must not run that command after the wheel,
 * and what the reader sees moves by the wheel's own travel and nothing else.
 * While the command is held nothing may be painted under the edge yet; the
 * reference is then the first element painted there after the wheel.
 *
 * P6b: a minimap pick during a stream, with and without a wheel right after
 * it. When the list finishes that scroll it re-lays out every row. The reader
 * then sees what they asked for: the picked turn at its landing offset, or,
 * when a wheel interrupted the pick first, what they were reading at that
 * wheel.
 *
 * "What the reader is reading" is the deepest element under the viewport's
 * top edge in the last frame painted before the wheel: the layout at the
 * wheel itself may never have been painted. Positions are read once per
 * frame as it is painted: a rAF resizes a probe element, and the
 * ResizeObserver callback that reports it runs after that frame's layout and
 * before its paint.
 */

const SCROLL = '[data-testid="chat-messages-scroll"]';
/** What should not have moved: subpixel layout only. */
const HELD_PX = 1;
const DIRECTIONS = ["away", "toward-end"] as const;
type Direction = (typeof DIRECTIONS)[number];

interface ProofRow {
  readonly key: string;
  readonly top: number;
}

interface ProofSample {
  readonly t: number;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly rows: ReadonlyArray<ProofRow>;
  /** The top of the reference element: the one under the edge in the last
   *  frame painted before the first wheel. `null` before that wheel, and
   *  once it left the document. */
  readonly edgeTop: number | null;
}

/** The reference as the reader last saw it before a wheel. */
interface ProofPainted {
  readonly t: number;
  readonly scrollTop: number;
  readonly top: number;
}

interface ProofWheel {
  readonly t: number;
  readonly deltaY: number;
  readonly scrollTop: number;
  /** Whether the list held an imperative scroll command at the wheel. */
  readonly held: boolean | null;
  readonly edge: string;
  /** `null` when no frame was painted with an element under the edge. */
  readonly painted: ProofPainted | null;
}

/** The list's own write when it finishes a scroll. */
interface ProofCheckpoint {
  readonly t: number;
  readonly scrollTop: number;
}

/** A programmatic scroll write: everything else that moves `scrollTop` is
 *  the reader's own scrolling. */
interface ProofWrite {
  readonly t: number;
  readonly before: number;
  readonly after: number;
  /** The functions that made it, innermost first. */
  readonly by: string;
}

interface P6Recorder {
  readonly notes: Array<{ readonly t: number; readonly line: string }>;
  readonly writes: ProofWrite[];
  readonly wheels: ProofWheel[];
  readonly samples: ProofSample[];
  readonly checkpoints: ProofCheckpoint[];
  /** When the first wheel came with nothing under the edge painted: the
   *  first element painted there after it. */
  readonly paintedAfterWheel: ProofPainted[];
  readonly note: (line: string) => void;
  /** Samples every painted frame for `ms`, and logs every scroll write and
   *  re-layout. */
  readonly watch: (ms: number) => void;
}

declare global {
  interface Window {
    __p6Proof?: P6Recorder;
  }
}

/** Installed before any page script. */
function installP6Recorder(): void {
  const selector = '[data-testid="chat-messages-scroll"]';
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;
  const scrollNode = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(selector);
  const rowsOnScreen = (node: HTMLElement): ProofRow[] => {
    const box = node.getBoundingClientRect();
    const rows: ProofRow[] = [];
    for (const element of node.querySelectorAll<HTMLElement>(
      "[data-row-key]",
    )) {
      const rect = element.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom) {
        rows.push({
          key: element.dataset.rowKey ?? "?",
          top: rect.top - box.top,
        });
      }
    }
    return rows;
  };
  // The deepest element under the viewport's top edge: the row spanning the
  // edge, then at each level the first child that reaches below it.
  const edgeElement = (node: HTMLElement): Element | null => {
    const edgeY = node.getBoundingClientRect().top;
    const row = Array.from(node.querySelectorAll("[data-row-key]")).find(
      (element) => {
        const rect = element.getBoundingClientRect();
        return rect.top <= edgeY && rect.bottom > edgeY;
      },
    );
    if (row === undefined) return null;
    let current = row;
    for (;;) {
      const next = Array.from(current.children).find((child) => {
        const rect = child.getBoundingClientRect();
        return rect.height > 0 && rect.bottom > edgeY;
      });
      if (next === undefined) return current;
      if (next.getBoundingClientRect().top > edgeY) return next;
      current = next;
    }
  };
  const describe = (element: Element): string => {
    const row = element.closest<HTMLElement>("[data-row-key]");
    const text = element.textContent.trim().slice(0, 24);
    return `<${element.tagName.toLowerCase()}> in ${row?.dataset.rowKey ?? "?"} "${text}"`;
  };
  // The list keeps its internal state in a ref one of the scroll node's
  // ancestors holds.
  const listState = (node: HTMLElement): Record<string, unknown> | null => {
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
  };
  // Its `scheduledWork` says whether a command waits.
  const readHeld = (node: HTMLElement): boolean | null => {
    const state = listState(node);
    const work: unknown = state?.scheduledWork;
    if (state === null || !isRecord(work) || typeof work.has !== "function")
      return null;
    return (
      Reflect.apply(work.has, work, ["imperativeScrollReady"]) === true ||
      state.pendingScrollToEnd !== undefined
    );
  };
  // What its next anchored adjustment holds still: a scroll target, then an
  // anchor lock, then the row under the top edge.
  const readAnchor = (node: HTMLElement): string => {
    const state = listState(node);
    const scrollingTo: unknown = state?.scrollingTo;
    const lock: unknown = state?.mvcpAnchorLock;
    const target = isRecord(scrollingTo)
      ? `scrollingTo{index:${String(scrollingTo.index)},animated:${String(scrollingTo.animated)}}`
      : "scrollingTo=none";
    return `${target} anchorLock=${isRecord(lock) ? String(lock.id) : "none"}`;
  };
  const callers = (): string =>
    (new Error().stack ?? "")
      .split("\n")
      .slice(3, 11)
      .map((line) => /at (?:Object\.)?([\w$.<>]+) /.exec(line.trim())?.[1])
      .filter((name): name is string => name !== undefined)
      .join(" < ");
  const notes: Array<{ readonly t: number; readonly line: string }> = [];
  const writes: ProofWrite[] = [];
  const wheels: ProofWheel[] = [];
  const samples: ProofSample[] = [];
  const checkpoints: ProofCheckpoint[] = [];
  let edge: Element | null = null;
  const topIn = (element: Element | null, node: HTMLElement): number | null =>
    element === null || !element.isConnected
      ? null
      : element.getBoundingClientRect().top - node.getBoundingClientRect().top;
  // The last painted frame: its scroll position, the element under its edge
  // and where the reference element sat in it.
  let lastFrame: {
    readonly t: number;
    readonly scrollTop: number;
    readonly under: Element | null;
    readonly underTop: number | null;
    readonly edgeTop: number | null;
  } | null = null;
  const paintedAfterWheel: ProofPainted[] = [];
  const note = (line: string): void => {
    notes.push({ t: performance.now(), line });
  };
  window.addEventListener(
    "wheel",
    (event) => {
      const node = scrollNode();
      if (node === null) return;
      if (edge === null && lastFrame !== null) edge = lastFrame.under;
      let top: number | null = null;
      if (edge !== null && lastFrame !== null) {
        top = edge === lastFrame.under ? lastFrame.underTop : lastFrame.edgeTop;
      }
      wheels.push({
        t: performance.now(),
        deltaY: event.deltaY,
        scrollTop: node.scrollTop,
        held: readHeld(node),
        edge: `${edge === null ? "none" : describe(edge)} [${readAnchor(node)}]`,
        painted:
          top === null || lastFrame === null
            ? null
            : { t: lastFrame.t, scrollTop: lastFrame.scrollTop, top },
      });
    },
    { capture: true },
  );
  const watch = (ms: number): void => {
    const node = scrollNode();
    if (node === null) throw new Error("no scroll node");
    const scrollTo = node.scrollTo.bind(node);
    Object.defineProperty(node, "scrollTo", {
      configurable: true,
      value: (...args: unknown[]): void => {
        const before = node.scrollTop;
        Reflect.apply(scrollTo, node, args);
        const by = callers();
        writes.push({
          t: performance.now(),
          before,
          after: node.scrollTop,
          by,
        });
        note(
          `write scrollTo ${JSON.stringify(args)} ${String(before)} -> ${String(node.scrollTop)} by ${by} [${readAnchor(node)}]`,
        );
        if ((new Error().stack ?? "").includes("finishScrollTo")) {
          checkpoints.push({ t: performance.now(), scrollTop: node.scrollTop });
        }
      },
    });
    const scrollTop = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollTop",
    );
    const get = scrollTop?.get?.bind(node);
    const set = scrollTop?.set?.bind(node);
    if (get !== undefined && set !== undefined) {
      Object.defineProperty(node, "scrollTop", {
        configurable: true,
        get: (): unknown => Reflect.apply(get, node, []),
        set: (value: number): void => {
          const before = node.scrollTop;
          Reflect.apply(set, node, [value]);
          const by = callers();
          writes.push({
            t: performance.now(),
            before,
            after: node.scrollTop,
            by,
          });
          note(
            `write scrollTop=${String(value)} ${String(before)} -> ${String(node.scrollTop)} by ${by}`,
          );
        },
      });
    }
    // The list's re-layouts, with what their anchored adjustment holds still.
    const state = listState(node);
    const calculate: unknown = state?.triggerCalculateItemsInView;
    if (state !== null && typeof calculate === "function") {
      state.triggerCalculateItemsInView = (...args: unknown[]): unknown => {
        note(
          `re-layout ${JSON.stringify(args)} at scrollTop ${String(node.scrollTop)} h ${String(node.scrollHeight)} by ${callers()} [${readAnchor(node)}]`,
        );
        const result: unknown = Reflect.apply(calculate, state, args);
        return result;
      };
    }
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;left:-10px;top:-10px;width:1px;height:1px;pointer-events:none";
    document.body.append(probe);
    const resize = new ResizeObserver(() => {
      const t = performance.now();
      const under = edgeElement(node);
      const underTop = topIn(under, node);
      if (edge === null && wheels.length > 0 && underTop !== null) {
        edge = under;
        paintedAfterWheel.push({ t, scrollTop: node.scrollTop, top: underTop });
      }
      const sample = {
        t,
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        rows: rowsOnScreen(node),
        edgeTop: topIn(edge, node),
      };
      samples.push(sample);
      lastFrame = {
        t,
        scrollTop: sample.scrollTop,
        under,
        underTop,
        edgeTop: sample.edgeTop,
      };
    });
    resize.observe(probe);
    const startedAt = performance.now();
    let frame = 0;
    const tick = (): void => {
      frame += 1;
      probe.style.width = `${String(1 + (frame % 2))}px`;
      if (performance.now() - startedAt < ms) {
        requestAnimationFrame(tick);
      } else {
        resize.disconnect();
      }
    };
    requestAnimationFrame(tick);
  };
  window.__p6Proof = {
    notes,
    writes,
    wheels,
    samples,
    checkpoints,
    paintedAfterWheel,
    note,
    watch,
  };
}

interface Recorded {
  readonly notes: ReadonlyArray<{ readonly t: number; readonly line: string }>;
  readonly writes: ReadonlyArray<ProofWrite>;
  readonly wheels: ReadonlyArray<ProofWheel>;
  readonly samples: ReadonlyArray<ProofSample>;
  readonly checkpoints: ReadonlyArray<ProofCheckpoint>;
  readonly paintedAfterWheel: ReadonlyArray<ProofPainted>;
}

async function readRecorder(page: Page): Promise<Recorded> {
  return page.evaluate(() => {
    const recorder = window.__p6Proof;
    if (recorder === undefined) throw new Error("no recorder");
    return {
      notes: recorder.notes,
      writes: recorder.writes,
      wheels: recorder.wheels,
      samples: recorder.samples,
      checkpoints: recorder.checkpoints,
      paintedAfterWheel: recorder.paintedAfterWheel,
    };
  });
}

/** Prints a measurement and keeps it on the test's annotations. */
function report(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  process.stdout.write(`${type}: ${description}\n`);
}

interface Deviation {
  /** The largest |top - expected| over the painted frames measured; a
   *  reference that left the document counts as Infinity. */
  readonly max: number;
  readonly worst: string;
  readonly frames: number;
}

interface DeviationQuery {
  readonly recorded: Recorded;
  /** When the reference was read, and the `scrollTop` it was read at. */
  readonly from: number;
  readonly fromScrollTop: number;
  readonly untilMs: number;
  /** Where the reference should sit while the reader does not scroll. */
  readonly expected: number;
  /** Reads the reference in a frame: `null` is gone. */
  readonly topOf: (sample: ProofSample) => number | null;
}

/**
 * How far a reference strayed over the painted frames in
 * `(from, from + untilMs]` from `expected` moved by the reader's own
 * scrolling since `from`: every `scrollTop` change no programmatic write
 * made. A wheel's scroll can land a frame after its event, so the wheel
 * events themselves are not the travel.
 */
function deviation(query: DeviationQuery): Deviation {
  const { recorded, from, fromScrollTop, untilMs, expected, topOf } = query;
  let max = 0;
  let worst = "none";
  let frames = 0;
  for (const sample of recorded.samples) {
    if (sample.t <= from || sample.t > from + untilMs) continue;
    const written = recorded.writes
      .filter((write) => write.t > from && write.t <= sample.t)
      .reduce((sum, write) => sum + write.after - write.before, 0);
    const travel = -(sample.scrollTop - fromScrollTop - written);
    const top = topOf(sample);
    frames += 1;
    const at = `+${(sample.t - from).toFixed(1)}ms (scrollTop=${String(sample.scrollTop)} h=${String(sample.scrollHeight)} top row ${sample.rows.at(0)?.key ?? "none"})`;
    if (top === null) {
      if (max !== Number.POSITIVE_INFINITY) {
        max = Number.POSITIVE_INFINITY;
        worst = `gone at ${at}`;
      }
      continue;
    }
    const off = Math.abs(top - (expected + travel));
    if (off > max) {
      max = off;
      worst = `at ${top.toFixed(1)}, expected ${(expected + travel).toFixed(1)} (reader's travel ${travel.toFixed(1)}), ${at}`;
    }
  }
  if (frames === 0)
    return {
      max: Number.POSITIVE_INFINITY,
      worst: "no painted frame in the window",
      frames,
    };
  return { max, worst, frames };
}

function traceLines(
  recorded: Recorded,
  zero: number,
  windowMs: readonly [number, number],
): string {
  return [
    ...recorded.notes,
    ...recorded.wheels.map((wheel) => ({
      t: wheel.t,
      line: `WHEEL deltaY=${String(wheel.deltaY)} scrollTop=${String(wheel.scrollTop)} held=${String(wheel.held)} edge=${wheel.edge} ${wheel.painted === null ? "nothing painted under the edge" : `painted at ${String(wheel.painted.top)} scrollTop=${String(wheel.painted.scrollTop)} ${(wheel.t - wheel.painted.t).toFixed(1)}ms before`}`,
    })),
    ...recorded.checkpoints.map((checkpoint) => ({
      t: checkpoint.t,
      line: `FINISH scrollTop=${String(checkpoint.scrollTop)}`,
    })),
  ]
    .filter(
      (entry) => entry.t - zero >= windowMs[0] && entry.t - zero <= windowMs[1],
    )
    .sort((a, b) => a.t - b.t)
    .map(
      (entry) =>
        `  ${entry.t - zero >= 0 ? "+" : ""}${(entry.t - zero).toFixed(1)}ms ${entry.line}`,
    )
    .join("\n");
}

/** The painted frames in the window that differ from the frame before:
 *  `scrollTop`, content height, the reference's top and the first rows. */
function frameLines(
  recorded: Recorded,
  zero: number,
  windowMs: readonly [number, number],
): string {
  const lines: string[] = [];
  let last = "";
  for (const sample of recorded.samples) {
    if (sample.t - zero < windowMs[0] || sample.t - zero > windowMs[1])
      continue;
    const frame = `scrollTop=${String(sample.scrollTop)} h=${String(sample.scrollHeight)} edgeTop=${String(sample.edgeTop)} rows ${sample.rows
      .slice(0, 3)
      .map((row) => `${row.key}@${row.top.toFixed(1)}`)
      .join(" ")}`;
    if (frame === last) continue;
    last = frame;
    lines.push(
      `  ${sample.t - zero >= 0 ? "+" : ""}${(sample.t - zero).toFixed(1)}ms FRAME ${frame}`,
    );
  }
  return `  ${String(recorded.samples.filter((sample) => sample.t < zero).length)} painted frames before the wheel\n${lines.join("\n")}`;
}

function callProbe(
  page: Page,
  name: string,
  args: ReadonlyArray<number | string | boolean | object>,
): Promise<void> {
  return page.evaluate(
    ({ method, values }) => {
      const probe = window.__chatScrollProbe;
      const fn: unknown = Reflect.get(probe, method);
      if (typeof fn !== "function")
        throw new Error(`no ${method} on the probe`);
      Reflect.apply(fn, probe, values);
    },
    { method: name, values: args },
  );
}

async function pointAtTranscript(page: Page): Promise<void> {
  const box = await page.locator(SCROLL).boundingBox();
  if (box === null) throw new Error("no scroll node");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

async function wheelTwice(page: Page, direction: Direction): Promise<void> {
  const delta = direction === "away" ? -100 : 100;
  await page.mouse.wheel(0, delta);
  await page.mouse.wheel(0, delta);
}

/**
 * Reopens a chat saved free-scrolling three turns above the tail, with the
 * saved turn's reply inflated to 2x a viewport and its range request held.
 * Resolves with that request sent and unanswered.
 */
async function reopenHeld(page: Page): Promise<void> {
  const turn = 156;
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(
    `${fixture("chat-scroll-model")}?line=windowed&tailBytes=1200&mountLater=1` +
      `&shortAfterSplit=1&splitTurn=${String(turn)}&inflate=29`,
  );
  await page.waitForFunction(
    () =>
      "__chatScrollProbe" in window &&
      window.__chatScrollProbe.windowState()?.skeletonComplete === true,
    undefined,
    { polling: "raf" },
  );
  const owner = `assistant:turn-${String(turn)}`;
  await callProbe(page, "seedSaved", [
    {
      mode: "free-scrolling",
      anchorMessageId: `${owner}#message-${String(2 * turn + 1)}:text-2`,
      anchorRowKey: owner,
      anchorIndex: 2 * turn + 2,
      offset: -100,
    },
  ]);
  await callProbe(page, "holdRanges", []);
  await callProbe(page, "mountNow", []);
  await page.waitForFunction(
    () => window.__chatScrollProbe.geometry() !== null,
  );
  await page.waitForFunction(
    (wanted) =>
      window.__chatScrollProbe.frameLog().some((line) => {
        const match = /loadRange \S+ \[(\d+),(\d+)\]/.exec(line);
        return (
          match !== null &&
          Number(match[1]) <= wanted &&
          wanted <= Number(match[2])
        );
      }),
    2 * turn + 1,
    { polling: "raf", timeout: 8_000 },
  );
  await nextFrames(page, 4);
  await pointAtTranscript(page);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installP6Recorder);
});

test.describe("P6: a wheel while the reopened chat's restore command is held", () => {
  for (const direction of DIRECTIONS) {
    test(`wheel ${direction} keeps its own position`, async ({ page }) => {
      test.setTimeout(240_000);
      // The ranges are answered `lead` ms after the wheel is sent; the lead
      // varies until the wheel arrives while the list holds the restore's
      // command.
      const leads = [20, 30, 25, 15, 35, 10, 40, 28, 22, 45, 18, 50];
      for (const [attempt, lead] of leads.entries()) {
        await reopenHeld(page);
        await page.evaluate(() => window.__p6Proof?.watch(2500));
        // Painted frames before the wheel: the ranges stay held meanwhile.
        await nextFrames(page, 3);
        await callProbe(page, "releaseRangesIn", [lead]);
        await wheelTwice(page, direction);
        await page.waitForTimeout(1500);
        const recorded = await readRecorder(page);
        const first = recorded.wheels.at(0);
        if (first === undefined) throw new Error("no wheel recorded");
        // What the reader saw: the element under the edge in the last frame
        // painted before the wheel, or, when that frame showed none, the
        // first one painted after it.
        const reference =
          first.painted ?? recorded.paintedAfterWheel.at(0) ?? null;
        if (first.held !== true || reference === null) {
          report(
            "attempt",
            `${String(attempt + 1)} lead ${String(lead)}ms: command held at the wheel=${String(first.held)}`,
          );
          continue;
        }
        const moved = deviation({
          recorded,
          from: reference.t,
          fromScrollTop: reference.scrollTop,
          untilMs: 1000,
          expected: reference.top,
          topOf: (sample) => sample.edgeTop,
        });
        // The list's scroll commands write through `doScrollTo`; none may
        // run after the wheel, even before the next frame is painted.
        const commands = recorded.writes.filter(
          (write) => write.t > first.t && write.by.includes("doScrollTo"),
        );
        const seen =
          first.painted === null
            ? `nothing under the edge painted before the wheel; ${first.edge} first painted at ${reference.top.toFixed(1)} +${(reference.t - first.t).toFixed(1)}ms after it`
            : `${first.edge} painted at ${reference.top.toFixed(1)} ${(first.t - reference.t).toFixed(1)}ms before it`;
        report(
          `P6 wheel ${direction}`,
          `attempt ${String(attempt + 1)} (lead ${String(lead)}ms), command held at the wheel; ${seen}: ` +
            `max deviation ${moved.max.toFixed(1)}px over ${String(moved.frames)} painted frames; worst ${moved.worst}; ` +
            `scroll commands after the wheel: ${String(commands.length)}\n` +
            traceLines(recorded, first.t, [-80, 1000]) +
            "\n" +
            frameLines(recorded, first.t, [-400, 160]),
        );
        expect(
          commands.map(
            (write) =>
              `${String(write.before)} -> ${String(write.after)} by ${write.by}`,
          ),
          "the list ran a scroll command after the wheel",
        ).toEqual([]);
        expect(
          moved.max,
          `what the reader saw moved beyond their travel: ${moved.worst}`,
        ).toBeLessThanOrEqual(HELD_PX);
        return;
      }
      throw new Error(
        "no attempt landed the wheel while the list held the restore's command",
      );
    });
  }
});

/** When the reader wheels around a pick: 30ms after it, or not at all. The
 *  pick never interrupts itself, so a wheel on its own first scroll event is
 *  not a distinct case and is not tested. */
const PICK_WHEELS = ["then wheel away", "with no wheel"] as const;
type PickWheel = (typeof PICK_WHEELS)[number];

async function streamAndPick(
  page: Page,
  wheel: PickWheel,
): Promise<{ readonly pickedAt: number; readonly picked: string }> {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(`${fixture("chat-scroll-model")}?line=windowed`);
  await page.waitForFunction(
    () =>
      "__chatScrollProbe" in window &&
      window.__chatScrollProbe.geometry() !== null,
    undefined,
    { polling: "raf" },
  );
  await nextFrames(page, 30);
  await pointAtTranscript(page);
  const items = await page.evaluate(() => window.__chatScrollProbe.pickItems());
  const index = items.length - 6;
  await page.evaluate(() => window.__chatScrollProbe.startParagraphStream(100));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__p6Proof?.watch(2500));
  // The pick runs in the page 30ms from now and the wheel is sent from here
  // at the same time, so it reaches the page while the pick's scroll runs.
  const scheduledAt = await page.evaluate((i) => {
    window.setTimeout(() => {
      window.__p6Proof?.note(`PICK ${String(i)}`);
      window.__chatScrollProbe.pick(i);
    }, 30);
    return performance.now() + 30;
  }, index);
  await page.waitForTimeout(30);
  if (wheel === "then wheel away") await wheelTwice(page, "away");
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__chatScrollProbe.stopStream());
  return { pickedAt: scheduledAt, picked: items[index] };
}

test.describe("P6b: the re-layout after a long jump keeps what the reader sees", () => {
  for (const wheel of PICK_WHEELS) {
    test(`pick ${wheel}`, async ({ page }) => {
      const { pickedAt, picked } = await streamAndPick(page, wheel);
      const recorded = await readRecorder(page);
      const finished = recorded.checkpoints.find(
        (checkpoint) => checkpoint.t > pickedAt,
      );
      // A wheel before the finish interrupts the pick, which the list may
      // then never finish.
      const interrupted = recorded.wheels.find(
        (entry) =>
          entry.t > pickedAt &&
          (finished === undefined || entry.t < finished.t),
      );
      const header = `P6b pick ${wheel}`;
      const trace = traceLines(recorded, pickedAt, [-20, 1000]);
      let moved: Deviation;
      let what: string;
      if (interrupted === undefined) {
        if (finished === undefined) {
          report(header, `the list never finished the pick's scroll\n${trace}`);
          throw new Error("the list never finished the pick's scroll");
        }
        // The picked turn sits at its landing offset from the first frame
        // painted after the finish.
        moved = deviation({
          recorded,
          from: finished.t,
          fromScrollTop: finished.scrollTop,
          untilMs: 1000,
          expected: PICK_OFFSET_PX,
          topOf: (sample) =>
            sample.rows.find((entry) => entry.key === picked)?.top ?? null,
        });
        const firstWheel = recorded.wheels.find((entry) => entry.t > pickedAt);
        const wheelAt =
          firstWheel === undefined
            ? "no wheel"
            : `first wheel ${(firstWheel.t - finished.t).toFixed(1)}ms after the finish`;
        what = `${picked} at ${String(PICK_OFFSET_PX)}px from the finish on (${wheelAt})`;
      } else {
        // What the reader saw at the wheel holds from the wheel on.
        const reference =
          interrupted.painted ?? recorded.paintedAfterWheel.at(0) ?? null;
        if (reference === null) {
          report(
            header,
            `nothing under the edge was painted around the wheel\n${trace}`,
          );
          throw new Error(
            "nothing under the edge was painted around the wheel",
          );
        }
        moved = deviation({
          recorded,
          from: reference.t,
          fromScrollTop: reference.scrollTop,
          untilMs: 1000,
          expected: reference.top,
          topOf: (sample) => sample.edgeTop,
        });
        const finish =
          finished === undefined
            ? "the list never finished the pick"
            : `${(finished.t - interrupted.t).toFixed(1)}ms before the finish`;
        const seen =
          interrupted.painted === null
            ? `first painted at ${reference.top.toFixed(1)} after it`
            : `painted at ${reference.top.toFixed(1)} before it`;
        what = `wheel +${(interrupted.t - pickedAt).toFixed(1)}ms after the pick, ${finish}; ${interrupted.edge} ${seen}`;
      }
      report(
        header,
        `${what}: max deviation ${moved.max.toFixed(1)}px over ${String(moved.frames)} painted frames; worst ${moved.worst}\n${trace}`,
      );
      expect(
        moved.max,
        `the reader lost ${interrupted === undefined ? "the picked turn" : "their place"}: ${moved.worst}`,
      ).toBeLessThanOrEqual(HELD_PX);
    });
  }
});
