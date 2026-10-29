import { expect, test } from "@playwright/test";
import { fixture, wheelsDelivered } from "./support/fixtures.ts";

declare global {
  interface Window {
    __windowedEditScrollProbe: {
      setPhase: (phase: "initial" | "reindexed" | "hydrated") => void;
      issueEndRequest: () => Promise<void>;
      scrollToEditedRow: () => Promise<void>;
      snapshot: () => {
        phase: string;
        scrollTop: number | null;
        scrollHeight: number | null;
        clientHeight: number | null;
        visibleMessageIds: (string | null)[];
      };
    };
  }
}

test("an end request follows the replacement across a windowed reindex", async ({
  page,
}) => {
  await page.goto(fixture("windowed-edit-scroll"));
  await expect(page.getByTestId("chat-messages-scroll")).toBeVisible();
  const scroller = page.getByTestId("chat-messages-scroll");
  const box = await scroller.boundingBox();
  if (box === null) throw new Error("scroll box missing");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await wheelsDelivered(page, [{ deltaX: 0, deltaY: -30000 }], 0);
  // Tall hydrated replies make the list's first long jump estimate imprecise.
  // Reissue until the reader is actually looking at the message to edit.
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.evaluate(() =>
      window.__windowedEditScrollProbe.scrollToEditedRow(),
    );
    if (
      (
        await page.evaluate(
          () => window.__windowedEditScrollProbe.snapshot().visibleMessageIds,
        )
      ).includes("message-584")
    )
      break;
  }
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__windowedEditScrollProbe.snapshot().visibleMessageIds,
      ),
    )
    .toContain("message-584");
  const before = await page.evaluate(() =>
    window.__windowedEditScrollProbe.snapshot(),
  );
  if (before.scrollHeight === null)
    throw new Error("initial scroll height missing");
  await page.evaluate(() => window.__windowedEditScrollProbe.issueEndRequest());
  await page.evaluate(() =>
    window.__windowedEditScrollProbe.setPhase("reindexed"),
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.__windowedEditScrollProbe.snapshot().phase),
    )
    .toBe("reindexed");
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__windowedEditScrollProbe.snapshot().scrollHeight,
      ),
    )
    .not.toBe(before.scrollHeight);
  await page.evaluate(() =>
    window.__windowedEditScrollProbe.setPhase("hydrated"),
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.__windowedEditScrollProbe.snapshot().phase),
    )
    .toBe("hydrated");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const position = window.__windowedEditScrollProbe.snapshot();
        if (
          position.scrollHeight === null ||
          position.clientHeight === null ||
          position.scrollTop === null
        )
          return Number.POSITIVE_INFINITY;
        return (
          position.scrollHeight - position.clientHeight - position.scrollTop
        );
      }),
    )
    .toBeLessThan(2);
  const after = await page.evaluate(() =>
    window.__windowedEditScrollProbe.snapshot(),
  );
  expect(after.visibleMessageIds, JSON.stringify({ before, after })).toContain(
    "edited-message",
  );
});
