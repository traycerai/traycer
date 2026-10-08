import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// Browser regression: the message queue is never a pill (staging round 2,
// G1-G2). While it holds anything it sits attached directly above the
// composer - its rows, their actions and Pause - with no click, in every
// preset; and when it empties it leaves no gap behind. Every one-line queue
// row, a badged agent reply included, is held to the dock's one row metric
// (L-171, L-172).
//
// Staging round 4 adds the pill row: it starts at the composer's left edge and
// every pill is fully drawn.
//
// Drives `src/__tests__/browser/composer-queue-dock.html` - the real tile's
// dock derivation, the real `ChatLowerDock` over the real composer shell, and
// the tile's own `lowerSurfaceFrame` decision of whether the composer tucks
// into the dock (`lib/chat/chat-lower-scroll-budget.ts`, unit-tested in
// `lib/chat/__tests__/chat-lower-scroll-budget.test.ts`) - with real key
// input, in the Compact and Default presets. Todo is the fixture's other dock
// member, so the queue is always read beside a surface that folds into a pill
// in Compact.
//
// What is NOT here, because a DOM test decides it: that the queue is not a
// pill, that its rows, Pause and Delete are drawn without a click, that an
// agent's reply is a queued row and is not counted by the Active agents pill,
// that every combination of pills is drawn. Those are jsdom tests next to the
// dock (`components/chat/__tests__/`). This file keeps the claims only a real
// layout engine can measure: where the boxes are.

test.use({
  viewport: { width: 900, height: 700 },
  deviceScaleFactor: 2,
  colorScheme: "light",
});

const PRESETS = ["compact", "default"] as const;
type Preset = (typeof PRESETS)[number];

// Sub-pixel layout, compared at a pixel.
const EPSILON = 1;
// Row heights are stated, not emergent (L-171), so they are compared tighter.
const ROW_EPSILON = 0.5;

interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * One reading of the lower surface: the dock, its pill row, the queue, the
 * composer, the queue's row heights and the pills as drawn.
 */
interface DockReading {
  readonly dock: Box | null;
  readonly strip: Box | null;
  readonly queue: Box | null;
  readonly composer: Box;
  readonly rowHeights: ReadonlyArray<number>;
  readonly provenanceBadges: number;
  readonly pillCount: number;
  readonly firstPillLeft: number | null;
  /**
   * The lowest opacity any pill is drawn at, its own and its ancestors' up to
   * the pill row: a pill at 0 is a box the row still lays out.
   */
  readonly faintestPill: number;
}

async function readDock(page: Page): Promise<DockReading> {
  return page.evaluate((): DockReading => {
    const box = (element: Element | null): Box | null => {
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left };
    };
    const composerInput = document.querySelector("[data-probe-composer]");
    if (composerInput === null) throw new Error("the fixture has no composer");
    const frame =
      composerInput.closest("[data-composer-editor-frame]") ?? composerInput;
    const composer = box(frame.closest("[data-composer-shell]") ?? frame);
    if (composer === null) throw new Error("the composer has no box");
    const pills = [...document.querySelectorAll("[data-chat-dock-chip]")];
    return {
      dock: box(document.querySelector('[data-testid="chat-lower-dock"]')),
      strip: box(
        document.querySelector('[data-testid="chat-dock-compact-strip"]'),
      ),
      queue: box(document.querySelector('[data-testid="queued-message-rows"]')),
      composer,
      rowHeights: [
        ...document.querySelectorAll('[data-testid="queued-message-row"]'),
      ].map((row) => row.getBoundingClientRect().height),
      provenanceBadges: document.querySelectorAll(
        '[data-testid="queued-message-provenance-chip"]',
      ).length,
      pillCount: pills.length,
      firstPillLeft:
        pills.length === 0
          ? null
          : Math.min(...pills.map((pill) => pill.getBoundingClientRect().left)),
      faintestPill: Math.min(
        1,
        ...pills.map((pill) => {
          let opacity = 1;
          for (
            let node: Element | null = pill;
            node !== null &&
            node.getAttribute("data-testid") !== "chat-dock-compact-strip";
            node = node.parentElement
          ) {
            opacity *= Number(getComputedStyle(node).opacity);
          }
          return opacity;
        }),
      ),
    };
  });
}

/**
 * A reading once the lower surface has stopped moving: a pill's 140ms arrival
 * or a queue row leaving can still be settling it when the state has changed.
 * Condition, not time - the frames between two equal readings are the only wait.
 */
