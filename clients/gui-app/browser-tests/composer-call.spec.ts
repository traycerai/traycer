import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

declare global {
  interface Window {
    __composerCallProbe?: {
      readonly offer: () => void;
      readonly sent: () => readonly {
        readonly text: string;
        readonly threadId: string | null;
      }[];
      readonly completeSend: () => void;
      readonly placeCall: () => void;
      readonly goLive: () => void;
      readonly showCaptions: () => void;
      readonly pauseForDictation: () => void;
    };
  }
}

// Call sits beside Send in a bot's message box, and in a call the box's field
// gives way to a bar of controls. Whether they fit the box, at the phone's
// width and at every desktop width, and stay inside it when the bot's name is
// long, is real layout: jsdom lays nothing out.

test.use({ deviceScaleFactor: 1 });

const BOX = '[data-testid="bot-channel-composer"]';
const LONG_TITLE =
  "Release engineering bot for the platform infrastructure and billing teams";

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("no box");
  return box;
}

function rightOf(box: Box): number {
  return box.x + box.width;
}

function bottomOf(box: Box): number {
  return box.y + box.height;
}

async function open(page: Page, width: number, query: string): Promise<void> {
  await page.setViewportSize({ width, height: 700 });
  await page.goto(`${fixture("composer-call")}?${query}`);
  await page.waitForFunction(() => window.__composerCallProbe !== undefined);
  await page.evaluate(() => window.__composerCallProbe?.offer());
  await page.getByRole("button", { name: /^Call / }).waitFor();
}

async function startCall(page: Page, testId: string): Promise<void> {
  await page.evaluate(() => window.__composerCallProbe?.placeCall());
  await page.evaluate(() => window.__composerCallProbe?.goLive());
  await page.getByTestId(`${testId}-call-bar`).waitFor();
  await nextFrames(page, 2);
}

async function expectTakesThePointer(control: Locator): Promise<void> {
  const box = await boxOf(control);
  const hit = await control.evaluate(
    (node, [x, y]) => node.contains(document.elementFromPoint(x, y)),
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  expect(hit).toBe(true);
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const sideways = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(sideways).toBe(0);
}

/** `inner` lies inside `outer`, to the pixel a border rounds to. */
function expectInside(inner: Box, outer: Box): void {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - 0.5);
  expect(rightOf(inner)).toBeLessThanOrEqual(rightOf(outer) + 0.5);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - 0.5);
  expect(bottomOf(inner)).toBeLessThanOrEqual(bottomOf(outer) + 0.5);
}

for (const width of [390, 768, 1024, 1400]) {
  test(`at ${String(width)}px Call sits beside Send inside the box, and the window does not scroll sideways`, async ({
    page,
  }) => {
    await open(page, width, "box=channel");
    const call = page.getByTestId("bot-channel-composer-call");
    const send = page.getByTestId("bot-channel-composer-send");
    const field = page.getByTestId("bot-channel-composer-input");
    await expect(call).toBeVisible();
    // A draft, so Send takes the pointer too.
    await field.locator("[data-composer-editor]").fill("Is CI green?");
    await expect(send).toBeEnabled();

    const form = await boxOf(page.locator(BOX));
    const callBox = await boxOf(call);
    const sendBox = await boxOf(send);
    expectInside(callBox, form);
    expectInside(sendBox, form);
    expectInside(await boxOf(field), form);
    expect(rightOf(form)).toBeLessThanOrEqual(width);
    // Beside Send, on its line, before it, close enough to read as a pair.
    expect(rightOf(callBox)).toBeLessThanOrEqual(sendBox.x);
    expect(sendBox.x - rightOf(callBox)).toBeLessThanOrEqual(16);
    expect(
      Math.abs(
        callBox.y + callBox.height / 2 - (sendBox.y + sendBox.height / 2),
      ),
    ).toBeLessThanOrEqual(1);
    await expectTakesThePointer(call);
    await expectTakesThePointer(send);
    await expectNoSidewaysScroll(page);
  });
}

