import { expect, test, type Page } from "@playwright/test";
import { settle } from "./support/chat-scroll-oracle";
import { fixture, nextFrames, wheelsDelivered } from "./support/fixtures";

/**
 * A reader's gesture during a reopen's restore is the reader's position, and
 * hide/show must bring them back to it. The list starts its own first-paint
 * scroll to the saved row on remount; while that scroll is unfinished the
 * list withholds every scroll report from the controller, so a gesture the
 * restore overwrote is never mirrored, and hiding saves nothing new.
 *
 * Two cells aim a real wheel at that window while a pump keeps
 * remeasuring the row above the viewport, the way the iOS page did:
 * one lands just AFTER the list's first-paint write
 * (`dispatchInitialScroll`), the other BEFORE it. The window is
 * a few frames wide and the input is handled at a frame boundary, so each
 * cell repeats the whole reopen until it has HITS_REQUIRED attempts that
 * landed in the window, and fails on the first hit that shows the defect. A
 * cell that cannot land enough hits FAILS ("window missed"): a green run
 * always exercised the window.
 */

const WINDOW_MS = 800;
const SAME_PX = 4;
const PARK_ATTEMPTS = 4;
const MAX_ATTEMPTS = 14;
const HITS_REQUIRED = 4;
/** A gesture sent as the reopen returns can land in the same frame as the
 *  first-paint write; one frame later it lands after it. */
const AFTER_DISPATCH_DELAY_MS = 30;
type Placement = "after-dispatch" | "before-dispatch";

interface Reading {
  readonly messageId: string | null;
  readonly offset: number;
}

interface ScrollWrite {
  readonly t: number;
  readonly value: number | null;
  readonly stack: string;
}

interface Saved {
  readonly mode: string;
  readonly anchorMessageId: string | null;
  readonly offset: number;
}

interface WindowFacts {
  readonly gestureAt: number | null;
  readonly reopenAt: number;
  readonly pumpEnd: number;
  readonly writes: ReadonlyArray<ScrollWrite>;
}

interface HideShowReadings {
  readonly beforeHide: Reading | null;
  /** Every mounted row's top before the hide: the saved anchor is judged by
   *  where that row was, whichever row the capture chose. */
  readonly topsBefore: Record<string, number>;
  readonly topsAfter: Record<string, number>;
  readonly savedAfterHide: Saved | null;
  readonly afterShow: Reading | null;
}

