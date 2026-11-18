import { expect, test } from "@playwright/test";
import { fixture, nextFrames } from "./support/fixtures.ts";

declare global {
  interface Window {
    __workingRowTailProbe: {
      setPhase: (phase: "unnamed" | "named-past-row-count") => void;
    };
    __workingRowTailSamples: {
      samples: Array<{ y: number; height: number } | null>;
      stop: () => void;
    };
  }
}

test("the working row stays drawn and in place when the skeleton names it past rowCount", async ({
  page,
}) => {
  await page.goto(fixture("windowed-working-row-tail"));
  const indicator = page.getByTestId("assistant-run-indicator");
  await expect(indicator).toBeVisible();
  await nextFrames(page, 3);
  const before = await indicator.boundingBox();
  if (before === null) throw new Error("working row has no box before");

  // Sampled every frame from before the phase change: a row that drops out
  // for one frame and comes back would pass the end-state checks alone.
  await page.evaluate(() => {
    const samples: Array<{ y: number; height: number } | null> = [];
    let running = true;
    const sample = (): void => {
      const box = document
        .querySelector('[data-testid="assistant-run-indicator"]')
        ?.getBoundingClientRect();
      samples.push(box === undefined ? null : { y: box.y, height: box.height });
      if (running) requestAnimationFrame(sample);
    };
    window.__workingRowTailSamples = {
      samples,
      stop: () => {
        running = false;
      },
    };
    requestAnimationFrame(sample);
    window.__workingRowTailProbe.setPhase("named-past-row-count");
  });
  await expect(page.getByText("Phase: named-past-row-count")).toBeVisible();
  await nextFrames(page, 3);
  const samples = await page.evaluate(() => {
    window.__workingRowTailSamples.stop();
    return window.__workingRowTailSamples.samples;
  });
  expect(samples.length).toBeGreaterThan(0);
  for (const sampled of samples) {
    expect(sampled).not.toBeNull();
    if (sampled === null) continue;
    expect(Math.abs(sampled.y - before.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(sampled.height - before.height)).toBeLessThanOrEqual(1);
  }

  await expect(indicator).toBeVisible();
  const after = await indicator.boundingBox();
  if (after === null) throw new Error("working row has no box after");
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
});
