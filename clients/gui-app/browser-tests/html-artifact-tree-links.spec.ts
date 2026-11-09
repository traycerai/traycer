import { expect, test, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// A link on an artifact's page to another artifact in the tree is reported to
// the app only when the reader clicks it: the app opens the target with no
// confirm, so a click that page script makes (`a.click()`) must not count.
// Whether a click is trusted is something only a real browser decides.

test.use({ viewport: { width: 900, height: 700 }, actionTimeout: 10_000 });

const FRAME_TITLE = "Tree links page";
const PAGE_PATH = "a/b/index.html";
// The address the frame served the page from; the mount id is per run.
const PAGE_URL = expect.stringMatching(/\/a\/b\/index\.html$/u);

interface LinkRecord {
  readonly href: string;
  readonly pagePath: string;
}
interface ProbeWindow extends Window {
  __treeLinks?: {
    readonly links: LinkRecord[];
    readonly serve: (url: string) => Promise<{
      readonly status: number;
      readonly mediaType: string;
      readonly base64: string;
    }>;
  };
}

const pageFrame = (page: Page) =>
  page.frameLocator(`iframe[title="${FRAME_TITLE}"]`);

const reported = (page: Page) =>
  page.evaluate(() => (window as ProbeWindow).__treeLinks?.links.slice() ?? []);

test.beforeEach(async ({ page }) => {
  await page.route(
    /^https:\/\/artifact-[^/]+\.traycer-artifact\.invalid\//,
    async (route) => {
      const served = await page.evaluate(
        (url) => (window as ProbeWindow).__treeLinks?.serve(url),
        route.request().url(),
      );
      if (served === undefined) {
        await route.abort();
        return;
      }
      await route.fulfill({
        status: served.status,
        contentType: served.mediaType,
        body: Buffer.from(served.base64, "base64"),
      });
    },
  );
  await page.goto(fixture("html-artifact-tree-links"));
  await expect(
    pageFrame(page).getByRole("heading", { name: "Tree links page" }),
  ).toBeVisible();
});

test("a mouse click on a link to another artifact reports it and leaves the frame on its page", async ({
  page,
}) => {
  await pageFrame(page).locator("#sibling").click();

  await expect
    .poll(() => reported(page))
    .toEqual([
      { href: "../sibling/index.html", pagePath: PAGE_PATH, pageUrl: PAGE_URL },
    ]);
  await expect(
    pageFrame(page).getByRole("heading", { name: "Tree links page" }),
  ).toBeVisible();
});

test("Enter on a focused link to another artifact reports it", async ({
  page,
}) => {
  await pageFrame(page).locator("#top").focus();
  await page.keyboard.press("Enter");

  await expect
    .poll(() => reported(page))
    .toEqual([{ href: "../../top/", pagePath: PAGE_PATH, pageUrl: PAGE_URL }]);
});

test("a click the page's own script makes on a link reports nothing", async ({
  page,
}) => {
  await pageFrame(page)
    .locator("#sibling")
    .evaluate((anchor: HTMLAnchorElement) => anchor.click());
  // The reader's click on the other link is the positive event: once it is
  // reported, the scripted click before it has had every chance to be.
  await pageFrame(page).locator("#top").click();

  await expect
    .poll(() => reported(page))
    .toEqual([{ href: "../../top/", pagePath: PAGE_PATH, pageUrl: PAGE_URL }]);
});

test("a click on a link back to the same page reports nothing", async ({
  page,
}) => {
  await pageFrame(page).locator("#self").click();
  // The other link, reported, proves the first click has been handled.
  await pageFrame(page).locator("#sibling").click();

  await expect
    .poll(() => reported(page))
    .toEqual([
      { href: "../sibling/index.html", pagePath: PAGE_PATH, pageUrl: PAGE_URL },
    ]);
});