async function open(page: Page): Promise<void> {
  await page.goto(fixture("chat-scroll-model"));
  await nextFrames(page, 30);
  const box = await page
    .locator('[data-testid="chat-messages-scroll"]')
    .boundingBox();
  if (box === null) throw new Error("no scroll node");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

const savedOf = (page: Page): Promise<Saved | null> =>
  page.evaluate(() => {
    const saved = window.__chatScrollProbe.saved();
    return saved === null
      ? null
      : {
          mode: saved.mode,
          anchorMessageId: saved.anchorMessageId,
          offset: saved.offset,
        };
  });

const readingOf = (page: Page): Promise<Reading | null> =>
  page.evaluate(() => window.__chatScrollProbe.readingRow());

const rowTopsOf = (page: Page): Promise<Record<string, number>> =>
  page.evaluate(() => {
    const tops: Record<string, number> = {};
    const node = document.querySelector<HTMLElement>(
      '[data-testid="chat-messages-scroll"]',
    );
    if (node === null) return tops;
    const edge = node.getBoundingClientRect().top;
    for (const row of node.querySelectorAll<HTMLElement>("[data-message-id]")) {
      const id = row.dataset.messageId;
      if (id !== undefined) tops[id] = row.getBoundingClientRect().top - edge;
    }
    return tops;
  });

/** Back to the tail, then away from it with the wheel until the reader is on
 *  a free reading row. The saved entry is written when the tile unmounts or
 *  hides, so a free reading row is what shows here. */
async function park(page: Page): Promise<Reading> {
  await wheelsDelivered(page, [{ deltaX: 0, deltaY: 100_000 }], 0);
  await settle(page, 12);
  for (let attempt = 0; attempt < PARK_ATTEMPTS; attempt += 1) {
    await wheelsDelivered(page, [{ deltaX: 0, deltaY: -600 }], 0);
    await settle(page, 12);
    const reading = await readingOf(page);
    const mode = await page.evaluate(() => window.__chatScrollProbe.mode());
    if (
      mode === "free-scrolling" &&
      reading !== null &&
      reading.messageId !== null
    ) {
      return reading;
    }
  }
  throw new Error("the reader did not park on a free reading row");
}

/** Wraps the scroll node's write paths once per page; every attempt resets
 *  the log (`window.__firstPaint`) and the gesture clock. */
function installWriteLog(page: Page): Promise<void> {
  return page.evaluate(() => {
    if (Reflect.get(window, "__firstPaintInstalled") === true) return;
    Reflect.set(window, "__firstPaintInstalled", true);
    const isChat = (el: Element): boolean =>
      el instanceof HTMLElement && el.dataset.testid === "chat-messages-scroll";
    const record = (value: number | null): void => {
      const facts: unknown = Reflect.get(window, "__firstPaint");
      if (typeof facts !== "object" || facts === null) return;
      const writes: unknown = Reflect.get(facts, "writes");
      if (!Array.isArray(writes)) return;
      writes.push({
        t: performance.now(),
        value,
        stack: new Error().stack ?? "",
      });
    };

    const originalScrollTo: unknown = Reflect.get(
      Element.prototype,
      "scrollTo",
    );
    if (typeof originalScrollTo !== "function") {
      throw new Error("no scrollTo to observe");
    }
    Element.prototype.scrollTo = function (
      this: Element,
      ...args: unknown[]
    ): void {
      if (isChat(this)) {
        const first = args.at(0);
        const top: unknown =
          typeof first === "object" && first !== null
            ? Reflect.get(first, "top")
            : args.at(1);
        record(typeof top === "number" ? top : null);
      }
      Reflect.apply(originalScrollTo, this, args);
    };
    // Shadowed on `HTMLElement.prototype`; the original accessor on
    // `Element.prototype` stays reachable through `Reflect` with the receiver.
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get(this: HTMLElement): number {
        return Number(Reflect.get(Element.prototype, "scrollTop", this));
      },
      set(this: HTMLElement, value: number): void {
        if (isChat(this)) record(value);
        Reflect.set(Element.prototype, "scrollTop", value, this);
      },
    });
    const noteGesture = (): void => {
      const facts: unknown = Reflect.get(window, "__firstPaint");
      if (
        typeof facts === "object" &&
        facts !== null &&
        Reflect.get(facts, "gestureAt") === null
      ) {
        Reflect.set(facts, "gestureAt", performance.now());
      }
    };
    window.addEventListener("wheel", noteGesture, {
      capture: true,
      passive: true,
    });
  });
}

/** Resets the log, then reopens through production's two-commit eviction path
 *  and runs the remeasure pump that widens the first-paint window. */
function reopenWithPump(page: Page): Promise<void> {
  return page.evaluate((windowMs) => {
    const facts = {
      gestureAt: null,
      reopenAt: performance.now(),
      pumpEnd: performance.now() + windowMs,
      writes: [],
    };
    Reflect.set(window, "__firstPaint", facts);

    const method: unknown = Reflect.get(
      window.__chatScrollProbe,
      "remountLater",
    );
    if (typeof method !== "function") {
      throw new Error("probe has no remountLater");
    }
    Reflect.apply(method, window.__chatScrollProbe, [true]);

    // Each frame resizes the row just above the viewport top, so the list
    // keeps remeasuring while it restores.
    let remeasurements = 0;
    const pump = (): void => {
      if (performance.now() > facts.pumpEnd) return;
      const node = document.querySelector<HTMLElement>(
        '[data-testid="chat-messages-scroll"]',
      );
      if (node !== null) {
        const rows = Array.from(
          node.querySelectorAll<HTMLElement>("[data-message-id]"),
        );
        const edge = node.getBoundingClientRect().top;
        const above =
          rows
            .filter((row) => row.getBoundingClientRect().bottom <= edge + 3)
            .at(-1) ?? rows.at(0);
        if (above !== undefined) {
          above.style.paddingBottom = `${String(24 + (remeasurements % 3) * 12)}px`;
          remeasurements += 1;
        }
      }
      requestAnimationFrame(pump);
    };
    requestAnimationFrame(pump);
  }, WINDOW_MS);
}

/** Chrome delivers a wheel on the next frame, so the page-side clock may read
 *  a moment after the input call returns. */
