import { expect, test, type Page } from "@playwright/test";
import { fixture, nextFrames } from "./support/fixtures";

/**
 * Real-browser coverage for the in-chat Find scrolling race
 * (`use-chat-find-controller.ts`'s `requestFindReveal`/`scheduleFindRevealStep`
 * gate against `issueFreeTimelineNavigation`'s `afterSettle`/`onCancelled`):
 * against `chat-find-scroll-model.tsx`'s real `ChatMessages` + `TileFindScope`
 * + `TileFindBar`, with real `requestAnimationFrame`/`scrollIntoView` timing
 * instead of a mocked `scrollToLocation`.
 *
 * The claim is the exact matched SENTENCE, not the find unit it lives in: a
 * needle reply's unit is one whole text segment, built far taller than the
 * fixture's viewport (`NEEDLE_UNIT_FILLER_PARAGRAPHS`), so a reveal that
 * lands only SOME part of the unit in view - the original bug's symptom -
 * is a real, catchable miss here, not a pass. One test drives both the
 * initial reveal and the find-next hop in sequence, so the heavy initial
 * app load (an unbundled dev-server boot of the real app) is paid once.
 */

declare global {
  interface Window {
    __chatFindScrollProbe?: { openFind: () => void };
  }
}

const SCROLL = '[data-testid="chat-messages-scroll"]';
const FIND_INPUT = 'input[aria-label="Find in tile"]';
const NEEDLE = "glimmerfrost";
const NEAR_SENTENCE =
  "The glimmerfrost marker sits inside this sentence, near turn five.";
const FAR_SENTENCE =
  "The glimmerfrost marker also sits inside this sentence, far below.";
/** Frames sampled per landing check: long enough to both catch the real
 *  settle and give a late, wrong correction room to show up. */
const LANDING_SAMPLE_FRAMES = 45;

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(fixture("chat-find-scroll-model"));
  await nextFrames(page, 6);
}

async function openFindAndSearch(page: Page, query: string): Promise<void> {
  await page.evaluate(() => window.__chatFindScrollProbe?.openFind());
  const input = page.locator(FIND_INPUT);
  await expect(input).toBeVisible();
  await input.fill(query);
  // Chat debounces a typed, non-empty query (`TYPED_FIND_QUERY_DEBOUNCE_MS`)
  // before it searches. Waiting for the real result-count label is the
  // actual "search completed" signal - not a guessed delay past the
  // debounce window.
  await expect(page.getByText(/^\d+ of \d+$/)).toBeVisible();
}

/**
 * Samples, once per animation frame for `frames` frames, whether `sentence`'s
 * own paragraph element sits FULLY inside the chat scroller's bounds (not
 * merely intersecting it, and not just its enclosing find unit). Sampled
 * entirely in-page so frame timing is real, not round-tripped through the
 * test process.
 */
async function sampleSentenceFullyInsideScroller(
  page: Page,
  sentence: string,
  frames: number,
): Promise<boolean[]> {
  return page.evaluate(
    async ({ sentence, frames, scrollSelector }) => {
      const scroller = document.querySelector<HTMLElement>(scrollSelector);
      if (scroller === null) throw new Error("no chat scroller mounted");
      // The far row can still be virtualized out of the DOM for the first
      // frame or two right after the hop issues - re-resolved every frame,
      // not looked up once, so that window counts as "not yet landed"
      // rather than a hard failure.
      const findTarget = (): HTMLElement | undefined =>
        Array.from(scroller.querySelectorAll("p")).find(
          (p) => p.textContent === sentence,
        );
      const samples: boolean[] = [];
      await new Promise<void>((resolve) => {
        let remaining = frames;
        const tick = (): void => {
          const target = findTarget();
          if (target === undefined) {
            samples.push(false);
          } else {
            const scrollerRect = scroller.getBoundingClientRect();
            const rect = target.getBoundingClientRect();
            samples.push(
              rect.top >= scrollerRect.top - 0.5 &&
                rect.bottom <= scrollerRect.bottom + 0.5,
            );
          }
          remaining -= 1;
          if (remaining <= 0) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return samples;
    },
    { sentence, frames, scrollSelector: SCROLL },
  );
}

/**
 * Asserts the sampled window lands the sentence fully inside the scroller
 * and HOLDS it there for the rest of the window - a late re-issue that
 * scrolls it back out (a false, transient "landed") fails this exactly as
 * surely as never landing at all.
 */
function assertLandsAndHolds(samples: readonly boolean[]): void {
  const landedAt = samples.indexOf(true);
  expect(
    landedAt,
    `never landed in ${samples.length} frames`,
  ).toBeGreaterThanOrEqual(0);
  const afterLanding = samples.slice(landedAt);
  expect(
    afterLanding.every(Boolean),
    `left the scroller again after landing at frame ${landedAt}: ${JSON.stringify(samples)}`,
  ).toBe(true);
}

test("reveals a matched sentence far below the fold inside the viewport, holds it there, and a find-next hop to a second, farther occurrence does the same", async ({
  page,
}) => {
  await open(page);
  const scroll = page.locator(SCROLL);
  await expect(scroll).toBeVisible();

  // Starts at the top: the near occurrence (around turn 5) is off-screen.
  await expect(page.getByText(NEAR_SENTENCE)).not.toBeInViewport();

  await openFindAndSearch(page, NEEDLE);

  const nearSamples = await sampleSentenceFullyInsideScroller(
    page,
    NEAR_SENTENCE,
    LANDING_SAMPLE_FRAMES,
  );
  assertLandsAndHolds(nearSamples);

  // After the first match lands and holds through the full 45-frame sample,
  // Enter requests the second occurrence in a different row farther down,
  // which must issue and land a brand-new real scroll.
  await page.locator(FIND_INPUT).press("Enter");

  const farSamples = await sampleSentenceFullyInsideScroller(
    page,
    FAR_SENTENCE,
    LANDING_SAMPLE_FRAMES,
  );
  assertLandsAndHolds(farSamples);

  // The near occurrence scrolled out of view behind the hop - proof this is
  // a real second navigation, not a stale paint left over from the first.
  await expect(page.getByText(NEAR_SENTENCE)).not.toBeInViewport();
});
