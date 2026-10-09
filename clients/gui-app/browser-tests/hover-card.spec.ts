import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  centreOf,
  fixture,
  type Point,
  nextFrames,
} from "./support/fixtures.ts";
import {
  NO_REOPEN_WINDOW_MS,
  OPEN_HOVER_CARD,
  STAYS_OPEN_WINDOW_MS,
  framesWithOtherThanOpenCards,
  installHoverCardProbe,
  maxPaintedHoverCards,
  openedHoverCards,
  overlappedHoverCardOpens,
  resetHoverCardProbe,
  settledCentreOf,
  wheelToHoverCardClose,
} from "./support/hover-card.ts";

// The app's hover cards (`components/ui/hover-card.tsx`), in real Chrome, on
// the real surfaces: the side tab strip's rows (`side-tab-strip.html`, the
// real `SideTabStrip`) and, for the two claims a list of agent rows and a modal
// dialog need, `hover-card-agents.html` (the real `AgentHoverTooltip` and the
// primitive itself).
//
// What is here is what jsdom cannot decide: what is PAINTED in a frame, what
// real pointer and keyboard input do to a card (a press, a wheel, Tab, Escape),
// and what Chrome decides for focus modality (`:focus-visible`) and hit testing.
// The logic - the open and close delays, the hand-off inside a group, the
// dismissed-until-the-pointer-leaves latch, menus shutting every card - is in
// `components/ui/__tests__/hover-card.test.tsx`, and the production trees'
// groups in `sidebar-row-first-use-overlays.test.tsx` and `epic-sidebar.test.tsx`.
//
// A card outlives its close by a fade, so "open" here is `data-state="open"`;
// and a claim that nothing happens is a window watched in the page's own frame
// loop (`support/hover-card.ts`), never a sleep.

test.use({
  viewport: { width: 1500, height: 1200 },
  colorScheme: "light",
});

const STRIP_FIXTURE = `${fixture("side-tab-strip")}?edge=left`;
const AGENTS_FIXTURE = fixture("hover-card-agents");

const STRIP_ROWS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
const STRIP_TITLES: Readonly<Record<string, string>> = {
  alpha: "Alpha rollout",
  beta: "Beta review",
  gamma: "Gamma notes",
  delta: "Delta migration",
  epsilon: "Epsilon cleanup",
  zeta: "Zeta spike",
};

/** Six agent rows: the first four resolve to the owner card, the last two to the label chip. */
const AGENT_TITLES = [
  "Plan the migration",
  "Write the tests",
  "Rebuild the index",
  "Review the diff",
  "Ship the release",
  "Sweep the worktrees",
];

async function openStrip(page: Page): Promise<void> {
  await page.goto(STRIP_FIXTURE);
  await page.waitForFunction("window.__sideTabStripProbe?.ready === true");
  await installHoverCardProbe(page);
}

async function openAgents(page: Page): Promise<void> {
  await page.goto(AGENTS_FIXTURE);
  await page.waitForFunction("window.__hoverCardAgentsProbe?.ready === true");
  await installHoverCardProbe(page);
}

/** The row: its `[data-side-tab]` element, found through the close control it carries. */
function stripRow(page: Page, id: string): Locator {
  return page.locator("[data-side-tab]").filter({
    has: page.getByTestId(`tab-close-epic-fixture-${id}`),
  });
}

function agentRow(page: Page, index: number): Locator {
  return page.getByTestId(`epic-sidebar-item-agent-${String(index)}`);
}

/** A place with no row, no card and nothing to hover: the empty surface beside the strip. */
async function emptySurface(page: Page): Promise<Point> {
  return centreOf(page.locator("[data-fixture-content]"));
}

async function moveTo(page: Page, point: Point): Promise<void> {
  await page.mouse.move(point.x, point.y);
}

/** The one card open now, once there is one. */
function theOpenCard(page: Page): Locator {
  return page.locator(OPEN_HOVER_CARD);
}

