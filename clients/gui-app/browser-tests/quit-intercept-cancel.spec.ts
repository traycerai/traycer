import { expect, test } from "@playwright/test";

import { centreOf, fixture } from "./support/fixtures.ts";

// The quit intercept's Cancel path: after Cancel, is the window actually
// usable again?
//
// jsdom cannot answer that - it has no hit testing, so a click reaches a node
// whether or not a real user could reach it, and the best a jsdom fixture can
// do is assert Radix released its `body { pointer-events: none }` lock, which
// is a proxy. This clicks a button behind the modal in a real layout engine,
// by coordinates: a locator click would wait for the button to be hittable,
// and landing on the modal instead is the point.

const DIALOG = '[data-testid="quit-intercept-dialog"]';
const CANCEL = '[data-testid="quit-intercept-cancel"]';

test.use({ viewport: { width: 1200, height: 800 } });

test("after Cancel the window takes clicks again, on both cancel paths", async ({
  page,
}) => {
  const probe = page.locator("#probe-state");
  const dialog = page.locator(DIALOG);
  const emitQuit = async (): Promise<void> => {
    await page.evaluate("window.__probeEmitQuit()");
    await expect(dialog).toBeVisible();
  };

  await page.goto(fixture("quit-intercept-cancel"));
  await page.waitForFunction(
    'document.querySelector("#app-button") !== null && typeof window.__probeEmitQuit === "function"',
  );

  // The retention is the premise of the whole fixture. Assert it POSITIVELY
  // before anything that depends on it: a fixture whose premise silently did
  // not happen proves nothing, and every later assertion here would still
  // pass on an empty registry.
  expect(
    await page.evaluate("window.__probeRetainedRows()"),
    "expected exactly one un-syncable unsynced row (the retained buffer) before the quit request",
  ).toBe(1);

  const appButton = await centreOf(page.locator("#app-button"));
  await page.mouse.click(appButton.x, appButton.y);
  await expect(
    probe,
    "the app button must be clickable BEFORE the modal opens, or this fixture cannot tell a released modal from a broken click",
  ).toHaveAttribute("data-app-clicks", "1");

  // ── Arm 1: the outside-click dismissal path ──────────────────────────────
  //
  // Clicking the app button while the dialog is open is unavoidably ALSO an
  // outside pointer-down on the dialog, so this one gesture measures two
  // things, and both are wanted: the app button must not receive the click
  // (the modal blocks) and the dialog must answer main rather than just
  // vanishing (a dismissal without a decision parks main for ever).
  await emitQuit();

  // Opening focus must not sit on the destructive control. This dialog is
  // summoned by a keyboard shortcut, so a default of "Quit and discard" means
  // Cmd+Q then Enter destroys every unsynced edit.
  await expect(
    page.locator(CANCEL),
    "the quit dialog must open with focus on Cancel, not on Quit and discard",
  ).toBeFocused();

  await page.mouse.click(appButton.x, appButton.y);
  await expect(dialog).toHaveCount(0);
  await expect(
    probe,
    "an outside click must RESPOND userCancelled, not merely dismiss",
  ).toHaveAttribute("data-decision", "userCancelled");
  await expect(
    probe,
    "the app button must NOT receive the click that lands on it while the quit dialog is open",
  ).toHaveAttribute("data-app-clicks", "1");

  // The claim jsdom cannot make: the window is interactive again.
  await page.mouse.click(appButton.x, appButton.y);
  await expect(
    probe,
    "after a cancel the app must accept clicks again - 'the app stayed alive' and 'a decision was sent' both pass without this",
  ).toHaveAttribute("data-app-clicks", "2");
  expect(
    await page.evaluate("document.body.style.pointerEvents"),
    "Radix's body pointer-events lock must be released after a cancel",
  ).toBe("");

  // ── Arm 2: the Cancel BUTTON, on a second quit after the first was cancelled
  //
  // Also the second-quit-after-cancel case: quitting is now a state the shell
  // enters and leaves deliberately, so a request arriving after a cancel has
  // to be serviced with its own id rather than swallowed by the resolved one.
  await page.evaluate(
    'document.querySelector("#probe-state").setAttribute("data-decision", "")',
  );
  await emitQuit();
  const cancelButton = await centreOf(page.locator(CANCEL));
  await page.mouse.click(cancelButton.x, cancelButton.y);
  await expect(dialog).toHaveCount(0);
  await expect(
    probe,
    "the Cancel button must respond userCancelled on a quit request that arrived after an earlier cancel",
  ).toHaveAttribute("data-decision", "userCancelled");
  await page.mouse.click(appButton.x, appButton.y);
  await expect(
    probe,
    "the window must be interactive again after the second cancel too",
  ).toHaveAttribute("data-app-clicks", "3");

  // And the point of cancelling: the work is still there.
  expect(
    await page.evaluate("window.__probeRetainedRows()"),
    "the retained unsynced buffer must survive a cancel - preserving it is the reason the verb exists",
  ).toBe(1);
});
