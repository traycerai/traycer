import { expect, test, type Locator, type Page } from "@playwright/test";

import { centreOf, fixture, nextFrames } from "./support/fixtures.ts";
import {
  finishAnimations,
  slowAnimations,
  startedAnimations,
} from "./support/section-motion.ts";

// The Activity view's collapsed rail in real Chrome: the claims only real
// layout, paint and input answer. Which tile is in which run, and what the
// cards say, is in `side-tab-strip.test.tsx`; the expanded list's own moves are
// in `side-strip-section-motion.spec.ts`.

test.use({ viewport: { width: 900, height: 900 } });

const RAIL = `${fixture("side-tab-strip")}?edge=left&scene=sections&rail=1`;
const RAIL_OF_TWENTY = `${RAIL}&tasks=20`;

async function openRail(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction("window.__sideTabStripProbe?.ready === true");
  await nextFrames(page, 4);
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`no layout box for ${locator.toString()}`);
  return box;
}

const tile = (page: Page, id: string): Locator =>
  page.getByTestId(`tab-epic-fixture-${id}`);

/** The Activity-view section a tile is drawn in. */
const laneOf = (locator: Locator): Promise<string | null> =>
  locator
    .locator("xpath=ancestor::*[@data-strip-lane]")
    .getAttribute("data-strip-lane");

const moveTask = (page: Page, id: string, section: string): Promise<void> =>
  page.evaluate(
    `window.__sideTabStripProbe.moveTask(${JSON.stringify(`fixture-${id}`)}, ${JSON.stringify(section)})`,
  );

test("opens each run of tiles with a 24px hairline in the rail's 8px rhythm, and beads Needs you's with a 4px amber dot", async ({
  page,
}) => {
  await openRail(page, RAIL);
  const first = await boxOf(tile(page, "staging"));
  const axis = first.x + first.width / 2;

  // The first run's hairline divides the tiles from New Task, 8px from each.
  const newTask = await boxOf(page.getByTestId("side-strip-new-task"));
  const hairlines = page.getByTestId("side-strip-rail-section-separator");
  await expect(hairlines).toHaveCount(4);
  const opening = await boxOf(hairlines.first());
  expect(opening.y - (newTask.y + newTask.height)).toBeCloseTo(8, 0);
  expect(first.y - (opening.y + opening.height)).toBeCloseTo(8, 0);
  await expect(page.getByTestId("side-strip-rail-divider")).toHaveCount(0);

  // The bead sits on that hairline's centre, the run's mark where every run's is.
  const dot = page.getByTestId("side-strip-rail-needs-you-dot");
  const dotBox = await boxOf(dot);
  expect(dotBox.width).toBe(4);
  expect(dotBox.height).toBe(4);
  expect(dotBox.x + 2).toBeCloseTo(axis, 0);
  expect(dotBox.y + 2).toBeCloseTo(opening.y + opening.height / 2, 0);
  // The warning token's own amber, where a missing colour would be transparent.
  const [fill, amber] = await dot.evaluate((node) => {
    const token = document.createElement("i");
    token.style.backgroundColor = "var(--color-warning)";
    document.body.append(token);
    const amber = getComputedStyle(token).backgroundColor;
    token.remove();
    return [getComputedStyle(node).backgroundColor, amber];
  });
  expect(fill).toBe(amber);
  expect(amber).not.toBe("rgba(0, 0, 0, 0)");

  // Needs you, To review, Working and Idle: the three hairlines between them,
  // the last tile of a run and the first of the next 8px from each.
  const hairlineBoxes = await hairlines.evaluateAll((nodes) =>
    nodes.slice(1).map((node) => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }),
  );
  // A grouped tile stands 4px inside its column, which is what sits 8px from
  // the hairline.
  const unitOf = (id: string): Locator =>
    tile(page, id)
      .locator(
        "xpath=ancestor::*[starts-with(@data-testid,'side-tab-group-column-')]",
      )
      .or(tile(page, id))
      .first();
  const above = await Promise.all(
    ["onboarding", "migration", "host"].map((id) => boxOf(unitOf(id))),
  );
  const below = await Promise.all(
    ["release", "gui", "layout"].map((id) => boxOf(unitOf(id))),
  );
  hairlineBoxes.forEach((hairline, index) => {
    expect([hairline.width, hairline.height]).toEqual([24, 1]);
    expect(hairline.x + 12).toBeCloseTo(axis, 0);
    expect(hairline.y - (above[index].y + above[index].height)).toBeCloseTo(
      8,
      0,
    );
    expect(below[index].y - (hairline.y + hairline.height)).toBeCloseTo(8, 0);
  });
});

