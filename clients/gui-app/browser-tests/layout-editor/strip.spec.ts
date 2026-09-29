import { expect, test } from "@playwright/test";

import { fixture, nextFrames } from "../support/fixtures.ts";
import { note, requireRect, viewportOf } from "../support/layout-editor/dom.ts";
import {
  moveInSteps,
  pressAt,
  releasePointer,
} from "../support/layout-editor/input.ts";
import { layoutEditorUse, sharedPage } from "../support/layout-editor/pages.ts";

// THE VERTICAL STRIP'S DRAG TOWARD THE WINDOW EDGE (S-11).
//
// `side-tab-strip.html` mounts the real vertical strip against a real window
// edge. Pulling a row sideways INTO the content past the 24px threshold tears
// it off to a new window, but pulling it toward the WINDOW EDGE must not: the
// pointer is still inside the window, the far band belongs to the strip's own
// drag, and a tear-off there would spawn a window on a gesture that only
// meant to reorder. The preview appears when the pointer leaves the viewport,
// and only then.
//
// What decides the claim is the pointer's position against the real viewport,
// which jsdom has none of.
//
// Not here, because a jsdom test decides it: the reorder along y with a
// neighbour stepping aside, a drop on a row's lower half pairing the two tabs,
// a split dragged whole, and the tear-off into the content
// (`root-dnd-provider-vertical.test.tsx`). One edge is loaded: the right
// strip's gesture is the left one's reflected.

test.use(layoutEditorUse());

const getPage = sharedPage({
  path: `${fixture("side-tab-strip")}?edge=left`,
  ready:
    "window.__sideTabStripProbe?.ready === true && document.querySelectorAll('[data-strip-item-id]').length > 0",
  errorsGlobal: "__sideTabStripErrors",
});

test.beforeEach(async () => {
  const page = getPage();
  await releasePointer(page);
  await page.mouse.move(1, 1);
  await page.evaluate("window.__sideTabStripProbe.reset()");
  await nextFrames(page, 3);
});

test("a row pulled toward the window edge shows no tear-off until the pointer leaves the viewport", async () => {
  const page = getPage();
  const row = await page.evaluate<{
    readonly cx: number;
    readonly cy: number;
  } | null>(`(() => {
    const close = document.querySelector('[data-testid="tab-close-epic-fixture-zeta"]');
    const row = close === null ? null : close.closest("[data-side-tab]");
    if (row === null) return null;
    const r = row.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  })()`);
  expect(row, "no row for Zeta in the strip").not.toBeNull();
  if (row === null) return;
  const far = await requireRect(page, "[data-fixture-far-side]");
  const viewport = await viewportOf(page);
  const requestsBefore = await page.evaluate<readonly string[]>(
    "window.__sideTabStripProbe.detachRequests()",
  );
  // As far toward the window edge as the viewport goes: 4px from it, which is
  // 44px past the band on the far side, beyond the 24px threshold.
  const atMargin = { x: far.x + 4, y: row.cy };
  const outside = { x: -12, y: row.cy };
  expect(
    atMargin.x,
    `the far margin at x=${atMargin.x.toFixed(0)} is not inside the viewport (${String(viewport.width)} wide)`,
  ).toBeGreaterThanOrEqual(0);

  await pressAt(page, row.cx, row.cy);
  await moveInSteps(page, atMargin);
  // Three frames of the preview's own chance to appear: the negative below is
  // only a claim once the drag has had them.
  await nextFrames(page, 3);
  const atMarginPreview = await page.evaluate<boolean>(
    "window.__sideTabStripProbe.tearOffPreview()",
  );
  await moveInSteps(page, outside);
  await expect
    .poll(
      () =>
        page.evaluate<boolean>("window.__sideTabStripProbe.tearOffPreview()"),
      {
        message:
          "window edge: the pointer outside the viewport shows no tear-off preview",
      },
    )
    .toBe(true);
  await releasePointer(page);
  await expect
    .poll(
      async () =>
        (
          await page.evaluate<readonly string[]>(
            "window.__sideTabStripProbe.detachRequests()",
          )
        ).length,
      {
        message:
          "window edge: releasing outside the viewport requested no new window",
      },
    )
    .toBe(requestsBefore.length + 1);
  note(
    `preview at the margin (x=${atMargin.x.toFixed(0)}) ${String(atMarginPreview)}, outside the viewport (x=${String(outside.x)}) true; requests ${JSON.stringify(await page.evaluate("window.__sideTabStripProbe.detachRequests()"))}`,
  );
  expect(
    atMarginPreview,
    "window edge: the pointer between the strip and the window edge already shows the tear-off preview",
  ).toBe(false);
});