test("a hand-off from row to row never paints two cards in one frame", async ({
  page,
}) => {
  await openStrip(page);
  const centres: Record<string, Point> = {};
  for (const id of STRIP_ROWS) {
    centres[id] = await settledCentreOf(page, stripRow(page, id));
  }
  await resetHoverCardProbe(page);

  // First a hand-off at walking pace: each card is fully in before the pointer
  // moves on, so what is being sampled is the exit of one and the entry of the
  // next, the frames where a fade and an instant open could overlap.
  await moveTo(page, centres.alpha);
  await expect(theOpenCard(page)).toContainText(STRIP_TITLES.alpha);
  for (const id of ["beta", "gamma"]) {
    await page.mouse.move(centres[id].x, centres[id].y, { steps: 4 });
    await expect(theOpenCard(page)).toContainText(STRIP_TITLES[id]);
    await expect(theOpenCard(page)).toHaveCount(1);
  }

  // Then a sweep: the pointer crosses the next rows without waiting for a card,
  // so each hand-off starts while the last one is still settling.
  for (const id of ["delta", "epsilon", "zeta"]) {
    await page.mouse.move(centres[id].x, centres[id].y, { steps: 2 });
  }
  await expect(theOpenCard(page)).toContainText(STRIP_TITLES.zeta);
  await expect(theOpenCard(page)).toHaveCount(1);

  expect(
    await overlappedHoverCardOpens(page),
    "the run must actually hand a card over: a card that opens while another is still on the page. Without one, 'never two painted' would hold for a strip with no group at all",
  ).toBeGreaterThan(0);
  expect(
    await maxPaintedHoverCards(page),
    "two cards were painted in the same frame: a card handed over from a sibling must appear at once AND the sibling must go at once, or the fade of one overlaps the other",
  ).toBe(1);
});

test("a hand-off between an owner card and a label chip never paints two cards in one frame", async ({
  page,
}) => {
  await openAgents(page);
  const rows = [4, 5, 6].map((index) => agentRow(page, index));
  const centres = [
    await settledCentreOf(page, rows[0]),
    await settledCentreOf(page, rows[1]),
    await settledCentreOf(page, rows[2]),
  ];
  await resetHoverCardProbe(page);

  // card -> label -> label -> card: the fixture's list mixes the two outcomes
  // `AgentHoverTooltip` has, the case the strip's rows cannot make.
  await moveTo(page, centres[0]);
  await expect(theOpenCard(page)).toContainText(AGENT_TITLES[3]);
  const path: ReadonlyArray<readonly [number, number]> = [
    [1, 4],
    [2, 5],
    [0, 3],
  ];
  for (const [centre, title] of path) {
    await page.mouse.move(centres[centre].x, centres[centre].y, { steps: 4 });
    await expect(theOpenCard(page)).toContainText(AGENT_TITLES[title]);
    await expect(theOpenCard(page)).toHaveCount(1);
  }

  expect(
    await overlappedHoverCardOpens(page),
    "the run must actually hand a card over, or 'never two painted' holds trivially",
  ).toBeGreaterThan(0);
  expect(
    await maxPaintedHoverCards(page),
    "an owner card and a label chip were painted in the same frame during a hand-off",
  ).toBe(1);
});

test("pressing a row whose card is open closes it, and it stays closed", async ({
  page,
}) => {
  await openStrip(page);
  const gamma = await settledCentreOf(page, stripRow(page, "gamma"));
  await moveTo(page, gamma);
  await expect(theOpenCard(page)).toContainText(STRIP_TITLES.gamma);

  await resetHoverCardProbe(page);
  await page.mouse.click(gamma.x, gamma.y);
  // The press is what closes it; the rest is a window in which the card must
  // not come back. Its mouse-down also FOCUSES the row: `useFocus` with
  // `visibleOnly` is what keeps that focus from re-opening the card Chrome
  // just dismissed, because a mouse focus is not `:focus-visible`.
  await expect(theOpenCard(page)).toHaveCount(0);
  expect(
    await framesWithOtherThanOpenCards(page, 0, NO_REOPEN_WINDOW_MS),
    "the card came back while the pointer rested on the row it was pressed on",
  ).toBe(0);
  expect(
    await openedHoverCards(page),
    "no card may open again after the press - not even for a frame (a blink)",
  ).toEqual([]);
});