for (const { width, pane } of [
  { width: 768, pane: null },
  { width: 1024, pane: null },
  { width: 1400, pane: null },
  { width: 1400, pane: "384" },
]) {
  const where = pane === null ? "" : ` in a ${pane}px column`;
  const query = `box=channel&title=${encodeURIComponent(LONG_TITLE)}${pane === null ? "" : `&pane=${pane}`}`;

  test(`at ${String(width)}px${where} every control of a call is whole inside the box, whatever the bot's name`, async ({
    page,
  }) => {
    await open(page, width, query);
    await startCall(page, "bot-channel-composer");
    await page.evaluate(() => window.__composerCallProbe?.showCaptions());
    await page.evaluate(() => window.__composerCallProbe?.pauseForDictation());
    // The widest bar: Resume, Mute, Captions and End together.
    const resume = page.getByTestId("voice-call-resume");
    await expect(resume).toBeVisible();

    const bar = page.getByTestId("bot-channel-composer-call-bar");
    const barBox = await boxOf(bar);
    const form = await boxOf(page.locator(BOX));
    expectInside(barBox, form);
    expect(rightOf(form)).toBeLessThanOrEqual(width);
    for (const control of [
      page.getByTestId("bot-channel-composer-call-level"),
      resume,
      page.getByTestId("bot-channel-composer-call-mute"),
      page.getByTestId("bot-channel-composer-call-captions"),
      page.getByTestId("bot-channel-composer-call-end"),
    ]) {
      await expect(control).toBeVisible();
      expectInside(await boxOf(control), barBox);
    }
    for (const control of [
      resume,
      page.getByTestId("bot-channel-composer-call-mute"),
      page.getByTestId("bot-channel-composer-call-captions"),
      page.getByTestId("bot-channel-composer-call-end"),
    ]) {
      await expectTakesThePointer(control);
    }
    // Nothing spills past the bar's edge, and the controls keep their order.
    expect(
      await bar.evaluate((node) => node.scrollWidth - node.clientWidth),
    ).toBeLessThanOrEqual(0);
    const mute = await boxOf(
      page.getByTestId("bot-channel-composer-call-mute"),
    );
    const captions = await boxOf(
      page.getByTestId("bot-channel-composer-call-captions"),
    );
    const end = await boxOf(page.getByTestId("bot-channel-composer-call-end"));
    expect(rightOf(mute)).toBeLessThanOrEqual(captions.x);
    expect(rightOf(captions)).toBeLessThanOrEqual(end.x);
    await expectNoSidewaysScroll(page);
  });
}

test("a long bot name is cut short in the bar and pushes no control out", async ({
  page,
}) => {
  await open(
    page,
    1400,
    `box=channel&title=${encodeURIComponent(LONG_TITLE)}&pane=384`,
  );
  await startCall(page, "bot-channel-composer");
  const bar = page.getByTestId("bot-channel-composer-call-bar");
  const name = bar.getByText(LONG_TITLE, { exact: true });

  await expect(name).toBeVisible();
  expect(
    await name.evaluate((node) => node.scrollWidth > node.clientWidth),
  ).toBe(true);
  expect(
    await name.evaluate((node) => getComputedStyle(node).textOverflow),
  ).toBe("ellipsis");
  const end = await boxOf(page.getByTestId("bot-channel-composer-call-end"));
  expect(rightOf(end)).toBeLessThanOrEqual(rightOf(await boxOf(bar)));
});

