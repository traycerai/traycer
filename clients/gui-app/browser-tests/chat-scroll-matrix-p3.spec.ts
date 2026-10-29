import { expect, test, type Page } from "@playwright/test";
import {
  settle,
  startTimeline,
  STRICT_BOTTOM_PX,
  type ChatScrollView,
} from "./support/chat-scroll-oracle";
import { fixture, nextFrames } from "./support/fixtures";

/**
 * TLC path P3 on the windowed line: a saved free reading position inside a
 * turn that is still a placeholder when the tab opens.
 *
 * The tab opens over a warm store whose window holds only the bootstrap tail
 * (`?mountLater=1`, a tab reopened in a new renderer session). Its saved
 * position names the second part of a split turn (`?splitTurn=`), in the
 * shape the live capture writes (`anchorRowKey` the turn, `anchorMessageId`
 * the part). The mount restore can only reach the turn's placeholder; the
 * hydration retry replays the part once the turn hydrates. The turn before it
 * (`?inflate=`) renders far taller than its placeholder estimate, and the
 * turns after it are one-liners (`?shortAfterSplit=1`), so the placeholder
 * clamp can land at the strict bottom.
 *
 * Varied: the turns between the saved turn and the end (`DISTANCES`), and how
 * far the inflated row's real height exceeds its estimate, in viewports
 * (`SCALES`). At rest with no input, every test checks (a) the saved part is
 * at its saved offset and (b) the mode and pill match strict-bottom geometry;
 * then it writes `scrollTop` directly (drag-select autoscroll, the iOS
 * status-bar tap, native find) and checks (c) a remount brings the written
 * position back, or (d) an appended reply leaves it alone.
 */

const SCROLL = '[data-testid="chat-messages-scroll"]';
const VIEWPORT = { width: 900, height: 700 };
const LAST_TURN = 159;
const DISTANCES = [1, 3, 6];
const SCALES = [1, 2, 5];
/** A one-word paragraph's drawn height, measured in the fixture. */
const INFLATE_PARAGRAPH_PX = 49;
const SAVED_OFFSET = -100;
/** The direct `scrollTop` write, upward into rows already hydrated. */
const WRITE_UP_PX = 900;
const HELD_PX = 2;
const TIMELINE_HEAD_LINES = 20;
const TIMELINE_TAIL_LINES = 40;
const FRAME_LOG_TAIL_LINES = 20;

interface SavedPart {
  readonly mode: "free-scrolling";
  readonly anchorMessageId: string;
  readonly anchorRowKey: string;
  readonly anchorIndex: number;
  readonly offset: number;
}

interface KeyRow {
  readonly key: string;
  readonly offset: number;
}

interface Witness {
  /** A frame at the strict bottom while the saved turn was a placeholder. */
  readonly bottomWhileCold: boolean;
  /** The inflated row's placeholder height, then its drawn height. */
  readonly inflatedEstimate: number | null;
  readonly inflatedMeasured: number | null;
  /** Frames during which the hydration retry's saved anchor was pending. */
  readonly pendingFrames: number;
}

interface Opened {
  readonly turn: number;
  readonly saved: SavedPart;
  readonly stopTimeline: () => Promise<string>;
  readonly stopWitness: () => Promise<Witness>;
}

function callProbe(
  page: Page,
  name: string,
  args: unknown[],
): Promise<unknown> {
  return page.evaluate(
    ({ name, args }) => {
      const probe = window.__chatScrollProbe;
      const method: unknown = Reflect.get(probe, name);
      if (typeof method !== "function")
        throw new Error(`no ${name} on the probe`);
      const result: unknown = Reflect.apply(method, probe, args);
      return result;
    },
    { name, args },
  );
}

/** Opens the tab over the cold saved turn; resolves once it has mounted.
 *  `beforeMount` runs with the saved position just before the tab opens. */
