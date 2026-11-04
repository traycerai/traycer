import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// Every row of a bot's channel or thread that a turn wrote shows that turn's
// receipt at rest, under its text: a reply, an announcement, the post a
// thread opens on and a reply in the thread, with no hover or focus. A row no
// turn wrote shows none. Whether the line is painted is the cascade's call
// (an opacity or a hover variant on the line), which jsdom does not compute:
// this reads the rendered rows of the production presentation, with the
// pointer parked off every row.

const RECEIPT = '[data-testid="bot-turn-receipt"]';

test.use({ viewport: { width: 1280, height: 900 } });

function botRow(scope: Locator, text: string): Locator {
  return scope
    .locator('[data-testid="bot-reply-row"], [data-testid="bot-announcement"]')
    .filter({ hasText: text });
}

async function openAtRest(page: Page): Promise<void> {
  await page.goto(fixture("bot-row-receipts"));
  await expect(page.getByTestId("fixture-thread")).toBeVisible();
  // Park the pointer off every row, so nothing is hovered.
  await page.mouse.move(1270, 890);
}

async function expectShownAtRest(row: Locator, text: RegExp): Promise<void> {
  const receipt = row.locator(RECEIPT);
  await expect(receipt).toBeVisible();
  await expect(receipt).toHaveText(text);
  await expect(receipt).toHaveCSS("opacity", "1");
}

test("a reply, a check-in announcement and a running reply show their turn's receipt at rest", async ({
  page,
}) => {
  await openAtRest(page);
  const channel = page.getByTestId("fixture-channel");

  await expectShownAtRest(
    botRow(channel, "Windows signing step"),
    /^Thought for 4s, read 3 files · /,
  );
  await expectShownAtRest(
    botRow(channel, "Check-in: the release branch"),
    /^Ran 2 commands, read 1 file · /,
  );
  await expectShownAtRest(botRow(channel, "flaky host test"), /^1m \d+s$/);
});

test("an announcement the host posted itself shows no receipt", async ({
  page,
}) => {
  await openAtRest(page);
  const channel = page.getByTestId("fixture-channel");
  await expect(channel.locator(RECEIPT).first()).toBeVisible();

  const created = botRow(channel, "Tracy is set up in this channel");
  await expect(created).toBeVisible();
  await expect(created.locator(RECEIPT)).toHaveCount(0);
});

test("the post a thread opens on and a reply in the thread show their turn's receipt at rest", async ({
  page,
}) => {
  await openAtRest(page);
  const thread = page.getByTestId("fixture-thread");

  await expectShownAtRest(
    page.getByTestId("bot-thread-anchor"),
    /^Thought for 6s, edited 2 files · /,
  );
  await expectShownAtRest(
    botRow(thread, "the schedule now reads 02:00"),
    /^Read 4 files · /,
  );
});
