import { expect, test, type Page } from "@playwright/test";

import { centreOf, fixture, nextFrames } from "./support/fixtures.ts";

// An expanded artifact is a native MODAL `<dialog>`, promoted to the top layer
// in place, and every claim here is one jsdom cannot decide: `showModal()`
// opens nothing there, nothing is painted, nothing is hit-tested, and
// inertness - which is the whole of the surface's modality - does not exist at
// all. The matching state and structure claims live in the Vitest suites
// beside the components.

test.use({ viewport: { width: 1200, height: 800 } });

const EXPAND = { name: "Expand" };
const CLOSE = { name: "Close" };

function surfaceOf(page: Page) {
  return page.getByRole("dialog", { name: "Report" });
}

async function openFixture(page: Page) {
  await page.goto(fixture("artifact-expansion"));
  await expect(page.getByRole("button", EXPAND)).toBeVisible();
  return surfaceOf(page);
}

async function expandedSurface(page: Page) {
  const surface = await openFixture(page);
  await page.getByRole("button", EXPAND).click();
  await expect(surface).toBeVisible();
  await nextFrames(page, 2);
  return surface;
}

/** Where focus is, relative to the surface, named so a failure says where. */
function focusHere(page: Page): Promise<string> {
  return surfaceOf(page).evaluate((node) => {
    const active = document.activeElement;
    if (active === null) return "none";
    const where = node.contains(active) ? "in" : "OUT";
    const name =
      active.id !== ""
        ? `#${active.id}`
        : (active.getAttribute("aria-label") ?? active.tagName.toLowerCase());
    return `${where}:${name}`;
  });
}

/** Asks the plain button behind the surface for focus; whether it took it. */
function focusBehindButton(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const behind = document.querySelector<HTMLElement>("#behind");
    behind?.focus();
    return behind !== null && document.activeElement === behind;
  });
}

/** The same of a control inside the FRAME behind it, which is its own document. */
function focusInsideBehindFrame(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>("#behind-frame");
    const inner =
      frame?.contentDocument?.querySelector<HTMLElement>("#inner") ?? null;
    inner?.focus();
    // Focus inside a frame reads as the FRAME holding it out here, so both
    // halves are asked: this document's view, and the frame's own.
    return (
      inner !== null &&
      frame !== null &&
      document.activeElement === frame &&
      frame.contentDocument?.activeElement === inner
    );
  });
}

test("the surface is promoted to the top layer as a modal", async ({
  page,
}) => {
  const surface = await expandedSurface(page);

  // `:modal` is the browser's own answer, and it carries both halves: this
  // element is in the top layer AND the rest of the document is inert. Each is
  // a mechanism that fails silently - a surface that is merely painted above
  // the page still lets the reader tab and read behind it.
  const state = await surface.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return {
      modal: node.matches(":modal"),
      // The raised surface takes the VIEWPORT, not the box of the
      // paint-contained ancestor it is rendered inside (the fixture mirrors
      // the chat's message row). Containment makes that ancestor a containing
      // block for fixed descendants and clips them, so this is the assertion
      // that separates a surface promoted to the top layer from one that
      // merely says `fixed inset-0`.
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      // The surface is an open `<dialog>` inline as well - that is how the
      // collapsed one lays out in place - so what is counted is the MODAL
      // ones, which is the window's one top-layer surface.
      modals: document.querySelectorAll("dialog:modal").length,
    };
  });

  expect(state.modal).toBe(true);
  expect(state.modals).toBe(1);
  expect({ x: state.box.x, y: state.box.y }).toEqual({ x: 0, y: 0 });
  expect({ width: state.box.width, height: state.box.height }).toEqual(
    state.viewport,
  );
});

