import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// Browser regressions for canvas Play and fullscreen: claims jsdom cannot
// decide because they depend on the SAME iframe document surviving a DOM
// move (fullscreen's manual top-layer popover promotes the existing canvas
// in place) and on real wheel/paint behaviour (ctrl-wheel zoom, Fit/Fill
// width). Store rules and the toolbar's own button wiring stay in Vitest
// (`components/canvas-artifact/__tests__/`); this file only proves what a
// real browser session shows.

test.use({ viewport: { width: 1400, height: 900 }, actionTimeout: 10_000 });

interface PlayProbe {
  readonly ready: boolean;
  readonly serve: (url: string) => Promise<{
    readonly status: number;
    readonly mediaType: string;
    readonly base64: string;
  }>;
}
interface ProbeWindow extends Window {
  __playProbe?: PlayProbe;
}

function board(page: Page, title: string) {
  return page.frameLocator(`iframe[title="${title}"]`);
}

function canvasSurface(page: Page) {
  return page.getByRole("application", { name: "Canvas", exact: true });
}

async function tokenOf(page: Page, title: string): Promise<string> {
  return board(page, title).locator('[data-tid="token"]').innerText();
}

/** Boards come from an address no network answers; the page serves them. */
async function serveBoardsFromPage(page: Page): Promise<void> {
  await page.route(
    /^https:\/\/artifact-[^/]+\.traycer-artifact\.invalid\//,
    async (route) => {
      const served = await page.evaluate(
        (url) => (window as ProbeWindow).__playProbe?.serve(url),
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
}

async function open(page: Page): Promise<void> {
  await serveBoardsFromPage(page);
  await page.goto(fixture("canvas-play"));
  await page.waitForFunction(
    () => (window as ProbeWindow).__playProbe?.ready === true,
  );
  // The positive event: both boards' pages are drawn.
  await expect(board(page, "A").locator('[data-tid="name"]')).toHaveText("A");
  await expect(board(page, "B").locator('[data-tid="name"]')).toHaveText("B");
}

test.describe("fullscreen keeps the same running board", () => {
  test("entering and leaving fullscreen never reloads the board", async ({
    page,
  }) => {
    await open(page);
    const before = await tokenOf(page, "A");

    await page.getByRole("button", { name: "Play A fullscreen" }).click();
    await expect(canvasSurface(page)).toHaveAttribute(
      "data-canvas-fullscreen",
      "true",
    );
    expect(await tokenOf(page, "A")).toBe(before);

    await page.getByRole("button", { name: "Back to canvas" }).click();
    await expect(canvasSurface(page)).not.toHaveAttribute(
      "data-canvas-fullscreen",
      "true",
    );
    expect(await tokenOf(page, "A")).toBe(before);
  });

  test("switching the fullscreen board keeps both boards' own documents running", async ({
    page,
  }) => {
    await open(page);
    const tokenA = await tokenOf(page, "A");
    const tokenB = await tokenOf(page, "B");

    await page.getByRole("button", { name: "Play A fullscreen" }).click();
    await page.getByRole("button", { name: "Choose board" }).click();
    await page.getByRole("menuitem", { name: "B" }).click();

    await expect(board(page, "B").locator('[data-tid="name"]')).toHaveText("B");
    expect(await tokenOf(page, "B")).toBe(tokenB);
    // A kept running in the background the whole time, off screen.
    expect(await tokenOf(page, "A")).toBe(tokenA);

    await page.getByRole("button", { name: "Back to canvas" }).click();
    expect(await tokenOf(page, "A")).toBe(tokenA);
    expect(await tokenOf(page, "B")).toBe(tokenB);
  });
});

test.describe("global Play vs. editing", () => {
  test("Play from one board's button makes every board interactive, with no editing chrome", async ({
    page,
  }) => {
    await open(page);

    await page.getByRole("button", { name: "Play A on canvas" }).click();

    // The way back replaces the per-board Play buttons; there is no longer
    // one specifically for "A" or "B" because play is a canvas-wide mode.
    await expect(
      page.getByRole("button", { name: "Playing · Back to editing" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Play A on canvas" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Play B on canvas" }),
    ).toHaveCount(0);
    // The edit toolbar (tools, pages) is gone while playing.
    await expect(
      page.getByRole("toolbar", { name: "Canvas tools" }),
    ).toHaveCount(0);

    await page
      .getByRole("button", { name: "Playing · Back to editing" })
      .click();
    await expect(
      page.getByRole("toolbar", { name: "Canvas tools" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Play A on canvas" }),
    ).toBeVisible();
  });
});

test.describe("fullscreen sizing", () => {
  test("Fit and Fill width change the board's measured width differently", async ({
    page,
  }) => {
    await open(page);
    await page.getByRole("button", { name: "Play A fullscreen" }).click();

    await page.getByRole("button", { name: "Fit" }).click();
    await nextFrames(page, 2);
    const fitBox = await page.locator('iframe[title="A"]').boundingBox();
    if (fitBox === null) throw new Error("the fullscreen board has no box");

    await page.getByRole("button", { name: "Fill width" }).click();
    await nextFrames(page, 2);
    const fillBox = await page.locator('iframe[title="A"]').boundingBox();
    if (fillBox === null) throw new Error("the fullscreen board has no box");

    // Fill stretches the board to the viewport's width; Fit keeps its own
    // aspect ratio, which here is narrower than the 1400px viewport.
    expect(fillBox.width).toBeGreaterThan(fitBox.width);
  });
});

/** `matrix(scaleX, 0, 0, scaleY, translateX, translateY)`, xyflow's own shape. */
function readViewportTransform(matrix: string): {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
} {
  const numbers = matrix
    .replace(/^matrix\(|\)$/g, "")
    .split(",")
    .map((value) => Number.parseFloat(value));
  const [scale, , , , x, y] = numbers;
  return { scale, x, y };
}

function viewportTransform(page: Page) {
  return page
    .locator(".react-flow__viewport")
    .evaluate((el) => getComputedStyle(el).transform);
}

/**
 * Resolves once `centerBoard`'s 200ms move has actually landed the board at
 * the stage's centre - the real target of that animation - rather than
 * inferring "done" from the transform going quiet between two samples, which
 * a sample pair taken before the animation starts can satisfy just as well
 * as one taken after it ends.
 */
async function waitForBoardCentred(page: Page, title: string): Promise<void> {
  const stage = page.getByRole("application", { name: "Canvas workspace" });
  const iframe = page.locator(`iframe[title="${title}"]`);
  await expect(async () => {
    const stageBox = await stage.boundingBox();
    const iframeBox = await iframe.boundingBox();
    if (stageBox === null || iframeBox === null)
      throw new Error("the stage or the board has no box yet");
    const stageCentre = {
      x: stageBox.x + stageBox.width / 2,
      y: stageBox.y + stageBox.height / 2,
    };
    const iframeCentre = {
      x: iframeBox.x + iframeBox.width / 2,
      y: iframeBox.y + iframeBox.height / 2,
    };
    expect(Math.abs(iframeCentre.x - stageCentre.x)).toBeLessThan(1);
    expect(Math.abs(iframeCentre.y - stageCentre.y)).toBeLessThan(1);
  }).toPass({ timeout: 2000 });
}

/**
 * Ctrl-wheel at `cursor` and assert the zoom changed with no added pan: the
 * flow-space point under the cursor, read back through xyflow's own
 * transform (never a board's DOM), must be the same before and after. A
 * plain pan would move that point; an anchored zoom will not.
 */
async function expectAnchoredZoom(
  page: Page,
  cursor: { readonly x: number; readonly y: number },
): Promise<void> {
  const zoomReadout = page.getByRole("button", { name: /, zoom$/ });
  const before = await zoomReadout.textContent();
  const paneBox = await page
    .getByRole("application", { name: "Canvas workspace" })
    .boundingBox();
  if (paneBox === null) throw new Error("the canvas pane has no box");
  const local = { x: cursor.x - paneBox.x, y: cursor.y - paneBox.y };

  const before1 = readViewportTransform(await viewportTransform(page));
  const flowPointAtCursor = {
    x: (local.x - before1.x) / before1.scale,
    y: (local.y - before1.y) / before1.scale,
  };

  await page.mouse.move(cursor.x, cursor.y);
  await page.keyboard.down("Control");
  try {
    await page.mouse.wheel(0, -240);
  } finally {
    await page.keyboard.up("Control");
  }
  await nextFrames(page, 2);

  await expect(zoomReadout).not.toHaveText(before ?? "");
  const after1 = readViewportTransform(await viewportTransform(page));
  expect(after1.scale).not.toBeCloseTo(before1.scale, 3);
  const flowPointAfter = {
    x: (local.x - after1.x) / after1.scale,
    y: (local.y - after1.y) / after1.scale,
  };
  // In flow units now (not screen pixels): the same content point should
  // still sit under the cursor, within a fraction of a flow unit.
  expect(Math.abs(flowPointAfter.x - flowPointAtCursor.x)).toBeLessThan(1);
  expect(Math.abs(flowPointAfter.y - flowPointAtCursor.y)).toBeLessThan(1);
}

test.describe("ctrl-wheel zoom", () => {
  test("zooms the pane about the cursor without an added pan, over empty canvas", async ({
    page,
  }) => {
    await open(page);
    const paneBox = await page
      .getByRole("application", { name: "Canvas workspace" })
      .boundingBox();
    if (paneBox === null) throw new Error("the canvas pane has no box");
    // Below both boards (y 0..420 at the initial 0.6 zoom): empty canvas.
    await expectAnchoredZoom(page, {
      x: paneBox.x + 80,
      y: paneBox.y + paneBox.height - 40,
    });
  });

  test("zooms the pane about the cursor without an added pan, over a played board's own wheel handler", async ({
    page,
  }) => {
    // Once a board is playing, the edit shield that would otherwise catch
    // the wheel at the parent level is gone: the gesture reaches the
    // board's OWN sandboxed document, which forwards it back up through
    // `traycer/canvas/zoom`, and canvas-frame.tsx re-maps its iframe-local
    // coordinates into page coordinates before the editor applies the same
    // anchored-zoom math. This is the one path the empty-canvas case above
    // never exercises.
    await open(page);
    await page.getByRole("button", { name: "Play A on canvas" }).click();
    await waitForBoardCentred(page, "A");

    const iframeBox = await page.locator('iframe[title="A"]').boundingBox();
    if (iframeBox === null) throw new Error("board A has no box");
    await expectAnchoredZoom(page, {
      x: iframeBox.x + iframeBox.width / 2,
      y: iframeBox.y + iframeBox.height / 2,
    });
  });
});

// The fixture seeds one element thread on each of boards A and B
// (`data-tid="name"`), a local-homed epic (no cloud verdict needed) with an
// open records lane carrying both threads, and a negotiated
// `epic.createCommentThread@1.2` so `useFrameCommentsEnabled` admits the
// toolbar's Comments control.

function commentsToggle(page: Page) {
  return page.getByRole("button", { name: "Comments" });
}
function commentPin(page: Page, number: number) {
  return page.getByRole("button", { name: `Open comment ${number}` });
}
function commentsSidebar(page: Page) {
  return page.getByRole("complementary", { name: "Comments sidebar" });
}
function fullscreenBoardChoice(page: Page) {
  return page.getByRole("button", { name: "Choose board" });
}

test.describe("comments mode and the shared sidebar", () => {
  // CanvasFullscreen renders `events.renderToolbarControls()` in its own
  // header, so the Comments toggle (`CanvasCommentsControl`) is reachable
  // both in edit mode and in fullscreen - the toggle and the pin/mode state
  // it drives are the same regardless of which surface the toggle is
  // clicked from. The shared sidebar, in turn, is only MOUNTED by the
  // canvas itself while fullscreen (`presentation.sidebar`); outside it,
  // the page around the canvas owns that slot, which is why the sidebar
  // claim below is proven in fullscreen specifically.
  test("comments mode pauses Play's own display without resetting it, and the pin comes and goes with the mode", async ({
    page,
  }) => {
    await open(page);
    await page.getByRole("button", { name: "Play A on canvas" }).click();
    await expect(
      page.getByRole("button", { name: "Playing · Back to editing" }),
    ).toBeVisible();

    // Entering comment mode pauses Play's own banner (`canvasInteractionMode`:
    // `playing: play && !commenting`) without clearing `play` itself - it
    // shows the pin instead, which is comment mode's own affordance.
    await commentsToggle(page).click();
    await expect(commentsToggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(commentPin(page, 1)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Playing · Back to editing" }),
    ).toHaveCount(0);

    // Comments off: the pin goes, and Play's banner returns on its own -
    // proof that `play` itself was never touched.
    await commentsToggle(page).click();
    await expect(commentsToggle(page)).toHaveAttribute("aria-pressed", "false");
    await expect(commentPin(page, 1)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Playing · Back to editing" }),
    ).toBeVisible();

    // Comments back on: the pin returns, the banner pauses again - the same
    // pair, every time, never drifting into each other's state.
    await commentsToggle(page).click();
    await expect(commentPin(page, 1)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Playing · Back to editing" }),
    ).toHaveCount(0);

    // A trip through fullscreen (its own Play, internally) and back leaves
    // `play` exactly as it was before the trip, once comment mode (which was
    // still on) is turned off again to let the banner speak for it.
    await page.getByRole("button", { name: "Play A fullscreen" }).click();
    await expect(canvasSurface(page)).toHaveAttribute(
      "data-canvas-fullscreen",
      "true",
    );
    await page.getByRole("button", { name: "Back to canvas" }).click();
    await expect(canvasSurface(page)).not.toHaveAttribute(
      "data-canvas-fullscreen",
      "true",
    );
    await commentsToggle(page).click();
    await expect(
      page.getByRole("button", { name: "Playing · Back to editing" }),
    ).toBeVisible();
  });

  test("the sidebar is reachable in fullscreen, and picking the other board's thread switches it without reloading either", async ({
    page,
  }) => {
    await open(page);
    const tokenA = await tokenOf(page, "A");
    const tokenB = await tokenOf(page, "B");

    await page.getByRole("button", { name: "Play A fullscreen" }).click();
    await expect(canvasSurface(page)).toHaveAttribute(
      "data-canvas-fullscreen",
      "true",
    );
    await expect(fullscreenBoardChoice(page)).toHaveText("A");

    // The toggle itself - not just the sidebar it feeds - is reachable from
    // fullscreen's own header (`CanvasFullscreen` renders the same
    // `renderToolbarControls()` the edit toolbar does).
    await expect(commentPin(page, 1)).toHaveCount(0);
    await commentsToggle(page).click();
    await expect(commentPin(page, 1)).toBeVisible();

    await commentPin(page, 1).click();
    await expect(commentsSidebar(page)).toBeVisible();

    // The sidebar lists every thread regardless of which board is on
    // screen; B's pin is off-screen while A fills the fullscreen viewport,
    // so its card in the sidebar - not its pin - is what picks it. A's card
    // is already expanded (it is the active thread), so B's is the second,
    // still-collapsed toggle.
    await commentsSidebar(page)
      .locator('[data-slot="comment-thread-toggle"]')
      .nth(1)
      .click();

    await expect(fullscreenBoardChoice(page)).toHaveText("B");
    // The sidebar survives the board switch it just drove.
    await expect(commentsSidebar(page)).toBeVisible();
    expect(await tokenOf(page, "A")).toBe(tokenA);
    expect(await tokenOf(page, "B")).toBe(tokenB);
  });
});

test.describe("the comment draft composer", () => {
  function commentTool(page: Page) {
    return page.getByRole("button", { name: "Comment (C)" });
  }

  async function openArtifactDraft(page: Page): Promise<void> {
    // Selecting the Comment TOOL is what turns comment mode on
    // (`chooseTool`: `setCommenting(next === "comment")`); the sidebar's
    // Comments toggle reaches the same `commenting` flag by a separate
    // path, and once it is on either way the toolbar - the tool included -
    // hides, so the tool must be picked first, while it is still visible.
    await commentTool(page).click();
    // Empty canvas below both boards (laid out at y 0..420, 0.6 zoom).
    const pane = page.getByRole("application", { name: "Canvas workspace" });
    const box = await pane.boundingBox();
    if (box === null) throw new Error("the canvas pane has no box");
    await page.mouse.click(box.x + 80, box.y + box.height - 40);
    await expect(
      page.getByRole("dialog", { name: "New comment" }),
    ).toBeVisible();
  }

  test("Cancel closes the draft and leaves comment mode exactly as it was", async ({
    page,
  }) => {
    await open(page);
    await openArtifactDraft(page);

    await page.getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByRole("dialog", { name: "New comment" })).toHaveCount(
      0,
    );
    await expect(commentsToggle(page)).toHaveAttribute("aria-pressed", "true");
  });

  test("posting through the real create call leaves comment mode exactly as it was", async ({
    page,
  }) => {
    await open(page);
    await openArtifactDraft(page);

    // The TipTap editor root is a plain `contenteditable` div with an
    // `aria-label`, not an element with an implicit "textbox" role.
    await page
      .locator('[contenteditable="true"]')
      .fill("A new thread from the composer");
    await page.getByRole("button", { name: "Comment", exact: true }).click();

    await expect(page.getByRole("dialog", { name: "New comment" })).toHaveCount(
      0,
    );
    await expect(commentsToggle(page)).toHaveAttribute("aria-pressed", "true");
  });
});