const untilGestureArrives = (page: Page): Promise<unknown> =>
  page
    .waitForFunction(
      () => {
        const facts: unknown = Reflect.get(window, "__firstPaint");
        return (
          typeof facts === "object" &&
          facts !== null &&
          typeof Reflect.get(facts, "gestureAt") === "number"
        );
      },
      undefined,
      { timeout: 2_000 },
    )
    .catch(() => undefined);

const pumpFinished = (page: Page): Promise<unknown> =>
  page.waitForFunction(() => {
    const facts: unknown = Reflect.get(window, "__firstPaint");
    if (typeof facts !== "object" || facts === null) return false;
    const pumpEnd: unknown = Reflect.get(facts, "pumpEnd");
    return typeof pumpEnd === "number" && performance.now() > pumpEnd;
  });

const windowFacts = (page: Page): Promise<WindowFacts> =>
  page.evaluate(() => {
    const facts: unknown = Reflect.get(window, "__firstPaint");
    if (typeof facts !== "object" || facts === null) {
      throw new Error("no write log");
    }
    const gestureAt: unknown = Reflect.get(facts, "gestureAt");
    const writes: unknown = Reflect.get(facts, "writes");
    if (!Array.isArray(writes)) throw new Error("malformed write log");
    return {
      gestureAt: typeof gestureAt === "number" ? gestureAt : null,
      reopenAt: Number(Reflect.get(facts, "reopenAt")),
      pumpEnd: Number(Reflect.get(facts, "pumpEnd")),
      writes: writes.map((write) => ({
        t: Number(Reflect.get(write, "t")),
        value: Number(Reflect.get(write, "value")),
        stack: String(Reflect.get(write, "stack")),
      })),
    };
  });

/** The frame that made the write: the first one outside the log's own
 *  wrapper, which `evaluate` compiled. */
function topFrame(stack: string): string {
  const frame = stack
    .split("\n")
    .slice(1)
    .find((line) => !line.includes("eval at evaluate"));
  return (frame ?? "?").trim().slice(0, 120);
}

function describeWrites(
  writes: ReadonlyArray<ScrollWrite>,
  gestureAt: number,
): string {
  if (writes.length === 0) return "none";
  return writes
    .map(
      (write) =>
        `${(write.t - gestureAt).toFixed(0)}ms value=${String(write.value)} ` +
        `${write.stack.includes("dispatchInitialScroll") ? "[first-paint] " : ""}${topFrame(write.stack)}`,
    )
    .join("\n    ");
}

const isFirstPaintWrite = (write: ScrollWrite): boolean =>
  write.stack.includes("dispatchInitialScroll");

/** Whether the gesture landed in the window this placement aims at. */
function inWindow(facts: WindowFacts, placement: Placement): boolean {
  const gestureAt = facts.gestureAt;
  if (gestureAt === null || gestureAt <= facts.reopenAt) return false;
  const firstWrite = facts.writes.find(isFirstPaintWrite);
  if (placement === "before-dispatch") {
    return firstWrite !== undefined && firstWrite.t > gestureAt;
  }
  return (
    firstWrite !== undefined &&
    firstWrite.t < gestureAt &&
    gestureAt < facts.pumpEnd
  );
}

/** One wheel up, over the transcript. */
async function wheelUp(page: Page): Promise<void> {
  await page.mouse.wheel(0, -400);
}

/** Hides the tile the way a top-level pane does, shows it again, and reads
 *  the reading row at each step and what hide saved. */
async function hideShow(page: Page): Promise<HideShowReadings> {
  const beforeHide = await readingOf(page);
  const topsBefore = await rowTopsOf(page);
  await page.evaluate(() => {
    window.__chatScrollProbe.hide("collapse");
  });
  await nextFrames(page, 10);
  const savedAfterHide = await savedOf(page);
  await page.evaluate(() => {
    window.__chatScrollProbe.show();
  });
  await nextFrames(page, 30);
  await settle(page, 12);
  return {
    beforeHide,
    topsBefore,
    topsAfter: await rowTopsOf(page),
    savedAfterHide,
    afterShow: await readingOf(page),
  };
}

const rowLabel = (
  id: string | null | undefined,
  offset: number | undefined,
): string => `${String(id)}@${offset === undefined ? "?" : offset.toFixed(1)}`;