test("a short bot name is shown whole in the bar", async ({ page }) => {
  await open(page, 1400, "box=channel&title=Tracy");
  await startCall(page, "bot-channel-composer");

  const name = page
    .getByTestId("bot-channel-composer-call-bar")
    .getByText("Tracy", { exact: true });
  await expect(name).toBeVisible();
  expect(
    await name.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
});

test("a thread's box holds the same bar inside a column as narrow as the thread's", async ({
  page,
}) => {
  await open(
    page,
    1024,
    `box=thread&pane=384&title=${encodeURIComponent(LONG_TITLE)}`,
  );
  await startCall(page, "bot-thread-composer");

  const bar = page.getByTestId("bot-thread-composer-call-bar");
  const form = await boxOf(page.getByTestId("bot-thread-composer"));
  const barBox = await boxOf(bar);
  expectInside(barBox, form);
  for (const id of ["mute", "captions", "end"]) {
    const control = page.getByTestId(`bot-thread-composer-call-${id}`);
    await expect(control).toBeVisible();
    expectInside(await boxOf(control), barBox);
  }
});

test("the captions hang above the box, inside the window", async ({ page }) => {
  await open(page, 1024, "box=channel");
  await startCall(page, "bot-channel-composer");
  await page.evaluate(() => window.__composerCallProbe?.showCaptions());

  const lines = page.getByTestId("bot-channel-composer-call-captions-lines");
  await expect(lines).toBeVisible();
  const linesBox = await boxOf(lines);
  const bar = await boxOf(page.getByTestId("bot-channel-composer-call-bar"));
  expect(bottomOf(linesBox)).toBeLessThanOrEqual(bar.y);
  expectInside(linesBox, await boxOf(page.locator(BOX)));
});

test.describe("mobile Send touch target", () => {
  test.use({ hasTouch: true });
  for (const { box, fontSize } of [
    { box: "channel", fontSize: 15 },
    { box: "thread", fontSize: 15 },
    { box: "channel", fontSize: 10 },
    { box: "thread", fontSize: 10 },
  ]) {
    test(`${box} at ${fontSize}px edge taps send once while Call and the draft stay separate`, async ({
      page,
    }) => {
      await open(page, 390, `box=${box}`);
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = `${size}px`;
      }, fontSize);
      const id = `bot-${box}-composer`;
      const send = page.getByTestId(`${id}-send`);
      const field = page
        .getByTestId(`${id}-input`)
        .locator("[data-composer-editor]");
      await expect(send).toBeDisabled();
      const idle = await boxOf(send);
      expect(idle.width).toBeGreaterThanOrEqual(44);
      expect(idle.height).toBeGreaterThanOrEqual(44);
      await page.touchscreen.tap(idle.x + 2, idle.y + idle.height / 2);
      await nextFrames(page, 2);
      expect(
        await page.evaluate(() => window.__composerCallProbe?.sent()),
      ).toEqual([]);
      await field.fill("Please check CI");
      await expect(send).toBeEnabled();
      const target = await boxOf(send);
      const call = await boxOf(page.getByTestId(`${id}-call`));
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
      expect(target.x - rightOf(call)).toBeGreaterThanOrEqual(fontSize / 2);
      expectInside(target, await boxOf(page.getByTestId(id)));
      const fieldBox = await boxOf(field);
      expect(rightOf(fieldBox) <= call.x || bottomOf(fieldBox) <= call.y).toBe(
        true,
      );
      const glyph = await boxOf(send.locator("svg"));
      expect(glyph.width).toBe(fontSize);
      await page.touchscreen.tap(target.x + 2, target.y + target.height / 2);
      await expect
        .poll(() =>
          page.evaluate(() => window.__composerCallProbe?.sent().length),
        )
        .toBe(1);
      await expect(send).toBeDisabled();
      await field.fill("Keep this next draft");
      const pending = await boxOf(send);
      await page.touchscreen.tap(
        rightOf(pending) - 2,
        pending.y + pending.height / 2,
      );
      await nextFrames(page, 2);
      expect(
        await page.evaluate(() => window.__composerCallProbe?.sent().length),
      ).toBe(1);
      await page.evaluate(() => window.__composerCallProbe?.completeSend());
      await expect(send).toBeEnabled();
      await expect(field).toHaveText("Keep this next draft");
      const second = await boxOf(send);
      await page.touchscreen.tap(
        rightOf(second) - 2,
        second.y + second.height / 2,
      );
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__composerCallProbe
              ?.sent()
              .map(({ text, threadId }) => ({ text, threadId })),
          ),
        )
        .toEqual([
          {
            text: "Please check CI",
            threadId: box === "thread" ? "thread-1" : null,
          },
          {
            text: "Keep this next draft",
            threadId: box === "thread" ? "thread-1" : null,
          },
        ]);
      await expectNoSidewaysScroll(page);
    });
  }
});
