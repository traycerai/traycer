import { expect, test, type Locator, type Page } from "@playwright/test";

import { centreOf, fixture, nextFrames } from "./support/fixtures.ts";
import {
  finishAnimations,
  slowAnimations,
  startedAnimations,
} from "./support/section-motion.ts";

// What the Activity view does when a task changes section, and how it scrolls
// over twenty tasks, in real Chrome: the claims only real layout, real input
// and real focus modality answer. Which task is in which section, and what is
// announced, is in `side-tab-strip.test.tsx`.

test.use({ viewport: { width: 900, height: 900 } });

const STRIP = `${fixture("side-tab-strip")}?edge=left&scene=sections&tasks=20`;
const SCROLLER = "header-tab-strip-scroll";

async function openStrip(page: Page): Promise<void> {
  await page.goto(STRIP);
  await page.waitForFunction("window.__sideTabStripProbe?.ready === true");
  await nextFrames(page, 4);
}

const row = (page: Page, id: string): Locator =>
  page.getByTestId(`tab-epic-fixture-${id}`);

/** The Activity-view section a row is drawn in. */
const laneOf = (locator: Locator): Promise<string | null> =>
  locator
    .locator("xpath=ancestor::*[@data-strip-lane]")
    .getAttribute("data-strip-lane");

const moveTask = (page: Page, id: string, section: string): Promise<void> =>
  page.evaluate(
    `window.__sideTabStripProbe.moveTask(${JSON.stringify(`fixture-${id}`)}, ${JSON.stringify(section)})`,
  );

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`no layout box for ${locator.toString()}`);
  return box;
}

const OUTSIDE_THE_STRIP = { x: 700, y: 450 };

test("slides a row that changes section from where it was, by transform alone", async ({
  page,
}) => {
  await openStrip(page);
  await slowAnimations(page);
  const watcher = row(page, "watcher");
  const before = await boxOf(watcher);

  await moveTask(page, "watcher", "to-review");
  await expect(watcher.getByTestId("side-tab-section-detail")).toBeVisible();

  const slide = (await startedAnimations(page)).find(
    (started) => started.on === "frame",
  );
  expect(slide?.properties).toEqual(["transform"]);
  // Laid out in To review, well above where it was, it is painted where it
  // was, give or take the few milliseconds the slowed animation has run.
  expect(await laneOf(watcher)).toBe("to-review");
  expect(Math.abs((await boxOf(watcher)).y - before.y)).toBeLessThan(4);

  await finishAnimations(page);
  expect((await boxOf(watcher)).y).toBeLessThan(before.y - 50);
});

test("glows a row once where it lands, in a ring that fades from its brightest", async ({
  page,
}) => {
  await openStrip(page);
  await slowAnimations(page);
  const cookie = row(page, "cookie");

  await moveTask(page, "cookie", "needs-you");
  await expect(cookie.getByTestId("side-tab-section-detail")).toBeVisible();

  const glows = (await startedAnimations(page)).filter(
    (started) => started.on === "row",
  );
  expect(glows).toHaveLength(1);
  expect(glows[0]?.properties).toContain("boxShadow");
  // The ring is whole as the row lands (a glow that faded in would still be a
  // hairline), and gone once the glow has played.
  const ring = (): Promise<string> =>
    cookie.evaluate((node) => getComputedStyle(node).boxShadow);
  const width = /([\d.]+)px inset/.exec(await ring())?.[1];
  expect(Number(width)).toBeGreaterThan(0.9);
  await finishAnimations(page);
  expect(await ring()).not.toContain("inset");
});

test("keeps the glow and drops the slide under reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openStrip(page);
  await slowAnimations(page);

  await moveTask(page, "cookie", "needs-you");
  await expect(
    row(page, "cookie").getByTestId("side-tab-section-detail"),
  ).toBeVisible();

  const started = await startedAnimations(page);
  expect(started.filter((entry) => entry.on === "frame")).toEqual([]);
  expect(started.filter((entry) => entry.on === "row")).toHaveLength(1);
});

test("keeps the row under the pointer in its section until the pointer leaves", async ({
  page,
}) => {
  await openStrip(page);
  await slowAnimations(page);
  const watcher = row(page, "watcher");
  await watcher.hover();

  await moveTask(page, "watcher", "to-review");

  // The row says what is now true of it, and has not moved; its section still
  // counts it.
  await expect(watcher.getByTestId("side-tab-section-detail")).toBeVisible();
  expect(await laneOf(watcher)).toBe("working");
  await expect(page.getByTestId("side-strip-section-working")).toHaveText(
    "Working6",
  );
  expect(await startedAnimations(page)).toEqual([]);

  await page.mouse.move(OUTSIDE_THE_STRIP.x, OUTSIDE_THE_STRIP.y);

  await expect.poll(() => laneOf(watcher)).toBe("to-review");
});