async function settledReading(page: Page): Promise<DockReading> {
  let previous = await readDock(page);
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await nextFrames(page, 2);
    const next = await readDock(page);
    if (JSON.stringify(next) === JSON.stringify(previous)) return next;
    previous = next;
  }
  throw new Error("the lower surface never stopped moving");
}

/**
 * The one-line row every dock panel is held to (L-171): the fixture's own
 * recipe string on a throwaway row with one line of text, measured by the same
 * engine. A queue row that measures anything else - a floated toolbar that
 * outgrew its budget, a provenance badge that wrapped (L-172) - moves the
 * composer's upper edge whenever the queue changes.
 */
async function rowMetric(page: Page): Promise<number> {
  const recipe: unknown = await page.evaluate("window.__probeRowRecipe");
  if (typeof recipe !== "string") {
    throw new Error("the fixture exposes no row recipe");
  }
  return page.evaluate((className) => {
    const row = document.createElement("div");
    row.className = className;
    row.style.width = "420px";
    row.textContent = "x";
    document.body.append(row);
    const height = row.getBoundingClientRect().height;
    row.remove();
    return height;
  }, recipe);
}

/** Loads the fixture in a preset, light, and waits until its dock has drawn. */
async function openDock(page: Page, preset: Preset): Promise<void> {
  await page.goto(fixture("composer-queue-dock"));
  await page.waitForFunction("window.__probeReady === true");
  await page.evaluate(
    `window.__probePreset(${JSON.stringify(preset)}); window.__probeTheme("light")`,
  );
  // Compact folds Todo into a pill, Default draws it as a row of the dock.
  await expect(
    page.getByTestId("chat-dock-compact-strip"),
    `${preset}: the fixture's Todo is ${preset === "compact" ? "a pill" : "a dock row"}`,
  ).toHaveCount(preset === "compact" ? 1 : 0);
}

/** Types into the composer and presses Enter, the way a send during a turn does. */
async function queueMessage(
  page: Page,
  text: string,
  rowsAfter: number,
): Promise<void> {
  await page.locator("[data-probe-composer]").focus();
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
  await expect(
    page.getByTestId("queued-message-row"),
    `queueing "${text}"`,
  ).toHaveCount(rowsAfter);
}

