import { expect, test, type Page } from "@playwright/test";
import { fixture } from "./support/fixtures";
import "./support/ordinary-draft-storage";

async function openDraftStorageFixture(page: Page): Promise<void> {
  await page.goto(fixture("ordinary-draft-storage"), { waitUntil: "commit" });
  await page.waitForFunction(
    () => typeof window.ordinaryDraftBrowser !== "undefined",
  );
}

test("keeps a trusted landing keystroke between IndexedDB commit and delivery", async ({
  page,
}) => {
  await openDraftStorageFixture(page);
  const editor = page.getByRole("textbox", { name: "Draft" });
  await page.evaluate(() => window.ordinaryDraftBrowser.beginTombstone());
  await editor.press("End");
  await editor.press("!");
  const state = await page.evaluate(() =>
    window.ordinaryDraftBrowser.finishTombstone(),
  );
  expect(state).toMatchObject({
    editor: {
      value: { content: { content: [{ content: [{ text: "before!" }] }] } },
    },
    pending: "held",
    evidence: 2,
  });
});

test("keeps a live tab's stage and reclaims it after Chromium releases its Web Lock", async ({
  page,
  context,
}) => {
  const writer = await context.newPage();
  await Promise.all([
    openDraftStorageFixture(writer),
    openDraftStorageFixture(page),
  ]);
  const hashes = await writer.evaluate(() =>
    window.ordinaryDraftBrowser.stage(8, 17),
  );
  expect(hashes).toHaveLength(2);
  expect(
    await page.evaluate(
      (batch) => window.ordinaryDraftBrowser.recover(batch),
      hashes,
    ),
  ).toEqual([true, true]);
  await writer.close();
  await expect
    .poll(() =>
      page.evaluate(async () => (await navigator.locks.query()).held?.length),
    )
    .toBe(0);
  expect(
    await page.evaluate(
      (batch) => window.ordinaryDraftBrowser.recover(batch),
      hashes,
    ),
  ).toEqual([false, false]);
});

test("refuses a batch at real Chromium quota without committing any of its images", async ({
  page,
  context,
}) => {
  await openDraftStorageFixture(page);
  const origin = new URL(page.url()).origin;
  const devtools = await context.newCDPSession(page);
  await devtools.send("Storage.overrideQuotaForOrigin", {
    origin,
    quotaSize: 256 * 1024,
  });
  const result = await page.evaluate(() =>
    window.ordinaryDraftBrowser.quota(2 * 1024 * 1024),
  );
  expect(result).toEqual([true, false, false]);
});
