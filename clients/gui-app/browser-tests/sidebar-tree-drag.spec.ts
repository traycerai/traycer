import { expect, test, type Locator, type Page } from "@playwright/test";

import type {
  DragStep,
  DragStepResult,
} from "./support/chat-tree-drag-globals.d.ts";
import { fixture, type Point } from "./support/fixtures.ts";

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

async function openTreeAt(page: Page, search: string): Promise<void> {
  await page.goto(`${fixture("chat-tree-drag")}?${search}`);
  await page.waitForFunction("window.__chatTreeDragProbe?.ready === true");
  await expect(page.getByTestId(`${ROW_PREFIX}chat-000`)).toBeVisible();
}

async function openTree(page: Page, chats: number): Promise<void> {
  await openTreeAt(page, `chats=${String(chats)}`);
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

async function isVirtualTree(page: Page): Promise<boolean> {
  return (
    (await scroller(page).locator("ul[data-chat-tree-row-count]").count()) === 1
  );
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

async function scrollStep(
  page: Page,
  input: { readonly kind: DragStep; readonly y: number | null },
  action: () => Promise<void>,
  timeout: number,
): Promise<DragStepResult> {
  await page.evaluate(
    ({ step, pointerY }) => window.__chatTreeDragProbe.armStep(step, pointerY),
    { step: input.kind, pointerY: input.y },
  );
  try {
    await action();
    await page.evaluate(() => window.__chatTreeDragProbe.finishInput());
    const result = await page.waitForFunction(
      () => window.__chatTreeDragProbe.stepResult(),
      undefined,
      { timeout },
    );
    return await result.jsonValue();
  } finally {
    await page.evaluate(() => window.__chatTreeDragProbe.stopStep());
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
 * dnd-kit scrolls a list while the pointer is inside the strip along its edge
 * this share of the list's height deep (its default threshold).
 */
const AUTO_SCROLL_STRIP = 0.2;

/** A tagged row's box in the viewport and its nearest transform. */
interface TaggedRowBox {
  readonly id: string;
  readonly top: number;
  readonly bottom: number;
  readonly transform: string;
}

interface StripGeometry {
  readonly x: number;
  readonly heldY: number | null;
  readonly scrollTop: number;
  readonly scrollGeneration: number;
  readonly clientHeight: number;
  readonly stripTop: number;
  readonly stripBottom: number;
  /** End of the last mounted virtual item shell in scroller coordinates. */
  readonly lastVirtualItemEnd: number | null;
  readonly rows: readonly TaggedRowBox[];
}

type StripRead =
  | { readonly kind: "aim"; readonly y: number }
  | { readonly kind: "no-hit"; readonly geometry: StripGeometry }
  | {
      readonly kind: "held-point";
      readonly rowId: string | null;
      readonly geometry: StripGeometry;
    };

/**
 * Picks a point inside the bottom strip that hits a non-dragged row. When
 * checking a held point, captures the hit and the scroller generation together.
 */
async function readStrip(
  page: Page,
  x: number,
  input: {
    readonly held: number | null;
    readonly dragged: string;
    readonly previousAim: number | null;
  },
): Promise<StripRead> {
  return scroller(page).evaluate(
    (list, { prefix, share, at, heldY, skip, priorAim }): StripRead => {
      const box = list.getBoundingClientRect();
      const { clientHeight, scrollTop } = list;
      const stripTop = box.bottom - share * clientHeight;
      const stripBottom = box.bottom - 1;
      const rowSelector = `[data-testid^="${prefix}"]`;
      const rowId = (element: Element): string =>
        (element.getAttribute("data-testid") ?? "").slice(prefix.length);

      function hitRow(y: number): string | null {
        // The drag overlay can be above the tree in the hit stack.
        const element = document
          .elementsFromPoint(at, y)
          .find((hit) => list.contains(hit) && hit.matches(rowSelector));
        if (element === undefined) return null;
        const id = rowId(element);
        return id === skip ? null : id;
      }

      function transformOf(element: Element): string {
        for (
          let node: Element | null = element;
          node !== null && node !== list;
          node = node.parentElement
        ) {
          const transform = getComputedStyle(node).transform;
          if (transform !== "none") return transform;
        }
        return "none";
      }

      function geometry(): StripGeometry {
        const rows = [...list.querySelectorAll(rowSelector)].map((element) => {
          const { top, bottom } = element.getBoundingClientRect();
          return {
            id: rowId(element),
            top,
            bottom,
            transform: transformOf(element),
          };
        });
        let lastVirtualItemEnd: number | null = null;
        for (const item of list.querySelectorAll(
          'ul[role="tree"] > li[data-index][data-row-key]',
        )) {
          const end = item.getBoundingClientRect().bottom - box.top + scrollTop;
          lastVirtualItemEnd = Math.max(lastVirtualItemEnd ?? end, end);
        }
        return {
          x: at,
          heldY,
          scrollTop,
          scrollGeneration: window.__chatTreeDragProbe.scrollGeneration(),
          clientHeight,
          stripTop,
          stripBottom,
          lastVirtualItemEnd,
          rows,
        };
      }

      if (heldY === null) {
        for (let y = Math.floor(stripBottom); y >= stripTop; y -= 1) {
          // A fresh coordinate produces a new sensor action even when the
          // deepest hit is the point that was already held.
          if (y !== priorAim && hitRow(y) !== null) return { kind: "aim", y };
        }
        return { kind: "no-hit", geometry: geometry() };
      }

      const heldOn =
        heldY >= stripTop && heldY <= stripBottom ? hitRow(heldY) : null;
      return { kind: "held-point", rowId: heldOn, geometry: geometry() };
    },
    {
      prefix: ROW_PREFIX,
      share: AUTO_SCROLL_STRIP,
      at: x,
      heldY: input.held,
      skip: input.dragged,
      priorAim: input.previousAim,
    },
  );
}

async function attachJson(name: string, value: unknown): Promise<void> {
  const testInfo = test.info();
  await testInfo.attach(name, {
    body: JSON.stringify(value),
    contentType: "application/json",
  });
}

/**
 * Holds the pointer at the deepest point of dnd-kit's bottom auto-scroll strip
 * that lies on a mounted row other than `dragged`, re-aiming after every move
 * of the list, until the list has scrolled `px`. A point between rows is over
 * the panel's un-nest zone, whose ancestors do not include the scroller, and a
 * point above the strip asks for no scroll. A wait only succeeds on a
 * scroll offset change or a committed loss of the scroll ancestor.
 */
async function autoScrollBy(
  page: Page,
  x: number,
  px: number,
  dragged: string,
): Promise<{ readonly reaims: number; readonly y: number }> {
  let reaims = 0;
  let y = 0;
  const deadline = Date.now() + 90_000;
  while ((await scrollTop(page)) <= px) {
    if (Date.now() > deadline) {
      throw new Error(
        `auto-scroll never passed ${String(px)}px (${String(reaims)} re-aims)`,
      );
    }
    const read = await readStrip(page, x, {
      held: null,
      dragged,
      previousAim: y,
    });
    if (read.kind === "no-hit") {
      await attachJson("strip", read.geometry);
      throw new Error(
        `no fresh mounted-row aim at this x in the activation strip\n${JSON.stringify(read.geometry)}`,
      );
    }
    if (read.kind !== "aim") throw new Error("no auto-scroll aim");
    y = read.y;
    let outcome: DragStepResult;
    try {
      outcome = await scrollStep(
        page,
        { kind: "edge", y: y },
        () => page.mouse.move(x, y, { steps: 2 }),
        Math.max(1, Math.min(5_000, deadline - Date.now())),
      );
    } catch (error) {
      const frames = await page.evaluate(() =>
        window.__chatTreeDragProbe.frames(60),
      );
      await attachJson("stall-frames", frames);
      const held = await readStrip(page, x, {
        held: y,
        dragged,
        previousAim: null,
      });
      await attachJson("strip", held);
      throw error;
    }
    if (outcome.outcome === "advanced") continue;
    const held = await readStrip(page, x, {
      held: y,
      dragged,
      previousAim: null,
    });
    if (held.kind !== "held-point") throw new Error("no held-point geometry");
    // The viewport may have moved between the committed target observation
    // and this hit test. Diagnose only observations of the same offset.
    if (
      held.geometry.scrollTop !== outcome.scrollTop ||
      held.geometry.scrollGeneration !== outcome.scrollGeneration
    ) {
      continue;
    }
    if (outcome.outcome === "panel-gap" && held.rowId === null) {
      reaims += 1;
      continue;
    }
    await attachJson("strip", held.geometry);
    await attachJson("dnd-target", outcome);
    throw new Error("the committed drop target and the current hit disagree");
  }
  return { reaims, y };
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

/**
 * The row's centre once it is at rest: its motion wrapper (the parent of its
 * drop wrapper) no longer holds a layout transform, so any slide has arrived.
 */
async function restedY(page: Page, id: string): Promise<number> {
  const wrapper = dropWrapper(page, id).locator("xpath=..");
  await expect
    .poll(() => wrapper.evaluate((node) => getComputedStyle(node).transform), {
      message: `${id} must come to rest`,
      timeout: 10_000,
    })
    .toBe("none");
  return (await centreOf(row(page, id))).y;
}

/** Starts recording whether the row's motion wrapper ever holds a transform. */
async function watchSlide(page: Page, id: string): Promise<void> {
  await page.evaluate(
    ({ prefix, rowId }) => {
      const state = { seen: false, stop: false };
      Reflect.set(window, "__rowSlide", state);
      const tick = (): void => {
        const wrapper = document
          .querySelector(`[data-testid="${prefix}${rowId}"]`)
          ?.closest('[data-slot="context-menu-trigger"]')?.parentElement;
        if (wrapper && getComputedStyle(wrapper).transform !== "none") {
          state.seen = true;
        }
        if (!state.stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    { prefix: ROW_PREFIX, rowId: id },
  );
}

async function slideSeen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const state: unknown = Reflect.get(window, "__rowSlide");
    if (typeof state !== "object" || state === null) return false;
    Reflect.set(state, "stop", true);
    return Reflect.get(state, "seen") === true;
  });
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
  const middle = Math.round(box.y + box.height / 2);
  await scrollStep(
    page,
    { kind: "middle", y: middle },
    () => page.mouse.move(start.x, middle, { steps: 4 }),
    5_000,
  );
  const target = await rowNearest(page, middle, [SOURCE]);
  // Only the windowed tree can demonstrate new mounting on the same input.
  if (await isVirtualTree(page)) {
    expect(
      initial,
      "the target must not have been mounted at drag start",
    ).not.toContain(target);
  }
  const at = await centreOf(row(page, target));
  await page.mouse.move(start.x, at.y, { steps: 3 });
  return { target };
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
  await startDrag(page, "chat-002-a");
  await page.mouse.move(empty.x, empty.y, { steps: 6 });
  await expect(page.locator('[class*="ring-primary/50"]')).toHaveCount(1);
  await release(page);
  await expect
    .poll(() => reparentRequests(page))
    .toEqual([{ chatId: "chat-002-a", newParentId: null }]);
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
  // The collapse slides the rows below up; the press lands where SOURCE ends.
  await restedY(page, SOURCE);
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
  const targetNowY = await restedY(page, target);
  expect(
    (await mountedIds(page)).sort(),
    "the growth must not change which rows are mounted, or dnd-kit re-measures by itself",
  ).toEqual(mountedBefore);
  const targetNow = { x: start.x, y: targetNowY };
  const scrollerNow = await scrollerBox(page);
  expect(
    targetNow.y,
    "the target must stay clear of the auto-scroll zone",
  ).toBeLessThan(scrollerNow.y + scrollerNow.height * 0.8);
  await page.mouse.move(start.x, targetNow.y, { steps: 3 });
  await expect(dropWrapper(page, target)).toHaveClass(RING);
  expect(
    (await mountedIds(page)).sort(),
    "the mounted rows must be the same at the drop, so only the re-measure could have corrected the targets",
  ).toEqual(mountedBefore);
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
  // The collapse slides the rows below up; measure and press where they end.
  await restedY(page, SOURCE);
  const folderBelow = (await centreOf(row(page, "chat-002"))).y;
  const start = await startDrag(page, SOURCE);
  const folder = await centreOf(row(page, "chat-001"));
  await page.mouse.move(start.x, folder.y, { steps: 4 });
  await expect(
    row(page, "chat-001-a"),
    "the folder must spring open",
  ).toBeVisible();
  const belowY = await restedY(page, "chat-002");
  expect(
    belowY,
    "the row below the folder must have moved down when it opened",
  ).toBeGreaterThan(folderBelow + 50);
  await page.mouse.move(start.x, belowY, { steps: 4 });
  await expect(dropWrapper(page, "chat-002")).toHaveClass(RING);
  await release(page);
  await expect
    .poll(() => reparentRequests(page))
    .toEqual([{ chatId: SOURCE, newParentId: "chat-002" }]);
});

test("H: a row slide after auto-scroll does not stale the targets: the drop lands on the row hovered", async ({
  page,
}) => {
  await openTreeAt(page, `chats=${String(CHAT_COUNT)}&folders=1`);
  const folders = Array.from(
    { length: 25 },
    (_, step) => `chat-${String(10 + step * 2).padStart(3, "0")}`,
  );
  for (const folder of folders) {
    await page.evaluate(
      (id) => window.__chatTreeDragProbe.collapse(id),
      folder,
    );
  }
  const start = await startDrag(page, SOURCE);
  await autoScrollBy(page, start.x, FAR_SCROLL_PX, SOURCE);
  const box = await scrollerBox(page);
  const middle = Math.round(box.y + box.height / 2);
  await scrollStep(
    page,
    { kind: "middle", y: middle },
    () => page.mouse.move(start.x, middle, { steps: 4 }),
    5_000,
  );
  // A collapsed folder in the upper part of the window, whose opening slides
  // the rows below it by its three children. The band starts below dnd-kit's
  // top auto-scroll zone (the top 20% of the scroller), so hovering the
  // folder scrolls nothing, and ends high enough that the slid target stays
  // above the bottom zone (from 80%). Folders sit every second root (60px),
  // so the band (18% of 362px) always holds one.
  const mounted = await mountedIds(page);
  let folder: string | null = null;
  for (const id of folders) {
    if (!mounted.includes(id)) continue;
    const at = await centreOf(row(page, id));
    if (at.y > box.y + box.height * 0.22 && at.y < box.y + box.height * 0.4) {
      folder = id;
    }
  }
  if (folder === null)
    throw new Error("no collapsed folder in the upper window");
  const target = `chat-${String(Number(folder.slice(5)) + 1).padStart(3, "0")}`;
  expect(mounted, "the target must be mounted before the slide").toContain(
    target,
  );
  await watchSlide(page, target);
  const folderAt = await centreOf(row(page, folder));
  await page.mouse.move(start.x, folderAt.y, { steps: 4 });
  await expect(
    row(page, `${folder}-a`),
    "the folder must spring open",
  ).toBeVisible();
  const settledAt = await restedY(page, target);
  expect(
    await slideSeen(page),
    "the row below the folder must have slid with a transform, or the layout motion is not running",
  ).toBe(true);
  expect(
    settledAt,
    "the target must stay clear of the auto-scroll zone",
  ).toBeLessThan(box.y + box.height * 0.8);
  await page.mouse.move(start.x, settledAt, { steps: 4 });
  await expect(dropWrapper(page, target)).toHaveClass(RING);
  await expect(
    page.locator(
      '[data-slot="context-menu-trigger"][class*="ring-primary/70"]',
    ),
    "the hovered row must be the only one lit",
  ).toHaveCount(1);
  await release(page);
  await expect
    .poll(() => reparentRequests(page))
    .toEqual([{ chatId: SOURCE, newParentId: target }]);
});

function idsInViewport(page: Page): Promise<string[]> {
  return scroller(page).evaluate((list, prefix) => {
    const viewport = list.getBoundingClientRect();
    const visible: string[] = [];
    for (const row of list.querySelectorAll(
      '[data-testid^="' + prefix + '"]',
    )) {
      const { top, bottom } = row.getBoundingClientRect();
      if (top < viewport.bottom && bottom > viewport.top) {
        visible.push(
          (row.getAttribute("data-testid") ?? "").slice(prefix.length),
        );
      }
    }
    return visible;
  }, ROW_PREFIX);
}

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

test("G: a keyboard move between visible rows commits without scrolling", async ({
  page,
}) => {
  await openTree(page, 2);
  const source = "chat-000";
  const target = "chat-001";
  await expect(row(page, target)).toBeVisible();
  expect(
    await scroller(page).evaluate(
      (list) => list.scrollHeight - list.clientHeight,
    ),
    "the stationary fixture must fit without scrolling",
  ).toBe(0);
  const offset = await scrollTop(page);
  await row(page, source).focus();
  await page.keyboard.press("Space");
  await expect(overlay(page)).toHaveCount(1);
  const move = await scrollStep(
    page,
    { kind: "keyboard", y: null },
    () => page.keyboard.press("ArrowDown"),
    5_000,
  );
  expect(move.keyboardScroll).toBe("stationary");
  expect(move.scrollTop).toBe(offset);
  await expect(dropWrapper(page, target)).toHaveClass(RING);
  await page.keyboard.press("Space");
  await expect(overlay(page)).toHaveCount(0);
  await expect
    .poll(() => reparentRequests(page))
    .toEqual([{ chatId: source, newParentId: target }]);
});

test("G: a keyboard drag carried past the window mounts rows that were not there, highlights one, and drops on it", async ({
  page,
}) => {
  await openTree(page, CHAT_COUNT);
  const virtual = await isVirtualTree(page);
  const initial = virtual ? await mountedIds(page) : await idsInViewport(page);
  await row(page, SOURCE).focus();
  await page.keyboard.press("Space");
  await expect(overlay(page)).toHaveCount(1);
  let target: string | null = null;
  let sawOffset = false;
  for (let press = 0; press < 150 && target === null; press += 1) {
    const { keyboardScroll } = await scrollStep(
      page,
      { kind: "keyboard", y: null },
      () => page.keyboard.press("ArrowDown"),
      5_000,
    );
    if (keyboardScroll === "offset") sawOffset = true;
    const lit = await highlighted(page);
    if (lit !== null && !initial.includes(lit)) target = lit;
  }
  if (target === null)
    throw new Error(
      "the keyboard drag never reached a row that was not mounted at its start",
    );
  expect(sawOffset, "the keyboard drag must scroll the window").toBe(true);
  await page.keyboard.press("Space");
  await expect(overlay(page)).toHaveCount(0);
  await expect
    .poll(() => reparentRequests(page))
    .toEqual([{ chatId: SOURCE, newParentId: target }]);
});