for (const preset of PRESETS) {
  test.describe(`${preset} preset`, () => {
    test(`every one-line queue row measures the dock's row metric, a badged agent reply included`, async ({
      page,
    }) => {
      await openDock(page, preset);
      const metric = await rowMetric(page);
      test.info().annotations.push({
        type: "row metric",
        description: `${String(metric)}px`,
      });

      for (const [count, text] of [
        [1, "hi"],
        [2, "and then the tests"],
      ] as const) {
        await queueMessage(page, text, count);
        const reading = await settledReading(page);
        const step = `${preset} after queueing ${String(count)}`;
        expect(reading.rowHeights, `${step}: rows drawn`).toHaveLength(count);
        for (const height of reading.rowHeights) {
          expect(
            Math.abs(height - metric),
            `${step}: a one-line row measures ${String(height)}px, not the ${String(metric)}px row metric`,
          ).toBeLessThanOrEqual(ROW_EPSILON);
        }
      }

      // An agent's reply carries the provenance badge (L-172): the row that is
      // most likely to wrap, and it has to measure the same.
      await page.evaluate("window.__probeQueueClear()");
      await expect(page.getByTestId("queued-message-row")).toHaveCount(0);
      await page.evaluate(`window.__probeQueueAgentReply("ok")`);
      await expect(page.getByTestId("queued-message-row")).toHaveCount(1);
      const reply = await settledReading(page);
      const step = `${preset} with an agent's reply queued`;
      expect(reply.provenanceBadges, `${step}: no provenance badge`).toBe(1);
      expect(reply.rowHeights, `${step}: rows drawn`).toHaveLength(1);
      expect(
        Math.abs((reply.rowHeights[0] ?? Number.NaN) - metric),
        `${step}: the badged row measures ${String(reply.rowHeights[0])}px, not the ${String(metric)}px row metric`,
      ).toBeLessThanOrEqual(ROW_EPSILON);
    });

    test(`twenty long agent replies are twenty one-line rows inside the list's cap, and a click unfolds one`, async ({
      page,
    }) => {
      await openDock(page, preset);
      const metric = await rowMetric(page);
      const reply = (index: number): string =>
        `Reply ${String(index)}: I read the diff and the failing test, and the cause is the retry path re-queuing the same job. ` +
        `Nothing else in the module touches it, so the fix is one guard. I checked the callers too, and none of them depend on the old order. ` +
        `Happy to walk through the trace if that helps, otherwise this is safe to merge as written.`;
      for (let index = 0; index < 20; index += 1) {
        await page.evaluate(
          `window.__probeQueueAgentReply(${JSON.stringify(reply(index))})`,
        );
      }
      await expect(page.getByTestId("queued-message-row")).toHaveCount(20);
      const reading = await settledReading(page);
      const step = `${preset} with twenty agent replies`;

      expect(reading.rowHeights, `${step}: rows drawn`).toHaveLength(20);
      for (const height of reading.rowHeights) {
        expect(
          Math.abs(height - metric),
          `${step}: a folded reply measures ${String(height)}px, not the ${String(metric)}px row metric`,
        ).toBeLessThanOrEqual(ROW_EPSILON);
      }

      const list = page.getByTestId("queued-message-list");
      const cap = await list.evaluate((element) => ({
        client: element.clientHeight,
        scroll: element.scrollHeight,
        bottom: element.getBoundingClientRect().bottom,
      }));
      expect(
        cap.scroll,
        `${step}: the list does not scroll, so twenty rows were not held to its cap`,
      ).toBeGreaterThan(cap.client);
      expect(
        cap.bottom,
        `${step}: the list ends at ${String(cap.bottom)}, below the composer's top ${String(reading.composer.top)}`,
      ).toBeLessThanOrEqual(reading.composer.top + EPSILON);

      const fold = page.getByTestId("queued-message-agent-fold").first();
      await expect(fold).toHaveAttribute("aria-expanded", "false");
      await fold.click();
      await expect(fold).toHaveAttribute("aria-expanded", "true");
      const unfolded = await settledReading(page);
      expect(
        (unfolded.rowHeights[0] ?? Number.NaN) - metric,
        `${step}: the clicked row did not grow past the ${String(metric)}px row metric`,
      ).toBeGreaterThan(ROW_EPSILON);
      for (const height of unfolded.rowHeights.slice(1)) {
        expect(
          Math.abs(height - metric),
          `${step}: an unclicked row grew to ${String(height)}px`,
        ).toBeLessThanOrEqual(ROW_EPSILON);
      }
    });

    test(`the queue sits attached directly above the composer`, async ({
      page,
    }) => {
      await openDock(page, preset);
      for (const [count, text] of [
        [1, "hi"],
        [2, "and then the tests"],
      ] as const) {
        await queueMessage(page, text, count);
        const reading = await settledReading(page);
        const step = `${preset} after queueing ${String(count)}`;
        expect(
          reading.queue,
          `${step}: the queue is not attached above the composer`,
        ).not.toBeNull();
        if (reading.queue === null) return;
        // Directly above the composer: the frame tucks into it with `-mb-px`.
        expect(
          Math.abs(reading.queue.bottom - reading.composer.top),
          `${step}: queue ends at ${String(reading.queue.bottom)}, composer starts at ${String(reading.composer.top)}`,
        ).toBeLessThanOrEqual(EPSILON + 1);
      }
    });

    test(`emptying the queue leaves no gap behind`, async ({ page }) => {
      await openDock(page, preset);
      const empty = await settledReading(page);
      await queueMessage(page, "hi", 1);
      await queueMessage(page, "and then the tests", 2);

      for (const remaining of [1, 0]) {
        const step = `${preset} after deleting down to ${String(remaining)}`;
        await page
          .getByRole("button", { name: "Delete queued message" })
          .first()
          .click();
        await expect(
          page.getByTestId("queued-message-row"),
          `${step}: rows drawn`,
        ).toHaveCount(remaining);
      }

      await expect(
        page.getByTestId("queued-message-rows"),
        `${preset}: the queue is still drawn`,
      ).toHaveCount(0);
      const after = await settledReading(page);
      // No leftover gap: everything sits exactly where it did before the first
      // message was queued. The composer is anchored to the bottom, so a gap
      // shows as the dock above it (or the pill row in it) sitting higher.
      expect(after.dock, `${preset}: the dock is gone`).not.toBeNull();
      expect(empty.dock, `${preset}: no dock before queueing`).not.toBeNull();
      if (after.dock === null || empty.dock === null) return;
      expect(
        Math.abs(after.dock.top - empty.dock.top),
        `${preset}: the dock starts at ${String(after.dock.top)}, was ${String(empty.dock.top)} before queueing`,
      ).toBeLessThanOrEqual(EPSILON);
      expect(
        Math.abs(after.composer.top - empty.composer.top),
        `${preset}: composer at ${String(after.composer.top)}, was ${String(empty.composer.top)} before queueing`,
      ).toBeLessThanOrEqual(EPSILON);
      expect(
        (after.strip === null) === (empty.strip === null),
        `${preset}: the pill row appeared or vanished`,
      ).toBe(true);
      if (after.strip !== null && empty.strip !== null) {
        expect(
          Math.abs(after.strip.bottom - empty.strip.bottom),
          `${preset}: the pill row moved`,
        ).toBeLessThanOrEqual(EPSILON);
      }
    });
  });
}

