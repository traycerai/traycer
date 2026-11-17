import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";
import {
  expectSteadyFrames,
  groupFramesSince,
  recordGroupFrames,
} from "./support/music-group-frames.ts";

// A Tracy tab opened cold has one group of music controls on every frame
// from its first commit to its channel's header: in the title row it reserves
// while the surface's code loads and while each wait on the way to the
// channel is open, never in a row of its own, and with the group and what sits
// under it where they stay. The page is the real tab host over a fake host;
// the surface's module is the real lazy one, held at its request, and each
// later wait is held by the page until the test releases it.

test.use({
  viewport: { width: 1280, height: 800 },
  hasTouch: false,
  isMobile: false,
});

declare global {
  interface Window {
    __coldOpenProbe?: {
      readonly release: (
        gate: "hostMethods" | "drafts" | "lists" | "open" | "snapshot",
      ) => void;
    };
  }
}

const OPENING_HEADER = "bot-channel-opening-header";

async function release(
  page: Page,
  gate: "hostMethods" | "drafts" | "lists" | "open" | "snapshot",
): Promise<void> {
  await page.evaluate((name) => window.__coldOpenProbe?.release(name), gate);
}

test("a cold open draws one group in the reserved title row through every wait, and nothing under it moves", async ({
  page,
}) => {
  let moduleRequests = 0;
  let releaseModule: () => void = () => undefined;
  const moduleHeld = new Promise<void>((resolve) => {
    releaseModule = resolve;
  });
  await page.route("**/bot-tab-surface*", async (route) => {
    moduleRequests += 1;
    await moduleHeld;
    await route.continue();
  });
  await recordGroupFrames(page);
  await page.goto(
    `${fixture("tracy-tab-cold-open")}?form=desktop&music=long&hostMethods=held&snapshot=held`,
  );
  await page.waitForFunction(() => window.__coldOpenProbe !== undefined);
  const opening = page.getByTestId(OPENING_HEADER);
  const group = opening.getByRole("group", { name: "Music playback" });

  // The surface's code is still on its way.
  await expect.poll(() => moduleRequests).toBeGreaterThan(0);
  await expect(group).toHaveCount(1);
  await expect(page.getByTestId("bot-tab")).toHaveCount(0);

  const waits: ReadonlyArray<() => Promise<void>> = [
    () => {
      releaseModule();
      return Promise.resolve();
    },
    () => release(page, "hostMethods"),
    () => release(page, "drafts"),
    () => release(page, "lists"),
    () => release(page, "open"),
  ];
  for (const released of waits) {
    await released();
    await nextFrames(page, 3);
    await expect(opening).toBeVisible();
    await expect(page.getByTestId("bot-channel-header")).toHaveCount(0);
    await expect(group).toHaveCount(1);
  }

  await release(page, "snapshot");
  await expect(page.getByTestId("bot-channel-header")).toBeVisible();
  await expect(opening).toHaveCount(0);
  await nextFrames(page, 3);

  const frames = await groupFramesSince(page, 0);
  test.info().annotations.push({
    type: "frames",
    description: `${String(frames.length)} frames after the first commit; placements ${[
      ...new Set(frames.map((frame) => frame.placement)),
    ].join(", ")}`,
  });
  expect(frames.some((frame) => frame.placement === "reserved")).toBe(true);
  expect(frames.at(-1)?.placement).toBe("header");
  expectSteadyFrames(frames);
});
