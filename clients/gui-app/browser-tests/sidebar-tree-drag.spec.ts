import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture, nextFrames, type Point } from "./support/fixtures.ts";

// The virtualised sidebar chat tree under the real `RootDndProvider`
// (`chat-tree-drag.html`): real pointer and keyboard drags over a few hundred
// chats, so most rows are not mounted when a drag starts. What is claimed here
// is what jsdom cannot decide: auto-scroll bringing drop targets in, a drop on
// a row that was not mounted at drag start, rows that move mid-drag still being
// hit where they now are, and the source row and the overlay surviving a far
// scroll.

test.use({ viewport: { width: 1200, height: 800 }, colorScheme: "light" });

const SCROLLER = '[data-sidebar="content"]';
const ROW_PREFIX = "epic-sidebar-item-";
const RING = /ring-primary\/70/;
const FAR_SCROLL_PX = 700;
/** Neither the first nor the last row, so only the drag keeps it mounted. */
const SOURCE = "chat-005";
const CHAT_COUNT = 300;

interface ReparentRequest {
  readonly chatId: string;
  readonly newParentId: string | null;
}

async function openTree(page: Page, chats: number): Promise<void> {
  await page.goto(`${fixture("chat-tree-drag")}?chats=${String(chats)}`);
  await page.waitForFunction("window.__chatTreeDragProbe?.ready === true");
  await expect(page.getByTestId(`${ROW_PREFIX}chat-000`)).toBeVisible();
}

function scroller(page: Page): Locator {
  return page
    .locator(SCROLLER)
    .filter({ has: page.locator("ul[role=tree]") })
    .last();
}

function row(page: Page, id: string): Locator {
  return page.getByTestId(`${ROW_PREFIX}${id}`);
}

/** The row's drop wrapper, which carries the reparent highlight. */
function dropWrapper(page: Page, id: string): Locator {
  return page
    .locator('[data-slot="context-menu-trigger"]')
    .filter({ has: row(page, id) });
}

async function mountedIds(page: Page): Promise<string[]> {
  return page.evaluate(
    (prefix) =>
      [...document.querySelectorAll(`[data-testid^="${prefix}"]`)].map(
        (element) =>
          (element.getAttribute("data-testid") ?? "").slice(prefix.length),
      ),
    ROW_PREFIX,
  );
}

async function scrollTop(page: Page): Promise<number> {
  return scroller(page).evaluate((node) => node.scrollTop);
}

