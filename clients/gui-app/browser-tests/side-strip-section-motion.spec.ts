import { expect, test, type Locator, type Page } from "@playwright/test";

import { centreOf, fixture, nextFrames } from "./support/fixtures.ts";
import {
  finishAnimations,
  freezeAnimations,
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
  await freezeAnimations(page);
  const watcher = row(page, "watcher");
  const before = await boxOf(watcher);

  await moveTask(page, "watcher", "to-review");
  await expect(watcher.getByTestId("side-tab-section-detail")).toBeVisible();

  const slide = (await startedAnimations(page)).find(
    (started) => started.on === "frame",
  );
  expect(slide?.properties).toEqual(["transform"]);
  // Laid out in To review, well above where it was, it is painted where it
  // was: the frozen slide is still on its first frame.
  expect(await laneOf(watcher)).toBe("to-review");
  expect(Math.abs((await boxOf(watcher)).y - before.y)).toBeLessThan(4);

  await finishAnimations(page);
  expect((await boxOf(watcher)).y).toBeLessThan(before.y - 50);
});

test("glows a row once where it lands, in a ring that fades from its brightest", async ({
  page,
}) => {
  await openStrip(page);
  await freezeAnimations(page);
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
  await freezeAnimations(page);

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
  await freezeAnimations(page);
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

test("keeps a task opened from To review there once it is read, until another task is opened", async ({
  page,
}) => {
  await openStrip(page);
  const release = row(page, "release");
  const at = await centreOf(release);
  await page.mouse.click(at.x, at.y);
  await page.mouse.move(OUTSIDE_THE_STRIP.x, OUTSIDE_THE_STRIP.y);

  await moveTask(page, "release", "idle");

  // Read, so its row no longer says "Done", and still where it was clicked.
  await expect(release.getByTestId("side-tab-section-detail")).toHaveCount(0);
  expect(await laneOf(release)).toBe("to-review");

  await page.evaluate('window.__sideTabStripProbe.activate("fixture-watcher")');

  await expect.poll(() => laneOf(release)).toBe("idle");
});

test("keeps an answered task in Needs you while it is the current one, out of that section's count", async ({
  page,
}) => {
  await openStrip(page);
  const onboarding = row(page, "onboarding");
  const needsYou = page.getByTestId("side-strip-section-needs-you");
  await expect(needsYou).toHaveText("Needs you2");
  const at = await centreOf(onboarding);
  await page.mouse.click(at.x, at.y);
  await page.mouse.move(OUTSIDE_THE_STRIP.x, OUTSIDE_THE_STRIP.y);

  await moveTask(page, "onboarding", "working");

  // Answered, so one task fewer waits on the person, and its row has not moved.
  await expect(needsYou).toHaveText("Needs you1");
  expect(await laneOf(onboarding)).toBe("needs-you");

  await page.evaluate('window.__sideTabStripProbe.activate("fixture-watcher")');

  await expect.poll(() => laneOf(onboarding)).toBe("working");
});

test("keeps a task opened from To review there while it starts working, until another task is opened", async ({
  page,
}) => {
  await openStrip(page);
  const release = row(page, "release");
  const at = await centreOf(release);
  await page.mouse.click(at.x, at.y);
  await page.mouse.move(OUTSIDE_THE_STRIP.x, OUTSIDE_THE_STRIP.y);

  await moveTask(page, "release", "working");

  await expect(release.getByTestId("side-tab-section-detail")).toHaveCount(0);
  expect(await laneOf(release)).toBe("to-review");

  await page.evaluate('window.__sideTabStripProbe.activate("fixture-watcher")');

  await expect.poll(() => laneOf(release)).toBe("working");
});

/**
 * Opens Release checklist from To review, then reads it into Idle: its row is
 * held in To review, above Watcher fix, with the pointer outside the list.
 */
async function holdReleaseAboveWatcher(page: Page): Promise<void> {
  await openStrip(page);
  const at = await centreOf(row(page, "release"));
  await page.mouse.click(at.x, at.y);
  await page.mouse.move(OUTSIDE_THE_STRIP.x, OUTSIDE_THE_STRIP.y);
  await moveTask(page, "release", "idle");
  expect(await laneOf(row(page, "release"))).toBe("to-review");
}

/** Clicks Watcher fix with the pointer inside the list, and waits for it to be the current row. */
async function openWatcherWithPointerInList(page: Page): Promise<void> {
  const watcher = row(page, "watcher");
  const at = await centreOf(watcher);
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);
  await expect(watcher).toHaveAttribute("data-active", "true");
  await expect(row(page, "release")).toHaveAttribute("data-active", "false");
}

test.describe("when another task is opened with the pointer in the list", () => {
  test("keeps the previous row in its section and the clicked row where it was", async ({
    page,
  }) => {
    await holdReleaseAboveWatcher(page);
    const before = await boxOf(row(page, "watcher"));

    await openWatcherWithPointerInList(page);
    await nextFrames(page, 3);

    expect(await laneOf(row(page, "release"))).toBe("to-review");
    expect((await boxOf(row(page, "watcher"))).y).toBe(before.y);
  });

  test("moves the previous row to its section once the pointer leaves the list", async ({
    page,
  }) => {
    await holdReleaseAboveWatcher(page);
    await openWatcherWithPointerInList(page);
    await nextFrames(page, 3);
    expect(await laneOf(row(page, "release"))).toBe("to-review");

    await page.mouse.move(OUTSIDE_THE_STRIP.x, OUTSIDE_THE_STRIP.y);

    await expect.poll(() => laneOf(row(page, "release"))).toBe("idle");
  });

  test("moves the previous row to its section when the window loses focus, the pointer still in the list", async ({
    page,
  }) => {
    await holdReleaseAboveWatcher(page);
    await openWatcherWithPointerInList(page);
    await nextFrames(page, 3);
    expect(await laneOf(row(page, "release"))).toBe("to-review");

    await page.evaluate(() => window.dispatchEvent(new Event("blur")));

    await expect.poll(() => laneOf(row(page, "release"))).toBe("idle");
  });

  test("moves the previous row to its section when the page becomes hidden, the pointer still in the list", async ({
    page,
  }) => {
    await holdReleaseAboveWatcher(page);
    await openWatcherWithPointerInList(page);
    await nextFrames(page, 3);
    expect(await laneOf(row(page, "release"))).toBe("to-review");

    await page.evaluate(() => {
      // A headless page is never hidden: report it hidden, as a browser does.
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await expect.poll(() => laneOf(row(page, "release"))).toBe("idle");
  });

  test("keeps the previous row in its section when focus leaves the list and the pointer does not", async ({
    page,
  }) => {
    await holdReleaseAboveWatcher(page);
    await openWatcherWithPointerInList(page);
    await nextFrames(page, 3);
    expect(await laneOf(row(page, "release"))).toBe("to-review");

    await row(page, "watcher").evaluate((node) => {
      node.blur();
    });
    await expect(row(page, "watcher")).not.toBeFocused();
    await nextFrames(page, 3);

    expect(await laneOf(row(page, "release"))).toBe("to-review");
  });

  test("keeps the previous row's section when its task is opened again while it waits", async ({
    page,
  }) => {
    await holdReleaseAboveWatcher(page);
    await openWatcherWithPointerInList(page);
    await nextFrames(page, 3);
    expect(await laneOf(row(page, "release"))).toBe("to-review");

    await page.evaluate(
      'window.__sideTabStripProbe.activate("fixture-release")',
    );
    await expect(row(page, "release")).toHaveAttribute("data-active", "true");
    await page.mouse.move(OUTSIDE_THE_STRIP.x, OUTSIDE_THE_STRIP.y);
    await nextFrames(page, 3);

    expect(await laneOf(row(page, "release"))).toBe("to-review");
  });
});

test("moves the previous row to its section at once when another task is opened with the pointer outside the list", async ({
  page,
}) => {
  await holdReleaseAboveWatcher(page);

  await page.evaluate('window.__sideTabStripProbe.activate("fixture-watcher")');

  await expect.poll(() => laneOf(row(page, "release"))).toBe("idle");
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("moves the previous row to its section right after a tap on another row", async ({
    page,
  }) => {
    await holdReleaseAboveWatcher(page);
    const at = await centreOf(row(page, "watcher"));

    await page.touchscreen.tap(at.x, at.y);

    await expect(row(page, "watcher")).toHaveAttribute("data-active", "true");
    await expect.poll(() => laneOf(row(page, "release"))).toBe("idle");
  });
});

test.describe("over a list that overflows", () => {
  test.use({ viewport: { width: 900, height: 700 } });

  const scroller = (page: Page): Locator => page.getByTestId(SCROLLER);
  const chip = (page: Page): Locator =>
    page.getByTestId("side-strip-needs-you-chip");
  const scrollTo = async (page: Page, top: number): Promise<void> => {
    await scroller(page).evaluate((node, to) => {
      node.scrollTop = to;
    }, top);
    await nextFrames(page, 3);
  };

  test("counts a held, answered current row out of Needs you, so the chip is gone once its header scrolls away", async ({
    page,
  }) => {
    await openStrip(page);
    await moveTask(page, "staging", "idle");
    const onboarding = row(page, "onboarding");
    const at = await centreOf(onboarding);
    await page.mouse.click(at.x, at.y);
    await page.mouse.move(OUTSIDE_THE_STRIP.x, OUTSIDE_THE_STRIP.y);
    // Onboarding is still waiting, so the chip is drawn once the header is
    // out of view: the absence below is not vacuous.
    await scrollTo(page, 1000);
    await expect(chip(page)).toBeVisible();
    await scrollTo(page, 0);

    await moveTask(page, "onboarding", "working");

    await expect(page.getByTestId("side-strip-section-needs-you")).toHaveText(
      "Needs you0",
    );
    expect(await laneOf(onboarding)).toBe("needs-you");
    await scrollTo(page, 1000);
    await expect(chip(page)).toHaveCount(0);
  });

  test("shows the chip only while the Needs you header is out of view", async ({
    page,
  }) => {
    await openStrip(page);
    await expect(chip(page)).toHaveCount(0);

    // Still inside Needs you: its header sticks and stays in view.
    await scrollTo(page, 40);
    await expect(chip(page)).toHaveCount(0);

    await scrollTo(page, 1000);
    await expect(chip(page)).toHaveAccessibleName("2 need you");
    await expect(chip(page).getByText("need you")).toBeVisible();

    await scrollTo(page, 0);
    await expect(chip(page)).toHaveCount(0);
  });

  for (const width of [240, 192]) {
    test(`at ${String(width)}px, holds the chip in the stuck header's own row, before its count and clear of its name, moving nothing`, async ({
      page,
    }) => {
      await openStrip(page);
      await page.evaluate(
        `window.__sideTabStripProbe.setWidth(${String(width)})`,
      );
      await nextFrames(page, 3);
      const top = (await boxOf(scroller(page))).y;
      // As Working's header reaches the top, partway through Working, and at
      // the end with Idle's header stuck.
      for (const at of [480, 560, 1000]) {
        await scrollTo(page, at);
        const row = chip(page).locator(
          "xpath=ancestor::*[@data-strip-section-row]",
        );
        const header = row.locator("[data-strip-section]");
        const [rowBox, chipBox, name, count] = await Promise.all([
          boxOf(row),
          boxOf(chip(page)),
          boxOf(header.locator(".truncate")),
          boxOf(header.locator("span").last()),
        ]);
        // The row is stuck where every header sticks: nothing made room.
        expect(rowBox.y).toBeCloseTo(top, 0);
        expect(chipBox.y).toBeGreaterThanOrEqual(rowBox.y);
        expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(
          rowBox.y + rowBox.height + 0.5,
        );
        expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(count.x);
        // Where the name's own letters end, not its box, which fills the row.
        const nameEnd = await header.locator(".truncate").evaluate((node) => {
          const letters = document.createRange();
          letters.selectNodeContents(node);
          return letters.getBoundingClientRect().right;
        });
        expect(nameEnd).toBeLessThanOrEqual(name.x + name.width);
        expect(chipBox.x).toBeGreaterThanOrEqual(nameEnd);
      }
      // At 192px only "↑ N" fits beside the name.
      await expect(chip(page).getByText("need you")).toBeVisible({
        visible: width === 240,
      });
    });
  }

  for (const width of [240, 192]) {
    test(`at ${String(width)}px, never draws the chip partly covered while the next header pushes its row out`, async ({
      page,
    }) => {
      await openStrip(page);
      await page.evaluate(
        `window.__sideTabStripProbe.setWidth(${String(width)})`,
      );
      await nextFrames(page, 3);
      // To review stuck, Working sliding up over it, then Working stuck.
      let seen = 0;
      for (let at = 200; at <= 340; at += 4) {
        await scrollTo(page, at);
        const chipBox = await chip(page).boundingBox();
        if (chipBox === null) continue;
        seen += 1;
        // Each edge of the chip, inside its rounded corners, hits the chip
        // itself: no row is over any part of it.
        const middleX = chipBox.x + chipBox.width / 2;
        const middleY = chipBox.y + chipBox.height / 2;
        const corners = [
          [middleX, chipBox.y + 1],
          [middleX, chipBox.y + chipBox.height - 1],
          [chipBox.x + 1, middleY],
          [chipBox.x + chipBox.width - 1, middleY],
        ];
        const whole = await chip(page).evaluate(
          (node, points) =>
            points.every(([x, y]) => {
              const hit = document.elementFromPoint(x, y);
              return hit !== null && node.contains(hit);
            }),
          corners,
        );
        expect(whole, `chip covered at scrollTop ${String(at)}`).toBe(true);
      }
      expect(seen).toBeGreaterThan(0);
    });
  }

  test("takes the chip's click back to Needs you and puts focus on its header", async ({
    page,
  }) => {
    await openStrip(page);
    await scrollTo(page, 1000);
    const at = await centreOf(chip(page));

    await page.mouse.click(at.x, at.y);

    await expect
      .poll(() => scroller(page).evaluate((node) => node.scrollTop))
      .toBe(0);
    await expect(chip(page)).toHaveCount(0);
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