test("compact preset: a lone pill arrives fully drawn, starting at the composer's left edge", async ({
  page,
}) => {
  await openDock(page, "compact");
  // From an empty pill row, so the pill meets a fresh row and arrives the way
  // one does mid-chat (the row has already drawn a pill, so the arrival is not
  // the chat opening).
  await page.evaluate(
    `window.__probeDock(${JSON.stringify({ todo: false, changes: false, agents: false })})`,
  );
  await expect(page.locator("[data-chat-dock-chip]")).toHaveCount(0);
  await page.evaluate(
    `window.__probeDock(${JSON.stringify({ todo: false, changes: true, agents: false })})`,
  );
  await expect(page.locator("[data-chat-dock-chip]")).toHaveCount(1);

  const reading = await settledReading(page);
  const step = "compact with Files changed alone";
  expect(reading.pillCount, `${step}: pills drawn`).toBe(1);
  expect(reading.firstPillLeft, `${step}: no pill row`).not.toBeNull();
  if (reading.firstPillLeft === null) return;
  expect(
    reading.faintestPill,
    `${step}: a pill is drawn at opacity ${String(reading.faintestPill)}, holding its width unseen`,
  ).toBe(1);
  expect(
    Math.abs(reading.firstPillLeft - reading.composer.left),
    `${step}: the pill row starts at ${String(reading.firstPillLeft)}px, the composer at ${String(reading.composer.left)}px`,
  ).toBeLessThanOrEqual(ROW_EPSILON);
});

// A folded agent row clips its PROSE to one line and never its chrome (#2441
// review F1): the sender chip and the status toolbar float in the row, are
// taller than a text line, and wrap below it in a narrow pane. 239px is the
// canvas's documented minimum pane width.
interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface FoldedRowReading {
  readonly scroll: Rect;
  readonly row: Rect;
  readonly list: Rect;
  readonly sender: Rect | null;
  readonly toolbar: Rect | null;
  readonly status: Rect | null;
  readonly preview: Rect & { readonly width: number; readonly height: number };
  readonly previewLineHeight: number;
  readonly previewLineClamp: string;
  readonly hitInsideFold: boolean;
  readonly foldExpanded: string | null;
  readonly listScrollWidth: number;
  readonly listClientWidth: number;
}

async function readFoldedRow(page: Page): Promise<FoldedRowReading> {
  return page.evaluate((): FoldedRowReading => {
    const rectOf = (element: Element): Rect => {
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return { left, top, right, bottom };
    };
    const find = (testId: string): Element | null =>
      document.querySelector(`[data-testid="${testId}"]`);
    const require = (testId: string): Element => {
      const element = find(testId);
      if (element === null) throw new Error(`no ${testId} is drawn`);
      return element;
    };
    const optional = (testId: string): Rect | null => {
      const element = find(testId);
      return element === null ? null : rectOf(element);
    };
    const preview = require("queued-message-content-preview");
    const box = preview.getBoundingClientRect();
    const style = getComputedStyle(preview);
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    const fold = require("queued-message-agent-fold");
    return {
      scroll: rectOf(require("queued-message-content-scroll")),
      row: rectOf(require("queued-message-row")),
      list: rectOf(require("queued-message-list")),
      sender: optional("queued-message-sender-badge"),
      toolbar: optional("queued-message-row-toolbar"),
      status: optional("queued-message-status-badge"),
      preview: {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      },
      previewLineHeight: Number.parseFloat(style.lineHeight),
      previewLineClamp: style.getPropertyValue("-webkit-line-clamp"),
      hitInsideFold: hit !== null && fold.contains(hit),
      foldExpanded: fold.getAttribute("aria-expanded"),
      listScrollWidth: require("queued-message-list").scrollWidth,
      listClientWidth: require("queued-message-list").clientWidth,
    };
  });
}