test("while a row's context menu is up no row opens a card, and none opens when it closes", async ({
  page,
}) => {
  await openStrip(page);
  const beta = await settledCentreOf(page, stripRow(page, "beta"));
  const alpha = await settledCentreOf(page, stripRow(page, "alpha"));
  await resetHoverCardProbe(page);

  // The real strip's real menu, opened by a real right-click. It is non-modal,
  // so the rows beside it still get the pointer: what keeps a sibling's card
  // shut is the menu's own `MenuOpenMarker`, and only a strip that mounts one
  // has it. (`hover-card.test.tsx` (k) decides the logic with a menu of its own.)
  await moveTo(page, beta);
  await page.mouse.click(beta.x, beta.y, { button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.mouse.move(alpha.x, alpha.y, { steps: 4 });
  expect(
    await framesWithOtherThanOpenCards(page, 0, NO_REOPEN_WINDOW_MS),
    "a card opened on the sibling row the pointer rests on while the menu was up",
  ).toBe(0);

  // Escape closes the menu with the pointer still resting on that sibling: the
  // open it swallowed must not surface by itself.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(
    await framesWithOtherThanOpenCards(page, 0, NO_REOPEN_WINDOW_MS),
    "the card the menu swallowed opened on its own once the menu closed",
  ).toBe(0);
  expect(
    await openedHoverCards(page),
    "no card may open at any point, not even for a frame",
  ).toEqual([]);
});

test("the pointer can travel from a row into its card, and the card closes when it leaves", async ({
  page,
}) => {
  await openStrip(page);
  const row = stripRow(page, "alpha");
  const alpha = await settledCentreOf(page, row);
  await moveTo(page, alpha);
  await expect(theOpenCard(page)).toContainText(STRIP_TITLES.alpha);

  const rowBox = await row.boundingBox();
  const cardBox = await theOpenCard(page).boundingBox();
  if (rowBox === null || cardBox === null) {
    throw new Error("the row and its card must both have a box");
  }
  // The gap between the row and its card is where the pointer is on neither:
  // the card's own hover delay is 150ms, so dwelling in it longer than that is
  // what the safe polygon exists for. It is measured on the REAL rects.
  const gap: Point = {
    x: (rowBox.x + rowBox.width + cardBox.x) / 2,
    y: alpha.y,
  };
  expect(
    await page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return (
        hit?.closest("[data-side-tab]") === null &&
        hit.closest('[data-slot="hover-card-content"]') === null
      );
    }, gap),
    "the gap point must be over neither the row nor the card, or dwelling there proves nothing",
  ).toBe(true);

  await moveTo(page, gap);
  expect(
    await framesWithOtherThanOpenCards(page, 1, STAYS_OPEN_WINDOW_MS),
    "the card closed while the pointer was in the gap between the row and the card",
  ).toBe(0);
  const inside = await centreOf(theOpenCard(page));
  await page.mouse.move(inside.x, inside.y, { steps: 4 });
  expect(
    await framesWithOtherThanOpenCards(page, 1, STAYS_OPEN_WINDOW_MS),
    "the card closed with the pointer inside it",
  ).toBe(0);

  await moveTo(page, await emptySurface(page));
  await expect(theOpenCard(page)).toHaveCount(0);
});

/**
 * Resizes the window until the row list overflows its scroller by `target`
 * pixels, and no more: the list's height follows the window's one for one, so
 * one correction lands it.
 */
async function overflowListBy(
  page: Page,
  scroller: Locator,
  target: number,
): Promise<void> {
  let height = 400;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.setViewportSize({ width: 900, height });
    await nextFrames(page, 2);
    const overflow = await scroller.evaluate(
      (node) => node.scrollHeight - node.clientHeight,
    );
    if (overflow === target) return;
    height += overflow - target;
  }
  throw new Error(
    `the row list never overflowed by exactly ${String(target)}px`,
  );
}

test("a wheel scroll of the list closes an open card even when the pointer stays on its row", async ({
  page,
}) => {
  await openStrip(page);
  const scroller = page.getByTestId("header-tab-strip-scroll");
  // A list that overflows by 8px: scrolling it to the end moves the rows by
  // 8px, half of what a row's centre is from its edge, so the pointer resting
  // on a row's centre is on the SAME row after the wheel. Nothing hands the
  // card over and no hover ends: only a dismissal by the scroll itself can
  // close it. (A scroll that carried another row under the pointer would hand
  // the card to that row, which closes the first one anyway.)
  await overflowListBy(page, scroller, 8);
  await scroller.evaluate((node) => {
    node.scrollTop = 0;
  });
  const row = stripRow(page, "delta");
  const centre = await settledCentreOf(page, row);
  const underPointerIsRow = (): Promise<boolean> =>
    page.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest("[data-side-tab]")
          ?.querySelector('[data-testid="tab-close-epic-fixture-delta"]') !==
        null,
      centre,
    );
  expect(await underPointerIsRow(), "the pointer must start on the row").toBe(
    true,
  );
  await moveTo(page, centre);
  await expect(theOpenCard(page)).toContainText(STRIP_TITLES.delta);

  await resetHoverCardProbe(page);
  await page.mouse.wheel(0, 120);
  await expect
    .poll(() => scroller.evaluate((node) => node.scrollTop), {
      message:
        "the wheel must scroll the list to its end, or there is nothing to dismiss",
    })
    .toBe(8);
  expect(
    await underPointerIsRow(),
    "the pointer must still be on the same row after the wheel: otherwise the card could have closed because the hover ended",
  ).toBe(true);
  await expect(
    theOpenCard(page),
    "the scroll of the list must close the card by itself (ancestor scroll)",
  ).toHaveCount(0);
  test.info().annotations.push({
    type: "wheel-to-close-ms",
    description: String(await wheelToHoverCardClose(page)),
  });
  expect(
    await framesWithOtherThanOpenCards(page, 0, STAYS_OPEN_WINDOW_MS),
    "the card came back while the pointer still rested on its row",
  ).toBe(0);
});