/** How far apart two offsets are; infinite when either is missing. */
const gap = (a: number | undefined, b: number | undefined): number =>
  a === undefined || b === undefined
    ? Number.POSITIVE_INFINITY
    : Math.abs(a - b);

const topOf = (
  tops: Record<string, number>,
  id: string | null | undefined,
): number | undefined =>
  id === null || id === undefined ? undefined : tops[id];

/** What went wrong in one window-hitting attempt; empty when it kept the
 *  reader where they were. */
function problemsAfterHideShow(
  readings: HideShowReadings,
  overwrites: string,
  overwriteCount: number,
): string[] {
  const { beforeHide, savedAfterHide, topsBefore, topsAfter, afterShow } =
    readings;
  const anchor = savedAfterHide?.anchorMessageId;
  const label =
    `before hide ${rowLabel(beforeHide?.messageId, beforeHide?.offset)}, ` +
    `saved ${rowLabel(anchor, savedAfterHide?.offset)} ` +
    `(that row sat at ${String(topOf(topsBefore, anchor))} before hide), ` +
    `after show ${rowLabel(afterShow?.messageId, afterShow?.offset)}`;
  const problems: string[] = [];
  if (beforeHide === null) problems.push("no reading row before hide");
  if (overwriteCount > 0) {
    problems.push(
      `the list re-dispatched its first-paint scroll after the gesture:\n    ${overwrites}`,
    );
  }
  if (gap(savedAfterHide?.offset, topOf(topsBefore, anchor)) > SAME_PX) {
    problems.push("saved is not where the reader was");
  }
  if (
    gap(topOf(topsAfter, beforeHide?.messageId), beforeHide?.offset) > SAME_PX
  ) {
    problems.push("show did not return the reading row to its offset");
  }
  return problems.map((problem) => `${problem}; ${label}`);
}

/** The before-dispatch cell's own claim: the reader ends beside where they
 *  parked, not stranded at the top. */
function problemsNearParked(
  parked: Reading,
  readings: HideShowReadings,
  viewportHeight: number,
): string[] {
  const reading = readings.beforeHide;
  const problems: string[] = [];
  if (reading?.messageId === "message-0" && parked.messageId !== "message-0") {
    problems.push("the reader was stranded at the top (message-0)");
  }
  const parkedTop = topOf(readings.topsBefore, parked.messageId);
  if (parkedTop === undefined || Math.abs(parkedTop) > viewportHeight) {
    problems.push(
      `the parked row ${String(parked.messageId)} is ${parkedTop === undefined ? "not mounted" : `${parkedTop.toFixed(0)}px away`}, ` +
        `more than a screen (${String(viewportHeight)}px) from where the reader stands`,
    );
  }
  return problems;
}

interface Attempt {
  readonly hit: boolean;
  readonly problems: string[];
  /** Where the gesture and the first first-paint write fell, for the report. */
  readonly note: string;
}

function noteOf(facts: WindowFacts): string {
  const since = (t: number | undefined): string =>
    t === undefined ? "none" : `${(t - facts.reopenAt).toFixed(0)}ms`;
  return (
    `gesture ${since(facts.gestureAt ?? undefined)}, ` +
    `first first-paint write ${since(facts.writes.find(isFirstPaintWrite)?.t)}, ` +
    `pump ends ${since(facts.pumpEnd)}, ${String(facts.writes.length)} writes`
  );
}

/**
 * One reopen: park, send the gesture (ahead of the reopen for the
 * before-dispatch placement, together with it otherwise), let the restore and
 * the pump finish, then hide and show the tile and compare.
 */
