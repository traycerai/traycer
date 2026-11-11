import { expect, test } from "@playwright/test";
import { fixture } from "./support/fixtures";
import { settle } from "./support/chat-scroll-oracle";

test("a missing legacy whole-row anchor falls back to the latest, not row zero", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(
    `${fixture("chat-scroll-model")}?line=windowed&mountLater=1&turns=120&tailBytes=512`,
  );
  await page.waitForFunction(
    () =>
      "__chatScrollProbe" in window &&
      window.__chatScrollProbe.windowState()?.skeletonComplete === true,
  );
  await page.evaluate(() => {
    window.__chatScrollProbe.seedSaved({
      mode: "free-scrolling",
      anchorMessageId: "assistant:retired-turn",
      anchorIndex: 0,
      offset: 0,
    });
    window.__chatScrollProbe.mountNow();
  });
  await page.waitForFunction(
    () => window.__chatScrollProbe.geometry() !== null,
  );
  const view = await settle(page, 20);
  expect(view.mode).toBe("following-end");
  expect(view.fromEnd).toBeLessThanOrEqual(1);
});

test("a legacy row that arrives after mount still restores its exact saved offset", async ({
  page,
}) => {
  // A paused clock holds the fixture's skeleton chunks (300ms apart), so the
  // row cannot arrive before the mount.
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(
    `${fixture("chat-scroll-model")}?line=windowed&mountLater=1&turns=120&skeletonChunkMs=300&tailBytes=512`,
  );
  await page.waitForFunction(() => "__chatScrollProbe" in window);
  await page.evaluate(() => {
    window.__chatScrollProbe.seedSaved({
      mode: "free-scrolling",
      anchorMessageId: "assistant:turn-80",
      anchorIndex: 0,
      offset: -40,
    });
    window.__chatScrollProbe.mountNow();
  });
  await page.waitForFunction(
    () => window.__chatScrollProbe.geometry() !== null,
  );
  await page.clock.runFor(100);
  // Mounted with the row still unindexed and its restore pending.
  expect(
    await page.evaluate(() =>
      window.__chatScrollProbe.ordinalOf("assistant:turn-80"),
    ),
  ).toBeNull();
  expect(
    await page.evaluate(() => window.__chatScrollProbe.pendingRestore()),
  ).not.toBeNull();
  await page.clock.resume();
  await page.waitForFunction(
    () => window.__chatScrollProbe.windowState()?.skeletonComplete === true,
  );
  // Layout lands on fractional pixels; the list's own restore tolerance is 1px.
  await expect
    .poll(async () => {
      const top = await page.evaluate(() =>
        window.__chatScrollProbe.rowTop("assistant:turn-80"),
      );
      return top === null ? Infinity : Math.abs(top + 40);
    })
    .toBeLessThanOrEqual(1);
  const view = await settle(page, 20);
  expect(view.mode).toBe("free-scrolling");
  expect(view.fromEnd).toBeGreaterThan(700);
});