async function openSaved(
  page: Page,
  distance: number,
  scale: number,
  beforeMount: ((saved: SavedPart) => Promise<void>) | null,
): Promise<Opened> {
  const turn = LAST_TURN - distance;
  const inflate = Math.ceil((scale * VIEWPORT.height) / INFLATE_PARAGRAPH_PX);
  await page.setViewportSize(VIEWPORT);
  await page.goto(
    `${fixture("chat-scroll-model")}?line=windowed&tailBytes=1200&mountLater=1` +
      `&shortAfterSplit=1&splitTurn=${String(turn)}&inflate=${String(inflate)}`,
  );
  await page.waitForFunction(
    () =>
      "__chatScrollProbe" in window &&
      window.__chatScrollProbe.windowState()?.skeletonComplete === true,
    undefined,
    { polling: "raf" },
  );
  const saved: SavedPart = {
    mode: "free-scrolling",
    anchorMessageId: `assistant:turn-${String(turn)}#message-${String(2 * turn + 1)}:text-2`,
    anchorRowKey: `assistant:turn-${String(turn)}`,
    anchorIndex: 2 * turn + 2,
    offset: SAVED_OFFSET,
  };
  expect(
    await page.evaluate(
      (id) =>
        window.__chatScrollProbe.hydratedRange()?.spans.some((span) => {
          const ordinal = window.__chatScrollProbe.ordinalOf(id);
          return (
            ordinal !== null &&
            span.fromOrdinal <= ordinal &&
            ordinal < span.toOrdinal
          );
        }) ?? true,
      saved.anchorRowKey,
    ),
    "the saved turn is cold before the tab opens",
  ).toBe(false);
  await callProbe(page, "seedSaved", [saved]);
  const stopTimeline = await startTimeline(page);
  await page.evaluate(
    ({ owner, inflated }) => {
      const probe = window.__chatScrollProbe;
      const pendingOf = (): unknown =>
        Reflect.apply(
          Reflect.get(probe, "pendingRestore") as () => unknown,
          probe,
          [],
        );
      const heightOf = (
        id: string,
      ): { height: number; placeholder: boolean } | null =>
        Reflect.apply(
          Reflect.get(probe, "rowHeight") as (id: string) => unknown,
          probe,
          [id],
        ) as { height: number; placeholder: boolean } | null;
      let bottomWhileCold = false;
      let inflatedEstimate: number | null = null;
      let inflatedMeasured: number | null = null;
      let pendingFrames = 0;
      let running = true;
      const tick = (): void => {
        if (!running) return;
        const g = probe.geometry();
        if (g !== null) {
          const fromEnd = g.scrollHeight - g.clientHeight - g.scrollTop;
          if (fromEnd <= 1 && probe.isPlaceholder(owner) === true)
            bottomWhileCold = true;
          if (pendingOf() !== null) pendingFrames += 1;
          const row = heightOf(inflated);
          if (row !== null) {
            if (row.placeholder && inflatedEstimate === null)
              inflatedEstimate = row.height;
            if (!row.placeholder) inflatedMeasured = row.height;
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      Reflect.set(window, "__p3WitnessStop", () => {
        running = false;
        return {
          bottomWhileCold,
          inflatedEstimate,
          inflatedMeasured,
          pendingFrames,
        };
      });
    },
    {
      owner: saved.anchorRowKey,
      inflated: `assistant:turn-${String(turn - 1)}`,
    },
  );
  if (beforeMount !== null) await beforeMount(saved);
  await callProbe(page, "mountNow", []);
  await page.waitForFunction(
    () => window.__chatScrollProbe.geometry() !== null,
  );
  return {
    turn,
    saved,
    stopTimeline,
    stopWitness: () =>
      page.evaluate(() => {
        const stop: unknown = Reflect.get(window, "__p3WitnessStop");
        if (typeof stop !== "function") throw new Error("no witness");
        return Reflect.apply(stop, window, []) as Witness;
      }),
  };
}

async function rowKeyTop(page: Page, key: string): Promise<number | null> {
  return page.evaluate(
    ({ selector, key }) => {
      const node = document.querySelector<HTMLElement>(selector);
      if (node === null) return null;
      const row = node.querySelector<HTMLElement>(
        `[data-row-key="${CSS.escape(key)}"]`,
      );
      if (row === null) return null;
      return row.getBoundingClientRect().top - node.getBoundingClientRect().top;
    },
    { selector: SCROLL, key },
  );
}

/** The first list item (by row key, parts included) the top edge crosses. */
async function readingKeyRow(page: Page): Promise<KeyRow | null> {
  return page.evaluate((selector) => {
    const node = document.querySelector<HTMLElement>(selector);
    if (node === null) return null;
    const top = node.getBoundingClientRect().top;
    const rows = Array.from(
      node.querySelectorAll<HTMLElement>("[data-row-key]"),
    )
      .filter((row) => row.getBoundingClientRect().bottom > top + 1)
      .sort(
        (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
      );
    const first = rows.at(0);
    if (first?.dataset.rowKey === undefined) return null;
    return {
      key: first.dataset.rowKey,
      offset: first.getBoundingClientRect().top - top,
    };
  }, SCROLL);
}

/** The model's at-rest questions for a row-key intent: I_IntentHeld,
 *  I_ModeMatchesGeometry, I_PillHonest. Returns the broken ones. */
async function brokenAtRest(
  page: Page,
  view: ChatScrollView,
  intent: KeyRow,
  label: string,
): Promise<string[]> {
  const atBottom = view.fromEnd <= STRICT_BOTTOM_PX;
  const broken: string[] = [];
  const top = await rowKeyTop(page, intent.key);
  const unreachable =
    top !== null &&
    ((atBottom && top > intent.offset) ||
      (view.scrollTop <= 0 && top < intent.offset));
  if (top === null) {
    broken.push(
      `${label} I_IntentHeld: ${intent.key} is not mounted (wanted at ${intent.offset.toFixed(1)})`,
    );
  } else if (Math.abs(top - intent.offset) > HELD_PX && !unreachable) {
    broken.push(
      `${label} I_IntentHeld: ${intent.key} is at ${top.toFixed(1)}, wanted ${intent.offset.toFixed(1)}`,
    );
  }
  if ((view.mode === "following-end") !== atBottom) {
    broken.push(
      `${label} I_ModeMatchesGeometry: mode=${String(view.mode)} ${atBottom ? "at" : "away from"} the bottom`,
    );
  }
  if (view.pill === atBottom) {
    broken.push(
      `${label} I_PillHonest: pill=${String(view.pill)} ${atBottom ? "at" : "away from"} the bottom`,
    );
  }
  return broken;
}

function describeView(view: ChatScrollView): string {
  return (
    `scrollTop=${view.scrollTop.toFixed(0)} fromEnd=${view.fromEnd.toFixed(0)} ` +
    `scrollHeight=${String(view.scrollHeight)} mode=${String(view.mode)} pill=${String(view.pill)}`
  );
}

/** Writes `scrollTop` with no reader input, and returns where it rested. */
async function writeScrollTop(
  page: Page,
): Promise<{ view: ChatScrollView; row: KeyRow }> {
  await page.evaluate(
    ({ selector, up }) => {
      const node = document.querySelector<HTMLElement>(selector);
      if (node === null) throw new Error("no scroll node");
      node.scrollTop = Math.max(0, node.scrollTop - up);
    },
    { selector: SCROLL, up: WRITE_UP_PX },
  );
  await nextFrames(page, 4);
  const view = await settle(page, 12);
  const row = await readingKeyRow(page);
  if (row === null) throw new Error("no reading row after the write");
  return { view, row };
}

async function finish(
  page: Page,
  opened: Opened,
  broken: string[],
  notes: string[],
): Promise<void> {
  const witness = await opened.stopWitness();
  const timeline = (await opened.stopTimeline()).split("\n");
  const pendingAtRest = (await callProbe(page, "pendingRestore", [])) !== null;
  const summary =
    `bottomWhileCold=${String(witness.bottomWhileCold)} ` +
    `inflated estimate=${String(witness.inflatedEstimate)} measured=${String(witness.inflatedMeasured)} ` +
    `pendingFrames=${String(witness.pendingFrames)} pendingAtEnd=${String(pendingAtRest)}`;
  test.info().annotations.push({ type: "witness", description: summary });
  for (const note of notes)
    test.info().annotations.push({ type: "step", description: note });
  if (broken.length === 0) return;
  const frames = (
    await page.evaluate(() => window.__chatScrollProbe.frameLog())
  ).slice(-FRAME_LOG_TAIL_LINES);
  expect(
    broken,
    `${broken.join("\n")}\n  WITNESS ${summary}\n  STEPS\n  ${notes.join("\n  ")}` +
      `\n  TIMELINE (first ${String(TIMELINE_HEAD_LINES)} changes)\n${timeline.slice(0, TIMELINE_HEAD_LINES).join("\n")}` +
      `\n  ...\n  TIMELINE (last ${String(TIMELINE_TAIL_LINES)} changes)\n${timeline.slice(-TIMELINE_TAIL_LINES).join("\n")}` +
      `\n  HOST FRAMES (last ${String(frames.length)})\n${frames.join("\n")}`,
  ).toEqual([]);
}

/** (a) and (b) at rest after the tab opened. */
async function checkRestored(
  page: Page,
  opened: Opened,
  broken: string[],
  notes: string[],
): Promise<void> {
  const view = await settle(page, 20);
  const intent = {
    key: opened.saved.anchorMessageId,
    offset: opened.saved.offset,
  };
  notes.push(
    `opened: ${describeView(view)} reading=${JSON.stringify(await readingKeyRow(page))}`,
  );
  broken.push(...(await brokenAtRest(page, view, intent, "(a/b) opened:")));
  notes.push(
    `pending after open=${String((await callProbe(page, "pendingRestore", [])) !== null)}`,
  );
}

for (const distance of DISTANCES) {
  for (const scale of SCALES) {
    test.describe(`P3: saved part ${String(distance)} turns from the end, row ${String(scale)}x viewport over estimate`, () => {
      test("(c) a written scrollTop survives a remount", async ({ page }) => {
        const opened = await openSaved(page, distance, scale, null);
        const broken: string[] = [];
        const notes: string[] = [];
        await checkRestored(page, opened, broken, notes);
        const written = await writeScrollTop(page);
        notes.push(
          `written: ${describeView(written.view)} reading=${JSON.stringify(written.row)}`,
        );
        broken.push(
          ...(await brokenAtRest(
            page,
            written.view,
            written.row,
            "(c) after the write:",
          )),
        );
        notes.push(
          `pending after write=${String((await callProbe(page, "pendingRestore", [])) !== null)} ` +
            `saved=${JSON.stringify(await page.evaluate(() => window.__chatScrollProbe.saved()))}`,
        );
        await callProbe(page, "remountLater", [true]);
        await nextFrames(page, 6);
        await page.waitForFunction(
          () => window.__chatScrollProbe.geometry() !== null,
        );
        // The cache holds what the unmount saved until this mount unmounts.
        notes.push(
          `saved at remount=${JSON.stringify(await page.evaluate(() => window.__chatScrollProbe.saved()))} ` +
            `pending at remount=${JSON.stringify(await callProbe(page, "pendingRestore", []))}`,
        );
        const remounted = await settle(page, 20);
        const oldAnchorTop = await rowKeyTop(
          page,
          opened.saved.anchorMessageId,
        );
        notes.push(
          `remounted: ${describeView(remounted)} reading=${JSON.stringify(await readingKeyRow(page))} ` +
            `old anchor top=${String(oldAnchorTop)}`,
        );
        broken.push(
          ...(await brokenAtRest(
            page,
            remounted,
            written.row,
            "(c) after the remount:",
          )),
        );
        await finish(page, opened, broken, notes);
      });

      test("(d) an appended reply leaves a written scrollTop alone", async ({
        page,
      }) => {
        const opened = await openSaved(page, distance, scale, null);
        const broken: string[] = [];
        const notes: string[] = [];
        await checkRestored(page, opened, broken, notes);
        const written = await writeScrollTop(page);
        notes.push(
          `written: ${describeView(written.view)} reading=${JSON.stringify(written.row)}`,
        );
        broken.push(
          ...(await brokenAtRest(
            page,
            written.view,
            written.row,
            "(d) after the write:",
          )),
        );
        notes.push(
          `pending after write=${String((await callProbe(page, "pendingRestore", [])) !== null)}`,
        );
        await page.evaluate(() => window.__chatScrollProbe.appendTurn());
        await nextFrames(page, 6);
        const appended = await settle(page, 20);
        const oldAnchorTop = await rowKeyTop(
          page,
          opened.saved.anchorMessageId,
        );
        notes.push(
          `appended: ${describeView(appended)} reading=${JSON.stringify(await readingKeyRow(page))} ` +
            `old anchor top=${String(oldAnchorTop)}`,
        );
        broken.push(
          ...(await brokenAtRest(
            page,
            appended,
            written.row,
            "(d) after the append:",
          )),
        );
        await finish(page, opened, broken, notes);
      });
    });
  }
}