test("keeps the row holding keyboard focus in its section until focus moves on", async ({
  page,
}) => {
  await openStrip(page);
  const watcher = row(page, "watcher");
  await watcher.focus();
  expect(await watcher.evaluate((node) => node.matches(":focus-visible"))).toBe(
    true,
  );

  await moveTask(page, "watcher", "to-review");

  await expect(watcher.getByTestId("side-tab-section-detail")).toBeVisible();
  expect(await laneOf(watcher)).toBe("working");

  await watcher.evaluate((node) => {
    node.blur();
  });

  await expect.poll(() => laneOf(watcher)).toBe("to-review");
});

test("does not hold a row that was only clicked, once the pointer has left", async ({
  page,
}) => {
  await openStrip(page);
  const watcher = row(page, "watcher");
  const at = await centreOf(watcher);
  await page.mouse.click(at.x, at.y);
  await expect(watcher).toBeFocused();
  await page.mouse.move(OUTSIDE_THE_STRIP.x, OUTSIDE_THE_STRIP.y);

  await moveTask(page, "watcher", "to-review");

  // A click leaves focus on the row without the person being on it.
  await expect.poll(() => laneOf(watcher)).toBe("to-review");
});

test.describe("over a list that overflows", () => {
  test.use({ viewport: { width: 900, height: 700 } });

  const scroller = (page: Page): Locator => page.getByTestId(SCROLLER);
  const pill = (page: Page): Locator =>
    page.getByTestId("side-strip-needs-you-pill");
  const scrollTo = async (page: Page, top: number): Promise<void> => {
    await scroller(page).evaluate((node, to) => {
      node.scrollTop = to;
    }, top);
    await nextFrames(page, 3);
  };

  test("floats the pill only while the Needs you header is out of view", async ({
    page,
  }) => {
    await openStrip(page);
    await expect(pill(page)).toHaveCount(0);

    // Still inside Needs you: its header sticks and stays in view.
    await scrollTo(page, 40);
    await expect(pill(page)).toHaveCount(0);

    await scrollTo(page, 1000);
    await expect(pill(page)).toHaveText("↑ 2 need you");

    await scrollTo(page, 0);
    await expect(pill(page)).toHaveCount(0);
  });

  test("takes the pill's click back to Needs you and puts focus on its header", async ({
    page,
  }) => {
    await openStrip(page);
    await scrollTo(page, 1000);
    const at = await centreOf(pill(page));

    await page.mouse.click(at.x, at.y);

    await expect
      .poll(() => scroller(page).evaluate((node) => node.scrollTop))
      .toBe(0);
    await expect(pill(page)).toHaveCount(0);
    await expect(
      page.getByTestId("side-strip-section-needs-you"),
    ).toBeFocused();
  });

  test("shows the header of the section at the top, and only that one", async ({
    page,
  }) => {
    await openStrip(page);
    // The first To review row at the top of the list, under its header.
    await row(page, "release").evaluate((node) => {
      node.scrollIntoView({ block: "start" });
    });
    await nextFrames(page, 3);

    const top = (await boxOf(scroller(page))).y;
    const header = page.getByTestId("side-strip-section-to-review");
    const headerBox = await boxOf(header);
    expect(headerBox.y).toBeCloseTo(top, 0);
    const hit = await page.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest("[data-strip-section]")
          ?.getAttribute("data-strip-section"),
      { x: headerBox.x + 40, y: headerBox.y + 12 },
    );
    expect(hit).toBe("to-review");
  });

  test("brings an activated row clear of the sticky header and the bottom fade", async ({
    page,
  }) => {
    await openStrip(page);
    const listBox = await boxOf(scroller(page));
    await scrollTo(page, 1000);

    // The first task, well above the viewport: it lands below the stuck header.
    await page.evaluate(
      'window.__sideTabStripProbe.activate("fixture-staging")',
    );
    await nextFrames(page, 3);
    const header = await boxOf(
      page.getByTestId("side-strip-section-needs-you"),
    );
    const first = await boxOf(row(page, "staging"));
    expect(first.y).toBeGreaterThanOrEqual(header.y + header.height - 0.5);

    // A task below the viewport, with rows after it: it lands above the fade.
    await scrollTo(page, 0);
    await page.evaluate(
      'window.__sideTabStripProbe.activate("fixture-checkout")',
    );
    await nextFrames(page, 3);
    const last = await boxOf(row(page, "checkout"));
    expect(last.y + last.height).toBeLessThanOrEqual(
      listBox.y + listBox.height - 20 + 0.5,
    );
  });

  test("fades the bottom edge while more rows lie below, and not at the end", async ({
    page,
  }) => {
    await openStrip(page);
    const fade = (): Promise<string> =>
      scroller(page).evaluate((node) => getComputedStyle(node).maskImage);
    await expect.poll(fade).not.toBe("none");

    await scrollTo(page, 1000);

    await expect.poll(fade).toBe("none");
  });
});
