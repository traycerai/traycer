import { expect, test } from "@playwright/test";
import { fixture, nextFrames } from "./support/fixtures.ts";

declare global {
  interface Window {
    __workingRowTailProbe: {
      setPhase: (phase: "unnamed" | "named-past-row-count") => void;
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

  await page.evaluate(() =>
    window.__workingRowTailProbe.setPhase("named-past-row-count"),
  );
  await expect(page.getByText("Phase: named-past-row-count")).toBeVisible();
  await nextFrames(page, 3);

  await expect(indicator).toBeVisible();
  const after = await indicator.boundingBox();
  if (after === null) throw new Error("working row has no box after");
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
});