/** Waits until the scroller has stopped moving, in frames. */
async function scrollSettled(page: Page): Promise<void> {
  let last = -1;
  let stable = 0;
  while (stable < 6) {
    await nextFrames(page, 1);
    const now = await scrollTop(page);
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
}

async function scrollerBox(page: Page) {
  const box = await scroller(page).boundingBox();
  if (box === null) throw new Error("the sidebar scroller has no box");
  return box;
}

async function centreOf(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`no box for ${locator.toString()}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A real pointer press on the row, then enough movement to pass the activation distance. */
async function startDrag(page: Page, id: string): Promise<Point> {
  const at = await centreOf(row(page, id));
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 12, at.y + 12, { steps: 4 });
  await expect(overlay(page)).toHaveCount(1);
  return { x: at.x + 12, y: at.y + 12 };
}

function overlay(page: Page): Locator {
  return page.locator('div[style*="position: fixed"][style*="touch-action"]');
}

/**
 * Holds the pointer on the centre of the mounted row whose centre lies deepest
 * inside the scroller (at most 8px above its bottom edge) until the list has
 * scrolled `px`, re-aiming at the row now deepest whenever the scroll stalls.
 * A pointer in the gap between rows is over the panel's un-nest zone, whose
 * ancestors do not include the scroller, so dnd-kit scrolls nothing until the
 * pointer moves.
 */
async function autoScrollBy(
  page: Page,
  x: number,
  px: number,
  dragged: string,
): Promise<{ readonly reaims: number; readonly y: number }> {
  const box = await scrollerBox(page);
  const aim = box.y + box.height - 8;
  let reaims = 0;
  let y = aim;
  const deadline = Date.now() + 90_000;
  while ((await scrollTop(page)) <= px) {
    if (Date.now() > deadline) {
      throw new Error(
        `auto-scroll never passed ${String(px)}px (${String(reaims)} re-aims)`,
      );
    }
    const near = await rowDeepest(page, aim, [dragged]);
    y = (await centreOf(row(page, near))).y;
    await page.mouse.move(x, y, { steps: 2 });
    const before = await scrollTop(page);
    for (
      let frame = 0;
      frame < 30 && (await scrollTop(page)) === before;
      frame += 1
    ) {
      await nextFrames(page, 1);
    }
    if ((await scrollTop(page)) === before) {
      reaims += 1;
      const lit = await highlighted(page);
      const frames = JSON.stringify(
        await page.evaluate("window.__chatTreeDragProbe.frames(40)"),
      );
      const testInfo = test.info();
      await testInfo.attach("stall-frames", {
        body: frames,
        contentType: "application/json",
      });
      expect(
        lit,
        `no row may be lit while the scroll is stalled; last frames: ${frames}`,
      ).toBeNull();
    }
  }
  return { reaims, y };
}

/** The mounted row whose centre lies deepest in the scroller without leaving it. */
async function rowDeepest(
  page: Page,
  bottom: number,
  except: readonly string[],
): Promise<string> {
  const found = await page.evaluate(
    ({ prefix, limit, skip }) => {
      let best: { id: string; y: number } | null = null;
      for (const element of document.querySelectorAll(
        `[data-testid^="${prefix}"]`,
      )) {
        const id = (element.getAttribute("data-testid") ?? "").slice(
          prefix.length,
        );
        if (skip.includes(id)) continue;
        const rect = element.getBoundingClientRect();
        const y = rect.top + rect.height / 2;
        if (y > limit) continue;
        if (best === null || y > best.y) best = { id, y };
      }
      return best?.id ?? null;
    },
    { prefix: ROW_PREFIX, limit: bottom, skip: [...except] },
  );
  if (found === null)
    throw new Error("no mounted row inside the scroller bottom");
  return found;
}

/** The mounted row, other than `except`, whose centre is nearest `y`. */
async function rowNearest(
  page: Page,
  y: number,
  except: readonly string[],
): Promise<string> {
  const found = await page.evaluate(
    ({ prefix, targetY, skip }) => {
      let best: { id: string; gap: number } | null = null;
      for (const element of document.querySelectorAll(
        `[data-testid^="${prefix}"]`,
      )) {
        const id = (element.getAttribute("data-testid") ?? "").slice(
          prefix.length,
        );
        if (skip.includes(id)) continue;
        const rect = element.getBoundingClientRect();
        const gap = Math.abs(rect.top + rect.height / 2 - targetY);
        if (best === null || gap < best.gap) best = { id, gap };
      }
      return best?.id ?? null;
    },
    { prefix: ROW_PREFIX, targetY: y, skip: [...except] },
  );
  if (found === null) throw new Error("no mounted row near the point");
  return found;
}

async function reparentRequests(page: Page): Promise<ReparentRequest[]> {
  return page.evaluate("window.__chatTreeDragProbe.reparentRequests()");
}

async function release(page: Page): Promise<void> {
  await page.mouse.up();
  await expect(overlay(page)).toHaveCount(0);
}

/**
 * Drags SOURCE down the list by auto-scroll, settles the pointer mid-panel
 * and returns the row it is over, which was not mounted when the drag started.
 */
async function dragToOffscreenRow(
  page: Page,
  condition: { readonly reducedMotion: boolean; readonly blurSource: boolean },
): Promise<{
  readonly target: string;
  readonly initial: readonly string[];
}> {
  if (condition.reducedMotion)
    await page.emulateMedia({ reducedMotion: "reduce" });
  await openTree(page, CHAT_COUNT);
  const initial = await mountedIds(page);
  const start = await startDrag(page, SOURCE);
  if (condition.blurSource) {
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
  }
  const scrolled = await autoScrollBy(page, start.x, FAR_SCROLL_PX, SOURCE);
  test
    .info()
    .annotations.push({ type: "reaims", description: String(scrolled.reaims) });
  const box = await scrollerBox(page);
  const middle = box.y + box.height / 2;
  await page.mouse.move(start.x, middle, { steps: 4 });
  await scrollSettled(page);
  const target = await rowNearest(page, middle, [SOURCE]);
  // On a tree that mounts every row there is nothing off-screen to prove.
  if (initial.length < CHAT_COUNT) {
    expect(
      initial,
      "the target must not have been mounted at drag start",
    ).not.toContain(target);
  }
  const at = await centreOf(row(page, target));
  await page.mouse.move(start.x, at.y, { steps: 3 });
  return { target, initial };
}

const AS_IS = { reducedMotion: false, blurSource: false };

test("A: auto-scroll mounts rows that were not there at drag start, and hovering one lights its reparent highlight", async ({
  page,
}) => {
  const { target } = await dragToOffscreenRow(page, AS_IS);
  await expect(dropWrapper(page, target)).toHaveClass(RING);
  await page.mouse.up();
});

test("A-motion-off: the same with row motion reduced", async ({ page }) => {
  const { target } = await dragToOffscreenRow(page, {
    reducedMotion: true,
    blurSource: false,
  });
  await expect(dropWrapper(page, target)).toHaveClass(RING);
  await page.mouse.up();
});

test("A-blurred: the same with the source row blurred after the drag starts", async ({
  page,
}) => {
  const { target } = await dragToOffscreenRow(page, {
    reducedMotion: false,
    blurSource: true,
  });
  await expect(dropWrapper(page, target)).toHaveClass(RING);
  await page.mouse.up();
});

test("B: releasing over a row that was off-screen at drag start reparents the chat under it", async ({
  page,
}) => {
  const { target } = await dragToOffscreenRow(page, AS_IS);
  await expect(dropWrapper(page, target)).toHaveClass(RING);
  await release(page);
  await expect
    .poll(() => reparentRequests(page))
    .toEqual([{ chatId: SOURCE, newParentId: target }]);
  await expect
    .poll(() =>
      page.evaluate((id) => window.__chatTreeDragProbe.parentOf(id), SOURCE),
    )
    .toBe(target);
  await page.evaluate((id) => window.__chatTreeDragProbe.expand(id), target);
  await expect(
    page.locator('li[aria-level="2"]').filter({ has: row(page, SOURCE) }),
    "the chat shows one level under its new parent once it is expanded",
  ).toHaveCount(1);
});

test("C: dropping a nested chat on the panel's empty space un-nests it to root", async ({
  page,
}) => {
  await openTree(page, 6);
  await expect(row(page, "chat-002-a")).toBeVisible();
  const last = await centreOf(row(page, "chat-005"));
  const box = await scrollerBox(page);
  const empty = {
    x: last.x,
    y: Math.min(last.y + 90, box.y + box.height - 10),
  };
  expect(empty.y, "the point must lie below the last row").toBeGreaterThan(
    last.y + 20,
  );
  const start = await startDrag(page, "chat-002-a");
  await page.mouse.move(empty.x, empty.y, { steps: 6 });
  await expect(page.locator('[class*="ring-primary/50"]')).toHaveCount(1);
  await release(page);
  await expect
    .poll(() => reparentRequests(page))
    .toEqual([{ chatId: "chat-002-a", newParentId: null }]);
  void start;
});

test("D: the dragged row stays mounted through a far scroll, the overlay stays under the pointer and auto-scroll keeps going", async ({
  page,
}) => {
  await openTree(page, CHAT_COUNT);
  const start = await startDrag(page, SOURCE);
  // A press focuses the row, and a focused row is kept mounted by its own pin:
  // blurred, only the drag holds it.
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  expect(
    await page.evaluate(
      (id) =>
        document.activeElement?.getAttribute("data-testid") ===
        `epic-sidebar-item-${id}`,
      SOURCE,
    ),
    "the source row must no longer be focused",
  ).toBe(false);
  const scrolled = await autoScrollBy(page, start.x, FAR_SCROLL_PX, SOURCE);
  test
    .info()
    .annotations.push({ type: "reaims", description: String(scrolled.reaims) });
  const first = await scrollTop(page);
  const ids = await mountedIds(page);
  expect(ids, "the source row must stay mounted").toContain(SOURCE);
  expect(
    ids,
    "an equally distant row that is not dragged must have unmounted",
  ).not.toContain("chat-001");
  const box = await overlay(page).boundingBox();
  if (box === null) throw new Error("no overlay box");
  const held = { x: start.x, y: scrolled.y };
  expect(held.x, "overlay must be under the pointer (x)").toBeGreaterThan(
    box.x - 5,
  );
  expect(held.x).toBeLessThan(box.x + box.width + 5);
  expect(
    held.y,
    "overlay must be under the pointer (y), not jumped to the corner",
  ).toBeGreaterThan(box.y - 5);
  expect(held.y).toBeLessThan(box.y + box.height + 5);
  await expect
    .poll(() => scrollTop(page), { message: "auto-scroll must keep going" })
    .toBeGreaterThan(first + 200);
  // Cancelled, not dropped: a drop would reparent the chat beside the row it is over.
  await page.keyboard.press("Escape");
  await expect(overlay(page)).toHaveCount(0);
  await page.mouse.up();
});

test("E: a row that grows mid-drag moves the rows below it with every row still mounted, and the highlight and drop land on the target where it is now", async ({
  page,
}) => {
  // Every row of a short list is mounted, so growing one changes no drop
  // target: only the re-measure of the rows that moved can correct the rects.
  await openTree(page, 12);
  await page.evaluate(() => window.__chatTreeDragProbe.collapse("chat-002"));
  await expect(row(page, "chat-002-a")).toHaveCount(0);
  const start = await startDrag(page, SOURCE);
  const mountedBefore = (await mountedIds(page)).sort();
  const target = "chat-003";
  const grown = "chat-002";
  const targetBefore = await centreOf(row(page, target));
  expect((await centreOf(row(page, grown))).y).toBeLessThan(targetBefore.y);
  await row(page, grown).evaluate((element) => {
    element.style.minHeight = "60px";
  });
  await expect
    .poll(async () => (await centreOf(row(page, target))).y, {
      message: "the target must move down",
    })
    .toBeGreaterThan(targetBefore.y + 20);
  await nextFrames(page, 4);
  expect(
    (await mountedIds(page)).sort(),
    "the growth must not change which rows are mounted, or dnd-kit re-measures by itself",
  ).toEqual(mountedBefore);
  const targetNow = await centreOf(row(page, target));
  const scrollerNow = await scrollerBox(page);
  expect(
    targetNow.y,
    "the target must stay clear of the auto-scroll zone",
  ).toBeLessThan(scrollerNow.y + scrollerNow.height * 0.8);
  await page.mouse.move(start.x, targetNow.y, { steps: 3 });
  await expect(dropWrapper(page, target)).toHaveClass(RING);
  await release(page);
  await expect
    .poll(() => reparentRequests(page))
    .toEqual([{ chatId: SOURCE, newParentId: target }]);
});

test("F: a folder that springs open mid-drag does not stale the rows below it: the drop lands on the row hovered", async ({
  page,
}) => {
  await openTree(page, CHAT_COUNT);
  await page.evaluate(() => window.__chatTreeDragProbe.collapse("chat-001"));
  await expect(row(page, "chat-001-a")).toHaveCount(0);
  const folderBelow = (await centreOf(row(page, "chat-002"))).y;
  const start = await startDrag(page, SOURCE);
  const folder = await centreOf(row(page, "chat-001"));
  await page.mouse.move(start.x, folder.y, { steps: 4 });
  await expect(
    row(page, "chat-001-a"),
    "the folder must spring open",
  ).toBeVisible();
  await nextFrames(page, 4);
  const beforeOpen = folderBelow;
  const below = await centreOf(row(page, "chat-002"));
  expect(
    below.y,
    "the row below the folder must have moved down when it opened",
  ).toBeGreaterThan(beforeOpen + 50);
  await page.mouse.move(start.x, below.y, { steps: 4 });
  await expect(dropWrapper(page, "chat-002")).toHaveClass(RING);
  await release(page);
  await expect
    .poll(() => reparentRequests(page))
    .toEqual([{ chatId: SOURCE, newParentId: "chat-002" }]);
});

async function highlighted(page: Page): Promise<string | null> {
  return page.evaluate((prefix) => {
    for (const wrapper of document.querySelectorAll(
      '[data-slot="context-menu-trigger"]',
    )) {
      if (!wrapper.className.includes("ring-primary/70")) continue;
      const item = wrapper.querySelector(`[data-testid^="${prefix}"]`);
      return (item?.getAttribute("data-testid") ?? "").slice(prefix.length);
    }
    return null;
  }, ROW_PREFIX);
}

test("G: a keyboard drag carried past the window mounts rows that were not there, highlights one, and drops on it", async ({
  page,
}) => {
  await openTree(page, CHAT_COUNT);
  const initial = await mountedIds(page);
  await row(page, SOURCE).focus();
  await page.keyboard.press("Space");
  await expect(overlay(page)).toHaveCount(1);
  let target: string | null = null;
  for (let press = 0; press < 150 && target === null; press += 1) {
    await page.keyboard.press("ArrowDown");
    await nextFrames(page, 1);
    const lit = await highlighted(page);
    if (lit !== null && !initial.includes(lit)) {
      // The sensor may still be scrolling the list under the overlay.
      await scrollSettled(page);
      const still = await highlighted(page);
      if (still !== null && !initial.includes(still)) target = still;
    }
  }
  if (target === null)
    throw new Error(
      "the keyboard drag never reached a row that was not mounted at its start",
    );
  await page.keyboard.press("Space");
  await expect(overlay(page)).toHaveCount(0);
  await expect
    .poll(() => reparentRequests(page))
    .toEqual([{ chatId: SOURCE, newParentId: target }]);
});
