import { expect, test, type Locator } from "@playwright/test";
import { fixture, nextFrames } from "./support/fixtures.ts";

// A team's bot in the command palette shows its team beside its name. A
// team's name has no length bound, so on a phone-width palette the team must
// give way: it truncates within the row, and the bot's own name stays whole.
// Which box gives way under a real flex layout is what jsdom cannot decide.
// The fixture (`command-palette-bot-hint.html`) is the production palette
// shell over the production Tracy source.

test.use({ viewport: { width: 360, height: 720 } });

interface Box {
  readonly left: number;
  readonly right: number;
  /** Its text is wider than the box shows. */
  readonly clipped: boolean;
}

function measure(locator: Locator): Promise<Box> {
  return locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      clipped: node.scrollWidth > node.clientWidth,
    };
  });
}

test("a long team name truncates beside the bot's name, which stays whole", async ({
  page,
}) => {
  await page.goto(fixture("command-palette-bot-hint"));
  const row = page.getByRole("option", { name: /^Triage/ });
  await expect(row).toBeVisible();
  await nextFrames(page, 2);

  const rowBox = await measure(row);
  const name = await measure(row.getByText("Triage", { exact: true }));
  const team = await measure(row.getByText(/developer experience guild/));

  // The team gives way, cut short inside the row; the name keeps its room.
  expect(team.clipped).toBe(true);
  expect(name.clipped).toBe(false);
  expect(name.right).toBeLessThanOrEqual(team.left);
  expect(team.right).toBeLessThanOrEqual(rowBox.right);
});
