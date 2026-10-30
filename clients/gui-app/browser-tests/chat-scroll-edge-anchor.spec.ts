import { expect, test, type Page } from "@playwright/test";
import { fixture, nextFrames, wheelsDelivered } from "./support/fixtures";

/**
 * The element at the viewport's top edge keeps its place while the list
 * re-measures around it: a card opened or a width change below or inside the
 * row that straddles the edge, and a block that appears above the edge inside
 * that row. Runs on both lines, and asserts the list recorded an
 * `edgeAnchor` for each re-measure.
 */

declare global {
  interface Window {
    __edge?: {
      adjusts: string[];
      anchor: () => string;
      mark: () => number | null;
      top: () => number | null;
    };
  }
}

const SCROLL = '[data-testid="chat-messages-scroll"]';
const CARD = 'button[aria-label^="Thought"]';

async function open(page: Page, line: "legacy" | "windowed"): Promise<void> {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(
    `${fixture("chat-scroll-model")}${line === "windowed" ? "?line=windowed" : ""}`,
  );
  await nextFrames(page, 30);
}

/** Wraps the list's adjust handler and exposes the edge element helpers. */
async function install(page: Page): Promise<void> {
  await page.evaluate(() => {
    interface ScrollAdjustHandler {
      requestAdjust: (add: number) => unknown;
    }
    interface EdgeAnchorState {
      readonly key: unknown;
      readonly offset: unknown;
      readonly node?: HTMLElement;
    }
    interface ListRefState {
      readonly scrollAdjustHandler: ScrollAdjustHandler;
      readonly idsInView?: readonly unknown[];
      readonly edgeAnchor?: EdgeAnchorState;
      readonly props: unknown;
    }
    interface HookState {
      readonly memoizedState: unknown;
      readonly next: HookState | null;
    }
    interface FiberLike {
      readonly return: FiberLike | null;
      readonly memoizedState?: HookState | null;
    }
    const isFiber = (value: unknown): value is FiberLike =>
      typeof value === "object" && value !== null && "return" in value;
    /** A `useRef()` hook value (`{ current }`) whose `current` looks like the
     *  list's own ref state (has `scrollAdjustHandler` and `props`). */
    const listRefState = (value: unknown): ListRefState | null => {
      if (typeof value !== "object" || value === null || !("current" in value))
        return null;
      const current = value.current;
      if (
        typeof current !== "object" ||
        current === null ||
        !("scrollAdjustHandler" in current) ||
        !("props" in current)
      )
        return null;
      return current as ListRefState;
    };

    const node = document.querySelector<HTMLElement>(
      '[data-testid="chat-messages-scroll"]',
    );
    if (node === null) throw new Error("no scroll node");
    const fiberKey = Object.keys(node).find((k) =>
      k.startsWith("__reactFiber$"),
    );
    if (fiberKey === undefined) throw new Error("no fiber on the scroll node");
    const raw: unknown = Reflect.get(node, fiberKey);
    let fiber: FiberLike | null = isFiber(raw) ? raw : null;
    let refState: ListRefState | undefined;
    while (fiber !== null && refState === undefined) {
      let hook: HookState | null = fiber.memoizedState ?? null;
      while (hook !== null && refState === undefined) {
        const found = listRefState(hook.memoizedState);
        if (found !== null) refState = found;
        hook = hook.next;
      }
      fiber = fiber.return;
    }
    if (refState === undefined)
      throw new Error("no list refState found on the scroll node's fibers");
    const adjusts: string[] = [];
    const state: ListRefState = refState;
    const h = state.scrollAdjustHandler;
    const orig = h.requestAdjust.bind(h);
    h.requestAdjust = (add: number) => {
      adjusts.push(
        `${Math.round(performance.now())} requestAdjust(${add}) idsInView=${JSON.stringify((state.idsInView ?? []).slice(0, 3))}`,
      );
      return orig(add);
    };
    let edgeEl: HTMLElement | null = null;
    let edgeText = "";
    /** The visible (non-`display:contents`, non-zero-height) element
     *  children of `el`, with a `display:contents` child's own children
     *  substituted in its place. */
    function visibleChildren(el: Element): HTMLElement[] {
      const result: HTMLElement[] = [];
      for (const child of Array.from(el.children)) {
        if (!(child instanceof HTMLElement)) continue;
        if (getComputedStyle(child).display === "contents") {
          result.push(...visibleChildren(child));
          continue;
        }
        if (child.getBoundingClientRect().height > 0) result.push(child);
      }
      return result;
    }
    window.__edge = {
      adjusts,
      anchor: () => {
        const a = state.edgeAnchor;
        if (a === undefined) return "edgeAnchor undefined";
        const n = a.node;
        const r = n?.getBoundingClientRect();
        return `key=${String(a.key)} offset=${String(a.offset)} node=${n?.tagName}.${String(n?.className).slice(0, 40)} nodeTop=${r ? (r.top - node.getBoundingClientRect().top).toFixed(1) : "?"} nodeH=${r ? r.height.toFixed(0) : "?"} edgeEl=${edgeEl ? `${edgeEl.tagName}.${String(edgeEl.className).slice(0, 30)} h=${edgeEl.getBoundingClientRect().height.toFixed(0)}` : "-"}`;
      },
      // The deepest block element crossing the scroller's top edge; on a gap
      // between blocks, the first block below it.
      mark: () => {
        const nodeRect = node.getBoundingClientRect();
        const y = nodeRect.top + 2;
        let hit = document.elementFromPoint(
          nodeRect.left + nodeRect.width / 2,
          y,
        ) as HTMLElement | null;
        while (
          hit &&
          hit !== node &&
          getComputedStyle(hit).display.startsWith("inline")
        )
          hit = hit.parentElement;
        if (!hit || hit === node) return null;
        for (;;) {
          const kids = visibleChildren(hit);
          const crossing = kids.find(
            (c) =>
              c.getBoundingClientRect().top <= y &&
              c.getBoundingClientRect().bottom > y,
          );
          const below = kids.find((c) => c.getBoundingClientRect().top > y);
          const next = crossing ?? below;
          if (!next || getComputedStyle(next).display.startsWith("inline"))
            break;
          hit = next;
        }
        edgeEl = hit;
        edgeText = hit.textContent.slice(0, 60);
        return hit.getBoundingClientRect().top - nodeRect.top;
      },
      // The element is found again by its tag and leading text, because
      // React reuses a node by position when a block is inserted above it.
      top: () => {
        if (!edgeEl) return null;
        const found = Array.from(node.querySelectorAll(edgeEl.tagName)).find(
          (candidate) => candidate.textContent.startsWith(edgeText),
        );
        return found
          ? found.getBoundingClientRect().top - node.getBoundingClientRect().top
          : null;
      },
    };
  });
}