async function attempt(
  page: Page,
  placement: Placement,
  gesture: (page: Page) => Promise<void>,
): Promise<Attempt> {
  const parked = await park(page);
  await installWriteLog(page);
  // A wheel queues behind the main thread's work: sent after the reopen call
  // returns, it is handled once the first-paint write has run; sent with it,
  // before.
  if (placement === "before-dispatch") {
    await Promise.all([reopenWithPump(page), gesture(page)]);
  } else {
    await reopenWithPump(page);
    await page.waitForTimeout(AFTER_DISPATCH_DELAY_MS);
    await gesture(page);
  }
  await untilGestureArrives(page);

  const facts = await windowFacts(page);
  await pumpFinished(page);
  if (!inWindow(facts, placement)) {
    await settle(page, 12);
    return { hit: false, problems: [], note: noteOf(facts) };
  }
  const gestureAt = facts.gestureAt ?? 0;
  await nextFrames(page, 60);
  await settle(page, 12);
  const overwrites =
    placement === "after-dispatch"
      ? (await windowFacts(page)).writes.filter(
          (write) => isFirstPaintWrite(write) && write.t > gestureAt,
        )
      : [];
  const readings = await hideShow(page);
  const problems = problemsAfterHideShow(
    readings,
    describeWrites(overwrites, gestureAt),
    overwrites.length,
  );
  if (placement === "before-dispatch") {
    const viewport = page.viewportSize();
    problems.push(
      ...problemsNearParked(
        parked,
        readings,
        viewport === null ? 700 : viewport.height,
      ),
    );
  }
  if (problems.length > 0) {
    const all = (await windowFacts(page)).writes;
    const near = all.filter((write) => Math.abs(write.t - gestureAt) <= 200);
    problems.push(
      `writes within 200ms of the gesture (first-paint writes carry dispatchInitialScroll in their stack):\n    ${describeWrites(near, gestureAt)}`,
    );
    // TEMPORARY DIAGNOSTIC - probe branch only. The 200ms window above stops
    // before the late convergence this failure is about, and the restore's own
    // terminal path is what says which fix it needs.
    problems.push(
      `EVERY write (${String(all.length)}):\n    ${describeWrites(all, gestureAt)}`,
    );
    const restorePath = await page.evaluate(() => {
      const log: unknown = Reflect.get(window, "__restorePath");
      return Array.isArray(log) ? log.map((entry) => String(entry)) : [];
    });
    // One entry per line: a `land?` entry now carries the DOM-vs-list
    // comparison, so the joined form was long enough to risk truncation and
    // too dense to read a single check out of.
    problems.push(
      `RESTORE PATH (${String(restorePath.length)}):\n    ${restorePath.join("\n    ")}`,
    );
    const resting = await page.evaluate(() => {
      const node = document.querySelector<HTMLElement>(
        '[data-testid="chat-messages-scroll"]',
      );
      return node === null
        ? "no node"
        : `scrollTop=${String(node.scrollTop)} of ${String(node.scrollHeight)} mode=${String(node.dataset.scrollMode)}`;
    });
    problems.push(`RESTING: ${resting}`);
  }
  return { hit: true, problems, note: noteOf(facts) };
}

/** Repeats the reopen until HITS_REQUIRED attempts landed in the window; the
 *  first window-hitting attempt that loses the reader's position fails. */
async function expectKeptInWindow(
  page: Page,
  placement: Placement,
  gesture: (page: Page) => Promise<void>,
): Promise<void> {
  test.setTimeout(240_000);
  await open(page);
  let hits = 0;
  let attempts = 0;
  const notes: string[] = [];
  try {
    while (hits < HITS_REQUIRED && attempts < MAX_ATTEMPTS) {
      attempts += 1;
      const result = await attempt(page, placement, gesture);
      notes.push(`${result.hit ? "HIT " : "miss"} ${result.note}`);
      if (!result.hit) continue;
      hits += 1;
      expect(
        result.problems,
        `attempt ${String(attempts)} (hit ${String(hits)}):\n  ${result.problems.join("\n  ")}`,
      ).toEqual([]);
    }
  } finally {
    test.info().annotations.push({
      type: "window",
      description: `${String(hits)} hits in ${String(attempts)} attempts\n${notes.join("\n")}`,
    });
  }
  expect(
    hits,
    `window missed: ${String(hits)} of ${String(HITS_REQUIRED)} required hits in ${String(attempts)} attempts`,
  ).toBe(HITS_REQUIRED);
}

test.describe("a wheel just after the restore's first-paint write", () => {
  test.use({ viewport: { width: 900, height: 700 } });

  test("is the position hide and show bring back", async ({ page }) => {
    await expectKeptInWindow(page, "after-dispatch", wheelUp);
  });
});

test.describe("a wheel before the restore's first-paint write", () => {
  test.use({ viewport: { width: 900, height: 700 } });

  test("leaves the reader beside the saved row, and hide and show keep it", async ({
    page,
  }) => {
    await expectKeptInWindow(page, "before-dispatch", wheelUp);
  });
});