function insideRect(inner: Rect, outer: Rect): boolean {
  return (
    inner.left >= outer.left - ROW_EPSILON &&
    inner.top >= outer.top - ROW_EPSILON &&
    inner.right <= outer.right + ROW_EPSILON &&
    inner.bottom <= outer.bottom + ROW_EPSILON
  );
}

// A sender's name is a chat title, so it can be long (review F2).
const LONG_SENDER = "Fix #2441 compact queued-message panel";

for (const [width, sender] of [
  [900, null],
  [320, null],
  [239, null],
  [200, null],
  [320, LONG_SENDER],
  [239, LONG_SENDER],
] as const) {
  test(`a folded agent reply keeps its badge, status and a readable one-line preview at ${String(width)}px, ${sender === null ? "short sender" : "long sender title"}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 700 });
    await openDock(page, "default");
    const replyText = JSON.stringify(
      "A long reply to review with plenty of words that runs past one line so the clamp becomes visible. Additional details at the end.",
    );
    await page.evaluate(
      sender === null
        ? `window.__probeQueueAgentReply(${replyText})`
        : `window.__probeQueueAgentReplyFrom(${replyText}, ${JSON.stringify(sender)})`,
    );
    await expect(page.getByTestId("queued-message-row")).toHaveCount(1);
    await settledReading(page);
    const reading = await readFoldedRow(page);
    test.info().annotations.push({
      type: "content box width",
      description: `${String(reading.scroll.right - reading.scroll.left)}px at ${String(width)}px`,
    });
    const step = `${String(width)}px (content box ${String(reading.scroll.right - reading.scroll.left)}px), folded, ${sender === null ? "short sender" : "long sender title"}`;

    expect(reading.foldExpanded, `${step}: the row is folded`).toBe("false");
    expect(reading.sender, `${step}: no sender badge is drawn`).not.toBeNull();
    for (const [name, chrome] of [
      ["sender badge", reading.sender],
      ["status toolbar", reading.toolbar],
      ["status badge", reading.status],
    ] as const) {
      if (chrome === null) continue;
      expect(
        insideRect(chrome, reading.scroll),
        `${step}: the ${name} ${JSON.stringify(chrome)} is outside the content box ${JSON.stringify(reading.scroll)}`,
      ).toBe(true);
      expect(
        insideRect(chrome, reading.row),
        `${step}: the ${name} ${JSON.stringify(chrome)} is outside the row ${JSON.stringify(reading.row)}`,
      ).toBe(true);
      expect(
        insideRect(chrome, reading.list),
        `${step}: the ${name} ${JSON.stringify(chrome)} is outside the list ${JSON.stringify(reading.list)}`,
      ).toBe(true);
    }

    expect(
      reading.listScrollWidth,
      `${step}: the list scrolls sideways (scrollWidth ${String(reading.listScrollWidth)} > clientWidth ${String(reading.listClientWidth)})`,
    ).toBeLessThanOrEqual(reading.listClientWidth);
    expect(
      reading.preview.width,
      `${step}: the preview is ${String(reading.preview.width)}px wide`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      reading.preview.height,
      `${step}: the preview is ${String(reading.preview.height)}px high`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      insideRect(reading.preview, reading.scroll),
      `${step}: the preview ${JSON.stringify(reading.preview)} is outside the content box ${JSON.stringify(reading.scroll)}`,
    ).toBe(true);
    expect(
      reading.previewLineClamp,
      `${step}: the preview is not clamped`,
    ).toBe("1");
    expect(
      reading.preview.height,
      `${step}: the preview is ${String(reading.preview.height)}px high, more than one ${String(reading.previewLineHeight)}px line`,
    ).toBeLessThanOrEqual(reading.previewLineHeight + ROW_EPSILON);
    expect(
      reading.hitInsideFold,
      `${step}: a click at the preview's centre does not land in the fold control`,
    ).toBe(true);

    if (width === 900) {
      const metric = await rowMetric(page);
      const settled = await settledReading(page);
      expect(
        Math.abs((settled.rowHeights[0] ?? Number.NaN) - metric),
        `${step}: the folded row measures ${String(settled.rowHeights[0])}px, not the ${String(metric)}px row metric`,
      ).toBeLessThanOrEqual(ROW_EPSILON);
    }
  });
}