// Each helper narrows `window.__edge` INSIDE its own `page.evaluate`
// callback: Playwright serializes that callback alone to run in the page, so
// a Node-side helper it merely referenced by name would not exist there.
const edge = (page: Page) =>
  page.evaluate(() => {
    if (window.__edge === undefined)
      throw new Error("edge helpers not installed");
    return window.__edge.top();
  });
const edgeMark = (page: Page) =>
  page.evaluate(() => {
    if (window.__edge === undefined)
      throw new Error("edge helpers not installed");
    return window.__edge.mark();
  });
const edgeAnchorText = (page: Page) =>
  page.evaluate(() => {
    if (window.__edge === undefined)
      throw new Error("edge helpers not installed");
    return window.__edge.anchor();
  });
const edgeAdjusts = (page: Page) =>
  page.evaluate(() => {
    if (window.__edge === undefined)
      throw new Error("edge helpers not installed");
    return window.__edge.adjusts;
  });

/** Wheels over the transcript by `deltaY` and returns once the page has
 *  received it. */
async function wheelBy(page: Page, deltaY: number): Promise<void> {
  const box = await page.locator(SCROLL).boundingBox();
  if (box === null) throw new Error("no scroll box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await wheelsDelivered(page, [{ deltaX: 0, deltaY }], 0);
}

async function settleFrames(page: Page, ms: number): Promise<void> {
  await nextFrames(page, 20);
  await page.waitForTimeout(ms);
  await nextFrames(page, 20);
}

function headerTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const nodeEl = document.querySelector<HTMLElement>(
      '[data-testid="chat-messages-scroll"]',
    );
    if (nodeEl === null) throw new Error("no scroll node");
    const btn = document.querySelector<HTMLElement>(
      'button[aria-label^="Thought"]',
    );
    if (btn === null) throw new Error("card button missing");
    return btn.getBoundingClientRect().top - nodeEl.getBoundingClientRect().top;
  });
}

function cardRowHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const btn = document.querySelector<HTMLElement>(
      'button[aria-label^="Thought"]',
    );
    if (btn === null) throw new Error("card button missing");
    const row = btn.closest("[data-message-id]");
    if (row === null) throw new Error("card row missing");
    return row.getBoundingClientRect().height;
  });
}

for (const line of ["legacy", "windowed"] as const) {
  test.describe(line, () => {
    test(`B6 narrower, detached: the element at the edge stays put`, async ({
      page,
    }) => {
      await open(page, line);
      await wheelBy(page, -1500);
      await settleFrames(page, 600);
      await install(page);
      const reading = await page.evaluate(() =>
        window.__chatScrollProbe.readingRow(),
      );
      const before = await edgeMark(page);
      const anchor = await edgeAnchorText(page);
      await page.setViewportSize({ width: 600, height: 700 });
      await settleFrames(page, 900);
      const after = await edge(page);
      const rowAfter = await page.evaluate(() =>
        window.__chatScrollProbe.readingRow(),
      );
      const adjusts = await edgeAdjusts(page);
      const report = `[${line} B6] edge ${String(before)} -> ${String(after)} (Δ ${before !== null && after !== null ? (after - before).toFixed(1) : "?"}); row ref ${JSON.stringify(reading)} -> ${JSON.stringify(rowAfter)}; anchor before: ${anchor}; adjusts=${String(adjusts.length)}\n${adjusts.join("\n")}`;
      test.info().annotations.push({ type: "report", description: report });
      process.stdout.write(`${report}\n`);
      expect(anchor, report).not.toContain("undefined");
      expect(before, report).not.toBeNull();
      expect(after, report).not.toBeNull();
      expect(
        Math.abs((after ?? 0) - (before ?? 0)),
        report,
      ).toBeLessThanOrEqual(1);
    });

    for (const [name, headerY] of [
      ["straddle", 100],
      ["control", 552],
    ] as const) {
      test(`B4 ${name}: opening then closing the card moves nothing`, async ({
        page,
      }) => {
        await open(page, line);
        await page.evaluate(() => {
          window.__chatScrollProbe.appendTallCardTurn();
          for (let i = 0; i < 3; i += 1) window.__chatScrollProbe.appendTurn();
        });
        await nextFrames(page, 60);
        const nodeBox = await page.locator(SCROLL).boundingBox();
        if (nodeBox === null) throw new Error("no scroll box");
        await page.mouse.move(
          nodeBox.x + nodeBox.width / 2,
          nodeBox.y + nodeBox.height / 2,
        );
        for (let i = 0; i < 12; i += 1) {
          const hb = await page.locator(CARD).boundingBox();
          const y = hb === null ? null : hb.y - nodeBox.y;
          if (y !== null && Math.abs(y - headerY) <= 3) break;
          await wheelsDelivered(
            page,
            [
              {
                deltaX: 0,
                deltaY: y === null ? -600 : Math.round(y - headerY),
              },
            ],
            0,
          );
          await nextFrames(page, 20);
        }
        await settleFrames(page, 600);
        await install(page);
        const rowTop = await page.evaluate(() => {
          const nodeEl = document.querySelector<HTMLElement>(
            '[data-testid="chat-messages-scroll"]',
          );
          if (nodeEl === null) throw new Error("no scroll node");
          const btn = document.querySelector<HTMLElement>(
            'button[aria-label^="Thought"]',
          );
          if (btn === null) throw new Error("card button missing");
          const row = btn.closest("[data-message-id]");
          if (row === null) throw new Error("card row missing");
          return (
            row.getBoundingClientRect().top - nodeEl.getBoundingClientRect().top
          );
        });
        // A scroll after install, so the list records its edge anchor.
        await wheelBy(page, 2);
        await settleFrames(page, 300);
        const anchor = await edgeAnchorText(page);
        const before = await headerTop(page);
        await page.locator(CARD).click();
        await settleFrames(page, 700);
        const expanded = await headerTop(page);
        await page.locator(CARD).click();
        await settleFrames(page, 700);
        const collapsed = await headerTop(page);
        const adjusts = await edgeAdjusts(page);
        const report = `[${line} B4 ${name}] row top ${rowTop.toFixed(0)} header ${before.toFixed(1)} -> expand ${expanded.toFixed(1)} (Δ ${(expanded - before).toFixed(1)}) -> collapse ${collapsed.toFixed(1)} (Δ ${(collapsed - before).toFixed(1)}); anchor: ${anchor}; adjusts=${String(adjusts.length)}\n${adjusts.join("\n")}`;
        process.stdout.write(`${report}\n`);
        expect(anchor, report).not.toContain("undefined");
        expect(Math.abs(expanded - before), report).toBeLessThanOrEqual(1);
        expect(Math.abs(collapsed - before), report).toBeLessThanOrEqual(1);
      });
    }
  });
}