test("focus opens a card only from the keyboard: a mouse or scripted focus opens nothing, Tab does, Escape closes it", async ({
  page,
}) => {
  await openStrip(page);
  const alphaRow = stripRow(page, "alpha");
  const betaRow = stripRow(page, "beta");
  const alpha = await settledCentreOf(page, alphaRow);
  await resetHoverCardProbe(page);

  // A mouse press focuses the row. That focus is not `:focus-visible`, so it
  // must open nothing once the pointer has gone.
  await moveTo(page, alpha);
  await page.mouse.click(alpha.x, alpha.y);
  await expect(alphaRow).toBeFocused();
  const empty = await emptySurface(page);
  await moveTo(page, empty);

  // A focus a script gives a row after a click elsewhere (a dialog handing
  // focus back, a tab activation) is not the keyboard's either: Chrome decides
  // it is not `:focus-visible`, and `useFocus` with `visibleOnly` is the only
  // thing standing between it and a card under a pointer that is far away.
  await page.mouse.click(empty.x, empty.y);
  await betaRow.focus();
  await expect(betaRow).toBeFocused();
  expect(
    await framesWithOtherThanOpenCards(page, 0, NO_REOPEN_WINDOW_MS),
    "a focus that was not the keyboard's opened a card",
  ).toBe(0);
  expect(
    await openedHoverCards(page),
    "no card may open from a mouse or scripted focus, not even for a frame",
  ).toEqual([]);

  // Tab is a keyboard focus: it opens the focused row's card, with no hover.
  const focusedRowId = async (): Promise<string> =>
    page.evaluate(() => {
      const row = document.activeElement?.closest("[data-side-tab]");
      const close = row
        ?.querySelector('[data-testid^="tab-close-epic-fixture-"]')
        ?.getAttribute("data-testid");
      return close?.replace("tab-close-epic-fixture-", "") ?? "";
    });
  await page.keyboard.press("Tab");
  const firstStop = await focusedRowId();
  expect(firstStop, "Tab must land on a strip row").not.toBe("");
  await expect(theOpenCard(page)).toContainText(STRIP_TITLES[firstStop]);

  await page.keyboard.press("Escape");
  await expect(theOpenCard(page)).toHaveCount(0);

  await page.keyboard.press("Tab");
  const secondStop = await focusedRowId();
  expect(secondStop, "the second Tab must land on a strip row").not.toBe("");
  await expect(theOpenCard(page)).toContainText(STRIP_TITLES[secondStop]);
  await expect(theOpenCard(page)).toHaveCount(1);
});

test("a card inside a modal dialog takes the pointer: its link is reachable and a click on it lands", async ({
  page,
}) => {
  await openAgents(page);
  await page.getByTestId("open-modal").click();
  await expect(page.locator('[data-slot="dialog-content"]')).toBeVisible();

  // The dialog disables the page's pointer events, so a card portalled beside
  // it is dead to the pointer unless it is a layer above the dialog.
  const trigger = await centreOf(page.getByTestId("modal-trigger"));
  await moveTo(page, trigger);
  await expect(page.getByTestId("modal-card")).toHaveAttribute(
    "data-state",
    "open",
  );
  const link = page.getByTestId("modal-link");
  await expect(link).toBeVisible();
  const linkCentre = await centreOf(link);
  await page.mouse.move(linkCentre.x, linkCentre.y, { steps: 6 });
  expect(
    await page.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest('[data-testid="modal-link"]') !== null,
      linkCentre,
    ),
    "the pointer must reach the card's link: the modal's body pointer-events lock must not cover the card",
  ).toBe(true);

  await page.mouse.click(linkCentre.x, linkCentre.y);
  await expect
    .poll(() => page.evaluate("window.__hoverCardLinkClicks ?? 0"), {
      message: "a click on the link inside the card must land",
    })
    .toBe(1);
  await expect(
    page.getByTestId("modal-card"),
    "a click inside the card must not close it",
  ).toHaveAttribute("data-state", "open");
});
