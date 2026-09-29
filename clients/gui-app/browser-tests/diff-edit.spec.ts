import {
  expect,
  test,
  type JSHandle,
  type Locator,
  type Page,
} from "@playwright/test";

import { fixture, type Point, nextFrames } from "./support/fixtures.ts";

// The Git diff's in-place editor, on the real Pierre diff renderer in Chrome.
//
// The diff paints inside a shadow root, its context expanders are buttons the
// patched `@pierre/diffs` adds a collapse control to, and its editor is a
// `contenteditable` layered over the painted lines with its own caret and
// selection overlay. Whether a click lands the caret on the line it hit,
// whether a drag / double-click / triple-click selection is still there once
// the gesture has settled, whether a keystroke survives autosave's refetch and
// a tile resize with the SAME editor still focused - all of that is layout and
// input dispatch, and jsdom has neither. Five claims, each on its own page
// load:
//
//   - end-of-file context expands, collapses and expands again;
//   - fully expanded context offers its collapse control and no expander;
//   - click-to-edit keeps drag, double-click and whole-line selections;
//   - keystrokes land, and focus and caret survive autosave and a resize;
//   - keys typed the moment the editor attaches land in order, the caret
//     after them.
//
// The input is real: mouse gestures and key presses dispatched by Chrome, not
// simulated events.

const LINE_30 = '[data-additions] [data-content] > [data-line="30"]';
const TRAILING_EXPANDER = "[data-separator-last] [data-expand-button]";
// An expand control, which the collapse control (also a `data-expand-button`)
// is not.
const EXPANDER = "[data-expand-button]:not([data-collapse-button])";
// How long a selection must keep existing once its gesture has landed. The
// claim IS about time (a rerender after the pointer gesture used to clear it),
// so this is a window, not a synchronisation sleep.
const DRAG_SELECTION_HOLD_MS = 1000;
const CLICK_SELECTION_HOLD_MS = 500;
// Frames the caret, its line and the scroll offset must hold still for before
// a resize reading is taken.
const STABLE_FRAMES = 10;

test.use({ viewport: { width: 1000, height: 800 } });

function diffRoot(page: Page): Locator {
  return page.locator("diffs-container");
}

function lineThirty(page: Page): Locator {
  return diffRoot(page).locator(LINE_30);
}

function selectionRanges(page: Page): Locator {
  return diffRoot(page).locator("[data-selection-range]");
}

function testState(page: Page): Locator {
  return page.locator("#test-state");
}

async function openDiff(page: Page): Promise<void> {
  await page.goto(fixture("diff-edit-focus"));
  await expect(
    diffRoot(page).locator(
      '[data-additions] [data-content] > [data-line="24"]',
    ),
    "the painted split diff",
  ).toBeAttached();
}

async function expandTrailingContext(page: Page): Promise<void> {
  await diffRoot(page).locator(TRAILING_EXPANDER).first().click();
  await expect(
    lineThirty(page),
    "the expanded trailing context",
  ).toBeAttached();
}

/** The editable line's click point: 120px in, or the middle of a narrower line. */
async function lineClickPoint(page: Page): Promise<Point> {
  await page.evaluate((selector) => {
    const line = document
      .querySelector("diffs-container")
      ?.shadowRoot?.querySelector(selector);
    if (!(line instanceof HTMLElement)) {
      throw new Error("the editable line is missing");
    }
    line.scrollIntoView({ block: "center" });
  }, LINE_30);
  await nextFrames(page, 2);
  const box = await lineThirty(page).boundingBox();
  if (box === null) throw new Error("the editable line has no layout box");
  return {
    x: box.x + Math.min(120, box.width / 2),
    y: box.y + box.height / 2,
  };
}

interface OpenEditor {
  readonly host: JSHandle<Element | null>;
  readonly clickPoint: Point;
}