test(`legacy: a block that appears above the edge inside the row leaves the edge element put`, async ({
  page,
}) => {
  await open(page, "legacy");
  await page.evaluate(() => {
    window.__chatScrollProbe.appendTallCardTurn();
    for (let i = 0; i < 3; i += 1) window.__chatScrollProbe.appendTurn();
  });
  await nextFrames(page, 60);
  const nodeBox = await page.locator(SCROLL).boundingBox();
  if (nodeBox === null) throw new Error("no scroll box");
  await page.mouse.move(
    nodeBox.x + nodeBox.width / 2,
    nodeBox.y + nodeBox.height / 2,
  );
  const rowTopNow = () =>
    page.evaluate(() => {
      const nodeEl = document.querySelector<HTMLElement>(
        '[data-testid="chat-messages-scroll"]',
      );
      if (nodeEl === null) throw new Error("no scroll node");
      const row =
        document
          .querySelector<HTMLElement>('button[aria-label^="Thought"]')
          ?.closest("[data-message-id]") ?? null;
      return row === null
        ? null
        : row.getBoundingClientRect().top - nodeEl.getBoundingClientRect().top;
    });
  for (let i = 0; i < 12; i += 1) {
    const top = await rowTopNow();
    if (top !== null && Math.abs(top + 400) <= 3) break;
    await wheelsDelivered(
      page,
      [{ deltaX: 0, deltaY: top === null ? -600 : Math.round(top + 400) }],
      0,
    );
    await nextFrames(page, 20);
  }
  await settleFrames(page, 600);
  await install(page);
  await wheelBy(page, 2);
  await settleFrames(page, 300);
  const rowBefore = await cardRowHeight(page);
  const before = await edgeMark(page);
  const anchor = await edgeAnchorText(page);
  await page.evaluate(() =>
    window.__chatScrollProbe.insertAboveInRow("message-49", 2),
  );
  await settleFrames(page, 900);
  const after = await edge(page);
  const rowAfter = await cardRowHeight(page);
  const adjusts = await edgeAdjusts(page);
  const report = `[legacy NEW] row ${rowBefore.toFixed(0)} -> ${rowAfter.toFixed(0)} (+${(rowAfter - rowBefore).toFixed(0)}); edge ${String(before)} -> ${String(after)} (Δ ${before !== null && after !== null ? (after - before).toFixed(1) : "?"}); anchor: ${anchor}; adjusts=${String(adjusts.length)}\n${adjusts.join("\n")}`;
  process.stdout.write(`${report}\n`);
  expect(anchor, report).not.toContain("undefined");
  if (before === null || after === null) throw new Error(report);
  expect(Math.abs(after - before), report).toBeLessThanOrEqual(1);
});
