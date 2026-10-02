import { expect, test, type Locator, type Page } from "@playwright/test";
import { z } from "zod";

import { centreOf, fixture, nextFrames } from "./support/fixtures.ts";

// A split pair in the vertical strip, in real Chrome: one row of the split icon
// and two halves, the current pair's row joined to the sheet, the drop preview
// that turns a row into the pair it will become, forming and separating a pair
// with nothing left overlapped, and the arrow keys through a pair and across a
// section. The halves' states and statuses are in `side-tab-strip.test.tsx`.

test.use({ viewport: { width: 1300, height: 900 } });

const PAIRS = `${fixture("side-tab-strip")}?edge=left&tasks=pairs`;

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`${PAIRS}${query}`);
  await page.waitForFunction("window.__sideTabStripProbe?.ready === true");
  await nextFrames(page, 4);
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`no layout box for ${locator.toString()}`);
  return box;
}

const frameSchema = z.array(
  z.object({
    id: z.string(),
    top: z.number(),
    bottom: z.number(),
    transform: z.string(),
  }),
);

/** Every strip item's frame as drawn, top to bottom, and its transform. */
async function readFrames(page: Page): Promise<z.infer<typeof frameSchema>> {
  return frameSchema.parse(
    await page.evaluate(`(() =>
      [...document.querySelectorAll('[data-testid="header-tab-strip-scroll"] [data-strip-item-id]')]
        .map((node) => {
          const box = node.getBoundingClientRect();
          return {
            id: node.getAttribute("data-strip-item-id"),
            top: box.top,
            bottom: box.bottom,
            transform: getComputedStyle(node).transform,
          };
        })
        .sort((a, b) => a.top - b.top)
    )()`),
  );
}

/** Whether any frame is drawn over the one after it. */
function overlaps(frames: z.infer<typeof frameSchema>): boolean {
  return frames.some(
    (frame, index) =>
      index > 0 && frame.top < (frames[index - 1]?.bottom ?? 0) - 0.5,
  );
}

/** The frames on each of the next `count` painted frames. */
async function framesOver(
  page: Page,
  count: number,
): Promise<ReadonlyArray<z.infer<typeof frameSchema>>> {
  const samples: Array<z.infer<typeof frameSchema>> = [];
  for (let frame = 0; frame < count; frame += 1) {
    await nextFrames(page, 1);
    samples.push(await readFrames(page));
  }
  return samples;
}

/** The strip at rest: no frame displaced, and none drawn over the next. */
async function expectSettled(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const frames = await readFrames(page);
      return frames.every(
        (frame, index) =>
          (frame.transform === "none" ||
            frame.transform === "matrix(1, 0, 0, 1, 0, 0)") &&
          (index === 0 || frame.top >= (frames[index - 1]?.bottom ?? 0) - 0.5),
      );
    })
    .toBe(true);
}

test("draws a pair as one 32px row of the split icon and two equal halves", async ({
  page,
}) => {
  await open(page, "");
  const pair = page.getByTestId("split-tab-group-split-other");
  await expect(pair).toHaveAttribute(
    "aria-label",
    "Split view: Release checklist and Host watcher fix",
  );
  const row = await pair.boundingBox();
  const left = await page.getByTestId("tab-epic-fixture-release").boundingBox();
  const right = await page.getByTestId("tab-epic-fixture-host").boundingBox();
  const icon = await page
    .getByTestId("split-quick-actions-split-other")
    .boundingBox();
  if (row === null || left === null || right === null || icon === null) {
    throw new Error("no layout");
  }
  expect(row.height).toBeCloseTo(32, 0);
  // Side by side on one line, the icon first, the halves equal and 4px apart.
  expect(icon.x + icon.width).toBeLessThanOrEqual(left.x);
  expect(left.y).toBeCloseTo(right.y, 0);
  expect(left.width).toBeCloseTo(right.width, 0);
  expect(right.x - (left.x + left.width)).toBeCloseTo(4, 0);
});

test("lines a half's caption up with the agents under it: its icon on their glyphs, its title on their names", async ({
  page,
}) => {
  await open(page, "&scene=sections");
  await page.evaluate(
    'import("/src/__tests__/browser/side-tab-strip-seed.ts").then((seed) => seed.seedSideStripPairAgents())',
  );
  // Both halves list agents, so both are captioned.
  const react = page.getByTestId("tab-epic-fixture-react");
  await react.hover();
  await react.getByTestId("side-tab-disclosure").click();
  const caption = page.getByTestId("split-half-caption-left");
  await expect(caption).toBeVisible();
  const agent = page.getByTestId("strip-agent-c-sync");

  const icon = await boxOf(caption.locator("svg"));
  const glyph = await boxOf(agent.locator("> *").first());
  const title = await boxOf(caption.locator(".truncate"));
  const name = await boxOf(agent.locator(".truncate"));
  expect(icon.x + icon.width / 2).toBeCloseTo(glyph.x + glyph.width / 2, 0);
  expect(title.x).toBeCloseTo(name.x, 0);
});

test("joins the current pair's whole row to the sheet, its focused half selected", async ({
  page,
}) => {
  await open(page, "");
  const pair = page.getByTestId("split-tab-group-split-current");
  await expect(pair).toHaveAttribute("data-sheet-joined", "left");
  await expect(page.getByTestId("tab-epic-fixture-cookie")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("tab-epic-fixture-react")).toHaveAttribute(
    "aria-selected",
    "false",
  );
});

