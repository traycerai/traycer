import { expect, test, type Page } from "@playwright/test";

import { centreOf, fixture } from "./support/fixtures.ts";

// The boot card's escape hatch must survive its own surface being replaced
// mid-press.
//
// WHY A BROWSER GATE. The defect is an input-dispatch fact, not a React fact:
// when the element a press started on leaves the document before release,
// Chromium emits NO `click`, so an `onClick` handler never runs and the
// navigation never happens. jsdom has no input pipeline - Testing Library
// dispatches `click` directly - so every jsdom test of this button passes on
// the broken build. This presses with real mouse input, swaps the surface while
// the button is held, releases, and counts.
//
// Reproduced from a CDP capture of a real user press on the shipped card:
// pointerdown/mousedown on `host-boot-open-settings`, mouseup 198ms later on
// the tree that replaced it, and no click event at all.

const BUTTON = '[data-testid="host-boot-open-settings"]';

test.use({ viewport: { width: 1200, height: 900 } });

async function openBootCard(page: Page): Promise<void> {
  await page.goto(fixture("boot-escape-hatch-press"));
  await page.waitForFunction(
    `document.querySelector(${JSON.stringify(BUTTON)}) !== null && typeof window.__bootEscapeHatchProbe === "object"`,
  );
}

function activations(page: Page): Promise<unknown> {
  return page.evaluate("window.__bootEscapeHatchProbe.activations()");
}

/**
 * Records, on the page, each of these events as it is dispatched (capture
 * phase, document), so a test can wait for the gesture to have LANDED before
 * it asserts that nothing activated.
 */
async function recordEvents(
  page: Page,
  types: readonly string[],
): Promise<void> {
  await page.evaluate(
    `(() => {
       window.__seenEvents = [];
       for (const type of ${JSON.stringify(types)}) {
         document.addEventListener(
           type,
           (event) => window.__seenEvents.push(event.type + ":" + event.button),
           true,
         );
       }
     })()`,
  );
}

function seenEvents(page: Page): Promise<unknown> {
  return page.evaluate("window.__seenEvents");
}

test("an ordinary click activates the escape hatch exactly once", async ({
  page,
}) => {
  await openBootCard(page);
  // Recorded so the assertion below runs after the release has produced its
  // click: a double fire (press-start AND click both activating) would land
  // there, and reading the count any earlier would miss it.
  await recordEvents(page, ["click"]);

  // This is the measured premise the swap test leans on: if the button never
  // activated at all, "it activates across a swap" would be satisfied by a
  // fixture that is simply broken.
  const centre = await centreOf(page.locator(BUTTON));
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down({ button: "left" });
  await page.mouse.up({ button: "left" });

  await expect
    .poll(() => seenEvents(page), {
      message: "the release must have produced its click before counting",
    })
    .toEqual(["click:0"]);
  expect(
    await activations(page),
    "an ordinary click must activate the escape hatch exactly once",
  ).toBe(1);
});

test("a press activates the escape hatch even when the boot surface is replaced before the release", async ({
  page,
}) => {
  await openBootCard(page);

  // Press, replace the surface under the held pointer, release. Before the
  // fix this was 0: Chromium emitted no click, so `onClick` never ran.
  const heldCentre = await centreOf(page.locator(BUTTON));
  expect(
    await page.evaluate("window.__bootEscapeHatchProbe.captureButton()"),
    "the fixture must be able to hold a reference to the pressed button",
  ).toBe(true);
  await page.mouse.move(heldCentre.x, heldCentre.y);
  await page.mouse.down({ button: "left" });
  await page.evaluate("window.__bootEscapeHatchProbe.swap()");

  // The swap must genuinely DETACH the pressed node. If React reconciled the
  // two surfaces into the same element, the browser would still fire a click
  // and this case would pass without testing anything.
  await page.waitForFunction(
    `window.__bootEscapeHatchProbe.capturedIsConnected() === false &&
     document.querySelector(${JSON.stringify(BUTTON)}) !== null`,
  );
  await page.mouse.up({ button: "left" });

  await expect
    .poll(() => activations(page), {
      message:
        "a press on the escape hatch must activate it even when the boot surface " +
        "is replaced before the release (no click event is emitted at all)",
    })
    .toBe(1);
});

test("a secondary-button press does not activate the escape hatch", async ({
  page,
}) => {
  await openBootCard(page);
  // Press-start activation must not turn a right-click into a navigation. The
  // negative needs a positive to stand on: `auxclick` is what Chromium emits
  // once a non-primary press has been fully dispatched (down, up, then this),
  // so waiting for it proves the gesture landed before the count is read.
  await recordEvents(page, ["pointerdown", "auxclick"]);

  const centre = await centreOf(page.locator(BUTTON));
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });

  await expect
    .poll(() => seenEvents(page), {
      message: "the right press must have been dispatched in full",
    })
    .toEqual(["pointerdown:2", "auxclick:2"]);
  expect(
    await activations(page),
    "a secondary-button press must not activate the escape hatch",
  ).toBe(0);
});
