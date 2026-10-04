import { expect, test, type Page } from "@playwright/test";
import { centreOf, fixture, nextFrames, type Point } from "./support/fixtures";

/**
 * The sidebar stack's drag gestures (L-166, L-181) on the real rail and the
 * real body, with real mouse input. The fixture seeds a stack of four -
 * Agents, Artifacts, Sharing, Git Diff - with every other panel standing alone.
 */
const STACK = fixture("left-panel-stack");

test.describe.configure({ mode: "default" });

async function open(page: Page): Promise<void> {
  await page.goto(STACK);
  await page.waitForFunction("window.__leftPanelStackProbe?.ready === true");
  await nextFrames(page, 4);
}

function readRail(page: Page): Promise<unknown> {
  return page.evaluate("window.__leftPanelStackProbe.rail()");
}

/** A real press on `from` and a drag to `to`, which leaves the button down. */
async function dragTo(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await nextFrames(page, 2);
}

function sectionHeader(page: Page, panelId: string, title: string) {
  return page
    .getByTestId(`epic-left-panel-section-${panelId}`)
    .getByRole("button", { name: title, exact: true });
}

test("stacks a fifth panel dragged off the rail onto the open body", async ({
  page,
}) => {
  await open(page);
  const terminals = await centreOf(
    page.getByRole("button", { name: "Terminals", exact: true }),
  );
  const body = await centreOf(
    page.getByTestId("epic-left-panel-section-sharing"),
  );
  await dragTo(page, terminals, body);
  await expect(page.locator("[data-body-drop-cue]")).toHaveAttribute(
    "data-body-drop-cue",
    "join",
  );
  await page.mouse.up();
  await expect
    .poll(() => readRail(page))
    .toEqual([
      "railAgents",
      [
        "railAgents",
        "railArtifacts",
        "railSharing",
        "railGitDiff",
        "railTerminals",
      ],
      "railArtifacts",
      "railSharing",
      "railGitDiff",
      "railTerminals",
      "railBrowsers",
      "railPullRequests",
      "railFileTree",
      "railComments",
    ]);
  await expect(
    page.getByTestId("epic-left-panel-section-terminals"),
  ).toBeVisible();
});

test("reorders a stacked section dropped by its header past the next section", async ({
  page,
}) => {
  await open(page);
  const artifacts = await centreOf(
    sectionHeader(page, "artifacts", "Artifacts"),
  );
  const sharing = await page
    .getByTestId("epic-left-panel-section-sharing")
    .boundingBox();
  if (sharing === null) throw new Error("no layout for the Sharing section");
  await dragTo(page, artifacts, {
    x: artifacts.x,
    y: Math.round(sharing.y + sharing.height * 0.75),
  });
  // The landing slot, between Sharing and Git Diff, is drawn on the top edge
  // of the section it lands before.
  await expect(
    page
      .getByTestId("epic-left-panel-section-git-diff")
      .locator("[data-section-drop-position]"),
  ).toHaveAttribute("data-section-drop-position", "before");
  await page.mouse.up();
  await expect
    .poll(() => readRail(page))
    .toEqual([
      "railAgents",
      ["railAgents", "railSharing", "railArtifacts", "railGitDiff"],
      "railSharing",
      "railArtifacts",
      "railGitDiff",
      "railTerminals",
      "railBrowsers",
      "railPullRequests",
      "railFileTree",
      "railComments",
    ]);
});

test("takes a stacked section out to the rail when its header is dropped there", async ({
  page,
}) => {
  await open(page);
  const sharing = await centreOf(sectionHeader(page, "sharing", "Sharing"));
  const fileTree = await page
    .getByRole("button", { name: "File Tree", exact: true })
    .boundingBox();
  if (fileTree === null) throw new Error("no layout for the File Tree icon");
  await dragTo(page, sharing, {
    x: Math.round(fileTree.x + fileTree.width * 0.9),
    y: Math.round(fileTree.y + fileTree.height / 2),
  });
  await page.mouse.up();
  await expect
    .poll(() => readRail(page))
    .toEqual([
      "railAgents",
      ["railAgents", "railArtifacts", "railGitDiff"],
      "railArtifacts",
      "railGitDiff",
      "railTerminals",
      "railBrowsers",
      "railPullRequests",
      "railFileTree",
      "railSharing",
      "railComments",
    ]);
  await expect(page.getByTestId("epic-left-panel-section-sharing")).toHaveCount(
    0,
  );
});