/**
 * Expands the trailing context, clicks the editable line and resolves on the
 * first frame the editor has attached: `contenteditable` focused inside the
 * SAME `diffs-container`, its caret painted. A user who clicks and types at
 * once starts typing on that frame, so nothing here waits past it - an
 * attached editor has to take input from its first frame.
 */
async function openEditor(page: Page): Promise<OpenEditor> {
  await openDiff(page);
  await expandTrailingContext(page);
  const host = await page.evaluateHandle(() =>
    document.querySelector("diffs-container"),
  );
  const clickPoint = await lineClickPoint(page);
  await page.mouse.click(clickPoint.x, clickPoint.y);
  // Polled every frame, not on `expect.poll`'s widening interval, so the
  // caller's next input follows the attach within a frame.
  await page.waitForFunction(
    (hostElement) => {
      const current = document.querySelector("diffs-container");
      return (
        current === hostElement &&
        current?.shadowRoot?.activeElement?.getAttribute("contenteditable") ===
          "true" &&
        current.shadowRoot.querySelector("[data-caret]") !== null
      );
    },
    host,
    { polling: "raf" },
  );
  return { host, clickPoint };
}

/**
 * The fewest `[data-selection-range]` overlays seen on any frame of a window.
 * Zero anywhere in it means the selection the gesture made was cleared again.
 */
async function fewestSelectionRanges(
  page: Page,
  windowMs: number,
): Promise<number> {
  return page.evaluate(async (durationMs) => {
    const root = document.querySelector("diffs-container")?.shadowRoot;
    if (root === null || root === undefined) {
      throw new Error("diffs-container has no shadow root");
    }
    const count = (): number =>
      root.querySelectorAll("[data-selection-range]").length;
    let fewest = count();
    const start = performance.now();
    while (performance.now() - start < durationMs) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
      fewest = Math.min(fewest, count());
    }
    return fewest;
  }, windowMs);
}

/**
 * A selection made by a gesture has to (1) exist once the gesture has landed
 * and (2) still exist after it has settled.
 */
async function expectSelectionToSurvive(
  page: Page,
  gesture: string,
  windowMs: number,
): Promise<void> {
  await expect(
    selectionRanges(page).first(),
    `${gesture} selection disappeared after the pointer gesture settled`,
  ).toBeAttached();
  expect(
    await fewestSelectionRanges(page, windowMs),
    `${gesture} selection disappeared after the pointer gesture settled`,
  ).toBeGreaterThan(0);
}

/** A plain click collapses the selection, ready for the next gesture. */
async function collapseSelection(page: Page, point: Point): Promise<void> {
  await page.mouse.click(point.x, point.y);
  await expect(
    selectionRanges(page),
    "the selection to collapse for the next gesture",
  ).toHaveCount(0);
}

interface EditorSnapshot {
  readonly lineText: string;
  readonly editableText: string;
  readonly caretOffset: number;
  readonly caretLeft: number;
  readonly caretVisible: boolean;
  readonly scrollTop: number;
  readonly focused: boolean;
  readonly sameHost: boolean;
  readonly changeCount: number;
  readonly blurCount: number;
  readonly attachCount: number;
  readonly contentsSettledCount: number;
  readonly workerQuiet: boolean;
  readonly writeCount: number;
  readonly comparisonIdentity: string;
  readonly activationError: string;
}

