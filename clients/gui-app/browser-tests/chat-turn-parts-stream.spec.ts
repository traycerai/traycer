import { expect, test, type Page } from "@playwright/test";
import { fixture, nextFrames } from "./support/fixtures";

interface Geometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrollMode: string | null;
}

interface TurnPartsProbe {
  readonly ready: boolean;
  readonly appendPart: () => void;
  readonly currentLastPartKey: () => string;
  readonly geometry: () => Geometry | null;
}

declare global {
  interface Window {
    __turnParts?: TurnPartsProbe;
  }
}

async function geometry(page: Page): Promise<Geometry> {
  const result = await page.evaluate(
    () => window.__turnParts?.geometry() ?? null,
  );
  if (result === null) throw new Error("the chat transcript is not mounted");
  return result;
}

async function openTurn(page: Page): Promise<Geometry> {
  await page.goto(fixture("chat-turn-parts-stream"));
  await page.waitForFunction(() => window.__turnParts?.ready === true);
  await nextFrames(page, 10);
  await expect
    .poll(async () => {
      const current = await geometry(page);
      return current.scrollHeight - current.scrollTop - current.clientHeight;
    })
    .toBeLessThanOrEqual(2);
  return geometry(page);
}

async function appendPart(page: Page, previous: Geometry): Promise<Geometry> {
  await page.evaluate(() => window.__turnParts?.appendPart());
  await expect
    .poll(async () => (await geometry(page)).scrollHeight)
    .toBeGreaterThan(previous.scrollHeight);
  return geometry(page);
}

test.use({ viewport: { width: 900, height: 700 }, colorScheme: "light" });

test("the transcript follows the end as assistant parts append", async ({
  page,
}) => {
  let current = await openTurn(page);
  for (let index = 0; index < 3; index += 1) {
    current = await appendPart(page, current);
    await expect
      .poll(async () => {
        const next = await geometry(page);
        return next.scrollHeight - next.scrollTop - next.clientHeight;
      })
      .toBeLessThanOrEqual(2);
  }
  expect(current.scrollHeight).toBeGreaterThan(0);
  expect(current.scrollMode).toBe("following-end");
});

test("scrolling up reveals Jump to Latest and holds position while parts append", async ({
  page,
}) => {
  const start = await openTurn(page);
  const scroller = page.getByTestId("chat-messages-scroll");
  const bounds = await scroller.boundingBox();
  if (bounds === null) throw new Error("the chat scroller has no box");
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.wheel(0, -360);

  await expect
    .poll(async () => (await geometry(page)).scrollMode)
    .toBe("free-scrolling");
  const detached = await geometry(page);
  expect(detached.scrollTop).toBeLessThan(start.scrollTop - 50);
  await expect(
    page.getByRole("button", { name: "Scroll to end" }),
  ).toBeVisible();

  let current = detached;
  for (let index = 0; index < 2; index += 1) {
    current = await appendPart(page, current);
    await expect
      .poll(async () =>
        Math.abs((await geometry(page)).scrollTop - detached.scrollTop),
      )
      .toBeLessThanOrEqual(2);
    await expect(
      page.getByRole("button", { name: "Scroll to end" }),
    ).toBeVisible();
  }
  expect(current.scrollHeight).toBeGreaterThan(detached.scrollHeight);
});

test("a reader part stays at the same viewport position while it grows mid-turn", async ({
  page,
}) => {
  await openTurn(page);
  const lastPartKey = await page.evaluate(
    () => window.__turnParts?.currentLastPartKey() ?? null,
  );
  if (lastPartKey === null)
    throw new Error("the streaming turn has no part key");
  const part = page.locator(`[data-row-key="${lastPartKey}"]`);
  await expect(part).toBeVisible();

  const scroller = page.getByTestId("chat-messages-scroll");
  const bounds = await scroller.boundingBox();
  if (bounds === null) throw new Error("the chat scroller has no box");
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.wheel(0, -120);
  await expect
    .poll(async () => (await geometry(page)).scrollMode)
    .toBe("free-scrolling");

  const before = await geometry(page);
  const beforeTop = await part.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  const previousHeight = before.scrollHeight;
  await page.evaluate(() => window.__turnParts?.appendPart());
  await expect
    .poll(async () => (await geometry(page)).scrollHeight)
    .toBeGreaterThan(previousHeight);
  await expect
    .poll(async () =>
      Math.abs((await geometry(page)).scrollTop - before.scrollTop),
    )
    .toBeLessThanOrEqual(2);
  await expect
    .poll(async () => {
      const top = await part.evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      return Math.abs(top - beforeTop);
    })
    .toBeLessThanOrEqual(2);
});