test("previews a split as the pair the row will become, the dragged task's half titled", async ({
  page,
}) => {
  await open(page, "");
  const gui = await centreOf(page.getByTestId("tab-epic-fixture-gui"));
  const start = await centreOf(page.getByTestId("tab-epic-fixture-start"));
  await page.mouse.move(gui.x, gui.y);
  await page.mouse.down();
  await page.mouse.move(gui.x, start.y, { steps: 16 });

  // GUI comes from above, so it takes the pair's left half.
  const preview = page.getByTestId("side-tab-pair-preview");
  await expect(preview).toHaveAttribute("data-side", "left");
  await expect(preview).toHaveText("GUI Sidebar Redesign");
  // The row keeps its own task in the other half, and its height.
  const row = await page.getByTestId("tab-epic-fixture-start").boundingBox();
  if (row === null) throw new Error("no layout");
  expect(row.height).toBeCloseTo(32, 0);
  await expect(page.getByTestId("tab-epic-fixture-start")).toContainText(
    "Start Page",
  );
  await page.mouse.up();
});

test("forms a pair in its target's place and separates it, with no row overlapped on any frame", async ({
  page,
}) => {
  await open(page, "");
  const gui = await centreOf(page.getByTestId("tab-epic-fixture-gui"));
  const start = await centreOf(page.getByTestId("tab-epic-fixture-start"));
  await page.mouse.move(gui.x, gui.y);
  await page.mouse.down();
  await page.mouse.move(gui.x, start.y, { steps: 16 });
  await expect(page.getByTestId("side-tab-pair-preview")).toBeVisible();
  await page.mouse.up();

  // The two rows close into one pair row where Start Page, the row dropped
  // on, was: last, after the two pairs that were there.
  const forming = await framesOver(page, 20);
  expect(forming.map(overlaps)).not.toContain(true);
  // The rows it did not touch hold still, to within a sub-pixel settle: the
  // list does not scroll after it.
  const firstTops = forming.map((frames) => frames[0]?.top ?? 0);
  expect(Math.max(...firstTops) - Math.min(...firstTops)).toBeLessThan(1);
  expect(forming.at(-1)?.map((frame) => frame.id)).toEqual([
    "split-current",
    "split-other",
    expect.stringMatching(/^split:/),
  ]);
  await expectSettled(page);

  // Separate views, from the new pair's icon: it opens into its two rows, the
  // right one out from under the left, and nothing is left over another.
  const formed = page
    .locator('[data-side-split-pair="expanded"]')
    .filter({ has: page.getByTestId("tab-epic-fixture-gui") });
  await formed.getByRole("button", { name: /^Split view actions/ }).click();
  await page.getByRole("menuitem", { name: "Separate views" }).click();
  await expect(page.locator('[data-side-split-pair="expanded"]')).toHaveCount(
    2,
  );
  await expectSettled(page);
  expect((await readFrames(page)).map((frame) => frame.id)).toEqual([
    "split-current",
    "split-other",
    "tab:epic:fixture-gui",
    "tab:epic:fixture-start",
  ]);
});

test("drops a pair's Needs you line once its waiting agent is drawn below, with no row overlapped on any frame", async ({
  page,
}) => {
  await open(page, "&scene=sections&agents=waiting");
  const pair = page.getByTestId("split-tab-group-split-current");
  await expect(pair.getByTestId("side-tab-section-detail")).toBeVisible();
  expect((await pair.boundingBox())?.height).toBeCloseTo(52, 0);

  // React UI Performance Audit's Perf agent waits on an approval. The chevron
  // takes its room on hover.
  const react = page.getByTestId("tab-epic-fixture-react");
  await react.hover();
  await react.getByTestId("side-tab-disclosure").click();

  const opening = await framesOver(page, 12);
  expect(opening.map(overlaps)).not.toContain(true);
  await expectSettled(page);
  await expect(pair.getByTestId("side-tab-section-detail")).toHaveCount(0);
  const row = await pair.boundingBox();
  const agent = await page
    .getByTestId("strip-agent-fixture-react-chat")
    .boundingBox();
  if (row === null || agent === null) throw new Error("no layout");
  expect(row.height).toBeCloseTo(32, 0);
  expect(agent.y).toBeGreaterThanOrEqual(row.y + row.height);
});

test.describe("the arrow keys", () => {
  const focusedTestId = (page: Page): Promise<string | null> =>
    page.evaluate(
      () => document.activeElement?.getAttribute("data-testid") ?? null,
    );

  test("move through a pair's halves and across a section boundary, and stop at the ends", async ({
    page,
  }) => {
    await open(page, "&scene=sections");
    // Cookie Sync working puts the current pair in Working, above Idle.
    await page.evaluate(`(async () => {
      const { __setAgentActivityStateForTests } = await import("/src/stores/agent-activity-store.ts");
      __setAgentActivityStateForTests({ "fixture-cookie": { working: ["a"], turn: ["a"] } }, "local", "connected");
    })()`);
    await expect(page.getByTestId("side-strip-section-working")).toBeVisible();
    await page.getByTestId("tab-epic-fixture-cookie").focus();

    await page.keyboard.press("ArrowUp");
    expect(await focusedTestId(page)).toBe("tab-epic-fixture-cookie");
    await page.keyboard.press("ArrowRight");
    expect(await focusedTestId(page)).toBe("tab-epic-fixture-react");
    await page.keyboard.press("ArrowRight");
    expect(await focusedTestId(page)).toBe("tab-epic-fixture-react");
    await page.keyboard.press("ArrowLeft");
    expect(await focusedTestId(page)).toBe("tab-epic-fixture-cookie");
    // Down from the pair's left half is its right half, then the next
    // section's first task.
    await page.keyboard.press("ArrowDown");
    expect(await focusedTestId(page)).toBe("tab-epic-fixture-react");
    await page.keyboard.press("ArrowDown");
    expect(await focusedTestId(page)).toBe("tab-epic-fixture-gui");
    await page.keyboard.press("ArrowUp");
    expect(await focusedTestId(page)).toBe("tab-epic-fixture-react");
  });
});
