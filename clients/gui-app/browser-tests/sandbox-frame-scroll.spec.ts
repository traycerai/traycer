import { expect, test, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// An app's own reveal stays in its frame: the transcript holding the frame
// may move only for the reader. The fixture's app has a page taller than the
// row's cap, and reveals an element at its bottom on command.

async function outerScrollTop(page: Page): Promise<number> {
  return page.getByTestId("outer-scroller").evaluate((node) => node.scrollTop);
}

async function openSelfScrollingApp(page: Page): Promise<void> {
  await page.goto(`${fixture("mcp-app-fullscreen")}?scenario=self-scroll`);
  await page.waitForFunction(
    () => Number(document.body.dataset.reads ?? "0") > 3,
  );
}

for (const command of [
  "scroll-into-view",
  "scroll-into-view-if-needed",
  "focus",
] as const) {
  test(`the app's ${command} scrolls its own page and not the transcript`, async ({
    page,
  }) => {
    await openSelfScrollingApp(page);
    // The frame wholly above the view, the element below the frame's own.
    await page.getByTestId("outer-scroller").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    const before = await outerScrollTop(page);
    await page.evaluate((name) => {
      document.body.dataset.command = name;
    }, command);
    await page.waitForFunction(
      (name) => document.body.dataset.did === name,
      command,
    );

    expect(await outerScrollTop(page)).toBe(before);
    const appScrollY = await page.evaluate(() =>
      Number(document.body.dataset.appScrollY),
    );
    expect(appScrollY).toBeGreaterThan(0);
  });
}

test("a wheel the app cannot use still scrolls the transcript", async ({
  page,
}) => {
  await openSelfScrollingApp(page);
  const frame = page.locator("iframe").first();
  const box = await frame.boundingBox();
  if (box === null) throw new Error("no frame box");
  await page.getByTestId("outer-scroller").evaluate((node) => {
    node.scrollTop = 40;
  });
  const before = await outerScrollTop(page);
  await page.mouse.move(box.x + box.width / 2, box.y + 80);
  // The app's page scrolls first; the wheels past its end chain out.
  for (let i = 0; i < 40; i += 1) {
    await page.mouse.wheel(0, 400);
  }

  await expect.poll(() => outerScrollTop(page)).toBeGreaterThan(before);
});

test("the app's focus while the window is in the background scrolls its own page and not the transcript", async ({
  page,
  context,
}) => {
  await openSelfScrollingApp(page);
  // With the window unfocused, `:focus` matches nothing in the frame even
  // once the element is the frame's active element.
  const devtools = await context.newCDPSession(page);
  await devtools.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  await (await context.newPage()).bringToFront();
  await page.getByTestId("outer-scroller").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const before = await outerScrollTop(page);
  await page.evaluate(() => {
    document.body.dataset.command = "focus";
  });
  await page.waitForFunction(() => document.body.dataset.did === "focus");

  expect(await outerScrollTop(page)).toBe(before);
  const appScrollY = await page.evaluate(() =>
    Number(document.body.dataset.appScrollY),
  );
  expect(appScrollY).toBeGreaterThan(0);
});

// The native reveal's result, not a computed one: the frame's document as
// the app left it, reloaded in a page of the frame's size with no bootstrap,
// and revealed natively from the same offset.
for (const reveal of [
  { command: "body-overflow", target: "#mid", from: 0, block: "start" },
  {
    command: "covering-nearest",
    target: "#cover",
    from: 800,
    block: "nearest",
  },
] as const) {
  test(`the app's reveal lands where the native one does: ${reveal.command}`, async ({
    page,
    browser,
  }) => {
    await openSelfScrollingApp(page);
    await page.evaluate((name) => {
      document.body.dataset.command = name;
    }, reveal.command);
    await page.waitForFunction(
      (name) => document.body.dataset.did === name,
      reveal.command,
    );
    const contained = await page.evaluate(() =>
      Number(document.body.dataset.appScrollY),
    );
    const frame = page
      .frames()
      .find((candidate) => candidate !== page.mainFrame());
    if (frame === undefined) throw new Error("no app frame");
    const size = await frame.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    const html = (await frame.content())
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/g, "");

    const plain = await browser.newPage({ viewport: size });
    await plain.setContent(html);
    const native = await plain.evaluate(({ target, from, block }) => {
      window.scrollTo(0, from);
      document.querySelector(target)?.scrollIntoView({ block });
      return Math.round(window.scrollY);
    }, reveal);
    await plain.close();

    expect(contained).toBe(native);
  });
}