/** The editor's caret, focus and counters, all read in one evaluation. */
async function snapshot(
  page: Page,
  host: JSHandle<Element | null>,
): Promise<EditorSnapshot> {
  return page.evaluate(
    ([hostElement, selector]): EditorSnapshot => {
      const need = <T>(value: T | null | undefined, what: string): T => {
        if (value === null || value === undefined) {
          throw new Error(
            `Could not capture diff editor snapshot: ${what} is missing (diffs-container, target line, caret, viewport, or #test-state)`,
          );
        }
        return value;
      };
      const current = need(
        document.querySelector<HTMLElement>("diffs-container"),
        "diffs-container",
      );
      const root = need(current.shadowRoot, "the shadow root");
      const line = need(root.querySelector<HTMLElement>(selector), "the line");
      const caret = need(
        root.querySelector<HTMLElement>("[data-caret]"),
        "the caret",
      );
      const viewport = need(
        document.querySelector<HTMLElement>("[data-diffs-host] > div"),
        "the viewport",
      );
      const state = need(
        document.querySelector<HTMLElement>("#test-state"),
        "#test-state",
      );
      const lineRect = line.getBoundingClientRect();
      const caretRect = caret.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      return {
        lineText: line.textContent,
        editableText:
          root.querySelector('[contenteditable="true"]')?.textContent ?? "",
        caretOffset: caretRect.top - lineRect.top,
        caretLeft: caretRect.left,
        caretVisible:
          caretRect.top >= viewportRect.top - 1 &&
          caretRect.bottom <= viewportRect.bottom + 1,
        scrollTop: viewport.scrollTop,
        focused:
          document.activeElement === current &&
          root.activeElement?.getAttribute("contenteditable") === "true",
        sameHost: current === hostElement,
        changeCount: Number(state.getAttribute("data-change-count")),
        blurCount: Number(state.getAttribute("data-blur-count")),
        attachCount: Number(state.getAttribute("data-attach-count")),
        contentsSettledCount: Number(
          state.getAttribute("data-contents-settled-count"),
        ),
        workerQuiet: state.getAttribute("data-worker-quiet") === "true",
        writeCount: Number(state.getAttribute("data-write-count")),
        comparisonIdentity:
          state.getAttribute("data-comparison-identity") ?? "",
        activationError: state.getAttribute("data-activation-error") ?? "",
      };
    },
    [host, LINE_30] as const,
  );
}

/**
 * Resolves once the editable line, the caret and the scroll offset have held
 * still for `STABLE_FRAMES` frames in a row: the editor re-anchors its caret
 * on a resize a frame or more after the layout moves, and a reading taken
 * mid-move is a reading of nothing.
 */
async function waitForStableCaret(page: Page): Promise<void> {
  await page.evaluate(
    async ([selector, stableFrames]) => {
      const root = document.querySelector("diffs-container")?.shadowRoot;
      const viewport = document.querySelector("[data-diffs-host] > div");
      if (
        root === null ||
        root === undefined ||
        !(viewport instanceof HTMLElement)
      ) {
        throw new Error("the diff viewport is missing");
      }
      const read = (): string => {
        const line = root.querySelector(selector)?.getBoundingClientRect();
        const caret = root
          .querySelector("[data-caret]")
          ?.getBoundingClientRect();
        return JSON.stringify([
          line?.top,
          line?.left,
          caret?.top,
          caret?.left,
          viewport.scrollTop,
          viewport.clientWidth,
        ]);
      };
      let last = read();
      let stable = 0;
      for (let frame = 0; stable < stableFrames; frame += 1) {
        if (frame > 600) throw new Error("the caret never held still");
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
        const next = read();
        stable = next === last ? stable + 1 : 0;
        last = next;
      }
    },
    [LINE_30, STABLE_FRAMES] as const,
  );
}

test("end-of-file context expands, collapses and expands again", async ({
  page,
}) => {
  await openDiff(page);
  const root = diffRoot(page);

  await expect(
    root.locator("[data-expand-button]").first(),
    "collapsed context is not expandable before the diff is edited",
  ).toBeAttached();
  await expect(
    root.locator(TRAILING_EXPANDER).first(),
    "trailing EOF context has no expander",
  ).toBeAttached();

  await root.locator(TRAILING_EXPANDER).first().click();
  await expect(
    lineThirty(page),
    "the expanded trailing context",
  ).toBeAttached();
  await expect(
    root.locator(`[data-separator-last] ${EXPANDER}`).first(),
    "partial context expansion lost its remaining expander",
  ).toBeAttached();

  const collapse = root.locator("[data-collapse-button]").first();
  await expect(
    collapse,
    "expanded context has no collapse control",
  ).toHaveJSProperty("tagName", "BUTTON");
  await expect(
    collapse,
    "expanded context has no collapse control",
  ).toHaveAttribute("aria-label", "Collapse expanded lines");

  await collapse.click();
  await expect(lineThirty(page), "the collapsed trailing context").toHaveCount(
    0,
  );

  await root.locator(TRAILING_EXPANDER).first().click();
  await expect(
    lineThirty(page),
    "the re-expanded trailing context",
  ).toBeAttached();
});

