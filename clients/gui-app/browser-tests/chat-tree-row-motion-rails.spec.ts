import { expect, test as base, type Page } from "@playwright/test";
import {
  BASE,
  ROOTS,
  ROW_PITCH,
  expectAppearsAtOnce,
  expectFadesInPlace,
  expectHeld,
  expectRailFadesWithOwner,
  expectRailFollowsOwner,
  expectRailHolds,
  expectRailSolid,
  expectRailSteps,
  expectSlides,
  halfFadedFrame,
  openTree,
  pageErrors,
  railPlaces,
  recordHide,
  recordShape,
} from "./support/chat-tree-motion.ts";

// The indent rail of an open group: one line down the group's left edge, drawn
// by the list beside the rows. It belongs to the row that owns the group, and
// moves as that row does: it slides when the owner slides, fades when the owner
// fades, and its length is set at once. A child fading alone leaves it solid.

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

/** The branch `b`, open, with its three children. */
const OWNER = "b";
const CHILDREN = ["b1", "b2", "b3"];

async function expectCleanPage(page: Page): Promise<void> {
  expect(await pageErrors(page), "errors in the fixture").toEqual([]);
}

test.describe("virtual chat tree: the indent rail of an open group", () => {
  test.beforeEach(async ({ page }) => {
    await openTree(page, BASE, 0, "a");
  });

  test("slides with its owner row when a root is inserted above it, and keeps its length", async ({
    page,
  }) => {
    // `a0` sorts between `a` and `b`.
    const recording = await recordShape(page, {
      ...BASE,
      roots: [...ROOTS, "a0"],
    });
    expectAppearsAtOnce(recording, "a0");
    expectSlides(recording, OWNER, ROW_PITCH);
    expectRailFollowsOwner(recording, OWNER);
    expect(
      railPlaces(recording, OWNER, "top"),
      "the rail is drawn on the way: it slides, it does not jump",
    ).toBeGreaterThanOrEqual(3);
    await expectCleanPage(page);
  });

  test("fades in place with its owner row and the children when the owner is hidden while its node stays", async ({
    page,
  }) => {
    const recording = await recordHide(
      page,
      { ...BASE, roots: ROOTS.filter((id) => id !== OWNER) },
      [OWNER, ...CHILDREN],
    );
    expectFadesInPlace(recording, OWNER);
    for (const id of CHILDREN) expectFadesInPlace(recording, id);
    expectRailFadesWithOwner(recording, OWNER);
    await expectCleanPage(page);
  });

  test("stays solid when one child is hidden, and its end rises in one step as the sibling below slides up", async ({
    page,
  }) => {
    const recording = await recordHide(
      page,
      { ...BASE, children: { b: ["b1", "b3"] } },
      ["b2"],
    );
    expectFadesInPlace(recording, "b2");
    expectRailSolid(recording, OWNER);
    expectRailHolds(recording, OWNER, "top");
    const { stepFrame } = expectRailSteps(
      recording,
      OWNER,
      "bottom",
      -ROW_PITCH,
    );
    // After the fade, with the sibling that slides into the slot.
    expect(stepFrame, "the rail's end waits for the fade").toBeGreaterThan(
      halfFadedFrame(recording, "b2"),
    );
    expectSlides(recording, "b3", -ROW_PITCH);
    for (const id of ["a", OWNER, "b1"]) expectHeld(recording, id);
    await expectCleanPage(page);
  });

  test("keeps its top and takes its new length at once when a child is inserted into the group", async ({
    page,
  }) => {
    const recording = await recordShape(page, {
      ...BASE,
      children: { b: ["b1", "bn", "b2", "b3"] },
    });
    expectAppearsAtOnce(recording, "bn");
    expectRailHolds(recording, OWNER, "top");
    const { stepFrame } = expectRailSteps(
      recording,
      OWNER,
      "bottom",
      ROW_PITCH,
    );
    expect(stepFrame, "the rail's end is there on the first frame").toBe(1);
    await expectCleanPage(page);
  });
});
