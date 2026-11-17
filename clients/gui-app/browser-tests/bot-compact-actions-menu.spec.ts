import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";
import {
  expectSteadyFrames,
  groupFramesSince,
  recordGroupFrames,
} from "./support/music-group-frames.ts";

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
      readonly showThreads: (shown: boolean) => void;
      readonly showSession: (chatId: string | null) => void;
      readonly soundTrack: (name: string) => void;
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
    await recordGroupFrames(page);
    await page.goto(
      `${fixture("bot-compact-actions-menu")}?form=desktop&music=1`,
    );
    await expect(page.getByTestId("bot-channel-header")).toBeVisible();
    await nextFrames(page, 3);

    expectSteadyFrames(await groupFramesSince(page, 0));
  });

  test("a cold open held at the connecting channel never draws the row, and nothing under the group moves", async ({
    page,
  }) => {
    await recordGroupFrames(page);
    await page.goto(
      `${fixture("bot-compact-actions-menu")}?form=desktop&music=1&snapshot=held`,
    );
    await expect(page.getByTestId("bot-channel-opening-header")).toBeVisible();
    await nextFrames(page, 3);
    await page.evaluate(() => window.__botChannelProbe?.holdSnapshots(null));
    await expect(page.getByTestId("bot-channel-header")).toBeVisible();
    await nextFrames(page, 3);

    const frames = await groupFramesSince(page, 0);
    expect(frames.some((f) => f.placement === "reserved")).toBe(true);
    expectSteadyFrames(frames);
  });

  test("a switch to another channel never draws the row, and nothing under the group moves", async ({
    page,
  }) => {
    await recordGroupFrames(page);
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
    const opened = (await groupFramesSince(page, 0)).length;

    await page.evaluate(
      (botId) => window.__botChannelProbe?.selectBot(botId),
      SECOND_BOT_ID,
    );
    await expect(page.getByTestId("bot-channel-opening-header")).toBeVisible();
    await nextFrames(page, 3);
    await page.evaluate(() => window.__botChannelProbe?.holdSnapshots(null));
    await expect(page.getByTestId("bot-channel-header")).toBeVisible();
    await nextFrames(page, 3);

    const frames = await groupFramesSince(page, opened);
    expect(frames.some((f) => f.placement === "reserved")).toBe(true);
    expectSteadyFrames(frames);
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

interface Recorded {
  readonly node: HTMLElement;
  readonly time: number;
  readonly label: string;
  readonly playState: AnimationPlayState;
  /** How many frames had been sampled when it was recorded. */
  readonly frames: number;
}

interface ReferenceFrame {
  /** The title's animation timeline on the frame; `null` with no animation. */
  readonly title: number | null;
  /** The timeline of an animation of the same title that was never moved. */
  readonly reference: number;
}

interface TitleFrame {
  /** The title's animation timeline on the frame; `null` with no animation. */
  readonly time: number | null;
  readonly paused: boolean;
}

declare global {
  interface Window {
    __recorded?: Recorded;
    __titleFrames?: TitleFrame[];
    __moveBeforeCalls?: number;
    __referenceFrames?: ReferenceFrame[];
  }
}

interface ContinuityReading {
  readonly sameNode: boolean;
  readonly active: string;
  readonly label: string;
  readonly time: number | null;
  readonly playState: AnimationPlayState | null;
  readonly before: number;
  readonly moveBeforeCalls: number;
  /** The title's frames from the one the move was made on. */
  readonly frames: readonly TitleFrame[];
}

const TITLE = '[data-testid="epic-playback-track"] .soundtrack-title';

interface Tracked {
  readonly page: Page;
  /** What the page threw or crashed with. */
  readonly failures: string[];
}

/** Samples the title's animation on every frame and counts native moves, before the page loads. */
async function trackTitle(page: Page): Promise<string[]> {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("crash", () => failures.push("the page crashed"));
  await page.addInitScript((titleSelector) => {
    window.__moveBeforeCalls = 0;
    const move: unknown = Reflect.get(Element.prototype, "moveBefore");
    if (typeof move === "function") {
      Element.prototype.moveBefore = function (
        node: Node,
        child: Node | null,
      ): void {
        window.__moveBeforeCalls = (window.__moveBeforeCalls ?? 0) + 1;
        Reflect.apply(move, this, [node, child]);
      };
    }
    const frames: TitleFrame[] = [];
    window.__titleFrames = frames;
    const sample = (): void => {
      const animation = document
        .querySelector(titleSelector)
        ?.getAnimations({ subtree: true })
        .at(0);
      frames.push(
        animation === undefined
          ? { time: null, paused: false }
          : {
              time: Number(animation.currentTime),
              paused: animation.playState === "paused",
            },
      );
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, TITLE);
  return failures;
}

async function openTracked(
  context: BrowserContext,
  query: string,
): Promise<Tracked> {
  const page = await context.newPage();
  const failures = await trackTitle(page);
  await page.goto(
    `${fixture("bot-compact-actions-menu")}?form=desktop&music=long&${query}`,
  );
  await page.waitForFunction(() => window.__botChannelProbe !== undefined);
  return { page, failures };
}

/** Records the node holding focus, the title's animation, and the frames so far. */
async function recordContinuity(page: Page): Promise<void> {
  await expect(page.locator(TITLE).first()).toHaveAttribute(
    "data-scrolling",
    "true",
  );
  await page.evaluate(async (titleSelector) => {
    const node = document.activeElement;
    const animation = document
      .querySelector(titleSelector)
      ?.getAnimations({ subtree: true })
      .at(0);
    if (!(node instanceof HTMLElement) || animation === undefined)
      throw new Error("a control must hold focus beside a running title");
    await animation.ready;
    window.__recorded = {
      node,
      time: Number(animation.currentTime),
      label: node.getAttribute("aria-label") ?? "",
      playState: animation.playState,
      frames: window.__titleFrames?.length ?? 0,
    };
  }, TITLE);
}

async function readContinuity(page: Page): Promise<ContinuityReading> {
  return page.evaluate((titleSelector) => {
    const recorded = window.__recorded;
    if (recorded === undefined) throw new Error("nothing was recorded");
    const animation = document
      .querySelector(titleSelector)
      ?.getAnimations({ subtree: true })
      .at(0);
    const active = document.activeElement;
    return {
      sameNode: active === recorded.node,
      active: `${active?.tagName ?? "none"} ${active?.getAttribute("aria-label") ?? ""}`,
      label: recorded.node.getAttribute("aria-label") ?? "",
      time: animation === undefined ? null : Number(animation.currentTime),
      playState: animation?.playState ?? null,
      before: recorded.time,
      moveBeforeCalls: window.__moveBeforeCalls ?? 0,
      frames: (window.__titleFrames ?? []).slice(recorded.frames),
    };
  }, TITLE);
}

type Mode = "playing" | "paused";

/**
 * After a move the same node holds focus under the label it had, no native
 * move was made, and the title's animation has not gone back: on every frame
 * since the move was made it exists, and it has run on from where it was when
 * playing, or stands where it was, paused, when paused.
 */
async function expectContinuous(
  page: Page,
  move: string,
  mode: Mode,
): Promise<void> {
  const reading = await readContinuity(page);
  const where = `${move}: ${JSON.stringify({ ...reading, frames: reading.frames.length })}`;
  expect.soft(reading.moveBeforeCalls, `no native move, ${where}`).toBe(0);
  expect.soft(reading.sameNode, `focus kept, ${where}`).toBe(true);
  expect
    .soft(reading.label, `label kept, ${where}`)
    .toBe(mode === "playing" ? "Pause" : "Play");
  const times = reading.frames.map((frame) => frame.time);
  expect
    .soft(times.length, `frames since the move, ${where}`)
    .toBeGreaterThan(0);
  expect
    .soft(
      times.filter((time) => time === null),
      `a frame with no title, ${where}`,
    )
    .toEqual([]);
  if (mode === "playing") {
    expect
      .soft(
        times.filter((time) => time !== null && time < reading.before),
        `a frame behind where it was, ${where}`,
      )
      .toEqual([]);
    expect
      .soft(reading.time ?? 0, `ran on, ${where}`)
      .toBeGreaterThan(reading.before);
  } else {
    expect
      .soft(
        times.filter(
          (time) => time === null || Math.abs(time - reading.before) > 1,
        ),
        `a frame off where it stood, ${where}`,
      )
      .toEqual([]);
    expect.soft(reading.playState, `still paused, ${where}`).toBe("paused");
    expect
      .soft(
        reading.frames.filter((frame) => !frame.paused),
        `a frame that ran, ${where}`,
      )
      .toEqual([]);
  }
}

/** One painted frame: what a move may leave a running title behind by. */
const ONE_FRAME_MS = 17;
/** What the move is made to take, in the task that commits it. */
const MOVE_COST_MS = 40;

/**
 * Starts an animation of the title's own keyframes and timing on an element
 * outside the tab, at the title's own start time, so the two read the same
 * timeline until the title is moved; it is then where the title would be had
 * it never moved. Every frame from here records both.
 */
async function startReference(page: Page): Promise<void> {
  const before = await page.evaluate((titleSelector) => {
    const title = document
      .querySelector(titleSelector)
      ?.getAnimations({ subtree: true })
      .at(0);
    if (title === undefined || !(title.effect instanceof KeyframeEffect))
      throw new Error("a running title is needed to start a reference");
    const element = document.createElement("div");
    document.body.append(element);
    const reference = new Animation(
      new KeyframeEffect(
        element,
        title.effect.getKeyframes(),
        title.effect.getTiming(),
      ),
      document.timeline,
    );
    reference.startTime = title.startTime;
    const frames: ReferenceFrame[] = [];
    window.__referenceFrames = frames;
    const sample = (): void => {
      const current = document
        .querySelector(titleSelector)
        ?.getAnimations({ subtree: true })
        .at(0);
      frames.push({
        title: current === undefined ? null : Number(current.currentTime),
        reference: Number(reference.currentTime),
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    return {
      title: Number(title.currentTime),
      reference: Number(reference.currentTime),
    };
  }, TITLE);
  expect(
    Math.abs(before.title - before.reference),
    "the reference reads the title's own time",
  ).toBeLessThanOrEqual(1);
}

/**
 * Makes the next move of the controls' carrier take `ms` of the task that
 * commits it: the busy wait comes right after the carrier is inserted, and so
 * between what the scope read before the move and what it puts back.
 */
async function slowNextCarrierMove(page: Page, ms: number): Promise<void> {
  await page.evaluate((cost) => {
    const append: unknown = Reflect.get(Node.prototype, "appendChild");
    if (typeof append !== "function") throw new Error("no appendChild");
    let slow = true;
    Node.prototype.appendChild = function <T extends Node>(
      this: Node,
      node: T,
    ): T {
      Reflect.apply(append, this, [node]);
      if (
        slow &&
        node instanceof HTMLElement &&
        node.querySelector('[role="group"][aria-label="Music playback"]') !==
          null
      ) {
        slow = false;
        const end = performance.now() + cost;
        while (performance.now() < end) continue;
      }
      return node;
    };
  }, ms);
}

async function referenceFramesFrom(
  page: Page,
  mark: number,
): Promise<ReferenceFrame[]> {
  return page.evaluate(
    (from) => (window.__referenceFrames ?? []).slice(from),
    mark,
  );
}

async function focusToggle(page: Page, name: "Pause" | "Play"): Promise<void> {
  await page
    .getByRole("group", { name: "Music playback" })
    .getByRole("button", { name })
    .focus();
}

interface Move {
  readonly name: string;
  readonly query: string;
  /** Runs once the channel's header shows, before the first move. */
  readonly prepare: (page: Page) => Promise<void>;
  /** Moves the tab off the channel's header and waits for where it goes. */
  readonly out: (page: Page) => Promise<void>;
  /** Moves it back to the channel's header and waits for it. */
  readonly back: (page: Page) => Promise<void>;
}

const channelHeader = (page: Page): Locator =>
  page.getByTestId("bot-channel-header");

async function expectOneGroup(page: Page): Promise<void> {
  await expect(page.getByRole("group", { name: "Music playback" })).toHaveCount(
    1,
  );
}

const SESSION: Move = {
  name: "a session",
  query: "bots=2",
  prepare: () => Promise.resolve(),
  out: async (page) => {
    await page.evaluate(() =>
      window.__botChannelProbe?.showSession("fixture-chat"),
    );
    await expect(page.getByTestId("bot-session-view")).toBeVisible();
    await expectOneGroup(page);
  },
  back: async (page) => {
    await page.evaluate(() => window.__botChannelProbe?.showSession(null));
    await expect(channelHeader(page)).toBeVisible();
  },
};

const OTHER_BOT: Move = {
  name: "another bot, through the reserved row",
  query: "bots=2&snapshot=held",
  // Only a switch made while the other bot's snapshot is still held reaches
  // the reserved row.
  prepare: async (page) => {
    await page.evaluate(
      (botId) => window.__botChannelProbe?.holdSnapshots(botId),
      SECOND_BOT_ID,
    );
  },
  out: async (page) => {
    await page.evaluate(
      (botId) => window.__botChannelProbe?.selectBot(botId),
      SECOND_BOT_ID,
    );
    await expect(page.getByTestId("bot-channel-opening-header")).toBeVisible();
  },
  back: async (page) => {
    await page.evaluate(() => window.__botChannelProbe?.holdSnapshots(null));
    await expect(channelHeader(page)).toBeVisible();
  },
};

// Threads draws the controls in their own row, with its own title.
const THREADS: Move = {
  name: "Threads",
  query: "bots=2",
  prepare: () => Promise.resolve(),
  out: async (page) => {
    await page.evaluate(() => window.__botChannelProbe?.showThreads(true));
    await expect(page.getByTestId("bot-threads-view")).toBeVisible();
    await expectOneGroup(page);
  },
  back: async (page) => {
    await page.evaluate(() => window.__botChannelProbe?.showThreads(false));
    await expect(channelHeader(page)).toBeVisible();
  },
};

/** Opens the page at the channel's header, with `name` focused when it is a control of the group. */
async function openAtHeader(
  context: BrowserContext,
  move: Move,
): Promise<Tracked> {
  const tracked = await openTracked(context, move.query);
  await move.prepare(tracked.page);
  await expect(channelHeader(tracked.page)).toBeVisible();
  return tracked;
}

/**
 * Makes `move` out and back, checking each leg against what stood before it:
 * the focused node and the title as `mode` says.
 */
async function moveOutAndBack(
  page: Page,
  move: Move,
  mode: Mode,
): Promise<void> {
  await focusToggle(page, mode === "playing" ? "Pause" : "Play");
  for (const leg of ["out", "back"] as const) {
    await recordContinuity(page);
    await move[leg](page);
    await nextFrames(page, 3);
    await expectContinuous(page, `${move.name} ${leg}`, mode);
  }
}

test.describe("the playback controls across the Tracy tab's moves", () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    hasTouch: false,
    isMobile: false,
  });

  for (const move of [SESSION, OTHER_BOT, THREADS]) {
    test(`keep focus and their running title across ${move.name}`, async ({
      context,
    }) => {
      const { page, failures } = await openAtHeader(context, move);
      expect(
        await page.evaluate(() => "moveBefore" in Element.prototype),
        "the browser has the native move the scope does not use",
      ).toBe(true);

      await moveOutAndBack(page, move, "playing");

      expect(failures).toEqual([]);
    });
  }

  test("keep a paused title where it stood, still paused, across a session and Threads", async ({
    context,
  }) => {
    const { page, failures } = await openAtHeader(context, SESSION);
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByRole("button", { name: "Play" })).toBeVisible();

    await moveOutAndBack(page, SESSION, "paused");
    await moveOutAndBack(page, THREADS, "paused");

    // Play still starts the title that was held still.
    await page.getByRole("button", { name: "Play" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          (titleSelector) =>
            document
              .querySelector(titleSelector)
              ?.getAnimations({ subtree: true })
              .at(0)?.playState,
          TITLE,
        ),
      )
      .toBe("running");

    expect(failures).toEqual([]);
  });

  for (const move of [SESSION, THREADS]) {
    test(`a running title is where it would have been after ${move.name}, though the move takes ${MOVE_COST_MS} ms`, async ({
      context,
    }) => {
      const { page, failures } = await openAtHeader(context, move);
      await expect(page.locator(TITLE).first()).toHaveAttribute(
        "data-scrolling",
        "true",
      );
      await startReference(page);
      await slowNextCarrierMove(page, MOVE_COST_MS);
      const mark =
        (await page.evaluate(() => window.__referenceFrames?.length)) ?? 0;

      await move.out(page);
      await nextFrames(page, 5);

      const frames = await referenceFramesFrom(page, mark);
      const lags = frames.map((frame) =>
        frame.title === null ? null : frame.title - frame.reference,
      );
      expect(frames.length, "frames since the move").toBeGreaterThan(5);
      expect(
        lags.filter((lag) => lag === null || Math.abs(lag) > ONE_FRAME_MS),
        `frames off the reference by more than one frame, in ms: ${JSON.stringify(lags)}`,
      ).toEqual([]);
      expect(failures).toEqual([]);
    });

    test(`a paused title stands where it stood after ${move.name}, though the move takes ${MOVE_COST_MS} ms`, async ({
      context,
    }) => {
      const { page, failures } = await openAtHeader(context, move);
      await page.getByRole("button", { name: "Pause" }).click();
      await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
      await recordContinuity(page);
      await slowNextCarrierMove(page, MOVE_COST_MS);

      await move.out(page);
      await nextFrames(page, 3);

      const after = await readContinuity(page);
      expect(after.playState).toBe("paused");
      expect(
        Math.abs((after.time ?? Infinity) - after.before),
      ).toBeLessThanOrEqual(1);
      expect(failures).toEqual([]);
    });
  }

  test("do not take focus from a control outside the group, or give it to one when none had it", async ({
    context,
  }) => {
    const { page } = await openAtHeader(context, SESSION);
    const outside = page.getByRole("button", { name: "Open menu" });
    const holdsPlayback = (): Promise<boolean> =>
      page.evaluate(
        () =>
          document.activeElement?.closest(
            '[role="group"][aria-label="Music playback"]',
          ) instanceof Element,
      );

    await outside.focus();
    await SESSION.out(page);
    await nextFrames(page, 3);
    await expect(outside).toBeFocused();
    await SESSION.back(page);
    await nextFrames(page, 3);
    await expect(outside).toBeFocused();

    await outside.blur();
    await SESSION.out(page);
    await nextFrames(page, 3);
    expect(await holdsPlayback()).toBe(false);
    await SESSION.back(page);
    await nextFrames(page, 3);
    expect(await holdsPlayback()).toBe(false);
  });

  test("keep the tab order Previous, Pause, Next, Search after a session and back", async ({
    context,
  }) => {
    const { page } = await openAtHeader(context, SESSION);
    await SESSION.out(page);
    await SESSION.back(page);
    await nextFrames(page, 3);

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
  });

  test("move without a title to carry under reduced motion, throwing nothing and keeping one group", async ({
    context,
  }) => {
    const { page, failures } = await openAtHeader(context, THREADS);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(
      page.getByRole("group", { name: "Music playback" }),
    ).toHaveCount(1);

    await THREADS.out(page);
    await THREADS.back(page);
    await nextFrames(page, 3);

    await expectOneGroup(page);
    expect(failures).toEqual([]);
  });

  test("start the title of another track from its own beginning when the track changes as the tab moves", async ({
    context,
  }) => {
    const { page } = await openAtHeader(context, SESSION);
    await focusToggle(page, "Pause");
    await page.waitForFunction(
      (titleSelector) =>
        Number(
          document
            .querySelector(titleSelector)
            ?.getAnimations({ subtree: true })
            .at(0)?.currentTime,
        ) > 1000,
      TITLE,
    );
    await recordContinuity(page);
    const before = (await readContinuity(page)).before;
    expect(before).toBeGreaterThan(1000);

    await page.evaluate(() => {
      window.__botChannelProbe?.soundTrack("other-tide");
      window.__botChannelProbe?.showSession("fixture-chat");
    });
    await expect(page.getByTestId("bot-session-view")).toBeVisible();
    await nextFrames(page, 3);

    const after = await readContinuity(page);
    expect(after.time).not.toBeNull();
    expect(after.time ?? before).toBeLessThan(before);
  });
});