test("fully expanded context offers its collapse control and no expander", async ({
  page,
}) => {
  await openDiff(page);
  const root = diffRoot(page);
  // The 20 lines above the hunk: one expand shows all of them, which leaves
  // the region's separator nothing to expand and only a collapse to offer.
  const leading = root.locator("[data-separator-first]");
  const lineOne = root.locator(
    '[data-additions] [data-content] > [data-line="1"]',
  );

  await leading.locator("[data-expand-button]").first().click();
  await expect(lineOne, "the expanded leading context").toBeAttached();
  await expect(
    leading.locator("[data-separator-content]").first(),
    "the fully expanded region's separator",
  ).toHaveText("Collapse expanded lines");
  await expect(
    leading.locator(EXPANDER),
    "a fully expanded region still offers an expander with nothing to expand",
  ).toHaveCount(0);

  // The 193 lines below it are more than one expand shows; a shift-click
  // expands them all. After that nothing in the file is left to expand.
  await root
    .locator(TRAILING_EXPANDER)
    .first()
    .click({ modifiers: ["Shift"] });
  await expect(
    root.locator('[data-additions] [data-content] > [data-line="220"]'),
    "the fully expanded trailing context",
  ).toBeAttached();
  await expect(
    root.locator(EXPANDER),
    "a fully expanded file still offers an expander with nothing to expand",
  ).toHaveCount(0);

  await leading.locator("button[data-collapse-button]").first().click();
  await expect(lineOne, "the collapsed leading context").toHaveCount(0);
  await expect(
    leading.locator(EXPANDER).first(),
    "the collapsed region lost its expander",
  ).toBeAttached();
});

test("click-to-edit keeps drag, double-click and whole-line selections", async ({
  page,
}) => {
  const { clickPoint } = await openEditor(page);

  const box = await lineThirty(page).boundingBox();
  if (box === null) throw new Error("the editable line has no layout box");
  const middle = box.y + box.height / 2;

  // A drag across the line: a selection must exist while the button is down
  // and still exist once the gesture has settled.
  await page.mouse.move(box.x + 24, middle);
  await page.mouse.down();
  await page.mouse.move(box.x + 128, middle);
  const during = await selectionRanges(page).count();
  await page.mouse.up();
  expect(during, "mouse drag never created a selection").toBeGreaterThan(0);
  await expectSelectionToSurvive(page, "mouse-drag", DRAG_SELECTION_HOLD_MS);

  await collapseSelection(page, clickPoint);
  await page.mouse.click(clickPoint.x, clickPoint.y, { clickCount: 2 });
  await expectSelectionToSurvive(page, "double-click", CLICK_SELECTION_HOLD_MS);

  await collapseSelection(page, clickPoint);
  await page.mouse.click(clickPoint.x, clickPoint.y, { clickCount: 3 });
  await expectSelectionToSurvive(page, "whole-line", CLICK_SELECTION_HOLD_MS);
});

