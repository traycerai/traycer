import { expect, test as base, type Page } from "@playwright/test";
import {
  drawn,
  expectHeld,
  openTree,
  pageErrors,
  recordShape,
  rowsInView,
  viewOf,
  type Recording,
  type Shape,
} from "./support/chat-tree-motion.ts";

// A change ABOVE the viewport, with the list scrolled mid-way, leaves every
// row in view where it is: the list moves the scroll by what the change added
// above, so what the reader is looking at does not move. Rows in view must be
// held on every frame, not slid back from where they were drawn.

const test = base.extend<{ pageErrorLog: string[] }>({
  pageErrorLog: [
    async ({ page }, use) => {
      const log: string[] = [];
      page.on("pageerror", (error) => {
        log.push(error.stack ?? error.message);
      });
      await use(log);
      expect(log, "uncaught page errors").toEqual([]);
    },
    { auto: true },
  ],
});

const ROOT_COUNT = 90;
/** Thirty rows down: row 30 is the first in view. */
const SCROLL_TOP = 900;
const FIRST_IN_VIEW = "r30";
/** Fewer than this in view means the case is not looking at a list. */
const LEAST_IN_VIEW = 8;
const ROOTS: readonly string[] = Array.from(
  { length: ROOT_COUNT },
  (_, i) => `r${String(i).padStart(2, "0")}`,
);
const LIST: Shape = { roots: ROOTS, children: {}, updatedAt: undefined };

/** Every row that was in view before the change stays where it was, in every frame. */
async function expectViewHeld(page: Page, recording: Recording): Promise<void> {
  const inView = rowsInView(recording, await viewOf(page));
  expect(inView.length, "rows in view").toBeGreaterThanOrEqual(LEAST_IN_VIEW);
  for (const id of inView) {
    expect(drawn(recording, id).length, `${id} is drawn on every frame`).toBe(
      recording.length,
    );
    expectHeld(recording, id);
  }
  expect(await pageErrors(page), "errors in the fixture").toEqual([]);
}

test.describe("virtual chat tree: a change above the viewport", () => {
  test("a root inserted above the viewport leaves every row in view where it is", async ({
    page,
  }) => {
    await openTree(page, LIST, SCROLL_TOP, FIRST_IN_VIEW);
    // `a00` sorts before every `r..`: it lands above the viewport.
    const recording = await recordShape(page, {
      ...LIST,
      roots: ["a00", ...ROOTS],
    });
    await expectViewHeld(page, recording);
  });

  test("a root re-sorted from below the viewport to above it leaves every row in view where it is", async ({
    page,
  }) => {
    await openTree(page, LIST, SCROLL_TOP, FIRST_IN_VIEW);
    // Newer than every other root, so it sorts first: from row 85, below the
    // viewport, to row 0, above it.
    const recording = await recordShape(page, {
      ...LIST,
      updatedAt: { r85: 5 },
    });
    await expectViewHeld(page, recording);
  });
});
