import { expect, test as base, type Page } from "@playwright/test";
import {
  BASE,
  ROOTS,
  ROW_PITCH,
  SCROLLED_TOP,
  drawn,
  expectClosesGap,
  expectAppearsAtOnce,
  expectFadesInPlace,
  expectHeld,
  expectSlides,
  expectOutAndBack,
  expectSlidesBack,
  expectSnaps,
  expectVanishesAtOnce,
  firstMoveFrame,
  groupHeight,
  halfFadedFrame,
  lastDrawnFrame,
  openTree,
  padded,
  pageErrors,
  placesOf,
  recordChevron,
  recordHide,
  recordScroll,
  recordShape,
  settled,
  startTop,
  type Shape,
} from "./support/chat-tree-motion.ts";

// How the virtualised Agents tree moves its rows (`ChatTreePanelBody` over a
// seeded store, the real list in a real layout). Each test records every
// drawn row's top and opacity on every animation frame across one change and
// asserts the KIND of motion each row makes and where it ends, never a frame's
// value: a slow runner draws fewer frames of the same motion.
//
// The rules are the recursive tree's, which the virtual list keeps:
// - a change that moves rows slides every row whose place changed;
// - a new row appears at once; a row whose node is gone vanishes at once;
// - a row its open group drops while its node stays (a filter, the archive)
//   fades in its slot, then only its own group slides into the slot;
// - scrolling animates nothing.

/**
 * Every case but the scroll runs twice: with the list at the top, and scrolled
 * so that the rows the case is about sit mid-list, between 30 rows above them
 * and 30 below. The expectations are the same either way, relative to the
 * viewport: a change in view moves the rows in view and nothing else.
 */
interface Place {
  readonly name: string;
  readonly scrollTop: number;
  /** The tree the case is about, as this place draws it. */
  readonly tree: (shape: Shape) => Shape;
  /**
   * Whether the rows below a row that faded out (a reparented row's old place,
   * a hidden row) are checked for the glide that closes its gap once it has
   * faded: scrolled, a hidden row's followers are held where they were until
   * the fade ends, then ease up 30 px; a reparented row's followers slide down
   * a row during the fade, then ease back. Base (traycer 2f451d3ee5, recorded
   * 22:19:17Z on the fixture that answers `epic.listTaskHosts` and
   * `epic.listCollaborators`):
   * - reparent: g 272 down to 302 during the fade, then 302, 301.1, 298.6, 293.8, 289.6, 285.6, 281.9, 278.8, 276,
   *   273.9, 272.5, 272; h the same 30 px lower;
   * - hide child: b3 122, 118.9, 114.4, 109.9, 106, 102.3, 99, 96.2, 94.1,
   *   92.6, 92;
   * - hide root: d 182, 180.7, 178.6, 174.4, 169.9, 165.8, 162.3, 159, 156.2,
   *   154.1, 152.6, 152; e to h the same shape.
   * Only the order of the motion and where it ends are asserted: a step's size,
   * and how late the sampler reads it, depend on the frame rate and the load.
   */
  readonly closesGapAfterFade: boolean;
}
const PLACES: readonly Place[] = [
  {
    name: "at the top of the list",
    scrollTop: 0,
    tree: (shape) => shape,
    closesGapAfterFade: false,
  },
  {
    name: "scrolled mid-list",
    scrollTop: SCROLLED_TOP,
    tree: padded,
    closesGapAfterFade: true,
  },
];

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

/** No error the page or the fixture raised. */
async function expectCleanPage(page: Page): Promise<void> {
  expect(await pageErrors(page), "errors in the fixture").toEqual([]);
}

const ABOVE_AN_INSERT = ["a", "b", "b1"];
const BELOW_AN_INSERT = ["b2", "b3", "c", "d", "e", "f", "g", "h"];
const NESTED: Shape = {
  roots: ROOTS,
  children: { b: ["b1", "b2", "b3"], b1: ["b1x", "b1y"] },
  updatedAt: undefined,
};