test("keystrokes land, and focus and caret survive autosave and a resize", async ({
  page,
}) => {
  const { host } = await openEditor(page);
  const state = testState(page);

  const attached = await snapshot(page, host);
  await page.keyboard.press("x");
  await expect(state, "the first physical keystroke").toHaveAttribute(
    "data-change-count",
    "1",
  );
  // The line itself, not the whole editable: the editable's text carries the
  // separators' own "Expand all" / "expanded lines" labels, so it contains an
  // "x" before anything is typed.
  await expect(
    lineThirty(page),
    "the first keystroke to appear in the editor",
  ).toContainText("x");
  const afterFirstKey = await snapshot(page, host);

  await expect(state, "autosave to write the draft").toHaveAttribute(
    "data-write-count",
    "1",
  );
  await expect
    .poll(
      async () =>
        Number(await state.getAttribute("data-contents-settled-count")),
      { message: "the post-save contents refetch to settle" },
    )
    .toBeGreaterThanOrEqual(2);
  await expect(
    state,
    "the post-commit WorkerPool quiet signal",
  ).toHaveAttribute("data-worker-quiet", "true");
  const afterAckWindow = await snapshot(page, host);

  await page.evaluate(() => {
    const tile = document.querySelector("#tile");
    if (tile instanceof HTMLElement) tile.style.width = "360px";
  });
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.querySelector("[data-diffs-host] > div")?.clientWidth,
        ),
      { message: "the tile to take its narrower width" },
    )
    .toBeLessThanOrEqual(360);
  await waitForStableCaret(page);
  const afterResize = await snapshot(page, host);

  await page.keyboard.press("y");
  await expect(state, "the post-resize physical keystroke").toHaveAttribute(
    "data-change-count",
    "2",
  );
  await nextFrames(page, 2);
  const afterSecondKey = await snapshot(page, host);

  await test.info().attach("editor-snapshots", {
    body: JSON.stringify(
      { attached, afterFirstKey, afterAckWindow, afterResize, afterSecondKey },
      null,
      2,
    ),
    contentType: "application/json",
  });

  expect
    .soft(
      Math.abs(attached.caretOffset),
      `caret is offset from its line by ${String(attached.caretOffset)}px`,
    )
    .toBeLessThanOrEqual(1);
  expect
    .soft(
      afterFirstKey.focused && afterFirstKey.sameHost,
      "the first keystroke did not retain the focused editor host",
    )
    .toBe(true);
  expect
    .soft(
      afterFirstKey.caretLeft,
      "the first keystroke did not advance the caret",
    )
    .toBeGreaterThan(attached.caretLeft);
  expect
    .soft(
      afterFirstKey.attachCount,
      `editor attached ${String(afterFirstKey.attachCount)} time(s) after the first keystroke`,
    )
    .toBe(1);
  expect
    .soft(
      afterAckWindow.attachCount,
      `editor attached ${String(afterAckWindow.attachCount)} time(s) after the post-save window`,
    )
    .toBe(1);
  expect
    .soft(
      afterAckWindow.caretLeft,
      "the caret returned toward the original click column after the post-save window",
    )
    .toBeGreaterThanOrEqual(afterFirstKey.caretLeft);
  expect
    .soft(
      afterAckWindow.focused && afterAckWindow.sameHost,
      "the post-save window did not retain the focused editor host",
    )
    .toBe(true);
  expect
    .soft(
      afterResize.attachCount,
      `editor attached ${String(afterResize.attachCount)} time(s) after width resize`,
    )
    .toBe(1);
  expect
    .soft(
      afterResize.caretVisible,
      "the caret is outside the tile viewport after width resize",
    )
    .toBe(true);
  expect
    .soft(
      Math.abs(afterResize.caretOffset),
      `caret is offset from its line by ${String(afterResize.caretOffset)}px after width resize`,
    )
    .toBeLessThanOrEqual(1);
  expect
    .soft(
      Math.abs(afterSecondKey.scrollTop - afterResize.scrollTop),
      `the next keystroke moved scrollTop by ${String(afterSecondKey.scrollTop - afterResize.scrollTop)}px`,
    )
    .toBeLessThanOrEqual(1);
  expect
    .soft(
      afterSecondKey.focused && afterSecondKey.sameHost,
      "the post-resize keystroke did not retain the focused editor host",
    )
    .toBe(true);
  expect
    .soft(
      afterSecondKey.attachCount,
      `editor attached ${String(afterSecondKey.attachCount)} time(s) after the post-resize keystroke`,
    )
    .toBe(1);
  expect
    .soft(
      afterSecondKey.caretLeft,
      "the post-resize keystroke did not move the caret",
    )
    .not.toBe(afterResize.caretLeft);
  expect
    .soft(
      afterSecondKey.blurCount,
      `the editor emitted ${String(afterSecondKey.blurCount)} blur event(s)`,
    )
    .toBe(0);
  expect
    .soft(
      afterSecondKey.activationError,
      `activation failed: ${afterSecondKey.activationError}`,
    )
    .toBe("");
});