test("wraps a group's run in a 48px column, its tiles 4px inside and on the rail's axis", async ({
  page,
}) => {
  await openRail(page, RAIL);
  const plain = await boxOf(tile(page, "staging"));
  // Working holds one of the group's tasks, Idle two.
  const working = page
    .getByTestId("side-tab-group-column-fixture-group")
    .first();
  const column = await boxOf(working);
  const host = await boxOf(tile(page, "host"));

  expect(column.width).toBe(48);
  expect(column.x + column.width / 2).toBeCloseTo(plain.x + plain.width / 2, 0);
  expect(host.x - column.x).toBe(4);
  expect(host.y - column.y).toBe(4);
  expect(column.y + column.height - (host.y + host.height)).toBe(4);
});

test("signed out, keeps Sign in inside the rail, a 32px nav tile on the rail's axis", async ({
  page,
}) => {
  await openRail(page, RAIL);
  const strip = await boxOf(page.getByTestId("side-tab-strip"));
  const allTasks = await boxOf(page.getByTestId("side-strip-all-tasks"));
  const signIn = await boxOf(page.getByRole("button", { name: "Sign in" }));

  expect(signIn.width).toBe(32);
  expect(signIn.height).toBe(32);
  expect(signIn.x).toBeGreaterThanOrEqual(strip.x);
  expect(signIn.x + signIn.width).toBeLessThanOrEqual(strip.x + strip.width);
  expect(signIn.x + signIn.width / 2).toBeCloseTo(
    allTasks.x + allTasks.width / 2,
    0,
  );
});

test("dims an Idle tile to half and leaves every other tile whole, the current task's filled", async ({
  page,
}) => {
  await openRail(page, RAIL);
  const opacity = (id: string): Promise<string> =>
    tile(page, id).evaluate((node) => getComputedStyle(node).opacity);

  for (const id of ["layout", "launch", "react"]) {
    expect(await opacity(id)).toBe("0.5");
  }
  for (const id of ["staging", "release", "cookie", "gui"]) {
    expect(await opacity(id)).toBe("1");
  }
  // Under the pointer, or keyboard focus, an Idle tile is whole, so its
  // hover fill and focus ring read at full strength.
  await tile(page, "layout").hover();
  await expect.poll(() => opacity("layout")).toBe("1");
  await page.mouse.move(700, 450);
  await tile(page, "launch").focus();
  await page.keyboard.press("Shift");
  await expect.poll(() => opacity("launch")).toBe("1");
  // The current task is Working here; its fill is the active one, where a
  // tile at rest has none.
  const fill = (id: string): Promise<string> =>
    tile(page, id).evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(await fill("gui")).not.toBe(await fill("cookie"));
});

test("slides a tile that changes section from where it was, by transform alone, and glows it once", async ({
  page,
}) => {
  await openRail(page, RAIL_OF_TWENTY);
  await slowAnimations(page);
  const watcher = tile(page, "watcher");
  const before = await boxOf(watcher);

  await moveTask(page, "watcher", "to-review");
  await expect.poll(() => laneOf(watcher)).toBe("to-review");

  const started = await startedAnimations(page);
  expect(started.find((entry) => entry.on === "frame")?.properties).toEqual([
    "transform",
  ]);
  const glows = started.filter((entry) => entry.on === "row");
  expect(glows).toHaveLength(1);
  expect(glows[0]?.properties).toContain("boxShadow");
  // Laid out in To review, well above, it is painted where it was.
  expect(Math.abs((await boxOf(watcher)).y - before.y)).toBeLessThan(4);

  await finishAnimations(page);
  expect((await boxOf(watcher)).y).toBeLessThan(before.y - 50);
});

test("keeps the tile under the pointer in its section until the pointer leaves", async ({
  page,
}) => {
  await openRail(page, RAIL_OF_TWENTY);
  const watcher = tile(page, "watcher");
  await watcher.hover();

  await moveTask(page, "watcher", "to-review");

  // It has not moved, and its section still counts it.
  await expect(watcher.getByTestId("side-tab-rail-badge")).toBeVisible();
  expect(await laneOf(watcher)).toBe("working");

  await page.mouse.move(700, 450);

  await expect.poll(() => laneOf(watcher)).toBe("to-review");
});

test("reorders a dragged tile among its own section's tiles and lands it at that section's end when dropped far below", async ({
  page,
}) => {
  await openRail(page, RAIL);
  const from = await centreOf(tile(page, "staging"));
  const farBelow = await centreOf(tile(page, "react"));
  const order = (): Promise<ReadonlyArray<string>> =>
    page.evaluate(
      "window.__sideTabStripProbe.items().map((item) => item.join('+'))",
    );

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Dropped over the last Idle tile, it stays in Needs you: behind the only
  // other task there, ahead of To review, and not at the end of the strip.
  await page.mouse.move(farBelow.x, farBelow.y, { steps: 16 });
  await nextFrames(page, 3);
  await page.mouse.up();

  await expect
    .poll(order)
    .toEqual([
      "epic:fixture-onboarding",
      "epic:fixture-staging",
      "epic:fixture-release",
      "epic:fixture-migration",
      "epic:fixture-gui",
      "epic:fixture-cookie",
      "epic:fixture-host",
      "epic:fixture-layout",
      "epic:fixture-launch",
      "epic:fixture-react",
    ]);
});