for (const place of PLACES) {
  const { tree } = place;
  const open = (page: Page, shape: Shape): Promise<void> =>
    openTree(page, tree(shape), place.scrollTop, "a");

  test.describe(`virtual chat tree: row motion ${place.name}`, () => {
    test("a child inserted into an open branch slides the rows below it down one row", async ({
      page,
    }) => {
      await open(page, BASE);
      const recording = await recordShape(
        page,
        tree({ ...BASE, children: { b: ["b1", "bn", "b2", "b3"] } }),
      );
      expectAppearsAtOnce(recording, "bn");
      for (const id of ABOVE_AN_INSERT) expectHeld(recording, id);
      for (const id of BELOW_AN_INSERT) expectSlides(recording, id, ROW_PITCH);
      await expectCleanPage(page);
    });

    test("collapsing a branch drops its children at once and slides the rows below up; expanding it brings them back at once and slides the rows below down", async ({
      page,
    }) => {
      await open(page, BASE);
      const children = ["b1", "b2", "b3"];
      const below = ["c", "d", "e", "f", "g", "h"];
      const collapse = await recordChevron(page, "b");
      for (const id of children) expectVanishesAtOnce(collapse, id);
      for (const id of ["a", "b"]) expectHeld(collapse, id);
      for (const id of below) {
        expectSlides(collapse, id, -groupHeight(children.length));
      }
      await settled(page);
      const expand = await recordChevron(page, "b");
      for (const id of children) expectAppearsAtOnce(expand, id);
      for (const id of ["a", "b"]) expectHeld(expand, id);
      for (const id of below) {
        expectSlides(expand, id, groupHeight(children.length));
      }
      await expectCleanPage(page);
    });

    test("expanding and collapsing a nested branch brings its children in and drops them at once, and slides every row below it", async ({
      page,
    }) => {
      // The nested branch starts collapsed.
      await open(page, NESTED);
      const nested = ["b1x", "b1y"];
      const below = ["b2", "b3", "c", "d", "e", "f", "g", "h"];
      const expand = await recordChevron(page, "b1");
      for (const id of nested) expectAppearsAtOnce(expand, id);
      for (const id of ["a", "b", "b1"]) expectHeld(expand, id);
      for (const id of below) {
        expectSlides(expand, id, groupHeight(nested.length));
      }
      await settled(page);
      const collapse = await recordChevron(page, "b1");
      for (const id of nested) expectVanishesAtOnce(collapse, id);
      for (const id of ["a", "b", "b1"]) expectHeld(collapse, id);
      for (const id of below) {
        expectSlides(collapse, id, -groupHeight(nested.length));
      }
      await expectCleanPage(page);
    });

    test("a row deleted from the store vanishes at once and the rows below slide up", async ({
      page,
    }) => {
      await open(page, BASE);
      const recording = await recordShape(
        page,
        tree({ ...BASE, children: { b: ["b1", "b3"] } }),
      );
      expectVanishesAtOnce(recording, "b2");
      for (const id of ["a", "b", "b1"]) expectHeld(recording, id);
      for (const id of ["b3", "c", "d", "e", "f", "g", "h"]) {
        expectSlides(recording, id, -ROW_PITCH);
      }
      await expectCleanPage(page);
    });

    test("a child its branch hides while its node stays fades in its slot, then only its siblings slide up and the rows outside the branch snap", async ({
      page,
    }) => {
      await open(page, BASE);
      const recording = await recordHide(
        page,
        tree({ ...BASE, children: { b: ["b1", "b3"] } }),
        ["b2"],
      );
      expectFadesInPlace(recording, "b2");
      for (const id of ["a", "b", "b1"]) expectHeld(recording, id);
      // Its sibling slides into the slot, and only after the fade has run.
      expectClosesGap(recording, "b3", -ROW_PITCH, "b2");
      expect(
        firstMoveFrame(recording, "b3"),
        "b3 waits for the fade",
      ).toBeGreaterThan(halfFadedFrame(recording, "b2"));
      if (place.closesGapAfterFade) {
        const start = startTop(recording, "b3");
        expectSlidesBack(recording, "b3", {
          from: start,
          to: start - ROW_PITCH,
          afterFrame: lastDrawnFrame(recording, "b2"),
        });
      }
      // Outside the branch the rows are set down in one step.
      for (const id of ["c", "d", "e", "f", "g", "h"]) {
        expectSnaps(recording, id, -ROW_PITCH);
      }
      await expectCleanPage(page);
    });

    test("a root row the list hides while its node stays fades in its slot, then the roots below it slide up", async ({
      page,
    }) => {
      await open(page, BASE);
      const recording = await recordHide(
        page,
        tree({ ...BASE, roots: ROOTS.filter((id) => id !== "c") }),
        ["c"],
      );
      expectFadesInPlace(recording, "c");
      for (const id of ["a", "b", "b1", "b2", "b3"]) expectHeld(recording, id);
      for (const id of ["d", "e", "f", "g", "h"]) {
        expectClosesGap(recording, id, -ROW_PITCH, "c");
        expect(
          firstMoveFrame(recording, id),
          `${id} waits for the fade`,
        ).toBeGreaterThan(halfFadedFrame(recording, "c"));
        if (place.closesGapAfterFade) {
          const start = startTop(recording, id);
          expectSlidesBack(recording, id, {
            from: start,
            to: start - ROW_PITCH,
            afterFrame: lastDrawnFrame(recording, "c"),
          });
        }
      }
      await expectCleanPage(page);
    });

    test("reparenting a row fades its old place out and puts it in the new one at once, and the moved row never slides", async ({
      page,
    }) => {
      await open(page, BASE);
      const recording = await recordShape(
        page,
        tree({
          roots: ROOTS.filter((id) => id !== "f"),
          children: { b: ["b1", "b2", "b3", "f"] },
          updatedAt: undefined,
        }),
      );
      // Where the row lands: below b3, which has not moved.
      const newPlace = startTop(recording, "b3") + ROW_PITCH;
      const oldPlace = startTop(recording, "f");
      const rows = drawn(recording, "f");
      // One row at the new place, one at the old: the moved row is never drawn
      // on the way from one to the other.
      const arrived = rows.filter((row) => Math.abs(row.top - newPlace) <= 1);
      const leaving = rows.filter((row) => Math.abs(row.top - newPlace) > 1);
      for (const row of leaving) {
        expect(
          row.top,
          `f frame ${String(row.frame)} is between its old and new places`,
        ).toBeGreaterThanOrEqual(oldPlace - 1);
      }
      // The new place is there from the first frame, solid, and never moves.
      expect(arrived[0].frame, "the new place's first frame").toBe(1);
      expect(arrived.length, "the new place stays").toBe(recording.length - 1);
      for (const row of arrived) expect(row.opacity).toBeGreaterThan(0.99);
      // The old place fades out and is gone.
      expect(leaving.length, "the old place fades").toBeGreaterThan(1);
      expect(
        Math.min(...leaving.map((row) => row.opacity)),
      ).toBeLessThanOrEqual(0.05);
      const lastLeaving = leaving[leaving.length - 1].frame;
      expect(lastLeaving, "the old place goes").toBeLessThan(
        recording.length - 1,
      );
      // The rows between the two places make room for the row that arrived.
      for (const id of ["c", "d", "e"]) expectSlides(recording, id, ROW_PITCH);
      for (const id of ["a", "b", "b1", "b2", "b3"]) expectHeld(recording, id);
      if (place.closesGapAfterFade) {
        // The rows after the old place slide down a row while its copy fades
        // out, then glide back up into its slot.
        for (const id of ["g", "h"]) {
          const start = startTop(recording, id);
          expectOutAndBack(recording, id, {
            from: start + ROW_PITCH,
            to: start,
            afterFrame: lastLeaving,
          });
        }
      }
      await expectCleanPage(page);
    });

    test.describe("with reduced motion", () => {
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
      });

      test("an inserted child sets every row below it down at once", async ({
        page,
      }) => {
        await open(page, BASE);
        const recording = await recordShape(
          page,
          tree({ ...BASE, children: { b: ["b1", "bn", "b2", "b3"] } }),
        );
        expectAppearsAtOnce(recording, "bn");
        for (const id of ABOVE_AN_INSERT) expectHeld(recording, id);
        for (const id of BELOW_AN_INSERT) expectSnaps(recording, id, ROW_PITCH);
        await expectCleanPage(page);
      });

      test("a hidden child vanishes at once, with no fade, and the rows below it are set down at once", async ({
        page,
      }) => {
        await open(page, BASE);
        const recording = await recordHide(
          page,
          tree({ ...BASE, children: { b: ["b1", "b3"] } }),
          ["b2"],
        );
        expectVanishesAtOnce(recording, "b2");
        for (const id of ["a", "b", "b1"]) expectHeld(recording, id);
        for (const id of ["b3", "c", "d", "e", "f", "g", "h"]) {
          expectSnaps(recording, id, -ROW_PITCH);
        }
        await expectCleanPage(page);
      });
    });
  });
}