/** Where the painted caret sits on the editable line, read off the layout. */
interface LineCaret {
  /** The line's painted text. */
  readonly lineText: string;
  /** The character boundary on the line nearest the painted caret. */
  readonly character: number;
  /** How far, in CSS px, the painted caret is from that boundary. */
  readonly distance: number;
}

async function lineCaret(page: Page): Promise<LineCaret> {
  return page.evaluate((selector): LineCaret => {
    const root = document.querySelector("diffs-container")?.shadowRoot;
    const line = root?.querySelector<HTMLElement>(selector);
    const caret = root?.querySelector<HTMLElement>("[data-caret]");
    if (
      line === null ||
      line === undefined ||
      caret === null ||
      caret === undefined
    ) {
      throw new Error("the editable line or its painted caret is missing");
    }
    const texts: Text[] = [];
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node !== null) {
      if (node instanceof Text) texts.push(node);
      node = walker.nextNode();
    }
    const lineText = texts.map((text) => text.data).join("");
    if (lineText.length === 0) throw new Error("the editable line is empty");
    const characterBox = (index: number): DOMRect => {
      let offset = index;
      for (const text of texts) {
        if (offset < text.length) {
          const range = document.createRange();
          range.setStart(text, offset);
          range.setEnd(text, offset + 1);
          return range.getBoundingClientRect();
        }
        offset -= text.length;
      }
      throw new Error(`the line has no character ${String(index)}`);
    };
    const boundaryX = (character: number): number =>
      character < lineText.length
        ? characterBox(character).left
        : characterBox(lineText.length - 1).right;
    const caretBox = caret.getBoundingClientRect();
    const caretX = caretBox.left + caretBox.width / 2;
    let character = 0;
    let distance = Number.POSITIVE_INFINITY;
    for (let boundary = 0; boundary <= lineText.length; boundary += 1) {
      const gap = Math.abs(boundaryX(boundary) - caretX);
      if (gap < distance) {
        character = boundary;
        distance = gap;
      }
    }
    return { lineText, character, distance };
  }, LINE_30);
}

// A user who clicks a line and types at once is typing into an editor that
// attached a frame or two earlier. `openEditor` hands over on the first frame
// the editor is focused with its caret painted, and the keys follow straight
// away. The editor used to receive a highlighter without the file's grammar
// and load it only in its tokenizer's 500ms-debounced warm-up; each key typed
// before then was written into the document but threw before the caret
// advanced or the line repainted, so "ab" was stored as "ba".
test("keys typed the moment the editor attaches land in order, the caret after them", async ({
  page,
}) => {
  const typed = "ab";
  await openEditor(page);
  const attached = await lineCaret(page);
  await page.keyboard.type(typed);
  await expect(
    testState(page),
    "every typed key to reach the editor",
  ).toHaveAttribute("data-change-count", String(typed.length));
  await nextFrames(page, 2);
  const afterTyping = await lineCaret(page);

  expect
    .soft(
      afterTyping.lineText,
      `the keys typed as the editor attached are not on the line in the order "${typed}"`,
    )
    .toBe(
      attached.lineText.slice(0, attached.character) +
        typed +
        attached.lineText.slice(attached.character),
    );
  expect(
    afterTyping.character,
    `the caret sits at character ${String(afterTyping.character)} (${afterTyping.distance.toFixed(1)}px off it), not after the typed "${typed}"`,
  ).toBe(attached.character + typed.length);
});
