import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// Browser regressions for canvas Play and fullscreen: claims jsdom cannot
// decide because they depend on the SAME iframe document surviving the
// fullscreen transitions (the current tile is absolute-positioned, with no
// manual top-layer popover) and on real wheel/paint behaviour (ctrl-wheel
// zoom, Fit/Fill width). Store rules and the toolbar's own button wiring stay
// in Vitest (`components/canvas-artifact/__tests__/`); this file only proves
// what a real browser session shows.

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

test.describe("per-board Play vs. editing", () => {
  test("Play from one board's button plays that board alone and keeps the editing chrome", async ({
    page,
  }) => {
    await open(page);

    await page.getByRole("button", { name: "Play A on canvas" }).click();

    // Play is per board: A's button becomes its stop control, B keeps its
    // own Play, and the edit toolbar stays up throughout.
    await expect(
      page.getByRole("button", { name: "Stop A (Escape)" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Play B on canvas" }),
    ).toBeVisible();
    await expect(
      page.getByRole("toolbar", { name: "Canvas tools" }),
    ).toBeVisible();

    // One board plays at a time: playing B moves the stop control there.
    await page.getByRole("button", { name: "Play B on canvas" }).click();
    await expect(
      page.getByRole("button", { name: "Play A on canvas" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stop B (Escape)" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Stop B (Escape)" }).click();
    await expect(
      page.getByRole("button", { name: "Play B on canvas" }),
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
    // never exercises. Starting play moves no camera, and both boards are in
    // view at the initial viewport, so A's box is readable right away.
    await open(page);
    await page.getByRole("button", { name: "Play A on canvas" }).click();
    await expect(
      page.getByRole("button", { name: "Stop A (Escape)" }),
    ).toBeVisible();

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
  // clicked from. The shared sidebar is the app's rail panel, a SIBLING of
  // the canvas tile (the fixture mounts it as the app's left panel does), so
  // it stays visible while a board is fullscreen; a pin click brings it
  // forward through the left-panel store (`useActivateCommentThread`).
  test("comments mode shows the pin without touching the playing board", async ({
    page,
  }) => {
    await open(page);
    await page.getByRole("button", { name: "Play A on canvas" }).click();
    await expect(
      page.getByRole("button", { name: "Stop A (Escape)" }),
    ).toBeVisible();

    // Comment mode wins the pointer over the playing board, but never clears
    // play itself: the pin appears while A's stop control stays.
    await commentsToggle(page).click();
    await expect(commentsToggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(commentPin(page, 1)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stop A (Escape)" }),
    ).toBeVisible();

    // Comments off: the pin goes; play was untouched throughout.
    await commentsToggle(page).click();
    await expect(commentsToggle(page)).toHaveAttribute("aria-pressed", "false");
    await expect(commentPin(page, 1)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Stop A (Escape)" }),
    ).toBeVisible();

    // A trip through fullscreen (its own play surface, orthogonal to the
    // in-place state) and back leaves the playing board exactly as it was.
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
    await expect(
      page.getByRole("button", { name: "Stop A (Escape)" }),
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
    // path. The toolbar stays up either way.
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

test.describe("relative links and the query-navigation reload", () => {
  // Each board's own page links to the other (A's link carries a query, B's
  // does not), and the bootstrap only intercepts a link's click in Play -
  // see canvas-bootstrap.ts's click listener.
  test("a query-carrying link reloads the target board in place, and the bridge still answers after it, and after the trip back", async ({
    page,
  }) => {
    await open(page);
    await page.getByRole("button", { name: "Play A on canvas" }).click();
    await expect(
      page.getByRole("button", { name: "Stop A (Escape)" }),
    ).toBeVisible();

    // Keyboard activation avoids cross-frame pointer rounding at canvas zoom.
    await board(page, "A").locator('[data-tid="link"]').press("Enter");
    // The hop moves play to B and reveals it once.
    await expect(
      page.getByRole("button", { name: "Stop B (Escape)" }),
    ).toBeVisible();
    await waitForBoardCentred(page, "B");
    // The reload lands with the query applied, not dropped.
    await expect
      .poll(() =>
        board(page, "B")
          .locator("body")
          .evaluate(() => location.search),
      )
      .toBe("?step=2");

    // The trip back never needs a reload (B's query, A's none), but clicking
    // it still exercises the bridge the reload just re-handshook: if that
    // handshake left it rejecting requests, this click - and the relative
    // link notification it depends on - would simply never land.
    await board(page, "B").locator('[data-tid="link"]').press("Enter");
    await waitForBoardCentred(page, "A");

    // And the editor itself is still live, not stuck behind the reload.
    await commentsToggle(page).click();
    await expect(commentsToggle(page)).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("the sidebar's draft across a fullscreen exit and reenter", () => {
  test("a reply typed in fullscreen survives Back to canvas and reentering, and Edit's menu is reachable there too", async ({
    page,
  }) => {
    await open(page);
    await page.getByRole("button", { name: "Play A fullscreen" }).click();
    await commentsToggle(page).click();
    await commentPin(page, 1).click();
    await expect(commentsSidebar(page)).toBeVisible();

    const reply = commentsSidebar(page).locator('[contenteditable="true"]');
    await reply.fill("in progress reply");

    await page.getByRole("button", { name: "Back to canvas" }).click();
    await expect(canvasSurface(page)).not.toHaveAttribute(
      "data-canvas-fullscreen",
      "true",
    );

    // The rail sidebar is a sibling of the tile, so leaving fullscreen must
    // not unmount it or drop the left-panel selection the pin click made -
    // the typed reply has to still be there after a round trip.
    await page.getByRole("button", { name: "Play A fullscreen" }).click();
    await expect(canvasSurface(page)).toHaveAttribute(
      "data-canvas-fullscreen",
      "true",
    );
    await expect(commentsSidebar(page)).toBeVisible();
    await expect(reply).toHaveText("in progress reply");

    // The actions menu (and the composer it opens) portal to
    // `document.body`; fullscreen is tile-scoped ordinary stacking, so the
    // menu must still be clickable while a board is fullscreen. A real click
    // through to a state change - the edit composer appearing, pre-filled
    // and typable - is what tells "exists in the DOM" apart from "actually
    // reachable" in that stack.
    await commentsSidebar(page)
      .getByRole("button", { name: "Comment actions" })
      .click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const editDraft = commentsSidebar(page)
      .locator('[contenteditable="true"]')
      .first();
    await expect(editDraft).toContainText("about boards/a.html");
    await editDraft.fill("about boards/a.html, edited in fullscreen");
    await expect(editDraft).toHaveText(
      "about boards/a.html, edited in fullscreen",
    );
  });
});