test("scrolling an 80-row list animates nothing: no row is drawn at more than two tops, none is faint, and a row scrolling in is drawn at once", async ({
  page,
}) => {
  const roots = Array.from({ length: 80 }, (_, i) => `r${String(i)}`);
  const shape: Shape = {
    roots: ["a", ...roots],
    children: {},
    updatedAt: undefined,
  };
  await openTree(page, shape, 0, "a");
  const recording = await recordScroll(page, 900);
  const ids = [
    ...new Set(
      recording.flatMap((rows) =>
        rows.filter((r) => !r.id.startsWith("rail:")).map((r) => r.id),
      ),
    ),
  ];
  // The list did scroll: the first row left, and rows came in at the end.
  expect(drawn(recording, "a").at(-1)?.top ?? 0).toBeLessThan(0);
  const arrivals = ids.filter((id) => drawn(recording, id)[0].frame > 0);
  expect(arrivals.length, "rows scrolled into the window").toBeGreaterThan(0);
  for (const id of ids) {
    expect(placesOf(recording, id), `${id}'s tops`).toBeLessThanOrEqual(2);
    for (const row of drawn(recording, id)) {
      expect(row.opacity, `${id} frame ${String(row.frame)}`).toBeGreaterThan(
        0.99,
      );
    }
  }
  await expectCleanPage(page);
});
