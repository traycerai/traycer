import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// What a choice in the compact header's Channel actions menu hands focus to once
// the menu has closed. Radix returns focus to the menu's trigger from a
// zero-delay timer at close, and the panel the choice opens must end up
// holding it instead; real focus and real pointer and key dispatch decide that,
// which jsdom does not. The page is the production surface, header, menu,
// search panel and settings panel over a fake host.

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

const SETTINGS = '[data-testid="bot-channel-settings"]';
const SEARCH_INPUT = '[data-testid="bot-search-input"]';

/** The second bot the fixture lists under `?bots=2`. */
const SECOND_BOT_ID = "bot_01JD5X8Q2M4N6P8R0S2T4V6W9Z";

declare global {
  interface Window {
    __botChannelProbe?: {
      readonly setControls: (on: boolean) => void;
      readonly setPaneWidth: (px: number) => void;
      readonly holdSnapshots: (botId: string | null) => void;
      readonly selectBot: (botId: string) => void;
    };
  }
}

async function openMenu(page: Page): Promise<Locator> {
  await page.goto(fixture("bot-compact-actions-menu"));
  await page.getByRole("button", { name: /^Channel actions/ }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

type Choice = "pointer" | "keyboard";

async function choose(page: Page, item: Locator, how: Choice): Promise<void> {
  await expect(item).toBeVisible();
  if (how === "pointer") {
    await item.click();
    return;
  }
  await item.focus();
  await page.keyboard.press("Enter");
}

for (const how of ["pointer", "keyboard"] as const) {
  test.describe(`a ${how} choice`, () => {
    test("opens the channel settings holding the focus, and Escape closes them", async ({
      page,
    }) => {
      const menu = await openMenu(page);

      await choose(page, menu.getByText(/settings/i), how);

      await expect(page.getByRole("menu")).toHaveCount(0);
      const settings = page.locator(SETTINGS);
      await expect(settings).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(settings).toHaveCount(0);
    });

    test("opens Search with its field holding the focus", async ({ page }) => {
      const menu = await openMenu(page);

      await choose(page, menu.getByText(/^Search/), how);

      await expect(page.getByRole("menu")).toHaveCount(0);
      const input = page.locator(SEARCH_INPUT);
      await expect(input).toBeFocused();
      await page.keyboard.type("release");
      await expect(input).toHaveValue("release");
    });
  });
}

test("keeps the active-task badge inside the header with zero top inset", async ({
  page,
}) => {
  await page.goto(fixture("bot-compact-actions-menu"));
  const header = page.getByTestId("app-header");
  const badge = page.getByTestId("bot-channel-actions-activity-count");
  await expect(badge).toHaveText("1");
  expect(
    await page
      .locator("#root")
      .evaluate((root) => getComputedStyle(root).paddingTop),
  ).toBe("0px");
  const headerBox = await header.boundingBox();
  const badgeBox = await badge.boundingBox();
  expect(headerBox).not.toBeNull();
  expect(badgeBox).not.toBeNull();
  if (headerBox === null || badgeBox === null)
    throw new Error("header and badge must have geometry");
  expect(headerBox.height).toBe(40);
  expect(badgeBox.x).toBeGreaterThanOrEqual(headerBox.x);
  expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(
    headerBox.x + headerBox.width,
  );
  expect(badgeBox.y).toBeGreaterThanOrEqual(headerBox.y);
  expect(badgeBox.y + badgeBox.height).toBeLessThanOrEqual(
    headerBox.y + headerBox.height,
  );
});

interface PaneFit {
  /** The pane's height less the tab's: what sits above the tab. */
  readonly above: number;
  readonly tabBottom: number;
  readonly paneBottom: number;
  readonly paneOverflow: number;
}

/** `bot-tab` against the pane it is drawn in, three levels up through the playback scope. */
async function paneFit(page: Page): Promise<PaneFit> {
  return page.getByTestId("bot-tab").evaluate((tab) => {
    const pane = tab.parentElement?.parentElement?.parentElement;
    if (pane === null || pane === undefined) throw new Error("no pane");
    return {
      above:
        pane.getBoundingClientRect().height -
        tab.getBoundingClientRect().height,
      tabBottom: tab.getBoundingClientRect().bottom,
      paneBottom: pane.getBoundingClientRect().bottom,
      paneOverflow: pane.scrollHeight - pane.clientHeight,
    };
  });
}

type GroupPlacement = "none" | "row" | "reserved" | "header" | "other";

interface GroupFrame {
  readonly placement: GroupPlacement;
  /** How many Music playback groups the tab holds. */
  readonly groups: number;
  readonly groupTop: number;
  /** Where what sits below the title row starts. */
  readonly belowTop: number;
}

declare global {
  interface Window {
    __groupFrames?: GroupFrame[];
  }
}

/** Records the group's place and the content's top on every frame from the first. */
async function sampleFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const GROUP = '[role="group"][aria-label="Music playback"]';
    const frames: GroupFrame[] = [];
    window.__groupFrames = frames;
    const placementIn = (header: Element | null): GroupPlacement => {
      if (header === null) return "row";
      const id = header.getAttribute("data-testid");
      if (id === "bot-channel-opening-header") return "reserved";
      return id === "bot-channel-header" ? "header" : "other";
    };
    const sample = (): void => {
      const group = document.querySelector(GROUP);
      const groups = document.querySelectorAll(GROUP).length;
      if (group === null) {
        frames.push({ placement: "none", groups, groupTop: 0, belowTop: 0 });
      } else {
        const header = group.closest("header");
        const below =
          header === null ? group : (header.nextElementSibling ?? group);
        frames.push({
          placement: placementIn(header),
          groups,
          groupTop: group.getBoundingClientRect().top,
          belowTop:
            header === null
              ? below.getBoundingClientRect().bottom
              : below.getBoundingClientRect().top,
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function framesSince(page: Page, from: number): Promise<GroupFrame[]> {
  return page.evaluate(
    (start) => (window.__groupFrames ?? []).slice(start),
    from,
  );
}

/**
 * From the first frame with a group: exactly one group on every frame, never
 * in a row of its own, and the group's top and the top of what sits below the
 * title row are the same on every frame.
 */
function expectSteady(frames: readonly GroupFrame[]): void {
  const present = frames.slice(frames.findIndex((f) => f.groups > 0));
  expect(present.length).toBeGreaterThan(0);
  expect(present.filter((f) => f.groups !== 1)).toEqual([]);
  expect(present.filter((f) => f.placement === "row")).toEqual([]);
  expect([...new Set(present.map((f) => f.groupTop))]).toHaveLength(1);
  expect([...new Set(present.map((f) => f.belowTop))]).toHaveLength(1);
}

test.describe("the music controls in the desktop channel header", () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    hasTouch: false,
    isMobile: false,
  });

  test("sit in the title row left of Search without growing the header, and give way as the pane narrows", async ({
    page,
  }) => {
    await page.goto(
      `${fixture("bot-compact-actions-menu")}?form=desktop&music=1`,
    );
    await page.waitForFunction(() => window.__botChannelProbe !== undefined);
    const header = page.getByTestId("bot-channel-header");
    const group = header.getByRole("group", { name: "Music playback" });
    const search = page.getByTestId("bot-channel-search-open");
    const track = header.getByTestId("epic-playback-track");
    const previous = header.getByTestId("epic-playback-previous");
    const next = header.getByTestId("epic-playback-next");
    const setPaneWidth = async (px: number): Promise<void> => {
      await page.evaluate((w) => window.__botChannelProbe?.setPaneWidth(w), px);
      await nextFrames(page, 2);
    };
    const boxOf = async (locator: Locator) => {
      const box = await locator.boundingBox();
      if (box === null) throw new Error(`no box for ${locator.toString()}`);
      return box;
    };

    await expect(group).toBeVisible();
    const withControls = await boxOf(header);
    const row = await boxOf(header.locator(":scope > div").first());
    const box = await boxOf(group);
    const searchBox = await boxOf(search);
    expect(box.y).toBeGreaterThanOrEqual(row.y);
    expect(box.y + box.height).toBeLessThanOrEqual(row.y + row.height);
    expect(box.x + box.width).toBeLessThanOrEqual(searchBox.x);
    expect((await boxOf(track)).width).toBeGreaterThan(100);

    // The scope wraps the tab in a column: the tab still fills its pane.
    const fit = await paneFit(page);
    expect(fit.above).toBe(0);
    expect(fit.tabBottom).toBe(fit.paneBottom);
    expect(fit.paneOverflow).toBe(0);

    // DOM order is visual order: Tab from the avatar crosses the controls,
    // then reaches Search.
    await page.getByTestId("bot-tab-avatar").focus();
    const order: string[] = [];
    for (let step = 0; step < 6 && order.at(-1) !== "Search in Tracy"; step++) {
      await page.keyboard.press("Tab");
      order.push(
        await page.evaluate(
          () => document.activeElement?.getAttribute("aria-label") ?? "",
        ),
      );
    }
    expect(order.slice(-4)).toEqual([
      "Previous track",
      "Pause",
      "Next track",
      "Search in Tracy",
    ]);

    await page.evaluate(() => window.__botChannelProbe?.setControls(false));
    await expect(group).toHaveCount(0);
    expect((await boxOf(header)).height).toBe(withControls.height);
    await page.evaluate(() => window.__botChannelProbe?.setControls(true));
    await expect(group).toBeVisible();

    // Under 40rem of title row the track is read by screen readers only.
    await setPaneWidth(560);
    await expect.poll(async () => (await boxOf(track)).width).toBeLessThan(2);
    await expect(previous).toBeVisible();
    await expect(next).toBeVisible();

    // Under 24rem previous and next go; Pause stays and works.
    await setPaneWidth(340);
    await expect(previous).toBeHidden();
    await expect(next).toBeHidden();
    await header.getByRole("button", { name: "Pause" }).click();
    await expect(header.getByRole("button", { name: "Play" })).toBeVisible();
    expect((await boxOf(header)).height).toBe(withControls.height);

    await search.click();
    await expect(page.locator(SEARCH_INPUT)).toBeFocused();
  });
  test("a cold open never draws the row, and nothing under the group moves", async ({
    page,
  }) => {
    await sampleFrames(page);
    await page.goto(
      `${fixture("bot-compact-actions-menu")}?form=desktop&music=1`,
    );
    await expect(page.getByTestId("bot-channel-header")).toBeVisible();
    await nextFrames(page, 3);

    expectSteady(await framesSince(page, 0));
  });

  test("a cold open held at the connecting channel never draws the row, and nothing under the group moves", async ({
    page,
  }) => {
    await sampleFrames(page);
    await page.goto(
      `${fixture("bot-compact-actions-menu")}?form=desktop&music=1&snapshot=held`,
    );
    await expect(page.getByTestId("bot-channel-opening-header")).toBeVisible();
    await nextFrames(page, 3);
    await page.evaluate(() => window.__botChannelProbe?.holdSnapshots(null));
    await expect(page.getByTestId("bot-channel-header")).toBeVisible();
    await nextFrames(page, 3);

    const frames = await framesSince(page, 0);
    expect(frames.some((f) => f.placement === "reserved")).toBe(true);
    expectSteady(frames);
  });

  test("a switch to another channel never draws the row, and nothing under the group moves", async ({
    page,
  }) => {
    await sampleFrames(page);
    await page.goto(
      `${fixture("bot-compact-actions-menu")}?form=desktop&music=1&bots=2&snapshot=held`,
    );
    await expect(page.getByTestId("bot-channel-opening-header")).toBeVisible();
    await page.evaluate(
      (botId) => window.__botChannelProbe?.holdSnapshots(botId),
      SECOND_BOT_ID,
    );
    await expect(page.getByTestId("bot-channel-header")).toBeVisible();
    await nextFrames(page, 3);
    const opened = (await framesSince(page, 0)).length;

    await page.evaluate(
      (botId) => window.__botChannelProbe?.selectBot(botId),
      SECOND_BOT_ID,
    );
    await expect(page.getByTestId("bot-channel-opening-header")).toBeVisible();
    await nextFrames(page, 3);
    await page.evaluate(() => window.__botChannelProbe?.holdSnapshots(null));
    await expect(page.getByTestId("bot-channel-header")).toBeVisible();
    await nextFrames(page, 3);

    const frames = await framesSince(page, opened);
    expect(frames.some((f) => f.placement === "reserved")).toBe(true);
    expectSteady(frames);
  });
  test("holds the controls in the reserved title row, with the tab filling its pane, while the channel connects", async ({
    page,
  }) => {
    // With the channel still connecting its header does not exist yet: the
    // controls sit in the reserved title row, the tab fills its pane, and no
    // row of their own is drawn above it.
    await page.goto(
      `${fixture("bot-compact-actions-menu")}?form=desktop&music=1&snapshot=held`,
    );
    await expect(page.getByTestId("bot-tab-connecting")).toBeVisible();
    await expect(
      page.getByRole("group", { name: "Music playback" }),
    ).toHaveCount(1);
    await expect(
      page
        .getByTestId("bot-channel-opening-header")
        .getByRole("group", { name: "Music playback" }),
    ).toHaveCount(1);
    await expect(page.getByTestId("bot-channel-header")).toHaveCount(0);
    const reservedFit = await paneFit(page);
    expect(reservedFit.above).toBe(0);
    expect(reservedFit.tabBottom).toBe(reservedFit.paneBottom);
    expect(reservedFit.paneOverflow).toBe(0);
    // DOM order is tab order: the group's buttons come before the content.
    expect(
      await page
        .getByRole("group", { name: "Music playback" })
        .evaluate(
          (group) =>
            (group.compareDocumentPosition(
              document.querySelector('[data-testid="bot-tab-connecting"]') ??
                group,
            ) &
              Node.DOCUMENT_POSITION_FOLLOWING) !==
            0,
        ),
    ).toBe(true);
  });
});