test("a press meant for the page behind it lands on the surface instead", async ({
  page,
}) => {
  await expandedSurface(page);

  // Aim real input at the control's own coordinates. A locator click would
  // first wait for that control to BE the hit target, which is the opposite of
  // what is asked here.
  const point = await centreOf(page.locator("#behind"));
  const landsInside = await surfaceOf(page).evaluate(
    (node, { x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && node.contains(hit);
    },
    { x: point.x, y: point.y },
  );

  expect(landsInside).toBe(true);
});

test("nothing the reader can reach behind the surface takes focus", async ({
  page,
}) => {
  await openFixture(page);
  await expect(
    page.frameLocator("#behind-frame").locator("#inner"),
  ).toBeVisible();

  // The positive controls come first: a button that could not take focus
  // anyway, or a frame that never loaded, would pass the real assertions below
  // by having nothing to reach in the first place.
  expect(await focusBehindButton(page)).toBe(true);
  expect(await focusInsideBehindFrame(page)).toBe(true);

  await page.getByRole("button", EXPAND).click();
  await expect(surfaceOf(page)).toBeVisible();
  await nextFrames(page, 2);

  // Inertness refuses focus outright - not a listener that catches focus and
  // sends it back, which is what the surface would need if it were only
  // painted on top, and which never sees a frame's own document at all. The
  // accessibility tree follows the same inertness, so a screen reader cannot
  // wander behind the surface either.
  // Inertness refuses focus outright - not a listener that catches focus and
  // puts it back, which is what a surface that is merely painted on top needs.
  // The accessibility tree follows the same inertness, so a screen reader
  // cannot wander behind the surface either.
  expect(await focusBehindButton(page)).toBe(false);
  expect(await focusHere(page)).toMatch(/^in:/);

  // The frame behind it is the one thing inertness does not reach: it is
  // per-DOCUMENT, so a script INSIDE that frame can still focus itself, and no
  // containment can close it - focus crossing into a frame fires no event in
  // this document at all (probed: zero `focusin`), which is why the shipped
  // fullscreen app surface does not catch it either. What the reader can do is
  // what this surface answers for, and Tab cannot get in there: the cycle test
  // below walks 20 presses and never lands on `#behind-frame`.
});

test("a menu opened inside the surface is visible and clickable there", async ({
  page,
}) => {
  const surface = await expandedSurface(page);
  await expect(page.locator("#probe-picked")).toHaveText("Not picked");

  await surface.getByRole("button", { name: "More actions" }).click();
  const item = page.getByRole("menuitem", { name: "Probe action" });

  // Visible AND the hit target: a menu portalled to `document.body` would be
  // painted UNDER the top layer and inert besides - mounted, invisible,
  // unreachable - which is what the surface overlay container exists to
  // prevent. `click()` waits for the item to be the element at its own centre,
  // so it asserts both.
  await expect(item).toBeVisible();
  await item.click();

  await expect(page.locator("#probe-picked")).toHaveText("Picked");
});

test("focus starts on Close and comes back to Expand on the way out", async ({
  page,
}) => {
  await expandedSurface(page);
  await expect(page.getByRole("button", CLOSE)).toBeFocused();

  await page.keyboard.press("Escape");

  await expect(page.getByRole("button", EXPAND)).toBeFocused();
});

test("Tab cycles inside the surface, forwards and backwards", async ({
  page,
}) => {
  await expandedSurface(page);

  // Walk further than the surface has focusable stops, in both directions.
  // Every landing must be the surface or the document, never a CONTROL behind
  // it, and never the frame behind it either - that is the reader reaching the
  // task through a surface that covers it, and `#behind` / `#behind-frame`
  // would both show up here as an `OUT:` entry of their own. The trails are
  // collected rather than asserted per step, so a failure says where focus
  // actually went.
  //
  // The document itself is where Chrome parks focus as it wraps the cycle
  // around, once per lap in each direction, and the press after it lands back
  // inside - which is the browser's own cycle working, not a leak: there is
  // nothing on the document to act on, and the test above proves that no
  // element behind the surface can take focus even when asked directly.
  const walk = async (key: "Tab" | "Shift+Tab"): Promise<string[]> => {
    const trail: string[] = [];
    for (let step = 0; step < 10; step += 1) {
      await page.keyboard.press(key);
      trail.push(await focusHere(page));
    }
    return trail;
  };
  const strayed = (trail: readonly string[]): string[] =>
    trail.filter((entry) => !entry.startsWith("in:") && entry !== "OUT:body");

  const forward = await walk("Tab");
  expect(strayed(forward), `forward trail: ${forward.join(" → ")}`).toEqual([]);

  const backward = await walk("Shift+Tab");
  expect(strayed(backward), `backward trail: ${backward.join(" → ")}`).toEqual(
    [],
  );

  // The document is passed THROUGH, never rested on: a second landing off the
  // surface in a row would mean the cycle had actually left it. Asked this way
  // rather than of the last entry, which depends on how many stops the surface
  // happens to have.
  const rested = (trail: readonly string[]): string[] =>
    trail.filter(
      (entry, index) =>
        index > 0 &&
        !entry.startsWith("in:") &&
        !trail[index - 1].startsWith("in:"),
    );
  expect(rested(forward), `forward trail: ${forward.join(" → ")}`).toEqual([]);
  expect(rested(backward), `backward trail: ${backward.join(" → ")}`).toEqual(
    [],
  );

  // A real cycle, not one stop swallowing every press.
  expect(
    new Set(forward).size,
    `forward trail: ${forward.join(" → ")}`,
  ).toBeGreaterThan(1);
});

test("a local mode takes the first Escape and the next one collapses", async ({
  page,
}) => {
  const surface = await expandedSurface(page);
  await page.locator("#probe-arm").click();
  await expect(page.locator("#probe-arm")).toHaveText("Local mode on");

  await page.keyboard.press("Escape");

  // The local mode stood down and the surface stayed up, as a canvas tool
  // disarming does.
  await expect(page.locator("#probe-arm")).toHaveText("Local mode off");
  await expect(surface).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(surface).toBeHidden();
});

test("a dialog raised outside the surface lowers it and is then reachable", async ({
  page,
}) => {
  const surface = await expandedSurface(page);

  // Dispatched, not clicked: the button behind the surface is inert and
  // covered, which the two tests above prove. Only the dialog appearing
  // matters here.
  await page.locator("#raise-dialog").dispatchEvent("click");

  // The surface yields the window's one claim, so the dialog is reachable
  // rather than covered by the top layer and inert behind it. The press is the
  // proof: it waits for the button to be the hit target at its own centre.
  await expect(surface).toBeHidden();
  await expect(page.getByRole("button", EXPAND)).toBeVisible();
  await page.locator("#outside-answer").click();
  await expect(page.locator("#outside-answer")).toHaveText("Answered");
});

test("the surface is the same instance before, during and after", async ({
  page,
}) => {
  await openFixture(page);
  const presses = page.locator("#probe-control");
  await presses.click();
  await presses.click();
  await expect(presses).toHaveText("Presses 2");

  await page.getByRole("button", EXPAND).click();
  const surface = surfaceOf(page);
  await expect(surface).toBeVisible();

  // Re-mounting a second copy - what expanding used to do - would reset this
  // to zero, and that divergence is what dropped the controls in the first
  // place.
  await expect(presses).toHaveText("Presses 2");
  await presses.click();
  await expect(presses).toHaveText("Presses 3");

  await page.keyboard.press("Escape");
  await expect(surface).toBeHidden();
  await expect(presses).toHaveText("Presses 3");
});
