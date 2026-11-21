import { expect, test, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// The member's own pending row in a bot's channel (Tracy Bots T249), on the
// windowed line: the person presses Send and the held row is drawn at the end;
// the host's index then names the row at its ordinal before any frame has
// carried its body; the body lands by the range the list asked for. Whether
// the list follows the row at the end, leaves a reader who scrolled away
// where they are, and keeps the reader's anchor when a teammate's post is
// named after the send is real layout and scroll state, which jsdom cannot
// decide. The fixture is the real chat store fed a host's frames under the
// real list (`src/__tests__/browser/bot-pending-row-follow.tsx`).
//
// Every wait is for something the page can be observed to have done: a probe
// that agrees with the one before it. The timeouts are hang detectors.

test.use({ viewport: { width: 900, height: 700 }, colorScheme: "light" });

/** A reader this far from the end is clearly away from it: well over one row. */
const AWAY_MARGIN = 300;
/** Where the scrolled-away reader is put. */
const AWAY_DISTANCE = 600;
const HANG_MS = 15_000;
/**
 * Consecutive readings that must agree before a layout counts as settled: the
 * list measures rows as they scroll into view, and two readings can straddle
 * one such correction.
 */
const STEADY_READINGS = 3;

async function probe(page: Page): Promise<BotPendingRowProbe> {
  return page.evaluate(() => {
    if (window.__pendingDriver === undefined) throw new Error("no driver");
    return window.__pendingDriver.probe();
  });
}

function sameLayout(a: BotPendingRowProbe, b: BotPendingRowProbe): boolean {
  return (
    a.scrollTop === b.scrollTop &&
    a.scrollHeight === b.scrollHeight &&
    a.pendingTop === b.pendingTop &&
    a.pendingHeight === b.pendingHeight &&
    a.anchorTop === b.anchorTop &&
    a.rowsWithPendingText === b.rowsWithPendingText &&
    a.teammateRows === b.teammateRows &&
    a.rangeRequests === b.rangeRequests
  );
}

/**
 * The first probe that satisfies `done` and agrees in layout with the
 * `STEADY_READINGS - 1` probes before it. `pump` runs before each reading (the host answering what the
 * list has asked).
 */
async function settled(
  page: Page,
  what: string,
  done: (reading: BotPendingRowProbe) => boolean,
  pump: (() => Promise<void>) | null,
): Promise<BotPendingRowProbe> {
  const seen: { agreeing: number; previous: BotPendingRowProbe | null } = {
    agreeing: 0,
    previous: null,
  };
  const result: { last: BotPendingRowProbe | null } = { last: null };
  await expect
    .poll(
      async () => {
        if (pump !== null) await pump();
        const next = await probe(page);
        const agrees =
          seen.previous !== null &&
          done(next) &&
          sameLayout(seen.previous, next);
        seen.agreeing = agrees ? seen.agreeing + 1 : 0;
        seen.previous = next;
        result.last = next;
        return seen.agreeing >= STEADY_READINGS - 1;
      },
      { message: `${what}: never reached a steady layout`, timeout: HANG_MS },
    )
    .toBe(true);
  if (result.last === null) throw new Error(`${what}: no reading`);
  return result.last;
}

async function open(page: Page): Promise<void> {
  await page.goto(fixture("bot-pending-row-follow"));
  await page.waitForFunction(() => window.__pendingDriver?.ready === true);
  await settled(page, "the channel opened", (r) => r.anchorId !== null, null);
}

/**
 * Puts the reader about `distance` px short of the end and returns where they
 * are once the list has settled: it measures rows as they scroll into view, so
 * the distance it settles at is read, not assumed.
 */
async function scrollToDistance(
  page: Page,
  distance: number,
): Promise<BotPendingRowProbe> {
  await page.evaluate((away) => {
    const node = document.querySelector<HTMLElement>(
      '[data-testid="chat-messages-scroll"]',
    );
    if (node === null) throw new Error("no scroll node");
    node.scrollTo({ top: node.scrollHeight - node.clientHeight - away });
  }, distance);
  return settled(
    page,
    `scrolled to ${String(distance)}px from the end`,
    (r) => (distance === 0 ? r.distance <= 1 : r.distance > 1),
    null,
  );
}

/** The person presses Send: the list is handed the held row, and settles. */
async function press(page: Page): Promise<BotPendingRowProbe> {
  const before = (await probe(page)).rowsHanded;
  await page.evaluate(() => {
    window.__pendingDriver?.press();
  });
  return settled(
    page,
    "the send was pressed",
    (r) => r.rowsHanded === before + 1,
    null,
  );
}

/** The host's index names the row (and, when asked, a teammate's post after it); no body yet. */
async function indexNames(
  page: Page,
  withTeammate: boolean,
): Promise<BotPendingRowProbe> {
  const before = (await probe(page)).rangeRequests;
  await page.evaluate((teammate) => {
    window.__pendingDriver?.indexNamesPending();
    if (teammate) window.__pendingDriver?.indexNamesTeammate();
  }, withTeammate);
  return settled(
    page,
    "the index named the row",
    (r) => r.rangeRequests > before,
    null,
  );
}

/** The host answers the range the list asked for, until the rows it named are drawn. */
async function bodyLands(
  page: Page,
  withTeammate: boolean,
): Promise<BotPendingRowProbe> {
  const answer = async (): Promise<void> => {
    await page.evaluate(() => window.__pendingDriver?.answerRange());
  };
  return settled(
    page,
    "the body landed",
    (r) => r.bodiesHeld === (withTeammate ? 2 : 1),
    answer,
  );
}

function expectFollowed(reading: BotPendingRowProbe, step: string): void {
  expect(reading.rowsWithPendingText, `${step}: rows with the text`).toBe(1);
  expect(reading.pendingIsLastRow, `${step}: the pending row is last`).toBe(
    true,
  );
  expect(reading.pendingInView, `${step}: the pending row is in view`).toBe(
    true,
  );
  expect(reading.distance, `${step}: followed to the end`).toBeLessThanOrEqual(
    1,
  );
}

test("a pending post at the end is the last row, in view and followed, at every step, with no jump when the index names it", async ({
  page,
}) => {
  await open(page);
  await scrollToDistance(page, 0);

  const pressed = await press(page);
  expectFollowed(pressed, "at the press");

  const named = await indexNames(page, false);
  expectFollowed(named, "after the index named the row, before its body");
  expect(
    Math.abs((named.pendingTop ?? 0) - (pressed.pendingTop ?? 0)),
    "the row jumped when the index named it",
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(named.scrollTop - pressed.scrollTop),
    "the list jumped when the index named the row",
  ).toBeLessThanOrEqual(1);

  const landed = await bodyLands(page, false);
  expectFollowed(landed, "after the body landed");
});

test("a reader scrolled away is not pulled down at any step", async ({
  page,
}) => {
  await open(page);
  const before = await scrollToDistance(page, AWAY_DISTANCE);
  expect(
    before.distance,
    "the reader is not clearly away from the end",
  ).toBeGreaterThan(AWAY_MARGIN);

  const steps: Array<[string, BotPendingRowProbe]> = [];
  steps.push(["at the press", await press(page)]);
  steps.push([
    "after the index named the row, before its body",
    await indexNames(page, false),
  ]);
  steps.push(["after the body landed", await bodyLands(page, false)]);

  for (const [step, reading] of steps) {
    expect(
      Math.abs(reading.scrollTop - before.scrollTop),
      `${step}: the reader was moved`,
    ).toBeLessThanOrEqual(1);
    expect(reading.anchorId, `${step}: the reader's anchor changed`).toBe(
      before.anchorId,
    );
    expect(
      reading.distance,
      `${step}: the reader is no longer away from the end`,
    ).toBeGreaterThan(AWAY_MARGIN);
    expect(reading.rowsWithPendingText).toBeLessThanOrEqual(1);
  }
});

test("a stored row with a teammate's post after it is one row, and the reader's anchor stays within 1px at every step", async ({
  page,
}) => {
  await open(page);
  const before = await scrollToDistance(page, AWAY_DISTANCE);
  expect(
    before.distance,
    "the reader is not clearly away from the end",
  ).toBeGreaterThan(AWAY_MARGIN);

  const steps: Array<[string, BotPendingRowProbe]> = [];
  steps.push(["at the press", await press(page)]);
  steps.push([
    "after the index named the row and the teammate's post, before their bodies",
    await indexNames(page, true),
  ]);
  steps.push(["after the bodies landed", await bodyLands(page, true)]);

  for (const [step, reading] of steps) {
    expect(reading.anchorId, `${step}: the reader's anchor changed`).toBe(
      before.anchorId,
    );
    expect(
      Math.abs((reading.anchorTop ?? 0) - (before.anchorTop ?? 0)),
      `${step}: the reader's anchor moved`,
    ).toBeLessThanOrEqual(1);
    expect(reading.rowsWithPendingText).toBeLessThanOrEqual(1);
  }

  // At the end, exactly one row carries the text, not two.
  const end = await scrollToDistance(page, 0);
  expect(end.rowsWithPendingText, "rows with the text at the end").toBe(1);
  expect(end.teammateRows, "rows with the teammate's post at the end").toBe(1);
});
